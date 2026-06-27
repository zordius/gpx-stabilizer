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

### 0. The OLD ~/bin/gopro-gpx.js stress-test — DEAD, produced no GPX  (closed 2026-06-27)

The previous tool `~/bin/gopro-gpx.js` (exiftool-based, the version *before* this
repo's rewrite) was launched on `/Volumes/ZS14T2025/p/20260211-ski` as a real-data
stress test ("跑個挑戰一點的實測看有沒問題") and ran detached. **It died before
completion and wrote no GPX.** Not being rerun — the new `gpx-from-gopro` (item 1)
replaces it.

- **Death point**: killed mid-extraction of `z/140/GX025140.MP4` — the 118th file
  in sorted (`walk(dir).sort()`, full-path alphabetical) order, immediately after
  `z/140/GX015140.MP4` (the last *complete* block in the log). **117 of 120 files
  fully extracted** (j/GOPR 66 = 13+36+17; z/GX 51 = 18+17+16). 3 left:
  `GX025140.MP4` (died here) + the two z-root stitched files `z/GX015130.MP4`,
  `z/GX015136.MP4`.
- **Cause**: log ends cleanly with **no JS exception** → external **SIGKILL**, not
  a code crash. The old js writes all GPX only AFTER the full extraction loop
  (`~/bin/gopro-gpx.js:265-270`, `${key}.gpx` per group to cwd), so dying 3 files
  short = **0 output**. Confirmed: no `*.gpx` in `~/zordius-ai/` (its cwd; the
  `gpx/workout-*.gpx` there are unrelated Apple-Watch exports). The "no controlling
  TTY → survives Claude exit" hope did NOT hold: it was force-killed when the Claude
  session was torn down (it was inside the harness task tree). Lesson → item 1 runs
  truly detached (own session via `setsid`).
- **Log** (durable): `~/zordius-ai/scratch/run2026.err` (1176 lines; `.out` empty).

### 1. Validate the NEW gpx-from-gopro on full real data  — RUNNING detached (2026-06-27)

A full validation run is **in progress, launched fully detached** (own session,
PPID = launchd, no controlling TTY) so it survives this/any Claude session teardown
— it is NOT in the harness task tree (unlike item 0, which that killed).

- **Purpose**: end-to-end validation of `gpx-from-gopro` on the real 3-day ski
  footage — confirm cheap stitched-file skips, correct (camera, local-date)
  grouping, and full trkpt fields — to confirm it can replace `~/bin/gopro-gpx.js`.
- **Arguments**: input dir `/Volumes/ZS14T2025/p/20260211-ski`; `--out
  ~/gpx-validate/out`; no `--cache-dir` → per-file sidecar caches
  `<file>.gpxcache.json` written on the drive next to each source, so a killed run
  resumes cheaply (the restart hit them — files logged `(cached)`).
- **Plain command** (foreground equivalent; paths absolute, run from anywhere):
  ```sh
  node ~/zrepos/gpx-stabilizer/src/gopro-cli.js \
    /Volumes/ZS14T2025/p/20260211-ski --out ~/gpx-validate/out
  ```
- **How it was launched detached** (macOS has no `setsid`; python fork+setsid):
  ```sh
  python3 -c 'import os
  if os.fork() > 0: os._exit(0)
  os.setsid()
  fo = os.open("/Users/zordius/gpx-validate/run.log", os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o644)
  os.dup2(os.open("/dev/null", os.O_RDONLY), 0); os.dup2(fo, 1); os.dup2(fo, 2)
  os.execvp("node", ["node", "/Users/zordius/zrepos/gpx-stabilizer/src/gopro-cli.js", "/Volumes/ZS14T2025/p/20260211-ski", "--out", "/Users/zordius/gpx-validate/out"])'
  ```
- **Log** (durable): `~/gpx-validate/run.log`.
- **Output GPX** (durable): `~/gpx-validate/out/` — one `<YYYYMMDD>-<family>.gpx`
  per (camera, local date), written only at the very end of the run.
- **Monitor**: alive? `pgrep -fl gopro-cli.js` (PPID 1 = detached) · progress:
  `tail -f ~/gpx-validate/run.log` · output appears at completion:
  `ls ~/gpx-validate/out/`.

**Validation checklist** (run once `~/gpx-validate/out/` is populated):
- **Stitched products skipped cheaply** — files with no GPMF track should log
  `no GPS track, skip` via the moov probe (not a slow full extraction).
- **Grouping** — one `<YYYYMMDD>-GOPR.gpx` per day for `j` (Hero5), one
  `<YYYYMMDD>-GX.gpx` per day for `z` (Hero10); trip spans 2026-02-11/12/13.
- **Fields present** — trkpts carry `ele` (MSL), `time`, `speed`, `fix`, `hdop`;
  validate each file with `xmllint --noout ~/gpx-validate/out/<file>.gpx`.
- **File-count sanity** — this run reported `found 124 video file(s)`; an earlier
  killed attempt reported `114`. Reconcile the diff (likely the dangling-symlink
  dirs under `j/133` that the walk logs as `skip dir … ENOENT` and that may
  intermittently resolve).

### 2. Probe unit tests  (deferred — needs a decision)

`probeGoproMeta` has no unit test because testing it needs a real mp4 (binary
fixture), which breaks this repo's all-inline-string test convention. The cache
logic IS tested (`test/gopro-cache.test.js`, fixture-free). Decide: commit a tiny
(~8.5 KB) no-GPS mp4 fixture to cover the probe's skip path + dims, or leave the
probe to the empirical end-to-end validation.

## Ideas parked (not started)

- `gopro-telemetry` was adopted over exiftool to get 18 Hz + native Node; see the
  Notion todo "評估 gopro-telemetry npm lib". exiftool's `-ee3` reads the whole
  H264 stream for GoPro-unused SEI — `-ee` would have sufficed.
- GPS9 (Hero11+) fix/hdop live in `value[7..8]`, not sticky — `extractGoproPoints`
  leaves them null for GPS9 until tested (only GPS5 Hero5/Hero10 verified).
- A dotted/hidden cache filename (`.<file>.gpxcache.json`) was considered and
  **dropped** — kept the visible `<file>.gpxcache.json`.
