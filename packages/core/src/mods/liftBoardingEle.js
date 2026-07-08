// Compute module "liftBoardingEle" — FINALIZE phase, opt-in (ski mode). Fixes a specific elevation
// artifact observed at lift boarding/unloading: a brief (~10-20s) elevation SAG of several metres
// that fully recovers, while horizontal speed stays low (still boarding/unloading, not actually
// riding) and the GPS chip's own quality signals (`fix`, `hdop`) stay normal throughout — so neither
// `fixQuality` (fix stays "3d") nor `gradeBound`'s speed-adaptive bound (loose at this low speed)
// catches it. Validated 2026-07-08 against 53 real confirmed-lift runs across 9 real HERO5 files
// (the whole ski day): ~17% show this exact shape (likely an undercount — several near-boundary
// scans were inconclusive, not confirmed-absent), all with `fix==="3d"` and low `hdop` throughout.
//
// Runs AFTER liftConfirm/liftSnap — checks BOTH ends of every confirmed-lift run (unloading at the
// top can have the same transient sky-occlusion as boarding at the bottom).
//
// Detection, per end: within a window straddling the run's boundary, find the elevation local
// minimum; if the peak just before it (the pre-dip anchor) and the recovery peak just after both
// clear that minimum by LIFT_BOARD_DIP_M, and horizontal speed stays under LIFT_BOARD_HS_MAX
// throughout, treat it as this artifact. Correction: replace every point strictly between the
// pre-dip anchor and the point where elevation first recovers back to at least that anchor's own
// level, with a straight-line TIME interpolation between those two anchors' elevations — bridging
// over the sag rather than keeping it. Emits `point.liftBoardingEle = { ele }` (namespaced; never
// touches liftConfirm/liftSnap's own fields). `stabilize`'s `opts.liftBoardingEle` decides whether
// the export actually uses this signal (see stabilize.js), ahead of `liftSnap`'s own `ele`.

const LOOKBACK = 40; // kept points to scan on either side of a run boundary
const PRE_WINDOW = 15; // points before the local min to search for the pre-dip peak
const POST_WINDOW = 8; // points after the local min to search for the recovery peak
const RECOVER_SEARCH = 20; // points after the local min to search for the actual recovery anchor
const DIP_M = 5; // metres the pre-dip peak must clear the minimum by
const RECOVER_M = 5; // metres the recovery peak must clear the minimum by
const HS_MAX = 3; // m/s — horizontal speed must stay under this throughout the window

/** Find at most one dip-shaped artifact in `window` (a time-ordered slice of kept points straddling
 * a run boundary) and fix it in place (mutates the point objects `window` references). */
function fixDipInWindow(window, g) {
  const dipM = g?.LIFT_BOARD_DIP_M ?? DIP_M;
  const recoverM = g?.LIFT_BOARD_RECOVER_M ?? RECOVER_M;
  const hsMax = g?.LIFT_BOARD_HS_MAX ?? HS_MAX;
  const n = window.length;
  if (n < 5) return;

  let minIdx = 0;
  for (let i = 1; i < n; i++) if (window[i].ele < window[minIdx].ele) minIdx = i;
  if (minIdx < 2 || minIdx > n - 3) return; // too close to either edge to see the full shape

  let preIdx = Math.max(0, minIdx - PRE_WINDOW);
  for (let i = preIdx; i < minIdx; i++) if (window[i].ele > window[preIdx].ele) preIdx = i;
  let postMax = Number.NEGATIVE_INFINITY;
  for (let i = minIdx + 1; i < Math.min(n, minIdx + 1 + POST_WINDOW); i++)
    postMax = Math.max(postMax, window[i].ele);

  const min = window[minIdx].ele;
  const dip = window[preIdx].ele - min;
  const recover = postMax - min;
  if (dip < dipM || recover < recoverM) return;

  const hi = Math.min(n, minIdx + 1 + RECOVER_SEARCH);
  if (window.slice(preIdx, hi).some((p) => (p.hs ?? 0) >= hsMax)) return; // actually moving -> not this

  // recovery anchor: first point after the min back at/above the pre-dip anchor's own level
  let postIdx = -1;
  for (let i = minIdx + 1; i < hi; i++) {
    if (window[i].ele >= window[preIdx].ele) {
      postIdx = i;
      break;
    }
  }
  if (postIdx < 0) return; // never actually recovered to the pre-dip level within the search range

  const a = window[preIdx];
  const b = window[postIdx];
  const span = b.time - a.time;
  if (span <= 0) return;
  for (let i = preIdx + 1; i < postIdx; i++) {
    const w = (window[i].time - a.time) / span;
    window[i].liftBoardingEle = { ele: a.ele + w * (b.ele - a.ele) };
  }
}

/** Contiguous stretches of `kept` where `liftConfirm.type === "lift"` (same segment.id throughout),
 * as [startIdx, endIdx] into `kept` — mirrors liftConfirm.js/liftSnap.js's own grouping. */
function groupLiftRuns(kept) {
  const runs = [];
  let i = 0;
  while (i < kept.length) {
    if (kept[i].liftConfirm?.type !== "lift") {
      i++;
      continue;
    }
    const startIdx = i;
    const id = kept[i].segment?.id;
    while (i < kept.length && kept[i].liftConfirm?.type === "lift" && kept[i].segment?.id === id)
      i++;
    runs.push({ startIdx, endIdx: i - 1 });
  }
  return runs;
}

export const finalize = (out, ctx) => {
  const g = ctx.g ?? {};
  const kept = out.filter((p) => !p.dropReason && p.time != null && Number.isFinite(p.ele));
  for (const run of groupLiftRuns(kept)) {
    const headLo = Math.max(0, run.startIdx - LOOKBACK);
    const headHi = Math.min(kept.length, run.startIdx + LOOKBACK);
    fixDipInWindow(kept.slice(headLo, headHi), g);

    const tailLo = Math.max(0, run.endIdx - LOOKBACK);
    const tailHi = Math.min(kept.length, run.endIdx + LOOKBACK);
    fixDipInWindow(kept.slice(tailLo, tailHi), g);
  }
};
