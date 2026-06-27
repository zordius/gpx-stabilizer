// Render-agnostic telemetry export: turn a GoPro video into the neutral shape a
// renderer needs — points + meta + timezone + recording UTC anchor. No renderer
// concepts leak here; the consumer maps this to its own model. See
// docs/export-contract.md.

import { stabilize } from "gpx-stabilizer";
import tzlookup from "tz-lookup";
import { extractGoproPoints, probeGoproMeta } from "./gopro.js";

function isFiniteNum(n) {
  return typeof n === "number" && Number.isFinite(n);
}

// First sample with a usable GPS lock: prefer a 3D fix, fall back to 2D, and
// require finite lat/lon. tz and the start anchor are both constant within one
// video (cross-timezone travel is out of v1 scope), so the first good fix
// suffices. Returns the point, or null if none.
function firstGoodFix(points) {
  const list = points ?? [];
  return (
    list.find((p) => p && p.fix === "3d" && isFiniteNum(p.lat) && isFiniteNum(p.lon)) ??
    list.find((p) => p && p.fix === "2d" && isFiniteNum(p.lat) && isFiniteNum(p.lon)) ??
    null
  );
}

/**
 * Raw lat/lon → IANA timezone lookup (offline, via tz-lookup).
 * @param {{ lat: number, lon: number }} coord
 * @returns {string | null}  e.g. "Asia/Tokyo"; null on non-finite or out-of-range input
 */
export function timezoneAt({ lat, lon } = {}) {
  if (!isFiniteNum(lat) || !isFiniteNum(lon)) return null;
  try {
    return tzlookup(lat, lon);
  } catch {
    return null;
  }
}

/**
 * IANA timezone for a track, from its first good-fix point.
 * @param {import("gpx-stabilizer").TrackPoint[]} points
 * @returns {string | null}  null if no good-fix point exists
 */
export function timezoneOfPoints(points) {
  const p = firstGoodFix(points);
  return p ? timezoneAt({ lat: p.lat, lon: p.lon }) : null;
}

/**
 * Recording start instant (UTC) = the UTC ms of the first good-fix sample, the
 * wall-clock anchor a renderer pins the segment to. `fix` reports that sample's
 * fix so the consumer knows the confidence.
 * @param {import("gpx-stabilizer").TrackPoint[]} points
 * @returns {{ startUtc: number | null, fix: string | null }}
 */
export function recordingStartUtc(points) {
  const p = firstGoodFix(points);
  if (!p) return { startUtc: null, fix: null };
  return { startUtc: isFiniteNum(p.time) ? p.time : null, fix: p.fix };
}

/**
 * @typedef {object} TelemetryResult
 * @property {import("./gopro.js").GoproMeta} meta   geometry / fps / durationS / hasGps
 * @property {import("gpx-stabilizer").TrackPoint[]} points  raw, or stabilized per opts
 * @property {string | null} timezone   = timezoneOfPoints(raw points)
 * @property {number | null} startUtc    = recordingStartUtc(raw points).startUtc
 */

/**
 * One-call convenience the adapter actually uses: probe + extract [+ stabilize]
 * + timezone + start anchor in a single await. Short-circuits on a video with no
 * GPS track.
 * @param {string} path
 * @param {{ rate?: number, stabilize?: boolean | Parameters<typeof stabilize>[1] }} [opts]
 *   rate in Hz (omit = native ~18 Hz); stabilize cleans the points first.
 * @returns {Promise<TelemetryResult>}
 */
export async function readGoproTelemetry(path, opts = {}) {
  const meta = await probeGoproMeta(path);
  if (!meta.hasGps) {
    return { meta, points: [], timezone: null, startUtc: null };
  }
  const raw = await extractGoproPoints(path, opts.rate != null ? { rate: opts.rate } : {});
  // tz + anchor are derived from the RAW points: stabilize() reduces a point to
  // {lat,lon,ele,time}, dropping the `fix` that good-fix selection relies on.
  const timezone = timezoneOfPoints(raw);
  const { startUtc } = recordingStartUtc(raw);
  const points = opts.stabilize
    ? stabilize(raw, opts.stabilize === true ? {} : opts.stabilize)
    : raw;
  return { meta, points, timezone, startUtc };
}
