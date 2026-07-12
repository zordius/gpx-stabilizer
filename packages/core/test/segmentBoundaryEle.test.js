import assert from "node:assert/strict";
import { test } from "node:test";
import { finalize } from "../src/mods/segmentBoundaryEle.js";

// segmentBoundaryEle only reads time/ele/hs/segment/dropReason off assembled points — unit-test its
// own logic directly with hand-built points (same style as liftBoardingEle's own tests).
function pt(over) {
  return { lat: 36, lon: 138, time: 0, hs: 0.3, segment: { id: 1 }, ...over };
}

// 6 jittery, essentially-stationary points (cumulative +ele easily clears 1m) followed by 17 points
// of sustained hs=2 motion (16s span, clears the >15s bar) -- the classic "no backward context, GPS
// still settling" shape this module exists to catch.
function headBoundaryTrack() {
  const jitter = [900, 900.5, 900.2, 900.9, 900.4, 901.2].map((ele, i) =>
    pt({ ele, time: i * 1000 }),
  );
  const sustained = Array.from({ length: 17 }, (_, i) =>
    pt({ ele: 902 + i, time: (6 + i) * 1000, hs: 2 }),
  );
  return [...jitter, ...sustained];
}

test("segmentBoundaryEle: drops a jittery head prefix before sustained motion starts (no previous segment at all)", () => {
  const out = headBoundaryTrack();
  finalize(out, { g: {} });
  for (let i = 0; i <= 5; i++)
    assert.deepEqual(out[i].segmentBoundaryEle, { ele: null }, `index ${i}`);
  for (let i = 6; i < out.length; i++)
    assert.equal(out[i].segmentBoundaryEle, undefined, `index ${i}`);
});

test("segmentBoundaryEle: drops a jittery tail suffix after sustained motion ends (no next segment at all)", () => {
  // mirror of headBoundaryTrack: sustained motion first, then the jittery tail.
  const sustained = Array.from({ length: 17 }, (_, i) =>
    pt({ ele: 902 + i, time: i * 1000, hs: 2 }),
  );
  const jitter = [901.2, 900.4, 900.9, 900.2, 900.5, 900].map((ele, i) =>
    pt({ ele, time: (17 + i) * 1000 }),
  );
  const out = [...sustained, ...jitter];
  finalize(out, { g: {} });
  for (let i = 0; i < 17; i++) assert.equal(out[i].segmentBoundaryEle, undefined, `index ${i}`);
  for (let i = 17; i < out.length; i++)
    assert.deepEqual(out[i].segmentBoundaryEle, { ele: null }, `index ${i}`);
});

test("segmentBoundaryEle: a small gap to the neighbouring segment (not isolated) suppresses the head check", () => {
  const seg1 = Array.from({ length: 5 }, (_, i) =>
    pt({ ele: 850, time: i * 1000, hs: 2, segment: { id: 1 } }),
  );
  // only a 6s gap between seg1's end (t=4000) and seg2's start (t=10000) -- well under the 600s bar
  const seg2Jitter = [900, 900.5, 900.2, 900.9, 900.4, 901.2].map((ele, i) =>
    pt({ ele, time: (10 + i) * 1000, segment: { id: 2 } }),
  );
  const seg2Sustained = Array.from({ length: 17 }, (_, i) =>
    pt({ ele: 902 + i, time: (16 + i) * 1000, hs: 2, segment: { id: 2 } }),
  );
  const out = [...seg1, ...seg2Jitter, ...seg2Sustained];
  finalize(out, { g: {} });
  assert.ok(out.every((p) => p.segmentBoundaryEle === undefined));
});

test("segmentBoundaryEle: a gap past the threshold (not just a missing neighbour) still counts as isolated", () => {
  const seg1 = Array.from({ length: 5 }, (_, i) =>
    pt({ ele: 850, time: i * 1000, hs: 2, segment: { id: 1 } }),
  );
  // a 601s gap between seg1's end (t=4000) and seg2's start -- clears SEG_BOUNDARY_GAP_MIN_S(600)
  const gapStart = 4000 + 601_000;
  const seg2Jitter = [900, 900.5, 900.2, 900.9, 900.4, 901.2].map((ele, i) =>
    pt({ ele, time: gapStart + i * 1000, segment: { id: 2 } }),
  );
  const seg2Sustained = Array.from({ length: 17 }, (_, i) =>
    pt({ ele: 902 + i, time: gapStart + (6 + i) * 1000, hs: 2, segment: { id: 2 } }),
  );
  const out = [...seg1, ...seg2Jitter, ...seg2Sustained];
  finalize(out, { g: {} });
  for (let i = 0; i < 5; i++) assert.equal(out[i].segmentBoundaryEle, undefined, `seg1 index ${i}`);
  for (let i = 5; i <= 10; i++)
    assert.deepEqual(out[i].segmentBoundaryEle, { ele: null }, `seg2 jitter index ${i}`);
});

