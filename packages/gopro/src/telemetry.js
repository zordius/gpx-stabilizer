// Render-agnostic telemetry export: turn a GoPro video into the neutral shape a
// renderer needs — points + meta + timezone + recording UTC anchor. No renderer
// concepts leak here; the consumer maps this to its own model. See
// docs/export-contract.md.

import { statSync } from "node:fs";
import { stabilize } from "gpx-stabilizer";
import tzlookup from "tz-lookup";
import { extractGoproAll, probeGoproMeta } from "./gopro.js";
import { CACHE_V, readCache, resolveCachePath, writeCache } from "./gopro-cache.js";

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

// Gates for trusting the regression extrapolation.
const MIN_REG_POINTS = 5; // too few points → slope is noise
const MIN_REG_SPAN_MS = 5000; // <5 s of media offset → extrapolating to 0 is unreliable
const SLOPE_TOL = 0.05; // |slope−1| must be within this (UTC ms vs media ms ⇒ ≈1)

/**
 * True recording-start instant (UTC) by **linear regression** of each good-fix
 * sample's UTC `time` against its media offset `cts`: `time ≈ intercept +
 * slope·cts`. The recording starts at `cts = 0`, so the intercept is the
 * wall-clock instant of the first video frame — *before* GPS lock, recovering the
 * pre-lock delay that the first-good-fix anchor ignores. `slope` should be ≈ 1
 * (both axes are milliseconds); a slope far from 1 means the GPS UTC and media
 * clocks disagree, so the extrapolation is not trustworthy.
 *
 * @param {import("gpx-stabilizer").TrackPoint[]} points  raw points (need `cts` + `time` + `fix`)
 * @returns {{ startUtc: number, slope: number, n: number } | null}  null when too
 *   few points, too short a media span, or `cts` is unavailable
 */
