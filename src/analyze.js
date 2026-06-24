// Analyze a track: screen raw points (drop bad ones), measure the survivors, run compute modules,
// and assemble everything back onto the original points. This is the orchestration/policy layer on
// top of the pure measurement engine (./measure.js) and the pluggable modules (./mods).
//
// There is no status field: a point belongs in the clean track iff it has NO `dropReason`. Drops
// are recorded as `dropReason = { reasonKey: context }` + `dropCount` (via `addDrop`), contributed
// by modules in two phases — a module joins a phase by exposing that phase's callback:
//   - `screen(point, lastKept)`: run on raw points before measurement (noTime, sameTime,
//     oversample). A point it drops is excluded from the projection centre and the time series, so
//     it carries only `x, y` and its drop reasons — no signals.
//   - `compute(ctx)`: run on the per-point context after the blocks (outlier). These flag points
//     that DO carry signals; non-`drop` keys attach as `point[name][key]`.
// Built-in modules (./mods) always run; caller modules are appended via `opts.modules`.

import { measure } from "./measure.js";
import { builtins } from "./mods/index.js";

/**
 * @param {import("./measure.js").TrackPoint[]} points  one track's points, in time order
 * @param {{ modules?: import("./mods/index.js").Module[] } & Record<string, number>} [opts]
 *   `modules` plus any measurement param overrides (see PARAMS in ./measure.js).
 * @returns {Array<object>} every original point, enriched (kept) or position-only (dropped)
 */
export function analyze(points, opts = {}) {
  const { modules = [], ...paramOpts } = opts;
  if (points.length === 0) return [];

  const all = [...builtins, ...modules];
  const preDrops = screen(
    points,
    all.filter((m) => m.screen),
  );
  const valid = keptIndices(preDrops);
  const m = measure(points, valid, paramOpts); // the per-point context (doubles as the signal bundle)

  const modData = {};
  for (const mod of all.filter((mm) => mm.compute)) modData[mod.name] = mod.compute(m);

  return assemble(points, preDrops, valid, m, modData);
}

/**
 * Run the screen modules over the raw points in one sweep with a shared "last kept" reference.
 * Returns, per point, `null` if it survives (enters the time series) or a `{ name: context }`
 * object of the screen-phase drop reasons it accumulated.
 */
export function screen(points, modules) {
  const preDrops = new Array(points.length).fill(null);
  let lastKept = null; // the last point that survived every screen module — the running reference
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    let reasons = null;
    for (const m of modules) {
      const ctx = m.screen(p, lastKept);
      if (ctx != null) {
        if (!reasons) reasons = {};
        reasons[m.name] = ctx;
      }
    }
    preDrops[i] = reasons;
    if (!reasons) lastKept = p;
  }
  return preDrops;
}

/** Original indices of the kept points (survived screening → the time-series sub-sequence). */
function keptIndices(preDrops) {
  const valid = [];
  for (let i = 0; i < preDrops.length; i++) if (preDrops[i] == null) valid.push(i);
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

/**
 * Merge the measured sub-sequence signals back onto every original point by index. Each module's
 * non-`drop` keys attach as a namespaced `point[modName] = { ...keys }`; a module's `drop` array
 * (null | context per point) is applied as a drop reason under the module's name (via `addDrop`).
 */
function assemble(points, preDrops, valid, sig, modData) {
  const pos = new Array(points.length).fill(-1);
  valid.forEach((i, k) => {
    pos[i] = k;
  });
  return points.map((p, i) => {
    const out = { ...p, x: sig.xAll[i], y: sig.yAll[i] };
    if (preDrops[i]) {
      // dropped in the screen phase: position + drop reasons only, no signals
      for (const key in preDrops[i]) addDrop(out, key, preDrops[i][key]);
      return out;
    }
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
    for (const modName in modData) {
      const merged = modData[modName];
      const ns = {};
      let hasSignal = false;
      for (const key in merged) {
        if (key === "drop") {
          if (merged.drop[k]) addDrop(out, modName, merged.drop[k]);
        } else {
          ns[key] = merged[key][k];
          hasSignal = true;
        }
      }
      if (hasSignal) out[modName] = ns;
    }
    return out;
  });
}
