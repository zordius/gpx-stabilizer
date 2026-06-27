// Mode presets — one knob (the CLI `--mode`) bundles every per-mode pipeline switch and parameter, so
// enabling "ski" configures despike's threshold profile, the carve signal, and which extra modules
// load, from ONE place. Each preset has:
//   - `params`: flow to analyze as paramOpts (→ ctx.g), e.g. DESPIKE_PROFILE, CARVE.
//   - `enable`: module specs loaded via loadModule() and appended to the built-ins (e.g. "kink").
// "core" is the general default (ship-first): nothing extra. "ski" turns on the ski-specific layer.
// Future ski work (reconstruction, stage-2 activity) extends MODES.ski — still one place.
export const MODES = {
  core: { params: {}, enable: [] },
  ski: { params: { DESPIKE_PROFILE: "ski", CARVE: true }, enable: ["kink"] },
};
