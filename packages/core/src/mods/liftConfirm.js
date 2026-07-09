// Compute module "liftConfirm" — FINALIZE phase, opt-in (ski mode only, like `kink`/`segment`).
// Confirms or rejects `segment.js`'s coarse `lift` candidate runs against a real cable line's
// physical constraints. Does NOT touch `point.segment` (segment.js's own output stays exactly what
// it measured) — writes its verdict into its own namespace, `point.liftConfirm = { type }`, so a
// consumer can compare "what segment.js measured" vs "what liftConfirm confirmed" directly.
//
// Ported from a pre-rewrite Python prototype's lift logic (see SPEC.md "Prior art for the
// follow-ons above", 2026-07-07) — thresholds below are its first-look numbers, carried over
// UNTUNED (same stance `segment.js` itself already takes: "Thresholds are first-look guesses, not
// tuned"), not re-derived against this repo's own corpus.
//
// `type` values: "lift" (confirmed), "ascent" (climbing, not confirmed as a cable ride — too
// winding/fast to trust, or too short after merging), "powered" (reuses `activity.js`'s existing
// term for an engine-driven vehicle — a switchbacking or too-fast "climb" is a road, not a rope; a
// lift/ascent/descent/flat run sandwiched between two strong `powered` runs also absorbs into it),
// "noise" (GPS drift while notionally on the lift — high heading-wander + confined + slow, the same
// "wandering while essentially stationary" shape as `drift`, just computed once per whole run
// instead of windowed — a genuinely different check: `drift`'s own flat-vertical-speed gate can
// never fire on a real lift climb, since a `lift` run is BY DEFINITION not flat-vertical).
//
// Sandwich absorption is scoped to `ascent` runs only for now — descent/flat absorption needs a
// symmetric `skiConfirm` module (not built yet) to have its own namespace to write into; extending
// this module to relabel descent/flat directly would mean writing a lift-confirmation verdict on a
// point that was never a lift candidate. [TBC once skiConfirm exists.]
//
// Head/tail trim (2026-07-07): `segment.js` glues a run purely on vertical-speed sign, with no idea
// about HORIZONTAL direction — so a genuine lift ride followed by walking off the platform in a new
// direction (still net-climbing, e.g. up a short rise before the trail starts) lands in the SAME
// run. The whole-run median checks in ①/③ below can miss this: a windowed signal like
// `straightLong` recovers once the post-lift walk settles into ITS OWN new straight-ish direction,
// pulling the run's median back above the ① threshold even though the run's direction genuinely
// broke partway through — found chasing a 260m liftSnap offset on `20260211-GOPR-c8713177.gpx`
// (Hero5): the first ~450 points held a rock-steady heading/speed (a real gondola), the remaining
// ~280 swung through 10 unrelated headings after getting off. So before ①, find the run's own
// consistent "core" (robustly estimated from its middle 60%, so a head/tail anomaly can't skew the
// reference it's trimmed against) and drop anything before/after it that doesn't locally match that
// core's heading AND speed for a sustained stretch — those excess points become `ascent` directly,
// never entering ①-⑤ at all.

import { addDrop } from "../analyze.js";

const LIFT_STRAIGHT = 0.5; //      lift candidate must be at least this straight (net/path ratio)
const LIFT_HS_MAX = 13.0; //       m/s — a cable can't move a rider faster than this
const LIFT_MIN_DUR = 60; //        s — an isolated lift run shorter than this isn't trusted alone
const LIFT_RDP_EPS = 40.0; //      m — Douglas-Peucker simplification epsilon before counting turns
const LIFT_FAKE_DEG = 45.0; //     degrees — a simplified turn sharper than this is not a cable line
const LIFT_FAKE_TURNS = 2; //      that many sharp turns -> switchbacking road, not a lift
const LIFT_FAKE_V = 7.0; //        m/s — median speed above this alone is too fast for a cable
const LIFT_DRIVE_MINSPD = 5.0; //  m/s — a winding climb only counts as `powered` if also this fast
const LIFT_DRIFT_WANDER = 0.85; // whole-run 3-D heading circular variance above this = drifting
const LIFT_DRIFT_DISP = 50.0; //   m — and confined to within this net displacement
const LIFT_DRIFT_VMED = 2.5; //    m/s — and slow
const LIFT_SANDWICH_MAX = 400; //  s — cap on an ascent run's own duration to still be "sandwiched"
const LIFT_SANDWICH_RATIO = 0.4; // cap grows by this fraction of the longer neighbouring `powered` run
const LIFT_TRIM_WIN_S = 10; //     s — ± half-window for a point's own local heading/speed estimate
const LIFT_TRIM_HEAD_DEG = 30; //  degrees — local heading must be within this of the run's core direction
const LIFT_TRIM_SPEED_FRAC = 0.5; // local speed must be within this fraction of the core's own speed
const LIFT_TRIM_SUSTAIN = 5; //    consecutive in-tolerance points required to mark entering/leaving the core
const LIFT_TRIM_MIN_CORE_FRAC = 0.5; // don't trim at all unless the found core covers at least this fraction

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function dist(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// Ramer-Douglas-Peucker line simplification over [x, y] pairs.
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  const abx = bx - ax;
  const aby = by - ay;
  const len = Math.hypot(abx, aby) || 1;
  let maxD = -1;
  let maxI = 0;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.abs((pts[i][0] - ax) * aby - (pts[i][1] - ay) * abx) / len;
    if (d > maxD) {
      maxD = d;
      maxI = i;
    }
  }
  if (maxD > eps) {
    const left = rdp(pts.slice(0, maxI + 1), eps);
    const right = rdp(pts.slice(maxI), eps);
    return [...left.slice(0, -1), ...right];
  }
  return [pts[0], pts[pts.length - 1]];
}

