# Export contract — telemetry for renderers (e.g. movie-layers `provider-gopro`)

Goal: give a renderer everything it needs from a GoPro video through a small,
**render-agnostic** API — telemetry samples, video metadata, the recording's UTC
anchor, and the timezone. No renderer concepts ("channel" / "frame" / "layer")
leak in here; the consumer (e.g. movie-layers' `provider-gopro` adapter) maps
this neutral shape to its own model.

Keep the repo's ethos: ESM, minimal deps, UTC/SI units, points kept raw (the
consumer decides what to drop).

---

## Types (already exist)

```js
// src/gpx.js
TrackPoint = {
  lat, lon,                 // degrees
  ele,                      // metres MSL, or null
  time,                     // epoch ms, UTC (GPS-derived), or null
  speed,                    // m/s, or null
  fix,                      // "none" | "2d" | "3d" | null
  hdop,                     // horizontal DOP, or null
  cts,                      // media offset (ms from stream start), or null — for start regression
}

// src/gopro.js
GoproMeta = { hasGps, gpmdSamples, width, height, codec, fps, durationS,
              model, firmware, serial, mediaId, highlights }
//   model/firmware from the MP4 udta FIRM atom (e.g. "HERO5" / "HD5.02.02.60.00"), or null.
//   serial = body serial (udta CAME, hex) — tells two same-model bodies apart;
//   mediaId = udta GUMI (hex); shared per recording on some bodies but PER-CHAPTER on
//     others (Hero10) — so it is NOT the session-split key (that's the filename file-number);
//   highlights = user tag-button times (udta HMMT, ms array). All null/[] when absent.
```

---

## Exports (all from the `gpx-from-gopro` package entry — `packages/gopro/src/index.js`)

> Post monorepo split: the GoPro/telemetry surface ships in the **`gpx-from-gopro`**
> package, not core `gpx-stabilizer`. Consumers `import { readGoproTelemetry, … }
> from "gpx-from-gopro"`. `stabilize` is re-exported there from the core package
> for convenience.

### A. Surface the existing GoPro functions (they live in `packages/gopro/src/gopro.js`)

```js
probeGoproMeta(path)                      // → Promise<GoproMeta>   (cheap moov-only probe; incl. model/firmware)
extractGoproPoints(path, { rate? })       // → Promise<TrackPoint[]> (native ~18 Hz; rate in Hz to downsample)
extractGoproAll(path, { rate? })          // → Promise<{ points, streams }>  (GPS + every non-GPS stream)
stabilize(points, opts?)                  // → TrackPoint[]          (already exported)
```

- `extractGoproPoints` today takes `{ groupTimes }` (ms). **Rename/accept `rate`
  (Hz)** in the public contract — map `rate → groupTimes = 1000 / rate`; omit
  `rate` for native ~18 Hz. (Keep `groupTimes` internally if you like.)

### B. New — timezone (GPS → tz)

```js
timezoneAt({ lat, lon })       // → IANA string | null   e.g. "Asia/Tokyo"   (raw lookup)
timezoneOfPoints(points)       // → IANA string | null   (uses the first good-fix point)
```

- Needs an **offline** lat/lon→IANA lookup. `tz-lookup` (tiny, offline, zero-dep
  flavour) fits the minimal-deps ethos; `geo-tz` is heavier but boundary-accurate.
- "good-fix point" = first sample with `fix === "3d"` (fallback `"2d"`) and finite
  lat/lon. Returns `null` if none.
- Rationale for "first good fix, not every point": tz is constant within one video
  (cross-timezone travel is out of scope for v1).

### C. New — recording start anchor (UTC)

```js
recordingStartUtc(points)      // → { startUtc: number | null, fix: string | null }
regressStartUtc(points)        // → { startUtc, slope, n } | null   (regression true-start)
resolveStartUtc(points)        // → { startUtc, confidence, verified, slope }   (best of the two)
```

- `recordingStartUtc` = the **UTC ms of the first good-fix sample**. Simple, but it
  ignores the **pre-lock delay** — the camera records before GPS locks, so the first
  fix is some seconds into the video, not its start.
- `regressStartUtc` recovers the **true start**: least-squares fit of good-fix `time`
  (UTC ms) against `cts` (media offset ms) → `time ≈ intercept + slope·cts`; the
  intercept is the UTC at `cts = 0` (the first video frame). `slope` should be ≈ 1
  (both axes ms). Returns `null` when there are too few points (<5), too short a
  media span (<5 s), or `cts` is unavailable.
