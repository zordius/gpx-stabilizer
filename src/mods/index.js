// Module registry — the Module contract, a validator, a loader, and the built-in modules.
//
// A module FILE exports `screen` and/or `compute` (no name — the name is the filename):
//   - screen(point, lastKept) → null (keep) | context (drop, recorded under the module's name).
//   - compute(ctx)            → { [signalKey]: array, drop?: (null|context)[] }.
// A module joins the screen phase by exposing `screen`, the compute phase by exposing `compute`,
// and both phases by exposing both.

import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as activity from "./activity.js";
import * as noTime from "./noTime.js";
import * as outlier from "./outlier.js";
import * as oversample from "./oversample.js";
import * as sameTime from "./sameTime.js";

/**
 * @typedef {{ screen?: Function, compute?: Function }} ModuleDef  a module file's exports
 * @typedef {{ name: string, screen?: Function, compute?: Function }} Module  a named, loaded module
 */

/**
 * Validate a module file's exports and pair them with a name. Throws on a malformed module.
 * @param {string} name
 * @param {ModuleDef} def
 * @returns {Module}
 */
export function validateModule(name, def) {
  if (!name || typeof name !== "string") throw new Error("module name must be a non-empty string");
  if (typeof def.screen !== "function" && typeof def.compute !== "function") {
    throw new Error(`module "${name}" must export screen and/or compute`);
  }
  for (const k of ["screen", "compute"]) {
    if (def[k] != null && typeof def[k] !== "function") {
      throw new Error(`module "${name}".${k} must be a function`);
    }
  }
  return { name, screen: def.screen, compute: def.compute };
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
