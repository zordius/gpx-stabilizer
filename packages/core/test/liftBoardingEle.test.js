import assert from "node:assert/strict";
import { test } from "node:test";
import { finalize } from "../src/mods/liftBoardingEle.js";

// liftBoardingEle only reads time/ele/hs/x/y/hdop/dropReason/liftConfirm/segment off assembled points —
// unit-test its own logic directly with hand-built points (same style as liftConfirm/liftSnap's own
// tests), rather than driving the whole analyze() pipeline just to reproduce a realistic boarding dip.
function pt(over) {
  return { lat: 36, lon: 138, time: 0, hs: 0.3, ...over };
}

// These fixtures are short enough that the TAIL mechanism's own MARGIN/lowSpeedBoundary reach
// (see module doc) swallows the whole track regardless of where the dip sits in it — so despite the
// "head" framing, they exercise the SHARED dip/bump engine (fixExcursionsInWindow/findExcursion) via
// the tail code path, not the HEAD mechanism (fixQueueHead, tested separately below) — that one
// needs `segment.type === "lift"` + real x/y, which none of these set. Kept as regression coverage
// for the shared engine; the naming is legacy from before the head/tail redesign (2026-07-09).
//
// A dip-then-recover shape: pre-queue flat (905m) -> pre-dip peak (913m) -> dip to 900m -> recovers
// past 913m (914m) -> then a genuine confirmed-lift climb continues.
function headDipTrack() {
  const queue = Array.from({ length: 10 }, (_, i) => pt({ ele: 905, time: i * 1000 }));
  const dip = [
    pt({ ele: 913, time: 10000 }), // pre-dip peak (index 10)
    pt({ ele: 910, time: 11000 }),
    pt({ ele: 906, time: 12000 }),
    pt({ ele: 903, time: 13000 }),
    pt({ ele: 901, time: 14000 }),
    pt({ ele: 900, time: 15000 }), // local min (index 15)
    pt({ ele: 905, time: 16000 }),
    pt({ ele: 909, time: 17000 }),
    pt({ ele: 914, time: 18000 }), // recovery anchor (index 18) — clears the pre-dip peak (913)
  ];
  const lift = Array.from({ length: 7 }, (_, i) =>
    pt({
      ele: 916 + i * 3,
      time: (19 + i) * 1000,
      hs: 1.4,
      liftConfirm: { type: "lift" },
      segment: { id: 1 },
    }),
  );
  return [...queue, ...dip, ...lift];
}

test("liftBoardingEle: fixes a head dip — drops the elevation strictly between the two anchors", () => {
  const out = headDipTrack();
  finalize(out, { g: {} });
  // points strictly between the pre-dip peak (idx 10, ele 913) and the recovery anchor (idx 18, ele
  // 914) get dropped rather than fabricated by interpolating between the two
  for (let i = 11; i < 18; i++) {
    assert.deepEqual(out[i].liftBoardingEle, { ele: null }, `index ${i}`);
  }
  // the anchors themselves and the queue/lift points outside the window are untouched
  assert.equal(out[10].liftBoardingEle, undefined);
  assert.equal(out[18].liftBoardingEle, undefined);
  assert.equal(out[0].liftBoardingEle, undefined);
  assert.equal(out[19].liftBoardingEle, undefined);
});

test("liftBoardingEle: fixes a tail dip — same shape, mirrored at the end of the run", () => {
  // lift phase stays strictly BELOW the dip's own pre-dip peak (930) and above its own min (913), so
  // the whole-window min/max search unambiguously lands on the dip's own shape, not the ascending
  // lift ramp's own endpoints.
  const lift = Array.from({ length: 10 }, (_, i) =>
    pt({
      ele: 915 + i,
      time: i * 1000,
      hs: 1.4,
      liftConfirm: { type: "lift" },
      segment: { id: 1 },
    }),
  );
  const dip = [
    pt({ ele: 930, time: 10000, hs: 1.4 }), // pre-dip peak (idx 10)
    pt({ ele: 926, time: 11000, hs: 1.4 }),
    pt({ ele: 921, time: 12000, hs: 1.4 }),
    pt({ ele: 917, time: 13000, hs: 1.4 }),
    pt({ ele: 915, time: 14000, hs: 1.4 }),
    pt({ ele: 913, time: 15000, hs: 1.4 }), // local min (idx 15)
    pt({ ele: 918, time: 16000, hs: 1.4 }),
    pt({ ele: 924, time: 17000, hs: 1.4 }),
    pt({ ele: 931, time: 18000, hs: 1.4 }), // recovery anchor (idx 18) — clears the pre-dip peak (930)
  ];
  const after = Array.from({ length: 10 }, (_, i) =>
    pt({ ele: 931, time: (19 + i) * 1000, hs: 1.4 }),
  );
  const out = [...lift, ...dip, ...after];
  finalize(out, { g: {} });
  for (let i = 11; i < 18; i++) {
    assert.deepEqual(out[i].liftBoardingEle, { ele: null }, `index ${i}`);
  }
  assert.equal(out[9].liftBoardingEle, undefined); // last real lift point, untouched
  assert.equal(out[19].liftBoardingEle, undefined); // first post-run point, untouched
});

