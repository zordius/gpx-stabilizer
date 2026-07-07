# HDOP — what it is, and whether it's usable (device-dependent)

Empirical notes on the device `<hdop>` field: what it means, how it's distributed
across two GoPro cameras, and the key finding that **hdop's usefulness as a quality
signal is device-dependent** — which gates any future decision to wire hdop into
the (today geometry-only) pipeline.

## Data provenance

One 3-day ski trip, **2026-02-11 … 02-13**, two cameras filming the same area:

- **GOPR** = GoPro **Hero5** (GPS5 chip)
- **GX** = GoPro **Hero10** (GPS5 chip)

Merged per-day GPX from `gpx-from-gopro` (the `~/gpx-validate/out/<day>-<fam>.gpx`
files). Analysis was ad-hoc (ephemeral scratch scripts); the numbers below are from
that one trip — treat them as strong indicators, not universal constants.

## 1. Scale & the sentinel

HDOP = **horizontal dilution of precision**: a unitless multiplier for how the
satellite geometry amplifies ranging error. It is **not** a distance in metres.

- `fix="none"` → `hdop = 99.99`, a **sentinel for "no valid fix"**, not a precision
  of 99 m. Filter these out before any hdop statistic.
- GPS5 stores precision as `DOP×100`; the extractor divides by 100. Observed values
  land at 1.2–35, confirming the scale is right (un-divided would be 120–3500). The
  GPS9 (Hero11+) scale is **unverified** — see `export-contract.md`.

## 2. Distribution — GOPR is clean & stable, GX is poor & day-variable

Good-fix (2d/3d, hdop < 99) percentiles and tail shares:

| day | cam | p50 | p90 | p99 | ≥2 | ≥3 | ≥5 | ≥10 |
|---|---|---|---|---|---|---|---|---|
| 02-11 | GOPR | 1.78 | 2.21 | 5.6 | 18% | 4% | 1% | 0% |
| 02-11 | GX | 2.99 | 6.5 | 35.8 | 85% | 50% | 14% | 5% |
| 02-12 | GOPR | 1.57 | 2.08 | 4.2 | 13% | 3% | 1% | 0% |
| 02-12 | GX | 4.55 | 14.2 | 20.7 | 100% | 68% | 47% | 23% |
| 02-13 | GOPR | 1.78 | 2.09 | 4.0 | 27% | 2% | 1% | 0% |
| 02-13 | GX | 3.25 | 6.9 | 23.5 | 100% | 64% | 18% | 3% |

- **GOPR**: a narrow, stable distribution (p50 ~1.6–1.8, p90 ~2.1 every day).
- **GX**: ~1.7× worse at the median **and** a far heavier tail (p99 20–36 vs 4–6),
  and **day-variable** (02-12 was much worse: p50 4.55, 23% ≥10). So a single
  multiplier does **not** map GX onto GOPR — GX degrades disproportionately in poor
  conditions.

## 3. Band structure (GOPR) — 2–3 is spread (transient), ≥3 is concentrated (obstruction)

Splitting good-fix points into bands and measuring **spatial spread** (fraction of
~50 m track cells the band touches) vs **temporal runs** (consecutive in time):

| band | track coverage | cells holding 80% | temporal runs |
|---|---|---|---|
| GOPR 2–3 | 33–52% of track | ~39 cells | long (mean run 240–430 pts) |
| GOPR ≥3 | **4–6% of track** | **4–6 cells** | long (mean run 110–250) |