// Count simplified-vertex turns sharper than `degThreshold`.
function countSharpTurns(simplified, degThreshold) {
  let n = 0;
  for (let k = 1; k < simplified.length - 1; k++) {
    const v1x = simplified[k][0] - simplified[k - 1][0];
    const v1y = simplified[k][1] - simplified[k - 1][1];
    const v2x = simplified[k + 1][0] - simplified[k][0];
    const v2y = simplified[k + 1][1] - simplified[k][1];
    const ang =
      Math.abs(Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y)) * (180 / Math.PI);
    if (ang > degThreshold) n++;
  }
  return n;
}

// Whole-run 3-D heading circular variance (1 - mean resultant length of unit step vectors):
// ~0 for a line/arc, ~1 for a wandering/GPS-drifting path. Needs >=3 real steps, else -1 (unusable).
function wanderScore3D(points) {
  const steps = [];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const dz = (points[i].ele ?? 0) - (points[i - 1].ele ?? 0);
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-9) steps.push({ ux: dx / len, uy: dy / len, uz: dz / len });
  }
  if (steps.length < 3) return -1;
  const meanOf = (key) => steps.reduce((s, v) => s + v[key], 0) / steps.length;
  return 1 - Math.hypot(meanOf("ux"), meanOf("uy"), meanOf("uz"));
}

// Group points by their (already contiguous, time-ordered) `segment.id` into per-run point arrays.
function groupRuns(points) {
  const map = new Map();
  for (const p of points) {
    if (!map.has(p.segment.id)) map.set(p.segment.id, []);
    map.get(p.segment.id).push(p);
  }
  return [...map.values()];
}

function circularMeanHeadingDeg(headingsDeg) {
  let sx = 0;
  let sy = 0;
  for (const h of headingsDeg) {
    const r = (h * Math.PI) / 180;
    sx += Math.cos(r);
    sy += Math.sin(r);
  }
  return (Math.atan2(sy, sx) * 180) / Math.PI;
}

// Smallest angle (0..180) between two headings in degrees.
function circularDiffDeg(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

// Per-point windowed heading (degrees, from the window's first to last point) and median speed —
// a two-pointer ± winS sweep, same shape as segment.js's own windowed vspeed. `heading[i]` is null
// where the window has no span to measure (a single point).
function windowedHeadingAndSpeed(points, winS) {
  const n = points.length;
  const heading = new Array(n);
  const speed = new Array(n);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    while (points[i].time - points[lo].time > winS * 1000) lo++;
    while (hi < n - 1 && points[hi + 1].time - points[i].time <= winS * 1000) hi++;
    heading[i] =
      lo === hi
        ? null
        : (Math.atan2(points[hi].x - points[lo].x, points[hi].y - points[lo].y) * 180) / Math.PI;
    speed[i] = median(points.slice(lo, hi + 1).map((p) => p.hs ?? 0));
  }
  return { heading, speed };
}

function sustainedTrue(arr, start, count) {
  if (start < 0 || start + count > arr.length) return false;
  for (let k = start; k < start + count; k++) if (!arr[k]) return false;
  return true;
}

// Minimum standard for the `"ascent"` label itself, applied at every site that assigns it below: the
// stretch must have actually gained net elevation (end higher than start) — a `"lift"` candidate that
// fails confirmation but never climbed isn't an ascent of any kind (most concretely, the tail of a
// real ski-away descent after unloading, which segment.js's vertical-speed grouping can still glue
// into the same `"lift"`-typed run as the climb before it; trimToCore then correctly splits it off
// for having a different heading/speed, but with no elevation check that split alone doesn't stop it
// from being mislabeled "ascent" and then, e.g., swept into a lift-boundary search as if still
// climbing). Points that fail the label's underlying check AND this gain check get no
// `liftConfirm` at all, not a fallback label — they're neither a lift nor an ascent.
function gainedElevation(points) {
  return (points.at(-1)?.ele ?? 0) - (points[0]?.ele ?? 0) > 0;
}

