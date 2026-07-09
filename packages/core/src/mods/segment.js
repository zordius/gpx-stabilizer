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
//
// Descent-break override (2026-07-09): the plain MIN_S rule above is type-blind — it absorbs a short
// episode into the PREVIOUS one regardless of type, on the theory that a short episode is probably
// just noise inside one continuous ride. That theory fails for one specific, real shape: getting off
// one lift and skiing/walking over to a genuinely DIFFERENT lift. The real horizontal transit between
// them is a `descent` episode (net downhill) that's individually short — exactly what MIN_S is built
// to swallow — so without an override, two separate lift rides glue into one `segment.id`, and a
// downstream best-fit line (liftSnap) across BOTH rides skews badly (found on
// `workout-2026-02-18_12-20.gpx`, 39.784393°N 140.920760°E: a 30s ski-away registered 82.7° off the
// first lift's own line and 130m of growing lateral drift in that time, yet MIN_S absorbed it — and
// everything after it, including the START of the second lift's own climb — right into the first).
//
// The fix is scoped to `type === "descent"` candidates ONLY, checked against the CURRENT merged
// entry's own best-fit line (a TLS fit, same math as `liftSnap.js`, computed once when that entry was
// first PUSHED — not re-fit as absorptions extend it, so a long chain of small absorptions can't drag
// the reference off centre): if the descent's own heading is more than SEG_HDG_BREAK_DEG off that
// line's direction AND its distance from the line is GROWING (not just off to one side), refuse the
// absorption — the descent becomes its own new entry instead, with its own fresh id, breaking the
// chain. Restricting this to `descent` (never `flat`/`lift`) is what keeps it safe: a genuinely
// winding walking/ski-touring ascent routinely swings well past 30° from its own overall best-fit
// line (a real trail curves; a real cable does not), so applying the same check to `lift`/`flat`
// candidates was validated to wrongly fragment those in the middle — restricting to `descent` alone
// reproduced the fix with zero such regressions across two real files (see gpx_eval/segment_break_*).
//
// Lift-sandwich merge (2026-07-09): the opposite failure from the descent-break override above —
// three genuinely-one-ride episodes staying needlessly SPLIT instead of two different rides staying
// wrongly GLUED. A non-`lift` episode wedged directly between two `lift` episodes, moving at a
// similar speed and in (almost) the same direction as BOTH neighbours, is very likely the same
// physical ride: a stretch whose average climb rate just dips under V_ON for long enough (> MIN_S,
// so the plain merge above never even considers it) to stand alone — e.g. a real cable line easing
// through a flatter mid-section. Deliberately does NOT look at elevation rate at all: direction +
// speed are enough to tell "same physical line, still moving" apart from "got off and did something
// else" (a real descent to elsewhere, or a traverse to a different lift), which elevation rate
// can't — that's exactly why this rule needs to exist rather than just widening V_ON's own band.
// Validated across 48 real files (see gpx_eval/sandwich_merge_survey.mjs): of 121 lift-sandwiched
// candidates, 23 satisfy both the heading and speed criteria — those are heavily concentrated at
// heading-diff ≈0° with closely matching speed (the same-ride shape above); the 98 rejected split
// cleanly into heading-diff ≈180° (a real ski descent down the same slope between separate
// boardings) or ≈30–150° (a traverse to a genuinely different lift) — motivating example: segment
// 48 of `workout-2026-02-11_11-03.gpx`, 36.800841°N 138.781174°E — hs 1.58/1.54/1.58 m/s and heading
// within 5° on both sides, yet its own climb rate (0.19 m/s) sits under V_ON while its neighbours
// read 0.39/0.26 m/s.

const V_ON = 0.3; //   |windowed vspeed| (m/s) hysteresis band: >+ = lift, <− = descent, else flat
const WIN_S = 15; //   ± detection-denoise half-window (s) for the vspeed estimate
const MIN_S = 60; //   episodes shorter than this merge into the previous (kills transition slivers)
const HDG_BREAK_DEG = 30; // degrees — how far a `descent` candidate's own heading may deviate from
// the current entry's fitted line before its absorption is refused (see doc above)
const SANDWICH_HDG_DEG = 5; // degrees — max heading difference (to BOTH neighbours) for a
// lift-sandwiched episode to be merged in as part of the same ride
const SANDWICH_SPEED_ABS = 1.5; // m/s — two speeds count as "similar" if within this absolute gap...
const SANDWICH_SPEED_REL = 0.4; // ...OR within this fraction of the larger one, whichever is looser
// (exploratory thresholds from the corpus survey above, not independently tuned per-value)

function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/** Total-least-squares best-fit line through `pts` (same math as `liftSnap.js`'s own line fit,
 * duplicated rather than shared — each finalize module stays self-contained, matching this
 * codebase's existing convention, e.g. `liftConfirm.js`'s own `dist`/`groupRuns`). */
function fitLine(pts) {
  const mx = mean(pts.map((p) => p.x));
  const my = mean(pts.map((p) => p.y));
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let ux = Math.cos(theta);
  let uy = Math.sin(theta);
  const s0 = (pts[0].x - mx) * ux + (pts[0].y - my) * uy;
  const sN = (pts.at(-1).x - mx) * ux + (pts.at(-1).y - my) * uy;
  if (sN < s0) {
    ux = -ux;
    uy = -uy;
  }
  return { mx, my, ux, uy, dirDeg: (Math.atan2(ux, uy) * 180) / Math.PI };
}

