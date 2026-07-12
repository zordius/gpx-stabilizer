# TODO — gpx-stabilizer (repo resume index)

Quick orientation for picking the work back up. **This is an index, not a source of
truth** — design decisions and status live in [`SPEC.md`](SPEC.md), and the GoPro
sensor evidence in [`docs/gpmf-sensors.md`](docs/gpmf-sensors.md). This file only says
where things stand and what's next; follow the links for detail (so status lives in
one place, not two).

## Shipped

- **Ski-mode lift machinery — `liftConfirm` / `liftSnap` / `liftBoardingEle` / `segmentBoundaryEle` /
  `tangleSnap` / `noise` (2026-07-08…10, v0.4.0/v0.5.0)** — `segment`'s coarse `lift` candidates are
  now confirmed against cable-line physics (`liftConfirm`, the prototype rule-cascade port:
  straightness + speed cap + min-duration, both fake-lift rejections, whole-run drift override,
  ascent drive-sandwich, head/tail trim), geometrically reconstructed (`liftSnap`: TLS line snap +
  hysteresis pause events + boundary fade), boarding/unloading elevation artifacts dropped-not-guessed
  (`liftBoardingEle`, five mechanisms + an hdop-gated position drop), plus the general
  `segmentBoundaryEle` boundary-ele drop, the `tangleSnap` low-speed tangle reposition, and a
  diagnostic `noise` signal. All bundled by `MODES.ski` — `opts.mode` on `analyze`/`stabilize` and
  `--mode` on both CLIs. **This closes the old "turn-confirm" follow-on.** Detail: module docs +
  [`SPEC.md`](SPEC.md) ("Segment / lift segmentation", prior-art port note).
- **`smooth.js` folded into `gradeBound` (2026-07-10)** — `opts.smooth` is gone; the distance-domain
  smoothing pass is now `gradeBound`'s own optional post-despike stage (`GRADE_SMOOTH_WIN_M`, 0 = off;
  ski mode sets 30), and `gradeBound` itself is default-on in ski mode.
- **Elevation-vs-time chart in the HTML viewer (2026-07-08…10)** — `elevationChartSvg` per panel,
  click shows time/elevation, chart line breaks at dropped-ele points. (The vertical-analysis
  "elevation-profile viewer" acceptance tool now exists.) Debug marker layers for lift boundaries
  (`lift start/end`, 2026-07-09) and snap boundaries (`liftSnap start/end`, 2026-07-11) ship alongside.
- **Whole-track analyze (2026-07-09)** — `stabilizeTrack` analyzes the track as ONE stream and
  re-splits at source `<trkseg>` boundaries; the gopro CLI writes one named `<trk>` per recording
  session.
- **`fixQuality` split out of `gpsQuality` as a core builtin (2026-07-08)** — a non-3D `fix` is
  chip-agnostic bad; the hdop half stays the opt-in, per-chip `gpsQuality`.
- **`gpsQuality` module — device-specific GPS-chip quality gate (2026-07-07)** — `measure.js` now
  carries the device's raw `<hdop>`/`<fix>` per point; a new opt-in module drops a point when
  `fix != "3d"` or `hdop >= 10`. Validated on a 3-day GX(Hero10)+Android ground-truth corpus:
  catches 82.3% of points `drift`/`outlier`/`stray`/`badspan` miss entirely, at a 7.9%
  false-positive cost. **Not a builtin** — the threshold is chip-specific (a same-trip Hero5's
  baseline hdop runs ~3× lower), so `packages/gopro`'s `readGoproTelemetry` opts it in only when
  `meta.model === "HERO10"`. Also **revises** `docs/hdop-notes.md`'s earlier "adds little over
  geometry" read for GX-class chips — see that doc's §9. Detail: [`SPEC.md`](SPEC.md) ("GPS-chip
  quality gate").