// Find the run's own consistent "core" and split off any head/tail that doesn't locally match it.
// The core's reference heading/speed is estimated from the middle 60% of the run (index-based) so a
// head/tail anomaly can't skew the very reference it's being trimmed against. Only trims when the
// core covers at least `minCoreFrac` of the run — a run that's winding/inconsistent THROUGHOUT (no
// majority core anywhere, e.g. a genuinely switchbacking road, or whole-run GPS scatter) has no
// reliable core to trim TO, so it's left untouched for ①/③/④'s own whole-run aggregate checks to
// judge instead, exactly as before this step existed. Validated on the real motivating case
// (`20260211-GOPR-c8713177.gpx` run 21): the confirmed core covers 503/737 points (68%) and its own
// max liftSnap offset drops from 260.9 m (untrimmed) to 5.1 m.
function trimToCore(points, opts) {
  const n = points.length;
  if (n < opts.sustain * 2) return { core: points, headExcess: [], tailExcess: [] };

  const midLo = Math.floor(n * 0.2);
  const midHi = Math.ceil(n * 0.8);
  const midHeadings = [];
  for (let i = midLo + 1; i < midHi; i++) {
    midHeadings.push(
      (Math.atan2(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y) * 180) / Math.PI,
    );
  }
  const refDir = circularMeanHeadingDeg(midHeadings);
  const refSpeed = median(points.slice(midLo, midHi).map((p) => p.hs ?? 0));

  const { heading, speed } = windowedHeadingAndSpeed(points, opts.win);
  const isCore = points.map((_, i) => {
    if (heading[i] == null) return false;
    const hdgOk = circularDiffDeg(heading[i], refDir) < opts.headTolDeg;
    const spdOk = Math.abs(speed[i] - refSpeed) <= opts.speedTolFrac * refSpeed;
    return hdgOk && spdOk;
  });

  let a = 0;
  while (a < n && !sustainedTrue(isCore, a, opts.sustain)) a++;
  let b = n - 1;
  while (b >= 0 && !sustainedTrue(isCore, b - opts.sustain + 1, opts.sustain)) b--;
  if (a > b || b + 1 - a < n * opts.minCoreFrac)
    return { core: points, headExcess: [], tailExcess: [] };
  return {
    core: points.slice(a, b + 1),
    headExcess: points.slice(0, a),
    tailExcess: points.slice(b + 1),
  };
}

