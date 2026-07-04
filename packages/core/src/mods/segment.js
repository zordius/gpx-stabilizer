// Compute module "segment" — FINALIZE phase (opt-in; NOT a built-in, like `kink`). Coarse
// lift/descent/flat segmentation of the CLEAN track: each kept point gets `point.segment = { id, type }`.
//
// Corpus finding (SPEC "Segment / lift segmentation"): the robust, geometry-only lift/descent axis is
// the SIGN of a *detection-denoised* vertical speed — a windowed Δele/Δt this module computes for
// itself purely to read structure (coarse, throwaway; it never rewrites the shipped `ele`). LIFT is a
// sustained climb, RUN a sustained descent, FLAT the sustained near-zero residue. Hysteresis (a ±V_ON
// dead-band on the windowed vspeed) + a minimum-episode merge recover the true multi-minute episodes
// instead of per-sample slivers.
//
// Ordering (SPEC "Two elevation smoothings"): this runs POST-stabilize (raw teleports would wreck the
// signal) and BEFORE any per-activity output-smoothing — segmentation labels the run so a later
// `finalize` smoother can smooth each segment by type. That is why it is a `finalize` module: it needs
// the cleaned points and runs in the sequential post-assemble stage. First cut is the coarse
// three-way split; turn-based lift-confirmation and catwalk-vs-carve sub-split are follow-ons.
//
// Thresholds are first-look guesses (see gpx_eval/seg_explore.mjs), overridable via g.SEG_*.

const V_ON = 0.3; //   |windowed vspeed| (m/s) hysteresis band: >+ = lift, <− = descent, else flat
const WIN_S = 15; //   ± detection-denoise half-window (s) for the vspeed estimate
const MIN_S = 60; //   episodes shorter than this merge into the previous (kills transition slivers)

export const finalize = (out, ctx) => {
  const g = ctx.g ?? {};
  const vOn = g.SEG_VON ?? V_ON;
  const winS = g.SEG_WIN_S ?? WIN_S;
  const minS = g.SEG_MIN_S ?? MIN_S;

  // segment over the CLEAN track only: kept points (no dropReason), already in time order
  const kept = [];
  for (const p of out) if (!p.dropReason && p.time != null && Number.isFinite(p.ele)) kept.push(p);
  const n = kept.length;
  if (n < 2) return; // nothing to segment

  const t = kept.map((p) => p.time / 1000);
  const ele = kept.map((p) => p.ele);

  // detection-denoise: windowed Δele/Δt (m/s) via a two-pointer sweep over the ±winS neighbourhood
  const vspeed = new Array(n);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    while (t[i] - t[lo] > winS) lo++;
    while (hi < n - 1 && t[hi + 1] - t[i] <= winS) hi++;
    vspeed[i] = (ele[hi] - ele[lo]) / Math.max(1, t[hi] - t[lo]);
  }
  const typeOf = (v) => (v > vOn ? "lift" : v < -vOn ? "descent" : "flat");

  // classify each point → merge consecutive same-type into runs → absorb sub-minS episodes forward
  const runs = [];
  for (let i = 0; i < n; i++) {
    const type = typeOf(vspeed[i]);
    const last = runs[runs.length - 1];
    if (last && last.type === type) last.b = i;
    else runs.push({ type, a: i, b: i });
  }
  const merged = [];
  for (const r of runs) {
    if (merged.length && t[r.b] - t[r.a] < minS)
      merged[merged.length - 1].b = r.b; // absorb into prev
    else merged.push({ ...r });
  }

  // label every kept point with its segment id + type
  merged.forEach((seg, id) => {
    for (let i = seg.a; i <= seg.b; i++) kept[i].segment = { id, type: seg.type };
  });
};
