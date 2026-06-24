// Per-point INIT signals — ported from the Python prototype's L1 CORE first step
// (gpx_stabilize.py lines 216–261). This is the time-window calculation only: it projects to
// local meters and derives motion/shape/reliability signals for each point. No labelling.
//
// `signals()` is a thin orchestrator; each numbered block below is its own pure function
// (exported so it can be unit-tested in isolation).

export const PARAMS = Object.freeze({
  SW: 15, //          point-count window half-width (smoothing + local straight/steady/carve)
  ELE_SMOOTH: 9, //   ele pre-smoothing width for vertical speed
  D_JUMP: 60, //      detour spike threshold (m)
  A_MAX: 60, //       acceleration spike threshold (m/s^2)
  NETSTAY: 0.25, //   paused when net speed is below this (m/s)
  CARVE_AMP: 0.25, // s-arc swing amplitude threshold (rad)
  NET_WIN: 60, //     net-speed / wander time window (+/- s)
  NETD_WIN: 150, //   net-displacement time window (+/- s)
  S_SHORT: 2, //      s-delta short half-window (samples)
  S_LONG: 10, //      s-delta long half-window (samples)
});

const DEG_LAT_M = 110540; // meters per degree latitude
const DEG_LON_M = 111320; // meters per degree longitude at the equator

function mean(a) {
  let s = 0;
  for (const v of a) s += v;
  return s / a.length;
}

/**
 * np.convolve(a, ones(w)/w, "same") — boxcar smoothing with zero-padded edges. Returns a copy
 * when the signal is shorter than the window.
 */
function smooth(a, w) {
  const n = a.length;
  if (n < w) return a.slice();
  const out = new Array(n);
  const off = Math.floor((w - 1) / 2);
  for (let i = 0; i < n; i++) {
    const k = i + off;
    const lo = Math.max(0, k - w + 1);
    const hi = Math.min(n - 1, k);
    let s = 0;
    for (let j = lo; j <= hi; j++) s += a[j];
    out[i] = s / w;
  }
  return out;
}

/** Leftmost index where t[idx] >= val (numpy searchsorted, side="left"). */
function searchLeft(t, val) {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < val) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Linear interpolation of missing elevations over the index axis (np.interp, clamped at ends). */
function interpEle(raw) {
  const n = raw.length;
  const el = raw.map((v) => (v == null || Number.isNaN(v) ? NaN : v));
  const known = [];
  for (let i = 0; i < n; i++) if (!Number.isNaN(el[i])) known.push(i);
  if (known.length === 0) return new Array(n).fill(0);
  const first = known[0];
  const last = known[known.length - 1];
  let ki = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(el[i])) continue;
    while (ki + 1 < known.length && known[ki + 1] <= i) ki++;
    if (i < first) el[i] = el[first];
    else if (i > last) el[i] = el[last];
    else {
      const a = known[ki];
      const b = known[ki + 1];
      el[i] = el[a] + ((i - a) / (b - a)) * (el[b] - el[a]);
    }
  }
  return el;
}

/**
 * Signed swing angle of the short (+/-shortHw) heading relative to the long (+/-longHw) heading,
 * per point (gpx_stabilize.py s_delta). Positive = veering left, negative = right.
 */
function sDelta(x, y, shortHw, longHw) {
  const n = x.length;
  const delta = new Array(n);
  for (let i = 0; i < n; i++) {
    const sl = Math.max(i - shortHw, 0);
    const sh = Math.min(i + shortHw, n - 1);
    const ll = Math.max(i - longHw, 0);
    const lh = Math.min(i + longHw, n - 1);
    const sx = x[sh] - x[sl];
    const sy = y[sh] - y[sl];
    const lx = x[lh] - x[ll];
    const ly = y[lh] - y[ll];
    delta[i] = Math.atan2(lx * sy - ly * sx, lx * sx + ly * sy);
  }
  return delta;
}

/**
 * @typedef {{ lat: number, lon: number, ele: number|null, time: number }} TrackPoint
 *   time is epoch milliseconds (as produced by the GPX parser).
 */

