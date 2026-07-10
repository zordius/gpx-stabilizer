// Compute module "segmentBoundaryEle" — FINALIZE phase, opt-in (ski mode). Drops elevation noise at
// the head/tail of a `segment.js` run whose neighbour on that side is far away in time (or absent
// entirely) — i.e. exactly the situation `liftBoardingEle`'s own HEAD/EXTREME/ASCENT-REVERSAL
// mechanisms were built to chase, but generalised to ANY segment type (lift, descent, OR flat), not
// just confirmed-lift runs, and gated on a plain time gap rather than liftConfirm's own verdict.
//
// Motivation (2026-07-10): a single video file/session analyzed on its own has no real data before
// its own first sample or after its own last — the same "no backward context" problem chased earlier
// this session, but that isn't unique to lift boarding: ANY segment sitting at the edge of what got
// analyzed (or genuinely isolated by a long real gap, e.g. a lunch break) can carry the same kind of
// GPS-settling elevation noise at its own head/tail, regardless of what kind of segment it is.
//
// For each segment.js run, independently on EACH side: if that side's neighbour is more than
// SEG_BOUNDARY_GAP_MIN_S away in time (or there IS no neighbour on that side — the run is the very
// first/last thing analyzed), walk in from that edge looking for the first CONTINUOUS stretch of
// `hs > SEG_BOUNDARY_HS_MIN` lasting more than SEG_BOUNDARY_SUSTAIN_MIN_S seconds — real, sustained
// motion, trusted evidence the point really is moving by then. Everything strictly before that
// stretch (HEAD side) or after it (TAIL side) is a candidate: if the raw elevation there accumulates
// more than SEG_BOUNDARY_CUM_ELE_MAX_M of either cumulative CLIMB or cumulative DESCENT (summed
// separately — a noisy up/down wobble with a small NET change still accumulates a large cumulative
// total on whichever side, unlike a plain first-to-last delta), the whole candidate stretch's
// elevation is dropped (`point.segmentBoundaryEle = { ele: null }`, same non-destructive, "admit the
// gap rather than guess" convention as `liftBoardingEle`) — EXCEPT any point `liftSnap` already
// reconstructed its own `ele` for (`point.liftSnap?.ele != null`), same deference as
// `liftBoardingEle`'s own EXTREME mechanism: this is a last resort for what liftSnap couldn't reach,
// not a substitute for a reconstruction that already exists (added 2026-07-10 after real-file
// testing on GOPR5138.MP4 showed a majority of one triggering stretch — the slow start of a confirmed
// lift run, isolated as this file's very first segment — already had a trustworthy liftSnap
// reconstruction). No qualifying sustained-motion stretch on a side -> that side is left untouched (no
// reliable boundary to check against at all).
//
// `stabilize`'s `opts.segmentBoundaryEle` decides whether the export actually uses this signal (see
// stabilize.js), ahead of `liftSnap`/`gradeBound`/raw, same tier as `liftBoardingEle`.

const SEG_BOUNDARY_GAP_MIN_S = 600; // s — 10 min; a neighbour further than this (or absent) counts as
// "isolated" on that side
const SEG_BOUNDARY_HS_MIN = 1; // m/s — above this counts as genuinely moving for this check
const SEG_BOUNDARY_SUSTAIN_MIN_S = 15; // s — the moving stretch must hold continuously for longer
// than this to count as trusted evidence, not just a brief speed blip
const SEG_BOUNDARY_CUM_ELE_MAX_M = 1; // m — cumulative climb OR cumulative descent (whichever, summed
// separately) that counts as noise in a candidate stretch — first-look guess, deliberately small: an
// isolated boundary's elevation reading is trusted a lot less than an ordinary mid-track stretch

/** Contiguous runs of `kept` sharing the same `point.segment.id` — ANY segment type (unlike
 * `liftBoardingEle.js`'s own `groupSegLiftRuns`, which only picks up `type === "lift"`). A point with
 * no `segment` at all (segment.js not loaded) can never start or extend a run. */
function groupSegments(kept) {
  const runs = [];
  let i = 0;
  while (i < kept.length) {
    if (kept[i].segment == null) {
      i++;
      continue;
    }
    const startIdx = i;
    const id = kept[i].segment.id;
    while (i < kept.length && kept[i].segment?.id === id) i++;
    runs.push({ startIdx, endIdx: i - 1 });
  }
  return runs;
}

/** True when `runs[idx]`'s own HEAD (its start) has no neighbour, or its nearest neighbour on that
 * side is more than `gapMinS` away in time. */
function isolatedHead(kept, runs, idx, gapMinS) {
  if (idx === 0) return true;
  const gapS = (kept[runs[idx].startIdx].time - kept[runs[idx - 1].endIdx].time) / 1000;
  return gapS >= gapMinS;
}

/** Mirror of `isolatedHead`, for the run's own TAIL (its end). */
function isolatedTail(kept, runs, idx, gapMinS) {
  if (idx === runs.length - 1) return true;
  const gapS = (kept[runs[idx + 1].startIdx].time - kept[runs[idx].endIdx].time) / 1000;
  return gapS >= gapMinS;
}

