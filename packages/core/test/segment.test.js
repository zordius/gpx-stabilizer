import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze } from "../src/analyze.js";
import * as segment from "../src/mods/segment.js";

// segment is an opt-in finalize module (not a built-in) — pass it via opts.modules.
const mod = { name: "segment", finalize: segment.finalize };

const LAT = 36;
const MX = Math.cos((LAT * Math.PI) / 180) * 111320;
const STEP = 5 / MX; // ~5 m/s eastward

/** climbSecs at +climbRate m/s of ele, then descendSecs at −descendRate, 1 Hz, moving horizontally. */
function liftThenRun({ climbSecs, descendSecs, climbRate = 1, descendRate = 2 }) {
  const pts = [];
  let ele = 1000;
  for (let i = 0; i < climbSecs + descendSecs; i++) {
    ele += i < climbSecs ? climbRate : -descendRate;
    pts.push({ lat: LAT, lon: 138 + i * STEP, ele, time: i * 1000 });
  }
  return pts;
}

test("segment: labels a sustained climb as lift and a sustained descent as descent", () => {
  const out = analyze(liftThenRun({ climbSecs: 90, descendSecs: 90 }), {
    modules: [mod],
    SEG_MIN_S: 20, // keep the two phases as distinct episodes for the test
  });
  const kept = out.filter((p) => !p.dropReason);
  // a point well inside the climb is lift; well inside the descent is descent
  const climbPt = kept.find((p) => p.time === 30000);
  const descPt = kept.find((p) => p.time === 150000);
  assert.equal(climbPt.segment.type, "lift");
  assert.equal(descPt.segment.type, "descent");
  assert.ok(descPt.segment.id > climbPt.segment.id); // distinct, ordered episodes
});

test("segment: only kept points are labelled; a clean flat run is one flat segment", () => {
  const flat = Array.from({ length: 60 }, (_, i) => ({
    lat: LAT,
    lon: 138 + i * STEP,
    ele: 1000,
    time: i * 1000,
  }));
  const out = analyze(flat, { modules: [mod] });
  const kept = out.filter((p) => !p.dropReason);
  assert.ok(kept.every((p) => p.segment?.type === "flat")); // no vertical motion → flat
  assert.ok(kept.every((p) => p.segment.id === 0)); // one contiguous segment
});

test("segment: base stabilize is unchanged when the module is not passed", () => {
  const out = analyze(liftThenRun({ climbSecs: 30, descendSecs: 30 })); // no modules
  assert.ok(out.every((p) => p.segment === undefined)); // opt-in: nothing attached
});
