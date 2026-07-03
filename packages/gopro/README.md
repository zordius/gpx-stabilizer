# gpx-from-gopro

Extract a GoPro video's GPS telemetry (GPMF `gpmd` track) as merged GPX, or as a render-agnostic
telemetry bundle (points + video metadata + recording UTC anchor + timezone). Node ESM. The MP4 is
streamed through mp4box so multi-GB files never load whole into RAM.

Part of the [gpx-stabilizer monorepo](https://github.com/zordius/gpx-stabilizer); builds on the
core [`gpx-stabilizer`](https://www.npmjs.com/package/gpx-stabilizer) package for GPX writing and
point stabilization.

## Install

```sh
npm install gpx-from-gopro
```

## CLI

```sh
gpx-from-gopro <dir|file.mp4> [...] [--out DIR] [--tz HOURS] [--rate HZ] [--cache-dir DIR | --no-cache]
```

Recurses directories for video files, groups by camera body (serial, falling back to filename
family) + local date, and writes one merged `<YYYYMMDD>-<family>.gpx` per group — within it, points
split into one `<trkseg>` per recording session (keyed on the filename file-number, with a time-gap
split for restarts/dropouts). A per-file extraction cache (keyed by size+mtime+rate) lets a killed
run resume without re-extracting. `--rate HZ` downsamples from the native ~18 Hz; `--tz HOURS`
overrides the longitude-guessed local date.

## Library — telemetry export

A render-agnostic API (telemetry samples + video metadata + recording UTC anchor + timezone) for a
renderer to consume. Full contract:
[`docs/export-contract.md`](https://github.com/zordius/gpx-stabilizer/blob/main/docs/export-contract.md).

```js
import { readGoproTelemetry } from "gpx-from-gopro";

// one call: probe + extract [+ stabilize] + timezone + start anchor
const { meta, points, timezone, startUtc } = await readGoproTelemetry("clip.mp4", {
  rate: 1,            // Hz; omit for native ~18 Hz
  stabilize: true,    // clean the points first (boolean | StabilizeOptions)
});
```

Short-circuits to empty `points` / null `timezone` / null `startUtc` on a video with no GPS track.

Also exported:

- `probeGoproMeta(path)` — cheap moov-only probe (geometry / fps / duration / `hasGps` gate).
- `extractGoproPoints(path, { rate? })` — raw `TrackPoint[]` (native ~18 Hz; `rate` in Hz to downsample).
- `timezoneAt({ lat, lon })` / `timezoneOfPoints(points)` — offline IANA timezone lookup.
- `recordingStartUtc(points)` — `{ startUtc, fix }` from the first good-fix sample.
- `stabilize` — re-exported from the core package for convenience.

## License

MIT
