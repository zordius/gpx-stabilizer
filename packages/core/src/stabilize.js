// Stabilize a GPX track: run the analysis pipeline and keep only the points it did NOT flag for a
// drop — duplicate timestamps, oversampling (so the survivors land at ~1 Hz), GPS outliers, and
// physically-implausible motion (the activity envelopes) — yielding a cleaned track. The base only
// removes noise points; an opt-in `gradeBound` rewrites the survivors' elevation to a slope-stable
// value (grade-change-bounded despike, optionally followed by distance-domain smoothing — see
// ./mods/gradeBound.js), the first survivor-rewriting module.

import { analyze } from "./analyze.js";
import { readGpx, saveGpx } from "./gpx.js";
import { resolveMode } from "./modes.js";
import * as gradeBoundMod from "./mods/gradeBound.js";
import { validateModule } from "./mods/index.js";
import { resample } from "./resample.js";

const gradeBoundModule = validateModule("gradeBound", gradeBoundMod);

/**
 * Stabilize one segment's points: analyze, drop every point that picked up a `dropReason`, and
 * reduce the survivors back to plain track points (the analysis signals are not carried into output).
 *
 * One opt-in survivor-`ele` rewrite (the `{lat,lon,ele,time}` shape is unchanged — only the *meaning*
 * of `ele` flips): **`opts.gradeBound`** — a terrain-preserving grade-change-bounded despike
 * (`point.gradeBound.ele`, see ./mods/gradeBound.js): removes physically-impossible `ele` spikes
 * without over-flattening real terrain, optionally followed by a distance-domain smoothing pass over
 * its own output (`g.GRADE_SMOOTH_WIN_M`, off by default — folded in from a former separate `smooth`
 * module, 2026-07-10, so a caller wanting both gets one coherent despike-then-smooth rewrite instead
 * of two independent ones competing for the same field; `MODES.ski` sets it). `true` for defaults, or
 * an object of param overrides (e.g. `{ GRADE_AMAX: 2, GRADE_SMOOTH_WIN_M: 30 }`). (Named after the
 * module, NOT `despike`, to avoid colliding with the horizontal `despike` builtin.)
 *
 * A second, three-axis rewrite: **`opts.liftSnap`** — a plain boolean (the module it reads,
 * `mods/liftSnap.js`, is parameter-free; the caller tunes its upstream module, `liftConfirm`, via the
 * normal `g.LIFT_*` params, unrelated to this export switch). Reads `point.liftSnap` (`{ lat, lon,
 * ele? }`, only present on points inside a run `liftConfirm` actually confirmed as a real lift —
 * see that module's doc) and, when present, overrides `lat`/`lon` unconditionally and `ele` ahead of
 * `gradeBound` (liftSnap only ever sets `ele` for the handful of points it reinterprets as a
 * pause; everywhere else it's absent, so the existing `gradeBound`/raw chain is untouched).
 * Unlike `gradeBound`, this does NOT auto-load its module — `liftConfirm`/`liftSnap` are
 * loaded via `opts.modules` (ski mode bundles both, see `modes.js`), so the export switch and the
 * module that feeds it stay decoupled; passing `liftSnap: true` without loading the modules is a
 * harmless no-op (no `point.liftSnap` ever appears, so every `??` falls through to the raw value).
 *
 * A third, general-purpose (not ski-gated) rewrite: **`opts.tangleSnap`** — same plain-boolean,
 * decoupled-loading convention as `liftSnap` (module: `mods/tangleSnap.js`). Reads `point.tangleSnap`
 * (`{ lat, lon }`, only present on points inside a very-low-speed run that module thinned and
 * reinflated) and, when present, overrides `lat`/`lon` ahead of `liftSnap` — it already reads
 * `liftSnap`'s own position as its input where available, so its output is the more-refined answer.
 * Does not touch `ele`.
 *
 * A fourth, ski-specific `ele` rewrite: **`opts.liftBoardingEle`** — same decoupled-loading
 * convention (module: `mods/liftBoardingEle.js`). Reads `point.liftBoardingEle` (`{ ele }`, only
 * present on the handful of points inside a lift-boarding/unloading elevation artifact it deals
 * with — see that module's doc) and, when present, wins outright ahead of `liftSnap`'s own `ele`
 * (the two almost never overlap in practice, but this one is the more targeted, validated fix when
 * they do) — INCLUDING when its own `ele` is `null`: the module can determine a stretch is
 * unrecoverable (no way to back out the true elevation) without being able to supply a replacement,
 * and that verdict must stand as the final answer (drop the elevation) rather than fall through to
 * `liftSnap`/raw the way an *absent* `point.liftBoardingEle` does. Presence of the field, not
 * truthiness of its `ele`, is what wins.
 *
 * **`opts.mode`** (e.g. `"ski"`) expands to a preset's params + modules via `resolveMode`
 * (./modes.js) BEFORE any of the above is read — so `MODES.ski`'s own `liftSnap`/`tangleSnap`/
 * `gradeBound`/`liftBoardingEle: true` and its `enable` modules are already in effect by the time
 * this function's own destructuring runs. An explicit field on `opts` still wins over the preset
 * (same precedence the CLI's `--mode` + `--config` already had).
 * @param {import("./gpx.js").TrackPoint[]} points
 * @param {Parameters<typeof analyze>[1] & { mode?: string, gradeBound?: boolean | Record<string, number>, liftSnap?: boolean, tangleSnap?: boolean, liftBoardingEle?: boolean }} [opts]
 * @returns {import("./gpx.js").TrackPoint[]}  the cleaned points
 */
