// Stabilize a GPX track: run the analysis pipeline and keep only the points it did NOT flag for a
// drop — duplicate timestamps, oversampling (so the survivors land at ~1 Hz), GPS outliers, and
// physically-implausible motion (the activity envelopes) — yielding a cleaned track. NOTE: this
// removes noise points; it does not yet resample/smooth the survivors (smoothing is a future step).

import { analyze } from "./analyze.js";
import { readGpx, saveGpx } from "./gpx.js";

/**
 * Stabilize one segment's points: analyze, drop every point that picked up a `dropReason`, and
 * reduce the survivors back to plain track points (the analysis signals are not carried into output).
 * @param {import("./gpx.js").TrackPoint[]} points
 * @param {Parameters<typeof analyze>[1]} [opts]  modules + activity/measurement overrides
 * @returns {import("./gpx.js").TrackPoint[]}  the cleaned points
 */
export function stabilize(points, opts = {}) {
  return analyze(points, opts)
    .filter((p) => !p.dropReason)
    .map(({ lat, lon, ele, time }) => ({ lat, lon, ele, time }));
}

/**
 * Stabilize every segment of a parsed Track, preserving its metadata.
 * @param {import("./gpx.js").Track} track
 * @param {Parameters<typeof analyze>[1]} [opts]
 * @returns {import("./gpx.js").Track}  a Track with cleaned segments
 */
export function stabilizeTrack(track, opts = {}) {
  const segments = (track?.segments ?? []).map((seg) => stabilize(seg, opts));
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
