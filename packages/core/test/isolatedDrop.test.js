import assert from "node:assert/strict";
import { test } from "node:test";
import { finalize } from "../src/mods/isolatedDrop.js";

// isolatedDrop only reads time/x/y/dropReason off assembled points — unit-test its own logic with
// hand-built points (same style as liftStationDrop's own tests). No segment/liftConfirm/hdop/fix
// fields anywhere here, on purpose: this module must not depend on any of them.

function pts(specs) {
  // specs: [{t, x, y, dropped?}] -- t in seconds
  return specs.map(({ t, x = 0, y = 0, dropped }) => ({
    lat: 36,
    lon: 138,
    time: t * 1000,
    x,
    y,
    ...(dropped ? { dropReason: { stray: {} } } : {}),
  }));
}

function droppedRanges(out) {
  const idxs = [];
  out.forEach((p, i) => {
    if (p.dropReason?.isolatedDrop) idxs.push(i);
  });
  return idxs;
}

test("isolatedDrop: a short, confined run bounded by real, MOVING gaps on both sides is dropped whole", () => {
  const out = pts([
    { t: 0, x: 0 }, // run A: dur=2s, net=100m -- real motion, must survive
    { t: 1, x: 50 },
    { t: 2, x: 100 },
    // gap > 3s
    { t: 10, x: 100 }, // short island: dur=1s, net=1m
    { t: 11, x: 101 },
    // gap > 3s
    { t: 20, x: 200 }, // run C: dur=2s, net=200m -- real motion, must survive
    { t: 21, x: 300 },
    { t: 22, x: 400 },
  ]);
  finalize(out, { g: {} });
  assert.deepEqual(droppedRanges(out), [3, 4]);
});

test("isolatedDrop: a run that goes far (net too large) is kept, however brief", () => {
  const out = pts([
    { t: 0, x: 0 },
    { t: 1, x: 20 }, // dur=1s but net=20m > 10m cap
  ]);
  finalize(out, { g: {} });
  assert.deepEqual(droppedRanges(out), []);
});

test("isolatedDrop: a run that lasts too long (dur too large) is kept, however confined", () => {
  // 3 points each <=3s apart -- ONE continuous run, not split by the gap rule itself
  const out = pts([
    { t: 0, x: 0 },
    { t: 2.5, x: 0.5 },
    { t: 5, x: 1 }, // whole run: dur=5s (not < 5), net=1m -- fails the strict duration gate
  ]);
  finalize(out, { g: {} });
  assert.deepEqual(droppedRanges(out), []);
});

test("isolatedDrop: a single-point island (dur=0, net=0) at the very start of the track is dropped, a real run after it survives", () => {
  // no earlier point at all -- the track's own start is as much an edge as a real gap
  const out = pts([
    { t: 0, x: 500 }, // lone point
    { t: 10, x: 0 }, // gap; run B starts here, real motion -- must survive
    { t: 11, x: 50 },
  ]);
  finalize(out, { g: {} });
  assert.deepEqual(droppedRanges(out), [0]);
});

test("isolatedDrop: a single-point island at the very end of the track is dropped, the real run before it survives", () => {
  const out = pts([
    { t: 0, x: 0 }, // run A: real motion -- must survive
    { t: 1, x: 60 },
    { t: 12, x: 500 }, // gap; lone point at the end
  ]);
  finalize(out, { g: {} });
  assert.deepEqual(droppedRanges(out), [2]);
});

test("isolatedDrop: a long continuous run with no internal gap is never touched, however brief a sub-window looks", () => {
  const specs = [];
  for (let t = 0; t <= 60; t++) specs.push({ t, x: 0 });
  const out = pts(specs);
  finalize(out, { g: {} });
  assert.deepEqual(droppedRanges(out), []);
});

test("isolatedDrop: already-dropped points are excluded from gap/run computation entirely", () => {
  // a point some earlier module already dropped sits BETWEEN two runs that would otherwise look
  // contiguous by index, but its own time gap on either side still exceeds gapS once excluded from
  // the "kept" view -- confirms this module doesn't accidentally bridge across a pre-existing drop
  const out = pts([
    { t: 0, x: 0 },
    { t: 1, x: 0 },
    { t: 5, x: 0, dropped: true }, // upstream drop, mid-gap
    { t: 10, x: 100 },
    { t: 11, x: 101 },
  ]);
  finalize(out, { g: {} });
  // two islands: [0,1] dur=1 net=0 -> dropped; [3,4] dur=1 net=1 -> dropped
  assert.deepEqual(droppedRanges(out), [0, 1, 3, 4]);
});

test("isolatedDrop: g.ISOLATED_* overrides the thresholds", () => {
  const out = pts([
    { t: 0, x: 0 },
    { t: 1, x: 0 },
    { t: 10, x: 100 },
    { t: 11, x: 101 },
  ]);
  finalize(out, { g: { ISOLATED_MAX_S: 0 } }); // dur=1s no longer "< 0"
  assert.deepEqual(droppedRanges(out), []);
});

test("isolatedDrop: g.ISOLATED_GAP_S widens what counts as one continuous segment", () => {
  const out = pts([
    { t: 0, x: 0 },
    { t: 1, x: 0 },
    { t: 5, x: 0 }, // 4s gap from previous -- under default 3s this is a break, but not under 10s
    { t: 6, x: 0 },
  ]);
  finalize(out, { g: { ISOLATED_GAP_S: 10 } });
  // one continuous 6s/0m run under the widened gap -- but dur=6s fails the default 5s cap, so kept
  assert.deepEqual(droppedRanges(out), []);
});
