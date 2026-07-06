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

## Core vs GoPro/IMU module — the placement rule *(decided 2026-06-30)*

Which tier a capability belongs to is decided by **one question**:

> **Can pure GPS geometry separate signal from noise for this decision?**
> - **Yes → core** — a clean geometric answer (a drop, a signal, a coarse split).
> - **No, it hits the "noise is noise" wall → GoPro/IMU module** — a decision one noisy GPS
>   channel cannot make robustly needs an *independent physical witness* (the IMU); it is a
>   deferred, GoPro-only module behind the aux / `finalize` seam (see the module-model section),
>   **never** the base.

This is the vertical-analysis meta-conclusion (below) promoted from a *finding* to the **placement
criterion**: on steep terrain every portable geometric method fails because a single noisy channel
cannot tell its own noise from real signal, and only an independent measurement breaks it. The same
logic settles every core-vs-module question. **Shape: core proposes from geometry; the IMU witnesses
when geometry is ambiguous** (the "witness, not reconstructor" model — [`docs/gpmf-sensors.md`](docs/gpmf-sensors.md)
§7). So a feature often **splits** across the boundary — the geometric half is a core signal, the
disambiguation is a GoPro witness.

Worked placements (decided 2026-06-30):

| concern | geometry enough? | tier |
|---|---|---|
| implausible-motion drop (activity envelope) | yes — the union box | **core** |
| powered-vehicle envelope (car / moto / train / sail) | yes — clean GPS (open sky, rigid mount) + distinctive envelope; IMU adds ~nothing | **core** — one merged box, "one mod" |
| `carve` geometric signal (S-arc density) | yes | **core signal** (already in `profile.js`) |
| carve **real-vs-spike** decision | **no** — a gentle-carve spike looks geometrically like a real arc | GoPro (#1 centripetal `ACCL`) |
| lift vs descent — coarse split | partial — `vspeed` sign only | **core** (coarse) |
| lift vs flat-skate / catwalk (is self-power present?) | **no** — poling micro-motion is sub-1 Hz, below GPS | GoPro (#12 vibration) |
| teleport-kill · elevation-noise fusion · obstruction | **no** | GoPro (#2 / #9 / #3 / #7) |

**Strategic payoff — this is what lets core converge.** When core owns only what geometry resolves
cleanly, its definition-of-done is **bounded and finishable**; the open-ended, chase-forever work
(carve-confirm, lift, elevation fusion) all lives behind the witness seam. Generalising ski (below)
is the same move: it pulls ski's hard part out of *core's* scope.

**Carve tier correction.** [`docs/core-ski-split.md`](docs/core-ski-split.md) defers "`carve`"
wholesale to ski-stabilizer. Under this rule that over-reaches: the carve **signal** is pure geometry
and stays in core (it already lives in `profile.js`); only carve's **drop/decision use** is deferred
(it needs the IMU witness). Read that doc's "defer carve" as "defer carve's *judgement use*, not the
signal."

**Carve is not ski-specific — generalise it.** `carve` measures **sustained, alternating-arc
(S-swing) density** — a pure-geometry signature of *rhythmic turning*, of which a ski carve is only
the most typical source. Two general uses (both core, both portable):

- **Real-turn-vs-spike for any arc sport.** The role it plays in ski `despike` — "is this sharp turn a
  legitimate arc or a GPS spike?" — applies unchanged to snowboard, longboard / skateboard, surf /
  wakeboard, MTB flow & berms, motorcycle twisties, inline slalom, and to **zigzag** patterns
  (sailing tack/gybe, autocross/cone slalom): a turn that is part of a rhythmic arc run is likely
  real, an isolated reversal is likely noise.
- **A stage-2 segmentation input.** Per-point `modes` is non-discriminative, but carve is a *temporal*
  signature: **high carve = actively working the terrain** (carving descent), **low carve + descending
  = a straight glide** (catwalk / schuss / road). Paired with the `vspeed` sign it is the core-side
  geometric input that the lift/activity segmentation needs — it supplies exactly the "is the rider
  *doing* something while descending?" axis that `vspeed` alone cannot.

Limits: carve detects **alternating** arcs, not a single sustained curve (a highway ramp / roundabout
/ lone hairpin is `straight`/`turn`'s job, not carve); and the arc wavelength must be resolvable at
the sample rate — broad multi-second ski carves are fine, **tight sub-second slalom aliases** at ~1 Hz
GPS. As a position-geometry signal it is portable (core), but coarse; the real-vs-noise *confirmation*
in ambiguous cases still wants the IMU witness (#1).

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
- **block 3 `kinematics`** — the **planar (x/y) derivative tower** of position. Physics-named, each
  order the same shape `{ vec, dir, mag }` (2-D vector, unit heading, magnitude):
  - `velocity` = Δ(x,y) / Δt (m/s) — `mag` is *horizontal* speed, `dir` the heading.
  - `acceleration` = Δvelocity / Δt (m/s²) — the 2nd derivative; `[0]` is the zero vector.
  - (A `jerk` order would slot in identically, but 3rd-order differences of 1 Hz GPS are dominated by
    noise, so it is intentionally not computed.)
- **block 3b `verticalRate`** — vertical speed `vz = Δel / Δt` (m/s), the **separate vertical axis**.
  **The B decomposition (2026-06-29):** GPS horizontal and vertical errors are different processes
  (VDOP ≈ 2–3× HDOP) and horizontal is a 2-D coupled curve, so the tower is horizontal-only and the
  vertical is its own 1-D axis — *not* folded into a 3-D vector (which would mix the two noise scales;
  that 3-D `mag` was why the old `activity` `accel` bound had to be "kept generous"). The vertical's
  natural parameter is the *cleaner* horizontal distance — the along-track **grade** (Δel / planarStep)
  and its physical bound live in the (upcoming) vertical analysis, not here.

### Layer 3 — `profile.js` (window-level descriptors)

For each point, summarise its ±window neighbourhood. **Owns all tuning `PARAMS`.** Built on a
`measure` bundle. Prefix-sum scans (`cu`, `cps`, `cpath`) keep the windowed stats O(1)/point.

| descriptor | window | meaning |
|---|---|---|
| `hs`, `vs` | ±SW (smoothed) | horizontal / vertical speed |
| `straight`, `steady` | ±SW | path straightness / speed steadiness |
| `maDist` | ±SW | distance off the moving-average line (jitter) |
| `netsp`, `netd150`, `netdShort`, `straightLong`, `straightShort`, `wander` | ±NET_WIN / ±NETD_WIN / ±NETD_WIN_SHORT | net speed, net displacement (long + short window), net displacement / path length (long + short window), direction variance |
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
| `drift` | compute | low-movement scatter (jitter while near-stationary) — the dominant garbage source (~92 % of drops on the 42-workout corpus) |
| `despike` | compute | **nothing — detection-only signal** (`point.despike.flagged`); see below |
| `badspan` | post-assemble | every point inside a dense bad-region: a glue **decision** over quality-drop + `despike.flagged` density (analyze.js `glueBadSpans`), not a per-point detector |

**`despike` is detection-only (option C, 2026-06-29).** It emits a `flagged` SIGNAL, never a `dropReason`. On its own despike is a weak/noisy proxy for `drift` (EDA: Jaccard 0.12 vs drift, same signal correlations, ~98 % of its old sole-drops were isolated curve false-positives), so an **isolated** flag must not drop a point. Instead the flag feeds the `badspan` density: a **dense** region of flags still glues into a dropped bad span (despike's real value — catching blobs of garbage `drift` misses), while a lone flag only contributes density and survives. Net on the 42-workout corpus: dropping 12.0 % → 10.6 % (5,039 isolated false-positives kept), `badspan` reach unchanged.

**Policy vs quality drops — a distinction two bugs missed the same way (found + fixed 2026-07-05).**
`oversample`/`noTime` are *policy* drops (deliberate thinning/structure, not a quality problem);
every other reason is a *quality* drop (a real gap — see `POLICY_DROPS` / `isQualityDropped` in
`analyze.js`). Two consumers of the point stream treated ANY `dropReason` as equivalent, silently
letting policy drops leak in as if they were real gaps — same root cause, two different symptoms,
both found on the same real clip (`GX065132.MP4`, a Hero10 source: raw ~10 Hz GPS5,
`oversample`-thinned to ~2 Hz survivors, so a policy-dropped point sits between nearly every
survivor):

- **`glueBadSpans`'s density denominator** counted every `time != null` point, including the
  policy-dropped raw duplicates — diluting a window's flag density ~10× and keeping `badspan` from
  firing even when every survivor in the window was quality-flagged. 0 → 12 points glued after the
  fix (`isPolicyOnlyDropped`, excludes them from the density population entirely, not just the flag
  count). See [`docs/gpmf-sensors.md`](docs/gpmf-sensors.md) "#6" for the investigation that found it.
- **`view.js`'s clean-line break (`splitAtDrops`)** cut the line at *any* `dropReason`, so a
  policy-dropped point between two survivors shattered the clean line into one-point runs — each a
  lone, invisible `M` with no connecting segment (the interactive viewer's clean line silently
  failed to render, no hover, no visible line — the bug that prompted this investigation). Fixed by
  skipping policy-only drops instead of breaking the run on them.

Both are regression-tested (`analyze.test.js`, `view.test.js`) and confirmed on `GX065132.MP4`. The
general lesson: **a policy drop is not a real gap — every point-stream consumer that reasons about
"is this point missing/absent" needs to ask *why*, not just *whether*.** Grep `dropReason` (or
`p.dropReason`) for a truthy-only check before adding a new one.

**`drift`'s window scale mismatch on a short clip — found, fixed, then corrected again
(2026-07-05/06), same investigation.** `drift`'s only compactness check, `netd150` (±NETD_WIN,
150 s), clamps to the whole clip on anything not much longer than that — so on a 33 s clip every
point's "net displacement over ±150 s" is really "net displacement over the whole clip," diluted by
real motion far outside any actual stay. On `GX065132.MP4`'s tail (the same erratic, "stopped but
wandering" span the policy-drop bugs above were found on) this undershot the 100 m cutoff by a hair
(102 m) purely from a fast descent 15+ seconds earlier in the same clip, so `drift` never fired
despite `wander`/`vs` both already reading compellingly drift-like.

- **First attempt (shipped, then reverted) — a second, much shorter net-displacement window
  (`netdShort`, ±NETD_WIN_SHORT, 15 s), gated on `hs` already being slow (< 2 m/s).** Confirmed on
  `GX065132.MP4`: 0 → 16 points glued into one 7.5 s drift segment. **Real-corpus use (2026-07-06)
  found this floods false positives**: on a real ski-day recording, a person walking away from a
  chairlift — decelerating smoothly to a near-stop, then resuming — tripped the gate for its entire
  ~47 s span, because at a 30 s window scale neither part of the gate is actually restrictive (human
  walking pace is under 2 m/s; 100 m of net displacement is not "compact" over just 30 s). Scanned
  the whole file: 481 → 3,970 drift-dropped points (8×), spanning ~25 segments across the entire
  recording, not an isolated case.
- **Root cause: `hs`/`netdShort` never measured "messiness."** `wander` (heading circular variance)
  weighs every step equally regardless of how much *extra* distance a detour/spike/loop cost
  relative to the progress it bought, so it can't tell a real (if slow) walk from GPS noise
  scribbling in place — both can show "low speed, high heading variance, small net displacement" at
  this window scale.
- **Fix — `straightShort`: net displacement / path length over the SAME ±NETD_WIN_SHORT window**
  (added to `profile.js`'s `windows()` block, reusing the same window bounds `netdShort` already
  computes). GPS noise while stationary inflates path length far more than net displacement (ratio
  → 0); a real walk — even slow, even pausing — keeps a meaningful fraction of its path length as
  net progress (ratio stays well above 0). Replaces the `hs`/`netdShort` gate entirely — no separate
  speed gate needed, since a real fast carve's `straightShort` never approaches the cutoff either
  (empirically >0.8 throughout, `gpx_eval/straightshort_scan.mjs`).
- **Threshold trade-off, resolved by explicit choice, not tuning:** `isDriftShort` also still
  requires the pre-existing `flat(k)` gate (`wander > 0.5 && |vs| < 0.2`) — and restricted to points
  where THAT holds too, the original `GX065132.MP4` sample's reachable `straightShort` floor (0.298)
  turned out to sit right on top of the reported false positive's own floor (0.289): no single
  threshold separates these two specific real, ground-truthed cases. Chose `DRIFT_STRAIGHT_SHORT =
  0.2` — this **no longer catches the `GX065132.MP4` sample** (already marked PARTIAL/weaker
  evidence in `docs/gpmf-sensors.md` #1/#6) in exchange for cleanly excluding the false positive AND
  correctly keeping the clearly-genuine long stays in the same corpus scan (8 segments with
  `straightShort` down to 0.004–0.13, vs. the excluded real walks at 0.24+) — a real, irreducible
  ambiguity at this timescale between "paused briefly while walking" and "GPS drifted while
  stationary," not a tuning miss (echoes the earlier-flagged "低速時所有訊號可能被同時污染" concern).
- **A run relying only on the short window still gets its own, much lower duration floor**
  (`DRIFT_MIN_SHORT`, 2 s default) — the existing 30 s floor exists because the long window's
  compactness alone is a weak tell over a couple of samples, but requiring 30 s here would defeat
  the short window's purpose entirely. A run the long window ALSO confirms keeps the original 30 s
  floor unchanged.

**The long window had the identical blind spot — found and converged onto the same fix
(2026-07-06).** A real, ground-truthed switchback (walked exactly once, confirmed by the user's own
memory of the route; its point-to-point path was checked directly and has zero self-intersections —
`gpx_eval/tangle_verify.mjs`) still tripped the long window's ORIGINAL plain `netd150 < 100` check,
for exactly the same reason `hs`/`netdShort` was wrong at the short scale: a single clean fold nets
little displacement over ±150 s the same way genuine wandering-in-place does — `netd150` alone can't
tell "folded once, cleanly" from "never really went anywhere."

- **Fix — `straightLong`: the same net-displacement/path-length ratio as `straightShort`, computed
  over ±NETD_WIN (150 s) instead of ±NETD_WIN_SHORT.** Added to the SAME `windows()` block, reusing
  `netd150`'s own window bounds and the path-length prefix sum already built for `straightShort` — no
  new O(n) work. `isDriftLong` now checks `straightLong < DRIFT_STRAIGHT_LONG` (default 0.2, same
  value as the short window) in place of `netd150 < 100`; `netd150` itself is unchanged (still
  exposed on points, still `straightLong`'s numerator).
- **Can't just drop the long window and use only `straightShort` — checked, not assumed.** The two
  windows aren't redundant even sharing one discriminant: `gpx_eval/onewindow_check.mjs` found the
  long window catching 1,864 real points on one corpus file, of which 78 % (1,453) `straightShort`
  never dipped below 0.2 for at all — a person can be genuinely stuck in one small area for minutes
  while any given 15 s slice of that time looks like plausible local movement; only the wider window
  reveals they never actually left. Symmetric to why the short window exists at all (a real short
  stay gets diluted away by real motion in the long window) — each scale catches a real pattern the
  other structurally cannot see.
- **Same trade-off shape as the short window, not a tuning coincidence:** restricted to points where
  `flat(k)` holds, the switchback's own reachable `straightLong` floor (0.207) sits right at the
  0.2 line — one confirmed real case on each side of the exact same cutoff, at both window scales,
  from two unrelated investigations. Reinforces that 0.2 is a deliberate, documented choice (drop a
  weaker-evidence catch, keep a confirmed false positive out), not a number discovered by hunting for
  a gap in the data — there isn't one, at either scale.

### Module model — multi-sensor & reconstruction extension *(proposed, 2026-06-28)*

**Status: the `finalize` phase is IMPLEMENTED (2026-07-04); `aux` threading (flavor B) and the
cross-module reconciliation helpers (e.g. a `removeDrop`) remain proposed** — added when a consumer
needs them. Today a module exports `repair` / `label` / `compute` / `finalize`. Two
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
- **`finalize(out, ctx)` — a 4th phase (the customizable final stage). IMPLEMENTED (2026-07-04).**
  Runs **after assemble** (and after `badspan`), over the fully-assembled points (every `dropReason`,
  signal; `aux` once threaded). Unlike `compute` (modules independent), `finalize` modules run
  **sequentially and see each other's results** — the home for cross-module **reconciliation** (un-drop
  a `stray`/`outlier` false positive when IMU shows real motion — there is otherwise no `removeDrop`),
  **reconstruction** (reposition / smooth `ele`), **segmentation** (label lift/run then feed
  per-activity output-smoothing), and the planned **drop → keep/reposition** decision. Built in
  `analyze.js` as a mutate-in-place loop over any `finalize`-exporting module; no built-in uses it yet,
  so base `stabilize` is unchanged. The reconstruction/segmentation tiers become `finalize` modules.
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

### Activity envelope — the additive-power model *(decided 2026-06-30)*

The per-vehicle boxes above are the *implementation*; the **reasoning model** behind which envelopes
are legitimate is **additive power** — at any instant the available power is a sum, not a category:

```
available power = human (weak, ever-present floor) + gravity (variable, slope-dependent) + engine (present / absent)
```

- **human** — the weak floor any moving person has; walking/running is its full-power form.
- **gravity** — dominates on a slope (drives ski / board / MTB to ~35 m/s, `vspeed` to −8); absent on
  the flat.
- **engine** — raises top speed to ~95 m/s on the ground, or opens the airborne envelope.

Orthogonal to power is the **離地 / airborne** axis (`alt` + `vspeed` reach), which only the airborne
group opens. Consequences:

- **Ski is bimodal, not a special case.** Slope present → the gravity high-speed end; slope
  insufficient → it falls back to the weak-human floor (≈ a clumsy walk — *"when gravity is
  insufficient, the signature is weak human power"*). Its box is the **union** of the two ends, which
  the current numbers already cover (`hspeed 0–35 ⊃ walking 0–2.5`, `vspeed ±8 ⊃ walking ±1`), so
  **stage-1 needs no numeric change** — the model just stops treating ski as a snowflake, which is what
  lets core converge.
- **Powered ground vehicles merge into one box. IMPLEMENTED (2026-07-01).** `driving` + `rail`
  (+ motorcycle / sail) overlap heavily; for core's only decision (drop-if-outside-*all*) a single
  "powered ground vehicle" box suffices — the "one mod" finish. Built as the `powered` activity in
  `mods/activity.js` (union of the old `driving`+`rail`: `alt ≤4500 · hspeed 0–95 · vspeed ±3 ·
  accel 0–10 · turn 0–2.0`), replacing both names in `CORE_DEFAULT`. *Cost (per the coupled-box rule):
  a merged box widens the cross-axis corners, admitting a few high-speed ∩ high-accel ∩ sharp-turn
  spike-corners the separate boxes reject — but `outlier` / `despike` / `stray` catch those anyway
  (defense in depth).*
- **The four power-classes are also the stage-2 category space.** human / no-engine-gravity /
  powered-ground / airborne are the coarse classes a future contextual **commit**
  ([`docs/core-ski-split.md`](docs/core-ski-split.md) stage 2) would resolve a *segment* to — a better
  routing key (for despike profiles, lift handling) than the seven vehicle names, since per-point
  `modes` is non-discriminative (99.7 % of points fit something, most fit 5–6 at once).

**Coverage gap the model exposes.** The current `flight` box requires `hspeed 60–300`, so **slow /
hovering airborne craft — helicopter hover, hang-glider / paraglider — do not fit it**; widen the
airborne group's lower `hspeed` when adding them. Note "離地" is **not directly observable** from GPS
(a low-slow hover ≈ standing still geometrically), so it is *inferred* from the `alt` / `vspeed` /
`hspeed` envelope, never measured.

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
- **Click-to-show-coordinates (2026-07-06).** Zoomed into a panel, a plain click (not a drag-pan)
  shows the clicked point's lat/lon bottom-left. Built from a real need this session: pinpointing
  which real-world spot a drop cluster corresponds to previously meant reverse-engineering pixel
  position → SVG viewBox math by hand (error-prone — got the wrong segment more than once). Each
  panel's `<svg>` carries `data-lat0`/`data-lon0` (the projection centre — `measure.js`'s `project()`
  already computed it, now threaded through `withXY`/`toLayers`/`analyzedLayers`/`analyze()` as an
  extra `.origin` property on the returned array, not a new element, so no existing consumer's
  shape changes) — enough for the inline script to invert a clicked SVG x/y straight back to lat/lon
  (the same formula as `project()`, run backwards), no per-point data needed.

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
  `STRAY_*`, overridable via opts), *not* a `profile.js` PARAM. **`SMOOTH_WIN_M` is the single
  aggressiveness DIAL** — small ⇒ light (keeps noise), large ⇒ aggressive (over-flattens real
  terrain); no universally-right value (it trades noise for fidelity per the source's noise level,
  which — the campaign showed — can't be auto-estimated portably), so it is tuned by testing the
  ends. The method is **sport-agnostic** pure geometry (any descending-slope motion — hiking, MTB,
  ski, driving); core stays sport-independent and does not consult `activity`.
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
- **Adaptive window (future) — it's NOISE-driven, not density (2026-06-29).** A calibration
  sweep against an IMU-fused elevation truth (4 clips, `gpx_eval/oracle_sweep.mjs` — detail in
  [`docs/gpmf-sensors.md`](docs/gpmf-sensors.md) "W-calibration sweep") found the optimal `SMOOTH_WIN_M`
  tracks the **noise level**: clean GPS5 (Hero5) wants ~10 m, noisy Hero10 ~30 m, so the fixed ±30 m
  default **over-smooths clean sources**. Crucially, the driver is **noise = raw-grade-jitter −
  fused-truth-jitter**, *not* raw jitter (high jitter can be real terrain — `GP045136`) and *not*
  density/speed. So a simple density-adaptive formula is **refuted**; an adaptive window needs a
  noise estimate — the GoPro IMU gives it (the #9 path), a portable core would need an `hdop` proxy
  (device-dependent) or a per-source-tier default. Until then, one default (±30 m), overridable via
  `opts.smooth = { SMOOTH_WIN_M: n }`.
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
    handling"), not an `ele` despiker. **A terrain-preserving `ele` despiker now exists anyway**
    (`stabilize` `opts.gradeBound` / `mods/gradeBound.js`, the grade-change bound) for the lone-spike
    case `stabilize` misses — validated to remove impossible spikes without over-flattening.
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

## Vertical analysis — the B-decomposition vertical half (design; pending experiment) *(added 2026-06-29)*

**Status: blueprint — each insight below is designed and to be validated one by one against the
IMU-fused truth (`gpx_eval/oracle_*.mjs`) and/or the human eye (an elevation-profile viewer).**

### Why this exists — "noise is noise"

Distance-domain mean smoothing (above) is a blunt start. The deeper finding (W-calibration sweep,
`gpmf-sensors.md`): **with GPS alone you cannot tell noise from real signal** — the optimal smoothing
is *noise-driven*, and noise can't be measured from one noisy channel (high grade-jitter can be real
terrain — `GP045136` — or noise — `GX065132`). You need **another input**. We have four, three of
them **portable (no IMU)** — and the **human eye** (the project's ultimate criterion; an
elevation-profile render is the 2-D track viewer's missing vertical twin). The IMU-fused elevation is
thereby demoted from "needed" to a **validation oracle**.

After the **B decomposition** (planar 2-D kinematics + a separate vertical 1-D axis — built, see
Layer 2), the vertical analysis is parameterised by the *cleaner* horizontal distance: **grade =
Δel / planarStep**. Its building blocks, each an analog of a horizontal insight (or genuinely
vertical-only):

### 1. Grade-change bound — *local* physical constraint (analog of the turn-rate / `activity` envelope)

Grade can't jump: `|d(grade)/d(dist)| × hs² = vertical acceleration`, which is physically bounded for
any body/vehicle. A grade-change **spike is therefore noise**, regardless of activity. **Speed-adaptive
for free** — the bound lives in *acceleration*, so faster ⇒ tighter grade-change (the thing the failed
per-activity-W tuning tried to do by hand). Use as a **reconstruction target**, not a naive per-point
detector (the 2nd derivative of noisy `el` is itself noisy): *find the `ele` closest to raw whose
grade-change stays within the physical bound everywhere* — removes impossible spikes, preserves
in-bound real terrain (no over-flatten). Bound value = a physical constant (tolerable vertical accel),
not a per-source tuning. **Experiment A done (2026-06-29, `gpx_eval/grade_recon.mjs`, a_max≈1–2 m/s²):
it works as designed and reveals its limit. It PROVABLY preserves terrain — RMS-to-fused-truth stays
≈ raw, where mean ±30 m over-flattens badly (`GP045136`: mean RMS 6.11 m vs grade-bound 1.50 m). But
its jitter reduction is MODEST (2.93→2.73, 2.67→2.26) because it only removes physically-IMPOSSIBLE
grade-change spikes; in-bound noise passes — physics can't tell a small real grade-change from a small
noise one ("noise is noise" again). So grade-bound is a *terrain-preserving despike* (the continuous
form of #2), NOT a full smoother — in-bound noise needs another input (#4 surface, or the IMU #9).
IMPLEMENTED as `mods/gradeBound.js` + `stabilize`'s `opts.gradeBound` (the campaign's one validated,
portable keeper — the iterative curvature clamp; `GRADE_AMAX` default 1.5 m/s²).**

### 2. `ele`-outlier — *local* single-point spike (analog of `outlier`)

`outlier`/`stray` test x/y only, so an `ele` spike survives `stabilize` (the documented gap). The
vertical analog of `outlier`'s 3-point detour: a point whose `ele` detours from the local line is an
`ele` spike → drop (or correct). Fills the gap a mean smoother can't (a mean barely dents a lone spike).

### 3. Vertical `maDist` = a *portable noise estimate* (split the 3-D `maDist`)

`profile.maDist` is the distance off the moving-average line (currently a 3-D x/y/el blob). Split it
into **horizontal** and **vertical** jitter; the **vertical** jitter (Δel off the smooth line) is a
*portable, runtime* estimate of the `ele` noise level — the missing input the noise-driven adaptive
window needs (≈ the `raw − fused` the IMU gave us, without the IMU).

### 4. Terrain-surface self-consistency — *global* constraint (genuinely vertical-only; no horizontal analog)

For non-flight movement the terrain is a **single-valued surface `z = f(x,y)`**: the track passing the
*same* (x,y) twice **must** read the same `ele`; a mismatch is noise. Unlike 1–3 (local), this is a
**global** self-consistency check — and **strongest for repetitive activities** (ski laps revisit each
(x,y) many times → a clean terrain model by robust vote; deviations = noise). Caveats: **gate on
non-flight** (`activity` classifies it; exclude jumps/airtime); a **robust vote, not hard equality**
(bridges / overpasses / multi-level are rare legitimate exceptions); "same (x,y)" means *near* in the
horizontal-noise radius — and the `ele` **spread among near-coincident points is itself a noise
estimate** (complements #3). **Needs revisits** → a single down-run has few; exploit it by assembling a
**multi-lap day** (the 18-chapter Hero5 day). No horizontal analog — horizontally, revisiting a point
is normal; only the vertical is locked by the surface.

**Experiment B done — FAILED on steep terrain (2026-06-29, `gpx_eval/surface_b.mjs`).** The full Hero5
day (9 chapters, 11 237 survivors) has only 27 multi-pass cells; validating the surface-median against
the IMU-fused truth on GP01: **RMS(surface-median − truth) = 4.31 m vs RMS(raw − truth) = 0.42 m** — the
surface is *10× worse* than just trusting raw. Cause: **slope × horizontal-noise confound** — a 12 m
cell on a ~50 % ski slope spans several metres of *real* elevation, so two passes "at the same (x,y)
within the horizontal-noise radius" differ in `ele` mostly because they're at different heights *on the
slope*, not because of vertical noise. So the revisit `ele` spread is **mostly the slope confound, not
vertical noise** (correcting the precheck read). A proper form would need a local terrain **plane fit**
(not bin-and-median) — but even that is limited because the horizontal position is itself noisy on a
slope. **B works on flat terrain; it's confounded exactly where skiing needs it (steep).**

### Experiment order (then one by one)

A) **#1 grade-change reconstruction** — DONE (terrain-preserving despike; in-bound noise passes).
B) **#4 surface self-consistency** — DONE, FAILED on steep terrain (slope×horizontal-noise confound).
C) **#3 vertical-`maDist` noise estimate** — but #1/#4's results predict it inherits the same wall.
D) **#2 `ele`-outlier** — subsumed by #1's continuous despike.

**Is xy noise a portable proxy for z noise? (final check, `gpx_eval/corr_xyz.mjs`).** Physically they
share a source (DOP/geometry — a bad-fix epoch is bad on all axes), so we tested whether the *observable*
horizontal noise predicts the unobservable vertical noise (z-noise = raw − IMU-fused truth). Result:
**`hdop` is useless** (r ≈ 0 on every clip); **horizontal `maDist` is only weakly correlated** with
z-noise — r ≈ 0.35 on clean Hero5 (R² ≈ 0.12), and **≈ 0 on dirty Hero10** (teleports swamp it). Real
but **too weak to be a usable z-noise estimate** (horizontal `maDist` also carries real turning, and each
axis has independent noise beyond the common-mode DOP part). So there is **no portable proxy** for the
vertical noise level.

**Meta-conclusion (2026-06-29, after A+B + the correlation check).** On *steep* terrain (skiing — the
use case) the **portable geometric** methods all hit a fundamental wall: #1 removes only
physically-impossible spikes (in-bound noise is indistinguishable from real small terrain); #4 is
confounded because the *horizontal* position is itself noisy and slope turns that into vertical error;
and xy↔z correlation is too weak (and `hdop` useless) to estimate the noise level. **The one thing that
genuinely separates vertical noise from signal is an independent vertical measurement — the IMU.** So for
ski elevation the IMU is **re-elevated from "validation tool" back to genuinely valuable** (#9), and the
realistic portable base stays **plain mean smoothing + grade-bound despike**, accepting the in-bound
noise. (On *flat* terrain #4 would work — no slope confound.) Lift segmentation remains a precondition.
Acceptance for any future tier: match the IMU-fused truth and/or read clean on an elevation-profile viewer.

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

## Segment / lift segmentation — corpus findings *(added 2026-07-04)*

First data-grounded look at the roadmap's **segment classification / lift handling** precondition,
run on a real multi-day ski corpus (2026-02-11 & -13, GX/Hero10 bodies; `gpx_eval/seg_explore.mjs`
— stabilize each recording, window `vspeed`/`hspeed`/`turn-rate` over ±15 s, segment by
`vspeed`-sign hysteresis, roll up per-episode stats). Consistent across 5 segments / 2 days:

- **`vspeed` SIGN is the robust lift/descent axis.** LIFT always `+`, RUN always `−`, physical both
  ways — confirms the "coarse split = `vspeed` sign" placement (core, geometry-only). This is the
  backbone signal.
- **Low `turn-rate` + steady moderate speed marks a lift.** A cable line is straight (turn
  ~0.3–0.5 rad/s) and steady; a run turns. This is the core-side `carve`/turn input that
  distinguishes a *lift* climb from a hiking climb or slow milling — but it is only meaningful
  **post-stabilize** (raw 18 Hz heading saturates to noise).
- **Must run POST-stabilize.** On raw points, GPS teleports blew `hspeed` up to 594–3286 m/s and
  heading to pure jitter; after `stabilize` (survivors ~1 Hz) both became physical (hspeed 5–16 m/s,
  turn 0.3–1.1). So segmentation belongs at the cleaned/`finalize` position, never on raw points.
- **FLAT is not a real class — it's a residue grab-bag** (base milling + catwalks + transitions):
  erratic `hspeed` (1.3–15.8) and the highest turn. Model **lift** and **descent**; let "neither"
  fall out and sub-classify later (catwalk = straight low-carve descent vs carving run).
- **`vspeed` magnitude is diluted by a measurement artifact, not by skiing.** With a fixed ±0.3 m/s
  "FLAT" dead-band on *raw* elevation, gentle climb/descent leaks into FLAT (a day's total climb ≠
  total descent, the difference sitting in FLAT). Fix: feed the sign test a **detection-denoised**
  `vspeed` (a windowed Δele/Δt the segmenter computes for itself — coarse, throwaway, sport-agnostic),
  and treat FLAT as sustained-near-zero (hysteresis), not a dead-band.
- **Two elevation smoothings — do NOT conflate them, and mind the order.** (1) *Detection-denoise* —
  the cheap internal `vspeed` window above, whose only job is to read the lift/descent structure; it
  never rewrites the shipped `ele`. (2) *Output-smooth* — the final shipped `ele`, which per-activity
  smoothing wants to tune per segment (a lift's monotonic climb tolerates aggressive smoothing; a
  run's real terrain does not). These are different steps: the correct pipeline order is **stabilize
  (drop noise points) → segment (label lift/run off detection-denoised `vspeed`) → per-activity
  output-smooth (keyed on the labels)**. So labeling "this is a lift" *precedes* and *feeds* the
  output-smoothing — the benefit is not lost. The earlier shorthand "segmentation runs post-smooth"
  was imprecise: it runs post-**stabilize**, not post-output-smooth (confirmed — `seg_explore` gets
  clean LIFT`+`/RUN`−` on `stabilize(raw)` with **no** output-smooth, using only its own window).
- **Fragmentation is only at transitions.** Sustained lift/run already appear as clean multi-minute
  blocks; naive per-point thresholding adds ~1-min slivers → wants hysteresis (sustained-sign
  entry/exit) + a minimum-episode + sliver-merge to recover the true ~3–5 min episodes.

**Coarse split — IMPLEMENTED (2026-07-04).** [`packages/core/src/mods/segment.js`](packages/core/src/mods/segment.js),
an opt-in `finalize`-phase module (like `kink`, not a built-in), labels each kept point
`point.segment = { id, type }` (`lift`/`descent`/`flat`) from the sign of a **detection-denoised**
(windowed) `vspeed` with hysteresis + a short-episode merge — the algorithm validated in
`gpx_eval/seg_explore.mjs` against the real ski corpus (reproduces its episode structure exactly).
Thresholds (`SEG_VON`/`SEG_WIN_S`/`SEG_MIN_S`) are first-look guesses, not tuned.

**Still open (follow-ons):** confirm a lift via low `turn` + steady speed (disambiguates a cable-line
climb from a hiking climb or slow milling); a catwalk-vs-carve sub-split within `descent` (high
`carve` = actively working the terrain vs low `carve` = a straight glide); and committing each segment
to the **four power-classes** (human / no-engine-gravity / powered-ground / airborne), not just
lift/descent/flat. `segment` runs **before** any per-activity output-smoothing and feeds it the labels
(see the two-smoothings note above) — though per-activity output-smoothing itself is a separate
negative result (below). This is the core-side half of the stage-2 coarse split
([`docs/core-ski-split.md`](docs/core-ski-split.md)).

**Per-activity output-smoothing — explored, NOT built (negative result, 2026-07-04).** With the
`segment` module in place, explored whether each segment type wants a different elevation-smoothing
window (`gpx_eval/segsmooth_eval.mjs`, across Hero10-GX + Hero5-GOPR + a FitoTrack phone track of the
same days). Findings:
- A first pass *seemed* to show "a descent gets worse when smoothed" (a plateau/upturn that would have
  set a conservative run window) — but that was a **metric artifact**: a fixed 20 m grade baseline is
  under-resolved on fast/sparse descents (~12 m/point) vs slow/dense lifts (~2–4 m/point). Resampling
  each episode to a uniform 5 m grid before smoothing/grading removed it.
- Corrected, across all three sources: grade jitter **decreases monotonically with window for every
  type**, curves roughly parallel (raw→80 m ≈ 3–4× drop); raw noise orders **lift > descent > flat**
  but no type shows a plateau in 0–80 m.
- So grade-jitter gives **no basis for a per-type window** — a single window (the existing `smooth`
  ~30 m) already does most of the noise reduction for all types. The genuine per-type rationale is
  *fidelity* (don't erase a run's real terrain), which is **unmeasurable without ground-truth
  elevation** (GoPro has no barometer; DEM/OSM is future). Same data-limited wall as the roadmap's
  "per-activity smoothing defaults", now with sharper evidence.

**Decision: do not build a per-type output-smoother** on unjustified numbers. `segment` labels stay
useful for other ends (lift-handling in the elevation-reconstruction tier, activity segmentation,
display) — just not for tuning grade smoothing. Revisit only if a fidelity/truth signal appears.

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
