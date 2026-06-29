// Stabilize a GPX track: run the analysis pipeline and keep only the points it did NOT flag for a
// drop — duplicate timestamps, oversampling (so the survivors land at ~1 Hz), GPS outliers, and
// physically-implausible motion (the activity envelopes) — yielding a cleaned track. The base only
// removes noise points; an opt-in `smooth` rewrites the survivors' elevation to a slope-stable value
// (distance-domain smoothing — see ./mods/smooth.js), the first survivor-rewriting module.

import { analyze } from "./analyze.js";
import { readGpx, saveGpx } from "./gpx.js";
import * as gradeBoundMod from "./mods/gradeBound.js";
import { validateModule } from "./mods/index.js";
import * as smoothMod from "./mods/smooth.js";
import { resample } from "./resample.js";

const smoothModule = validateModule("smooth", smoothMod);
const gradeBoundModule = validateModule("gradeBound", gradeBoundMod);

/**
 * Stabilize one segment's points: analyze, drop every point that picked up a `dropReason`, and
 * reduce the survivors back to plain track points (the analysis signals are not carried into output).
 *
 * Two opt-in survivor-`ele` rewrites (the `{lat,lon,ele,time}` shape is unchanged — only the *meaning*
 * of `ele` flips):
 * - **`opts.smooth`** — distance-domain mean smoothing (`point.smooth.ele`, see ./mods/smooth.js).
 * - **`opts.gradeBound`** — a terrain-preserving grade-change-bounded despike (`point.gradeBound.ele`,
 *   see ./mods/gradeBound.js): removes physically-impossible `ele` spikes without over-flattening real
 *   terrain. The portable answer to the "stabilize is horizontal-only, ele spikes survive" gap.
 *   (Named after the module, NOT `despike`, to avoid colliding with the horizontal `despike` builtin.)
 *
 * Each is `true` for defaults or an object of param overrides (e.g. `{ SMOOTH_WIN_M: 50 }` /
 * `{ GRADE_AMAX: 2 }`). They are independent compute signals, so they don't chain in-pipeline; if both
 * are set the export prefers `gradeBound` (terrain-preserving) — true despike-then-smooth awaits the
 * proposed `finalize` phase.
 * @param {import("./gpx.js").TrackPoint[]} points
 * @param {Parameters<typeof analyze>[1] & { smooth?: boolean | Record<string, number>, gradeBound?: boolean | Record<string, number> }} [opts]
 * @returns {import("./gpx.js").TrackPoint[]}  the cleaned points
 */
export function stabilize(points, opts = {}) {
  const { smooth, gradeBound, ...rest } = opts;
  const modules = [...(rest.modules ?? [])];
  if (smooth) modules.push(smoothModule);
  if (gradeBound) modules.push(gradeBoundModule);
  const analyzeOpts =
    smooth || gradeBound
      ? {
          ...rest,
          modules,
          ...(typeof smooth === "object" ? smooth : {}),
          ...(typeof gradeBound === "object" ? gradeBound : {}),
        }
      : rest;
  return analyze(points, analyzeOpts)
    .filter((p) => !p.dropReason)
    .map((p) => ({
      lat: p.lat,
      lon: p.lon,
      // gradeBound (despike) wins over smooth when both set (terrain-preserving); else whichever; else raw
      ele: (gradeBound ? p.gradeBound?.ele : smooth ? p.smooth?.ele : null) ?? p.ele,
      time: p.time,
    }));
}

/**
 * Stabilize every segment of a parsed Track, preserving its metadata.
 *
 * With `opts.resample`, each cleaned segment is regularised onto a uniform time grid AFTER cleaning
 * + smoothing (see ./resample.js); a segment whose interior has a gap longer than `maxGap` splits
 * into several, so the Track can gain segments. `resample` is `true` for defaults, or an options
 * object (e.g. `{ RESAMPLE_HZ: 2, maxGap: 5 }`). It is handled here, not in the single-segment
 * `stabilize`, because the split is expressed as multiple `<trkseg>`s.
 * @param {import("./gpx.js").Track} track
 * @param {Parameters<typeof analyze>[1] & { smooth?, resample?: boolean | Record<string, number> }} [opts]
 * @returns {import("./gpx.js").Track}  a Track with cleaned (and optionally resampled) segments
 */
export function stabilizeTrack(track, opts = {}) {
  const { resample: resampleOpts, ...rest } = opts;
  const cleaned = (track?.segments ?? []).map((seg) => stabilize(seg, rest));
  const segments = resampleOpts
    ? cleaned.flatMap((seg) => resample(seg, typeof resampleOpts === "object" ? resampleOpts : {}))
    : cleaned;
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
