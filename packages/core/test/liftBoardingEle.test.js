import assert from "node:assert/strict";
import { test } from "node:test";
import { finalize } from "../src/mods/liftBoardingEle.js";

// liftBoardingEle only reads time/ele/hs/dropReason/liftConfirm/segment off assembled points —
// unit-test its own logic directly with hand-built points (same style as liftConfirm/liftSnap's own
// tests), rather than driving the whole analyze() pipeline just to reproduce a realistic boarding dip.
function pt(over) {
  return { lat: 36, lon: 138, time: 0, hs: 0.3, ...over };
}

// A run whose HEAD shows a clean dip-then-recover: pre-queue flat (905m) -> pre-dip peak (913m) ->
// dip to 900m -> recovers past 913m (914m) -> then a genuine confirmed-lift climb continues.
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

test("liftBoardingEle: fixes a head dip — bridges the pre-dip anchor to the recovery anchor by time", () => {
  const out = headDipTrack();
  finalize(out, { g: {} });
  // points strictly between the pre-dip peak (idx 10, ele 913) and the recovery anchor (idx 18, ele
  // 914) get replaced with a straight-line time interpolation between those two
  for (let i = 11; i < 18; i++) {
    const w = (out[i].time - out[10].time) / (out[18].time - out[10].time);
    const expected = 913 + w * (914 - 913);
    assert.ok(
      Math.abs(out[i].liftBoardingEle.ele - expected) < 1e-9,
      `index ${i}: got ${out[i].liftBoardingEle?.ele}, expected ${expected}`,
    );
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
    const w = (out[i].time - out[10].time) / (out[18].time - out[10].time);
    const expected = 930 + w * (931 - 930);
    assert.ok(Math.abs(out[i].liftBoardingEle.ele - expected) < 1e-9, `index ${i}`);
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
