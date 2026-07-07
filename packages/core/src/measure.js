// Point-level measurement — the pure, parameter-free core (ported from the Python prototype's L1
// CORE first step, gpx_stabilize.py 216–261). It projects each point to local meters and takes
// adjacent-pair deltas plus the PLANAR kinematic derivatives (velocity, acceleration) and a separate
// vertical rate; every value depends only on a point and its immediate neighbour (O(1)/point, no
// window), so this layer needs no tuning params. `deltas` is planar (x/y); `kinematics` is the
// horizontal-only derivative tower and `verticalRate` is the separate vertical axis (B decomposition:
// horizontal and vertical GPS errors are different processes — see SPEC). Windowed
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
 * Bundle: positions `xAll/yAll` (all points), `x/y/el/t` (valid); per-step `dt`, planar `planarStep`; the
 * PLANAR kinematic derivatives `velocity` (m/s) and `acceleration` (m/s²), each `{ vec, dir, mag }`
 * (horizontal vector, heading, magnitude); the separate vertical speed `vz` (m/s, Δel/Δt); `speed` =
 * the device `<speed>` per valid point (or null); and the raw GPS-chip quality fields `hdop`
 * (dilution of precision) and `fix` ("2d"/"3d"/"none") per valid point, or null when the source
 * never populates them (e.g. Android/FitoTrack GPX has neither tag at all).
 * Every array is per-point length `valid.length` — the per-step quantities are padded so the last
 * point reuses the previous step's value, so consumers index directly by point (no n−1 offset).
 *
 * @param {TrackPoint[]} points
 * @param {number[]} valid  indices of the trusted/timed points
 */
export function measure(points, valid) {
  const { xAll, yAll, x, y, el, t, lat0, lon0 } = project(points, valid); // block 1
  const { dt, planarStep } = deltas(x, y, t); //                block 2
  const { velocity, acceleration } = kinematics(x, y, dt); //   block 3 — PLANAR (x/y only)
  const vz = verticalRate(el, dt); //                           block 3b — the separate vertical axis
  const speed = valid.map((i) => points[i].speed ?? null); //   device <speed> per valid point, or null
  const hdop = valid.map((i) => points[i].hdop ?? null); //     device <hdop> per valid point, or null
  const fix = valid.map((i) => points[i].fix ?? null); //       device <fix> ("2d"/"3d"/"none") or null
  // Align every per-step array to per-point length n: the last point reuses the previous step's
  // value ("same as its neighbour"), so all bundle arrays index directly by point — no n-1 offset.
  return {
    xAll,
    yAll,
    x,
    y,
    el,
    t,
    lat0, // projection centre — lets a consumer invert x/y back to lat/lon (e.g. the HTML viewer's
    lon0, // click-to-show-coordinates feature)
    dt: padLast(dt),
    planarStep: padLast(planarStep),
    velocity: padOrder(velocity),
    acceleration: padOrder(acceleration),
    vz: padLast(vz),
    speed,
    hdop,
    fix,
    n: valid.length,
  };
}

/** Pad a per-step array (length n−1) to per-point length n by repeating the last value. */
function padLast(a) {
  return a.length ? [...a, a[a.length - 1]] : a;
}

/** padLast applied to a derivative-order record's component arrays (planar x/y). */
function padOrder(o) {
  return {
    vec: { x: padLast(o.vec.x), y: padLast(o.vec.y) },
    dir: { x: padLast(o.dir.x), y: padLast(o.dir.y) },
    mag: padLast(o.mag),
  };
}

/**
 * Canonical horizontal speed at valid-point `p` (m/s): the device `<speed>` if the source GPX gave
 * one, else the magnitude of the planar (x/y) velocity. The single place this rule lives — consumers
 * that want "the best speed we have" call this rather than re-deriving it.
 *
 * Caveat: the device `<speed>` is NOT an independent Doppler reading on this data. Measured against the
 * position-derived speed it moves in lockstep — e.g. ~2.4 m/s while the receiver sits physically still
 * during indoor drift — so it inherits the same GPS jitter and gives NO edge when stationary. Don't
 * trust it (or any horizontal speed) to detect a stop; the only honest "not moving" signal during
 * drift is the vertical axis (`vs ≈ 0`, barometric).
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
  return { xAll, yAll, x, y, el, t, lat0, lon0 };
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
 * Block 3 — the **planar (x/y)** kinematic derivative tower of position. GPS horizontal and vertical
 * errors are different processes (VDOP ≈ 2–3× HDOP) and horizontal is a 2-D coupled curve, so the
 * tower is horizontal-only and elevation is a *separate* axis (`verticalRate`, parameterised by the
 * cleaner horizontal distance — the B decomposition; see SPEC). `velocity` = Δ(x,y) / Δt (m/s);
 * `acceleration` = Δvelocity / Δt (m/s², its [0] the zero vector). Each order is `{ vec, dir, mag }`:
 * the 2-D vector, its unit heading, and its magnitude — so `velocity.mag` is the *horizontal* speed
 * and `velocity.dir` the heading. A `jerk` order would slot in the same way (3rd-order 1 Hz GPS = noise).
 */
export function kinematics(x, y, dt) {
  const s = Math.max(0, x.length - 1); // one value per step
  // order 1 — velocity = Δ(x,y) / Δt
  const velocity = derivOrder(s, (i) => {
    const h = dt[i] || 1;
    return [(x[i + 1] - x[i]) / h, (y[i + 1] - y[i]) / h];
  });
  // order 2 — acceleration = Δvelocity / Δt (zero at the first step)
  const v = velocity.vec;
  const acceleration = derivOrder(s, (i) => {
    if (i === 0) return [0, 0];
    const h = dt[i] || 1;
    return [(v.x[i] - v.x[i - 1]) / h, (v.y[i] - v.y[i - 1]) / h];
  });
  return { velocity, acceleration };
}

/**
 * Block 3b — vertical speed `Δel / Δt` per step (m/s): the **separate vertical axis** (B decomposition).
 * Kept apart from the planar tower because vertical GPS noise is a different, larger process; the
 * along-track *grade* (Δel / horizontal distance) and its physical bound live in the vertical analysis.
 */
export function verticalRate(el, dt) {
  const s = Math.max(0, el.length - 1);
  const vz = new Array(s);
  for (let i = 0; i < s; i++) vz[i] = (el[i + 1] - el[i]) / (dt[i] || 1);
  return vz;
}

/** Build one planar derivative-order record `{ vec, dir, mag }` from a per-step (x,y) vector function. */
function derivOrder(s, vecAt) {
  const vx = new Array(s);
  const vy = new Array(s);
  const dx = new Array(s);
  const dy = new Array(s);
  const mag = new Array(s);
  for (let i = 0; i < s; i++) {
    const [ax, ay] = vecAt(i);
    vx[i] = ax;
    vy[i] = ay;
    const m = Math.hypot(ax, ay);
    mag[i] = m;
    const inv = m > 1e-9 ? 1 / m : 0; // a zero vector has no direction
    dx[i] = ax * inv;
    dy[i] = ay * inv;
  }
  return { vec: { x: vx, y: vy }, dir: { x: dx, y: dy }, mag };
}
