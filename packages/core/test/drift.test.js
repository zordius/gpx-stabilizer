import assert from "node:assert/strict";
import { test } from "node:test";
import { compute } from "../src/mods/drift.js";

// ctx with per-point arrays at 1 Hz; `flags[k]` = drift-like (random heading + flat + path-inefficient
// at both window scales)
function ctxFor(flags) {
  const n = flags.length;
  return {
    n,
    t: Array.from({ length: n }, (_, i) => i),
    x: new Array(n).fill(0),
    y: new Array(n).fill(0),
    wander: flags.map((f) => (f ? 0.8 : 0.1)), // drift -> high circular variance
    vs: flags.map((f) => (f ? 0.05 : 0.5)), //    drift -> flat (low |vs|)
    straightLong: flags.map((f) => (f ? 0.05 : 0.9)), // drift -> inefficient path, long window
    straightShort: flags.map((f) => (f ? 0.05 : 0.9)), // drift -> inefficient path, short window
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

test("drift: needs random heading AND flat altitude AND path inefficiency", () => {
  const n = 200;
  const base = {
    n,
    t: Array.from({ length: n }, (_, i) => i),
    x: new Array(n).fill(0),
    y: new Array(n).fill(0),
    straightShort: new Array(n).fill(1), // inert (efficient) — these cases test the long window only
    g: {},
  };
  const run = (w, v, sl) =>
    compute({
      ...base,
      wander: new Array(n).fill(w),
      vs: new Array(n).fill(v),
      straightLong: new Array(n).fill(sl),
    });
  assert.ok(run(0.8, 0.6, 0.05).drop.every((x) => x === null)); // climbing -> |vs| fails
  assert.ok(run(0.1, 0.05, 0.05).drop.every((x) => x === null)); // steady heading -> wander fails
  assert.ok(run(0.8, 0.05, 0.9).drop.every((x) => x === null)); // efficient path -> straightLong fails
  assert.ok(run(0.8, 0.05, 0.05).drop.some((x) => x !== null)); // all three hold -> drift
});

test("drift: a run only the short window confirms gets a much lower duration floor", () => {
  // Mirrors GX065132.MP4's real shape: straightLong never dips below the long window's own cutoff
  // ANYWHERE (diluted by real motion elsewhere in a short recording), so the long window can never
  // confirm this run at any duration; straightShort (path efficiency over the short window) does,
  // but only for a short ~4 s stretch. The ORIGINAL 30 s floor would (wrongly) let a real short
  // wobble like this through undetected.
  const n = 40;
  const inRun = (i) => i >= 15 && i <= 19; // t = 15..19 inclusive -> 4 s
  const ctx = {
    n,
    t: Array.from({ length: n }, (_, i) => i),
    x: new Array(n).fill(0),
    y: new Array(n).fill(0),
    wander: Array.from({ length: n }, (_, i) => (inRun(i) ? 0.8 : 0.1)),
    vs: Array.from({ length: n }, (_, i) => (inRun(i) ? 0.05 : 0.5)),
    straightLong: new Array(n).fill(0.9), // never confirms the long window, in or out of the run
    straightShort: Array.from({ length: n }, (_, i) => (inRun(i) ? 0.05 : 0.9)),
    g: {},
  };
  const { drift, drop } = compute(ctx);
  assert.ok(drop[17] && drift[17], "the short, path-inefficient wobble is caught");
  assert.equal(drop[0], null, "outside the run stays kept");
});

test("drift: a run relying on the long window keeps the original 30 s floor even when the short window also confirms it", () => {
  // The short window's lower duration floor only applies to a run the LONG window never confirms
  // (see `run.every((k) => !isDriftLong(k))` in drift.js). Here straightLong IS below the long
  // window's own cutoff, so even though straightShort is ALSO low throughout (the short window
  // would confirm it too), the original 30 s floor still applies — confirming both ways is not
  // itself reason to relax it.
  const flags = Array.from({ length: 100 }, (_, i) => i >= 50 && i < 80); // 29 s < 30 s
  const ctx = {
    n: 100,
    t: Array.from({ length: 100 }, (_, i) => i),
    x: new Array(100).fill(0),
    y: new Array(100).fill(0),
    wander: flags.map((f) => (f ? 0.8 : 0.1)),
    vs: flags.map((f) => (f ? 0.05 : 0.5)),
    straightLong: flags.map((f) => (f ? 0.05 : 0.9)),
    straightShort: flags.map((f) => (f ? 0.05 : 0.9)),
    g: {},
  };
  assert.ok(compute(ctx).drop.every((d) => d === null));
});

test("drift: a real, path-efficient walk (even slow, even pausing) is not misread as drift", () => {
  // The short-scale false positive that motivated straightShort: a person walking away from a
  // chairlift, decelerating to a near-stop then resuming, has high `wander` (heading naturally
  // varies at very low speed) — but the path they actually walked still converts a meaningful
  // fraction of its length into net progress (straightShort stays > the drift cutoff), unlike GPS
  // noise scribbling in place.
  const n = 200;
  const ctx = {
    n,
    t: Array.from({ length: n }, (_, i) => i),
    x: new Array(n).fill(0),
    y: new Array(n).fill(0),
    wander: new Array(n).fill(0.8), // heading naturally varies at near-stationary speed too
    vs: new Array(n).fill(0.05),
    straightLong: new Array(n).fill(0.7), // real net progress over the long window too
    straightShort: new Array(n).fill(0.8), // real walk: most of the path converts to net progress
    g: {},
  };
  assert.ok(compute(ctx).drop.every((d) => d === null));
});

test("drift: a real, clean single fold (walked once) is not misread as a long stay", () => {
  // The long-scale false positive: a real switchback/U-turn nets little displacement over +/-150 s
  // (the walk out and the walk back cancel out) exactly the way genuine wandering-in-place does, so
  // a plain net-displacement check (the pre-straightLong design) misreads it. straightLong stays
  // above the drift cutoff because the fold itself doesn't inflate path length nearly as much as
  // GPS noise would relative to the (small but real) net progress at any given point along it.
  const n = 150;
  const ctx = {
    n,
    t: Array.from({ length: n }, (_, i) => i),
    x: new Array(n).fill(0),
    y: new Array(n).fill(0),
    wander: new Array(n).fill(0.7), // a fold's heading swings a lot too
    vs: new Array(n).fill(0.03),
    straightLong: new Array(n).fill(0.3), // a clean fold: inefficient, but above the 0.2 cutoff
    straightShort: new Array(n).fill(0.3),
    g: {},
  };
  assert.ok(compute(ctx).drop.every((d) => d === null));
});
