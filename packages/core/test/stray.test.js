import assert from "node:assert/strict";
import { test } from "node:test";
import { compute } from "../src/mods/stray.js";

// `bulkN` points in a ~100 m blob around the origin, then each entry of `far` added as one point at
// (d, d) — a teleport that far. Projected x/y in metres, as the compute phase supplies.
function ctx(bulkN, far, g = {}) {
  const x = [];
  const y = [];
  for (let i = 0; i < bulkN; i++) {
    x.push((i % 10) * 10); // 0..90 m
    y.push((i * 7) % 100); // 0..99 m
  }
  for (const d of far) {
    x.push(d);
    y.push(d);
  }
  return { x, y, g };
}

test("stray: a far teleport cluster is dropped, the bulk is kept", () => {
  const bulkN = 60;
  const { drop } = compute(ctx(bulkN, [50000, 50000, 50000])); // 3 points ~70 km out
  for (let i = 0; i < bulkN; i++) assert.equal(drop[i], null, "bulk point kept");
  assert.ok(drop[bulkN] && drop[bulkN + 1] && drop[bulkN + 2], "far cluster dropped");
  assert.ok(drop[bulkN].dist > drop[bulkN].thresh, "drop carries dist > thresh");
});

test("stray: a clean track (all within the bulk) drops nothing", () => {
  assert.ok(compute(ctx(80, [])).drop.every((d) => d === null));
});

test("stray: too few points -> no drop (left to outlier)", () => {
  assert.ok(compute(ctx(8, [50000])).drop.every((d) => d === null)); // n = 9 < STRAY_MIN_N
});

test("stray: STRAY_FACTOR tunes the bulk-radius gate", () => {
  const far = [1000]; // ~1 km out — far vs the ~100 m bulk, near vs a generous factor
  assert.ok(
    compute(ctx(60, far, { STRAY_FACTOR: 2, STRAY_FLOOR: 0 })).drop[60] != null,
    "tight gate drops",
  );
  assert.equal(
    compute(ctx(60, far, { STRAY_FACTOR: 50, STRAY_FLOOR: 0 })).drop[60],
    null,
    "generous gate keeps",
  );
});
