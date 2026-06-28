# gpx-stabilizer — Spec

## Target

**Base feature = remove noise points from a GPX file, and view the result.**
Everything beyond that is an **optional module** enabled on top of the base.

```
in.gpx ──▶ [ base: remove noise points ] ──▶ out.gpx     (default; self-contained)
                   └─▶ optional modules (opt-in) ──▶ richer output / viewer
```

## Principles

- **Base is self-contained** — pure geometry/kinematics on the raw points; no labeling, no OSM, no
  external data. GPX in → cleaner GPX out.
- **Modules are independent & opt-in** — each is a separate toggleable unit. The base never depends
  on a module.
- **Composable** — modules run as an ordered pipeline over a working copy of the points.
- **Zero runtime dependencies**, Node ESM, `node --test`, Biome.

---

## Architecture

Two things ship today: **stabilize** (clean a GPX) and a **viewer** (render tracks to HTML/SVG).
Both are built on a layered pipeline:

```
gpx.js ──▶ analyze.js ───────────────────────────────────▶ enriched points ──▶ stabilize.js ──▶ out.gpx
parse      label → measure → profile → compute-modules        (+ dropReason)     keep un-dropped
                       │         │            │
                  point-level  window-level   noTime · sameTime · oversample · outlier · activity

view.js / html.js ── project points ──▶ layers ──▶ SVG ──▶ HTML viewer
```

### Layer 1 — `gpx.js` (I/O)

Zero-dependency, regex-based GPX 1.1 parse/serialize. `readGpx`/`parseGpx` → `{ segments, meta }`;
`writeGpx`/`saveGpx` reproduce the preserved metadata. A point is `{ lat, lon, ele, time }` (time =
epoch ms).

### Layer 2 — `measure.js` (point-level, parameter-free)

The pure core: every value depends only on a point and its immediate neighbour (O(1)/point, **no
window**, **no tuning params**). Runs over the `valid` sub-sequence (the kept time series), but
projects **every** point so dropped points still get a position.

- **block 1 `project`** — lat/lon → local meters (`x/y`, centre = mean of valid; longitude
  compressed by `cos(lat0)`), elevation interpolated (`el`), time (`t`). **Planar x/y never uses
  altitude.**
- **block 2 `deltas`** — per-step **planar** distance `planarStep = hypot(Δx, Δy)` and `dt` (floored at 1 s).
- **block 3 `kinematics`** — the 3D **derivative tower** of position. Physics-named, each order the
  same shape `{ vec, dir, mag }` (vector, 3D unit direction, magnitude):
  - `velocity` = Δposition / Δt (m/s) — `mag` is 3D speed, `dir` the heading.
  - `acceleration` = Δvelocity / Δt (m/s²) — the 2nd derivative; `[0]` is the zero vector.
  - (A `jerk` order would slot in identically, but 3rd-order differences of 1 Hz GPS are dominated by
    noise, so it is intentionally not computed.)

### Layer 3 — `profile.js` (window-level descriptors)

For each point, summarise its ±window neighbourhood. **Owns all tuning `PARAMS`.** Built on a
`measure` bundle. Prefix-sum scans (`cu`, `cps`, `cpath`) keep the windowed stats O(1)/point.

| descriptor | window | meaning |
|---|---|---|
| `hs`, `vs` | ±SW (smoothed) | horizontal / vertical speed |
| `straight`, `steady` | ±SW | path straightness / speed steadiness |
| `maDist` | ±SW | distance off the moving-average line (jitter) |
| `netsp`, `netd150`, `wander` | ±NET_WIN / ±NETD_WIN | net speed, net displacement, direction variance |
| `carve` | ±SW | S-arc swing density |
| `paused` | derived | `netsp < NETSTAY` — the "not moving" state |

### Layer 4 — `analyze.js` (orchestrator / policy)

`analyze(points, opts)` = **label → measure → profile → compute-modules → assemble**. The per-point
context modules see is the union of the measure and profile bundles. There is **no status field**: a
point belongs to the clean track iff it has **no `dropReason`**.

- **Drop-reason channel**: a dropped point carries `dropReason = { reasonKey: context }` + `dropCount`
  (via `addDrop`). Multiple modules may flag the same point (defense in depth).
- **Two symmetric module phases** — each produces ordinary outputs plus an optional reserved `drop`:
  - `label(point, lastKept)` — pre-measurement, sequential; returns `null | { drop?, ...labels }`. A
    `drop` excludes the point from the projection centre and the time series (position + reasons
    only, no signals); other keys ride on the point as namespaced labels (kept or dropped).
  - `compute(ctx)` — post-measurement, batch; returns `{ [signalKey]: array, drop?: array }`.
    Non-`drop` keys attach as `point[modName][key]`.

### Modules (`mods/`)

A module file exports `label` and/or `compute` (name = filename). Built-ins always run; callers
append via `opts.modules`; `loadModule` resolves a bare name (cwd → npm → internal). Current
built-ins, in order:

| module | phase | drops |
|---|---|---|
| `noTime` | label | points with no timestamp |
| `sameTime` | label | duplicate timestamps |
| `oversample` | label | sub-1 s points → survivors land at ~1 Hz |
| `outlier` | compute | GPS spikes: 3-point geometric detour, or speed-change spike |
| `activity` | compute | physically-implausible motion (see below) |

### Activity classification (`mods/activity.js`)

