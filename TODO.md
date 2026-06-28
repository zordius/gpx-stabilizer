# TODO — gpx-from-gopro

Resume notes for the GoPro→GPX work in this repo. Read this, then pick up the
open items below.

## State (done)

`gpx-from-gopro` (bin → `src/gopro-cli.js`) is built, tested, and committed.
It recurses a directory for GoPro videos and writes one merged **GPX 1.1** per
`(camera family, local date)` to `--out`.

- `src/gopro.js` — `probeGoproMeta()` (cheap moov-only probe: `hasGps` +
  width/height/codec/fps/duration) and `extractGoproPoints()` (gpmf-extract +
  gopro-telemetry → points). Native ~18 Hz. Altitude corrected to MSL via
  `egm96-universal` for pre-Hero8 cameras (Hero5/6/7); Hero8+ already MSL.
- `src/gopro-cache.js` — per-file resumable cache (sidecar `<file>.gpxcache.json`
  by default, or `--cache-dir`), keyed by `v+size+mtime+rate`, atomic write.
  `CACHE_V` is currently `2` — bump it whenever the point shape/extraction changes.
- `src/gpx.js` — `TrackPoint` carries `{lat, lon, ele, time, speed, fix, hdop}`;
  `parseGpx`/`writeGpx` round-trip all of them (`speed` in `<extensions>`,
  `fix`/`hdop` as standard 1.1 children).
- Commits: `1ae2d6d` extraction · `79ff95b` CLI · `fe55dee` speed · `db2b41a`
  biome 2-space · `3d9f174` moov-probe gate · `8c02da7` cache · `dfc3cf3`
  fix/hdop · `0c09f41` cache module + tests.

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
