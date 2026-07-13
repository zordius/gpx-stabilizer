// Compute module "liftStationDrop" — FINALIZE phase, opt-in (ski mode only). Drops whole short,
// noisy segment runs at lift stations (the boarding/unloading areas at either end of a lift ride):
// milling around the queue or the unload platform leaves a run that is brief, goes nowhere, and
// wanders — pure position noise a downstream consumer only trips over.
//
// A run is dropped when ALL of these hold (rule "C" of gpx_eval/liftadj_noise_scan.mjs, validated
// on the 42-file ~/zrepos/gpx-test corpus, 2026-07-12):
//   - it is NOT a `lift` run, and sits DIRECTLY adjacent (in segment order) to a `lift` run — the
//     station gate. Without it, the same shape thresholds start matching runs elsewhere on the
//     mountain (variant "D" of the scan), where a short tangle is more likely a real pause worth
//     keeping (drift/tangleSnap territory) than boarding noise;
//   - duration < LIFT_STATION_MAX_S (90 s). NOT 60: segment.js's own MIN_S merge already absorbed
//     sub-60s slivers, so the post-merge junk lives in the 60–90 s band — the sub-60s runs that DO
//     survive are the heading-break-protected real short descents, which the corpus shows are the
//     ones worth protecting;
//   - net first-to-last displacement < LIFT_STATION_MAX_NET_M (50 m) — it went nowhere. Corpus:
//     station junk all sits at net <= 48 m while normal short runs read p50 75–166 m;
//   - AND at least one wandering signal: path-length / net ratio > LIFT_STATION_MIN_RATIO (2.5)
//     (scribbling in place — the ratio's high tail only separates junk in the 60–120 s band, which
//     is why the duration gate above matters), OR an ele-rewriting mod (liftBoardingEle /
//     segmentBoundaryEle) already discarded the elevation of >= LIFT_STATION_MIN_ELE_FRAC (0.5) of
//     its points — the single strongest station marker in the corpus (78 % of ele-dropped runs sit
//     adjacent to a lift), catching the low-ratio cases, while the ratio arm catches the
//     eleFrac = 0 cases; neither alone covers both.
//
// Corroboration that the rule hits stations, not chance: its corpus matches recur at the SAME
// coordinates across different days' files (e.g. 36.79467,138.78499 on 2026-02-11 and -12;
// 39.9862,140.9819 on 2025-01-17 and -19) — the signature of a fixed physical lift station.
// 32 runs / ~37 min dropped across 42 files (~0.76 per file), 29 flat + 3 descent (the descents:
// 26–35 s heading-break survivors with eleFrac 0.8–1.0 — boarding-area noise the descent-break
// override preserved for the wrong reason). Thresholds are from this one FitoTrack corpus —
// exploratory, not universal; all overridable via g.LIFT_STATION_*.
//
// Runs AFTER `segment` (reads `point.segment` run ids/types) and AFTER `liftBoardingEle` /
// `segmentBoundaryEle` (reads their namespaced fields for the eleFrac arm), BEFORE `tangleSnap`
// (a dropped run needs no repositioning). Emits a whole-run `addDrop` per matched run — a
// quality drop like drift/stray, so the clean line breaks there and stabilize() removes the
// points from the export.

import { addDrop } from "../analyze.js";

const MAX_S = 90; //        run duration must be under this (see module doc for why not 60)
const MAX_NET_M = 50; //    net first-to-last displacement must be under this (metres)
const MIN_RATIO = 2.5; //   path-length / net ratio above this = wandering in place
const MIN_ELE_FRAC = 0.5; // fraction of the run's points already ele-dropped that also qualifies

export const finalize = (out, ctx) => {
  const g = ctx.g ?? {};
  const maxS = g.LIFT_STATION_MAX_S ?? MAX_S;
  const maxNetM = g.LIFT_STATION_MAX_NET_M ?? MAX_NET_M;
  const minRatio = g.LIFT_STATION_MIN_RATIO ?? MIN_RATIO;
  const minEleFrac = g.LIFT_STATION_MIN_ELE_FRAC ?? MIN_ELE_FRAC;

  const kept = out.filter((p) => !p.dropReason && p.segment);
  if (kept.length < 2) return;

  // group kept points into segment.js runs (same shape as liftSnap's groupRuns, but order-preserving
  // slices so adjacency below means "directly neighbouring runs in time")
  const runs = [];
  let cur = null;
  for (const p of kept) {
    if (!cur || cur.id !== p.segment.id) {
      cur = { id: p.segment.id, type: p.segment.type, pts: [p] };
      runs.push(cur);
    } else cur.pts.push(p);
  }

  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (r.type === "lift") continue;
    const nearLift = runs[i - 1]?.type === "lift" || runs[i + 1]?.type === "lift";
    if (!nearLift) continue;

    const pts = r.pts;
    const dur = (pts.at(-1).time - pts[0].time) / 1000;
    if (!(dur < maxS)) continue;
    const net = Math.hypot(pts.at(-1).x - pts[0].x, pts.at(-1).y - pts[0].y);
    if (!(net < maxNetM)) continue;

    let path = 0;
    for (let k = 1; k < pts.length; k++) {
      path += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y);
    }
    const ratio = path / Math.max(net, 1); // net floored at 1 m so a pure tangle still reads high
    const eleDropped = pts.filter((p) => p.liftBoardingEle != null || p.segmentBoundaryEle != null);
    const eleFrac = eleDropped.length / pts.length;
    if (!(ratio > minRatio || eleFrac >= minEleFrac)) continue;

    const why = {
      dur: Math.round(dur),
      net: Math.round(net),
      ratio: Math.round(ratio * 10) / 10,
      eleFrac: Math.round(eleFrac * 100) / 100,
    };
    for (const p of pts) addDrop(p, "liftStationDrop", why);
  }
};