test("segmentBoundaryEle: no qualifying sustained-motion stretch anywhere -> no-op regardless of cumulative ele", () => {
  // hs never exceeds 1 anywhere in the whole segment -- no trusted boundary to check the jitter against.
  const out = [900, 900.5, 900.2, 900.9, 900.4, 901.2, 901.8, 902.5].map((ele, i) =>
    pt({ ele, time: i * 1000 }),
  );
  finalize(out, { g: {} });
  assert.ok(out.every((p) => p.segmentBoundaryEle === undefined));
});

test("segmentBoundaryEle: cumulative climb/descent below the threshold is left alone", () => {
  const jitter = [900, 900.1, 900.05, 900.15, 900.02, 900.2].map((ele, i) =>
    pt({ ele, time: i * 1000 }),
  ); // cumPos ~0.4m
  const sustained = Array.from({ length: 17 }, (_, i) =>
    pt({ ele: 901 + i, time: (6 + i) * 1000, hs: 2 }),
  );
  const out = [...jitter, ...sustained];
  finalize(out, { g: {} });
  assert.ok(out.every((p) => p.segmentBoundaryEle === undefined));
});

test("segmentBoundaryEle: cumulative DESCENT alone (not just climb) can also trigger the drop", () => {
  const jitter = [905, 904.5, 904.8, 904.1, 904.6, 903.8].map((ele, i) =>
    pt({ ele, time: i * 1000 }),
  ); // cumNeg ~-1.9m
  const sustained = Array.from({ length: 17 }, (_, i) =>
    pt({ ele: 903 - i, time: (6 + i) * 1000, hs: 2 }),
  );
  const out = [...jitter, ...sustained];
  finalize(out, { g: {} });
  for (let i = 0; i <= 5; i++)
    assert.deepEqual(out[i].segmentBoundaryEle, { ele: null }, `index ${i}`);
});

test("segmentBoundaryEle: a sustained-motion stretch shorter than the minimum duration doesn't count", () => {
  // only 10s of hs=2 (under the >15s bar), so no trusted boundary is ever found -> no-op.
  const jitter = [900, 900.5, 900.2, 900.9, 900.4, 901.2].map((ele, i) =>
    pt({ ele, time: i * 1000 }),
  );
  const tooShort = Array.from({ length: 10 }, (_, i) =>
    pt({ ele: 902 + i, time: (6 + i) * 1000, hs: 2 }),
  );
  const out = [...jitter, ...tooShort];
  finalize(out, { g: {} });
  assert.ok(out.every((p) => p.segmentBoundaryEle === undefined));
});

test("segmentBoundaryEle: defers to a point liftSnap already reconstructed, but still drops its untouched neighbours", () => {
  const out = headBoundaryTrack();
  out[2].liftSnap = { ele: 900.2 }; // one point mid-jitter already has a trustworthy reconstruction
  out[3].liftSnap = { ele: 900.9 };
  finalize(out, { g: {} });
  assert.equal(out[2].segmentBoundaryEle, undefined, "liftSnap-reconstructed point is left alone");
  assert.equal(out[3].segmentBoundaryEle, undefined, "liftSnap-reconstructed point is left alone");
  for (const i of [0, 1, 4, 5]) {
    assert.deepEqual(out[i].segmentBoundaryEle, { ele: null }, `index ${i} still dropped`);
  }
  // the trigger decision itself still reads raw ele (unaffected by which points get skipped on write)
  for (let i = 6; i < out.length; i++)
    assert.equal(out[i].segmentBoundaryEle, undefined, `index ${i}`);
});

test("segmentBoundaryEle: no segment at all on any point -> no-op", () => {
  const out = [900, 900.5, 900.2, 900.9, 900.4, 901.2].map((ele, i) => {
    const { segment, ...rest } = pt({ ele, time: i * 1000 });
    return rest;
  });
  finalize(out, { g: {} });
  assert.ok(out.every((p) => p.segmentBoundaryEle === undefined));
});
