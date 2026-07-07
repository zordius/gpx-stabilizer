import assert from "node:assert/strict";
import { test } from "node:test";
import { compute } from "../src/mods/gpsQuality.js";

const ctx = (hdop, fix, g = {}) => ({ n: hdop.length, hdop, fix, g });

test("gpsQuality: drops a non-3d fix regardless of hdop", () => {
  const { drop } = compute(ctx([1, 1, 1], ["3d", "2d", "none"]));
  assert.equal(drop[0], null);
  assert.deepEqual(drop[1], { hdop: 1, fix: "2d" });
  assert.deepEqual(drop[2], { hdop: 1, fix: "none" });
});

test("gpsQuality: drops a 3d fix whose hdop is at/over the default threshold (10)", () => {
  const { drop } = compute(ctx([9.99, 10, 50], ["3d", "3d", "3d"]));
  assert.equal(drop[0], null);
  assert.ok(drop[1] && drop[2]);
});

test("gpsQuality: GPSQ_HDOP_MAX overrides the default cutoff", () => {
  const { drop } = compute(ctx([6], ["3d"], { GPSQ_HDOP_MAX: 5 }));
  assert.ok(drop[0]);
  assert.equal(compute(ctx([6], ["3d"], { GPSQ_HDOP_MAX: 7 })).drop[0], null);
});

test("gpsQuality: self-gates to a no-op when hdop/fix are absent (e.g. Android/FitoTrack)", () => {
  const { drop } = compute(ctx([null, null], [null, null]));
  assert.deepEqual(drop, [null, null]);
});
