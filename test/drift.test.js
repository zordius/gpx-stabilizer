import assert from "node:assert/strict";
import { test } from "node:test";
import { compute } from "../src/mods/drift.js";

// ctx with per-point arrays at 1 Hz; `flags[k]` = drift-like (random heading + flat + compact)
function ctxFor(flags) {
  const n = flags.length;
  return {
    n,
    t: Array.from({ length: n }, (_, i) => i),
    x: new Array(n).fill(0),
    y: new Array(n).fill(0),
    wander: flags.map((f) => (f ? 0.8 : 0.1)), // drift -> high circular variance
    vs: flags.map((f) => (f ? 0.05 : 0.5)), //    drift -> flat (low |vs|)
    netd150: flags.map((f) => (f ? 20 : 500)), // drift -> compact (went nowhere)
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

test("drift: needs random heading AND flat altitude AND compactness", () => {
  const n = 200;
  const base = {
    n,
    t: Array.from({ length: n }, (_, i) => i),
    x: new Array(n).fill(0),
    y: new Array(n).fill(0),
    g: {},
  };
  const run = (w, v, d) =>
    compute({
      ...base,
      wander: new Array(n).fill(w),
      vs: new Array(n).fill(v),
      netd150: new Array(n).fill(d),
    });
  assert.ok(run(0.8, 0.6, 20).drop.every((x) => x === null)); // climbing -> |vs| fails
  assert.ok(run(0.1, 0.05, 20).drop.every((x) => x === null)); // steady heading -> wander fails
  assert.ok(run(0.8, 0.05, 500).drop.every((x) => x === null)); // moving away -> netd150 fails
  assert.ok(run(0.8, 0.05, 20).drop.some((x) => x !== null)); // all three hold -> drift
});
