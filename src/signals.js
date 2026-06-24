// Per-point INIT signals — ported from the Python prototype's L1 CORE first step
// (gpx_stabilize.py lines 216–261). This is the time-window calculation only: it projects to
// local meters and derives motion/shape/reliability signals for each point. No labelling.

const PARAMS = {
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
};

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
 *   outlier      GPS spike flag (detour or acceleration too large)
 *   paused       net speed below NETSTAY
 *
 * Every point also gets a `gpsStatus`: "ok" | "oversample" | "error" | "dupe" — graded against the
 * last kept ("ok") point, which also resamples the track to ~1 Hz. Only "ok" points (>= 1 s after
 * the previous kept point) feed the projection-centre mean and the time series and carry the full
 * signal set; "oversample" (within 1 s of the last kept point), "error" (no time, or same time +
 * moved) and "dupe" (same time + same position) carry only `x, y, gpsStatus`.
 *
 * @param {TrackPoint[]} points  one track's points, in time order
 * @param {Partial<typeof PARAMS>} [opts]
 * @returns {Array<TrackPoint & Record<string, number|boolean>>}
 */
export function signals(points, opts = {}) {
  const g = { ...PARAMS, ...opts };
  const N = points.length;
  if (N === 0) return [];

  // ── triage each point against the LAST KEPT ("ok") point `q` — this both marks sampling quality
  //   AND resamples the track to ~1 Hz (points within 1 s of the last kept point are dropped) ──
  //   error      : no timestamp, OR same time as `q` but a different position (impossible jump)
  //   dupe       : identical time AND position as `q` (literal duplicate)
  //   oversample : less than 1 s after `q` (denser than 1 Hz → resampled out)
  //   ok         : >= 1 s after `q`, or the first timed point → kept as the new `q`
  // only `ok` points feed the projection centre and the time series.
  const gpsStatus = new Array(N);
  let q = null; // the last point kept as "ok" — the running 1 Hz reference
  for (let i = 0; i < N; i++) {
    const p = points[i];
    if (p.time == null) {
      gpsStatus[i] = "error";
    } else if (q == null) {
      gpsStatus[i] = "ok";
      q = p;
    } else {
      const dms = p.time - q.time;
      if (dms === 0) {
        gpsStatus[i] = p.lat === q.lat && p.lon === q.lon ? "dupe" : "error";
      } else if (dms < 1000) {
        gpsStatus[i] = "oversample";
      } else {
        gpsStatus[i] = "ok";
        q = p;
      }
    }
  }
  const inSeries = (s) => s === "ok";
  const valid = [];
  for (let i = 0; i < N; i++) if (inSeries(gpsStatus[i])) valid.push(i);

  // ── projection: centre on the TIMED points (fall back to all if none), then project every point ──
  const centre = valid.length > 0 ? valid : points.map((_, i) => i);
  const lat0 = mean(centre.map((i) => points[i].lat));
  const lon0 = mean(centre.map((i) => points[i].lon));
  const mx = Math.cos((lat0 * Math.PI) / 180) * DEG_LON_M;
  const xAll = points.map((p) => (p.lon - lon0) * mx);
  const yAll = points.map((p) => (p.lat - lat0) * DEG_LAT_M);

  // ── elevation gap-fill + time in seconds, over the valid (timed) sub-sequence only ──
  const n = valid.length;
  const x = valid.map((i) => xAll[i]);
  const y = valid.map((i) => yAll[i]);
  const el = interpEle(valid.map((i) => points[i].ele));
  const t = valid.map((i) => points[i].time / 1000);

  // ── per-step deltas (dt floored at 1s so duplicate timestamps don't explode speed) ──
  const dt = new Array(Math.max(0, n - 1));
  const step = new Array(Math.max(0, n - 1));
  for (let i = 0; i < n - 1; i++) {
    dt[i] = Math.max(t[i + 1] - t[i], 1.0);
    step[i] = Math.hypot(x[i + 1] - x[i], y[i + 1] - y[i]);
  }

  // ── horizontal / vertical speed (smoothed) ──
  const hsRaw = new Array(n).fill(0);
  for (let i = 1; i < n; i++) hsRaw[i] = step[i - 1] / dt[i - 1];
  const hs = smooth(hsRaw, g.SW);
  const elS = smooth(el, g.ELE_SMOOTH);
  const vsRaw = new Array(n).fill(0);
  for (let i = 1; i < n; i++) vsRaw[i] = (elS[i] - elS[i - 1]) / dt[i - 1];
  const vs = smooth(vsRaw, g.SW);

  // ── local straightness + speed steadiness over +/-SW ──
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

  // ── GPS spike flag: 3-point detour or acceleration too large ──
  const detour = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const d02 = Math.hypot(x[i + 1] - x[i - 1], y[i + 1] - y[i - 1]);
    detour[i] = step[i - 1] + step[i] - d02;
  }
  const outlier = new Array(n);
  for (let i = 0; i < n; i++) {
    const accel = i >= 1 ? Math.abs(hs[i] - hs[i - 1]) / dt[i - 1] : 0;
    outlier[i] = detour[i] > g.D_JUMP || accel > g.A_MAX;
  }

  // ── cumulative 3D unit step vectors (for windowed wander) + moving-average jitter ──
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

  // ── time-windowed net speed / wander / net displacement ──
  const netsp = new Array(n).fill(0);
  const wander = new Array(n).fill(0);
  const netd150 = new Array(n).fill(9e9);
  for (let i = 0; i < n; i++) {
    const lo = searchLeft(t, t[i] - g.NET_WIN);
    const hi = Math.min(n - 1, searchLeft(t, t[i] + g.NET_WIN));
    netsp[i] = Math.hypot(x[hi] - x[lo], y[hi] - y[lo]) / Math.max(t[hi] - t[lo], 1);
    const ns = hi - lo;
    if (ns >= 3) {
      const rx = cux[hi] - cux[lo];
      const ry = cuy[hi] - cuy[lo];
      const rz = cuz[hi] - cuz[lo];
      wander[i] = 1.0 - Math.sqrt(rx * rx + ry * ry + rz * rz) / ns;
    }
    const l2 = searchLeft(t, t[i] - g.NETD_WIN);
    const h2 = Math.min(n - 1, searchLeft(t, t[i] + g.NETD_WIN));
    netd150[i] = Math.hypot(x[h2] - x[l2], y[h2] - y[l2]);
  }
  const paused = netsp.map((v) => v < g.NETSTAY);

  // ── local S-arc density (carve): count signed swing crossings per 100 m over +/-SW ──
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

  // ── assemble back onto every original point (valid → full signals, error → position only) ──
  const pos = new Array(N).fill(-1);
  valid.forEach((i, k) => {
    pos[i] = k;
  });
  return points.map((p, i) => {
    if (!inSeries(gpsStatus[i])) return { ...p, x: xAll[i], y: yAll[i], gpsStatus: gpsStatus[i] };
    const k = pos[i];
    return {
      ...p,
      x: xAll[i],
      y: yAll[i],
      gpsStatus: gpsStatus[i],
      hs: hs[k],
      vs: vs[k],
      straight: straight[k],
      steady: steady[k],
      netsp: netsp[k],
      netd150: netd150[k],
      wander: wander[k],
      maDist: maDist[k],
      carve: carve[k],
      outlier: outlier[k],
      paused: paused[k],
    };
  });
}
