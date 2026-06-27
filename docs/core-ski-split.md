# Core vs ski-stabilizer split (design intent)

Two release tiers, to keep general GPS cleanup from getting entangled with
skiing-specific logic (the two purposes interfere — e.g. "is this sharp turn a
spike or a real ski carve?").

- **core (ship first)** — GENERAL GPS noise removal only. "Good enough":
  under-removing subtle spikes is acceptable and deferred. Must not bake in
  skiing concepts/parameters.
- **ski-stabilizer (later)** — the ski-specific layer (advanced spike removal +
  trajectory reconstruction), where the ski/noise interaction is handled
  holistically instead of leaking into core.

## Audit — general vs ski

**General → keep in core:** `dequantizeTime`, `noTime`, `oversample`, `outlier`
(detour/accel spike), `activity` (multi-activity envelope; skiing is just one
box — drops only motion fitting NO activity), `drift` (stationary GPS drift),
`glueBadSpans` (drop-density garbage glue).

**Ski-contaminated → defer to ski-stabilizer:**
- the reconstruction / smoothing main line (currently in `scratch/`:
  net-progress weighting + slope→carve-radius self-calibration + local model
  selection "is the new line better than the old, per segment");
- the `carve` signal (S-arc density — a pure skiing concept, and currently
  UNUSED by any core drop module).

**Dead → remove from core:** `kink` (label-only, never drops).

## despike — keep in core, but with selectable parameter profiles

`despike` stays in core. It gets **parameter profiles** (same pattern as
`activity`'s `CORE_DEFAULT` + opt-in specials):

- Only the TURN thresholds differ per profile: `DESPIKE_LONE` / `DESPIKE_REV` /
  `DESPIKE_GAP`. The `speed` teleport detector + the `jut` gate are
  activity-agnostic and **shared** across profiles.
- **core/general** profile = more aggressive turn thresholds — cost: ski arcs may
  get flagged/removed (acceptable, core doesn't protect carves).
- **ski** profile = current carve-preserving values (lone 120°, rev 90°).
- All despike thresholds are already `g.DESPIKE_* ?? default`, so profiles are
  pure value sets — ~zero logic change.

### Future: per-activity profile selection (user request, 2026-06-28)

Let users SELECT a profile per activity — walking, driving, etc. — just like ski.
The exact "general" threshold numbers still need picking.

How the activity gets decided is itself a **two-stage** model — and only stage 2
can route profiles:

- **Stage 1 — per-point MEMBERSHIP (what we have now).** `activity` looks at one
  point's instantaneous motion and returns the SET of envelopes it fits
  (`point.activity.modes`); no context, no commitment. Its only decision is
  filter-impossible (fits nothing → drop). Measured across all gpx: 99.7% of
  points fit *something* and most fit **5–6 activities at once** (≈40% fit all
  six) — the boxes are deliberately generous, so `modes` is **NOT discriminative**
  (it can't tell skiing from driving). So you can't route profiles off `modes`
  as-is.
- **Stage 2 — contextual COMMIT (future).** A different kind of computation:
  sequence labelling over a window/segment (HMM/Viterbi or windowed smoothing +
  activity-stickiness transitions). The overlap is only instantaneous; the
  temporal JOINT pattern (e.g. skiing's descend-fast-carve + ride-lift-up cycle,
  sustained ±vspeed swings) DOES discriminate, so a *segment* resolves to "most
  likely this one". This committed per-segment activity is what would drive the
  per-activity profile routing.

**Near-term shortcut:** the user usually already knows the activity, so a MANUAL
activity selection (ski opt-in profile, etc.) is the pragmatic path; stage-2
auto-inference is the fuller future work (ski-stabilizer territory).