/** Walking forward from `run.startIdx`, the index where the FIRST continuous `hs > hsMin` stretch
 * lasting more than `minS` seconds itself BEGINS — i.e. the boundary of the untrusted head prefix
 * (`[run.startIdx, that index - 1]`). `-1` when no such stretch exists anywhere in the run at all. */
function findSustainedFromHead(kept, run, hsMin, minS) {
  let i = run.startIdx;
  while (i <= run.endIdx) {
    if ((kept[i].hs ?? 0) <= hsMin) {
      i++;
      continue;
    }
    const streakStart = i;
    let j = i;
    while (j + 1 <= run.endIdx && (kept[j + 1].hs ?? 0) > hsMin) j++;
    if ((kept[j].time - kept[streakStart].time) / 1000 > minS) return streakStart;
    i = j + 1;
  }
  return -1;
}

/** Mirror of `findSustainedFromHead`, walking backward from `run.endIdx`: the index where the LAST
 * continuous `hs > hsMin` stretch lasting more than `minS` seconds itself ENDS — the boundary of the
 * untrusted tail suffix (`[that index + 1, run.endIdx]`). `-1` when none exists. */
function findSustainedFromTail(kept, run, hsMin, minS) {
  let i = run.endIdx;
  while (i >= run.startIdx) {
    if ((kept[i].hs ?? 0) <= hsMin) {
      i--;
      continue;
    }
    const streakEnd = i;
    let j = i;
    while (j - 1 >= run.startIdx && (kept[j - 1].hs ?? 0) > hsMin) j--;
    if ((kept[streakEnd].time - kept[j].time) / 1000 > minS) return streakEnd;
    i = j - 1;
  }
  return -1;
}

/** Cumulative positive and negative raw-`ele` deltas across `[from, to]`, summed SEPARATELY (not
 * netted) — drops the whole stretch if either cumulative total exceeds `cumMaxM`. A stretch of 0 or 1
 * points has no delta to accumulate at all and is left alone. The trigger decision itself always reads
 * raw `ele` (the candidate stretch is untrusted *as a whole*, so its own shape must be judged on the
 * unmodified signal); but the actual write skips any point `liftSnap` already reconstructed its own
 * `ele` for (`point.liftSnap?.ele != null`, same convention as `liftBoardingEle.js`'s own EXTREME
 * mechanism, `fixExtremeLowSpeed`) — real-file testing (2026-07-10, GOPR5138.MP4) showed a majority of
 * a triggering stretch can already have a trustworthy `liftSnap` pause-event reconstruction (a
 * confirmed-lift run's own slow start), and this mechanism is a last resort for what liftSnap couldn't
 * reach, not a substitute for a reconstruction that already exists. */
function checkAndDropCumulative(kept, from, to, cumMaxM) {
  if (to <= from) return;
  let cumPos = 0;
  let cumNeg = 0;
  for (let i = from; i < to; i++) {
    const d = kept[i + 1].ele - kept[i].ele;
    if (d > 0) cumPos += d;
    else cumNeg += d;
  }
  if (cumPos > cumMaxM || -cumNeg > cumMaxM) {
    for (let i = from; i <= to; i++) {
      if (kept[i].liftSnap?.ele == null) kept[i].segmentBoundaryEle = { ele: null };
    }
  }
}

export const finalize = (out, ctx) => {
  const g = ctx.g ?? {};
  const gapMinS = g.SEG_BOUNDARY_GAP_MIN_S ?? SEG_BOUNDARY_GAP_MIN_S;
  const hsMin = g.SEG_BOUNDARY_HS_MIN ?? SEG_BOUNDARY_HS_MIN;
  const sustainMinS = g.SEG_BOUNDARY_SUSTAIN_MIN_S ?? SEG_BOUNDARY_SUSTAIN_MIN_S;
  const cumMaxM = g.SEG_BOUNDARY_CUM_ELE_MAX_M ?? SEG_BOUNDARY_CUM_ELE_MAX_M;
  const kept = out.filter(
    (p) => !p.dropReason && p.time != null && Number.isFinite(p.ele) && p.segment != null,
  );

  const runs = groupSegments(kept);
  for (let idx = 0; idx < runs.length; idx++) {
    const run = runs[idx];
    if (isolatedHead(kept, runs, idx, gapMinS)) {
      const streakStart = findSustainedFromHead(kept, run, hsMin, sustainMinS);
      if (streakStart >= 0) checkAndDropCumulative(kept, run.startIdx, streakStart - 1, cumMaxM);
    }
    if (isolatedTail(kept, runs, idx, gapMinS)) {
      const streakEnd = findSustainedFromTail(kept, run, hsMin, sustainMinS);
      if (streakEnd >= 0) checkAndDropCumulative(kept, streakEnd + 1, run.endIdx, cumMaxM);
    }
  }
};
