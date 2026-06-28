# GPMF sensor streams — multi-sensor cross-validation (design)

Design note for extending `gpx-from-gopro` beyond GPS. A GoPro's GPMF track carries many
non-GPS streams (IMU, image analysis, audio) that can **independently validate or augment**
the GPS-only geometry pipeline — turning "GPS guesses" into "claims with a physical witness".

> **Status: DESIGN.** Every use in §4 is a *hypothesis*. The plan is to prove them one by
> one on real footage before wiring anything into the pipeline; the table tracks status.

## Provenance / how we know

Dumped two real clips: Hero10 `GX065132.MP4` and Hero5 `GP175136.MP4`. Reusable probes live
(gitignored) under `gpx_eval/`: `dump_streams.mjs` (stream list), `dump_samples.mjs` (real
sample values), `io_cost.mjs` (IO measurement). Run them on any model to extend the matrix.

## 1. Stream availability — device-dependent

| stream | Hero5 (GOPR) | Hero10 (GX) | meaning |
|---|---|---|---|
| `GPS5` | ✓ | ✓ | lat, lon, alt, 2D/3D speed (+ sticky `fix`, `precision`=DOP×100) |
| `ACCL` | ✓ ~200 Hz | ✓ ~20 Hz | accelerometer m/s² (+ sticky temperature) |
| `GYRO` | ✓ ~400 Hz | ✓ ~20 Hz | gyroscope rad/s |
| `SHUT` | ✓ | ✓ | exposure / shutter time (s) |
| ISO | `ISOG` (ISO×100) | `ISOE` (ISO) | sensor gain — **different key & scale** |
| `GRAV` | — | ✓ | gravity vector (down direction) |
| `CORI` / `IORI` | — | ✓ | camera / image orientation (quaternion) |
| `SCEN` | — | ✓ | scene class probs (snow, urban, indoor, water, vegetation, beach) |
| `FACE` | — | ✓ | face boxes + confidence, smile %, blink % |
| `YAVG`/`HUES`/`UNIF` | — | ✓ | luma average / predominant hues / image uniformity |
| `WBAL`/`WRGB` | — | ✓ | white balance Kelvin / RGB gains |
| `AALP`/`MWET`/`WNDM` | — | ✓ | audio level dBFS / mic-wet / wind processing |

- **Common (both): `GPS5`, `ACCL`, `GYRO`, `SHUT`, ISO** → IMU-based work is *portable*.
- **Hero10-only: everything image-derived + orientation** → richer, but not on the older chip.
- **No satellite count on either** — GoPro's only GPS-quality fields are `fix` + DOP (see
  `hdop-notes.md`). GPMF is presence-based: a clip lists only the streams it actually recorded.

## 2. IO cost — reading more streams is free

All streams are interleaved in **one `gpmd` track** (243 KB on the 179 MB Hero10 clip = 0.13%).
`gpmf-extract` pulls that whole track stream-agnostically; `gopro-telemetry`'s `stream` option
is a **post-parse, in-memory** filter. Measured (local SSD):

| step | time | note |
|---|---|---|
| extract (IO) | 225 ms | stream-agnostic, happens **once** |
| parse GPS-only | 197 ms | 1 stream |
| parse ALL 21 streams | 467 ms | +270 ms CPU |

