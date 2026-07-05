# TODO — gpx-stabilizer (repo resume index)

Quick orientation for picking the work back up. **This is an index, not a source of
truth** — design decisions and status live in [`SPEC.md`](SPEC.md), and the GoPro
sensor evidence in [`docs/gpmf-sensors.md`](docs/gpmf-sensors.md). This file only says
where things stand and what's next; follow the links for detail (so status lives in
one place, not two).

## Shipped

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
- **Two policy-vs-quality-drop bugs fixed (2026-07-05)** — on a high-native-sample-rate source
  (e.g. Hero10's raw ~10 Hz GPS5, `oversample`-thinned to ~2 Hz survivors), a policy-dropped point
  sits between nearly every survivor. Two consumers wrongly treated it as a real gap:
  `glueBadSpans`'s density calc diluted its flag density ~10× (0 → 12 `badspan`-glued points on
  `GX065132.MP4` after the fix), and `view.js`'s clean-line break shattered the line into
  one-point, invisible runs (the bug that surfaced this — the interactive viewer's clean line
  didn't render, no hover). Both fixed the same way: skip policy-only drops
  (`oversample`/`noTime`) instead of treating them as quality gaps. Detail + regression tests:
  [`SPEC.md`](SPEC.md) ("Policy vs quality drops").

## Next (detail in SPEC)

- **Sequencing** — finish the geometry-only **core**, then the GoPro **GPS/IMU
  module**. The boundary is now a rule: [`SPEC.md`](SPEC.md) "Core vs GoPro/IMU module
  — the placement rule".
- **Core roadmap, remaining** — apply the **additive-power activity model**
  ([`SPEC.md`](SPEC.md)): powered-vehicle box merge **DONE** (`powered` in
  `mods/activity.js`, 2026-07-01); coarse lift/descent/flat segmentation **DONE**
  (`mods/segment.js`, see Shipped above); still open — its **turn-confirm** and
  **catwalk-vs-carve** follow-ons, four power-classes as the stage-2 commit space,
  distance-domain resample variant, and OSM validation.
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
  CLI write of the new counts is unconfirmed pending an external-volume remount.*
- **GPS9 (Hero11+) fix/hdop unverified** — read from `value[7..8]` but no Hero11+
  hardware to confirm the `hdop` scale. Authoritative gap notes:
  [`docs/export-contract.md`](docs/export-contract.md) ("Flag for the implementer") and
  [`docs/hdop-notes.md`](docs/hdop-notes.md).

## Dev gotcha

`npm test` / `npm run lint` **from the repo root** — Biome only loads `biome.json` when
run from there; elsewhere it defaults to tabs.
