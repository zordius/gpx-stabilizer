// Analyze a track: label raw points, measure the survivors, profile their neighbourhoods, run
// compute modules, and assemble everything back onto the original points. This is the
// orchestration/policy layer on top of the point-level engine (./measure.js), the window-level
// descriptors (./profile.js), and the pluggable modules (./mods). The per-point context modules see
// is the union of the measure and profile bundles.
//
// There is no status field: a point belongs in the clean track iff it has NO `dropReason`. Drops are
// recorded as `dropReason = { reasonKey: context }` + `dropCount` (via `addDrop`). Three module
// phases:
//   - `repair(points, edit)`: rewrite original values BEFORE anything reads them (dequantizeTime). Each
//     `edit(point, field, value)` overwrites the field and logs provenance in `point.edited`
//     (via `addEdit`); the new values flow through the whole pipeline and into the output.
//   - `label(point, lastKept)`: run on the repaired raw points (noTime, oversample). A `drop` excludes
//     the point from the projection centre and time series (position + reasons only, no signals);
//     other keys ride on the point as namespaced labels.
//   - `compute(ctx)`: run on the per-point context after the blocks (outlier, activity, drift, kink).
//     Non-`drop` keys attach as `point[name][key]` (signals); `drop` flags a point that WAS measured.
// Built-in modules (./mods) always run; caller modules are appended via `opts.modules`.

import { measure } from "./measure.js";
import { builtins } from "./mods/index.js";
import { profile } from "./profile.js";

/**
 * @param {import("./measure.js").TrackPoint[]} points  one track's points, in time order
 * @param {{ modules?: import("./mods/index.js").Module[], disable?: string[] } & Record<string, number>} [opts]
 *   `modules` to append, `disable` to skip built-ins by name (e.g. ["oversample"]), plus any
 *   measurement param overrides (see PARAMS in ./measure.js). The whole object is plain JSON.
 * @returns {Array<object>} every original point, enriched (kept) or position-only (dropped)
 */
export function analyze(points, opts = {}) {
  const { modules = [], disable = [], ...paramOpts } = opts;
  if (points.length === 0) return [];

  const all = [...builtins.filter((m) => !disable.includes(m.name)), ...modules];
  const pts = repairPoints(
    points,
    all.filter((m) => m.repair),
  ); // rewrite raw values before measuring
  const bags = label(
    pts,
    all.filter((m) => m.label),
  );
  const valid = keptIndices(bags);
  const m = measure(pts, valid); //              point-level primitives (positions, dt, planarStep)
  const w = profile(m, paramOpts); //                   window-level descriptors (hs, straight, …)
  const ctx = { ...m, ...w }; //                        the per-point context: measure ∪ profile

  const modData = {};
  for (const mod of all.filter((mm) => mm.compute)) modData[mod.name] = mod.compute(ctx);

  return assemble(pts, bags, valid, ctx, modData);
}

/**
 * Run the repair phase: copy the input (so the caller's points aren't mutated), then let each repair
 * module rewrite values via an `edit` callback bound to its name. Returns the repaired copy.
 * @param {object[]} points
 * @param {import("./mods/index.js").Module[]} mods
 * @returns {object[]}
 */
export function repairPoints(points, mods) {
  const pts = points.map((p) => ({ ...p }));
  for (const mod of mods)
    mod.repair(pts, (point, field, value) => addEdit(point, field, value, mod.name));
  return pts;
}

/**
 * Overwrite `point[field]` and record the change centrally in `point.edited[field]` (capturing the
 * original `from` once, the latest `to`, and the list of modules that touched it). Mirrors `addDrop`.
 * @param {object} point
 * @param {string} field
 * @param {number} value
 * @param {string} by  the editing module's name
 * @returns {object} the same point
 */
export function addEdit(point, field, value, by) {
  if (!point.edited) point.edited = {};
  if (!point.edited[field]) point.edited[field] = { from: point[field], by: [] };
  const e = point.edited[field];
  e.to = value;
  e.by.push(by);
  point[field] = value;
  return point;
}