export function regressStartUtc(points) {
  const pts = (points ?? []).filter(
    (p) => p && (p.fix === "3d" || p.fix === "2d") && isFiniteNum(p.time) && isFiniteNum(p.cts),
  );
  const n = pts.length;
  if (n < MIN_REG_POINTS) return null;
  // Centre x (cts) and y (time) before the least-squares sums: UTC ms (~1.7e12)
  // and cts ms make the raw normal equations lose precision to catastrophic
  // cancellation; centring keeps the magnitudes small and the slope/intercept
  // accurate.
  let sx = 0;
  let sy = 0;
  let minC = Number.POSITIVE_INFINITY;
  let maxC = Number.NEGATIVE_INFINITY;
  for (const p of pts) {
    sx += p.cts;
    sy += p.time;
    if (p.cts < minC) minC = p.cts;
    if (p.cts > maxC) maxC = p.cts;
  }
  if (maxC - minC < MIN_REG_SPAN_MS) return null;
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    const dx = p.cts - mx;
    sxx += dx * dx;
    sxy += dx * (p.time - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx; // UTC at cts = 0
  return { startUtc: Math.round(intercept), slope, n };
}

/**
 * Best recording-start anchor + how much to trust it. Prefers the regression
 * true-start when its slope passes the quality gate; otherwise falls back to the
 * first good fix (the pre-lock delay is then unknown and left in).
 * @param {import("gpx-stabilizer").TrackPoint[]} points  raw points
 * @returns {{ startUtc: number | null, confidence: 'gps' | null, verified: boolean, slope: number | null }}
 */
export function resolveStartUtc(points) {
  const reg = regressStartUtc(points);
  const verified = reg != null && Math.abs(reg.slope - 1) <= SLOPE_TOL;
  const startUtc = verified ? reg.startUtc : recordingStartUtc(points).startUtc;
  return {
    startUtc,
    confidence: startUtc != null ? "gps" : null,
    verified,
    slope: reg ? reg.slope : null,
  };
}

/**
 * @typedef {object} TelemetryResult
 * @property {import("./gopro.js").GoproMeta} meta   geometry / fps / durationS / hasGps
 * @property {import("gpx-stabilizer").TrackPoint[]} points  raw, or stabilized per opts
 * @property {string | null} timezone   = timezoneOfPoints(raw points)
 * @property {number | null} startUtc    best recording-start anchor: the regression
 *   true-start when verified, else the first good fix (= clock.startUtc)
 * @property {{ startUtc: number|null, confidence: 'gps'|null, verified: boolean, slope: number|null }} clock
 *   the start anchor + trust: `verified` true ⇒ regression-extrapolated true start
 *   (slope ≈ 1); false ⇒ first-good-fix fallback (pre-lock delay left in)
 */

/**
 * Cached probe + extract: a video's GoPro samples plus its metadata, as
 * `{ meta, points, fromCache }`. The expensive whole-stream extraction (and the
 * moov probe) are skipped entirely on a cache hit.
 *
 * Caching is **ON by default** — a sidecar `<file>.gpxcache.json` is written
 * next to the source, keyed by file size+mtime+rate+schema-version, so a repeat
 * read (or a killed run) returns instantly. Pass `cache: false` to disable
 * (pure, no file writes) or `cache: { dir }` to keep records in a managed
 * directory instead of beside the media.
 *
 * `points` is `[]` for a video with no GPS track (`meta.hasGps === false`). The
 * record also carries `streams` — every non-GPS GPMF channel (IMU `ACCL`/`GYRO`,
 * `SCEN`, exposure, …) as raw cts-timed samples (`{}` when no GPS track), so the
 * one extraction populates the cache for later multi-sensor work at ~0 extra IO.
 * @param {string} path
 * @param {{ rate?: number, cache?: boolean | { dir?: string | null } }} [opts]
 *   rate in Hz (omit = native ~18 Hz); cache controls the on-disk record (default on).
 * @returns {Promise<{ meta: import("./gopro.js").GoproMeta, points: import("gpx-stabilizer").TrackPoint[], streams: Record<string, import("./gopro.js").GoproStream>, fromCache: boolean }>}
 */
export async function readGoproSamples(path, opts = {}) {
  const { rate, cache } = opts;
  const groupTimes = rate ? Math.round(1000 / rate) : undefined;
  const cp = resolveCachePath(path, cache);
  const ident = { v: CACHE_V, size: 0, mtime: 0, rate: groupTimes ?? null };
  if (cp) {
    try {
      const st = statSync(path);
      ident.size = st.size;
      ident.mtime = Math.round(st.mtimeMs);
    } catch {
      // unstattable -> leave size/mtime 0 (guaranteed miss); probe surfaces the error
    }
    const hit = readCache(cp, ident);
    if (hit) {
      return {
        meta: hit.meta,
        points: hit.points ?? [],
        streams: hit.streams ?? {},
        fromCache: true,
      };
    }
  }
  const meta = await probeGoproMeta(path);
  const { points, streams } = meta.hasGps
    ? await extractGoproAll(path, groupTimes ? { groupTimes } : {})
    : { points: [], streams: {} };
  if (cp) {
    const dir = cache && typeof cache === "object" ? (cache.dir ?? null) : null;
    writeCache(cp, { ...ident, meta, points, streams }, dir);
  }
  return { meta, points, streams, fromCache: false };
}

/**
 * One-call convenience the adapter actually uses: (cached) probe + extract
 * [+ stabilize] + timezone + start anchor in a single await. Short-circuits on
 * a video with no GPS track.
 * @param {string} path
 * @param {{ rate?: number, stabilize?: boolean | Parameters<typeof stabilize>[1], cache?: boolean | { dir?: string | null } }} [opts]
 *   rate in Hz (omit = native ~18 Hz); stabilize cleans the points first; cache
 *   controls the on-disk extraction record (default on — see `readGoproSamples`).
 * @returns {Promise<TelemetryResult>}
 */
export async function readGoproTelemetry(path, opts = {}) {
  const { meta, points: raw } = await readGoproSamples(path, {
    rate: opts.rate,
    cache: opts.cache,
  });
  if (!meta.hasGps) {
    return {
      meta,
      points: [],
      timezone: null,
      startUtc: null,
      clock: { startUtc: null, confidence: null, verified: false, slope: null },
    };
  }
  // tz + anchor are derived from the RAW points: stabilize() reduces a point to
  // {lat,lon,ele,time}, dropping the `fix` + `cts` that good-fix selection and the
  // start regression rely on.
  const timezone = timezoneOfPoints(raw);
  const clock = resolveStartUtc(raw);
  const points = opts.stabilize
    ? stabilize(raw, opts.stabilize === true ? {} : opts.stabilize)
    : raw;
  return { meta, points, timezone, startUtc: clock.startUtc, clock };
}
