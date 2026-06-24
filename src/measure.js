// Point-level measurement — the pure, parameter-free core (ported from the Python prototype's L1
// CORE first step, gpx_stabilize.py 216–261). It projects each point to local meters and takes
// adjacent-pair deltas; every value depends only on a point and its immediate neighbour (O(1)/point,
// no window), so this layer needs no tuning params. Windowed descriptors live in ./profile.js;
// screening/modules/labelling in ./analyze.js. `measure()` runs the numbered blocks below; each
// block is its own exported pure function (unit-testable in isolation).

const DEG_LAT_M = 110540; // meters per degree latitude
const DEG_LON_M = 111320; // meters per degree longitude at the equator

function mean(a) {
  let s = 0;
  for (const v of a) s += v;
  return s / a.length;
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
 * @typedef {{ lat: number, lon: number, ele: number|null, time: number }} TrackPoint
 *   time is epoch milliseconds (as produced by the GPX parser).
 */

/**
 * Run the point-level blocks over `points`, treating `valid` (an index array) as the trusted time
 * series: the projection centre is their mean and the deltas run along them. Every point is still
 * projected (so excluded points get `xAll/yAll`). Returns the per-point primitive bundle that
 * profile.js turns into windowed descriptors and analyze.js assembles back onto the points.
 *
 * @param {TrackPoint[]} points
 * @param {number[]} valid  indices of the trusted/timed points
 */
export function measure(points, valid) {
  const { xAll, yAll, x, y, el, t } = project(points, valid); // block 1
  const { dt, step } = deltas(x, y, t); //                      block 2
  return { xAll, yAll, x, y, el, t, dt, step, n: valid.length };
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
