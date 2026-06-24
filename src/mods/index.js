// Module registry — the Module contract, a validator, a loader, and the built-in modules.
//
// A module FILE exports `screen` and/or `compute` (no name — the name is the filename):
//   - screen(point, lastKept) → null (keep) | context (drop, recorded under the module's name).
//   - compute(ctx)            → { [signalKey]: array, drop?: (null|context)[] }.
// A module joins the screen phase by exposing `screen`, the compute phase by exposing `compute`,
// and both phases by exposing both.

import { basename } from "node:path";
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
];

/** Dynamically load a custom module file; its name is the file's basename (sans extension). */
export async function loadModule(path) {
  const ns = await import(path);
  const name = basename(path).replace(/\.[cm]?js$/, "");
  return validateModule(name, ns);
}