test("liftBoardingEle: a dip below the minimum threshold is left alone", () => {
  const out = headDipTrack();
  finalize(out, { g: { LIFT_BOARD_DIP_M: 20 } }); // the real dip here is only ~13m
  assert.ok(out.every((p) => p.liftBoardingEle === undefined));
});

test("liftBoardingEle: a weak recovery (doesn't clear the threshold) is left alone", () => {
  const out = headDipTrack();
  // the POST_WINDOW search reaches into the following climb too, so the real recovery here is
  // ~28m (900 -> 928) — a threshold safely above that must still skip the fix
  finalize(out, { g: { LIFT_BOARD_RECOVER_M: 30 } });
  assert.ok(out.every((p) => p.liftBoardingEle === undefined));
});

test("liftBoardingEle: real movement (hs too high) during the window is not treated as boarding", () => {
  const out = headDipTrack();
  out[13].hs = 5; // one point in the dip window is actually moving fast
  finalize(out, { g: {} });
  assert.ok(out.every((p) => p.liftBoardingEle === undefined));
});

test("liftBoardingEle: a smooth monotonic climb (no dip at all) is a no-op", () => {
  const out = Array.from({ length: 40 }, (_, i) =>
    pt({
      ele: 900 + i * 2,
      time: i * 1000,
      hs: 1.4,
      liftConfirm: { type: "lift" },
      segment: { id: 0 },
    }),
  );
  finalize(out, { g: {} });
  assert.ok(out.every((p) => p.liftBoardingEle === undefined));
});

test("liftBoardingEle: no confirmed-lift run anywhere -> no-op", () => {
  const out = headDipTrack().map((p) => {
    const { liftConfirm, ...rest } = p;
    return rest;
  });
  finalize(out, { g: {} });
  assert.ok(out.every((p) => p.liftBoardingEle === undefined));
});

// --- HEAD mechanism: queue-region discard (2026-07-09; revised same day to DROP rather than correct) ---

// anchor (far from the lift, x=1000, still genuinely moving — hs=5 so STAGE 1's backward walk stops
// AT it rather than absorbing it into the confirmed stop) -> a "queue" (x=50, within QUEUE_DIST_M=200
// of the lift's own (0,0) boarding position, hs=0.3 so STAGE 1 confirms a stop) -> the lift run
// itself, whose own boarding reading is whatever `boardEle` is — the region's elevation is unusable
// either way, so the mechanism drops it rather than trying to infer what it "should" have been.
function queueHeadTrack(boardEle) {
  const anchor = pt({ time: 0, x: 1000, y: 0, ele: 800, hs: 5 });
  const queue = Array.from({ length: 5 }, (_, i) =>
    pt({ time: (i + 1) * 10000, x: 50, y: 0, ele: 700 }), // ele is noise -- expected to be dropped
  );
  const lift = Array.from({ length: 21 }, (_, i) =>
    pt({
      time: 60000 + i * 10000,
      x: 0,
      y: 0,
      ele: i === 0 ? boardEle : 900 + i * 10,
      segment: { id: 1, type: "lift" },
    }),
  );
  return [anchor, ...queue, ...lift];
}

test("liftBoardingEle: drops the elevation of a confirmed queue region through the boarding point", () => {
  const out = queueHeadTrack(850); // the raw boarding reading itself is irrelevant -- it gets dropped
  finalize(out, { g: {} });

  const boardIdx = 6; // anchor(1) + queue(5) -> lift[0]
  assert.equal(out[0].liftBoardingEle, undefined); // the reliable pre-queue anchor is untouched
  for (let i = 1; i <= boardIdx; i++) {
    assert.deepEqual(out[i].liftBoardingEle, { ele: null }, `index ${i}`);
  }
  // real ride points after boarding are untouched
  for (let i = boardIdx + 1; i < out.length; i++) assert.equal(out[i].liftBoardingEle, undefined);
});

test("liftBoardingEle: no STAGE 1 confirmed stop directly adjacent to boarding -> head is a no-op", () => {
  // hs stays at 5 (above QUEUE_STOP_HS_MAX=2.5) the whole way to boarding -- a real, still-moving
  // approach, not a confirmed stop, however close it otherwise looks.
  const out = queueHeadTrack(850).map((p) => (p.segment?.type === "lift" ? p : { ...p, hs: 5 }));
  finalize(out, { g: {} });
  assert.ok(out.every((p) => p.liftBoardingEle === undefined));
});

test("liftBoardingEle: STAGE 2 doesn't extend past QUEUE_DIST_M -- the confirmed stop is still dropped", () => {
  // same shape as queueHeadTrack, but the queue sits at x=500 (outside the default 200m) -- STAGE 1
  // still confirms the stop (it doesn't check distance at all), so the drop still runs, just bounded
  // at the point right before the queue (STAGE 2 can't reach past it either).
  const out = queueHeadTrack(850).map((p) => (p.time > 0 && p.time < 60000 ? { ...p, x: 500 } : p));
  finalize(out, { g: {} });
  const boardIdx = 6;
  assert.deepEqual(out[boardIdx].liftBoardingEle, { ele: null });
});

