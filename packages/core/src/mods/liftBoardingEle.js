// Compute module "liftBoardingEle" — FINALIZE phase, opt-in (ski mode). Removes elevation artifacts
// observed at lift boarding/unloading/mid-ride — DROPS the elevation of the affected points
// (`point.liftBoardingEle = { ele: null }`, leaving lat/lon/time untouched) rather than correcting or
// interpolating it (2026-07-09; all three sub-mechanisms below originally tried a "best guess"
// correction instead — a rate-capped/flat extrapolation for HEAD, a straight-line TIME interpolation
// for TAIL/MID-RUN). This module can reliably detect that a stretch is bad, but in every case has no
// independent way to back out what the true elevation actually was there — a guess dressed up as a
// measurement is worse than admitting the gap: it silently invents a plausible-looking number a
// consumer can't tell from a real one. `stabilize.js`'s override chain treats a present-but-null
// `liftBoardingEle.ele` as the final answer (not "no opinion"), so it actually removes the `<ele>`
// tag on export rather than falling through to a raw/liftSnap value.
//
// Three sub-mechanisms, differing only in HOW each finds the region to drop:
//
// HEAD (boarding/queueing) — queue-region discard (see the STAGE 1/STAGE 2 doc further down for how
// the region itself is found: a confirmed low-speed stop directly adjacent to boarding, extended
// backward by distance to the lift's own boarding position). Drops from the last reliable point
// before that region through the boarding point itself.
//
// TAIL (unloading) / MID-RUN (mid-ride, see further down) — dip/bump-shaped excursion detection
// (`findExcursion`): the search window is the actual low-speed stop straddling the run's tail
// boundary (TAIL) or a small fixed radius slid across the run's own interior (MID-RUN — no speed
// gate, since the run is already confirmed and its cable speed is trusted). Either way,
// `findExcursion` needs a local extremum flanked by two neighbours ("anchors") that clear it by a
// threshold on both sides — those two anchors are themselves left untouched (they're what makes the
// shape detectable at all); only the interior between them gets dropped.
//
// A fourth, cross-cutting step — POSITION drop (2026-07-09) — runs last, over EVERY point any of the
// three mechanisms above already ele-dropped: where hdop ALSO independently reads poor
// (LIFT_QUEUE_DROP_HDOP_MAX), that's strong enough evidence the point's horizontal position is
// unusable too, not just its elevation, so the point is dropped ENTIRELY (`addDrop`) rather than
// just losing `ele`. Unlike the ele-only drops, this can't selectively blank `lat`/`lon` and keep
// the point — GPX's `<trkpt>` requires both as attributes, so "drop position" has only one
// representation: remove the point from the output. See `dropUnreliableQueuePositions` further down
// for the clustering rule (a lone still-good-hdop point sandwiched between two bad ones is itself
// unreliable in context, so it's swept into the same drop rather than surviving as an island).
//
// Runs AFTER liftConfirm/liftSnap. Emits `point.liftBoardingEle = { ele }` (namespaced; never touches
// liftConfirm/liftSnap's own fields). `stabilize`'s `opts.liftBoardingEle` decides whether the export
// actually uses this signal (see stabilize.js), ahead of `liftSnap`'s own `ele`.
//
// --- TAIL/MID-RUN mechanism (2026-07-08; revised 2026-07-09 to DROP rather than correct) ---
// The search window is the ACTUAL low-speed stop straddling the run's boundary — `lowSpeedBoundary`
// walks outward while horizontal speed stays under LIFT_BOARD_HS_MAX (capped at MAX_SPAN points),
// plus a small MARGIN into the confirmed run itself. A FIXED-size window doesn't work here: too small
// and it misses stops longer than ~20s; too large and, once it's big enough to cover a 2-minute stop,
// it also reaches far enough to swallow unrelated terrain (e.g. the real bottom of the previous ski
// run), misidentifying THAT as an excursion. Anchoring the window to the actual low-speed span
// sidesteps this: its size tracks the real stop, whatever that turns out to be.
//
// Within that window, `findExcursion` looks for a local extremum — a MINIMUM (dip/sag) or, mirrored,
// a MAXIMUM (bump/spike) — whose near and far neighbours both clear it by LIFT_BOARD_DIP_M /
// LIFT_BOARD_RECOVER_M, with horizontal speed under LIFT_BOARD_HS_MAX throughout the [near anchor,
// far anchor] span specifically (not the whole window — the MARGIN slack can legitimately carry real
// motion just outside that span). `fixExcursionsInWindow` runs this for BOTH polarities, drops
// whichever qualifying excursion is larger, and repeats against the now-partly-cleaned window until
// neither polarity finds anything — so a stop with several separate back-and-forth swings gets every
// one of them, not just the first or the biggest. Per excursion: drop every point strictly between
// the near and far anchors (the two anchors themselves are left alone — they're the trusted evidence
// that a shape exists there at all, not part of the unusable stretch).

