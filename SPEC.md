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
                  point-level  window-level   noTime · sameTime · oversample · outlier · stray · activity

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
| `stray` | compute | points far outside the track's spatial bulk (median centre + bulk-radius × factor) — teleport/cluster garbage `outlier`'s single-point detour misses |
| `activity` | compute | physically-implausible motion (see below) |

### Module model — multi-sensor & reconstruction extension *(proposed, 2026-06-28)*

**Status: proposed (not implemented).** Today a module exports `repair` / `label` / `compute`. Two
additions let modules consume **external per-point signals** (IMU / scene / exposure — see
[`docs/gpmf-sensors.md`](docs/gpmf-sensors.md)) and do **final reconciliation / reconstruction**
(rescue a false drop, reposition/smooth — see the elevation-reconstruction contract above), **without
breaking core's zero-dep, source-agnostic, base-is-pure-geometry ethos**. Both stay opt-in; the base
`stabilize` is unchanged.

- **`aux` in the shared ctx (flavor B).** An optional `opts.aux` namespace (per-point-aligned arrays,
  e.g. `{ accl, gyro, scene, exposure }`) is threaded into the compute ctx, so *any* module can read
  an external signal — and *any future* signal (OSM piste, weather, DEM) joins the same way. Core
  stays source-agnostic: the **caller pre-aligns** the side data onto **the analysis grid** — the
  post-label survivors (the points compute/witness modules actually see), **NOT** the raw point
  timeline and **NOT** the resampled export grid (see "Two grids" below). The `gpx-from-gopro` adapter
  aggregates GPMF `cts` samples (RMS/peak, never decimate) into each survivor's interval; core only
  merges, never touches sample rates.

  **Two grids (2026-06-29).** There are two distinct position timelines, and conflating them breaks
  aux alignment: (1) the **analysis grid** — the `oversample`-thinned survivors of *real* GPS fixes,
  where every drop / signal / IMU **witness** runs; (2) the **export grid** — the uniform points
  `resample` *synthesises* for consumers (see the resample contract below). Aux aligns to the **analysis
  grid**: a witness (e.g. ACCL teleport-kill) compares a GPS-derived quantity against IMU, so it needs
  *real* fixes — a resampled point's position is interpolated, its "GPS acceleration" an artefact. So
  witness modules run **before** resample, and `resample` is a pure export-layer regulariser,
  independent of aux. The grid-defining stages (`noTime` / `oversample` / `resample`) own the timeline;
  everything else is computed relative to whichever grid it belongs to.
- **`finalize(out, ctx)` — a 4th phase (the customizable final stage).** Runs **after assemble**,
  over the fully-assembled points (every `dropReason`, signal, and `aux`). Unlike `compute` (modules
  independent), `finalize` modules run **sequentially and see each other's results** — the home for
  cross-module **reconciliation** (un-drop a `stray`/`outlier` false positive when IMU shows real
  motion — there is otherwise no `removeDrop`), **reconstruction** (reposition / smooth `ele`), and
  the planned **drop → keep/reposition** decision. The reconstruction tier becomes `finalize` modules.
