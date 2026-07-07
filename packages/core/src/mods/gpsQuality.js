// Compute module "gpsQuality" — drop a point on the GPS chip's OWN reported quality (`fix`
// 2d/3d/none, `hdop` dilution of precision), not on derived geometry the way drift/outlier/stray
// do. Self-gates to a no-op when a source never populates these fields (e.g. Android/FitoTrack GPX
// has neither `<fix>` nor `<hdop>` at all — see measure.js), so it's mechanically safe to run
// against any track.
//
// NOT a builtin (see mods/index.js's kink.js precedent for the same reason): the default
// `HDOP_MAX` below is calibrated to one specific GPS chip generation. Cross-device validation
// (gpx-stabilizer's gpx_eval/gx_specific_signal_mining.mjs and hero5_hdop_check.mjs, three days of
// simultaneous GoPro Hero10 + Android recordings) found Hero10's baseline hdop 5-10x higher than a
// same-day Hero5's (kept-point median 5.3 vs 1.8), so a fixed cutoff tuned for one chip would
// either misfire or sit permanently inert on another — this must stay an explicit opt-in
// (`opts.modules`), chosen by a caller that knows which chip/model produced the track (e.g.
// packages/gopro gates it on `meta.model === "HERO10"`), not a general "core" default.
//
// On that same 3-day GX(Hero10)+Android corpus, `fix !== "3d" || hdop >= 10` independently catches
// 82.3% of the points existing drift/outlier/stray/badspan modules miss entirely (823 points), at a
// 7.9% false-positive cost on points otherwise judged fine — and the caught points are genuinely
// bad, not boundary noise (cross-device position error: median 159m, mean 733m, vs. 4.9m/18.3m for
// points the gate leaves alone).
export const compute = (ctx) => {
  const { n, hdop, fix, g } = ctx;
  const hdopMax = g.GPSQ_HDOP_MAX ?? 10;
  const drop = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const badFix = fix[i] != null && fix[i] !== "3d";
    const badHdop = hdop[i] != null && hdop[i] >= hdopMax;
    if (badFix || badHdop) drop[i] = { hdop: hdop[i], fix: fix[i] };
  }
  return { drop };
};
