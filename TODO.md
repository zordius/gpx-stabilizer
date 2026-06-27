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

### 1. Validate the NEW gpx-from-gopro on full real data  — DONE (2026-06-28), 2 bugs found + fixed

End-to-end validated on the real 3-day ski footage (`/Volumes/ZS14T2025/p/20260211-ski`,
124 files, GOPR=Hero5 `j/` + GX=Hero10 `z/`). The first full run (detached, 7 h)
**extracted all 124 files but crashed at the final write step with 0 output** — which
surfaced two real bugs, both now fixed in `packages/gopro/src/gopro-cli.js`:

- **Stack overflow on large groups** — `Math.min(...realTimes)` (and
  `points.push(...points)`) spread hundreds of thousands of args → `Maximum call
  stack size exceeded`. The biggest group, `20260212-GOPR`, is 433 k points. Fixed:
  reduce-loop for the min, loop-push for accumulation (no array spread into a call).
- **GPS cold-start pollution** — a cold-starting GPS emits null-island `(0,0)` points
  with a stale 2021 clock; they sort to the front of a day file (polluting the track)
  and a file that never locks formed bogus stray-date groups (`20210307-GX`,
  `20210310-GX`). Fixed: filter `(0,0)` points at write time and skip groups left
  empty. Cleared ~30 k junk points across the 6 outputs and removed the 2 stray files.

**Validated** (rerun via the on-drive sidecar caches, `processed=120 skipped=4 failed=0`):
stitched skips (4× `no GPS track, skip` via moov probe) · grouping (6 files = GOPR+GX ×
2026-02-11/12/13) · fields (`ele` MSL, `time`, `speed`, `fix`, `hdop`) · `xmllint`
clean on all 6 · `(0,0)` residual = 0 · first trkpt now a real fix (`37.54,140.15`).

Re-run command (current `packages/` path; caches make it ~minutes, not 7 h):
```sh
node ~/zrepos/gpx-stabilizer/packages/gopro/src/gopro-cli.js \
  /Volumes/ZS14T2025/p/20260211-ski --out ~/gpx-validate/out
```

**Caveats / left open**:
- **Caches predate the monorepo refactor** (`CACHE_V` still `2`). The rerun validated
  the write/group/skip/field paths on real extracted points, but the *post-refactor*
  extraction code (cts / recording-start commits) was **not** re-verified — that needs
  a `--no-cache` (or `CACHE_V` bump) full re-extraction (~7 h). Decide if worth it.
- **Drive is a flaky SMB mount** (`//pi@192.168.199.239/usbhdd`): `found N` drifted
  124/114/54 across runs and one file once probed as `EISDIR`. Not a tool bug; just
  expect intermittent partial walks on that network drive.
- `j/133` dangling-symlink dirs still log `skip dir … ENOENT` intermittently.

### 2. Probe unit tests  (decided 2026-06-27 — no fixture, covered by end-to-end)

`probeGoproMeta` has no unit test because testing it needs a real mp4 (binary
fixture), which breaks this repo's all-inline-string test convention. The cache
logic IS tested (`test/gopro-cache.test.js`, fixture-free).

**Decision**: leave the probe to the empirical end-to-end validation (item 1) —
do **not** commit a binary mp4 fixture, keeping the all-inline-string convention.
The probe's key behaviours (no-GPS stitched-file skip path + width/height/dims)
are exercised by the real 3-day footage run; if probe logic changes later and
needs regression cover, revisit then.

## Ideas parked (not started)

- `gopro-telemetry` was adopted over exiftool to get 18 Hz + native Node; see the
  Notion todo "評估 gopro-telemetry npm lib". exiftool's `-ee3` reads the whole
  H264 stream for GoPro-unused SEI — `-ee` would have sufficed.
- GPS9 (Hero11+) fix/hdop live in `value[7..8]`, not sticky — `extractGoproPoints`
  leaves them null for GPS9 until tested (only GPS5 Hero5/Hero10 verified).
- A dotted/hidden cache filename (`.<file>.gpxcache.json`) was considered and
  **dropped** — kept the visible `<file>.gpxcache.json`.