- **aux may also ride a module's closure (flavor A).** A module factory `m(acclSamples) → { compute }`
  closes over external data, so a *standalone* aux module (emit own signals / own drops, e.g. the
  validated #2 teleport-confirm) needs **no core change at all** — it's just a user module passed via
  `opts.modules`. Flavor B + `finalize` are for when a module must read aux mid-decision or override
  another module's drop.

So: **everything stays a module** (a file exports any of `repair` / `label` / `compute` / `finalize`);
extraction is the adapter's job (mp4 → `gpx-from-gopro`), analysis stays in core, and the cross-sensor
logic enters through these opt-in seams — core never depends on `gpx-from-gopro` or GoPro libs.

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
**Base scope = noise/outlier removal.** The first *survivor-rewriting* step now exists as an opt-in:
`stabilize(points, { smooth: true })` appends `mods/smooth.js` and exports a slope-stable `ele`
(distance-domain elevation smoothing — see the contract below). The base default is unchanged (raw).

### Viewer (`view.js` + `html.js`) — eval rendering module

`toHtmlFiles(files)` / `toHtml(points)` render one or more tracks to a standalone HTML document:
- `view.js` projects points to local-meter `x/y` (north-up) and builds `Layer`s; a layer draws a
  **line** when a `width` is set, otherwise **markers**; a point style (`pointColor`/`size`) draws
  markers on top of the line (reusing its points).
- **Frame on the kept track.** A layer may set `bbox: true` to opt in as the viewBox driver;
  `analyzedLayers` marks the **clean** track so the default frame is the kept points alone. Every
  layer — raw, drop markers, far `stray` garbage — is still **drawn**, but dropped points never grow
  the frame (so a teleport to null-island no longer shrinks the real track to a dot); pan/zoom can
  still reach anything drawn outside it. `toSvg` falls back to all layers when none opt in, and
  `opts.bbox` is an explicit override.
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

- track smoothing (resample/smooth the cleaned survivors) — **elevation smoothing
  BUILT (`mods/smooth.js`, `stabilize` `smooth`) and uniform-grid resampling BUILT
  (`resample.js`, `stabilizeTrack` `resample`); the IMU-fusion tier still future
  (contracts below)**
- segment classification / lift handling / segment bridging / cluster cleanup
- OSM validation
- temporal activity segmentation (smooth per-point `activity.modes` into activity runs)

## Track smoothing — elevation reconstruction (contract) *(added 2026-06-28)*

**Status: distance-domain elevation smoothing IMPLEMENTED** (`mods/smooth.js` +
`stabilize` `opts.smooth`, 2026-06-29); the resample and IMU-fusion tiers remain
future. Promotes the roadmap's "track smoothing" bullet to a contract. The base
still removes noise *points* and never rewrites a survivor's values by default —
elevation rewriting is strictly opt-in.

### Why (the finding)

A downstream consumer (movie-layers `provider-gopro` / `provider-gpx`) derives a
**gradient** channel as `Δele / horizontal-distance` — which this lib deliberately
leaves to the renderer ([`docs/export-contract.md`](docs/export-contract.md): *gradient
is the renderer's job*). On real ski footage (`GX065132.MP4`, Hero10, 33 s) the
derived grade swings **−39 … +26 %** with heavy frame-to-frame jitter, because
**per-sample GPS elevation noise (±several m)** survives `stabilize`: it drops outlier
*points* but leaves each kept point's `ele` raw. The consumer already averages slope
over a ~20 m horizontal baseline and *still* jitters — a windowed *slope* cannot
recover from a noisy underlying *elevation*. Every consumer would re-implement the
same fix. Elevation truth, and the kinematic context to smooth it (`profile.vs`,
along-track distance), live **here** — so the smoothing belongs here, as the
long-planned opt-in module on the survivors.

### Contract (built — base tier; advanced tier future)

`mods/smooth.js`, a `compute` module over the survivors, with measure/profile context,
producing a **slope-stable elevation**:

- **Distance-domain smoothing.** Smooths `ele` over an along-track **length scale in
  metres** (`SMOOTH_WIN_M`, half-width, default ±30 m), *not* a time/index window — so
  it is robust to variable speed and sample spacing. The module builds its own cumulative
  along-track distance from `measure`'s planar `planarStep` and boxcar-means within ±win
  via an O(n) two-pointer sweep; endpoints use a naturally shrinking window. **As built**
  the param follows the in-module `g.SMOOTH_WIN_M ?? 30` convention (like stray's
  `STRAY_*`, overridable via opts), *not* a `profile.js` PARAM.
- **Guarantee.** Per-sample vertical noise is reduced so grade = `Δele* / Δdist` over
  that scale has **bounded jitter** (small mean `|Δgrade|` per metre), while real
  terrain grade over the scale is preserved (true climbs are not flattened). Verified by
  the proxy eval below.
- **Output shape.** The smoothed series is emitted as a namespaced signal
  `point.smooth.ele` (raw `ele` untouched in-pipeline). The **export** decides what ships:
  `stabilize` stays raw by default (base ethos — removal, not rewriting); **`opts.smooth`**
  appends the module *and* flips the exported `ele` to the smoothed value (adding the
  module alone, via `opts.modules`, only surfaces the `point.smooth.ele` signal — it does
  not swap the export). `stabilize`'s `{lat,lon,ele,time}` shape is unchanged; only the
  *meaning* of `ele` flips when `smooth` is on.
- **Parameters per activity (future).** The length scale should differ by activity
  (ski vs walk); today there is one default (±30 m), overridable via
  `opts.smooth = { SMOOTH_WIN_M: n }`. Per-activity defaults tie into the ski-tier work.
- **Current limitation.** Runs on the post-label valid series, which still contains the
  points the compute-phase drops (outlier/stray/activity) will flag — compute modules are
  independent and don't see each other's drops. Strictly post-drop smoothing awaits the
  proposed `finalize` phase.
- **Precondition / findings (2026-06-29).** Distance-domain *mean* smoothing assumes the input is
  **horizontally clean** — true for clean GPS5 (Hero5), but dirty Hero10 (many `none`/`2d` fixes,
  40–80 m/s teleport spikes) must be `stabilize`d first; vertical fusion can't fix horizontal
  teleports. A full-stack eval (clean → mean / median / trimmed smooth / IMU-fuse, on the same
  survivor grid) then found:
  - **Mean is the right smoother.** A window **median makes a derived grade WORSE** (it snaps to
    sample values → staircase → spikier derivative); a **trimmed mean only ties the mean** (once
    `stabilize` removes the gross spikes there's no lone spike left to trim). A speculative
    `SMOOTH_ROBUST` median option was tried and **reverted**. **IMU-vertical fusion** lowers grade
    jitter best and preserves the clean signal's range, but is GoPro-only (the #9 advanced tier).
  - **The dirty-Hero10 extremes are mostly LIFT GEOMETRY, not `ele` spikes** — a chapter that
    climbs +151 m gives ±300–400 % grade that *no* `ele` smoothing fixes (a real steep climb over a
    short horizontal). So the prerequisite is **activity/lift segmentation** (roadmap "lift
    handling"), not an `ele` despiker. A dedicated `ele`-outlier *drop* remains a candidate only if
    a real lone spike that `stabilize` misses *and* the mean smears ever shows up — none yet.
  Evidence + the IMU oracle: [`docs/gpmf-sensors.md`](docs/gpmf-sensors.md) ("IMU-vertical elevation oracle").
- **Advanced (future, GoPro-only).** GoPro has no barometer (altitude is GPS-derived,
  the noisiest GPS axis); a complementary filter could fuse low-pass GPS `ele` with
  high-pass IMU vertical acceleration to constrain the *shape* between samples — gated on
  plain distance-domain smoothing proving insufficient. Catalogued as candidate #9 in
  [`docs/gpmf-sensors.md`](docs/gpmf-sensors.md) (IMU drift / world-frame caveats there).

### Acceptance

Re-derive gradient on `GX065132.MP4` through the consumer: raw = −39…26 % at high
jitter; smoothed = grade tracking terrain with bounded jitter at a *modest* consumer
baseline. The movie-layers render is the eval harness.

**Proxy eval (done, 2026-06-29)** — `gpx_eval/smooth_eval.mjs` derives grade over a 20 m
baseline on the stabilized `GX065132` track (57 survivors), raw `ele` vs smoothed:

| | grade range | span | jitter (Δ/step) |
|---|---|---|---|
| raw `ele` | −32.8…25.4 % | 58.3 | 2.66 % |
| smooth ±20 m | ±14.2 % | 28.4 | 1.17 % |
| **smooth ±30 m** (default) | −11.8…11.2 % | 23.0 | **0.98 %** |
| smooth ±50 m | −8.0…4.6 % | 12.6 | 0.58 % |

raw matches the contract's −39…26 % / high-jitter; ±30 m cuts jitter 2.7× and span 2.5×
while staying small enough to track terrain (≈3.5 s of skiing).

**True consumer acceptance — PASSED (2026-06-29).** Wired into movie-layers `provider-gopro`
(their commit `cd0ebb8`, smoothing now their default) and re-derived through the real
`gradientSamples` (windowM 20 m) on `GX065132`: gradient **−39.4…26.3 % (raw) → −11.8…11.2 %
(smoothed)** — matches this proxy exactly. The contract's acceptance is met end-to-end, not
just by proxy. (`resample` was evaluated and **not adopted** by that consumer — its per-frame
render + per-channel `maxGap` dim already covers gap handling; resample stays available for
consumers that want hole-splitting.)

### Related finding — `stabilize` drops `speed` — RESOLVED (consumer-side, 2026-06-29)

`stabilize` reduces survivors to `{lat,lon,ele,time}`, so a consumer's **speed** channel
vanishes under `stabilize: true`. **Resolved at the movie-layers acceptance:** the consumer's
own **GPS-derived speed fallback** fires under `stabilize:{smooth:true}` (its `speed` channel
read 0–34.1 km/h, matching the device's 0.3–35.2), so the speed gauge still renders. **The lib
keeps `stabilize` minimal — `speed` is NOT carried through** (base ethos: removal, not
field-widening); a consumer that needs per-sample speed derives it (from positions, or reads
the raw points). The `export-contract.md` §D "revisit" trigger is hereby closed.

## Track resampling — uniform grid (contract) *(added 2026-06-29)*

**Status: IMPLEMENTED** (`resample.js` + `stabilizeTrack` `opts.resample`, 2026-06-29).
The other half of the roadmap's "track smoothing" bullet (elevation smoothing rewrites
*values*; this regularises the *grid*). **Time-domain, with `maxGap` splitting.**

### Why

Every analyse stage is **per-point**: it labels / measures / signals / drops the *existing*
points, so cardinality only ever shrinks and the time grid stays whatever the source gave
(then `oversample`-thinned to an *irregular* ~1 Hz of real fixes). A consumer that samples
the track at its own cadence — movie-layers reading a position at each **video frame**
timestamp — wants a *uniform* grid. Producing one means **synthesising** points
(interpolating between survivors), which changes cardinality and the grid, so it cannot be
a per-point module. It is a **track→track transform** in the export layer.

### Contract

A standalone `resample(points, opts)` exported from core (returns `points[][]` — one or more
segments, since a split can multiply them), wired into **`stabilizeTrack` `opts.resample`**
(NOT the single-segment `stabilize`, because the `maxGap` split is expressed as multiple
`<trkseg>`s — a Track concern), applied **after** drop-filtering and elevation smoothing:

- **Export-layer, last.** Runs on the cleaned (and optionally smoothed) survivors, after
  `analyze` + filter. All drops / signals / IMU **witness** decisions are already settled on
  the **analysis grid** (real fixes); resample only regularises the output. It is therefore
  **aux-independent** (witnesses need real fixes — a resampled position is interpolated; see
  "Two grids" above). `analyze` is untouched — its assemble maps signals back by original
  index, which a cardinality change would break, so resample cannot live inside it.
- **Time-domain.** One output point per fixed Δt (`RESAMPLE_HZ`, e.g. 1 Hz; or a rate set to
  the consumer's video frame rate). Position/ele/(speed) are **linearly interpolated** at each
  grid time from the bracketing survivors. (A distance-domain variant — one point per Δm, for
  elevation profiles — is a future `opts` flag, not built now.)
- **`maxGap` splitting.** Interpolating across a large hole (a dropped bad-span, a stop, a
  GoPro crash break) would **invent** a straight line through missing data. So a gap longer
  than `maxGap` seconds is **not** bridged: the output splits into separate `<trkseg>`s at the
  hole — the same session-boundary semantics as the GoPro adapter's GUMI `<trkseg>` split.
- **Output shape.** Still `{lat,lon,ele,time}` (uniform `time`); cardinality changes. `ele` is
  the smoothed value when `opts.smooth` is also on (smooth → resample order is automatic:
  smoothing is a compute signal, resample reads the exported elevation).
- **Relationship to `oversample`.** `oversample` thins to an *irregular* ~1 Hz by **dropping**
  real fixes; `resample` regularises to an *exact* grid by **synthesis**. With resample on,
  `oversample`'s role narrows to pre-thinning the analysis grid (a fork: keep it for the
  witness grid, or skip straight to resample from the de-duplicated survivors — decide when
  wiring aux).

### Acceptance (done, 2026-06-29)

`gpx_eval/resample_eval.mjs` on `GX065132`,
`stabilizeTrack(track, { smooth: true, resample: { RESAMPLE_HZ: 1 } })`:

| | segments | points | intra-step |
|---|---|---|---|
| cleaned (no resample) | 1 | 57 | {500, 5500} ms (irregular) |
| **smooth + resample 1 Hz** | 1 | 33 | **{1000} ms (strictly uniform)** |
| resample 2 Hz | 1 | 66 | {500} ms |
| + injected 30 s hole | **2** | 33 | {1000} ms |

A strictly-uniform grid; a 5.5 s hole `< maxGap` (10 s) is bridged; an injected 30 s hole
`> maxGap` splits into two `<trkseg>`s rather than a straight bridge. Unit-tested
(`test/resample.test.js`): passthrough, interpolation, `RESAMPLE_HZ` step, gap split vs bridge,
single/empty/untimed, sub-step run. Full core suite 144→146 pass.

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
- **Viewer (connected)** — `analyzedLayers` now splits the analysis into render layers: the clean
  (kept) track, one marker layer per drop reason (`drift` · `stray` · `outlier` · `activity`), and
  device-`hdop` quality overlays (`hdop 2–3`, `hdop ≥3`, plus the stationary-`paused ∩ ≥3`
  "garbage-zone" subset the pipeline currently keeps). Still open: shade the clean line by a signal
  (e.g. `hs`), and surface `activity.modes`. **What hdop means and whether it's usable is
  device-dependent** — see [`docs/hdop-notes.md`](docs/hdop-notes.md) (good chips give a clean
  baseline/obstruction split; poor chips give an unusable noise ramp), which gates any future move to
  wire hdop into the pipeline.
- **Drop → keep / reposition, and where framing rides (direction)** — the drop modules only emit a
  **drop signal**; the eventual reconstruction tier (see roadmap: *track smoothing*) is a later stage
  that decides, per dropped point/run, **discard vs reposition** (move it back onto a plausible line)
  rather than just delete. The viewBox is computed at that **keep decision**: it frames the **kept**
  set only (the `bbox: true` clean layer), while every point — raw, drop markers, far `stray` garbage
  — stays **drawn**. So dropped points never distort the default frame, yet are not lost: the planned
  **multi-level zoom** (zoom-out) is exactly what reveals the off-frame drops for inspection. The
  `stray` module itself was lifted from this work — the bbox-framing garbage detector (robust centre +
  bulk-radius gate) turned out to be a useful drop in its own right, complementary to `outlier`'s
  single-point detour (which misses *clusters*).

## Reference

Original Python prototype: `old_ski_v1` branch (monolith). This rewrite re-derives a minimal base +
optional modules.