/**
 * Compute the per-point INIT signals for one chronological track. The projection is local
 * equirectangular in meters, recentred on THIS track's mean (lat0/lon0) — accurate for any
 * ski-area-sized box anywhere on Earth. Returns a new array; inputs are not mutated.
 *
 * Each returned point keeps its original fields and gains:
 *   x, y         local meters (east, north)
 *   hs, vs       horizontal / vertical speed (m/s), smoothed
 *   straight     local straightness (disp/path) over +/-SW
 *   steady       local speed steadiness (CoV of hs) over +/-SW; 9 when too slow to be meaningful
 *   netsp        net speed over +/-NET_WIN seconds
 *   netd150      net displacement over +/-NETD_WIN seconds
 *   wander       3D step-direction circular variance over +/-NET_WIN seconds (GPS jitter, 0..1)
 *   maDist       3D distance from the moving-average line (high-frequency jitter)
 *   carve        local S-arc density (swings / 100 m)
 *   paused       net speed below NETSTAY
 *
 * There is no status field: a point belongs in the clean track iff it has NO `dropReason`. Drops
 * are recorded as `dropReason = { reasonKey: context }` + `dropCount` (via `addDrop`), contributed
 * by modules in two phases:
 *   - triage modules (run on raw points, before signals): noTime, dupe, resample. A point they drop
 *     is excluded from the projection centre and the time series, so it carries only `x, y` and its
 *     drop reasons — no signals.
 *   - signal modules (run on the per-point context, after the blocks): outlier (GPS spike). These
 *     flag points that DO carry signals.
 * Built-in modules always run; caller modules are appended via `opts.modules`.
 *
 * @typedef {{ name: string, phase?: "triage" | "signal",
 *             check?: (point: object, lastKept: object|null) => (null | any),
 *             run?: (ctx: object) => Record<string, any> }} Module
 *   A pluggable module — the standard export shape so a CLI can load a custom JS file
 *   (`export default { name, phase, ... }`). A "triage" module implements `check(point, lastKept)`
 *   returning null (keep) or a context (drop, under `name`). A "signal" module (default) implements
 *   `run(ctx)`: non-`drop` keys attach as `point[name][key]`; a `drop` array (null | context per
 *   point) becomes a drop reason under `name`.
 *
 * @param {TrackPoint[]} points  one track's points, in time order
 * @param {Partial<typeof PARAMS> & { modules?: Module[] }} [opts]
 * @returns {Array<TrackPoint & Record<string, number|boolean|object>>}
 */
export function signals(points, opts = {}) {
  const { modules = [], ...paramOpts } = opts;
  const g = { ...PARAMS, ...paramOpts };
  if (points.length === 0) return [];

  // Modules come in two phases. Built-ins always run; caller modules are appended.
  const all = [noTimeModule, dedupeModule, resampleModule, outlierModule, ...modules];
  const triageMods = all.filter((m) => m.phase === "triage");
  const signalMods = all.filter((m) => m.phase !== "triage");

  const preDrops = triage(points, triageMods); //                 triage phase (pre-series drops)
  const valid = keptIndices(preDrops);
  const { xAll, yAll, x, y, el, t } = project(points, valid); //  block 1
  const { dt, step } = deltas(x, y, t); //                        block 2
  const { hs, vs } = speeds(step, dt, el, g); //                  block 3
  const { straight, steady } = localShape(x, y, hs, g); //        block 4
  const { maDist, cu } = jitter(x, y, el, g); //                  block 5
  const { netsp, netd150, wander, paused } = windows(x, y, t, cu, g); // block 6
  const carve = carveDensity(x, y, step, g); //                   block 7

  // Signal-phase modules run on the per-point context after the blocks; each module's run(ctx)
  // returns { [signalKey]: array, drop?: (null|context)[] } (see assemble).
  const ctx = {
    x,
    y,
    el,
    t,
    dt,
    step,
    hs,
    vs,
    straight,
    steady,
    netsp,
    netd150,
    wander,
    maDist,
    carve,
    paused,
    n: valid.length,
    g,
  };
  const modData = {};
  for (const mod of signalMods) modData[mod.name] = mod.run(ctx);

  const sig = {
    xAll,
    yAll,
    hs,
    vs,
    straight,
    steady,
    netsp,
    netd150,
    wander,
    maDist,
    carve,
    paused,
  };
  return assemble(points, preDrops, valid, sig, modData);
}