- `resolveStartUtc` picks the **best**: the regression true-start when its slope
  passes the gate (`|slope − 1| ≤ 0.05`, i.e. `verified: true`), else the
  first-good-fix fallback (`verified: false`, pre-lock delay left in). This is what
  `readGoproTelemetry.clock` carries.

### D. New — one-call convenience (what the adapter actually calls)

```js
readGoproTelemetry(path, {
  rate?,                       // Hz; omit = native ~18 Hz
  stabilize?,                  // boolean | StabilizeOptions — clean the points first
                               //   StabilizeOptions.gradeBound / mode:"ski" → slope-stable elevation
                               //   (see below; `smooth: true` is gone as of 2026-07-10)
  resample?,                   // boolean | 'fps' | { RESAMPLE_HZ?: number|'fps', maxGap?: number }
                               //   uniform time grid; IMPLIES stabilize; 'fps' = one point per video frame
  cache?,                      // on by default — see section E
}) // → Promise<TelemetryResult>

TelemetryResult = {
  meta,                        // GoproMeta (geometry / fps / durationS / hasGps)
  points,                      // TrackPoint[]  (raw, or stabilized; with resample = flat concat of segments)
  segments,                    // TrackPoint[][]  one per <trkseg> — [points] normally; resample splits at gaps
  timezone,                    // from the RAW points (see note)    (string | null)
  startUtc,                    // best start anchor (= clock.startUtc) (number | null)
  clock,                       // { startUtc, confidence:'gps'|null, verified, slope } — see C
}
```

- Bundles `probeGoproMeta` + `extractGoproPoints` [+ `stabilize`] + `timezoneOfPoints`
  + `resolveStartUtc` in one await. Short-circuit on `!meta.hasGps` (return
  `points: []`, `timezone: null`, `startUtc: null`, `clock` all-null).
- **`startUtc` = `clock.startUtc`** — the regression true-start when `clock.verified`,
  else the first-good-fix fallback. The renderer anchors the segment to `startUtc`;
  `clock.verified` tells it whether the pre-lock delay was corrected.
- **`timezone` / `startUtc` are derived from the RAW (pre-stabilize) points**, not
  from the returned `points`. That's deliberate: `stabilize` reduces each point to
  `{lat, lon, ele, time}` (below), dropping the `fix` that good-fix selection needs —
  so computing them post-stabilize would break tz/anchor. The guarantees hold either
  way.