- **`gpx-from-gopro` CLI** (`packages/gopro`) — recurses a directory for GoPro videos,
  writes one merged GPX 1.1 per **(camera, local date)**: serial (udta CAME) merge key,
  file-number session split (see "Open validation items" below — GUMI was replaced),
  resumable per-file cache (`CACHE_V=3`, all GPMF streams). Telemetry-export API + cache
  contract: [`docs/export-contract.md`](docs/export-contract.md). **`--organize DIR`**
  reorganizes the source videos to mirror the `.gpx` grouping/session naming
  (`src/organize.js`), moving each file's cache alongside and sweeping the `.gpx` in too
  when `--out` wasn't explicit; always previews + confirms first. **`--html`/`--png`**
  (2026-07-05) render each group's merged track through core's own analyzed view
  (clean track + drop markers), additive to the `.gpx` — an eval aid so a group can be
  eyeballed without a separate `gpx-stabilizer --html` pass; required exporting
  `analyzedSvg`/`savePng` from core's public API (`packages/core/src/index.js`).
- **core `stabilize`** (`packages/core`) — noise/outlier removal, plus opt-in elevation
  **smoothing** (`mods/smooth.js`), uniform-grid **resampling** (`resample.js`), and coarse
  lift/descent/flat **segmentation** (`mods/segment.js`, an opt-in `finalize`-phase module,
  2026-07-04). Consumer-accepted by movie-layers `provider-gopro`. Status + evals in
  [`SPEC.md`](SPEC.md) ("Track smoothing" / "Track resampling" / "Segment / lift segmentation").
- **HTML viewer: click-to-show-coordinates (2026-07-06)** — zoomed into a panel, a plain click
  shows the clicked point's lat/lon bottom-left. Detail: [`SPEC.md`](SPEC.md) ("Viewer
  (`view.js` + `html.js`)").
- **Two policy-vs-quality-drop bugs fixed (2026-07-05)** — on a high-native-sample-rate source
  (e.g. Hero10's raw ~10 Hz GPS5, `oversample`-thinned to ~2 Hz survivors), a policy-dropped point
  sits between nearly every survivor. Two consumers wrongly treated it as a real gap:
  `glueBadSpans`'s density calc diluted its flag density ~10× (0 → 12 `badspan`-glued points on
  `GX065132.MP4` after the fix), and `view.js`'s clean-line break shattered the line into
  one-point, invisible runs (the bug that surfaced this — the interactive viewer's clean line
  didn't render, no hover). Both fixed the same way: skip policy-only drops
  (`oversample`/`noTime`) instead of treating them as quality gaps. Detail + regression tests:
  [`SPEC.md`](SPEC.md) ("Policy vs quality drops").
- **`drift` fixed for short clips (2026-07-05), corrected again (2026-07-06)** — its only
  compactness check (`netd150`, ±150 s) clamps to the whole clip on anything not much longer than
  that, diluting a real short stay with real motion elsewhere in a short recording. A first fix
  (a second `netdShort` window gated on `hs < 2 m/s`) confirmed the original `GX065132.MP4` sample
  but then flooded false positives on a real ski-day recording (481 → 3,970 drift-dropped points,
  ~25 segments) — a person walking away from a chairlift, decelerating to a near-stop then
  resuming, tripped it for its whole ~47 s span, because neither part of that gate is actually
  restrictive at a 30 s window scale. Replaced with `straightShort` (net displacement / path length
  over the same short window) — GPS noise inflates path length far more than net displacement, a
  real walk doesn't. This cleanly excludes the false positive and correctly keeps clearly-genuine
  long stays in the same corpus, but **no longer catches the original `GX065132.MP4` sample**
  (already marked weaker/PARTIAL evidence elsewhere) — its own reachable `straightShort` floor
  turned out to overlap the false positive's, a real ambiguity at this timescale, not a tuning
  miss.
- **The long window had the identical blind spot (2026-07-06, same-day follow-up)** — a real,
  ground-truthed switchback (walked exactly once; checked directly, zero self-intersections) still
  tripped the long window's original plain `netd150 < 100` check, for the same reason: a single
  clean fold nets little displacement over ±150 s the same way genuine wandering-in-place does.
  Converged the long window onto the same fix — `straightLong` (the same net-displacement/path-length
  ratio, just over ±150 s instead of ±15 s), reusing the path-length prefix sum already built for
  `straightShort` (no new O(n) work). Checked, not assumed, whether the short window alone could
  cover both scales: it can't — one corpus file had the long window catching 1,864 real points, 78 %
  of which the short window's own `straightShort` never dipped below 0.2 for at all (a person can be
  stuck in one small area for minutes while any given 15 s slice looks like real local movement).
  Detail + regression tests: [`SPEC.md`](SPEC.md) ("drift's window scale mismatch").

