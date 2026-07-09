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

// --- descent-break override (2026-07-09) ---

const stepNorth = (v) => v / 111320; // deg lat per second at v m/s northward
const stepEast = (v) => v / MX; // deg lon per second at v m/s eastward

test("segment: a short real descent to a genuinely DIFFERENT lift is not absorbed — two lift segments", () => {
  const pts = [];
  let lat = LAT;
  let lon = 138;
  let ele = 1000;
  let time = 0;
  // lift1: climbs due north for 30s
  for (let i = 0; i < 30; i++) {
    lat += stepNorth(4);
    ele += 1;
    pts.push({ lat, lon, ele, time });
    time += 1000;
  }
  // real ski-away: 40s heading due EAST instead (90° off lift1's own line) while losing elevation —
  // growing lateral distance from lift1's line the whole time. Long enough that a point well inside
  // it has the full ±15s detection-denoise window contained within the descent itself (no dilution
  // from the climbs on either side), so it raw-classifies as "descent" and not "flat".
  for (let i = 0; i < 40; i++) {
    lon += stepEast(4);
    ele -= 3;
    pts.push({ lat, lon, ele, time });
    time += 1000;
  }
  // lift2: climbs due north again, on a new (offset) parallel line — long enough (its own EFFECTIVE
  // span, after the detection-denoise window bleeds a few seconds of "flat" off its own leading
  // edge, still clears SEG_MIN_S below) to stand on its own regardless of the descent-break gate
  // (which only ever restricts absorbing a `descent`-typed candidate; a `lift`-typed one this short
  // would otherwise still get silently absorbed backward by the plain MIN_S rule, defeating the test)
  for (let i = 0; i < 100; i++) {
    lat += stepNorth(4);
    ele += 1;
    pts.push({ lat, lon, ele, time });
    time += 1000;
  }
  const out = analyze(pts, { modules: [mod], SEG_MIN_S: 60 });
  const kept = out.filter((p) => !p.dropReason);
  const climb1 = kept.find((p) => p.time === 15000);
  const descent = kept.find((p) => p.time === 50000);
  const climb2 = kept.find((p) => p.time === 100000);
  assert.equal(climb1.segment.type, "lift");
  assert.equal(descent.segment.type, "descent");
  assert.equal(climb2.segment.type, "lift");
  assert.notEqual(climb1.segment.id, climb2.segment.id); // two DISTINCT lift episodes, not glued together
});

test("segment: a brief same-direction dip (no heading break) is still absorbed into the one lift episode", () => {
  const pts = [];
  let lat = LAT;
  let ele = 1000;
  let time = 0;
  // lift1: climbs due north for 30s
  for (let i = 0; i < 30; i++) {
    lat += stepNorth(4);
    ele += 1;
    pts.push({ lat, lon: 138, ele, time });
    time += 1000;
  }
  // an elevation dip continuing the SAME direction (no real horizontal break) — e.g. a transient
  // sky-occlusion sag, not a departure to a different lift. Same long shape as the real-descent test
  // above so this also raw-classifies as "descent" and genuinely exercises the new gate's "heading
  // matches -> still safe to absorb" branch, not just pre-existing flat-merging.
  for (let i = 0; i < 40; i++) {
    lat += stepNorth(4);
    ele -= 3;
    pts.push({ lat, lon: 138, ele, time });
    time += 1000;
  }
  const out = analyze(pts, { modules: [mod], SEG_MIN_S: 60 });
  const kept = out.filter((p) => !p.dropReason);
  const climb1 = kept.find((p) => p.time === 15000);
  const dip = kept.find((p) => p.time === 50000);
  assert.equal(climb1.segment.type, "lift");
  assert.equal(dip.segment.type, "lift"); // absorbed into the same lift episode, not its own descent
  assert.equal(dip.segment.id, climb1.segment.id);
});

// --- lift-sandwich merge (2026-07-09) ---
// The "reject" side of this rule (heading well off from both neighbours -> stays split) is already
// exercised by the descent-break test above: its 90°-off ski-away is ALSO a lift-sandwiched non-lift
// episode, and asserting `climb1.segment.id !== climb2.segment.id` there only holds if this merge
// pass leaves it alone too. Only the "accept" shape needs its own dedicated test here.

test("segment: a long same-direction, same-speed FLAT stretch between two lifts merges into one ride", () => {
  const pts = [];
  let lat = LAT;
  let ele = 1000;
  let time = 0;
  // lift1: climbs due north for 30s
  for (let i = 0; i < 30; i++) {
    lat += stepNorth(4);
    ele += 1;
    pts.push({ lat, lon: 138, ele, time });
    time += 1000;
  }
  // a long (> MIN_S), genuinely shallower stretch of the SAME ride — same direction, same speed,
  // just a climb rate (0.1 m/s) under V_ON — e.g. the cable line easing through a flatter section
  for (let i = 0; i < 80; i++) {
    lat += stepNorth(4);
    ele += 0.1;
    pts.push({ lat, lon: 138, ele, time });
    time += 1000;
  }
  // lift2: climbs due north again, long enough to stand on its own before the sandwich pass even runs
  for (let i = 0; i < 90; i++) {
    lat += stepNorth(4);
    ele += 1;
    pts.push({ lat, lon: 138, ele, time });
    time += 1000;
  }
  const out = analyze(pts, { modules: [mod] }); // default SEG_MIN_S (60)
  const kept = out.filter((p) => !p.dropReason);
  const climb1 = kept.find((p) => p.time === 15000);
  const flat = kept.find((p) => p.time === 70000);
  const climb2 = kept.find((p) => p.time === 150000);
  assert.equal(climb1.segment.type, "lift");
  assert.equal(flat.segment.type, "lift"); // merged in, not left as its own "flat" episode
  assert.equal(climb2.segment.type, "lift");
  assert.equal(flat.segment.id, climb1.segment.id);
  assert.equal(climb2.segment.id, climb1.segment.id); // all three -> ONE ride
});