- **Stabilize drops per-sample fields.** With a truthy `stabilize`, the returned
  `points` keep only `{lat, lon, ele, time}` — `fix`, `speed`, and `hdop` are **not**
  carried through (that's `stabilize`'s output shape; it's a general-purpose core
  function, intentionally minimal). A consumer that needs per-sample `speed`/`fix`/
  `hdop` should pass `stabilize: false` and clean downstream, or read them off the raw
  points. (Decision 2026-06-27: keep `stabilize` minimal rather than widen core; revisit
  if a consumer genuinely needs cleaned points *with* those fields.)
  - **RESOLVED (2026-06-29):** decided **not** to carry `speed` — the consumer derives it.
    At the movie-layers acceptance, `provider-gopro`'s GPS-derived speed fallback fired under
    `stabilize:{smooth:true}` (its `speed` channel read 0–34.1 km/h vs the device's 0.3–35.2),
    so the gauge still renders. `stabilize` stays minimal (`{lat,lon,ele,time}`); a consumer
    needing per-sample speed derives it or reads the raw points. See [`SPEC.md`](../SPEC.md)
    ("Related finding — stabilize drops speed").
- **Elevation smoothing — NEW 2026-06-29; option renamed 2026-07-10.** Smooths each
  survivor's `ele` over an along-track distance window (default ±30 m), so a gradient
  derived as `Δele / distance` has **bounded jitter** (the raw GPS `ele` is the noisiest
  axis; on a ski clip raw grade swings −33…+25 % at high jitter, smoothed ≈ ±11 % at ⅓
  the jitter). The `{lat,lon,ele,time}` shape is unchanged — only the *meaning* of `ele`
  flips to the smoothed value; deriving the gradient number from it is still the renderer's
  job. **The `smooth: true` spelling is GONE (2026-07-10, now a silent no-op)** — the pass
  was folded into core's `gradeBound` module: pass
  `stabilize: { gradeBound: { GRADE_SMOOTH_WIN_M: 30 } }` (despike + smoothing), or
  `stabilize: { mode: "ski" }` which bundles it. See [`SPEC.md`](../SPEC.md) "Track smoothing".
- **Resampling (`resample`) — NEW 2026-06-29.** Regularises the cleaned points onto a
  **uniform time grid** (`RESAMPLE_HZ`, default 1 Hz; `'fps'` ⇒ `meta.fps`, one point per
  video frame). It **implies `stabilize`** (resampling raw, uncleaned points is meaningless;
  `stabilize: false` + `resample` throws). A time gap longer than `maxGap` (default 10 s) is
  **not bridged** — the output splits into separate `segments` there, so a stop / GPS dropout
  / GoPro crash break becomes a real `<trkseg>` break instead of an invented straight line.
  Read **`segments`** for the split; `points` stays the flat concatenation for back-compat.
  Position/ele/speed are linearly interpolated; with the `gradeBound` smoothing also on, the grid
  carries the smoothed elevation. See [`SPEC.md`](../SPEC.md) "Track resampling".
- **`segments` is always present** (NEW 2026-06-29): `[points]` when not resampling, the
  split list when resampling. A renderer that must not bridge holes should iterate `segments`
  rather than `points`.

### E. Caching (opt-in, **on by default**)

The expensive step is `extractGoproPoints` — it streams the whole MP4. To make
repeat reads (re-render, preview, a killed batch) cheap, probe+extract is cached
per file.

```js
readGoproSamples(path, {
  rate?,                       // Hz; omit = native ~18 Hz (downsamples GPS points only)
  cache?,                      // true (default) | false | { dir }
}) // → Promise<{ meta, points, streams, fromCache }>   points: [] / streams: {} when no GPS track
```

- `readGoproSamples` is the cached probe+extract that backs `readGoproTelemetry`.
  Both take the same `cache` option; the derivations (timezone, start anchor,
  stabilize) are cheap pure functions over the cached raw points and are **not**
  themselves cached.
- **`streams`** = every non-GPS GPMF channel (IMU `ACCL`/`GYRO`, `SCEN`, exposure, …)
  as `{ name, units, samples: [{ cts, value }] }`, kept at native rate — for
  multi-sensor work (see [`gpmf-sensors.md`](gpmf-sensors.md)). Extracting them costs
  ~0 extra IO (one shared `gpmd` track; the stream filter is post-parse), so the cache
  now carries the full telemetry, not just GPS points. `rate` downsamples only `points`.
- **Default = on, sidecar.** With no `cache` (or `cache: true`) a record is
  written next to the source as `<file>.gpxcache.json`. Pass **`cache: false`**
  for a pure, side-effect-free read (no file writes), or **`cache: { dir }`** to
  keep records in a managed directory (hashed names) instead of polluting the
  media tree — the saner choice for an embedding app.
- **Key** = file `size` + `mtime` + `rate` + schema `version` (`CACHE_V`). Any
  change misses and re-extracts; writes are atomic (temp-then-rename). A hit
  returns `{ meta, points }` **without touching the file at all** (the moov probe
  is skipped too).
- **What's cached** is the raw extraction (`{ meta, points, streams }`, points
  carrying `cts`, `meta` carrying `model`/`firmware`); `stabilize`/tz/anchor are not.
- **`CACHE_V` discipline**: bump it whenever the cached shape or extraction output
  changes, so stale records are auto-invalidated. (v3 added `cts`; `streams` +
  `model`/`firmware` are later **additive** v3 fields — an older v3 record reads back
  with them absent, so during multi-sensor iteration stale records are cleared by hand
  rather than bumped; bump before shipping.)

---

## Semantics / units (contract guarantees)

- **time** epoch ms UTC (GPS), **speed** m/s, **ele** metres MSL, **lat/lon** degrees.
- A **no-fix prefix** (pre-lock samples) is **kept** in `points` (current behaviour);
  the consumer decides to drop or dim them — it reads `fix`/`hdop` for that.
- `points` are in **capture order**, ascending `time` (modulo the kept pre-lock head).
- All "missing" values are `null`, never `undefined`/`NaN`.

## Out of scope (the renderer's job, NOT this lib)

- Mapping to renderer channels, **gradient** (derive the number from `ele` + distance),
  unit conversion (e.g. m/s → km/h), drawing.
