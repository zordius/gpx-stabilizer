# GPMF sensor streams — multi-sensor cross-validation (design)

Design note for extending `gpx-from-gopro` beyond GPS. A GoPro's GPMF track carries many
non-GPS streams (IMU, image analysis, audio) that can **independently validate or augment**
the GPS-only geometry pipeline — turning "GPS guesses" into "claims with a physical witness".

> **Status: DESIGN.** Every use in §4 is a *hypothesis*. The plan is to prove them one by
> one on real footage before wiring anything into the pipeline; the table tracks status.

## Provenance / how we know

Dumped real clips: Hero10 `GX065132.MP4` (ski, fix3d) and Hero5 `GP175136.MP4` (static/no-fix
— the end-of-day tail, GP17 of an 18-chapter recording). **Plus 2026-06-29:** two Hero5 *ski*
chapters with full IMU streams — `GP015136` / `GP045136` (12 min each, fix3d, ACCL ~203 Hz /
GYRO ~407 Hz) — re-extracted from the SMB archive into a local v3 cache (the chapters' on-disk
sidecar caches are stale **v2, points-only**; a 4 GB chapter takes ~260 s to stream over SMB).
Reusable probes live (gitignored) under `gpx_eval/`: `dump_streams.mjs` / `dump_samples.mjs` /
`io_cost.mjs` (matrix), plus the vibration set — `vib_analyze.mjs` (low/high band split),
`vib_speed.mjs` (HF energy binned by GPS speed), `vband_climb.mjs` (vertical speed by band).
Run them on any model to extend the matrix.

## 1. Stream availability — device-dependent

| stream | Hero5 (GOPR) | Hero10 (GX) | meaning |
|---|---|---|---|
| `GPS5` | ✓ | ✓ | lat, lon, alt, 2D/3D speed (+ sticky `fix`, `precision`=DOP×100) |
| `ACCL` | ✓ ~200 Hz | ✓ ~200 Hz | accelerometer m/s² (+ sticky temperature) |
| `GYRO` | ✓ ~400 Hz | ✓ ~200 Hz | gyroscope rad/s |
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
- **Camera model is identifiable** — read from the MP4 `udta/FIRM` atom (firmware prefix → model:
  `HD5`→HERO5, `H21`→HERO10), now carried in `GoproMeta.model`/`.firmware` and the cache. This is the
  per-model hook the axis/ISO differences above need (e.g. `if model === "HERO5"` for the `(z,x,y)`
  gyro axis order). Self-contained — no exiftool/ffprobe.

### IMU sample rate — genuine data, interpolated timestamps *(verified 2026-06-28)*