**Extra IO for all-streams vs GPS-only = 0 bytes.** So multi-sensor is free on the axis that
hurt (the SMB read); only a few hundred ms of extra parse CPU. Implication: **extract once,
parse many** — and optionally cache the raw 243 KB GPMF buffer so any stream is re-derivable
with zero re-IO (today's cache stores only the GPS points).

## 3. Architecture — keep the dep, widen the gate

- **`gopro-telemetry` stays** — it already parses every stream with names/units/scaling/sticky/
  timing (the dump used it). Multi-stream = drop `stream: ["GPS"]` in `gopro.js` and use
  `timeIn: "MP4"`/cts (universal) instead of GPS-UTC time. We were *under*-using the dep, not
  needing to replace it. (Replacing it is a separate, optional zero-dep decision.)
- **`gpmf-extract` unchanged** (already extracts the whole gpmd track).
- **Add `extractGoproStreams(path, { streams })`** alongside `extractGoproPoints`; keep the
  GPS `TrackPoint[]` API as-is (multi-stream needs a per-stream sample shape).
- **Per-model gotchas** for any IMU code: ISO key/scale (`ISOG`×100 vs `ISOE`); ACCL/GYRO
  **axis conventions differ** (Hero5 GYRO is `(z,x,y)`); sample rates differ. Build a per-model
  axis/scale map as each model is tested.
- **Time alignment**: IMU/image streams ride media `cts`; GPS has UTC. Align on `cts` (already
  extracted for the start-regression).

## 4. Use-case catalog (validate one by one)

`★` = leverage (expected payoff × tractability). Status starts UNVERIFIED.

| # | use | target open problem | streams | device | ★ | how to validate | status |
|---|---|---|---|---|---|---|---|
| 1 | **GYRO → carve vs spike** | `despike` / ski "real carve or noise?" | GYRO | both | ★★★ | yaw-rate vs GPS heading-change at `despike`-flagged points; real turn ⇒ gyro yaw, spike ⇒ none | UNVERIFIED |
| 2 | **ACCL → kill teleport false-claims** | `stray` / `outlier` | ACCL (+GRAV+CORI) | both¹ | ★★★ | a GPS jump with ~zero body linear accel = confirmed garbage | UNVERIFIED |
| 3 | **SCEN → obstruction (device-independent)** | obstruction detection — hdop fails on GX | SCEN | Hero10 | ★★★ | correlate vegetation/indoor prob with the hdop≥3 spatial clusters (GOPR's hdop knee is the ground truth) | UNVERIFIED |
| 4 | **GRAV+GYRO → carve lean** | ski `carve` signal | GRAV, GYRO | Hero10 | ★★ | roll (from GRAV) + yaw synchronized through a carve | UNVERIFIED |
| 5 | **SCEN(indoor)+low-speed+FACE → rest/queue** | temporal activity segmentation (roadmap) | SCEN, FACE, GPS speed | Hero10 | ★★ | indoor/face episodes ↔ stationary runs (the base-area hdop clusters) | UNVERIFIED |
| 6 | **ACCL/GYRO → truly-stationary check** | stationary garbage zones (`hdop≥3 paused`) | ACCL, GYRO | both | ★★ | IMU motion energy ≈ 0 ⇒ really stopped (vs GPS drift while moving) | UNVERIFIED |
| 7 | exposure (ISO+SHUT+YAVG) → lighting context | scene aux (minor) | ISO, SHUT, YAVG | both² | ★ | — | PARKED |
| 8 | WNDM/AALP → moving/stopped gate | last-resort motion gate when GPS garbage | WNDM, AALP | Hero10 | ☆ | weak — speed already from GPS/IMU; AGC confounds AALP | PARKED |

¹ On Hero5 (no `GRAV`/`CORI`) gravity & orientation must be self-estimated from raw `ACCL`/`GYRO`.
² `YAVG` is Hero10-only; `ISO`/`SHUT` on both.

## 5. Strategy

- **Portable bet = IMU (`ACCL`/`GYRO`)** — on both cameras, so the general cross-validation
  (carve/spike, teleport-kill, stationary check) builds here.
- **Hero10-only = image/orientation** (`SCEN`/`GRAV`/`FACE`…) — can't be the general solution,
  but they plug *exactly* GX's GPS weakness: `SCEN` gives a device-independent obstruction signal
  where GX's hdop has no usable knee (see `hdop-notes.md` §4–5).
- **Recurring theme**: which signal to trust stays **device-dependent** — Hero5 reads obstruction
  off its clean hdop knee; Hero10 reads it off `SCEN`. The pipeline must pick per source.

## 6. Validation order

1. **GYRO → carve/spike** (#1) — portable, cleanest signal, hits the central ski problem.
2. **SCEN → obstruction** (#3) — novel, fills the GX gap hdop can't.
3. **ACCL → teleport-kill** (#2) — strong, but needs body→world frame fusion.
4. **rest/queue segmentation** (#5).

Prove each on real footage (the `~/Downloads/5/` clips + the on-drive trip) before any pipeline
wiring. Tick the status column as each lands.

## Open

- Per-model axis/scale map — fill in as each camera model is dumped.
- Cache the raw GPMF buffer vs today's GPS-points cache (enables zero-re-IO multi-stream).
- A non-GoPro path: this is all GoPro-specific; other sources won't have these streams.
