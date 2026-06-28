# gpx-stabilizer

A monorepo of two npm packages for working with GPS tracks. Node ESM.

- **[`gpx-stabilizer`](packages/core)** (core) — clean noise out of a GPX recording and view the
  result. **Zero runtime dependencies.**
- **[`gpx-from-gopro`](packages/gopro)** — extract a GoPro video's GPS telemetry as merged GPX, or as
  a render-agnostic telemetry bundle (points + metadata + timezone + UTC anchor). Depends on the core
  package plus the GoPro libraries.

Source lives under `packages/core` and `packages/gopro`, wired together with npm workspaces (the gopro
package consumes core via the workspace link, so the two develop together without publishing first).

> Scope: "stabilize" currently means **noise/outlier removal** (survivors land at ~1 Hz; positions are
> not yet smoothed/repositioned). CLIs ship now (see below); trajectory smoothing is the next tier —
> see [`SPEC.md`](SPEC.md).

## Install

```sh
npm install   # at the repo root: links both workspaces, installs Biome (dev) + the gopro package's deps
```

When published, `npm i gpx-stabilizer` pulls **no runtime deps**; `npm i gpx-from-gopro` pulls the
GoPro libraries (and core as a dependency).

---

# `gpx-stabilizer` (core)

Two features: **stabilize** (clean a GPX) and a **viewer** (render tracks to a standalone HTML/SVG doc).

## Stabilize

```js
import { readGpx, stabilizeGpx, stabilize } from "gpx-stabilizer";

// file → cleaned file (preserves track metadata)
stabilizeGpx("in.gpx", "out.gpx");

// or work with points directly
const { segments } = readGpx("in.gpx");
const clean = stabilize(segments[0]); // array of { lat, lon, ele, time }, noise removed
```

Noise removal is a pipeline of built-in modules (all on by default): `dequantizeTime` (spread
duplicate-second timestamps), `noTime`, `oversample`, `outlier` (position / acceleration spikes),
`stray` (points far outside the track's spatial bulk — cold-start / wild-fix teleport clusters that
`outlier`'s single-point detour misses), `activity`, `drift` (stationary satellite drift), and
`despike` (heading + segment-length spikes).
`activity` classifies each point into the human-movement activities whose kinematic envelope it fits
(walking · running · cycling · driving · rail · skiing · flight) and drops anything no enabled activity
can explain. Enable a special activity:

```js
stabilizeGpx("in.gpx", "out.gpx", { activities: ["walking", "skiing", "flight", "skydive"] });
```

### Modes (`core` / `ski`)

A mode bundles per-use-case thresholds. **`core`** (the default) is tuned for **general** tracks: its
`despike` keeps real sharp corners (walking/driving turn legitimately up to ~150°), so it only removes
clear spikes. **`ski`** opts into ski-tuned `despike` thresholds (which also catch the gentler-carve
spikes), the ski-only `carve` signal, and the `kink` overlay. The clean way to select it is the CLI
`--mode ski` (which also loads `kink`); programmatically, pass the params directly:

```js
stabilizeGpx("in.gpx", "out.gpx", { DESPIKE_PROFILE: "ski", CARVE: true });
```

## CLI

```sh
gpx-stabilize FILE.gpx [...]                # → <name>.stabilized.gpx per input (the cleaned track)
gpx-stabilize FILE.gpx [...] --html [out.html]   # → one interactive HTML viewer for all inputs
gpx-stabilize FILE.gpx [...] --png         # → one PNG per input (needs @resvg/resvg-js)
```

Options: `--out DIR` · `--mode core|ski` (default `core`; `ski` = ski-tuned despike + carve + kink) ·
`--config FILE.json` (a full analyze config) · `--disable name,...` (skip built-in modules).

## Viewer

```js
import { readGpx, toHtmlFiles } from "gpx-stabilizer";
import { writeFileSync } from "node:fs";

const files = ["a.gpx", "b.gpx"].map((name) => ({ name, points: readGpx(name).segments.flat() }));
writeFileSync("view.html", toHtmlFiles(files)); // open in a browser
```

Each track renders as one full-viewport panel (sticky title + legend) that zooms to fit the real
window via CSS. A track shows as markers by default; pass `{ width }` for a line, or
`pointColor`/`size` to draw both.

---

# `gpx-from-gopro`

Extract a GoPro video's GPS telemetry (GPMF `gpmd` track) — streamed through mp4box so multi-GB files
never load whole into RAM.

## CLI

```sh
gpx-from-gopro <dir|file.mp4> [...] [--out DIR] [--tz HOURS] [--rate HZ] [--cache-dir DIR | --no-cache]
```

Recurses directories for video files, groups by camera family + local date, and writes one merged
`<YYYYMMDD>-<family>.gpx` per group. A per-file extraction cache (keyed by size+mtime+rate) lets a
killed run resume without re-extracting. `--rate HZ` downsamples from the native ~18 Hz; `--tz HOURS`
overrides the longitude-guessed local date.

## Library — telemetry export

A render-agnostic API (telemetry samples + video metadata + recording UTC anchor + timezone) for a
renderer to consume. Full contract: [`docs/export-contract.md`](docs/export-contract.md).

```js
import { readGoproTelemetry } from "gpx-from-gopro";

// one call: probe + extract [+ stabilize] + timezone + start anchor
const { meta, points, timezone, startUtc } = await readGoproTelemetry("clip.mp4", {
  rate: 1,            // Hz; omit for native ~18 Hz
  stabilize: true,    // clean the points first (boolean | StabilizeOptions)
});
```

Also exported: `probeGoproMeta` (cheap moov-only probe / `hasGps` gate), `extractGoproPoints`,
`timezoneAt` / `timezoneOfPoints`, and `recordingStartUtc`. `stabilize` is re-exported from the core
package for convenience.

---

## Develop

```sh
npm test            # runs `node --test` in every workspace
npm run lint        # biome check (config + Biome live at the repo root)
npm run format      # biome format --write
```

Architecture and design rationale: [`SPEC.md`](SPEC.md). Monorepo layout rationale:
[`docs/monorepo-split.md`](docs/monorepo-split.md).
Original Python prototype: [`old_ski_v1`](https://github.com/zordius/gpx-stabilizer/tree/old_ski_v1) branch.