/**
 * Record why a point might be dropped from the clean output. Maintains `point.dropReason`
 * (`{ reasonKey: context }`) and `point.dropCount`; idempotent per key (re-adding a key updates its
 * context without re-counting). Any module can call it.
 */
export function addDrop(point, reasonKey, context = true) {
  if (!point.dropReason) point.dropReason = {};
  if (!(reasonKey in point.dropReason)) point.dropCount = (point.dropCount ?? 0) + 1;
  point.dropReason[reasonKey] = context;
  return point;
}

// ── Built-in triage modules (phase "triage"): run on raw points before signals, in one sequential
//    sweep that shares a running "last kept" reference. A point that any of them flags is dropped
//    from the time series; survivors become the reference for the points that follow. ──

/** A point with no timestamp can't join the motion time series. */
export const noTimeModule = {
  name: "noTime",
  phase: "triage",
  check: (p) => (p.time == null ? true : null),
};

/** Drop points that share the last kept point's timestamp (exact duplicate, or a moved conflict). */
export const dedupeModule = {
  name: "dupe",
  phase: "triage",
  check: (p, q) => {
    if (!q || p.time == null || p.time !== q.time) return null;
    return { moved: p.lat !== q.lat || p.lon !== q.lon };
  },
};

/** Resample to ~1 Hz: drop points less than 1 s after the last kept point. */
export const resampleModule = {
  name: "resample",
  phase: "triage",
  check: (p, q) => {
    if (!q || p.time == null) return null;
    const gap = p.time - q.time;
    return gap > 0 && gap < 1000 ? { gap } : null;
  },
};

/**
 * Run the triage modules over the raw points in one sweep with a shared "last kept" reference.
 * Returns, per point, `null` if it survives (enters the time series) or a `{ name: context }`
 * object of the triage drop reasons it accumulated.
 */
export function triage(points, modules) {
  const preDrops = new Array(points.length).fill(null);
  let lastKept = null; // the last point that survived every triage module — the running reference
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    let reasons = null;
    for (const m of modules) {
      const ctx = m.check(p, lastKept);
      if (ctx != null) {
        if (!reasons) reasons = {};
        reasons[m.name] = ctx;
      }
    }
    preDrops[i] = reasons;
    if (!reasons) lastKept = p;
  }
  return preDrops;
}

/** Original indices of the kept points (survived triage → the time-series sub-sequence). */
function keptIndices(preDrops) {
  const valid = [];
  for (let i = 0; i < preDrops.length; i++) if (preDrops[i] == null) valid.push(i);
  return valid;
}

/**
 * Block 1 — project to local meters. The centre (lat0/lon0) is the mean of the `ok` points (falls
 * back to all points if none are ok), but every point is projected so excluded points still have a
 * position. Returns `xAll/yAll` for all points and `x/y/el/t` for the ok sub-sequence.
 */
export function project(points, valid) {
  const centre = valid.length > 0 ? valid : points.map((_, i) => i);
  const lat0 = mean(centre.map((i) => points[i].lat));
  const lon0 = mean(centre.map((i) => points[i].lon));
  const mx = Math.cos((lat0 * Math.PI) / 180) * DEG_LON_M;
  const xAll = points.map((p) => (p.lon - lon0) * mx);
  const yAll = points.map((p) => (p.lat - lat0) * DEG_LAT_M);
  const x = valid.map((i) => xAll[i]);
  const y = valid.map((i) => yAll[i]);
  const el = interpEle(valid.map((i) => points[i].ele));
  const t = valid.map((i) => points[i].time / 1000);
  return { xAll, yAll, x, y, el, t };
}

/** Block 2 — per-step distance and time delta (dt floored at 1 s against duplicate timestamps). */
export function deltas(x, y, t) {
  const n = x.length;
  const dt = new Array(Math.max(0, n - 1));
  const step = new Array(Math.max(0, n - 1));
  for (let i = 0; i < n - 1; i++) {
    dt[i] = Math.max(t[i + 1] - t[i], 1.0);
    step[i] = Math.hypot(x[i + 1] - x[i], y[i + 1] - y[i]);
  }
  return { dt, step };
}

