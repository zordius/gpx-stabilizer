import assert from "node:assert/strict";
import { test } from "node:test";
import { repairPoints } from "../src/analyze.js";
import { builtins } from "../src/mods/index.js";

const dequantizeTime = builtins.find((m) => m.name === "dequantizeTime");
const run = (times) =>
  repairPoints(
    times.map((time) => ({ lat: 36, lon: 138, ele: 0, time })),
    [dequantizeTime],
  );

test("dequantizeTime: a +2 s gap re-times the duplicate to the empty middle second (1 Hz recovered)", () => {
  // K(0), dup(0), N(2000)  ->  0, 1000, 2000
  const out = run([0, 0, 2000]);
  assert.deepEqual(
    out.map((p) => p.time),
    [0, 1000, 2000],
  );
  assert.equal(out[0].edited, undefined); // run's first point keeps its time
  assert.deepEqual(out[1].edited.time, { from: 0, to: 1000, by: ["dequantizeTime"] });
  assert.equal(out[2].edited, undefined); // distinct time untouched
});

test("dequantizeTime: a +1 s gap spreads the duplicate to the half-second (sub-second sample)", () => {
  // K(0), dup(0), N(1000)  ->  0, 500, 1000
  const out = run([0, 0, 1000]);
  assert.deepEqual(
    out.map((p) => p.time),
    [0, 500, 1000],
  );
});

test("dequantizeTime: a run of 3 identical stamps spreads evenly up to the next distinct time", () => {
  // 0,0,0, then 3000  ->  0, 1000, 2000, 3000
  const out = run([0, 0, 0, 3000]);
  assert.deepEqual(
    out.map((p) => p.time),
    [0, 1000, 2000, 3000],
  );
});

test("dequantizeTime: a 2 s+ gap caps the shift at +1 s (the rest is no-signal, not spread room)", () => {
  // next fix is 3 s / 5 s away -> the duplicate only moves to the +1 s slot, the rest stays a gap
  assert.deepEqual(
    run([0, 0, 3000]).map((p) => p.time),
    [0, 1000, 3000], // not 0, 1500, 3000
  );
  assert.deepEqual(
    run([0, 0, 5000]).map((p) => p.time),
    [0, 1000, 5000],
  );
  // a 3-run keeps the 1 Hz cadence and stops; it does not stretch to fill a far gap
  assert.deepEqual(
    run([0, 0, 0, 9000]).map((p) => p.time),
    [0, 1000, 2000, 9000],
  );
});

test("dequantizeTime: pulls a duplicate BACK into an empty slot before it (1 2 2 5 5 -> 1 2 3 4 5)", () => {
  const s = (x) => x * 1000;
  // the classic shape: the 5 5 run has no forward room but a gap before -> first 5 fills slot 4
  assert.deepEqual(
    run([s(1), s(2), s(2), s(5), s(5)]).map((p) => p.time),
    [s(1), s(2), s(3), s(4), s(5)],
  );
  // the common non-tail form: 3 5 5 6 -> 3 4 5 6 (next fix is +1 s, so pull back not push)
  assert.deepEqual(
    run([s(3), s(5), s(5), s(6)]).map((p) => p.time),
    [s(3), s(4), s(5), s(6)],
  );
});

test("dequantizeTime: a tail duplicate with a gap before it is pulled back to fill the gap", () => {
  // 0, then a gap, then 5 5 at the end -> first 5 pulled back to slot 4
  assert.deepEqual(
    run([0, 5000, 5000]).map((p) => p.time),
    [0, 4000, 5000],
  );
});

test("dequantizeTime: a duplicate hemmed in on both sides compresses to a sub-second", () => {
  // 4 5 5 at the tail, prev adjacent (no room either side) -> compress, second sample drops later
  assert.deepEqual(
    run([4000, 5000, 5000]).map((p) => p.time),
    [4000, 5000, 5500],
  );
});

test("dequantizeTime: strictly-increasing input is left untouched (no edits)", () => {
  const out = run([0, 1000, 2000]);
  assert.deepEqual(
    out.map((p) => p.time),
    [0, 1000, 2000],
  );
  for (const p of out) assert.equal(p.edited, undefined);
});

test("repairPoints: does not mutate the caller's points", () => {
  const src = [
    { lat: 36, lon: 138, ele: 0, time: 0 },
    { lat: 36, lon: 138, ele: 0, time: 0 },
  ];
  repairPoints(src, [dequantizeTime]);
  assert.deepEqual(
    src.map((p) => p.time),
    [0, 0], // originals unchanged
  );
});
