// Per-point INIT signals — the pure measurement engine, ported from the Python prototype's L1 CORE
// first step (gpx_stabilize.py lines 216–261). It projects to local meters and derives the
// motion/shape/reliability signal for each point. No screening, no modules, no labelling — that
// orchestration lives in ./analyze.js. `measure()` runs the numbered blocks below; each block is
// its own exported pure function (unit-testable in isolation).

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
 * Run the measurement blocks over `points`, treating `valid` (an index array) as the trusted time
 * series: the projection centre is their mean and the windowed signals are computed over them. Every
 * point is still projected (so excluded points get `xAll/yAll`). Returns one bundle of arrays — the
 * per-point context that analyze.js feeds to compute modules and assembles back onto the points.
 *
 * Signals (over the `valid` sub-sequence): hs, vs (speed); straight, steady (local shape);
 * netsp, netd150, wander (time-windowed); maDist (jitter); carve (S-arc density); paused.
 *
 * @param {TrackPoint[]} points
 * @param {number[]} valid  indices of the trusted/timed points
 * @param {Partial<typeof PARAMS>} [opts]
 */
export function measure(points, valid, opts = {}) {
  const g = { ...PARAMS, ...opts };
  const { xAll, yAll, x, y, el, t } = project(points, valid); //  block 1
  const { dt, step } = deltas(x, y, t); //                        block 2
  const { hs, vs } = speeds(step, dt, el, g); //                  block 3
  const { straight, steady } = localShape(x, y, hs, g); //        block 4
  const { maDist, cu } = jitter(x, y, el, g); //                  block 5
  const { netsp, netd150, wander, paused } = windows(x, y, t, cu, g); // block 6
  const carve = carveDensity(x, y, step, g); //                   block 7
  return {
    xAll,
    yAll,
    x,
    y,
    el,
    t,
    dt,
    step,
    cu,
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
}

/**
 * Block 1 — project to local meters. The centre (lat0/lon0) is the mean of the `valid` points (falls
 * back to all points if none are valid), but every point is projected so excluded points still have
 * a position. Returns `xAll/yAll` for all points and `x/y/el/t` for the valid sub-sequence.
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
