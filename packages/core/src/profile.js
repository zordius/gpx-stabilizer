// Window-level descriptors — for each point, summarise its ±window neighbourhood: smoothed speed,
// local straightness/steadiness, jitter off the moving-average line, time-windowed net speed /
// displacement / wander, carve density, and the paused flag. Built on the point-level bundle from
// ./measure.js; this layer owns ALL the tuning PARAMS (the point layer needs none). Prefix-sum
// scans (cu, cps, cpath) keep the windowed stats O(1)/point. `profile()` runs the numbered blocks
// below (continuing measure.js's 1–2); each block is its own exported pure function.

export const PARAMS = Object.freeze({
  SW: 15, //          point-count window half-width (smoothing + local straight/steady/carve)
  ELE_SMOOTH: 9, //   ele pre-smoothing width for vertical speed
  D_JUMP: 60, //      detour spike threshold (m)
  A_MAX: 60, //       acceleration spike threshold (m/s^2)
  NETSTAY: 0.25, //   paused when net speed is below this (m/s)
  CARVE_AMP: 0.25, // s-arc swing amplitude threshold (rad)
  NET_WIN: 60, //     net-speed / wander time window (+/- s)
  NETD_WIN: 150, //   net-displacement time window (+/- s)
  NETD_WIN_SHORT: 15, // short net-displacement window (+/- s) — catches a compact stay/wobble
  //                     that NETD_WIN's long window dilutes on a short recording (the long window
  //                     clamps to the whole clip, mixing in real motion far outside the stay)
  S_SHORT: 2, //      s-delta short half-window (samples)
  S_LONG: 10, //      s-delta long half-window (samples)
});

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
 * Compute the windowed descriptors for each point from a point-level measure() bundle. `opts`
 * overrides any PARAMS knob. Returns one bundle of per-point arrays (over the valid sub-sequence)
 * plus the resolved params `g` — the per-point context that analyze.js merges with the measure
 * bundle for compute modules and assembly.
 *
 * Descriptors: hs, vs (smoothed speed); straight, steady (local shape); maDist (jitter); netsp,
 * netd150, netdShort, wander (time-windowed); carve (S-arc density); paused. `cu` is the
 * cumulative-unit-vector scan the windows block differences (exposed for modules).
 *
 * @param {ReturnType<import("./measure.js").measure>} m  point bundle (x, y, el, t, dt, planarStep)
 * @param {Partial<typeof PARAMS>} [opts]
 */
export function profile(m, opts = {}) {
  const g = { ...PARAMS, ...opts };
  const { x, y, el, t, dt, planarStep } = m;
  const { hs, vs } = speeds(planarStep, dt, el, g); //           block 3
  const { straight, steady } = localShape(x, y, hs, g); //       block 4
  const { maDist, cu } = jitter(x, y, el, g); //                 block 5
  const { netsp, netd150, netdShort, wander, paused } = windows(x, y, t, cu, g); // block 6
  // carve (S-arc density) is a SKI-specific signal — no core module consumes it. Gate it on g.CARVE
  // (off by default → zeros) so the general core skips the work; ski mode turns it on. Block 7.
  const carve = g.CARVE ? carveDensity(x, y, planarStep, g) : new Array(x.length).fill(0);
  return {
    hs,
    vs,
    straight,
    steady,
    maDist,
    cu,
    netsp,
    netd150,
    netdShort,
    wander,
    paused,
    carve,
    g,
  };
}

