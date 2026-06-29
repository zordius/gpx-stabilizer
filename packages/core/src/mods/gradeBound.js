// Compute module "gradeBound" — a TERRAIN-PRESERVING elevation despike via a physical grade-change
// bound. The vertical analog of the turn-rate / `activity` envelope (B decomposition): grade
// (Δel / horizontal-distance) cannot jump, because `|d(grade)/ds| × hs² = vertical acceleration`,
// which is physically bounded for any body/vehicle. So a grade-change *spike* is necessarily noise,
// whatever the activity — and the bound is **speed-adaptive for free** (it lives in acceleration, so
// faster ⇒ tighter grade-change). This rewrites `el` to the closest profile whose grade-change stays
// within the bound everywhere: it removes physically-IMPOSSIBLE spikes while leaving in-bound real
// terrain untouched (no over-flatten — a mean smoother can't do both).
//
// Validated (experiment A, `gpx_eval/grade_recon.mjs`, vs the IMU-fused truth): preserves terrain
// (RMS-to-truth stays ~raw where a mean over-flattens), but only catches the impossible spikes —
// in-bound noise passes (physics can't tell a small real grade-change from a small noise one). So
// this is a despike, NOT a full smoother. Emits a namespaced signal `point.gradeBound.ele`; the raw
// `el` is untouched in-pipeline (the export decides — `stabilize`'s `opts.despike`). Params follow the
// in-module `g.X ?? default` convention.

export const compute = ({ el, planarStep, dt, g }) => {
  const n = el.length;
  const ele = el.slice();
  if (n < 3) return { ele };
  const aMax = g?.GRADE_AMAX ?? 1.5; //   tolerable vertical accel (m/s²) — a physical constant, not tuning
  const HS_MIN = g?.GRADE_HS_MIN ?? 1.5; // m/s floor: near a stop don't let aMax/hs² blow the bound up
  const ITERS = g?.GRADE_ITERS ?? 400; //  iteration cap (converges far sooner for isolated spikes)

  // cumulative along-track horizontal distance + horizontal speed per point
  const s = new Array(n);
  s[0] = 0;
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + planarStep[i - 1];
  const hs = new Array(n);
  for (let i = 0; i < n; i++) hs[i] = i ? planarStep[i - 1] / (dt[i - 1] || 1) : 0;

  // Gauss-Seidel curvature clamp: only points whose grade-change (curvature of ele-vs-distance)
  // exceeds the local bound are pulled — minimally — toward the bound, so in-bound terrain is left be.
  for (let it = 0; it < ITERS; it++) {
    let maxAdj = 0;
    for (let i = 1; i < n - 1; i++) {
      const dsL = s[i] - s[i - 1];
      const dsR = s[i + 1] - s[i];
      if (dsL <= 0 || dsR <= 0) continue;
      const span = (dsL + dsR) / 2;
      const curv = ((ele[i + 1] - ele[i]) / dsR - (ele[i] - ele[i - 1]) / dsL) / span; // d(grade)/ds
      const v = Math.max(hs[i], HS_MIN);
      const kMax = aMax / (v * v);
      if (Math.abs(curv) > kMax) {
        const target = Math.sign(curv) * kMax;
        const A = (1 / dsR + 1 / dsL) / span;
        const B = (ele[i + 1] / dsR + ele[i - 1] / dsL) / span;
        const adj = (B - target) / A - ele[i];
        ele[i] += adj * 0.5; // relaxation for stability
        if (Math.abs(adj) > maxAdj) maxAdj = Math.abs(adj);
      }
    }
    if (maxAdj < 1e-4) break;
  }
  return { ele };
};