**Positive listing**: each point is classified into the human-movement activities whose **coupled
kinematic envelope** it fits; matched names attach as `point.activity.modes`. A point fitting **no
enabled activity** is dropped as `implausible`.

- **Coupled boxes, not global per-axis gates** — each activity bounds `alt · hspeed · vspeed · accel ·
  turn` *together*, so only `flight` allows high speed **and** high altitude, etc. The acceptable
  region is the **union** of enabled boxes; a GPS spike (high speed + ~180° reversal + huge
  acceleration) fits nothing.
- **Robust axes carry the call** — `alt`/`hspeed`/`vspeed` (1st order) are the decisive bounds; the
  noisier 2nd-order `accel` bound is kept generous. `alt` uses an **upper bound only** (a low/negative
  altitude is real terrain — e.g. Dead Sea −430 m — or GPS/geoid noise; it never touches x/y).
- **Profile-style enable/disable** — a registry of activities; a `CORE_DEFAULT` name list is enabled
  by default (`walking · running · cycling · driving · rail · skiing · flight`); specials
  (`skydive · coaster`) are defined but opt-in via `opts.activities` (CLI later).
- `paused` (window-level) handles the "not moving" state — not an activity box.

### `stabilize.js` (top-level base feature)

`stabilize(points)` = `analyze` → keep points with no `dropReason` → reduce to plain track points.
`stabilizeTrack` / `stabilizeGpx` apply it per segment and write the cleaned `.gpx`, preserving meta.
**Current scope = noise/outlier removal; smoothing of survivors is not yet implemented.**

### Viewer (`view.js` + `html.js`) — eval rendering module

`toHtmlFiles(files)` / `toHtml(points)` render one or more tracks to a standalone HTML document:
- `view.js` projects points to local-meter `x/y` (north-up) and builds `Layer`s; a layer draws a
  **line** when a `width` is set, otherwise **markers**; a point style (`pointColor`/`size`) draws
  markers on top of the line (reusing its points).
- `html.js` emits **semantic** HTML (no `<div>`): an `<h1>`, a summary `<p>`, then one `<section>`
  per file — each a sticky `<header>` (file-name `<h2>` anchor + overlaid legend) over a
  full-viewport `<svg>`. Each `<svg>` carries the data's bounding-box aspect ratio as a `--ar` CSS
  variable; CSS sizes it to the largest box that fits the real viewport (`vw`/`vh`), so the
  zoom-to-fit is computed in CSS, not baked in. Marker/line pixel size stays constant under zoom via
  `non-scaling-stroke`.

---

## Point-level vs window-level

A useful axis for reasoning about cost and meaning:

- **Point-level** — output depends only on a point or a fixed ±1 stencil (O(1)/point). `project`,
  `deltas`, `kinematics`. Parameter-free; the building blocks.
- **Window-level** — output depends on a ±W neighbourhood. Almost every *descriptor* the system
  exports (`hs/vs`, `straight/steady`, `maDist`, `netsp/wander`, `carve`, `paused`). Lives in
  `profile.js`, which owns the params.

Prefix-sum scans bridge the two: a point-level scan (`cu`, `cps`, `cpath`) makes a window-level
statistic O(1)/point instead of O(W).

---

## Optional modules (roadmap)

Beyond the base + the eval viewer, still to come:

- track smoothing (resample/smooth the cleaned survivors)
- segment classification / lift handling / segment bridging / cluster cleanup
- OSM validation
- temporal activity segmentation (smooth per-point `activity.modes` into activity runs)

## Design notes — per-stage roadmap & open reviews

Working notes on where each pipeline stage is headed. "review" = revisit the design before adding to
it. (Stage numbers match the pipeline diagram: ① label → ② measure → ③ profile → ⑤ compute → ⑥
assemble.)

- **① label phase (done)** — `screen` is now the raw-point **`label`** phase: a module's
  `label(point, lastKept)` returns `null | { drop?, ...labels }`. **`drop` is one reserved,
  core-level label** — it excludes the point from the projection centre and the valid series and
  records a `dropReason`; non-drop keys ride on the point as namespaced labels (kept or dropped), so
  a region filter can either `drop` early (saves measuring points it would discard) or just label and
  let downstream branch. The two phases are now **symmetric**: pre-measure emits **labels + drop**,
  post-measure (`compute`) emits **signals + drop**. Candidate future label modules that need only the
  raw point: **`country`**, and **OSM-provided polygons** (region / area / piste membership). Name
  `label` is settled; flat-vs-namespaced label attachment chose **namespaced under module name** (to
  match `compute`).
- **② measure** — future modules: **not yet known; to discuss.**
- **③ profile** — **to review again.** The window-level descriptor set is inherited from the
  prototype; re-examine which descriptors earn their place.
- **⑤ compute + ⑥ assemble** — **to review again.** Module I/O shape, the per-point vs per-step
  alignment (today each compute module re-aligns itself, e.g. `k = min(p, s-1)`), and the unified
  **label / signal / drop** data model: `drop` is a reserved output of *both* phases; labels (pre-
  measure) and signals (post-measure) are the ordinary outputs; assemble merges all three onto points.
- **Viewer** — still to connect to `analyze`: colour kept vs dropped points, mark `activity.modes`,
  shade by a signal (e.g. `hs`). This is the last mile that makes every signal above visible.

## Reference

Original Python prototype: `old_ski_v1` branch (monolith). This rewrite re-derives a minimal base +
optional modules.
