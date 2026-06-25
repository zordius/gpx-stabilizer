# gpx-stabilizer

Clean noise out of a GPX recording, and view the result. Zero runtime dependencies, Node ESM.

Two features today:

1. **Stabilize** — read a GPX, drop the noise points (duplicate timestamps, oversampling, GPS
   outliers, physically-implausible motion), and write a cleaned `.gpx`.
2. **Viewer** — render one or more tracks to a standalone, browser-viewable HTML/SVG document.

> Scope: "stabilize" currently means **noise/outlier removal** (survivors land at ~1 Hz).
> Smoothing and a CLI are on the roadmap — see [`SPEC.md`](SPEC.md).

## Install

```sh
npm install   # dev only (Biome); the package itself has no runtime deps
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

Noise removal is a pipeline of opt-in-able modules (all on by default): `noTime`, `sameTime`,
`oversample`, `outlier`, and `activity` — the last classifies each point into the human-movement
activities whose kinematic envelope it fits (walking · running · cycling · driving · rail · skiing ·
flight) and drops anything no enabled activity can explain. Enable a special activity:

```js
stabilizeGpx("in.gpx", "out.gpx", { activities: ["walking", "skiing", "flight", "skydive"] });
```

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

## Develop

```sh
npm test            # node --test
npm run lint        # biome check
npm run format      # biome format --write
```

Architecture and design rationale: [`SPEC.md`](SPEC.md).
Original Python prototype: [`old_ski_v1`](https://github.com/zordius/gpx-stabilizer/tree/old_ski_v1) branch.