import { addDrop } from "../analyze.js";

const HS_MAX = 3; // m/s — safety gate: the [near anchor, far anchor] span of an accepted excursion
// must stay under this throughout (loose — it's a last-resort "not actually moving" sanity check)
const SPAN_HS_MAX = 3; // m/s — boundary for the low-speed SPAN search itself (currently same as
// HS_MAX — see module doc for why neither a looser nor a stricter single value cleanly separates
// every case found so far; this is a placeholder pending a real fix, not a tuned constant)
const MAX_SPAN = 400; // safety cap (points) on the low-speed span search, so an unrelated long stop
// (e.g. a lunch break with hs~0 for many minutes) can't be scanned as one span
const MARGIN = 40; // points of slack past the low-speed boundary, into the confirmed run itself —
// the recovery anchor can land well inside the run: elevation only catches back up to the pre-dip
// level once real climbing motion is underway, which takes more than a couple of seconds
const DIP_M = 5; // metres the near anchor must clear the excursion's extremum by
const RECOVER_M = 5; // metres the far anchor must clear the excursion's extremum by
const MAX_EXCURSIONS = 20; // safety cap on how many excursions one window can have fixed in a row

/**
 * Walk `kept` from `from` one step at a time in `dir` (-1 or +1) while horizontal speed stays at or
 * under `hsMax`, up to `MAX_SPAN` steps, and return the furthest index reached. This is what bounds
 * the search window to the ACTUAL low-speed stop (however long it really lasts) instead of a fixed
 * point count — a fixed window either misses a long stop or, sized to cover one, starts swallowing
 * unrelated terrain once it's big enough (see module doc).
 */
function lowSpeedBoundary(kept, from, dir, hsMax) {
  let i = from;
  for (let steps = 0; steps < MAX_SPAN; steps++) {
    const next = i + dir;
    if (next < 0 || next >= kept.length || (kept[next].hs ?? 0) > hsMax) break;
    i = next;
  }
  return i;
}

/** A point's current best-known elevation for shape-detection purposes: the raw `ele`, UNLESS this
 * module has already made a final call on this point — a numeric override from an earlier excursion
 * fix in this same window (so a second excursion in the same low-speed stop is judged against the
 * already-cleaned series, not the original noise), or `NaN` if that call was a DROP. `NaN` rather
 * than falling through to raw `ele` matters: a dropped point's raw reading is exactly the noise this
 * module doesn't trust, and `NaN` can't win any `<`/`>` extremum comparison in `findExcursion` below,
 * so a dropped point simply can't be picked as a new extremum or anchor on a later pass. */
const curEle = (p) => (p.liftBoardingEle ? p.liftBoardingEle.ele ?? Number.NaN : p.ele);

/**
 * Find ONE dip- OR bump-shaped excursion in `window` — `sign: 1` looks for a dip (a local minimum
 * sagging below its neighbours), `sign: -1` looks for a bump (a local maximum spiking above them) —
 * by searching for a local extremum of `sign * curEle(p)` (negating the elevation before comparing
 * turns "find the highest point" into the same "find the lowest point" search a dip uses, so one
 * routine covers both shapes). Returns `{ preIdx, postIdx, mag }` (mag = the excursion's total size,
 * near + far clearance, for ranking against the opposite polarity) or `null` if none qualifies.
 */
