// Compute module "smooth" — a slope-stable elevation by distance-domain smoothing.
//
// `stabilize` removes noise POINTS but never rewrites a survivor's values, so each kept point's
// `ele` is still the raw, per-sample-noisy GPS altitude (±several m — elevation is the noisiest GPS
// axis). A downstream GRADIENT (Δele / horizontal-distance) therefore jitters wildly even when the
// consumer averages slope over a baseline: a windowed *slope* cannot recover from a noisy underlying
// *elevation*. This module smooths the elevation itself, so a grade derived from it has bounded jitter.
//
// Distance-domain, NOT index/time: smooth `el` over an along-track LENGTH SCALE in metres
// (±SMOOTH_WIN_M), using the planar along-track distance `measure` already computes (`planarStep`).
// A metre window is robust to variable speed and sample spacing — a time/index window would smooth
// more where the receiver moved fast. Endpoints use a naturally shrinking window. Constant-grade
// terrain is preserved (the mean of a symmetric, uniformly-sampled ramp is its midpoint), while
// zero-mean per-sample noise averages down by ~√(points-in-window).
//
// Output: a namespaced signal `point.smooth.ele` (raw `ele` left untouched in-pipeline). The EXPORT
// decides what ships — `stabilize` stays raw by default (base ethos = removal, not rewriting); its
// `opts.smooth` flips the exported `ele` to the smoothed value. Module-specific param `SMOOTH_WIN_M`
// follows the in-module `g.X ?? default` convention (like stray's STRAY_*), overridable via opts.
//
// NOTE (current limitation): runs on the post-label valid series, which still contains the points
// the compute-phase drops (outlier/stray/activity) will flag — compute modules are independent and
// don't see each other's drops. A gross ele spike on a soon-to-be-dropped point can thus tug the
// mean within its window. Strictly post-drop smoothing awaits the proposed `finalize` phase (SPEC);
// for the per-sample-noise case this module targets, the effect is minor.

const median = (el, lo, hi) => {
  const w = el.slice(lo, hi).sort((a, b) => a - b);
  const h = w.length >> 1;
  return w.length % 2 ? w[h] : (w[h - 1] + w[h]) / 2;
};

export const compute = ({ el, planarStep, g }) => {
  const n = el.length;
  const ele = new Array(n);
  if (n === 0) return { ele };
  const win = g?.SMOOTH_WIN_M ?? 30; // along-track half-window (m)
  // `SMOOTH_ROBUST` swaps the boxcar mean for a window MEDIAN — robust to `ele` spikes (a lone
  // spike doesn't shift the median, where a mean barely dents it). Recommended for dirty sources
  // (noisy GPS5 altitude / Hero10) whose `ele` carries spikes `stabilize` (horizontal-only) can't
  // drop; the mean default is kept for clean inputs and round-trip stability. See SPEC precondition.
  const robust = g?.SMOOTH_ROBUST ?? false;

  // cumulative along-track planar distance: cpath[i] = Σ planarStep[0..i-1] (non-decreasing)
  const cpath = new Array(n);
  cpath[0] = 0;
  for (let i = 1; i < n; i++) cpath[i] = cpath[i - 1] + planarStep[i - 1];

  // two-pointer sweep of the ±win-metre window [lo, hi) (cpath is sorted, so both edges advance
  // monotonically). The point itself is always in window (distance 0), so the window is never empty.
  let lo = 0;
  let hi = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    while (lo < n && cpath[i] - cpath[lo] > win) sum -= el[lo++];
    while (hi < n && cpath[hi] - cpath[i] <= win) sum += el[hi++];
    ele[i] = robust ? median(el, lo, hi) : sum / (hi - lo);
  }
  return { ele };
};
