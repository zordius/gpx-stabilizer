// Compute module "liftSnap" — FINALIZE phase, opt-in (ski mode only). Geometric reconstruction for
// runs `liftConfirm` actually confirmed as `lift` (reads `point.liftConfirm?.type === "lift"`, NOT
// `point.segment.type` — a fake/rejected lift must never get snapped). Must run AFTER `liftConfirm`
// in the `modules` array.
//
// Ported from the same pre-rewrite Python prototype as `liftConfirm` (SPEC.md "Prior art for the
// follow-ons above", 2026-07-07). Two physical premises about a real cable line:
//   1. It is a straight line (in the horizontal plane) — every point on a confirmed lift run gets
//      orthogonally projected onto that run's own best-fit line.
//   2. It never travels backward, only pauses — a real stop/hover is detected as one whole EVENT via
//      hysteresis on horizontal speed (see PAUSE EVENT DETECTION below), not deleted but reinterpreted
//      as a pause AT the lift's actual position (moved onto the anchor position from just before the
//      event began, in lat, lon, AND elevation) rather than discarded as noise.
//
// Emits a namespaced signal, `point.liftSnap = { lat, lon, ele? }` — never mutates the point itself
// (same non-destructive convention as `mods/gradeBound.js`'s `point.gradeBound.ele`). `ele` is
// present ONLY for a point inside a confirmed pause event; every snapped point gets `lat`/`lon`,
// since the line-projection touches all of them. `stabilize`'s `opts.liftSnap` decides whether the
// export actually uses this signal (see stabilize.js).
//
// Fade at the run's own boundaries (2026-07-07): `liftConfirm`'s ⓪ trim step gives a run a hard
// start/end, but the real cable line doesn't begin/end exactly there — the last raw-position point
// before the confirmed core and the first fully-snapped point right after it would otherwise show a
// visible jump. So the snap weight ramps 0->1 over the first `LIFTSNAP_FADE_M` metres of along-line
// travel, and 1->0 over the last, blending the snapped position — and, for a pause event, its
// elevation too — toward the point's own raw value near either end rather than snapping it outright.
//
// PAUSE EVENT DETECTION (2026-07-10, replacing a per-point along-line regression check): comparing
// each point's own along-line projection against the run's running high-water mark is noise-sensitive
// — during a genuine stop, GPS jitter on `x`/`y` makes that projection wobble a few millimetres either
// side of flat, so individual points inside the SAME real pause flipped unpredictably between "still
// advancing" (no elevation override) and "paused" (anchored elevation) — found chasing a single-point
// elevation spike inside an otherwise-flat chairlift pause (see git history). Detecting the pause as
// one EVENT on horizontal speed instead removes the flip: hysteresis (enter once `hs` drops at/under
// `LIFTSNAP_PAUSE_HS_ON`, m/s close to a genuine stop; exit only once it recovers to
// `LIFTSNAP_PAUSE_HS_OFF_FRAC` of the run's OWN median speed, clamped to never sit below the enter
// threshold so a slow run can't invert the band) keeps a noisy near-threshold stretch from flickering
// in and out — the same convention `segment.js`'s `V_ON` dead-band uses for its own lift/descent/flat
// classification. A candidate event shorter than `LIFTSNAP_PAUSE_MIN_S` is discarded (too brief to
// trust as a real stop, not just one noisy slow sample) — same minimum-duration guard as
// `liftBoardingEle.js`'s `QUEUE_STOP_MIN_S`. Every point inside a confirmed event shares ONE elevation
// (the event's own median raw `ele` — robust against a single noisy sample inside the event, unlike
// anchoring to one arbitrary point's own reading) and the SAME anchor position (the run's own last
// position before the event began), so no two points in the same real pause can disagree. A point
// with no known `hs` never triggers or clears a pause (missing speed data, not evidence of one) — the
// run's own first point specifically has no prior position yet to anchor a pause to, so it is always
// treated as advancing.

import { unproject } from "../measure.js";

const LIFTSNAP_FADE_M = 20; // metres of along-line travel over which the snap weight ramps 0<->1
const LIFTSNAP_PAUSE_HS_ON = 0.5; // m/s — at/under this, horizontal speed enters a pause event
// (first-look guess, like this module's siblings' own untuned thresholds — see module doc)
const LIFTSNAP_PAUSE_HS_OFF_FRAC = 0.5; // fraction of the run's own median hs required to exit a
// pause event once entered (hysteresis band; always clamped to at least LIFTSNAP_PAUSE_HS_ON below)
const LIFTSNAP_PAUSE_MIN_S = 1; // s — a candidate pause event shorter than this is discarded (too
// brief to trust as a real stop rather than one noisy slow sample)