function findExcursion(window, sign, dipM, recoverM, hsMax) {
  const n = window.length;
  const se = (p) => sign * curEle(p);

  let extIdx = 0;
  for (let i = 1; i < n; i++) if (se(window[i]) < se(window[extIdx])) extIdx = i;
  if (extIdx < 1 || extIdx > n - 2) return null; // too close to either edge to see the full shape

  let preIdx = 0;
  for (let i = 0; i < extIdx; i++) if (se(window[i]) > se(window[preIdx])) preIdx = i;
  let farMax = Number.NEGATIVE_INFINITY;
  for (let i = extIdx + 1; i < n; i++) farMax = Math.max(farMax, se(window[i]));

  const ext = se(window[extIdx]);
  const near = se(window[preIdx]) - ext;
  const far = farMax - ext;
  if (near < dipM || far < recoverM) return null;

  // far anchor: first point after the extremum back at/above the near anchor's own level
  let postIdx = -1;
  for (let i = extIdx + 1; i < n; i++) {
    if (se(window[i]) >= se(window[preIdx])) {
      postIdx = i;
      break;
    }
  }
  if (postIdx < 0) return null; // never actually recovered to the near-anchor level within the window

  // hs gate is scoped to the actual [preIdx, postIdx] span — the window's own MARGIN slack can
  // legitimately carry a few real-motion points just outside that span.
  if (window.slice(preIdx, postIdx + 1).some((p) => (p.hs ?? 0) >= hsMax)) return null;

  return { preIdx, postIdx, mag: near + far };
}

/** Drop one excursion (`{ preIdx, postIdx }` into `window`): the anchors at `preIdx`/`postIdx`
 * themselves are the trusted evidence a shape exists there and are left untouched; every point
 * strictly between them is unrecoverable (same reasoning as the HEAD queue-region mechanism, see
 * module doc), so its elevation is dropped (`{ ele: null }`) rather than fabricated by interpolating
 * between the two anchors. */
function dropExcursion(window, preIdx, postIdx) {
  for (let i = preIdx + 1; i < postIdx; i++) window[i].liftBoardingEle = { ele: null };
}

/**
 * Repeatedly find and drop the single largest dip- or bump-shaped excursion in `window` (a
 * time-ordered slice of kept points spanning a low-speed stop plus a little margin into the
 * confirmed run), until neither shape qualifies anymore or `MAX_EXCURSIONS` is reached — so a stop
 * with several separate back-and-forth swings gets every one of them, not just the biggest. Mutates
 * the point objects `window` references (`point.liftBoardingEle = { ele: null }`).
 */
function fixExcursionsInWindow(window, g) {
  const dipM = g?.LIFT_BOARD_DIP_M ?? DIP_M;
  const recoverM = g?.LIFT_BOARD_RECOVER_M ?? RECOVER_M;
  const hsMax = g?.LIFT_BOARD_HS_MAX ?? HS_MAX;
  if (window.length < 5) return;

  for (let iter = 0; iter < MAX_EXCURSIONS; iter++) {
    const dip = findExcursion(window, 1, dipM, recoverM, hsMax);
    const bump = findExcursion(window, -1, dipM, recoverM, hsMax);
    const best = !dip ? bump : !bump ? dip : dip.mag >= bump.mag ? dip : bump;
    if (!best) return;
    dropExcursion(window, best.preIdx, best.postIdx);
  }
}

const MIDRUN_RADIUS = 40; // points — a local window radius for scanning a confirmed run's OWN
// interior for a dip. Kept modest (unlike the boarding/unloading window, which is sized to the
// actual low-speed span): a bigger window here would let the run's own steady climb trend swamp a
// local dip the same way unrelated terrain swamps the boarding case (see module doc) — the run's
// elevation is expected to keep rising throughout, so "the global extremum across a big chunk of the
// run" is essentially just wherever that chunk starts, not a local anomaly.

/**
 * Scan the interior of a CONFIRMED-lift run itself (not the boarding/unloading window outside it)
 * for a dip-shaped excursion — mid-ride, e.g. sky occlusion from a tower or the top station's own
 * structure while still riding, well before actually unloading. Two differences from the boarding
 * case: dip-only (a sudden upward spike mid-ride isn't a shape this has been observed to produce),
 * and NO horizontal-speed gate at all — the run is already confirmed, so its cable speed is trusted
 * to be roughly steady throughout; there's no "was this really stationary" question to answer here,
 * only shape. Slides a small fixed-radius window across `runPoints` (a slice of `kept` covering just
 * that one run) and drops each qualifying dip's interior in turn, resuming past its far anchor so the
 * same region isn't rescanned.
 */
