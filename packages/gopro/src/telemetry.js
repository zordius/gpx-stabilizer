// Render-agnostic telemetry export: turn a GoPro video into the neutral shape a
// renderer needs — points + meta + timezone + recording UTC anchor. No renderer
// concepts leak here; the consumer maps this to its own model. See
// docs/export-contract.md.

import { statSync } from "node:fs";
import { loadModule, resample, stabilize } from "gpx-stabilizer";
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
const MIN_PAIR_SPAN_MS = 1000; // Theil-Sen: skip near-duplicate-cts pairs (unstable slope, tiny denominator)
const SYNC_RESIDUAL_TOL_MS = 2000; // after the robust fit, >2s off the line predates real time sync
const REFERENCE_WINDOW_MS = 30 * 24 * 3600 * 1000; // 30 days either side of `referenceUtc`

/**
 * Robust slope estimate: the MEDIAN of pairwise slopes over a grid-sampled subset
 * (Theil-Sen) — unlike OLS, a minority of wildly-off points can't drag the median,
 * because their slopes land at the extremes of the sorted list, not the middle.
 * O(gridN²) pairs; gridN caps at 200 so even a few thousand points stay cheap.
 * Returns null if every sampled pair fails the `MIN_PAIR_SPAN_MS` separation.
 */
function theilSenSlope(pts) {
  const n = pts.length;
  const gridN = Math.min(n, 200);
  const step = Math.max(1, Math.floor(n / gridN));
  const idxs = [];
  for (let i = 0; i < n; i += step) idxs.push(i);
  const slopes = [];
  for (let i = 0; i < idxs.length; i++) {
    for (let j = i + 1; j < idxs.length; j++) {
      const a = pts[idxs[i]];
      const b = pts[idxs[j]];
      const dx = b.cts - a.cts;
      if (Math.abs(dx) < MIN_PAIR_SPAN_MS) continue;
      slopes.push((b.time - a.time) / dx);
    }
  }
  if (!slopes.length) return null;
  slopes.sort((x, y) => x - y);
  return slopes[Math.floor(slopes.length / 2)];
}

/**
 * True recording-start instant (UTC) by **linear regression** of each sample's
 * UTC `time` against its media offset `cts`: `time ≈ intercept + slope·cts`. The
 * recording starts at `cts = 0`, so the intercept is the wall-clock instant of
 * the first video frame — *before* GPS lock, recovering the pre-lock delay that
 * the first-good-fix anchor ignores. `slope` should be ≈ 1 (both axes are
 * milliseconds); a slope far from 1 means the GPS UTC and media clocks disagree,
 * so the extrapolation is not trustworthy.
 *
 * Deliberately **not** gated on `fix` or position (unlike {@link firstGoodFix}):
 * some chips (observed on a HERO10) sync UTC `time` well before — or entirely
 * independently of — ever reporting a `2d`/`3d` fix, so a `time`+`cts` pair can
 * already be trustworthy while `fix` stays `"none"` and `lat`/`lon` stay stuck at
 * this format's (0,0) "no sample yet" sentinel for the WHOLE clip (a real
 * HERO10 track: 5448 samples, zero ever left (0,0), yet the back four-fifths sync
 * to a slope-1 line). Position and time sync are independent signals — gating the
 * regression on either misses a valid clock.
 *
 * What position-based gating used to catch, this catches differently: a chip
 * commonly emits a PRE-SYNC run of samples (a firmware boot-time constant,
 * unrelated to `cts`) before its real UTC sync kicks in — sometimes as most of
 * the clip, not a minority (observed: an 80/20 split, junk majority). Junk of
 * this shape isn't just scattered noise, either: it's often internally
 * consistent (its OWN slope is also ≈1, e.g. a free-running RTC that just never
 * got corrected) with the WRONG intercept, so a slope check alone can't tell the
 * two clusters apart — whichever has more points wins a plain majority vote,
 * right or wrong. `referenceUtc` (the file's own mtime, or any other rough
 * "roughly when this was recorded" anchor — accurate to a day is plenty) breaks
 * the tie: real satellite time and a firmware boot constant are NEVER
 * confusable at that resolution (a boot constant sits years off), so points
 * more than `REFERENCE_WINDOW_MS` from it are dropped before anything else runs,
 * regardless of which cluster is bigger. Without a `referenceUtc`, this can only
 * fall back to catching a scattered-noise minority via {@link theilSenSlope}'s
 * pairwise-slope median (immune to a minority, not a majority) — pass one
 * whenever it's available.
 *
 * @param {import("gpx-stabilizer").TrackPoint[]} points  raw points (need `cts` + `time`)
 * @param {{ referenceUtc?: number }} [opts]  `referenceUtc`: epoch ms roughly near
 *   the true recording time (e.g. file mtime) — disambiguates a majority-junk
 *   cluster from the real one; omit only when no such anchor exists at all.
 * @returns {{ startUtc: number, slope: number, n: number } | null}  null when too
 *   few points, too short a media span, or `cts` is unavailable
 */
