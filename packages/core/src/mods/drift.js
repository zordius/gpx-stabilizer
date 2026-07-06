// Compute module "drift" — detect stationary satellite-signal drift (typically a person stopped
// indoors): the heading is random (`wander` high), the altitude is flat (`|vs|` low), AND the
// receiver didn't go anywhere relative to how far it LOOKED like it travelled — a SPATIALLY-COMPACT
// stay whose reported position merely scatters. The horizontal speed lies (drift fakes it); the
// vertical axis and the path-efficiency check stay honest. Compactness is the scale-free tell — it
// does the "really a stay" work that duration used to, so a low duration floor now catches both
// long and short stays in ONE pass. Such points aren't real positions, so the run is dropped; the
// drop context carries the SEGMENT (id, time span, point count, centroid) so a later stage can
// collapse it into one `stay` marker. Thresholds are tunable via opts (flow through `g.DRIFT_*`).
//
// Checked at TWO window scales, either passing (same OR-across-shapes pattern as outlier's
// detour/speed-spike): `straightLong` (+/-NETD_WIN, 150 s) for a real long stay, and `straightShort`
// (+/-NETD_WIN_SHORT, 15 s) for a compact stay/wobble a long window dilutes with real motion
// elsewhere. Both are net displacement / path length over their own window (see profile.js) — NOT
// plain net displacement — because a plain distance cutoff (the original design, `netd150 < 100 m`
// for the long window; an even earlier short-window attempt reused that same cutoff at 15 s) asks
// "how far did it net travel," which a real, clean, ONE-TIME fold answers exactly like genuine
// wandering-in-place does: both net near-zero displacement. `straightLong`/`straightShort` ask the
// right question instead — "how much of the path actually converted into net progress" — because
// GPS noise wobbling in place inflates path length far more than it inflates net displacement,
// while a real walk (even slow, even pausing, even folding back on itself once) keeps a meaningful
// fraction of its path length as net progress.
//
// Found chasing a real false positive at EACH scale: at the short scale, a person walking away from
// a chairlift, decelerating smoothly to a near-stop then resuming, tripped an early hs+netdShort
// short-window gate for its entire ~47 s span (hs stays under 2 m/s throughout a slow walk; 100 m of
// net displacement is not a meaningful "compact" bound at a 30 s window scale). At the long scale, a
// person's one clean, non-self-intersecting U-turn — ground-truthed as walked exactly once, not a
// repeat visit — tripped the original plain `netd150 < 100` long-window check, for the identical
// reason one scale up: a single fold nets little displacement over +/-150 s the same way genuine
// wandering-in-place does.
//
// Neither window is redundant with the other even though both now share the same discriminant: a
// real short stay gets diluted away by surrounding motion in the long window (needs the short
// window — e.g. `GX065132.MP4`: netd150 = 102 m against a 100 m cutoff, purely because the clip is
// only 33 s and the +/-150 s window swallows a fast descent earlier in the same clip), while a long,
// low-grade wander can look locally fine in any given 15 s slice yet never leave the area over
// minutes (needs the long window — `gpx_eval/onewindow_check.mjs` found the long window catching
// 1,864 real points on one corpus file, 78% of which the short window's own straightShort never
// dipped below 0.2 for at all). A real fast carve never approaches either cutoff (stays >0.8), so no
// separate speed gate is needed at either scale.
//
// Not a hand-tuned cutoff either way: both real false positives sit close enough to their own
// scale's true positive (0.289 vs. 0.298 short-scale; 0.207 long-scale, right at the line) that 0.2
// is a deliberate, documented trade-off — chosen knowing it drops a weaker-evidence true positive at
// each scale in exchange for cleanly excluding a real, confirmed false positive at that scale (see
// profile.js's `windows()` doc for the full validation).
//
// A run qualifying ONLY through the short-window path (the long window's own straightLong never
// confirms it for any point in the run) gets its OWN, much lower duration floor (DRIFT_MIN_SHORT):
// the 30 s floor below exists because the long window's compactness check alone isn't a strong
// enough tell over a couple of samples, but a run the short window alone confirms doesn't need
// nearly as much time to be a believable stay/wobble — and requiring 30 s here would defeat the
// short window's whole purpose (GX065132's actual qualifying run is ~2 s: a `vs` glitch a few
// samples later, unrelated to either fix, cuts it short). A run where straightLong ALSO holds keeps
// the original 30 s floor unchanged.

export const compute = (ctx) => {
  const { n, t, x, y, wander, vs, straightLong, straightShort, g } = ctx;
  const wHi = g.DRIFT_WANDER ?? 0.5; //               random heading (circular variance)
  const vLo = g.DRIFT_VS ?? 0.2; //                   flat altitude (m/s) — the clean tell, drift can't fake it
  const straightLoLong = g.DRIFT_STRAIGHT_LONG ?? 0.2; //  net displacement / path length over +/-150 s
  const straightLoShort = g.DRIFT_STRAIGHT_SHORT ?? 0.2; // net displacement / path length over +/-15 s
  const gap = g.DRIFT_GAP ?? 60; //                   merge rest-like points within this many seconds
  const minDur = g.DRIFT_MIN ?? 30; //                low floor — compactness does the work, not duration
  const minDurShort = g.DRIFT_MIN_SHORT ?? 2; //      s — floor for a run only the short window confirms

  const flat = (k) => wander[k] > wHi && Math.abs(vs[k]) < vLo; // shared by both window checks
  const isDriftLong = (k) => flat(k) && straightLong[k] < straightLoLong;
  const isDriftShort = (k) => flat(k) && straightShort[k] < straightLoShort;
  const isDrift = (k) => isDriftLong(k) || isDriftShort(k);
  const drift = new Array(n).fill(null);
  const drop = new Array(n).fill(null);

  let run = []; // indices of the current candidate run of rest-like points
  let segId = 0;
  const flush = () => {
    const dur = run.length ? t[run[run.length - 1]] - t[run[0]] : 0;
    const floor = run.length && run.every((k) => !isDriftLong(k)) ? minDurShort : minDur;
    if (run.length && dur >= floor) {
      let sx = 0;
      let sy = 0;
      for (const k of run) {
        sx += x[k];
        sy += y[k];
      }
      const seg = {
        seg: segId++,
        t0: t[run[0]],
        t1: t[run[run.length - 1]],
        dur,
        npt: run.length,
        cx: sx / run.length, // centroid — where the receiver actually sat
        cy: sy / run.length,
      };
      for (const k of run) {
        drift[k] = seg;
        drop[k] = seg;
      }
    }
    run = [];
  };
  for (let k = 0; k < n; k++) {
    if (!isDrift(k)) continue;
    if (run.length && t[k] - t[run[run.length - 1]] > gap) flush(); // time gap too big -> new run
    run.push(k);
  }
  flush();
  return { drift, drop };
};