function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function lerp(a, b, w) {
  return a + w * (b - a);
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

/**
 * Contiguous [from, to] index spans (into `run`) where horizontal speed stays low enough, for long
 * enough, to count as one pause event — hysteresis-gated on `hs` (see module doc) and filtered to at
 * least `minS` seconds long. Index 0 is never eligible (no prior position exists yet to anchor a
 * pause to). A point with no known `hs` neither enters nor clears a pause; it just carries forward
 * whatever state was already in effect.
 */
function findPauseEvents(run, hsOn, hsOffFrac, minS) {
  const speeds = run.map((p) => p.hs);
  const known = speeds.filter((v) => v != null);
  const refSpeed = known.length ? median(known) : 0;
  const hsOff = Math.max(hsOn, hsOffFrac * refSpeed);

  const inPause = new Array(run.length).fill(false);
  let paused = false;
  for (let i = 1; i < run.length; i++) {
    const v = speeds[i];
    if (v != null) {
      if (!paused && v <= hsOn) paused = true;
      else if (paused && v >= hsOff) paused = false;
    }
    inPause[i] = paused;
  }

  const events = [];
  let i = 1;
  while (i < run.length) {
    if (!inPause[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < run.length && inPause[j + 1]) j++;
    if ((run[j].time - run[i].time) / 1000 >= minS) events.push([i, j]);
    i = j + 1;
  }
  return events;
}

export const finalize = (out, ctx) => {
  const g = ctx.g ?? {};
  const fadeM = g.LIFTSNAP_FADE_M ?? LIFTSNAP_FADE_M;
  const hsOn = g.LIFTSNAP_PAUSE_HS_ON ?? LIFTSNAP_PAUSE_HS_ON;
  const hsOffFrac = g.LIFTSNAP_PAUSE_HS_OFF_FRAC ?? LIFTSNAP_PAUSE_HS_OFF_FRAC;
  const minS = g.LIFTSNAP_PAUSE_MIN_S ?? LIFTSNAP_PAUSE_MIN_S;
  const confirmed = out.filter((p) => p.liftConfirm?.type === "lift");
  if (confirmed.length === 0) return;

  for (const run of groupRuns(confirmed)) {
    if (run.length < 3) continue; // too few points for a line fit to mean anything

    // total-least-squares line fit (2x2 covariance eigen-decomposition -> principal direction)
    const mx = mean(run.map((p) => p.x));
    const my = mean(run.map((p) => p.y));
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const p of run) {
      const dx = p.x - mx;
      const dy = p.y - my;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let ux = Math.cos(theta);
    let uy = Math.sin(theta);

    // along-line signed projection, oriented so travel goes first -> last (matches time order)
    const s = run.map((p) => (p.x - mx) * ux + (p.y - my) * uy);
    if (s.at(-1) < s[0]) {
      ux = -ux;
      uy = -uy;
      for (let i = 0; i < s.length; i++) s[i] = -s[i];
    }
    const snapped = s.map((si) => ({ x: mx + si * ux, y: my + si * uy }));

    // snap weight: 0 at either end of the run, ramping to 1 over fadeM metres of along-line travel
    // — blends the snapped value toward the point's own raw value near the boundaries instead of
    // snapping it outright (see module doc).
    const s0 = s[0];
    const sN = s.at(-1);
    const weightAt = (si) => {
      if (fadeM <= 0) return 1; // no fade distance -> always fully snapped (avoid a 0/0 at si === s0)
      const fromStart = si - s0;
      const fromEnd = sN - si;
      return Math.max(0, Math.min(1, Math.min(fromStart, fromEnd) / fadeM));
    };

    const events = findPauseEvents(run, hsOn, hsOffFrac, minS);
    const inEvent = new Array(run.length).fill(-1);
    for (let e = 0; e < events.length; e++) {
      const [from, to] = events[e];
      for (let i = from; i <= to; i++) inEvent[i] = e;
    }
    const eventEle = events.map(([from, to]) => median(run.slice(from, to + 1).map((p) => p.ele)));

    // walk forward: outside any event, position-only snap (no ele); the anchor tracks the last
    // non-event point's own snapped position, ready for whichever pause event comes next. Inside an
    // event, every point shares that SAME anchor position and the event's own median ele (see
    // findPauseEvents' doc) — computed once per event, not per point, so no two points in the same
    // real pause can end up inconsistent with each other.
    let anchor = null;
    for (let i = 0; i < run.length; i++) {
      const p = run[i];
      const w = weightAt(s[i]);
      const e = inEvent[i];
      if (e < 0) {
        const bx = lerp(p.x, snapped[i].x, w);
        const by = lerp(p.y, snapped[i].y, w);
        anchor = { x: bx, y: by };
        p.liftSnap = unproject(bx, by, ctx.lat0, ctx.lon0);
      } else {
        const bx = lerp(p.x, anchor.x, w);
        const by = lerp(p.y, anchor.y, w);
        p.liftSnap = { ...unproject(bx, by, ctx.lat0, ctx.lon0), ele: lerp(p.ele, eventEle[e], w) };
      }
    }
  }
};
