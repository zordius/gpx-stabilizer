# TODO — gpx-stabilizer (repo resume index)

Quick orientation for picking the work back up. **This is an index, not a source of
truth** — design decisions and status live in [`SPEC.md`](SPEC.md), and the GoPro
sensor evidence in [`docs/gpmf-sensors.md`](docs/gpmf-sensors.md). This file only says
where things stand and what's next; follow the links for detail (so status lives in
one place, not two).

## Shipped

- **`gpx-from-gopro` CLI** (`packages/gopro`) — recurses a directory for GoPro videos,
  writes one merged GPX 1.1 per **(camera, local date)**: serial (udta CAME) merge key,
  GUMI per-`<trkseg>` session split, resumable per-file cache (`CACHE_V=3`, all GPMF
  streams). Telemetry-export API + cache contract:
  [`docs/export-contract.md`](docs/export-contract.md).
- **core `stabilize`** (`packages/core`) — noise/outlier removal, plus opt-in elevation
  **smoothing** (`mods/smooth.js`) and uniform-grid **resampling** (`resample.js`).
  Consumer-accepted by movie-layers `provider-gopro`. Status + evals in
  [`SPEC.md`](SPEC.md) ("Track smoothing" / "Track resampling").

## Next (detail in SPEC)

- **Sequencing** — finish the geometry-only **core**, then the GoPro **GPS/IMU
  module**. The boundary is now a rule: [`SPEC.md`](SPEC.md) "Core vs GoPro/IMU module
  — the placement rule".
- **Core roadmap, remaining** — apply the **additive-power activity model**
  ([`SPEC.md`](SPEC.md)): powered-vehicle box merge **DONE** (`powered` in
  `mods/activity.js`, 2026-07-01); still open — four power-classes as the stage-2
  commit space; distance-domain resample variant; then **segment classification / lift
  handling / activity segmentation** (the shared precondition the elevation work kept
  hitting) and OSM validation.
- **Per-activity smoothing defaults — BLOCKED, don't treat as ready-to-build.** Two
  gaps: (a) no data to *derive* it — the only local tracks are one batch of ski GoPro
  clips (`gpx_eval/hero5cache/`), so walking/cycling/driving/rail/flight values would be
  pure estimates, and `smooth_eval.mjs` measures grade *jitter* (self-consistency), not
  error-vs-truth; (b) it needs **segment segmentation** first — a mixed-activity track
  can't decide *which* per-activity params to apply without committed per-segment
  labels. Also note `smooth` is deliberately **sport-agnostic** today
  ([`packages/core/src/mods/smooth.js`](packages/core/src/mods/smooth.js)), and SPEC says
  the right knob is **noise-driven, not activity-driven** ([`SPEC.md`](SPEC.md) "Adaptive
  window"). Revisit only after segmentation lands and multi-activity tracks exist.
- **GPS/IMU module (deferred, GoPro-only)** — lead with the **witness** uses: #2 ACCL
  teleport-kill (validated, both cameras) and #1 ACCL-centripetal carve-vs-spike — not
  full INS reconstruction. Catalog + per-signal status:
  [`docs/gpmf-sensors.md`](docs/gpmf-sensors.md). Wiring a witness into the pipeline
  needs the proposed `finalize` phase (SPEC module-model section).

## Open validation items (unique to here — not tracked in SPEC)

- **GUMI session split is [TBC].** The GUMI-per-`<trkseg>` split assumes a recording's
  chapters share a GUMI and a crash starts a new one — inferred, not verified (the two
  local clips are single-chapter, single-camera). Validate against a real multi-chapter
  set (and two same-model bodies for the serial collision-suffix path) when such files
  exist. The serial **merge key** is correct regardless; only the per-session **segment
  split** depends on this assumption. (`buildGroups` in `src/group.js`; unit-tested with
  synthetic entries in `test/group.test.js`.)
- **GPS9 (Hero11+) fix/hdop unverified** — read from `value[7..8]` but no Hero11+
  hardware to confirm the `hdop` scale. Authoritative gap notes:
  [`docs/export-contract.md`](docs/export-contract.md) ("Flag for the implementer") and
  [`docs/hdop-notes.md`](docs/hdop-notes.md).

## Dev gotcha

`npm test` / `npm run lint` **from the repo root** — Biome only loads `biome.json` when
run from there; elsewhere it defaults to tabs.
