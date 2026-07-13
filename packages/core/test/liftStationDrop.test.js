import assert from "node:assert/strict";
import { test } from "node:test";
import { finalize } from "../src/mods/liftStationDrop.js";

// liftStationDrop only reads time/x/y/segment/liftBoardingEle/segmentBoundaryEle/dropReason off
// assembled points — unit-test its own logic with hand-built runs (same style as liftBoardingEle /
// liftSnap's own tests).

let t0 = 0;
function run(id, type, xs, over = {}) {
  const pts = xs.map((x, i) => ({
    lat: 36,
    lon: 138,
    time: (t0 + i) * 1000,
    x,
    y: 0,
    segment: { id, type },
    ...(typeof over === "function" ? over(i) : over),
  }));
  t0 += xs.length;
  return pts;
}

// a wandering stretch: 70 points 1s apart oscillating ±10m around x=0 → path ~1400m, net ~0m
const tangleXs = () => Array.from({ length: 70 }, (_, i) => (i % 2 ? 10 : -10));
// a straight glide at 3 m/s: net grows 3m per point → 70 pts = 207m net, ratio 1
const straightXs = () => Array.from({ length: 70 }, (_, i) => i * 3);
// a lift ride: steady 5 m/s over 200 pts
const liftXs = () => Array.from({ length: 200 }, (_, i) => i * 5);

function build(...runs) {
  t0 = 0;
  return runs.flat();
}

function droppedIds(out) {
  return [...new Set(out.filter((p) => p.dropReason?.liftStationDrop).map((p) => p.segment.id))];
}

test("liftStationDrop: a short tangled flat run adjacent to a lift is dropped whole", () => {
  const flat = run(1, "flat", tangleXs());
  const out = build(run(0, "lift", liftXs()), flat, run(2, "descent", straightXs()));
  finalize(out, { g: {} });
  assert.deepEqual(droppedIds(out), [1]);
  assert.ok(flat.every((p) => p.dropReason?.liftStationDrop)); // the whole run, not a subset
  assert.ok(out.filter((p) => p.segment.id !== 1).every((p) => !p.dropReason)); // neighbours untouched
});

test("liftStationDrop: the same tangle NOT adjacent to any lift run is kept", () => {
  const out = build(
    run(0, "descent", straightXs()),
    run(1, "flat", tangleXs()),
    run(2, "descent", straightXs()),
  );
  finalize(out, { g: {} });
  assert.deepEqual(droppedIds(out), []);
});

test("liftStationDrop: low-ratio adjacent run is still dropped when enough of its ele was already dropped", () => {
  // straight-ish but short net: 70 pts covering 30m (net 30 < 50, ratio ~1) with 60% ele-dropped
  const xs = Array.from({ length: 70 }, (_, i) => i * (30 / 69));
  const flat = run(1, "flat", xs, (i) => (i < 42 ? { liftBoardingEle: { ele: null } } : {}));
  const out = build(run(0, "lift", liftXs()), flat);
  finalize(out, { g: {} });
  assert.deepEqual(droppedIds(out), [1]);
});

test("liftStationDrop: low-ratio adjacent run with no ele-dropped points is kept", () => {
  const xs = Array.from({ length: 70 }, (_, i) => i * (30 / 69)); // net 30m, ratio ~1, eleFrac 0
  const out = build(run(0, "lift", liftXs()), run(1, "flat", xs));
  finalize(out, { g: {} });
  assert.deepEqual(droppedIds(out), []);
});

test("liftStationDrop: adjacent tangle that actually goes somewhere (net too large) is kept", () => {
  // oscillate AND drift: net 138m > 50m cap even though it wiggles
  const xs = Array.from({ length: 70 }, (_, i) => i * 2 + (i % 2 ? 10 : -10));
  const out = build(run(0, "lift", liftXs()), run(1, "flat", xs));
  finalize(out, { g: {} });
  assert.deepEqual(droppedIds(out), []);
});

test("liftStationDrop: adjacent tangle lasting past the duration cap is kept", () => {
  const xs = Array.from({ length: 120 }, (_, i) => (i % 2 ? 10 : -10)); // 119s > 90s
  const out = build(run(0, "lift", liftXs()), run(1, "flat", xs));
  finalize(out, { g: {} });
  assert.deepEqual(droppedIds(out), []);
});

test("liftStationDrop: a lift run itself is never dropped, however tangled", () => {
  const out = build(run(0, "lift", liftXs()), run(1, "lift", tangleXs()));
  finalize(out, { g: {} });
  assert.deepEqual(droppedIds(out), []);
});

test("liftStationDrop: g.LIFT_STATION_* overrides the thresholds", () => {
  const out = build(run(0, "lift", liftXs()), run(1, "flat", tangleXs()));
  finalize(out, { g: { LIFT_STATION_MAX_S: 30 } }); // 69s run no longer "short"
  assert.deepEqual(droppedIds(out), []);
});

test("liftStationDrop: already-dropped points are ignored when grouping runs", () => {
  const flat = run(1, "flat", tangleXs());
  const out = build(run(0, "lift", liftXs()), flat);
  for (const p of out) if (p.segment.id === 0) p.dropReason = { stray: {} }; // lift run fully dropped upstream
  finalize(out, { g: {} });
  // with the lift run gone from the kept view, the tangle has no lift neighbour → kept
  assert.deepEqual(droppedIds(out), []);
});