- **Both bands are temporally continuous** (long runs, ~0% singletons) — that is just
  hdop autocorrelation (once it's bad it stays bad a while). Temporal continuity does
  **not** discriminate the bands.
- The discriminator is **spatial**: 2–3 is **spread across the track** (a general,
  transient drift that happens everywhere); ≥3 is **spatially concentrated** at a
  handful of repeating places — i.e. genuine **sky-obstruction spots**. ≥3 is ~8–13×
  more concentrated than 2–3.

## 4. GX has no knee — hdop is a noise ramp, not a signal

Sweeping the threshold and watching track coverage fall (low coverage = concentrated
= place-bound):

| threshold | GOPR 02-11 | GX 02-11 | GX 02-12 |
|---|---|---|---|
| ≥2 | 35% | 98% | 100% |
| ≥3 | **6%** ← knee | 77% | 90% |
| ≥5 | 4% | 52% | 63% |
| ≥10 | 2% | 31% | 29% |
| ≥15 | 1% | 19% | **9%** |
| ≥20 | 0% | 11% | 3% |

- **GOPR has a sharp knee at ≥3** (35% → 6%): a bimodal distribution = baseline drift
  + an obstruction tail. ≥3 is a clean, meaningful cut = "obstructed place".
- **GX has no knee** — coverage decays gradually (98→77→52→31→11%). **No absolute
  threshold isolates obstruction from the noise floor.** Reaching GOPR-≥3's 6%
  concentration needs ≥20+ on 02-11 (still 11%) but ≥15 on 02-12 — the cut that would
  work is both very high **and** drifts day to day.

## 5. Conclusion — hdop usability is device-dependent

| device | hdop as an obstruction signal? | how to use it |
|---|---|---|
| **GOPR (good chip)** | ✓ reliable — bimodal, clean knee | absolute **≥3**, or a per-track **p97** that auto-adapts (see §6) = obstruction places; handle spatially (drop/flag the zone) |
| **GX (poor chip)** | ✗ unreliable *for spatial obstruction-mapping* — continuous noise ramp, no knee, day-variable; ✓ **revised 2026-07-07 for straight point-quality gating** — see §9 | no fixed cut isolates a spatially-concentrated obstruction band, **and a relative percentile fails too** (no knee — §6); but §9 found a cross-device-validated absolute cut (`hdop≥10`) still usable as a *point-level* quality gate, just not as an *obstruction-place* detector |

The one-line takeaway: **a good GPS chip's hdop has a clean baseline/obstruction split
so a threshold means something; a poor chip's hdop is a continuous noise ramp where no
threshold cleanly separates signal from noise.** Any hdop-based logic must therefore be
**per-device (or per-track-relative), never one absolute set of cutpoints.**

## 6. Percentile method — an adaptive per-day threshold (good chip only)

For a good chip, a **fixed percentile** of each track's own good-fix hdop auto-derives a
per-day obstruction threshold — adapting the absolute cut to the day's conditions while
keeping the band definition ("the worst ~3%") fixed. On GOPR, **p97** lands on the
obstruction knee every day:

| day | p97 → absolute hdop | band share | track coverage |
|---|---|---|---|
| 02-11 | **3.33** | 3.0% | 6% |
| 02-12 | **3.05** | 3.0% | 7% |
| 02-13 | **2.60** | 3.2% | 7% |

The three thresholds **differ** (3.33 / 3.05 / 2.60) yet each pins the band to ~6–7%
track coverage — the same spatial concentration the fixed `≥3` knee gives (§3). Below
p97 the band is still spread (p90–p95 = 11–27% coverage); at ~p97 it snaps to the
obstruction places. So `threshold = p97(track hdop)` self-tunes: a clear day drops the
cut to 2.60, a worse day raises it to 3.33 — more robust than a hardcoded `≥3`.

**This works only because GOPR has a knee.** The same sweep on GX never stabilises (a
relative top-5% gave 31% coverage one day vs 9% another) — no percentile recovers a
place-bound band from GX's noise ramp. So the percentile method is the *adaptive form of
the good-chip case*, not a rescue for poor chips.

## 7. Relation to the pipeline (geometry-only today)

The base pipeline ignores hdop entirely (pure geometry/kinematics). Cross-checking the
geometry drops against hdop on GOPR (Hero5, an 18-file cache run, ~221k pts) showed the
two are independent-but-aligned:

- pipeline quality-drops are **36× more concentrated** on hdop≥2 points than on hdop<2
  (8.7% vs 0.2%); 5.4× even restricted to good-fix points.
- **`drift` ≡ the fix=none garbage**: 100% of drift drops were the 99.99 sentinel —
  drift independently rediscovers exactly what the GPS marked invalid (so it overlaps a
  trivial `fix=="none"` filter).
- **`despike` is complementary**: 61% of its drops have *good* hdop (<2) — geometric
  spikes the GPS itself didn't flag. This is value hdop can't provide.
- spatial/kinematic: poor hdop correlates with **slow/stationary** (26% of <0.5 m/s
  points are hdop≥2 vs ~0% when fast) and with the **base area** (low-altitude band),
  and is heavily clustered (9 cells held 50% of the bad points).

Decision-relevant: if hdop is ever wired into the pipeline, it is only safe as a signal
for good-chip devices (GOPR ≥3 = place-based obstruction) and must be per-device /
per-track. For GX-class devices it adds little over geometry. The geometric modules
(`drift`, `outlier`, `stray`, `despike`) already cover the garbage either way.

**Revised for GX, 2026-07-07 — see §9.** The "adds little over geometry" line above was an
*inference* from the no-knee shape (§4), never checked against an independent ground truth
for GX itself (this section's own cross-checks, §7, ran on GOPR). A later 3-day
GX+Android corpus with a genuinely independent second device found the opposite: `fix`/`hdop`
catches the majority of points the geometric modules miss entirely. §9 has the numbers and
reconciles the two.

## 8. Open

- **GPS9 (Hero11+) hdop scale unverified** (no hardware) — `export-contract.md`.
- **"stationary ∩ hdop≥3 = garbage zone"** the pipeline currently KEEPS: on GX 02-11
  ~6,400 such points exist and only ~5% are dropped today (`view.js`'s `hdop≥3 paused`
  overlay visualises them). Whether to add a hdop-aware drop for these is open — but per
  §5 it would have to be device-aware.

## 9. Revision — cross-device ground truth changes the GX conclusion (2026-07-07)

§4/§5/§7 above concluded hdop "adds little over geometry" for GX-class chips. That was an
**inference from the distribution's shape** (no knee → no clean obstruction-place cut), not
a direct measurement against an independent position reference — §7's own hdop-vs-drops
cross-check ran on GOPR, never on GX. A later corpus closes that gap and revises the
GX-specific part of the conclusion (the GOPR conclusion in §5/§6 is untouched).

### New data

Three days (2026-02-11/12/13) of a **different** trip: GX (Hero10) + a phone
(Android/FitoTrack) recording the **same person, simultaneously** — a genuine independent
position reference, not a proxy. Scripts: `gpx_eval/gx_specific_signal_mining.mjs`,
`gpx_eval/hero5_hdop_check.mjs`, `gpx_eval/lift_straightness_check.mjs` (all ephemeral, not
checked in). Credibility between the two devices was decided per contiguous disagreement
run (not per point, to avoid noise-driven flip-flop), using each side's own quality-drop
flags and a sampling-rate-normalized local-smoothness residual as the tie-break.

### The shape finding replicates — "no knee" is confirmed again

Sweeping the hdop cutoff on this new corpus reproduces §4's exact shape: recall decays
*gradually* with no step, e.g. (bad-point recall / good-point false-positive rate)
1→100%/100%, 3→97.5%/46.5%, 5→84.8%/18.5%, 8→57.4%/10.0%. No knee — §4 was right about the
shape on this corpus too.

### But "no knee" does not mean "no usable threshold" once there's ground truth

Restricted to the points the existing geometric pipeline (`drift`/`outlier`/`stray`/
`badspan`/`activity`) **already misses entirely** (823 cross-device-confirmed-wrong points,
kept as "clean" today), a fixed gate — drop when `fix != "3d"` **or** `hdop >= 10` — catches:

| hdop cutoff | catches of the 823 already-missed points | newly drops of already-fine kept points |
|---|---|---|
| 8 | 83.0% (683) | 10.98% (290/2642) |
| 10 | 82.3% (677) | 7.91% (209/2642) |
| 12 | 82.3% (677) | 5.75% (152/2642) |

And the caught points are genuinely bad, not boundary noise — median cross-device position
error of the caught set is 159 m (mean 733 m, p90 2288 m) vs 4.9 m (mean 18.3 m) for the
points the gate leaves alone. So a continuous, knee-less ramp can still support a real,
validated point-level quality gate — §4's shape observation was correct, but §5/§7's
"therefore it adds little" inference from that shape does not hold once checked against an
independent reference. The two sections were answering different questions: §4 asks "can
hdop find spatially-concentrated obstruction *places*" (no, confirmed again above); §9 asks
"does hdop/fix predict this *point's* position error" (yes, strongly, once you have
something to check it against).

### Still device-specific — confirmed in the OTHER direction this time

§2's "GX is ~1.7× worse than GOPR at the median" already flagged hdop as device-variable.
Re-checked directly on this new corpus's own GOPR (Hero5) file: kept-point median hdop is
**1.77–1.78** (Hero10's kept-point median on the corresponding trip: **5.31–5.78**) — a
~3× gap, consistent with §2's finding but from an independent trip. A `hdop>=10` cutoff
tuned on Hero10 would almost never fire on a Hero5 file (its p90 is only ~2.2), so it is
**not portable across chip generations** — confirming §5's "must be per-device" rule, just
for a *different* reason than §4's "no knee" (here the issue is the whole scale sitting an
order of magnitude apart, not the distribution's shape).

### Shipped

`packages/core/src/mods/gpsQuality.js` — `fix != "3d" || hdop >= GPSQ_HDOP_MAX` (default 10),
self-gates to a no-op when a source has neither field (e.g. this Android/FitoTrack GPX, which
carries no `<hdop>`/`<fix>` tags at all). **Not a core builtin** (same reasoning as `kink.js`'s
existing precedent) — the threshold is chip-specific per the finding above, so it stays an
explicit `opts.modules` opt-in. `packages/gopro/src/telemetry.js` opts in automatically only
when `meta.model === "HERO10"`; every other model (including Hero5/GOPR) is unaffected. See
[`SPEC.md`](../SPEC.md) ("GPS-chip quality gate") and [`TODO.md`](../TODO.md) for the shipped
entry.