## Next (detail in SPEC)

- **Sequencing** — finish the geometry-only **core**, then the GoPro **GPS/IMU
  module**. The boundary is now a rule: [`SPEC.md`](SPEC.md) "Core vs GoPro/IMU module
  — the placement rule".
- **Core roadmap, remaining** — apply the **additive-power activity model**
  ([`SPEC.md`](SPEC.md)): powered-vehicle box merge **DONE** (`powered` in
  `mods/activity.js`, 2026-07-01); coarse lift/descent/flat segmentation **DONE**
  (`mods/segment.js`); lift **turn-confirm DONE** (`mods/liftConfirm.js`, 2026-07-08 —
  see Shipped above); still open — the **catwalk-vs-carve** sub-split, a symmetric
  **`skiConfirm`** module (`liftConfirm`'s sandwich absorption is scoped to `ascent`
  runs pending it — see that module's doc), four power-classes as the stage-2 commit
  space, distance-domain resample variant, and OSM validation.
- **Per-activity smoothing defaults — BLOCKED, don't treat as ready-to-build.** Two
  gaps: (a) no data to *derive* it — the only local tracks are one 3-day ski GoPro trip's
  clips, so walking/cycling/driving/rail/flight values would be pure estimates, and
  `smooth_eval.mjs` measures grade *jitter* (self-consistency), not error-vs-truth; (b) it
  needs **segment segmentation** first — a mixed-activity track can't decide *which*
  per-activity params to apply without committed per-segment labels. Also note `smooth`
  is deliberately **sport-agnostic** today
  ([`packages/core/src/mods/smooth.js`](packages/core/src/mods/smooth.js)), and SPEC says
  the right knob is **noise-driven, not activity-driven** ([`SPEC.md`](SPEC.md) "Adaptive
  window"). Revisit only after segmentation lands and multi-activity tracks exist.
- **GPS/IMU module (deferred, GoPro-only)** — lead with the **witness** uses: #2 ACCL
  teleport-kill (**CONFIRM**, both cameras); #1 ACCL-centripetal carve-vs-spike
  (**PARTIAL** as of 2026-07-05 — geometry-only `despike`+`carve` can't split a flagged
  point from a real carve, an independent IMU horizontal-force proxy can; but the one
  ground-truthed sample turned out to be a stationary gear-removal + GPS-obstruction
  moment, not a real carve — weaker evidence than first read); #6 ACCL/GYRO
  truly-stationary check (**PARTIAL** as of 2026-07-05, same sample, found the *opposite*
  problem: the catalog's original "IMU energy ≈ 0" test is wrong — a person doing real,
  non-translational things (bending, head turns) reads as MORE active than actual skiing;
  the fix is testing horizontal/translational force specifically — but a corpus-wide scan
  (723 candidate clusters across all 124 cached clips, `gpx_eval/stationary_scan.mjs`)
  found a second failure mode too: a head/helmet-mounted camera's neck-pivot lever arm
  still injects real force into that same fix on a quick head turn (ground-truthed on a
  chairlift), so "tolerates rotation" only holds for rotation about the sensor's own
  centre) — not full INS reconstruction. Catalog + per-signal status:
  [`docs/gpmf-sensors.md`](docs/gpmf-sensors.md). Wiring a witness into the pipeline needs
  the proposed `finalize` phase (SPEC module-model section).

## Known issues

- **~~Failing test at HEAD~~ — FIXED (2026-07-12, stale fixture, not a module bug).** core's
  `liftBoardingEle: a weak recovery …` had been failing since `2f92a18` (2026-07-09, so v0.4.0 and
  v0.5.0 both shipped with it red): that commit replaced the fixed `POST_WINDOW` recovery search
  with `lowSpeedBoundary`+`MARGIN`, which spans the test's whole short fixture (every point's hs is
  under `HS_MAX`), raising the best reachable recovery from ~28 m to 34 m — over the test's 30 m
  "safely above" threshold. `LIFT_BOARD_RECOVER_M` itself was honored throughout; the test's
  threshold is now 40 m (above the fixture's reachable 34 m), preserving its original intent.

## Known limitation (not addressed — deliberately skipped, 2026-07-06)

- **A `drift` run isn't always ONE spatially-compact stay.** Checked a real case
  (`20260211-GOPR-c8713177.gpx`, 03:47:29–03:50:30, 147 points): its "slow" sub-portion spans
  61.86 x 30.24 m (max 49.49 m from centroid) — not remotely 1×1 m — and splits into at least two
  spatially distinct clusters (~18 m radius, and a separate one 49 m away) bridged by the
  `DRIFT_GAP` (60 s) merge, not one clean stay. Root cause: `straightLong`/`netd150` are WINDOWED
  signals (±150 s) — a point can individually qualify as drift because its window is dominated by a
  *nearby-in-time* stay, even while that point itself is mid a real, clean approach/departure
  walk (confirmed: the fast-deceleration head of this same run, hs 0.95→2.25, sits 20–76 m from the
  stay's own centroid and is NOT part of the run's 29 self-intersections at all — see
  `gpx_eval/seg3_spatial_check.mjs`). No dedicated spatial-clustering "stay" check exists today;
  `drift` conflates "GPS unreliable" with "this is a stay" via the windowed path-efficiency proxy.
  A real fix would re-cluster a candidate run by actual spatial spread (radius from centroid / max
  pairwise distance) rather than trusting the temporal window's reach — deliberately NOT
  implemented; recorded here so a future pass doesn't have to re-derive it.

## Open validation items (unique to here — not tracked in SPEC)

- **GUMI session split — RESOLVED (2026-07-03): the GUMI assumption was FALSE, split
  re-keyed to file-number.** Validated against a real multi-day / multi-camera ski corpus
  (124 clips, both a `1dafbb` Hero10/GX and a `c871` GOPR body). Finding: GUMI is
  **per-chapter on the Hero10** (each ~12-min chapter gets a fresh GUMI even mid-recording,
  ~1 s apart), so the old GUMI-per-`<trkseg>` split **over-split** a continuous GX run into
  17 segments where the GOPR body (GUMI per session) correctly showed 2. Fix: session key is
  now the **filename file-number** (a recording's chapters share it — signal B) plus a
  within-session **time-gap sub-split** (>120 s — signal A); GUMI is no longer used. GX days
  now split 2 / 3 / 3 (was 17 / 17 / 16), GOPR unchanged. `buildGroups` + `fileNumber` in
  `src/group.js`; real-corpus A+B tests in `test/group.test.js`. *Still open: the crash →
  new-file-number half is inferred (this corpus has no confirmed crash), and the end-to-end
  CLI write of the new counts is unconfirmed — the blocking external volume is mounted again
  as of 2026-07-11 (`/Volumes/ZS14T2025`), so this is now verifiable, just not yet done.*
- **GPS9 (Hero11+) fix/hdop unverified** — read from `value[7..8]` but no Hero11+
  hardware to confirm the `hdop` scale. Authoritative gap notes:
  [`docs/export-contract.md`](docs/export-contract.md) ("Flag for the implementer") and
  [`docs/hdop-notes.md`](docs/hdop-notes.md).

## Dev gotcha

`npm test` / `npm run lint` **from the repo root** — Biome only loads `biome.json` when
run from there; elsewhere it defaults to tabs.
