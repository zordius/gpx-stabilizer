// Compute module "fixQuality" — drop a point whose GPS chip reports it does NOT have a full 3D fix
// (`fix` 2d or none). Unlike `gpsQuality`'s hdop threshold (calibrated to one chip generation, so
// opt-in only — see that module's doc), a non-3D fix is a chip-agnostic, unconditionally-bad
// signal: the device itself is saying it doesn't trust the position. Safe as a CORE BUILTIN.
// Self-gates to a no-op when a source never populates `<fix>` (e.g. Android/FitoTrack GPX has
// neither `<fix>` nor `<hdop>` at all — see measure.js), so it's mechanically safe against any track.
//
// Motivating case (2026-07-08): a GoPro HERO5 clip's cold-start run — the GPS chip holds a stale,
// non-zero (NOT `(0,0)`) placeholder position for several seconds while acquiring a lock, each
// sample explicitly marked `fix: "none"`. Nothing MOVES during the placeholder run (the position is
// literally repeated), so drift/outlier/stray never read it as a teleport — only the device's own
// fix status catches it. `fix` was already gated to HERO10 via `gpsQuality` (its hdop threshold IS
// chip-specific), which meant this exact case went uncaught on every other model.
export const compute = (ctx) => {
  const { n, fix } = ctx;
  const drop = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (fix[i] != null && fix[i] !== "3d") drop[i] = { fix: fix[i] };
  }
  return { drop };
};
