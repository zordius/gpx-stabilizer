# TODO — gpx-from-gopro

Resume notes for the GoPro→GPX work in this repo. Read this, then pick up the
open items below.

## State (done)

`gpx-from-gopro` (bin → `src/gopro-cli.js`) is built, tested, and committed.
It recurses a directory for GoPro videos and writes one merged **GPX 1.1** per
**(camera, local date)** to `--out` — camera = the body serial (udta CAME) when
known (so two same-model bodies on one day stay separate), the filename family
otherwise. Within a day, points split into one `<trkseg>` per recording session
(udta GUMI); a crash (new GUMI) is a segment break, all in the one daily file.

- `src/gopro.js` — `probeGoproMeta()` (cheap moov-only probe: `hasGps` +
  width/height/codec/fps/duration, **plus** udta camera meta —
  `FIRM`→firmware/model, `CAME`→serial, `GUMI`→mediaId, `HMMT`→highlights —
  read from the moov bytes already in hand, ~0 extra IO); `extractGoproPoints()`
  (GPS only) and `extractGoproAll()` (GPS `points` + every non-GPS GPMF stream as
  raw cts samples). Native ~18 Hz. Altitude corrected to MSL via `egm96-universal`
  for pre-Hero8 cameras (Hero5/6/7); Hero8+ already MSL.
- `src/group.js` — **pure, IO-free grouping policy**: `family()` (filename →
  GOPR/GX/GH/…) and `buildGroups(entries)` → `{ groups, skipped }`. Holds the
  serial-merge + GUMI-segment + name-collision + placeholder-drop logic so it is
  unit-testable; the CLI keeps extraction/timezone/skip. Name = readable
  `<date>-<family>`; a short serial suffix is added only on a family+date collision.
- `src/gopro-cache.js` — per-file resumable cache (sidecar `<file>.gpxcache.json`
  by default, or `--cache-dir`), keyed by `v+size+mtime+rate`, atomic write.
  `CACHE_V` is currently `3` — the record is `{ meta, points, streams }` (streams =
  every non-GPS GPMF channel; `meta` carries model/firmware/serial/mediaId/
  highlights). Bump whenever the record shape/extraction changes.
- `src/gpx.js` — `TrackPoint` carries `{lat, lon, ele, time, speed, fix, hdop}`;
  `parseGpx`/`writeGpx` round-trip all of them (`speed` in `<extensions>`,
  `fix`/`hdop` as standard 1.1 children). `writeGpx` emits one `<trkseg>` per
  segment, so the GUMI session split round-trips.
- Commits (recent): `873f079` all-stream cache · `61b8cd2` model/firmware detect ·
  `7623a06` cache serial/mediaId/highlights · `0580a91` serial grouping + GUMI
  segments. Earlier: `1ae2d6d` extraction · `79ff95b` CLI · `fe55dee` speed ·
  `db2b41a` biome 2-space · `3d9f174` moov-probe gate · `8c02da7` cache ·
  `dfc3cf3` fix/hdop · `0c09f41` cache module + tests.

Run: `npm test` (node --test) and `npm run lint` (biome) — **from the repo root**
(biome only loads `biome.json` when run from here; otherwise it defaults to tabs).

CLI:
```
gpx-from-gopro <dir|file.mp4> [...] [--out DIR] [--tz HOURS] [--rate HZ] [--cache-dir DIR | --no-cache]
```

## Open

**Sequencing (2026-06-28): finish the core first, then the GPS/IMU module.** The
geometry-only, portable **core** stabilization (the `gpx-stabilizer` roadmap in
[`SPEC.md`](SPEC.md) — track smoothing / elevation reconstruction, etc.) comes
before the GoPro multi-sensor work.

- **GPS/IMU module (deferred).** The full non-GPS sensor catalog + the fusion
  analysis live in [`docs/gpmf-sensors.md`](docs/gpmf-sensors.md). It is a
  **GoPro-only opt-in module** (via the aux / `finalize` hooks, §3 + `SPEC.md`),
  **not** the base. When picked up, lead with the **witness** uses — #2 ACCL
  teleport-kill (validated, both cameras) and #1 ACCL-centripetal carve-vs-spike —
  not full INS reconstruction (§7: "witness, not reconstructor"). Already built +
  committed: full-telemetry extraction, all-stream v3 cache, camera model/firmware.
  Left: validate the remaining witness signals, then wire one into the pipeline
  (which needs the proposed `finalize` phase).

(Item 1 — re-verify post-refactor extraction — **DONE 2026-06-28**: the `--no-cache`
rerun matched the cache-based output, no regression.)

## Ideas parked (not started)

- `gopro-telemetry` was adopted over exiftool to get 18 Hz + native Node; see the
  Notion todo "評估 gopro-telemetry npm lib". exiftool's `-ee3` reads the whole
  H264 stream for GoPro-unused SEI — `-ee` would have sufficed.
- GPS9 (Hero11+) fix/hdop live in `value[7..8]`, not sticky — `extractGoproPoints`
  leaves them null for GPS9 until tested (only GPS5 Hero5/Hero10 verified).
- A dotted/hidden cache filename (`.<file>.gpxcache.json`) was considered and
  **dropped** — kept the visible `<file>.gpxcache.json`.
- **GUMI session semantics are [TBC]** — the GUMI-per-`<trkseg>` split assumes
  chapters of one recording share a GUMI and a crash starts a new one. Inferred,
  **not** verified: the two local clips are single-chapter, single-camera. Validate
  against a real multi-chapter set (and two same-model bodies for the serial
  collision-suffix path) when such files are available. The serial-based **merge
  key** is correct regardless; only the per-session **segment split** depends on
  this assumption (`buildGroups` in `src/group.js`; unit-tested with synthetic
  entries in `test/group.test.js`).
