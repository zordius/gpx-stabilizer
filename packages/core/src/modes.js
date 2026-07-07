// Mode presets — one knob (the CLI `--mode`) bundles every per-mode pipeline switch and parameter, so
// enabling "ski" configures despike's threshold profile, the carve signal, and which extra modules
// load, from ONE place. Each preset has:
//   - `params`: flow to analyze as paramOpts (→ ctx.g), e.g. DESPIKE_PROFILE, CARVE.
//   - `enable`: module specs loaded via loadModule() and appended to the built-ins (e.g. "kink").
// "core" is the general default (ship-first): nothing extra. "ski" turns on the ski-specific layer.
// Future ski work (reconstruction, stage-2 activity) extends MODES.ski — still one place.
export const MODES = {
  core: { params: {}, enable: [] },
  // `segment` was already shipped (2026-07-04) but never added here — without it, `liftConfirm`'s
  // `point.segment` read is always undefined, so ski mode would load liftConfirm/liftSnap and have
  // them do nothing. Added now alongside them (2026-07-07), not a new design decision on its own.
  ski: {
    params: {
      DESPIKE_PROFILE: "ski",
      CARVE: true,
      liftSnap: true,
      tangleSnap: true,
      gradeBound: true,
    },
    // `gradeBound` (2026-07-08) was already shipped and general-purpose but never enabled by
    // EITHER mode — ski-mode output had zero elevation despiking by default (the physically-
    // impossible spikes, e.g. 989->988->989, just passed straight through). Empirically checked
    // against 7 real ski GPX files (gpx_eval/gradebound_falsepos_check*.mjs, 99472 kept points)
    // before flipping this on: 82% of points move <0.05m, and the "plausible false positive on
    // real gentle terrain" band (1-3m adjustment at normal ski speed, not an obvious sensor glitch)
    // is ~0.14% of points, concentrated on slow (2-4 m/s) traverses. Cheap enough to default on.
    // `tangleSnap` (2026-07-07) is general-purpose, not ski-specific — bundled here anyway
    // because ski mode is currently the only mode doing survivor repositioning at all, and it must
    // run AFTER `liftSnap` (its own module doc: prefers `point.liftSnap`'s position when present).
    // A non-ski caller can still `loadModule("tangleSnap")` and pass `tangleSnap: true` manually.
    enable: ["kink", "segment", "liftConfirm", "liftSnap", "tangleSnap"],
  },
};
