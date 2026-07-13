// Compute module "isolatedDrop" — FINALIZE phase, general-purpose, opt-in (bundled by ski mode
// alongside its own drop/reposition modules, but chip- and mode-agnostic by construction — see
// below; any source/mode can load it manually via opts.modules).
//
// Redefines "segment" purely from the OUTPUT's own time gaps, independent of segment.js's
// vspeed-sign lift/descent/flat classification: two consecutive KEPT points (no dropReason, as of
// wherever this module sits in the finalize order) more than ISOLATED_GAP_S apart mark a break. The
// default gap (3s) matches movie-layers' own gps-channel `maxGap` — the threshold at which its
// lat/lon widget freezes/shows "no signal" (movie-layers src/providers/{gopro,gpx}.js, `opts.maxGap
// ?? 3`; see src/data.js's Channel — a bigger inter-sample gap reads as `valid: false`, holding the
// last value). So a run this module even looks at is exactly one continuous on-screen appearance of
// that widget between two freezes — the same segmentation a viewer would perceive.
//
// A run is dropped WHOLE when BOTH: its own duration is under ISOLATED_MAX_S (5s), AND its
// head-to-tail net displacement is under ISOLATED_MAX_NET_M (10m) — a brief, near-stationary scrap
// sandwiched between two gaps (or sitting at the very start/end of the track, which is just as much
// an edge as a real gap) that is more likely a leftover fragment than a real, meaningful moment. For
// a video overlay this converts "flicker on for a couple of seconds then freeze" into "just one
// continuous freeze" — avoiding a jarring blink of the lat/lon widget for a stretch too brief to
// read anyway.
//
// Chip/mode-agnostic by construction: reads only point.time/x/y (present on every point — measure.js
// projects every point, dropped or not, before any drop decision is made; see SPEC.md "measure.js")
// and dropReason — no hdop/fix, no segment.type, no activity/mode fields. Thresholds are first-look
// guesses (same stance as this codebase's other exploratory modules — segment.js, liftConfirm.js —
// "not independently tuned"), not derived from a ground-truthed corpus; override via g.ISOLATED_*.

import { addDrop } from "../analyze.js";

const GAP_S = 3; //       seconds — a bigger inter-kept-point gap starts a new "segment" (matches
// movie-layers' own gps-channel maxGap / widget-freeze default)
const MAX_S = 5; //       seconds — a segment shorter than this is a drop candidate
const MAX_NET_M = 10; //  metres — AND its own head-to-tail displacement under this

export const finalize = (out, ctx) => {
  const g = ctx.g ?? {};
  const gapS = g.ISOLATED_GAP_S ?? GAP_S;
  const maxS = g.ISOLATED_MAX_S ?? MAX_S;
  const maxNetM = g.ISOLATED_MAX_NET_M ?? MAX_NET_M;

  const kept = out.filter(
    (p) => !p.dropReason && p.time != null && Number.isFinite(p.x) && Number.isFinite(p.y),
  );
  if (kept.length === 0) return;

  // group into runs, breaking wherever consecutive kept points are more than gapS apart
  const runs = [];
  let cur = [kept[0]];
  for (let i = 1; i < kept.length; i++) {
    if ((kept[i].time - kept[i - 1].time) / 1000 > gapS) {
      runs.push(cur);
      cur = [];
    }
    cur.push(kept[i]);
  }
  runs.push(cur);

  for (const run of runs) {
    const dur = (run.at(-1).time - run[0].time) / 1000;
    if (!(dur < maxS)) continue;
    const net = Math.hypot(run.at(-1).x - run[0].x, run.at(-1).y - run[0].y);
    if (!(net < maxNetM)) continue;
    const why = { dur: Math.round(dur * 10) / 10, net: Math.round(net * 10) / 10 };
    for (const p of run) addDrop(p, "isolatedDrop", why);
  }
};