/** Block 3 — horizontal and vertical speed (m/s), each smoothed; ele is pre-smoothed for vs. */
export function speeds(planarStep, dt, el, g) {
  const n = el.length;
  const hsRaw = new Array(n).fill(0);
  for (let i = 1; i < n; i++) hsRaw[i] = planarStep[i - 1] / dt[i - 1];
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
 * Block 5 — high-frequency jitter: distance from the moving-average line, plus the cumulative
 * **planar (2D)** unit step vectors `cu` that the windows block differences for windowed wander.
 * `cu` is horizontal-only (B decomposition: heading is a horizontal concept; verified the 3D→2D
 * change is a no-op for `drift` at its current threshold — `gpx_eval/wander_compare.mjs`).
 * (`maDist` is still the 3D x/y/el jitter — no drop module consumes it; splitting it into a
 * horizontal + a vertical noise-estimate is a separate item, SPEC "Vertical analysis" #3.)
 */
export function jitter(x, y, el, g) {
  const n = x.length;
  const cux = new Array(n);
  const cuy = new Array(n);
  cux[0] = 0;
  cuy[0] = 0;
  for (let i = 1; i < n; i++) {
    const dxu = x[i] - x[i - 1];
    const dyu = y[i] - y[i - 1];
    const lu = Math.max(Math.hypot(dxu, dyu), 1e-9); // planar step length (heading is horizontal)
    cux[i] = cux[i - 1] + dxu / lu;
    cuy[i] = cuy[i - 1] + dyu / lu;
  }
  const xma = smooth(x, g.SW);
  const yma = smooth(y, g.SW);
  const zma = smooth(el, g.SW);
  const maDist = new Array(n);
  for (let i = 0; i < n; i++) {
    maDist[i] = Math.sqrt((x[i] - xma[i]) ** 2 + (y[i] - yma[i]) ** 2 + (el[i] - zma[i]) ** 2);
  }
  return { maDist, cu: { x: cux, y: cuy } };
}

/**
 * Block 6 — time-windowed net speed (+/-NET_WIN), wander (circular variance of `cu` over the same
 * window), net displacement at two scales (+/-NETD_WIN, +/-NETD_WIN_SHORT), and the `paused` flag.
 * The short-window net displacement exists purely to catch a compact stay on a recording shorter
 * than (or not much longer than) NETD_WIN, where the long window clamps to the whole clip and
 * dilutes with real motion outside the stay — same underlying "did the receiver actually go
 * anywhere" question as netd150, just at a scale a short clip's own length doesn't drown out.
 */
export function windows(x, y, t, cu, g) {
  const n = x.length;
  const netsp = new Array(n).fill(0);
  const wander = new Array(n).fill(0);
  const netd150 = new Array(n).fill(9e9);
  const netdShort = new Array(n).fill(9e9);
  for (let i = 0; i < n; i++) {
    const lo = searchLeft(t, t[i] - g.NET_WIN);
    const hi = Math.min(n - 1, searchLeft(t, t[i] + g.NET_WIN));
    netsp[i] = Math.hypot(x[hi] - x[lo], y[hi] - y[lo]) / Math.max(t[hi] - t[lo], 1);
    const ns = hi - lo;
    if (ns >= 3) {
      const rx = cu.x[hi] - cu.x[lo];
      const ry = cu.y[hi] - cu.y[lo];
      wander[i] = 1.0 - Math.hypot(rx, ry) / ns; // planar (2D) circular variance — heading is horizontal
    }
    const l2 = searchLeft(t, t[i] - g.NETD_WIN);
    const h2 = Math.min(n - 1, searchLeft(t, t[i] + g.NETD_WIN));
    netd150[i] = Math.hypot(x[h2] - x[l2], y[h2] - y[l2]);
    const l3 = searchLeft(t, t[i] - g.NETD_WIN_SHORT);
    const h3 = Math.min(n - 1, searchLeft(t, t[i] + g.NETD_WIN_SHORT));
    netdShort[i] = Math.hypot(x[h3] - x[l3], y[h3] - y[l3]);
  }
  const paused = netsp.map((v) => v < g.NETSTAY);
  return { netsp, netd150, netdShort, wander, paused };
}

/** Block 7 — local S-arc density (carve): signed swing crossings per 100 m over +/-SW. */
export function carveDensity(x, y, planarStep, g) {
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
  for (let i = 1; i < n; i++) cpath[i] = cpath[i - 1] + planarStep[i - 1];
  const carve = new Array(n).fill(0);
  for (let k = 0; k < n; k++) {
    const lo = Math.max(0, k - g.SW);
    const hi = Math.min(n, k + g.SW + 1);
    const pth = cpath[hi - 1] - cpath[lo];
    carve[k] = pth > 0 ? ((cps[hi] - cps[lo]) / pth) * 100 : 0.0;
  }
  return carve;
}
