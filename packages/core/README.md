# gpx-stabilizer

Clean noise out of a GPX recording, and view the result. **Zero runtime dependencies**, Node ESM.

Two features: **stabilize** (drop the noise points and write a cleaned `.gpx`) and a **viewer** (render
one or more tracks to a standalone, browser-viewable HTML/SVG document).

> Scope: "stabilize" currently means **noise/outlier removal** (survivors land at ~1 Hz; positions are
> not yet smoothed/repositioned). Trajectory smoothing is the next tier.

Part of the [gpx-stabilizer monorepo](https://github.com/zordius/gpx-stabilizer); to pull GPS out of a
GoPro video, see the companion [`gpx-from-gopro`](https://www.npmjs.com/package/gpx-from-gopro) package.

## Install

```sh
npm install gpx-stabilizer
```

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

## License

MIT