test("liftBoardingEle: HEAD accepts a queue stretch shorter than QUEUE_STOP_MIN_S when it runs off the front of the analyzed data", () => {
  // the queue starts at index 0 -- the very front of `kept`, as if this file/session were analyzed
  // alone with no earlier real data -- and is only ~1s long, well under QUEUE_STOP_MIN_S (5s). The
  // old code rejected this as "too brief to trust"; hitting the data boundary while still slow is
  // now accepted outright, since there is no way to see whether the real queue started earlier.
  const queue = [
    pt({ time: 0, x: 50, y: 0, ele: 700, hs: 0.3 }),
    pt({ time: 1000, x: 50, y: 0, ele: 700, hs: 0.3 }),
  ];
  const lift = Array.from({ length: 21 }, (_, i) =>
    pt({
      time: 2000 + i * 10000,
      x: 0,
      y: 0,
      ele: i === 0 ? 850 : 900 + i * 10,
      segment: { id: 1, type: "lift" },
    }),
  );
  const out = [...queue, ...lift];
  finalize(out, { g: {} });
  const boardIdx = 2; // queue(2) -> lift[0]
  for (let i = 0; i <= boardIdx; i++) {
    assert.deepEqual(out[i].liftBoardingEle, { ele: null }, `index ${i}`);
  }
  for (let i = boardIdx + 1; i < out.length; i++) assert.equal(out[i].liftBoardingEle, undefined);
});

test("liftBoardingEle: a real, still-moving approach at the very front of the data is still not treated as a queue", () => {
  // same boundary position, but hs stays high right up to boarding -- STAGE 1's own first check
  // (hs >= hsMax) rejects it before the boundary-relaxation can even apply.
  const queue = [pt({ time: 0, x: 50, y: 0, ele: 700, hs: 5 })];
  const lift = Array.from({ length: 21 }, (_, i) =>
    pt({
      time: 1000 + i * 10000,
      x: 0,
      y: 0,
      ele: i === 0 ? 850 : 900 + i * 10,
      segment: { id: 1, type: "lift" },
    }),
  );
  const out = [...queue, ...lift];
  finalize(out, { g: {} });
  assert.ok(out.every((p) => p.liftBoardingEle === undefined));
});

// --- position drop for confirmed-bad-GPS points (2026-07-09) ---
// queueHeadTrack's indices: 0 = anchor (never ele-dropped), 1-5 = queue, 6 = boarding point (both
// ele-dropped by the HEAD mechanism, per the first test above), 7+ = the real ride (never touched).

test("liftBoardingEle: drops the WHOLE POINT (not just ele) when hdop is also poor", () => {
  const out = queueHeadTrack(850).map((p, i) => (i >= 1 && i <= 5 ? { ...p, hdop: 5 } : p));
  finalize(out, { g: {} });
  for (let i = 1; i <= 5; i++) {
    assert.ok(out[i].dropReason?.liftBoardingEle, `index ${i} should be fully dropped`);
  }
  // the boarding point itself has no hdop override here -> stays ele-drop-only, not fully dropped
  assert.equal(out[6].dropReason, undefined);
  assert.deepEqual(out[6].liftBoardingEle, { ele: null });
});

test("liftBoardingEle: leaves the point alone (ele-drop only) when hdop is still good", () => {
  const out = queueHeadTrack(850); // no hdop overrides -> hdop is undefined everywhere
  finalize(out, { g: {} });
  for (let i = 1; i <= 6; i++) {
    assert.equal(out[i].dropReason, undefined, `index ${i} should not be fully dropped`);
  }
});

test("liftBoardingEle: hdop alone, on a point liftBoardingEle never ele-dropped, is not enough to drop it", () => {
  const out = queueHeadTrack(850).map((p, i) => (i === 10 ? { ...p, hdop: 10 } : p)); // a real ride point
  finalize(out, { g: {} });
  assert.equal(out[10].dropReason, undefined);
});

test("liftBoardingEle: clusters across a lone still-good-hdop point sandwiched between two bad ones", () => {
  const out = queueHeadTrack(850).map((p, i) => (i === 1 || i === 3 ? { ...p, hdop: 5 } : p));
  // queue points are 10s apart -> idx1 and idx3 are 20s apart; widen the glue so they bridge
  finalize(out, { g: { LIFT_QUEUE_DROP_GLUE_S: 25 } });
  assert.ok(out[1].dropReason?.liftBoardingEle);
  assert.ok(out[2].dropReason?.liftBoardingEle); // sandwiched between the two seeds -> swept in too
  assert.ok(out[3].dropReason?.liftBoardingEle);
  // outside the [idx1, idx3] cluster -- untouched, even though still ele-dropped
  assert.equal(out[4].dropReason, undefined);
  assert.equal(out[5].dropReason, undefined);
  assert.equal(out[6].dropReason, undefined);
});