/** Block 3 — horizontal and vertical speed (m/s), each smoothed; ele is pre-smoothed for vs. */
export function speeds(step, dt, el, g) {
  const n = el.length;
  const hsRaw = new Array(n).fill(0);
  for (let i = 1; i < n; i++) hsRaw[i] = step[i - 1] / dt[i - 1];
  const hs = smooth(hsRaw, g.SW);
  const elS = smooth(el, g.ELE_SMOOTH);
  const vsRaw = new Array(n).fill(0);
  for (let i = 1; i < n; i++) vsRaw[i] = (elS[i] - elS[i - 1]) / dt[i - 1];
  const vs = smooth(vsRaw, g.SW);
  return { hs, vs };
}

/** Block 4 — local straightness (disp/path) and speed steadiness (CoV of hs) over +/-SW. */
export function localShape(x, y, hs, g) {
  const n = x.length;
  const straight = new Array(n).fill(1);
  const steady = new Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - g.SW);
    const hi = Math.min(n, i + g.SW + 1);
    let pl = 0;
    for (let j = lo; j < hi - 1; j++) pl += Math.hypot(x[j + 1] - x[j], y[j + 1] - y[j]);
    const disp = Math.hypot(x[hi - 1] - x[lo], y[hi - 1] - y[lo]);
    straight[i] = pl > 0 ? disp / pl : 1.0;
    let m = 0;
    for (let j = lo; j < hi; j++) m += hs[j];
    m /= hi - lo;
    if (m > 0.3) {
      let v = 0;
      for (let j = lo; j < hi; j++) v += (hs[j] - m) ** 2;
      steady[i] = Math.sqrt(v / (hi - lo)) / m;
    } else {
      steady[i] = 9.0;
    }
  }
  return { straight, steady };
}

/**
 * Built-in module — GPS spike detector (position 3-point detour, or impossible acceleration).
 * Its `run` returns `{ drop }` where each entry is `{ detour, accel }` when flagged, else `null`,
 * so spikes become the "outlier" drop reason. This is also the reference `Module` shape.
 */
export const outlierModule = {
  name: "outlier",
  phase: "signal",
  run({ x, y, step, hs, dt, g }) {
    const n = x.length;
    const detour = new Array(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
      const d02 = Math.hypot(x[i + 1] - x[i - 1], y[i + 1] - y[i - 1]);
      detour[i] = step[i - 1] + step[i] - d02;
    }
    const drop = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const accel = i >= 1 ? Math.abs(hs[i] - hs[i - 1]) / dt[i - 1] : 0;
      if (detour[i] > g.D_JUMP || accel > g.A_MAX) drop[i] = { detour: detour[i], accel };
    }
    return { drop };
  },
};

/**
 * Block 5 — high-frequency jitter: distance from the moving-average line, plus the cumulative 3D
 * unit step vectors `cu` that the windows block differences for windowed wander.
 */
export function jitter(x, y, el, g) {
  const n = x.length;
  const cux = new Array(n);
  const cuy = new Array(n);
  const cuz = new Array(n);
  cux[0] = 0;
  cuy[0] = 0;
  cuz[0] = 0;
  for (let i = 1; i < n; i++) {
    const dxu = x[i] - x[i - 1];
    const dyu = y[i] - y[i - 1];
    const dzu = el[i] - el[i - 1];
    const lu = Math.max(Math.sqrt(dxu * dxu + dyu * dyu + dzu * dzu), 1e-9);
    cux[i] = cux[i - 1] + dxu / lu;
    cuy[i] = cuy[i - 1] + dyu / lu;
    cuz[i] = cuz[i - 1] + dzu / lu;
  }
  const xma = smooth(x, g.SW);
  const yma = smooth(y, g.SW);
  const zma = smooth(el, g.SW);
  const maDist = new Array(n);
  for (let i = 0; i < n; i++) {
    maDist[i] = Math.sqrt((x[i] - xma[i]) ** 2 + (y[i] - yma[i]) ** 2 + (el[i] - zma[i]) ** 2);
  }
  return { maDist, cu: { x: cux, y: cuy, z: cuz } };
}

/**
 * Block 6 — time-windowed net speed (+/-NET_WIN), wander (circular variance of `cu` over the same
 * window), net displacement (+/-NETD_WIN), and the `paused` flag.
 */