Checked on both cameras (static + moving clips): the rates above are the **true data rate**, not a
padded/held lower rate — ACCL/GYRO samples are all distinct measurements (**~0 %** exact-consecutive
duplicates, max identical-run 2 = coincidence), and each ~1 s GPMF payload carries ~200 ACCL samples.
**But** GPMF timestamps *payloads*, not individual IMU samples, so gopro-telemetry spreads a payload's
samples **uniformly** (per-sample `cts` step `sd ≈ 0`). Consequence: GPS↔IMU alignment is
*payload-precise* (the ~1 s boundaries are real; within-payload `cts` is nominal) — fine for windowed
energy (±300 ms, as #2/#6 use), but **don't trust a single sample's `cts` for sub-10 ms event timing**.

**Downsampling: aggregate, never decimate.** The accelerometer's worth is its sub-second transients
(impacts, vibration, carve dynamics). Decimating 200 Hz → 1 Hz **aliases** (high-freq folds in → a
meaningless near-gravity reading). Reduce by a windowed **statistic** instead — RMS / peak / variance
of `|ACCL|−g` per GPS sample — which is what #2/#6 already do, effectively consuming the IMU at GPS
rate. Keep the **raw** stream in the cache (re-derivable features); GYRO's high rate feeds the
orientation / mount work (#10/#11), so don't reduce it (Hero5 records it at **2×** ACCL — ~400 Hz).

**GYRO drift — estimate and remove the bias, never raw-integrate.** Measured on a static clip (Hero5
sitting on a table): a steady per-axis bias ≈ **1.3 °/s** (plus ~0.2 °/s noise). Integrated to a
heading that is **~13° off at 10 s, ~79° at 60 s** — so **raw gyro integration only holds for ~10 s**;
beyond that bias dominates. The bias is **estimable per clip** (the static-period mean) and removable →
residual drift drops to the random-walk floor (~minutes usable); fusing with an absolute reference
(`ACCL` gravity for tilt, GPS heading for yaw — the #11 loop) de-drifts it entirely. So **never
dead-reckon heading from raw gyro** — estimate + subtract bias, then fuse. (One unit, uncalibrated,
temperature-dependent → order-of-magnitude; re-estimate per clip.)

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
parse many** — **now built** (§3): `readGoproSamples` extracts and caches *all* streams, so the
GPS-only CLI run also populates the rich cache at ~0 extra IO.

## 3. Architecture — keep the dep, widen the gate *(built)*

- **`gopro-telemetry` stays** — it already parses every stream with names/units/scaling/sticky/
  timing (the dump used it). Multi-stream just drops the `stream: ["GPS"]` filter and uses
  `timeIn: "MP4"`/cts (universal). We were *under*-using the dep, not needing to replace it.
- **`gpmf-extract` unchanged** (already extracts the whole gpmd track).
- **`extractGoproAll(path)` → `{ points, streams }`** (built, exported) — GPS `TrackPoint[]` plus
  every non-GPS stream as `{ name, units, samples: [{ cts, value }] }`, aux at native rate.
  `extractGoproPoints` (GPS-only `TrackPoint[]`) is unchanged for existing callers.
- **Cached**: `readGoproSamples` extracts via `extractGoproAll` and stores `{ meta, points, streams }`
  (CACHE_V stays 3, additive). Both the lib and the CLI go through it, so both populate the rich
  cache. `meta` also carries `model`/`firmware` (read from `udta/FIRM`).
- **Per-model gotchas** for any IMU code: ISO key/scale (`ISOG`×100 vs `ISOE`); ACCL/GYRO
  **axis conventions differ** (Hero5 GYRO is `(z,x,y)`); GYRO rate differs (Hero5 ~400, Hero10 ~200).
  Branch on `meta.model` (§1) — build the per-model axis/scale map as each model is tested.
- **Time alignment**: IMU/image streams ride media `cts`; GPS has UTC. Align on `cts` (already
  extracted for the start-regression) — payload-precise (§1).

### Camera-facing ≠ travel direction — a cross-cutting caveat

The camera's **orientation is not the travel direction** — except on a *rigid vehicle mount*. On a
body/helmet mount the rider looks around and the torso turns independently of where the GPS says they
are going (a ski carve turns the skis while the camera stays facing downhill). So **any design that
relates a body-frame sensor to the GPS course must not assume camera-heading = travel**:

- `GYRO` yaw ≠ travel-turning → #1 uses centripetal `ACCL`, **not** yaw.
- `ACCL`/`GYRO` body axes ≠ world N/E/up → isolating "lateral"/"vertical" needs a gravity/orientation
  step (`GRAV`, or a GYRO+ACCL AHRS on Hero5), not a fixed axis.
- The mismatch is itself a **signal** — its *degree* is the mount type (#10 below).

Treat "is camera-heading usable as course?" as a per-clip question (answered by #10), never an
assumption. Expect this caveat to recur across the multi-sensor designs.

## 4. Use-case catalog (validate one by one)

`★` = leverage (expected payoff × tractability). Status starts UNVERIFIED.

| # | use | target open problem | streams | device | ★ | how to validate | status |
|---|---|---|---|---|---|---|---|
| 1 | **ACCL centripetal → carve vs spike** | `despike` / ski "real carve or noise?" | ACCL (+`GRAV`/orientation) | both | ★★★ | at a `despike`-flagged turn a real carve has sustained lateral **centripetal** accel (`v²/r`), a spike has none. Coarse/portable = `ACCL` magnitude above g; carve-specific = the horizontal-projected linear accel (down-axis from `GRAV`, or GYRO+ACCL AHRS on Hero5). **Not gyro yaw** — a carve needn't rotate the camera (angulation keeps it facing downhill) | UNVERIFIED |
| 2 | **ACCL → kill teleport false-claims** | `stray` / `outlier` | ACCL (+GRAV+CORI) | both¹ | ★★★ | a GPS jump with ~zero body linear accel = confirmed garbage | **CONFIRM ✓**⁵ |
| 3 | **SCEN → obstruction (device-independent)** | obstruction detection — hdop fails on GX | SCEN | Hero10 | ★★★ | correlate vegetation/indoor prob with the hdop≥3 spatial clusters (GOPR's hdop knee is the ground truth) | UNVERIFIED |
| 4 | **GRAV lean + ACCL centripetal → carve confirm** | ski `carve` signal | GRAV, ACCL | Hero10 | ★★ | lean angle (`GRAV` tilt) and lateral centripetal (`ACCL`) rise together through a carved arc — the lean *is* the resultant of gravity + centripetal (not gyro yaw) | UNVERIFIED |
| 5 | **SCEN(indoor)+low-speed+FACE → rest/queue** | temporal activity segmentation (roadmap) | SCEN, FACE, GPS speed | Hero10 | ★★ | indoor/face episodes ↔ stationary runs (the base-area hdop clusters) | UNVERIFIED |
| 6 | **ACCL/GYRO → truly-stationary check** | stationary garbage zones (`hdop≥3 paused`) | ACCL, GYRO | both | ★★ | IMU motion energy ≈ 0 ⇒ really stopped (vs GPS drift while moving) | UNVERIFIED |
| 7 | **exposure (SHUT×ISO) → obstruction / indoor (PORTABLE)** | obstruction detection — the one proxy that works on *both* chips | SHUT, ISO (+`YAVG` on Hero10) | both² | ★★ | per-clip-relative `SHUT×ISO` (or `YAVG`) vs `SCEN` indoor/vegetation prob + GOPR hdop≥3 clusters (ground truth) + known indoor episodes³ | UNVERIFIED |
| 8 | WNDM/AALP → moving/stopped gate | last-resort motion gate when GPS garbage | WNDM, AALP | Hero10 | ☆ | weak — speed already from GPS/IMU; AGC confounds AALP | PARKED |
| 9 | **ACCL (vertical) → assist elevation reconstruction** | track smoothing / gradient jitter ([`SPEC.md`](../SPEC.md) elevation-reconstruction contract) | ACCL (+`GRAV`/`CORI` for world-frame) | both⁴ | ★★ | complementary filter (low-pass GPS `ele` + high-pass IMU vertical) vs plain distance-domain smoothing on `GX065132.MP4` (the contract's eval clip) | **PARTIAL** (oracle v1 — see below) |
| 10 | **GYRO heading vs GPS heading → mount type** | `activity` (vehicle vs body) + a *meta*-gate: is camera-heading = travel? | GYRO (+`GRAV`/AHRS for the yaw axis) | both | ★★ | correlate GYRO-yaw heading-change with GPS heading-change over moving segments — **tight ⇒ hard/vehicle** mount (camera ≈ travel), **loose ⇒ soft/body** mount. A high-corr clip *unlocks* GYRO-as-travel-heading (turn-type, dead-reckon); a low-corr clip must **not** use it (the §3 facing caveat) | UNVERIFIED |
| 11 | **GYRO return-to-center → travel / fall-line direction** | recover course on a *soft* mount (where camera-heading ≠ travel); also gyro bias self-cal | GYRO (+`GRAV`/AHRS) | both | ★★ | accumulate gyro heading over a window; its **time-center ≈ the dominant travel direction** (humans naturally return to facing forward). Window bound: raw gyro drifts ~13°/10 s so it must be bias-removed (per-clip) and/or GPS-de-drifted (the §1 fusion loop). **Ski caveat**: the head faces the fall line, so the center is the *run's descent direction*, not per-carve heading | UNVERIFIED |
| 12 | **ACCL/GYRO high-freq → surface roughness / on-snow vs transport** | `activity` segment classification / **lift handling** (roadmap) | ACCL, GYRO (HF band) | both | ★★ | high-freq vibration (signal − 0.3 s MA) rises with speed **and** surface roughness; at the *same* speed, smooth-groomed ≈ ⅓ the vibration of rough snow. Lift = moderate speed + low vibration + **climbing**; smooth catwalk = same but **descending** — so HF energy + vertical-speed together separate ski / catwalk / lift (speed alone cannot) | **PARTIAL** (measured — see Vibration findings below) |

¹ On Hero5 (no `GRAV`/`CORI`) gravity & orientation must be self-estimated from raw `ACCL`/`GYRO`.
² `YAVG` (measured luma) is Hero10-only; `SHUT`/`ISO` on both → the proxy itself is portable.
³ Use the **exposure product** `SHUT×ISO`, not `SHUT` alone (GoPro has no iris, so it trades shutter
  against gain). **Confounds**: snow is bright enough to compress the range under light tree cover;
  auto-exposure saturates in full sun (shutter floored); time-of-day / weather shift the baseline —
  so normalise per-clip and read it as **coarse open-vs-covered / indoor**, not a fine sky fraction.
  Physical basis: trees & terrain block light *and* satellites together, so "darker ⇒ more obstructed"
  has real causation. **Indoor is the strong signal** (order-of-magnitude drop); light tree cover is
  the subtle, confounded end.
⁴ GoPro has **no barometer** — altitude is GPS-derived (so noisy). World-frame vertical accel needs
  gravity removed + orientation, and double-integration **drifts**, so this is a *shape* constraint
  fused with GPS (GPS carries the low-frequency truth, IMU the high-frequency motion), **not** a
  standalone altitude. **Gated**: only worth building if the contract's plain distance-domain
  smoothing proves insufficient — likely overkill for ski descents (the real grade dominates the
  noise), but kept on the list because GPS altitude is the noisiest GPS axis.
⁵ **Verified 2026-06-28** on `GX065132.MP4` (Hero10, real ~200 Hz ACCL). `|ACCL|`mean ≈ g (sensor
  sane); IMU linear force correlates with GPS position-acceleration (Pearson r ≈ 0.39 — moderate, as
  ACCL is an accel/vibration sensor, not a speedometer), and the top real GPS-accel events all have
  IMU corroboration. A controlled ~700 m teleport injected at the calmest point sent GPS pos-accel to
  **70 568 m/s²** while IMU stayed **0.77 m/s²** — a **~92 000×** separation, so "high GPS accel ∩
  flat IMU = garbage" holds with a 5-orders-of-magnitude margin and won't false-positive on real
  maneuvers. The **CONFIRM** direction (additive drop) is a standalone `compute` module (flavor A,
  zero core change). The **RESCUE** direction (un-drop a `stray`/`outlier` false positive) needs the
  proposed `finalize` phase ([`SPEC.md`](../SPEC.md)). Probe `gpx_eval/accl_validate2.mjs`.
  **Confirmed on REAL garbage** (`GX015129.MP4`, a Hero10 cold-start clip: 3122 real + 2694 garbage
  points): real-track points have GPS pos-accel ≈ IMU force (median ratio **1.8**, p99 **44**), while
  the wandering-teleport garbage hits GPS pos-accel **10.4 M m/s²** with IMU normal (~2.84) — a GPS/IMU
  ratio up to **6 M×**, even cleaner than the injection. Two findings: (a) garbage is two kinds —
  static null-island `(0,0)` (GPS-accel ≈ 0, *not* a teleport, left to `fix=none`) and wandering
  teleport (the #2 target); (b) a *per-point* flag catches only the entry/exit jumps of a teleport run
  (its interior points sit close together, low local accel — the same cluster blind spot as `outlier`),
  so the drop must act at **run/segment** level, not per point. Probe `gpx_eval/accl_real.mjs`.
  **Confirmed on BOTH cameras** (real motion *and* a real teleport in one clip each): Hero5
  `GOPR5131` and Hero10 `GX015129` — moving points give GPS pos-accel ≈ IMU (ratio **~1.8–1.9**, no
  false positive), real teleports give GPS ≫ IMU (Hero5 **1.4e8×**, Hero10 **5.3e8×** at the peak
  jump). Note the device asymmetry from §4: Hero5's clean GPS barely teleports (1 of 70 clips had any
  far points, and those were a *static* wrong-spot cold-start with a single snap-back to track),
  whereas Hero10 teleports constantly — but where a jump occurs the signature is identical, so the
  IMU cross-check is sound on both. (`|ACCL|`-magnitude is frame-invariant, so Hero5's different axis
  convention doesn't matter.) Probe `gpx_eval/accl_top.mjs`.

### Vibration (ACCL/GYRO high-freq) — measured, and what it is NOT *(2026-06-29)*

Investigated for #12 and as input to the #9 elevation oracle. HF = vibration energy = RMS of
(signal − 0.3 s moving average); probes `gpx_eval/vib_*.mjs`.

- **The IMU clearly sees ski vibration.** Ski (Hero10 `GX065132`) vs static (Hero5 `GP175136`):
  ACCL HF **2.71 vs 0.39 m/s² (~7×)**, GYRO HF **0.34 vs 0.067 rad/s (~5×)** — well above the
  stationary noise floor. Motion-coupled and present **regardless of in-video stabilization**
  (the GPMF IMU is the raw sensor HyperSmooth consumes, not a post-stabilized signal). *Caveat:*
  this pair is **cross-camera** (Hero10 vs Hero5); the 7× gap is far beyond any plausible
  noise-floor difference, but a same-body static control would be cleaner.
- **Vibration is NOT a clean function of speed** — three datasets disagree: Hero10 `GX065132`
  (33 s) gave a **U-shape** (slow ≈ fast high, mid-cruise low); Hero5 `GP015136` (12 min) gave a
  clean **monotonic** rise (ACCL **0.92 → 4.30** slow→fast); Hero5 `GP045136` (12 min) **broke
  monotonic** — its 3–5 m/s band was anomalously low (ACCL 0.63) despite holding the most
  samples. The confound is **surface roughness / terrain**, not pure noise. ⇒ **Do NOT use
  vibration as the speed/density proxy** for the adaptive smoothing window (SPEC "per-activity"
  / the density-adaptive design): use `planarStep` / speed directly. A single short clip
  misleads — the Hero10 U-shape was a 33 s small-sample artifact, and `GP015136`'s "clean
  monotonic" reversed on the next chapter. (Fact Discipline: don't conclude from one clip.)
- **It IS a surface / activity signal** (the real value, → #12). Same speed, smooth-groomed vs
  rough snow differ **2–3×** in HF — something speed cannot tell apart. A first guess that
  `GP045136`'s low-vib 3–5 m/s band was a **lift** was **refuted** by `vband_climb.mjs`: that
  band is **descending −0.96 m/s**, so it's a smooth catwalk, not a lift (a lift climbs). The
  clean discriminator is therefore **two axes**: HF vibration (smooth vs rough) + GPS vertical
  speed (up = lift, down = run) → ski / catwalk / lift separate cleanly. Feeds the roadmap's
  segment classification / lift handling.
- **For the #9 elevation oracle, vibration is the band to REJECT.** Using IMU vertical as a
  ground-truth elevation/slope shape means **low-passing out** exactly this HF band first. The
  plan: an **IMU-as-calibration-oracle** — offline, fuse low-passed IMU vertical (Hero10: via
  `GRAV`/`CORI`; **Hero5: self-fuse `ACCL`+`GYRO`, no `GRAV`/`CORI`**) to a slope truth, then use
  it to pick the core smoothing constant that bounds jitter **without over-flattening** real
  terrain — the gap a jitter-only metric can't close (jitter falls monotonically with window, so
  it can't see over-flattening). Teacher = GoPro IMU (offline, gopro side); student = core's
  pure-GPX smoother + the baked constant. Keep the constant physics/density-based (not overfit to
  one GPS chip's noise) and document its provenance.

### IMU-vertical elevation oracle (#9) — v1 works on CLEAN input *(2026-06-29)*

First complementary filter (`gpx_eval/oracle_v1.mjs`): gravity direction = the **low-pass of
`ACCL` itself** (not `GRAV` — Hero10 `ACCL`/`GRAV` axis conventions don't align, giving a wrong
baseline `|g|`≈3.6; ACCL-only gives `|g|`≈9.8 **and** works on Hero5, which has no `GRAV`).
Vertical linear accel = high-pass `ACCL` on that axis (zero-mean ⇒ no integration-bias drift),
fused with GPS vertical velocity + a slow position anchor.

- **Works on clean input.** Net elevation tracks GPS with no drift (Hero5 `GP015136`: −347.9 m
  fused vs −348.2 m raw over a 348 m descent). On the noisy Hero10 *best-case* clip `GX065132`
  it cuts 20 m grade jitter ~2.4× (1.05→0.43); on the already-clean Hero5 clip it barely helps
  (raw jitter 0.11) — IMU vertical earns its keep **only when GPS `ele` is noisy**, matching #9's
  "gated on plain smoothing being insufficient."
- **Needs clean GPS first — two separate IMU jobs.** On **raw dirty Hero10** (`GX045132`/
  `GX055132`: many `none`/`2d` fixes, 40–80 m/s teleport spikes) fused grade is still garbage
  (±300 %): vertical fusion smooths `ele` but **cannot fix horizontal teleports** that corrupt the
  grade *denominator*. Horizontal teleports = **witness #2 / `stabilize`**; vertical fusion (#9) =
  `ele` noise on the survivors. Order: de-teleport → then fuse/smooth.
- **Smoother choice (full-stack eval, same survivor grid).** Among clean / mean / median / trimmed
  smooth / IMU-fuse: **mean wins for grade jitter** (Hero10 2.00→1.14, Hero5 0.74→0.63); a window
  **median is WORST** (snaps to sample values → staircase → spikier derivative; Hero10 1.90); a
  **trimmed mean only ties the mean** (no lone spike left once `stabilize` runs). **IMU-fuse** has
  the lowest jitter *and* best preserves the clean range, but is GoPro-only (#9). A speculative
  `SMOOTH_ROBUST` median was tried in core and **reverted**.
- **The dirty-Hero10 extremes are mostly LIFT geometry, not `ele` spikes.** A chapter that climbs
  +151 m (`GX045132`, real — raw & fused agree) gives ±300–400 % grade that **no `ele` smoothing
  fixes** (steep climb over short horizontal); the ski-down (`GX055132`, −151 m) is far saner. So
  the prerequisite is **lift/activity segmentation** (#12 / SPEC "lift handling"), not an `ele`
  despiker — `stabilize` is horizontal-only (`outlier`/`stray` test x/y) but no surviving lone
  `ele` spike that the mean smears has actually been found.
- *Metric caveat:* the Δ/step jitter is **density-confounded** — raw (dense ~10–18 Hz) vs the
  ~1 Hz survivors aren't comparable; compare on a common grid (the full-stack eval does).
- *Metric caveat:* the Δ/step jitter is **density-confounded** — raw (dense ~10–18 Hz) vs the
  ~1 Hz survivors aren't comparable; compare grade **range**, or resample to a common grid first.

## 5. Strategy

- **Portable bet = IMU (`ACCL`/`GYRO`)** — on both cameras, so the general cross-validation
  (carve/spike, teleport-kill, stationary check) builds here.
- **Hero10-only = image/orientation** (`SCEN`/`GRAV`/`FACE`…) — can't be the general solution,
  but they plug *exactly* GX's GPS weakness: `SCEN` gives a device-independent obstruction signal
  where GX's hdop has no usable knee (see `hdop-notes.md` §4–5).
- **Obstruction has three candidate signals, and only one is portable**: Hero5 → clean **hdop knee**;
  Hero10 → **`SCEN`**; and **exposure (`SHUT×ISO`) on both** (#7). The portable exposure proxy is the
  most interesting bet precisely because it sidesteps the device-dependence — if it holds up it could
  be *the* cross-model obstruction signal, with hdop/SCEN as per-device corroboration.
- **`GYRO` repositioned** — it is **not** a carve signal (a carve needn't rotate the camera, §3
  facing caveat). Its jobs: the **orientation/gravity backbone** that makes the centripetal-`ACCL`
  extraction (#1/#4) work on Hero5 (no `GRAV`) and corroborates it on Hero10, **mount detection**
  (#10), and a no-rotation term for the stationary check (#6).
- **Recurring theme**: which signal to trust otherwise stays **device-dependent** (see
  `hdop-notes.md` §4–5). The pipeline must pick per source.

## 6. Validation order

1. **ACCL centripetal → carve/spike** (#1) — portable, hits the central ski problem. (Was "GYRO yaw";
   corrected — a carve is a *centripetal acceleration*, not a camera rotation. See §3 facing caveat.)
2. **Obstruction trio** (#3 + #7) — test `SCEN` and exposure `SHUT×ISO` together against the GOPR
   hdop≥3 ground truth; the portable exposure proxy (#7) is the prize if it holds.
3. **rest/queue segmentation** (#5) and **mount type** (#10).

(**#2 ACCL → teleport-kill is DONE** — confirmed on both cameras, §4.)

Prove each on real footage (the `~/Downloads/5/` clips + the on-drive trip) before any pipeline
wiring. Tick the status column as each lands.

## 7. Sensor fusion — the complementary pairs, and IMU as *witness* not *reconstructor*

**Two complementary pairs, same shape.** GPS and an inertial sensor have errors in *opposite* frequency
bands, so they fuse:

| fused quantity | absolute, drift-free, high-freq-noisy | smooth high-freq, low-freq drift |
|---|---|---|
| **heading** | GPS course (position deltas) | `GYRO` (integrated yaw) |
| **velocity / position** | GPS position / Doppler velocity | `ACCL` (gravity-removed, integrated) |

A complementary filter takes `low-pass(GPS) + high-pass(IMU)`: the IMU's **drift lives in the low band**
the high-pass discards; the GPS's **noise lives in the high band** the low-pass discards. Because GPS
**re-anchors** every sample, the IMU integration never runs long enough to drift — the error is
*bounded*, not growing, so it holds indefinitely (the "no accumulation limit" §1 alludes to). The
acceleration pair is the harsher one: position is a *double* integral of accel, so bias drifts as
`½·b·t²` (quadratic) — GPS anchoring is even more essential there.

**The two pairs are one GPS-INS, coupled.** The accel pair can't run without the heading pair: `ACCL`
carries gravity, so isolating *linear* acceleration needs the orientation (which way is down) that
`GYRO`+`GRAV` produce. A small attitude error leaks residual gravity into "horizontal accel" → a large
integrated velocity error. So it is a single strapdown GPS/INS, not two independent filters.

**Practical limits — why it is not a free true-track:**

- **No GPS = no anchor.** Short gaps (seconds) the IMU bridges; a long outage (indoor, deep cover, the
  pre-lock cold-start) drifts unbounded — it is **GPS-anchored, not GPS-free**; a no-GPS stretch can't
  be reconstructed from IMU alone.
- **Systematic GPS error passes through.** The low-pass removes GPS jitter/teleports (high-freq), but a
  *sustained* offset (multipath under a cliff) is low-freq → the fused track inherits it. It fixes the
  wobble, not a consistently-wrong GPS.
- **Orientation/gravity dependency** — worst on Hero5 (no `GRAV`) and during a sustained carve (the
  centripetal contaminates the gravity reference, exactly when you need it).
- **Bias drifts with temperature/time** → must be re-estimated continuously, which only works while GPS
  is present.
- **Camera motion ≠ body track** — on a soft mount the IMU sees head bob/lean that isn't the path.
- **Cost / portability** — a full GPS-INS is a heavy multi-state EKF, **GoPro-only** (a `.gpx` source
  has no IMU), so it can never be the base.

**Conclusion — witness, not reconstructor.** For this project's goal (*remove noise points*), the
high-value, cheap use of the IMU is as an independent **witness** that confirms/vetoes a GPS point
(#1 carve, #2 teleport) — a windowed comparison, no EKF. **Full INS trajectory reconstruction is a
separate, heavier, GoPro-only thing** — an opt-in module at most (via the aux/`finalize` hooks, §3 /
`SPEC.md`), never the base. So the **sequencing**: finish the geometry-only, portable **core** first;
the GoPro **GPS/IMU module** (this whole catalog) is deferred — and when it lands, lead with the
witness uses; INS-grade reconstruction is the speculative far end that may, at most, feed *back* into
stabilization through the same hooks.

## Open

- Per-model axis/scale map — fill in as each camera model is dumped.
- Cache the raw GPMF buffer vs today's GPS-points cache (enables zero-re-IO multi-stream).
- A non-GoPro path: this is all GoPro-specific; other sources won't have these streams.