/**
 * Run the label modules over the raw points in one sweep with a shared "last kept" reference.
 * Returns, per point, `null` or a `{ [name]: bag }` object of each module's per-point bag (a bag may
 * carry the reserved `drop` key and/or other labels). A point with any `drop` is excluded from the
 * time series, so the running reference only advances past points no module dropped.
 */
export function label(points, modules) {
  const bags = new Array(points.length).fill(null);
  let lastKept = null; // the last point no label module dropped — the running reference
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    let bag = null;
    let dropped = false;
    for (const m of modules) {
      const out = m.label(p, lastKept);
      if (out != null) {
        if (!bag) bag = {};
        bag[m.name] = out;
        if (out.drop != null) dropped = true;
      }
    }
    bags[i] = bag;
    if (!dropped) lastKept = p; // labelled-but-kept points still advance the reference
  }
  return bags;
}

/** True if any label module dropped this point (its bag carries the reserved `drop` key). */
function isDropped(bag) {
  if (bag == null) return false;
  for (const name in bag) if (bag[name].drop != null) return true;
  return false;
}

/** Original indices of the kept points (not dropped by the label phase → the time-series). */
function keptIndices(bags) {
  const valid = [];
  for (let i = 0; i < bags.length; i++) if (!isDropped(bags[i])) valid.push(i);
  return valid;
}

/**
 * Record why a point might be dropped from the clean output. Maintains `point.dropReason`
 * (`{ reasonKey: context }`) and `point.dropCount`; idempotent per key (re-adding a key updates its
 * context without re-counting). Any module can call it.
 */
export function addDrop(point, reasonKey, context = true) {
  if (!point.dropReason) point.dropReason = {};
  if (!(reasonKey in point.dropReason)) point.dropCount = (point.dropCount ?? 0) + 1;
  point.dropReason[reasonKey] = context;
  return point;
}

/** Attach a module's non-`drop` keys as a namespaced `point[modName] = { ...keys }` (merging). */
function attachLabels(out, modName, source, valueAt) {
  const ns = {};
  let any = false;
  for (const key in source) {
    if (key === "drop") continue;
    ns[key] = valueAt(source[key]);
    any = true;
  }
  if (any) out[modName] = { ...(out[modName] ?? {}), ...ns };
}

/**
 * Merge the label bags and the measured signals back onto every original point by index. For both
 * phases a module's `drop` becomes a drop reason under its name (via `addDrop`) and its other keys
 * attach as a namespaced label/signal. Dropped points carry position + reasons (+ labels) but no
 * signals; kept points additionally carry the measure/profile signals and compute-module output.
 */
function assemble(points, bags, valid, sig, modData) {
  const pos = new Array(points.length).fill(-1);
  valid.forEach((i, k) => {
    pos[i] = k;
  });
  return points.map((p, i) => {
    const out = { ...p, x: sig.xAll[i], y: sig.yAll[i] };
    // label phase: per-point bags — `drop` → reason; other keys → namespaced labels
    const bag = bags[i];
    let dropped = false;
    if (bag) {
      for (const modName in bag) {
        const b = bag[modName];
        if (b.drop != null) {
          addDrop(out, modName, b.drop);
          dropped = true;
        }
        attachLabels(out, modName, b, (v) => v);
      }
    }
    if (dropped) return out; // excluded from measurement: position + reasons (+ labels), no signals

    const k = pos[i];
    Object.assign(out, {
      hs: sig.hs[k],
      vs: sig.vs[k],
      straight: sig.straight[k],
      steady: sig.steady[k],
      netsp: sig.netsp[k],
      netd150: sig.netd150[k],
      wander: sig.wander[k],
      maDist: sig.maDist[k],
      carve: sig.carve[k],
      paused: sig.paused[k],
    });
    // compute phase: per-array signals — `drop` → reason; other keys → namespaced signals
    for (const modName in modData) {
      const merged = modData[modName];
      if (merged.drop?.[k]) addDrop(out, modName, merged.drop[k]);
      attachLabels(out, modName, merged, (arr) => arr[k]);
    }
    return out;
  });
}
