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

### 0. The OLD version's stress-test is RUNNING in the background  (don't rerun if alive)

The previous tool `~/bin/gopro-gpx.js` (exiftool-based, the version *before* this
repo's rewrite) was launched on `/Volumes/ZS14T2025/p/20260211-ski` as a
real-data stress test ("跑個挑戰一點的實測看有沒問題") and **was still running at
handoff** as a detached background process:

- **Process** (at handoff): `node` pid **17801** (Bash-tool wrapper zsh 17798).
  It's a session leader with **no controlling TTY**, so leaving Claude / closing
  the terminal does not SIGHUP it; on Claude exit it reparents to launchd and
  keeps running. (Residual risk: if the harness force-kills tracked tasks on quit
  it would die — unverified.)
- **Log** (durable, on disk): `~/zordius-ai/scratch/run2026.err` (and `.out`).
- **Output**: writes the aggregate GPX to its cwd `~/zordius-ai/*.gpx`, but ONLY
  at the very end — partial progress is not saved, so it must run to completion.
- Progress at handoff: ~66 of 124 — **`j` (Hero5) only**; reached the j-root
  stitched products (`20260211-j.mp4` … → `no GPS, skip`). **Had not reached `z`
  (Hero10 GX)** or written its final GPX. Clean: 0 errors; 3-day grouping correct
  (`20260211/12/13-GOPR`: 13 / 36 / 17).

**Resume:**
```sh
pgrep -fl gopro-gpx.js                 # still alive?
ps -o pid,ppid,stat -p 17801           # PPID 1 = reparented to launchd, survived
tail -f ~/zordius-ai/scratch/run2026.err   # watch progress
ls ~/zordius-ai/*.gpx                   # appears only on completion
```
- If **alive** → let it finish; do NOT rerun. Then review it completes through
  `z` cleanly and check the aggregate GPX.
- If **dead** → rerun `node ~/bin/gopro-gpx.js /Volumes/ZS14T2025/p/20260211-ski`
  (writes GPX to the current directory).

Note: this old version has no probe gate, so it fully extracts the huge stitched
files just to skip them — slow. The new `gpx-from-gopro` is meant to replace it,
so weigh whether finishing the old-version validation is still worth it vs. just
running item 1 below.

### 1. Validate the NEW gpx-from-gopro on full real data  (the main remaining item)

Run the CLI on the real ski footage and sanity-check the output:
```
cd ~/zrepos/gpx-stabilizer
node src/gopro-cli.js /Volumes/ZS14T2025/p/20260211-ski --out /tmp/gpxout
```
Check:
- **Stitched products skipped cheaply** — files like `20260211-j.mp4` (no GPMF
  track) should log `no GPS track, skip` via the probe (not a slow extraction).
- **Grouping** — one `<YYYYMMDD>-GOPR.gpx` per day for the `j` camera (Hero5),
  one `<YYYYMMDD>-GX.gpx` per day for `z` (Hero10). The trip spans 2026-02-11/12/13.
- **Fields present** — trkpts carry `ele` (MSL), `time`, `speed`, `fix`, `hdop`;
  validate with `xmllint --noout <out>.gpx`.
- The slow external drive makes this take a while; the cache makes a rerun cheap.

Was blocked during the build session because the old `~/bin/gopro-gpx.js` batch
was running on the same dir and held the slow drive — check `pgrep -f gopro-gpx.js`
is clear first.

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