export function stabilize(points, opts = {}) {
  const { gradeBound, liftSnap, tangleSnap, liftBoardingEle, ...rest } = resolveMode(opts);
  const modules = [...(rest.modules ?? [])];
  if (gradeBound) modules.push(gradeBoundModule);
  const analyzeOpts = gradeBound
    ? { ...rest, modules, ...(typeof gradeBound === "object" ? gradeBound : {}) }
    : rest;
  return analyze(points, analyzeOpts)
    .filter((p) => !p.dropReason)
    .map((p) => ({
      // passed through untouched when the caller tagged its own input points with it (stabilizeTrack
      // uses this to re-split the cleaned stream at the ORIGINAL <trkseg> boundaries after analyzing
      // the whole track as one continuous stream — see that function's doc); absent for any other
      // caller, so this is a no-op addition to the existing shape.
      ...(p.origSeg != null ? { origSeg: p.origSeg } : {}),
      lat: (tangleSnap ? p.tangleSnap?.lat : null) ?? (liftSnap ? p.liftSnap?.lat : null) ?? p.lat,
      lon: (tangleSnap ? p.tangleSnap?.lon : null) ?? (liftSnap ? p.liftSnap?.lon : null) ?? p.lon,
      // liftBoardingEle (the lift-boarding fix) wins when present — its OWN `ele` is the final
      // answer even when `null` (a deliberate "drop, unrecoverable" verdict, not "no opinion"), so
      // this does NOT chain through `??` like the others below it. Then liftSnap (a confirmed-lift
      // pause reposition), then gradeBound (despike, optionally chained into a smoothing pass — see
      // that module's doc), else raw.
      ele:
        liftBoardingEle && p.liftBoardingEle
          ? p.liftBoardingEle.ele
          : (liftSnap ? p.liftSnap?.ele : null) ?? (gradeBound ? p.gradeBound?.ele : null) ?? p.ele,
      time: p.time,
    }));
}

/**
 * Stabilize every segment of a parsed Track, preserving its metadata.
 *
 * Analyzes the WHOLE track as one continuous stream (2026-07-09), not segment-by-segment: a
 * `<trkseg>` boundary in the source is often just a recording-tool artifact (e.g. GoPro starts a new
 * segment across a brief GPS dropout or a clip switch, not necessarily anything physically
 * discontinuous) — analyzing each segment in isolation would cut that artificial boundary right
 * through a real lift ride or ski run that happens to straddle it, the same kind of needless
 * fragmentation `mods/segment.js`'s own lift-sandwich merge exists to undo one level up. Merging
 * first lets every module (segment/liftConfirm/windowed hs, …) see the true, uninterrupted motion.
 *
 * The ORIGINAL segment boundaries still matter for OUTPUT, though: unlike a same-segment gap (which
 * `opts.resample`'s own `maxGap` already splits on, see below), a genuine boundary BETWEEN two
 * source `<trkseg>`s means the recording itself stopped and restarted — collapsing that into one
 * output segment would silently claim continuous coverage across a real gap. So every point is
 * tagged (`point.origSeg`, a plain integer index into the source `Track.segments`) before flattening
 * — `stabilize()` passes this field through untouched (see its own doc) purely because it rides on
 * the point object through every stage's spread-copy, so it survives all the way to the cleaned
 * output despite drops/repairs/re-timing along the way, unlike keying by `time` (which a repair
 * module, e.g. dequantizeTime, can rewrite). The cleaned stream is then re-split at every point where
 * that tag changes, before any `resample`-driven splitting runs, and the tag is stripped again since
 * it's bookkeeping internal to this function, not part of the public point shape.
 *
 * With `opts.resample`, each resulting segment is further regularised onto a uniform time grid AFTER
 * cleaning + smoothing (see ./resample.js); a segment whose interior has a gap longer than `maxGap`
 * splits again, so the Track can gain even more segments. `resample` is `true` for defaults, or an
 * options object (e.g. `{ RESAMPLE_HZ: 2, maxGap: 5 }`).
 * @param {import("./gpx.js").Track} track
 * @param {Parameters<typeof analyze>[1] & { resample?: boolean | Record<string, number> }} [opts]
 * @returns {import("./gpx.js").Track}  a Track with cleaned (and optionally resampled) segments
 */
export function stabilizeTrack(track, opts = {}) {
  const { resample: resampleOpts, ...rest } = opts;
  const rawSegments = track?.segments ?? [];

  const flat = [];
  rawSegments.forEach((seg, i) => {
    for (const p of seg) flat.push({ ...p, origSeg: i });
  });

  const cleanedFlat = stabilize(flat, rest);

  // re-split at every ORIGINAL <trkseg> boundary (see doc above) -- independent of any dropReason or
  // resample gap, since a boundary here means the source recording itself stopped and restarted
  const bySourceBoundary = [];
  let cur = [];
  let curSeg = null;
  for (const { origSeg, ...p } of cleanedFlat) {
    if (cur.length && curSeg !== origSeg) {
      bySourceBoundary.push(cur);
      cur = [];
    }
    curSeg = origSeg;
    cur.push(p); // origSeg stripped -- internal bookkeeping, not part of the public point shape
  }
  if (cur.length) bySourceBoundary.push(cur);

  const segments = resampleOpts
    ? bySourceBoundary.flatMap((seg) => resample(seg, typeof resampleOpts === "object" ? resampleOpts : {}))
    : bySourceBoundary;
  return { segments, meta: track?.meta ?? {} };
}

/**
 * Read a GPX file, stabilize every segment, and write the cleaned track to `output`.
 * @param {string} input   source GPX path
 * @param {string} output  destination GPX path
 * @param {Parameters<typeof analyze>[1]} [opts]
 * @returns {import("./gpx.js").Track}  the cleaned track that was written
 */
export function stabilizeGpx(input, output, opts = {}) {
  const clean = stabilizeTrack(readGpx(input), opts);
  saveGpx(clean, output);
  return clean;
}