export function windows(x, y, t, cu, g) {
  const n = x.length;
  const netsp = new Array(n).fill(0);
  const wander = new Array(n).fill(0);
  const netd150 = new Array(n).fill(9e9);
  for (let i = 0; i < n; i++) {
    const lo = searchLeft(t, t[i] - g.NET_WIN);
    const hi = Math.min(n - 1, searchLeft(t, t[i] + g.NET_WIN));
    netsp[i] = Math.hypot(x[hi] - x[lo], y[hi] - y[lo]) / Math.max(t[hi] - t[lo], 1);
    const ns = hi - lo;
    if (ns >= 3) {
      const rx = cu.x[hi] - cu.x[lo];
      const ry = cu.y[hi] - cu.y[lo];
      const rz = cu.z[hi] - cu.z[lo];
      wander[i] = 1.0 - Math.sqrt(rx * rx + ry * ry + rz * rz) / ns;
    }
    const l2 = searchLeft(t, t[i] - g.NETD_WIN);
    const h2 = Math.min(n - 1, searchLeft(t, t[i] + g.NETD_WIN));
    netd150[i] = Math.hypot(x[h2] - x[l2], y[h2] - y[l2]);
  }
  const paused = netsp.map((v) => v < g.NETSTAY);
  return { netsp, netd150, wander, paused };
}

/** Block 7 — local S-arc density (carve): signed swing crossings per 100 m over +/-SW. */
export function carveDensity(x, y, step, g) {
  const n = x.length;
  const delta = sDelta(x, y, g.S_SHORT, g.S_LONG);
  const cp = new Array(n).fill(false);
  let sg = 0;
  for (let k = 0; k < n; k++) {
    const v = delta[k];
    if (sg === 0) {
      if (Math.abs(v) > g.CARVE_AMP) sg = v > 0 ? 1 : -1;
    } else if (v > 0 !== sg > 0 && Math.abs(v) > g.CARVE_AMP) {
      cp[k] = true;
      sg = v > 0 ? 1 : -1;
    }
  }
  const cps = new Array(n + 1);
  cps[0] = 0;
  for (let i = 0; i < n; i++) cps[i + 1] = cps[i] + (cp[i] ? 1 : 0);
  const cpath = new Array(n);
  cpath[0] = 0;
  for (let i = 1; i < n; i++) cpath[i] = cpath[i - 1] + step[i - 1];
  const carve = new Array(n).fill(0);
  for (let k = 0; k < n; k++) {
    const lo = Math.max(0, k - g.SW);
    const hi = Math.min(n, k + g.SW + 1);
    const pth = cpath[hi - 1] - cpath[lo];
    carve[k] = pth > 0 ? ((cps[hi] - cps[lo]) / pth) * 100 : 0.0;
  }
  return carve;
}

/**
 * Merge the ok sub-sequence signals back onto every original point by index. Each module's
 * non-`drop` keys attach as a namespaced `point[modName] = { ...keys }`; a module's `drop` array
 * (null | context per point) is applied as a drop reason under the module's name (via `addDrop`).
 */
function assemble(points, preDrops, valid, sig, modData) {
  const pos = new Array(points.length).fill(-1);
  valid.forEach((i, k) => {
    pos[i] = k;
  });
  return points.map((p, i) => {
    const out = { ...p, x: sig.xAll[i], y: sig.yAll[i] };
    if (preDrops[i]) {
      // dropped in triage: position + drop reasons only, no signals
      for (const key in preDrops[i]) addDrop(out, key, preDrops[i][key]);
      return out;
    }
    const k = pos[i];
    Object.assign(out, {
      hs: sig.hs[k],
      vs: sig.vs[k],
      straight: sig.straight[k],
      steady: sig.steady[k],
      netsp: sig.netsp[k],
      netd150: sig.netd150[k],
      wander: sig.wander[k],
      maDist: sig.maDist[k],
      carve: sig.carve[k],
      paused: sig.paused[k],
    });
    for (const modName in modData) {
      const merged = modData[modName];
      const ns = {};
      let hasSignal = false;
      for (const key in merged) {
        if (key === "drop") {
          if (merged.drop[k]) addDrop(out, modName, merged.drop[k]);
        } else {
          ns[key] = merged[key][k];
          hasSignal = true;
        }
      }
      if (hasSignal) out[modName] = ns;
    }
    return out;
  });
}
