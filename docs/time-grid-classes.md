# GPX time grids: two classes and the repair pipeline

GPX files split into two classes by how `<time>` is recorded. The repair phase
normalises both onto the same downstream pipeline **without a mode flag** — each
repair/decimation mod self-gates on the data.

## Class A — second-aligned (e.g. FitoTrack)

Timestamps are floored to whole seconds, so sub-second fixes collapse onto a
duplicate integer second.

- **`dequantizeTime`** (built): reconstructs each run of identical stamps onto the
  1 Hz grid (forward / back / compress), recording every move in `point.edited.time`.
- **`oversample`**: drops the sub-1 s points dequantize created (the 0.5 s half of
  the +1 s duplicate case) to keep ~1 Hz.

## Class B — sub-second native (other apps)

Timestamps are already distinct fractional seconds.

- **`dequantizeTime` is a NO-OP automatically** — it only fires on runs of
  *identical* timestamps, and Class B has none.
- **`oversample` must NOT decimate** this real data.
- **`uniformizeTime`** (NOT built — deferred) evens out density spikes instead.

## The self-gate: `point.edited`

A sub-1 s point is told apart by provenance:

| sub-1 s point | `point.edited.time` | handled by | class |
|---|---|---|---|
| dequantize artifact (0.5 s half) | set | `oversample` → drop | A |
| native dense fix | absent | `uniformizeTime` → even out | B |

So `oversample` should gate on `gap < 1 s && point.edited.time` (drop only
dequantize's own creations), and `uniformizeTime` acts only on non-edited sub-1 s
points. Each no-ops on the other class → one pipeline, no flag.

## `uniformizeTime` spec (deferred — build against a real Class B file)

Goal (chosen): **keep every point; only even out the timestamps where the local
fix rate exceeds 1 Hz.** Never drops.

- A **dense stretch** = a maximal run of consecutive points whose every internal
  gap is `< 1000 ms` (and not `point.edited` by dequantize).
- Redistribute the stretch's interior times uniformly between its first and last
  time: `t'[i+k] = t[i] + (t[j] - t[i]) * k / (j - i)`; endpoints fixed.
- Keep all points; only `time` moves, via `addEdit`.
- Self-gates: a 1 Hz-or-sparser track has no such stretch → no-op.

## Status

- **Class A: implemented** — `dequantizeTime` + `oversample`, 0.1 s GPX output.
- **Class B: designed, NOT built** — `uniformizeTime` plus the `oversample`
  `point.edited` gate are deferred until a real Class B GPX exists to validate the
  density detection and redistribution against. All 42 sample files are Class A
  (FitoTrack, whole-second, zero fractional timestamps).
