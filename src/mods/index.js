// Module registry — the Module contract, a validator, a loader, and the built-in modules.
//
// A module FILE exports `label` and/or `compute` (no name — the name is the filename):
//   - label(point, lastKept) → null | { drop?: context, [labelKey]: value }. The reserved `drop`
//     key excludes the point from the time series (recorded as a drop reason under the module's
//     name); other keys ride on the point as namespaced labels. Runs per raw point, pre-measurement.
//   - compute(ctx)           → { [signalKey]: array, drop?: (null|context)[] }. Runs post-measurement.
// Symmetric: both phases produce ordinary outputs (labels / signals) plus an optional reserved
// `drop`. A module joins a phase by exposing that phase's callback, or both by exposing both.

import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as activity from "./activity.js";
import * as noTime from "./noTime.js";
import * as outlier from "./outlier.js";
import * as oversample from "./oversample.js";
import * as sameTime from "./sameTime.js";

/**
 * @typedef {{ label?: Function, compute?: Function }} ModuleDef  a module file's exports
 * @typedef {{ name: string, label?: Function, compute?: Function }} Module  a named, loaded module
 */

/**
 * Validate a module file's exports and pair them with a name. Throws on a malformed module.
 * @param {string} name
 * @param {ModuleDef} def
 * @returns {Module}
 */
export function validateModule(name, def) {
  if (!name || typeof name !== "string") throw new Error("module name must be a non-empty string");
  if (typeof def.label !== "function" && typeof def.compute !== "function") {
    throw new Error(`module "${name}" must export label and/or compute`);
  }
  for (const k of ["label", "compute"]) {
    if (def[k] != null && typeof def[k] !== "function") {
      throw new Error(`module "${name}".${k} must be a function`);
    }
  }
  return { name, label: def.label, compute: def.compute };
}

/** The built-in modules, named after their files and validated. */
export const builtins = [
  validateModule("noTime", noTime),
  validateModule("sameTime", sameTime),
  validateModule("oversample", oversample),
  validateModule("outlier", outlier),
  validateModule("activity", activity),
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
