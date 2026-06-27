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
GoproMeta = { hasGps, gpmdSamples, width, height, codec, fps, durationS }
```

---

## Exports (all from the `gpx-from-gopro` package entry — `packages/gopro/src/index.js`)

> Post monorepo split: the GoPro/telemetry surface ships in the **`gpx-from-gopro`**
> package, not core `gpx-stabilizer`. Consumers `import { readGoproTelemetry, … }
> from "gpx-from-gopro"`. `stabilize` is re-exported there from the core package
> for convenience.

### A. Surface the existing GoPro functions (they live in `packages/gopro/src/gopro.js`)

```js
probeGoproMeta(path)                      // → Promise<GoproMeta>   (cheap moov-only probe)
extractGoproPoints(path, { rate? })       // → Promise<TrackPoint[]> (native ~18 Hz; rate in Hz to downsample)
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
}) // → Promise<TelemetryResult>

TelemetryResult = {
  meta,                        // GoproMeta (geometry / fps / durationS / hasGps)
  points,                      // TrackPoint[]  (raw, or stabilized per opts)
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

---

## Semantics / units (contract guarantees)

- **time** epoch ms UTC (GPS), **speed** m/s, **ele** metres MSL, **lat/lon** degrees.
- A **no-fix prefix** (pre-lock samples) is **kept** in `points` (current behaviour);
  the consumer decides to drop or dim them — it reads `fix`/`hdop` for that.
- `points` are in **capture order**, ascending `time` (modulo the kept pre-lock head).
- All "missing" values are `null`, never `undefined`/`NaN`.

## Out of scope (the renderer's job, NOT this lib)

- Mapping to renderer channels, **gradient** (derive from `ele` + distance),
  interpolation, unit conversion (e.g. m/s → km/h), drawing.

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
- **Only the GPS stream** is extracted; accel/gyro/etc. (the >1 Hz non-GPS data)
  are **not** in this contract's v1.
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