function fixMidRunDips(runPoints, g) {
  const dipM = g?.LIFT_BOARD_DIP_M ?? DIP_M;
  const recoverM = g?.LIFT_BOARD_RECOVER_M ?? RECOVER_M;
  const n = runPoints.length;
  let i = MIDRUN_RADIUS;
  while (i < n - MIDRUN_RADIUS) {
    const lo = i - MIDRUN_RADIUS;
    const hi = Math.min(n, i + MIDRUN_RADIUS + 1);
    const window = runPoints.slice(lo, hi);
    const found = findExcursion(window, 1, dipM, recoverM, Number.POSITIVE_INFINITY);
    if (!found) {
      i++;
      continue;
    }
    dropExcursion(window, found.preIdx, found.postIdx);
    i = lo + found.postIdx + 1; // resume scanning just past the region just dropped
  }
}

/** Contiguous stretches of `kept` where `liftConfirm.type` is `"lift"` or `"ascent"` (same segment.id
 * throughout), as [startIdx, endIdx] into `kept` — mirrors liftConfirm.js/liftSnap.js's own grouping,
 * widened to `"ascent"` because liftConfirm can relegate a real lift climb to that label without this
 * module caring which side of that call it landed on (see module doc). */
const isLiftish = (p) => p.liftConfirm?.type === "lift" || p.liftConfirm?.type === "ascent";

function groupLiftRuns(kept) {
  const runs = [];
  let i = 0;
  while (i < kept.length) {
    if (!isLiftish(kept[i])) {
      i++;
      continue;
    }
    const startIdx = i;
    const id = kept[i].segment?.id;
    while (i < kept.length && isLiftish(kept[i]) && kept[i].segment?.id === id) i++;
    runs.push({ startIdx, endIdx: i - 1 });
  }
  return runs;
}

// --- HEAD mechanism (2026-07-09; revised same day to DROP rather than correct): queue-region discard ---

const QUEUE_DIST_M = 200; // m — how far the (stage 2) region extension may reach from the lift's own
// boarding position. Validated against real queues (~10-130m) vs unrelated stops (>1.7km).
const QUEUE_LOOKBACK_S = 600; // s — safety cap on how far back the queue search looks, so an
// unrelated long gap (e.g. a lunch break spent wandering back near the same station) can't be
// counted as one continuous queue

// Two-stage queue search (2026-07-09 redesign, replacing a single distance+speed filter): a real
// fast ski-in can pass within any reasonable distance of the station while still genuinely moving —
// distance alone can't tell that apart from a real queue (found chasing a regression: an approach
// that skied past 937m at hs~4 m/s, 140s and 51 real vertical metres before boarding, got bridged as
// if that whole real descent were the queue, erasing a stretch that was already correct). Splitting
// into two stages, each trusting a different signal, is what actually separates them:
//
// STAGE 1 — CONFIRM: walk backward from the boarding point while hs stays under QUEUE_STOP_HS_MAX,
// require the resulting contiguous stretch to be at least QUEUE_STOP_MIN_S long. This is strict
// (low threshold, sustained duration) specifically so a real descent's own brief speed dips (a few
// seconds, never actually near-zero) can't satisfy it — only a genuine, sustained near-stop can. No
// confirmed stop directly adjacent to boarding -> no evidence of a queue at all -> leave the run
// untouched. EXCEPT when the backward walk runs off the front of the analyzed data while still
// below QUEUE_STOP_HS_MAX (2026-07-10) — e.g. a single video file/session analyzed on its own,
// starting already mid-queue, with no earlier real data to confirm the stretch's true duration
// against. There the visible low-speed run, however short, is accepted outright rather than
// rejected for merely looking too brief within an artificially truncated window — a whole-day
// merge of the same footage (real data before this file) would see the same stretch clear
// QUEUE_STOP_MIN_S on its own merits.
//
// STAGE 2 — EXTEND: once confirmed, walk further backward from there using DISTANCE to the boarding
// position (not hs — once you're this close to the lift, hs itself is exactly what gets corrupted by
// the same GPS noise this module exists to work around, so it stops being a trustworthy per-point
// signal). The one thing distance alone still can't rule out is sustained real motion resuming
// (walking back far enough to rejoin the approach), so extension also breaks if hs stays at or above
// QUEUE_EXTEND_HS_MAX continuously for QUEUE_EXTEND_BREAK_S — long enough to separate that from a
// real queue's own brief fold-back-on-itself speed bursts (observed up to ~8s).
const QUEUE_STOP_HS_MAX = 2.5; // m/s — empirically, real "about to board" approaches don't all fully
// stop: some hover at 1.5-1.9 m/s right up to boarding rather than dropping near zero. 2.5 covers
// those while staying under the ~2.65 m/s floor of the real-descent transient dip that motivated
// the two-stage split in the first place (see module doc) — the narrowest margin found across the
// real cases checked; a source with a different approach-speed profile may need retuning.
const QUEUE_STOP_MIN_S = 5; // s
const QUEUE_EXTEND_HS_MAX = 3; // m/s
const QUEUE_EXTEND_BREAK_S = 10; // s

