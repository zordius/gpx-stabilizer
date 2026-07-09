// Mode presets — one knob (`opts.mode`, or the CLI `--mode`) bundles every per-mode pipeline switch
// and parameter, so enabling "ski" configures despike's threshold profile, the carve signal, and
// which extra modules load, from ONE place. Each preset has:
//   - `params`: flow to analyze as paramOpts (→ ctx.g), e.g. DESPIKE_PROFILE, CARVE.
//   - `enable`: names of modules to append to the built-ins (e.g. "kink") — resolved via
//     MODULE_REGISTRY below (a static, synchronous set: the mode shortcut only ever bundles this
//     fixed roster, not an arbitrary cwd/npm-resolved module — see resolveMode's doc).
// "core" is the general default (ship-first): nothing extra. "ski" turns on the ski-specific layer.
// Future ski work (reconstruction, stage-2 activity) extends MODES.ski — still one place.

import { validateModule } from "./mods/index.js";
import * as kink from "./mods/kink.js";
import * as liftBoardingEle from "./mods/liftBoardingEle.js";
import * as liftConfirm from "./mods/liftConfirm.js";
import * as liftSnap from "./mods/liftSnap.js";
import * as noise from "./mods/noise.js";
import * as segment from "./mods/segment.js";
import * as tangleSnap from "./mods/tangleSnap.js";

// Statically imported (not `loadModule()`) so `resolveMode` stays synchronous — every one of these
// is an internal, checked-in module; there's no cwd/npm-override use case for a mode's own bundle
// (unlike a caller's own `opts.modules`, which still takes arbitrary Module objects either way).
//
// Built LAZILY (on first `resolveMode()` call), not at this module's own top level: `liftConfirm.js`
// imports `addDrop` from `../analyze.js`, and `analyze.js` imports `resolveMode` from here — a real
// circular import. Reading `liftConfirm.finalize` (a `const`, not a hoisted function declaration)
// while THIS module is still mid-evaluation as part of that cycle hits it before its own
// initialization (`ReferenceError: Cannot access 'finalize' before initialization`). Deferring the
// read to the first actual CALL sidesteps it — by then every module in the graph has finished
// evaluating, cycle included.
let moduleRegistry = null;
function getModuleRegistry() {
  if (!moduleRegistry) {
    moduleRegistry = {
      kink: validateModule("kink", kink),
      segment: validateModule("segment", segment),
      liftConfirm: validateModule("liftConfirm", liftConfirm),
      liftSnap: validateModule("liftSnap", liftSnap),
      liftBoardingEle: validateModule("liftBoardingEle", liftBoardingEle),
      tangleSnap: validateModule("tangleSnap", tangleSnap),
      noise: validateModule("noise", noise),
    };
  }
  return moduleRegistry;
}

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
      liftBoardingEle: true,
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
    // `liftBoardingEle` (2026-07-08) fixes the lift-boarding/unloading elevation-sag artifact (see
    // that module's doc) — validated against 53 real confirmed-lift runs across 9 real files, ~17%
    // (likely an undercount) show the exact shape. Must run after `liftConfirm` (reads its verdict).
    // `noise` (2026-07-08) is diagnostic-only (see that module's doc) — bundled here so its map/chart
    // layer is available whenever ski mode is, no separate opt-in needed to go look at it.
    enable: ["kink", "segment", "liftConfirm", "liftSnap", "liftBoardingEle", "tangleSnap", "noise"],
  },
};

/**
 * Expand `opts.mode` (e.g. "ski") into the preset's `params` + `enable` modules, merged under the
 * caller's own opts (explicit fields win over the preset — same precedence the CLI's `--mode` +
 * `--config` already had). A no-op, returning `opts` unchanged, when `opts.mode` is absent — so
 * every existing caller that never sets `mode` pays nothing. `analyze()` and `stabilize()` both call
 * this at their own top; `stabilize()` strips `mode` before its own params reach `analyze()` again,
 * so there's no double-expansion.
 * @param {{ mode?: keyof typeof MODES } & Record<string, unknown>} [opts]
 */
export function resolveMode(opts = {}) {
  const { mode, ...rest } = opts;
  if (mode == null) return opts;
  const preset = MODES[mode];
  if (!preset) throw new Error(`unknown mode "${mode}" (use: ${Object.keys(MODES).join(", ")})`);
  const registry = getModuleRegistry();
  const presetModules = preset.enable.map((name) => registry[name]);
  return { ...preset.params, ...rest, modules: [...presetModules, ...(rest.modules ?? [])] };
}
