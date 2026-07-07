// Module registry — the Module contract, a validator, a loader, and the built-in modules.
//
// A module FILE exports `repair`, `label` and/or `compute` (no name — the name is the filename):
//   - repair(points, edit)   → rewrites original values BEFORE measurement (whole-array, one-shot).
//     `edit(point, field, value)` overwrites point[field] and records provenance in point.edited;
//     positions/time it changes flow into every downstream stage and the output. (e.g. dequantizeTime)
//   - label(point, lastKept) → null | { drop?: context, [labelKey]: value }. The reserved `drop`
//     key excludes the point from the time series (recorded as a drop reason under the module's
//     name); other keys ride on the point as namespaced labels. Runs per raw point, pre-measurement.
//   - compute(ctx)           → { [signalKey]: array, drop?: (null|context)[] }. Runs post-measurement.
//   - finalize(out, ctx)     → post-assemble SEQUENTIAL pass over the fully-assembled points. Unlike
//     compute (modules independent, same ctx), finalize modules run in order and see the assembled
//     points AND each other's mutations — the home for cross-module reconciliation, reconstruction,
//     and segmentation. Mutates `out` in place (no return). Runs after every drop, incl. badspan.
// A module joins a phase by exposing that phase's callback (one, or several).

import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as activity from "./activity.js";
import * as dequantizeTime from "./dequantizeTime.js";
import * as despike from "./despike.js";
import * as drift from "./drift.js";
import * as noTime from "./noTime.js";
import * as outlier from "./outlier.js";
import * as oversample from "./oversample.js";
import * as stray from "./stray.js";

/**
 * @typedef {{ repair?: Function, label?: Function, compute?: Function, finalize?: Function }} ModuleDef  a module's exports
 * @typedef {{ name: string, repair?: Function, label?: Function, compute?: Function, finalize?: Function }} Module
 */

const PHASES = ["repair", "label", "compute", "finalize"];

/**
 * Validate a module file's exports and pair them with a name. Throws on a malformed module.
 * @param {string} name
 * @param {ModuleDef} def
 * @returns {Module}
 */
export function validateModule(name, def) {
  if (!name || typeof name !== "string") throw new Error("module name must be a non-empty string");
  if (PHASES.every((k) => typeof def[k] !== "function")) {
    throw new Error(`module "${name}" must export ${PHASES.join(", ")} (one or more)`);
  }
  for (const k of PHASES) {
    if (def[k] != null && typeof def[k] !== "function") {
      throw new Error(`module "${name}".${k} must be a function`);
    }
  }
  return {
    name,
    repair: def.repair,
    label: def.label,
    compute: def.compute,
    finalize: def.finalize,
  };
}

/** The built-in modules (the general "core" pipeline), named after their files and validated.
 * NOTE: `kink` is intentionally NOT here — it's a label-only overlay with no cleaning value in core
 * (its sharp-turn flags are either spikes despike already drops, or real corners we keep). The file
 * `./kink.js` stays; opt back in for the future ski work via `opts.modules: [await loadModule("kink")]`.
 * It originally sat after `drift` / before `despike`, but compute-module ORDER IS COSMETIC (each runs
 * on the same ctx independently; assemble/glue come after), so re-add it anywhere among the computes.
 * `gpsQuality` is ALSO intentionally not here, for a different reason: it gates on the raw GPS chip's
 * own `hdop`/`fix`, and its default threshold is calibrated to one specific chip generation (see the
 * module's own doc) — a caller that knows which device/model produced the track opts in via
 * `opts.modules: [await loadModule("gpsQuality")]` (e.g. packages/gopro, gated on `meta.model`).
 * `segment`/`liftConfirm`/`liftSnap` are also not here — ski-specific (lift/descent/flat + cable-line
 * confirmation + reconstruction), untuned first-look thresholds, no value for a non-ski track. All
 * three (plus `kink`) are bundled by `MODES.ski` in `../modes.js`, the intended way to opt in.
 * `tangleSnap` is also not here, though it's general-purpose rather than ski-specific (a very-low-
 * speed GPS-tangle thin+reinflate, no sport assumptions) — its thresholds are equally untuned, and it
 * still needs to run after `liftSnap` when both are present, so it's bundled by `MODES.ski` alongside
 * the others rather than made a builtin ahead of the rest of that decision being revisited. */
export const builtins = [
  validateModule("dequantizeTime", dequantizeTime),
  validateModule("noTime", noTime),
  validateModule("oversample", oversample),
  validateModule("outlier", outlier),
  validateModule("stray", stray),
  validateModule("activity", activity),
  validateModule("drift", drift),
  validateModule("despike", despike),
];

/**
 * Load a module by spec. A path (contains a separator or a `.js`/`.mjs`/`.cjs` extension) is
 * imported directly, relative to the cwd; its name is the file's basename. A bare name (e.g.
 * "noTime") is resolved in order — 1) `<cwd>/<name>.js`, 2) an installed npm package `<name>`,
 * 3) the internal `./mods/<name>.js` — and throws if none resolve; its name is the bare spec.
 * @param {string} spec
 * @returns {Promise<Module>}
 */
export async function loadModule(spec) {
  if (/[\\/]/.test(spec) || /\.[cm]?js$/.test(spec)) {
    const url = pathToFileURL(resolve(process.cwd(), spec)).href;
    return validateModule(basename(spec).replace(/\.[cm]?js$/, ""), await import(url));
  }
  const candidates = [
    pathToFileURL(resolve(process.cwd(), `${spec}.js`)).href, // 1. <cwd>/<name>.js
    spec, //                                                     2. an npm package
    `./${spec}.js`, //                                           3. internal ./mods/<name>.js
  ];
  for (const candidate of candidates) {
    let ns;
    try {
      ns = await import(candidate);
    } catch (err) {
      if (err?.code === "ERR_MODULE_NOT_FOUND" || err?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
        continue; // not here — try the next location
      }
      throw err; // a real error inside a resolved module
    }
    return validateModule(spec, ns);
  }
  throw new Error(`cannot resolve module "${spec}" (tried cwd file, npm package, internal mods/)`);
}