/** Grouping by `segment.type === "lift"` directly (NOT `liftConfirm` — the queue search needs the
 * lift's own boarding POSITION, which exists as soon as segment.js classifies it, before liftConfirm
 * even runs, and regardless of which verdict it lands on). */
function groupSegLiftRuns(kept) {
  const runs = [];
  let i = 0;
  while (i < kept.length) {
    if (kept[i].segment?.type !== "lift") {
      i++;
      continue;
    }
    const startIdx = i;
    const id = kept[i].segment.id;
    while (i < kept.length && kept[i].segment?.type === "lift" && kept[i].segment?.id === id) i++;
    runs.push({ startIdx, endIdx: i - 1 });
  }
  return runs;
}

/**
 * STAGE 1 (see module doc): walk backward from `run.startIdx` while `hs` stays under `hsMax`,
 * contiguously. Returns the start index of that stretch if its own duration reaches `minS`, else -1
 * (no confirmed stop directly adjacent to boarding) — UNLESS the walk runs off the front of the
 * analyzed data (`searchLo`, e.g. this file/session is the very start of what got analyzed) while
 * still below `hsMax`: there is no way to see how much earlier the stop actually began, so the
 * visible low-speed stretch — however short — is already stronger evidence than an ordinary
 * mid-stream dip that recovered inside the window (which minS exists to filter out), and is accepted
 * outright without needing to clear minS itself.
 */
function findConfirmedStop(kept, run, searchLo, hsMax, minS) {
  let i = run.startIdx - 1;
  if (i < searchLo || (kept[i].hs ?? 0) >= hsMax) return -1;
  let stopStart = i;
  while (i - 1 >= searchLo && (kept[i - 1].hs ?? 0) < hsMax) {
    i--;
    stopStart = i;
  }
  if (stopStart === searchLo) return stopStart; // ran off the front of the data, still slow
  const durS = (kept[run.startIdx - 1].time - kept[stopStart].time) / 1000;
  return durS >= minS ? stopStart : -1;
}

/**
 * STAGE 2 (see module doc): from the confirmed stop's own start (`stopStart`), keep walking backward
 * while within `distM` of the lift's own boarding position `ls` (hs is NOT checked point-by-point —
 * see module doc for why), breaking if `hs` stays at or above `breakHsMax` continuously for
 * `breakMinS` (real motion resuming, not the queue's own brief speed bursts) — rolling back to
 * exclude that WHOLE streak, not just the excess past `breakMinS`. Returns the index just BEFORE the
 * accepted region (i.e. `+1` is where the region — and so the drop — actually starts); never less
 * than `searchLo - 1`, so the region can validly start right at `searchLo` when nothing beyond it
 * qualifies.
 */
function extendQueueRegion(kept, ls, stopStart, searchLo, distM, lookbackS, breakHsMax, breakMinS) {
  let i = stopStart;
  let streakStartIdx = -1;
  while (i - 1 >= searchLo) {
    const next = kept[i - 1];
    if ((ls.time - next.time) / 1000 > lookbackS) break;
    if (Math.hypot(next.x - ls.x, next.y - ls.y) > distM) break;
    if ((next.hs ?? 0) >= breakHsMax) {
      if (streakStartIdx < 0) streakStartIdx = i;
      if ((kept[streakStartIdx].time - next.time) / 1000 >= breakMinS) {
        i = streakStartIdx; // roll back -- exclude the whole streak, not just the part past breakMinS
        break;
      }
    } else {
      streakStartIdx = -1;
    }
    i--;
  }
  return i - 1;
}

/**
 * Fix one run's HEAD: STAGE 1 confirms a real queue/stop exists directly adjacent to boarding at
 * all; STAGE 2 (only reached if stage 1 confirms) finds how far back it actually extends. If found,
 * DROP the elevation (`{ ele: null }`, see module doc for why not a correction) for every point from
 * there through the boarding point itself. A run with no confirmed stop is left untouched: there's
 * no evidence its boarding reading is a queue-region artifact at all.
 */
