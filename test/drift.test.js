import assert from "node:assert/strict";
import { test } from "node:test";
import { compute } from "../src/mods/drift.js";

// ctx with per-point arrays at 1 Hz; `flags[k]` = drift-like point (random heading + flat altitude)
function ctxFor(flags) {
  const n = flags.length;
  return {
    n,
    t: Array.from({ length: n }, (_, i) => i),
    x: new Array(n).fill(0),
    y: new Array(n).fill(0),
    wander: flags.map((f) => (f ? 0.8 : 0.1)), // drift -> high circular variance
    vs: flags.map((f) => (f ? 0.05 : 0.5)), //    drift -> flat (low |vs|)
    g: {},
  };
}

test("drift: a sustained random-heading + flat-altitude run is dropped as one segment", () => {
  const flags = Array.from({ length: 200 }, (_, i) => i >= 40 && i <= 169); // 130 s block
  const { drift, drop } = compute(ctxFor(flags));
  assert.ok(drop[100] && drift[100], "mid-run point is dropped and labelled");
  assert.equal(drop[10], null, "outside the run -> kept");
  assert.equal(drift[100].npt, 130);
  assert.ok(drift[100].dur >= 120);
  assert.equal(drift[100].seg, 0);
});

test("drift: a run shorter than the minimum duration is not dropped", () => {
  const flags = Array.from({ length: 100 }, (_, i) => i >= 50 && i < 80); // 29 s < 120 s
  assert.ok(compute(ctxFor(flags)).drop.every((d) => d === null));
});

test("drift: needs BOTH random heading and flat altitude", () => {
  const n = 200;
  const base = {
    n,
    t: Array.from({ length: n }, (_, i) => i),
    x: new Array(n).fill(0),
    y: new Array(n).fill(0),
    g: {},
  };
  // high wander but climbing (|vs| high) -> not drift
  const climbing = compute({ ...base, wander: new Array(n).fill(0.8), vs: new Array(n).fill(0.6) });
  assert.ok(climbing.drop.every((d) => d === null));
  // flat but steady heading (a glide) -> not drift
  const glide = compute({ ...base, wander: new Array(n).fill(0.1), vs: new Array(n).fill(0.05) });
  assert.ok(glide.drop.every((d) => d === null));
});
