// Compute module "drift" — detect stationary satellite-signal drift (typically a person stopped
// indoors): the heading is random (`wander` high), the altitude is flat (`|vs|` low), AND the
// receiver didn't go anywhere (net displacement small) — a SPATIALLY-COMPACT stay whose reported
// position merely scatters. The horizontal speed lies (drift fakes it); the vertical axis and the
// net-displacement stay honest. Compactness is the scale-free tell — it does the "really a stay"
// work that duration used to, so a low duration floor now catches both long and short stays in ONE
// pass. Such points aren't real positions, so the run is dropped; the drop context carries the
// SEGMENT (id, time span, point count, centroid) so a later stage can collapse it into one `stay`
// marker. Thresholds are tunable via opts (flow through `g.DRIFT_*`).
//
// Net displacement is checked at TWO window scales, either passing (same OR-across-shapes pattern
// as outlier's detour/speed-spike): `netd150` (+/-NETD_WIN, 150 s by default) for a real long stay,
// and a short-window "messiness" check (`straightShort`, +/-NETD_WIN_SHORT, 15 s) for a compact
// stay/wobble on a recording not much longer than NETD_WIN — the long window then clamps to the
// whole clip and dilutes with real motion elsewhere in it, so a genuine short stay can undershoot
// the long-window check by only a little (found on `GX065132.MP4`: netd150 = 102 m against a 100 m
// cutoff, entirely because the clip is only 33 s and the +/-150 s window swallows the fast descent
// earlier in the same clip).
//
// The short-window branch checks `straightShort` (net displacement / path length over the SAME
// +/-NETD_WIN_SHORT window, see profile.js) rather than a speed gate + absolute distance cutoff: an
// earlier version gated on `hs < 2 m/s` and reused the long window's `netd150` cutoff (100 m), but a
// real person walking away from a chairlift — decelerating smoothly to a near-stop, then resuming —
// tripped that gate for its ENTIRE ~47 s span (hs stays under 2 m/s throughout a slow walk; 100 m of
// net displacement is not a meaningful "compact" bound at a 30 s window scale, since even brisk
// walking covers well under that). `straightShort` answers the right question instead — not "how
// far/how fast" but "how much of the path actually converted into net progress" — because GPS noise
// wobbling in place inflates path length far more than it inflates net displacement, while a real
// walk (even slow, even pausing) keeps a meaningful fraction of its path length as net progress.
// Validated against both the real false positive above and the original true-positive sample
// (`gpx_eval/straightshort_scan.mjs`): straightShort has a clean gap in the data with no segment's
// minimum landing between 0.13 and 0.24 — genuinely bimodal, not a hand-tuned cutoff — and a real
// fast carve never approaches either side (stays >0.8), so no separate speed gate is needed.
//
// A run qualifying ONLY through the short-window path (netd150 never confirms it — the long
// window's own compactness never holds for any point in the run) gets its OWN, much lower duration
// floor (DRIFT_MIN_SHORT): the 30 s floor below exists because the long window's compactness check
// alone isn't a strong enough tell over a couple of samples, but a run the short window alone
// confirms doesn't need nearly as much time to be a believable stay/wobble — and requiring 30 s
// here would defeat the short window's whole purpose (GX065132's actual qualifying run is ~2 s: a
// `vs` glitch a few samples later, unrelated to this fix, cuts it short). A run where netd150 ALSO
// holds keeps the original 30 s floor unchanged.

export const compute = (ctx) => {
  const { n, t, x, y, wander, vs, netd150, straightShort, g } = ctx;
  const wHi = g.DRIFT_WANDER ?? 0.5; //          random heading (circular variance)
  const vLo = g.DRIFT_VS ?? 0.2; //              flat altitude (m/s) — the clean tell, drift can't fake it
  const dLo = g.DRIFT_NETD ?? 100; //            net displacement over +/-150 s (m): small = went nowhere
  const straightLo = g.DRIFT_STRAIGHT_SHORT ?? 0.2; // net displacement / path length over +/-15 s
  const gap = g.DRIFT_GAP ?? 60; //              merge rest-like points within this many seconds
  const minDur = g.DRIFT_MIN ?? 30; //           low floor — compactness does the work, not duration
  const minDurShort = g.DRIFT_MIN_SHORT ?? 2; // s — floor for a run only the short window confirms

  const flat = (k) => wander[k] > wHi && Math.abs(vs[k]) < vLo; // shared by both window checks
  const isDriftLong = (k) => flat(k) && netd150[k] < dLo;
  const isDriftShort = (k) => flat(k) && straightShort[k] < straightLo;
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