- **Boundary moved (2026-06-29):** elevation **smoothing** and uniform-grid
  **resampling / interpolation** — which the renderer used to own — are now **offered
  opt-in** by the lib (`stabilize`'s `gradeBound` smoothing / `resample`), because the elevation
  truth and the kinematic context to smooth it live here (every consumer would otherwise
  re-implement the same fix). Deriving the gradient *number* from the (now-smoothable)
  `ele` is still the renderer's; the lib just makes the `ele` it derives from slope-stable.

## Flag for the implementer (known gaps)

- **GPS9 (Hero11+) fix/hdop** are now filled from `value[7..8]` = `[DOP, fix]`
  (`extractGoproPoints`), so fix-based logic works on Hero11+. **Open gap [TBC]:**
  the `hdop` scale is unverified — GPS5's sticky `precision` is DOP×100 (divided
  by 100), but GPS9's `value[7]` is read as-is on the assumption it's already in
  DOP units. No Hero11+ sample on hand to confirm; if `hdop` comes out ×100 too
  large on real Hero11+ footage, divide `value[7]` by 100 in `extractGoproPoints`.
  `fix` (`value[8]`) is unaffected.
  - **Verification status (2026-06-27): NOT VERIFIED — no hardware/footage.**
    `readGoproTelemetry` was integration-tested against two real GoPro clips, but
    both are **GPS5** (HERO10 Black + an older camera), so the GPS5 path is
    confirmed (correct coords / `Asia/Tokyo` / `hdop` scale) while the **GPS9 path
    was never exercised**. Closing this needs a Hero11+ (or later, GPS9) `.mp4`/
    `.360` sample — none available at time of writing. Re-run the integration test
    against such a file to confirm `fix`/`hdop` before relying on GPS9.
- **Non-GPS streams** (IMU `ACCL`/`GYRO`, scene, exposure, …) are **now extracted and
  cached** via `extractGoproAll` / `readGoproSamples.streams` — at **zero extra IO**
  (all streams share the one `gpmd` track; the `stream` filter is post-parse). The
  GPS-only `readGoproTelemetry` contract (B–E) is unchanged; the streams ride alongside
  for multi-sensor cross-validation (see [`gpmf-sensors.md`](gpmf-sensors.md)).
- `probeGoproMeta` (mp4box) overlaps a renderer's own video probe (movie-layers
  uses ffprobe). Both are fine; the renderer picks one. Expose it anyway — useful
  standalone and as the `hasGps` gate.

---

## How movie-layers consumes it (informative, not part of this lib)

`provider-gopro` (movie-layers side) will roughly do:

```js
const { meta, points, timezone, startUtc, clock } = await readGoproTelemetry(path, { rate })
// anchor channels to startUtc (the verified true-start when clock.verified, so the
// first fix lands `lockDelay` into playback — gray pre-display before it)
return {
  channels: {
    gps:      { unit: 'deg',  samples: points.map(p => ({ t: tRel(p), value: { lat: p.lat, lon: p.lon } })) },
    altitude: { unit: 'm',    samples: points.map(p => ({ t: tRel(p), value: p.ele })) },
    speed:    { unit: 'km/h', samples: points.map(p => ({ t: tRel(p), value: p.speed == null ? null : p.speed * 3.6 })) },
    // gradient is DERIVED by the adapter from altitude + distance — not from this lib
  },
  clock:    { startUtc, confidence: clock.confidence },   // ← resolveStartUtc
  timezone,                                               // ← timezoneOfPoints
}
```

So this lib only needs to deliver **points + meta + timezone + startUtc/clock**;
everything above the dashed line is the adapter's.

**Using the new smoothing / resampling (2026-06-29).** For the jittery-gradient and
hole-bridging problems, the adapter can opt in:

```js
const { meta, points, segments, startUtc, clock } = await readGoproTelemetry(path, {
  stabilize: { gradeBound: { GRADE_SMOOTH_WIN_M: 30 } }, // slope-stable ele → derived gradient
                                 // stops jittering (was `smooth: true` before 2026-07-10)
  resample: 'fps',               // one point per video frame (= meta.fps); maxGap splits dropouts
})
// iterate `segments` (not `points`) so a GPS dropout / crash break renders as a gap,
// not a straight line; each segment is a uniform per-frame TrackPoint[].
for (const seg of segments) { /* map seg → channel samples, anchored to startUtc */ }
```
