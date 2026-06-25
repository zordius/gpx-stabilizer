// Point-level measurement — the pure, parameter-free core (ported from the Python prototype's L1
// CORE first step, gpx_stabilize.py 216–261). It projects each point to local meters and takes
// adjacent-pair deltas plus the 3D kinematic derivatives (velocity, acceleration); every value
// depends only on a point and its immediate neighbour (O(1)/point, no window), so this layer needs
// no tuning params. `deltas` is planar (x/y); `kinematics` adds the 3D derivative tower. Windowed
// descriptors live in ./profile.js;
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
 * series: the projection centre is their mean and the deltas/directions run along them. Every point
 * is still projected (so excluded points get `xAll/yAll`). Returns the per-point primitive bundle
 * that profile.js turns into windowed descriptors and analyze.js assembles back onto the points.
 *
 * Bundle: positions `xAll/yAll` (all points), `x/y/el/t` (valid); per-step `dt`, planar `planarStep`; and
 * the 3D kinematic derivatives `velocity` (m/s) and `acceleration` (m/s²), each `{ vec, dir, mag }`
 * (vector, unit direction, magnitude); and `speed` = the device `<speed>` per valid point (or null).
 * Every array is per-point length `valid.length` — the per-step quantities are padded so the last
 * point reuses the previous step's value, so consumers index directly by point (no n−1 offset).
 *
 * @param {TrackPoint[]} points
 * @param {number[]} valid  indices of the trusted/timed points
 */
export function measure(points, valid) {
  const { xAll, yAll, x, y, el, t } = project(points, valid); // block 1
  const { dt, planarStep } = deltas(x, y, t); //                block 2
  const { velocity, acceleration } = kinematics(x, y, el, dt); // block 3
  const speed = valid.map((i) => points[i].speed ?? null); //   device <speed> per valid point, or null
  // Align every per-step array to per-point length n: the last point reuses the previous step's
  // value ("same as its neighbour"), so all bundle arrays index directly by point — no n-1 offset.
  return {
    xAll,
    yAll,
    x,
    y,
    el,
    t,
    dt: padLast(dt),
    planarStep: padLast(planarStep),
    velocity: padOrder(velocity),
    acceleration: padOrder(acceleration),
    speed,
    n: valid.length,
  };
}

/** Pad a per-step array (length n−1) to per-point length n by repeating the last value. */
function padLast(a) {
  return a.length ? [...a, a[a.length - 1]] : a;
}

/** padLast applied to a derivative-order record's component arrays. */
function padOrder(o) {
  return {
    vec: { x: padLast(o.vec.x), y: padLast(o.vec.y), z: padLast(o.vec.z) },
    dir: { x: padLast(o.dir.x), y: padLast(o.dir.y), z: padLast(o.dir.z) },
    mag: padLast(o.mag),
  };
}

/**
 * Canonical horizontal speed at valid-point `p` (m/s): the device `<speed>` if the source GPX gave
 * one, else the magnitude of the planar (x/y) velocity. The single place this rule lives — consumers
 * that want "the best speed we have" call this rather than re-deriving it. (Device Doppler speed is
 * cleaner; position-differenced speed runs ~5 % high from jitter.)
 * @param {ReturnType<typeof measure>} ctx  a measure bundle (needs `speed`, `velocity`)
 * @param {number} p  valid-point index
 */
export function speedOf(ctx, p) {
  if (ctx.speed?.[p] != null) return ctx.speed[p];
  const v = ctx.velocity.vec;
  return v.x.length ? Math.hypot(v.x[p], v.y[p]) : 0;
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

/** Block 2 — per-step planar distance and time delta (dt floored at 1 s against duplicate stamps). */
export function deltas(x, y, t) {
  const n = x.length;
  const dt = new Array(Math.max(0, n - 1));
  const planarStep = new Array(Math.max(0, n - 1));
  for (let i = 0; i < n - 1; i++) {
    dt[i] = Math.max(t[i + 1] - t[i], 1.0);
    planarStep[i] = Math.hypot(x[i + 1] - x[i], y[i + 1] - y[i]); // planar (x/y only, no elevation)
  }
  return { dt, planarStep };
}

/**
 * Block 3 — the 3D kinematic derivative tower of position (the first 3D quantities here; deltas
 * above is planar). `velocity` = Δposition / Δt (m/s); `acceleration` = Δvelocity / Δt (m/s², the
 * second derivative of position) — its [0] is the zero vector (no previous step). Each order is the
 * same shape `{ vec, dir, mag }`: the vector, its 3D unit direction, and its magnitude — so
 * `velocity.mag` is the 3D speed and `velocity.dir` the heading. Add a `jerk` order the same way if
 * ever needed — but 3rd-order differences of 1 Hz GPS are dominated by noise.
 */
export function kinematics(x, y, el, dt) {
  const s = Math.max(0, x.length - 1); // one value per step
  // order 1 — velocity = Δposition / Δt
  const velocity = derivOrder(s, (i) => {
    const h = dt[i] || 1;
    return [(x[i + 1] - x[i]) / h, (y[i + 1] - y[i]) / h, (el[i + 1] - el[i]) / h];
  });
  // order 2 — acceleration = Δvelocity / Δt (zero at the first step)
  const v = velocity.vec;
  const acceleration = derivOrder(s, (i) => {
    if (i === 0) return [0, 0, 0];
    const h = dt[i] || 1;
    return [(v.x[i] - v.x[i - 1]) / h, (v.y[i] - v.y[i - 1]) / h, (v.z[i] - v.z[i - 1]) / h];
  });
  return { velocity, acceleration };
}

/** Build one derivative-order record `{ vec, dir, mag }` from a per-step vector function. */
function derivOrder(s, vecAt) {
  const vx = new Array(s);
  const vy = new Array(s);
  const vz = new Array(s);
  const dx = new Array(s);
  const dy = new Array(s);
  const dz = new Array(s);
  const mag = new Array(s);
  for (let i = 0; i < s; i++) {
    const [ax, ay, az] = vecAt(i);
    vx[i] = ax;
    vy[i] = ay;
    vz[i] = az;
    const m = Math.hypot(ax, ay, az);
    mag[i] = m;
    const inv = m > 1e-9 ? 1 / m : 0; // a zero vector has no direction
    dx[i] = ax * inv;
    dy[i] = ay * inv;
    dz[i] = az * inv;
  }
  return { vec: { x: vx, y: vy, z: vz }, dir: { x: dx, y: dy, z: dz }, mag };
}
