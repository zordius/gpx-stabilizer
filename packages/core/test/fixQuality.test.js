import assert from "node:assert/strict";
import { test } from "node:test";
import { compute } from "../src/mods/fixQuality.js";

const ctx = (fix) => ({ n: fix.length, fix });

test("fixQuality: drops a non-3d fix (2d or none), chip-agnostic — no hdop involved", () => {
  const { drop } = compute(ctx(["3d", "2d", "none"]));
  assert.equal(drop[0], null);
  assert.deepEqual(drop[1], { fix: "2d" });
  assert.deepEqual(drop[2], { fix: "none" });
});

test("fixQuality: self-gates to a no-op when the source never populates <fix>", () => {
  const { drop } = compute(ctx([null, null]));
  assert.deepEqual(drop, [null, null]);
});
