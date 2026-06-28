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

### 1. Re-verify post-refactor extraction (caches predate the monorepo split)

**Status: full `--no-cache` re-extraction LAUNCHED 2026-06-28 (in progress, ~7 h).**
Another session can pick up the check when it finishes — see "How to check the
result" below.

**Why this run exists.** The real 3-day end-to-end validation (124 files; the
stack-overflow + GPS cold-start `(0,0)` bugs it surfaced are fixed in commit
`f581a58`) was **rerun via the on-drive sidecar caches**, so it confirmed the
write/group/skip/field paths but ran them on points extracted *before* the
refactor — `CACHE_V` is still `2`. The **post-refactor** extraction code (cts /
recording-start commits) was therefore **not** re-verified. `--no-cache` forces a
fresh extraction with the current code (it neither reads nor writes the sidecar
caches), which is exactly what this run re-verifies.

**The run** (background; the drive `/Volumes/ZS14T2025` is a flaky SMB mount —
`found N` has drifted 124/114/54 across past runs and a file once probed `EISDIR`,
so expect intermittent partial walks — not a tool bug):

```sh
node ~/zrepos/gpx-stabilizer/packages/gopro/src/gopro-cli.js \
  /Volumes/ZS14T2025/p/20260211-ski --out ~/gpx-validate/out --no-cache
```

- **Input**: `/Volumes/ZS14T2025/p/20260211-ski` — 124 files, GOPR=Hero5 `j/` +
  GX=Hero10 `z/`.
- **Output**: `~/gpx-validate/out` (6 merged GPX expected).
- If interrupted, just re-run the same command — `--no-cache` makes it idempotent
  (it always re-extracts from scratch; no resume state to corrupt).

**How to check the result** (whoever lands here after the run finishes). The
acceptance bar is the same one the cache-based rerun hit, re-confirmed now on
freshly-extracted points:

- console tail reads `processed=120 skipped=4 failed=0` (the 4 skips = `no GPS
  track, skip` via the moov probe).
- `~/gpx-validate/out` holds exactly **6** files = GOPR+GX × 2026-02-11/12/13.
- each trkpt carries `ele` (MSL), `time`, `speed`, `fix`, `hdop`.
- `xmllint --noout` is clean on all 6.
- `(0,0)` null-island residual = 0; the first trkpt of each file is a real fix
  (the 2026-02-11 files start near `37.54,140.15`).
- **post-refactor-specific**: points carry `cts`, and start-anchor regression runs
  (`recordingStartUtc`/`resolveStartUtc`) — confirm no crash and a sane
  `slope ≈ 1`. Optionally diff the 6 outputs against the prior cache-based run to
  confirm the post-refactor extraction produces equivalent points.

If all pass, this item is **DONE** — record the outcome and delete it.

## Ideas parked (not started)

- `gopro-telemetry` was adopted over exiftool to get 18 Hz + native Node; see the
  Notion todo "評估 gopro-telemetry npm lib". exiftool's `-ee3` reads the whole
  H264 stream for GoPro-unused SEI — `-ee` would have sufficed.
- GPS9 (Hero11+) fix/hdop live in `value[7..8]`, not sticky — `extractGoproPoints`
  leaves them null for GPS9 until tested (only GPS5 Hero5/Hero10 verified).
- A dotted/hidden cache filename (`.<file>.gpxcache.json`) was considered and
  **dropped** — kept the visible `<file>.gpxcache.json`.