export function regressStartUtc(points, { referenceUtc } = {}) {
  let pts = (points ?? []).filter((p) => p && isFiniteNum(p.time) && isFiniteNum(p.cts));
  if (isFiniteNum(referenceUtc)) {
    pts = pts.filter((p) => Math.abs(p.time - referenceUtc) <= REFERENCE_WINDOW_MS);
  }
  if (pts.length < MIN_REG_POINTS) return null;

  const robustSlope = theilSenSlope(pts);
  if (robustSlope == null) return null;
  const intercepts = pts.map((p) => p.time - robustSlope * p.cts).sort((a, b) => a - b);
  const robustIntercept = intercepts[Math.floor(intercepts.length / 2)];
  const survivors = pts.filter(
    (p) => Math.abs(p.time - (robustIntercept + robustSlope * p.cts)) < SYNC_RESIDUAL_TOL_MS,
  );

  const n = survivors.length;
  if (n < MIN_REG_POINTS) return null;
  // Centre x (cts) and y (time) before the least-squares sums: UTC ms (~1.7e12)
  // and cts ms make the raw normal equations lose precision to catastrophic
  // cancellation; centring keeps the magnitudes small and the slope/intercept
  // accurate.
  let sx = 0;
  let sy = 0;
  let minC = Number.POSITIVE_INFINITY;
  let maxC = Number.NEGATIVE_INFINITY;
  for (const p of survivors) {
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
  for (const p of survivors) {
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
 * @param {{ referenceUtc?: number }} [opts]  forwarded to {@link regressStartUtc}
 * @returns {{ startUtc: number | null, confidence: 'gps' | null, verified: boolean, slope: number | null }}
 */
export function resolveStartUtc(points, opts) {
  const reg = regressStartUtc(points, opts);
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
 * @property {import("gpx-stabilizer").TrackPoint[]} points  raw, or stabilized per opts;
 *   with `resample`, the flat concatenation of `segments` (back-compat single array)
 * @property {import("gpx-stabilizer").TrackPoint[][]} segments  one entry per `<trkseg>`:
 *   `[points]` normally, but `resample` splits at gaps > maxGap into several (always present)
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
 * @param {{ rate?: number, stabilize?: boolean | Parameters<typeof stabilize>[1],
 *   resample?: boolean | "fps" | { RESAMPLE_HZ?: number | "fps", maxGap?: number },
 *   cache?: boolean | { dir?: string | null } }} [opts]
 *   `rate` in Hz (omit = native ~18 Hz); `stabilize` cleans the points first; `resample`
 *   regularises the cleaned points onto a uniform time grid (see {@link resample}) — it
 *   **implies** `stabilize` (resampling raw, uncleaned points is meaningless), and
 *   `RESAMPLE_HZ: "fps"` (or `resample: "fps"`) uses the video frame rate (`meta.fps`) so
 *   there is one point per frame; `cache` controls the on-disk extraction record. When cleaning
 *   runs on a HERO10 file, core's `gpsQuality` module is applied automatically (gated on
 *   `meta.model` — see the module's doc for why it's model-specific, not a general default).
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
      segments: [],
      timezone: null,
      startUtc: null,
      clock: { startUtc: null, confidence: null, verified: false, slope: null },
    };
  }
  // tz + anchor are derived from the RAW points: stabilize() reduces a point to
  // {lat,lon,ele,time}, dropping the `fix` + `cts` that good-fix selection and the
  // start regression rely on.
  const timezone = timezoneOfPoints(raw);
  // regressStartUtc's disambiguating reference (its own doc): prefer the camera's
  // own container creation time (meta.createdUtc, moov mvhd — set once at record
  // time) over file mtime, which drifts whenever the file is later copied/moved
  // (observed: over a MONTH off on a real clip, well past a plausible window) —
  // mtime is only a fallback for the rare file whose moov didn't yield one.
  let referenceUtc = meta.createdUtc;
  if (referenceUtc == null) {
    try {
      referenceUtc = statSync(path).mtimeMs;
    } catch {
      /* no reference at all — regressStartUtc falls back to unanchored (minority-only) robustness */
    }
  }
  const clock = resolveStartUtc(raw, { referenceUtc });

  // resample runs on cleaned survivors, so it IMPLIES stabilize; an explicit
  // `stabilize: false` alongside `resample` is contradictory.
  if (opts.resample && opts.stabilize === false) {
    throw new Error("readGoproTelemetry: `resample` requires cleaning — drop `stabilize: false`");
  }
  // Hero10's GPS chip needs its own quality gate (core's `gpsQuality` module — see its doc): its
  // hdop baseline runs 5-10x higher than a Hero5's on the same trip, so the threshold is calibrated
  // to that one chip generation and must not silently apply to every model. `gpsQuality` is opt-in
  // (not a core builtin) specifically so this decision lives here, where `meta.model` is known.
  const gxModules = meta.model === "HERO10" ? [await loadModule("gpsQuality")] : [];
  const stabilizeOpts = opts.stabilize && opts.stabilize !== true ? opts.stabilize : {};
  const cleaned =
    opts.stabilize || opts.resample
      ? stabilize(raw, {
          ...stabilizeOpts,
          modules: [...(stabilizeOpts.modules ?? []), ...gxModules],
        })
      : raw;

  let points = cleaned;
  let segments = cleaned.length ? [cleaned] : [];
  if (opts.resample) {
    const ro = typeof opts.resample === "object" ? { ...opts.resample } : {};
    // "fps" (shorthand `resample: "fps"` or `RESAMPLE_HZ: "fps"`) → one point per video frame
    if (opts.resample === "fps" || ro.RESAMPLE_HZ === "fps") {
      if (!meta.fps)
        throw new Error("readGoproTelemetry: resample 'fps' but meta.fps is unavailable");
      ro.RESAMPLE_HZ = meta.fps;
    }
    segments = resample(cleaned, ro);
    points = segments.flat();
  }
  return { meta, points, segments, timezone, startUtc: clock.startUtc, clock };
}