/** Signed perpendicular distance of `p` from `line` (metres). */
function lateral(line, p) {
  const dx = p.x - line.mx;
  const dy = p.y - line.my;
  return -dx * line.uy + dy * line.ux;
}

/** Smallest angle (0..180) between two headings in degrees. */
function circDiff(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

/** Is it safe to absorb a `descent` candidate (`pts`) into the entry fitted by `line`? Unsafe (i.e.
 * a real break) only when BOTH hold: the candidate's own point-to-point heading is more than
 * `hdgBreakDeg` off the line's direction, AND its distance from the line grows from first point to
 * last (moving away, not just sitting off to one side). `line` may be `null` (no current entry yet,
 * e.g. the very first run) or `pts` too short to have a heading — both default to "safe". */
function isSafeDescentAbsorb(pts, line, hdgBreakDeg) {
  if (!line || pts.length < 2) return true;
  const a = pts[0];
  const b = pts.at(-1);
  const heading = (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
  const hdgDiff = circDiff(heading, line.dirDeg);
  const growingAway = Math.abs(lateral(line, b)) > Math.abs(lateral(line, a));
  return !(hdgDiff > hdgBreakDeg && growingAway);
}

/** A run's own point-to-point heading: first point to last, in degrees. */
function runHeadingDeg(pts) {
  const a = pts[0];
  const b = pts.at(-1);
  return (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
}

/** Two average speeds count as "similar" if within `speedAbs` m/s of each other, or within
 * `speedRel` of the larger one — whichever tolerance is looser. */
function speedSimilar(a, b, speedAbs, speedRel) {
  return Math.abs(a - b) < speedAbs || Math.abs(a - b) / Math.max(a, b, 0.1) < speedRel;
}

/**
 * Merge every non-`lift` entry in `merged` that is directly sandwiched between two `lift` entries,
 * moves at a similar speed, and heads in (almost) the same direction as BOTH of them (see module doc
 * for why this is safe without looking at elevation rate at all). Mutates `merged` in place
 * (splicing the sandwiched entry and its `lift` successor into the `lift` predecessor). Repeats to a
 * fixed point since merging one sandwich can newly expose another (a lift/non-lift/lift/non-lift/
 * lift chain), restarting the scan after each splice rather than tracking shifted indices.
 */
function mergeLiftSandwiches(merged, kept, hdgMaxDeg, speedAbs, speedRel) {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i < merged.length - 1; i++) {
      const cur = merged[i];
      const prev = merged[i - 1];
      const next = merged[i + 1];
      if (cur.type === "lift" || prev.type !== "lift" || next.type !== "lift") continue;
      const curPts = kept.slice(cur.a, cur.b + 1);
      const prevPts = kept.slice(prev.a, prev.b + 1);
      const nextPts = kept.slice(next.a, next.b + 1);
      if (curPts.length < 2 || prevPts.length < 2 || nextPts.length < 2) continue;
      const curHdg = runHeadingDeg(curPts);
      const curHs = mean(curPts.map((p) => p.hs ?? 0));
      const prevHs = mean(prevPts.map((p) => p.hs ?? 0));
      const nextHs = mean(nextPts.map((p) => p.hs ?? 0));
      const hdgOk =
        circDiff(curHdg, runHeadingDeg(prevPts)) < hdgMaxDeg &&
        circDiff(curHdg, runHeadingDeg(nextPts)) < hdgMaxDeg;
      const speedOk =
        speedSimilar(curHs, prevHs, speedAbs, speedRel) && speedSimilar(curHs, nextHs, speedAbs, speedRel);
      if (hdgOk && speedOk) {
        prev.b = next.b; // absorb cur + next into prev, all as "lift"
        merged.splice(i, 2);
        changed = true;
        break; // indices past i are now shifted -- restart the scan
      }
    }
  }
}

export const finalize = (out, ctx) => {
  const g = ctx.g ?? {};
  const vOn = g.SEG_VON ?? V_ON;
  const winS = g.SEG_WIN_S ?? WIN_S;
  const minS = g.SEG_MIN_S ?? MIN_S;
  const hdgBreakDeg = g.SEG_HDG_BREAK_DEG ?? HDG_BREAK_DEG;
  const sandwichHdgDeg = g.SEG_SANDWICH_HDG_DEG ?? SANDWICH_HDG_DEG;
  const sandwichSpeedAbs = g.SEG_SANDWICH_SPEED_ABS ?? SANDWICH_SPEED_ABS;
  const sandwichSpeedRel = g.SEG_SANDWICH_SPEED_REL ?? SANDWICH_SPEED_REL;

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
  let curLine = null; // current entry's own fitted line, frozen when that entry was first pushed
  for (const r of runs) {
    const wantsAbsorb = merged.length > 0 && t[r.b] - t[r.a] < minS;
    const safe =
      !wantsAbsorb ||
      r.type !== "descent" ||
      isSafeDescentAbsorb(kept.slice(r.a, r.b + 1), curLine, hdgBreakDeg);
    if (wantsAbsorb && safe) {
      merged[merged.length - 1].b = r.b; // absorb into prev
    } else {
      merged.push({ ...r });
      curLine = fitLine(kept.slice(r.a, r.b + 1));
    }
  }

  mergeLiftSandwiches(merged, kept, sandwichHdgDeg, sandwichSpeedAbs, sandwichSpeedRel);

  // label every kept point with its segment id + type
  merged.forEach((seg, id) => {
    for (let i = seg.a; i <= seg.b; i++) kept[i].segment = { id, type: seg.type };
  });
};