export const finalize = (out, ctx) => {
  const g = ctx.g ?? {};
  const straight = g.LIFT_STRAIGHT ?? LIFT_STRAIGHT;
  const hsMax = g.LIFT_HS_MAX ?? LIFT_HS_MAX;
  const minDur = g.LIFT_MIN_DUR ?? LIFT_MIN_DUR;
  const rdpEps = g.LIFT_RDP_EPS ?? LIFT_RDP_EPS;
  const fakeDeg = g.LIFT_FAKE_DEG ?? LIFT_FAKE_DEG;
  const fakeTurns = g.LIFT_FAKE_TURNS ?? LIFT_FAKE_TURNS;
  const fakeV = g.LIFT_FAKE_V ?? LIFT_FAKE_V;
  const driveMinspd = g.LIFT_DRIVE_MINSPD ?? LIFT_DRIVE_MINSPD;
  const driftWander = g.LIFT_DRIFT_WANDER ?? LIFT_DRIFT_WANDER;
  const driftDisp = g.LIFT_DRIFT_DISP ?? LIFT_DRIFT_DISP;
  const driftVmed = g.LIFT_DRIFT_VMED ?? LIFT_DRIFT_VMED;
  const sandwichMax = g.LIFT_SANDWICH_MAX ?? LIFT_SANDWICH_MAX;
  const sandwichRatio = g.LIFT_SANDWICH_RATIO ?? LIFT_SANDWICH_RATIO;
  const trimWin = g.LIFT_TRIM_WIN_S ?? LIFT_TRIM_WIN_S;
  const trimHeadDeg = g.LIFT_TRIM_HEAD_DEG ?? LIFT_TRIM_HEAD_DEG;
  const trimSpeedFrac = g.LIFT_TRIM_SPEED_FRAC ?? LIFT_TRIM_SPEED_FRAC;
  const trimSustain = g.LIFT_TRIM_SUSTAIN ?? LIFT_TRIM_SUSTAIN;
  const trimMinCoreFrac = g.LIFT_TRIM_MIN_CORE_FRAC ?? LIFT_TRIM_MIN_CORE_FRAC;

  const liftPoints = out.filter((p) => p.segment?.type === "lift");
  // id captured up front (not re-read from r.points[0] later) — trimming can empty r.points, which
  // would otherwise make the run's own id unrecoverable for the sandwich pass below.
  const runs = groupRuns(liftPoints).map((points) => ({
    id: points[0].segment.id,
    points,
    verdict: "lift",
  }));
  if (runs.length === 0) return;

  // ⓪ trim head/tail: exclude any stretch that doesn't locally match the run's own core
  // heading/speed (see module doc) — those points become `ascent` directly, never reaching ①-⑤.
  for (const r of runs) {
    const { core, headExcess, tailExcess } = trimToCore(r.points, {
      win: trimWin,
      headTolDeg: trimHeadDeg,
      speedTolFrac: trimSpeedFrac,
      sustain: trimSustain,
      minCoreFrac: trimMinCoreFrac,
    });
    if (gainedElevation(headExcess)) for (const p of headExcess) p.liftConfirm = { type: "ascent" };
    if (gainedElevation(tailExcess)) for (const p of tailExcess) p.liftConfirm = { type: "ascent" };
    r.points = core;
  }

  // ① base confirmation: not straight enough, or too fast for a cable -> ascent (if it climbed)
  for (const r of runs) {
    const strt = median(r.points.map((p) => p.straightLong ?? p.straightShort ?? 0));
    const vmed = median(r.points.map((p) => p.hs ?? 0));
    if (!(strt > straight && vmed < hsMax)) r.verdict = gainedElevation(r.points) ? "ascent" : null;
  }

  // ② minimum duration: still `lift`, but too short -> ascent (if it climbed)
  for (const r of runs) {
    if (r.verdict !== "lift") continue;
    const dur = (r.points.at(-1).time - r.points[0].time) / 1000;
    if (dur < minDur) r.verdict = gainedElevation(r.points) ? "ascent" : null;
  }

  // ③ fake-lift-by-turning / fake-lift-by-speed: a real cable line can't wiggle or go this fast
  for (const r of runs) {
    if (r.verdict !== "lift") continue;
    const vmed = median(r.points.map((p) => p.hs ?? 0));
    if (vmed > fakeV) {
      r.verdict = "powered";
      continue;
    }
    const simplified = rdp(
      r.points.map((p) => [p.x, p.y]),
      rdpEps,
    );
    const sharpTurns = countSharpTurns(simplified, fakeDeg);
    if (sharpTurns >= fakeTurns && vmed > driveMinspd) r.verdict = "powered";
  }

  // ④ GPS-drift override: only on runs still confirmed `lift` (never `ascent`/`powered`) — a real
  // quality problem, so it also drops the points (unlike ①-③, which only relabel).
  for (const r of runs) {
    if (r.verdict !== "lift") continue;
    const disp = dist(r.points[0], r.points.at(-1));
    const vmed = median(r.points.map((p) => p.hs ?? 0));
    const wander = wanderScore3D(r.points);
    if (wander > driftWander && disp < driftDisp && vmed < driftVmed) {
      r.verdict = "noise";
      for (const p of r.points) addDrop(p, "liftConfirm", { reason: "gpsDrift" });
    }
  }

  // ⑤ powered-sandwich, scoped to `ascent` only (see module doc): an ascent run wedged between two
  // `powered` runs, short enough relative to their length, absorbs into `powered` too.
  const allRuns = groupRuns(out.filter((p) => p.segment)).sort(
    (a, b) => a[0].segment.id - b[0].segment.id,
  );
  const verdictById = new Map(runs.map((r) => [r.id, r]));
  const poweredDisp = (run) => {
    const v = run && verdictById.get(run[0].segment.id);
    return v?.verdict === "powered" ? dist(run[0], run.at(-1)) : null;
  };
  for (let i = 0; i < allRuns.length; i++) {
    const run = allRuns[i];
    const v = verdictById.get(run[0].segment.id);
    if (v?.verdict !== "ascent") continue;
    const leftDisp = poweredDisp(allRuns[i - 1]);
    const rightDisp = poweredDisp(allRuns[i + 1]);
    if (leftDisp == null || rightDisp == null) continue;
    const dur = (run.at(-1).time - run[0].time) / 1000;
    if (dur >= sandwichMax + sandwichRatio * Math.max(leftDisp, rightDisp)) continue; // too long -> protect real activity
    v.verdict = "powered";
  }

  // write the verdict into its own namespace — point.segment is never touched. A `null` verdict
  // (failed its confirmation check AND never climbed — see `gainedElevation`) gets no liftConfirm at
  // all: it's neither a lift nor an ascent, so it stays unclassified rather than mislabeled.
  for (const r of runs) {
    if (r.verdict == null) continue;
    for (const p of r.points) p.liftConfirm = { type: r.verdict };
  }
};
