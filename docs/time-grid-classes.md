# GPX time grids: two classes and the repair pipeline

GPX files split into two classes by how `<time>` is recorded. The repair phase
normalises both onto the same downstream pipeline **without a mode flag** — each
repair/decimation mod self-gates on the data.

## Class A — second-aligned (e.g. FitoTrack)

Timestamps are floored to whole seconds, so sub-second fixes collapse onto a
duplicate integer second.

- **`dequantizeTime`** (built): reconstructs each run of identical stamps onto the
  1 Hz grid (forward / back / compress), recording every move in `point.edited.time`.
  The re-timed sub-second points land at **0.5 s** spacing.
- **`oversample`** (built): drops points closer than **0.5 s** to the last kept
  point (genuine > 2 Hz bursts). This KEEPS the re-timed 0.5 s points AND their
  real 1 Hz neighbours, so Class A keeps every fix (it makes no drops on it).

## Class B — sub-second native (other apps)

Timestamps are already distinct fractional seconds.

- **`dequantizeTime` is a NO-OP automatically** — it only fires on runs of
  *identical* timestamps, and Class B has none.
- **`oversample`** keeps native ~1 Hz jitter (0.9–1.1 s) thanks to the 0.5 s gate;
  it only trims > 2 Hz.
- **`uniformizeTime`** (NOT built — deferred) evens out the remaining sub-second
  density spikes.

## Why a 0.5 s threshold, not an `edited` gate

We first considered gating `oversample` on `point.edited.time` (keep anything the
repair touched). It backfires: keeping the re-timed 0.5 s point makes its REAL
1 Hz neighbour sit 0.5 s after it, so a 1 s gate then drops that real fix —
keeping an estimate and discarding real data.

A flat **0.5 s threshold** avoids this with no provenance needed: it keeps every
point ≥ 0.5 s apart (the re-timed point AND its neighbour) and only discards
genuine > 2 Hz bursts. The same gate keeps Class B's ~1 Hz jitter. Bonus: Class A
now produces zero `oversample` drops, so every clean-line break corresponds to a
visible quality drop (drift / outlier / activity).

## `uniformizeTime` spec (deferred — build against a real Class B file)

Goal (chosen): **keep every point; only even out the timestamps where the local
fix rate exceeds 1 Hz.** Never drops.

- A **dense stretch** = a maximal run of consecutive points whose every internal
  gap is `< 1000 ms` (those that survive the 0.5 s `oversample` gate).
- Redistribute the stretch's interior times uniformly between its first and last
  time: `t'[i+k] = t[i] + (t[j] - t[i]) * k / (j - i)`; endpoints fixed.
- Keep all points; only `time` moves, via `addEdit`.
- Self-gates: a 1 Hz-or-sparser track has no such stretch → no-op.

## Status

- **Class A: implemented** — `dequantizeTime` + `oversample` (0.5 s gate, keeps
  the re-timed fixes), 0.1 s GPX output.
- **Class B: partially** — `dequantizeTime`/`oversample` already behave correctly
  on it (no-op / jitter-safe); `uniformizeTime` is deferred until a real Class B
  GPX exists to validate the density detection and redistribution against. All 42
  sample files are Class A (FitoTrack, whole-second, zero fractional timestamps).