function fixQueueHead(kept, searchLo, run, g) {
  const distM = g?.LIFT_QUEUE_DIST_M ?? QUEUE_DIST_M;
  const lookbackS = g?.LIFT_QUEUE_LOOKBACK_S ?? QUEUE_LOOKBACK_S;
  const stopHsMax = g?.LIFT_QUEUE_STOP_HS_MAX ?? QUEUE_STOP_HS_MAX;
  const stopMinS = g?.LIFT_QUEUE_STOP_MIN_S ?? QUEUE_STOP_MIN_S;
  const extendHsMax = g?.LIFT_QUEUE_EXTEND_HS_MAX ?? QUEUE_EXTEND_HS_MAX;
  const extendBreakS = g?.LIFT_QUEUE_EXTEND_BREAK_S ?? QUEUE_EXTEND_BREAK_S;
  const ls = kept[run.startIdx];

  const stopStart = findConfirmedStop(kept, run, searchLo, stopHsMax, stopMinS);
  if (stopStart < 0) return; // no confirmed stop adjacent to boarding -- nothing to drop

  const beforeRegion = extendQueueRegion(
    kept,
    ls,
    stopStart,
    searchLo,
    distM,
    lookbackS,
    extendHsMax,
    extendBreakS,
  );

  for (let i = beforeRegion + 1; i <= run.startIdx; i++) kept[i].liftBoardingEle = { ele: null };
}

// --- position drop for confirmed-bad-GPS points (2026-07-09, see module doc) ---

const QUEUE_DROP_HDOP_MAX = 3; // hdop above this, on a point liftBoardingEle already ele-dropped, is
// independent evidence the point's POSITION is unusable too, not just its elevation
const QUEUE_DROP_GLUE_S = 10; // s — bridge (also drop) any point strictly between two qualifying
// points if they're within this many seconds of each other, so a lone still-good-hdop sample doesn't
// survive as an isolated, unreliable island in the middle of an otherwise-bad stretch

/**
 * Fully drop (`addDrop`, same convention as any other quality drop) every point where
 * `liftBoardingEle` already dropped the elevation AND `hdop` independently reads above `hdopMax` —
 * see module doc for why this can't just blank `lat`/`lon` the way the ele-only drops do. Clusters
 * qualifying points first: consecutive qualifying points within `glueS` of each other bridge into
 * one region, and every point strictly between them (even one that doesn't itself qualify) is
 * dropped too, rather than surviving as a lone island.
 */
function dropUnreliableQueuePositions(kept, hdopMax, glueS) {
  const seeds = [];
  for (let i = 0; i < kept.length; i++) {
    const p = kept[i];
    if (p.liftBoardingEle?.ele === null && p.hdop != null && p.hdop > hdopMax) seeds.push(i);
  }

  let i = 0;
  while (i < seeds.length) {
    let j = i;
    while (j + 1 < seeds.length && (kept[seeds[j + 1]].time - kept[seeds[j]].time) / 1000 <= glueS) j++;
    for (let k = seeds[i]; k <= seeds[j]; k++) addDrop(kept[k], "liftBoardingEle", { reason: "queuePosition" });
    i = j + 1;
  }
}

export const finalize = (out, ctx) => {
  const g = ctx.g ?? {};
  const spanHsMax = g.LIFT_BOARD_SPAN_HS_MAX ?? SPAN_HS_MAX;
  const dropHdopMax = g.LIFT_QUEUE_DROP_HDOP_MAX ?? QUEUE_DROP_HDOP_MAX;
  const dropGlueS = g.LIFT_QUEUE_DROP_GLUE_S ?? QUEUE_DROP_GLUE_S;
  const kept = out.filter((p) => !p.dropReason && p.time != null && Number.isFinite(p.ele));

  let searchLo = 0;
  for (const run of groupSegLiftRuns(kept)) {
    fixQueueHead(kept, searchLo, run, g);
    searchLo = run.endIdx + 1;
  }

  for (const run of groupLiftRuns(kept)) {
    const tailLo = Math.max(0, run.endIdx - MARGIN);
    const tailHi = lowSpeedBoundary(kept, run.endIdx, 1, spanHsMax) + 1;
    fixExcursionsInWindow(kept.slice(tailLo, tailHi), g);

    fixMidRunDips(kept.slice(run.startIdx, run.endIdx + 1), g);
  }

  dropUnreliableQueuePositions(kept, dropHdopMax, dropGlueS);
};
