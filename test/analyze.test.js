import assert from "node:assert/strict";
import { test } from "node:test";
import { addDrop, analyze } from "../src/analyze.js";
import { PARAMS } from "../src/measure.js";

// ════════════════════════════════════════════════════════════════════════════════════════
// analyze() integration — screen → measure → compute → assemble: wiring, drop reasons, the
// 1 Hz resample, centre exclusion, modules, and edges. Tracks use real lat/lon so projection
// is exercised end to end.
// ════════════════════════════════════════════════════════════════════════════════════════

const LAT = 36;
const MX = Math.cos((LAT * Math.PI) / 180) * 111320;
const STEP5 = 5 / MX; // ~5 m/s eastward in degrees of longitude

/** Build a 1 Hz track. dlon/dlat advance per sample; dele is m/s of elevation change. */
function track({ n, lon = 138, lat = LAT, dlon = 0, dlat = 0, ele = 1000, dele = 0 }) {
  return Array.from({ length: n }, (_, i) => ({
    lat: lat + i * dlat,
    lon: lon + i * dlon,
    ele: ele + i * dele,
    time: i * 1000,
  }));
}

test("addDrop: records reasons and maintains dropReason + dropCount", () => {
  const p = {};
  addDrop(p, "outlier", { detour: 90 });
  addDrop(p, "drift", true);
  addDrop(p, "outlier", { detour: 95 }); // same key updates context, not the count
  assert.deepEqual(p.dropReason, { outlier: { detour: 95 }, drift: true });
  assert.equal(p.dropCount, 2);
});

test("analyze: empty input yields an empty array", () => {
  assert.deepEqual(analyze([]), []);
});

test("analyze: end-to-end wiring on a known straight run", () => {
  const m = analyze(track({ n: 121, dlon: STEP5 }))[60];
  assert.equal(m.lat, 36); //   original fields preserved
  assert.equal(m.ele, 1000);
  assert.ok(Math.abs(m.hs - 5) < 0.1, `hs=${m.hs}`);
  assert.ok(Math.abs(m.netsp - 5) < 0.2, `netsp=${m.netsp}`);
  assert.ok(m.straight > 0.99);
  assert.ok(m.wander < 0.05);
  assert.equal(m.carve, 0);
  assert.equal(m.paused, false);
  assert.equal(m.dropReason, undefined); // a clean point has no drop reasons
});

test("analyze: vs signs with climb and descent", () => {
  assert.ok(analyze(track({ n: 121, dlon: STEP5, dele: 1 }))[60].vs > 0.5);
  assert.ok(analyze(track({ n: 121, dlon: STEP5, dele: -1 }))[60].vs < -0.5);
});

test("analyze: a GPS spike becomes an outlier drop reason with high jitter", () => {
  const pts = track({ n: 121, dlon: STEP5 });
  pts[60] = { ...pts[60], lat: pts[60].lat + 50 / 110540 }; // ~50 m sideways jump
  const out = analyze(pts);
  assert.equal(out[60].dropCount, 1);
  assert.ok(out[60].dropReason.outlier.detour > PARAMS.D_JUMP);
  assert.ok(out[60].maDist > 10, `maDist=${out[60].maDist}`);
});

test("analyze: missing elevations are interpolated, never NaN", () => {
  const pts = track({ n: 30, dlon: STEP5, dele: 1 });
  pts[10].ele = null;
  pts[11].ele = null;
  for (const p of analyze(pts)) assert.ok(Number.isFinite(p.vs) && Number.isFinite(p.maDist));
});

test("analyze: kept points get full signals; dropped points get only position + drop reasons", () => {
  const out = analyze([
    { lat: 36, lon: 138, ele: 1000, time: 0 }, //                  kept
    { lat: 36, lon: 138, ele: 1000, time: 0 }, //                  sameTime
    { lat: 36, lon: 138 + STEP5, ele: 1000, time: 0 }, //          sameTime (moved)
    { lat: 36, lon: 138 + 2 * STEP5, ele: 1000, time: 500 }, //    oversample
    { lat: 36, lon: 138 + 3 * STEP5, ele: 1000, time: 1500 }, //   kept
    { lat: 36, lon: 138 + 4 * STEP5, ele: 1000, time: null }, //   noTime
  ]);
  assert.deepEqual(
    out.map((p) => (p.dropReason ? Object.keys(p.dropReason)[0] : "kept")),
    ["kept", "sameTime", "sameTime", "oversample", "kept", "noTime"],
  );
  for (const p of out) assert.equal(typeof p.x, "number"); // every point projected
  for (const i of [1, 2, 3, 5]) assert.equal(out[i].hs, undefined, `dropped #${i} has no signals`);
  assert.equal(typeof out[0].hs, "number"); // kept points carry signals
  assert.equal(typeof out[4].hs, "number");
});

test("analyze: resamples dense input to ~1 kept point per second", () => {
  const pts = Array.from({ length: 21 }, (_, i) => ({
    lat: 36,
    lon: 138 + i * 1e-5,
    ele: 1000,
    time: i * 100, // 10 Hz
  }));
  assert.equal(analyze(pts).filter((p) => !p.dropReason).length, 3); // t = 0, 1000, 2000 ms
});

test("analyze: a dropped point does not shift the projection centre", () => {
  const pts = track({ n: 121, dlon: STEP5 });
  pts.splice(61, 0, { lat: 80, lon: 200, ele: 0, time: 60500 }); // wild, < 1 s after a kept point
  const out = analyze(pts);
  assert.ok(out[61].dropReason.oversample); // resampled out
  assert.ok(Math.abs(out[60].x) < 1, "centre unaffected by the dropped point");
});

test("analyze: leading untimed point is dropped (noTime); the first timed point is kept", () => {
  const out = analyze([
    { lat: 36, lon: 138, ele: 1000, time: null },
    { lat: 36, lon: 138 + STEP5, ele: 1000, time: 1000 },
    { lat: 36, lon: 138 + 2 * STEP5, ele: 1000, time: 2000 },
  ]);
  assert.ok(out[0].dropReason.noTime);
  assert.equal(out[1].dropReason, undefined);
  assert.equal(out[2].dropReason, undefined);
});

test("analyze: a compute module's output attaches under its name on each kept point", () => {
  const demo = {
    name: "demo",
    compute: (ctx) => ({ a: ctx.hs.map((v) => v * 2), q: ctx.hs.map(() => 7) }),
  };
  const out = analyze(track({ n: 5, dlon: STEP5 }), { modules: [demo] });
  assert.deepEqual(Object.keys(out[2].demo).sort(), ["a", "q"]);
  assert.equal(out[2].demo.a, out[2].hs * 2); // the module saw the base signals
  assert.equal(out[2].demo.q, 7);
});

test("analyze: a module adds a drop reason via a drop array under its name", () => {
  const mymod = {
    name: "mymod",
    compute: (ctx) => ({ drop: ctx.x.map((_, k) => (k === 2 ? { why: "demo" } : null)) }),
  };
  const out = analyze(track({ n: 5, dlon: STEP5 }), { modules: [mymod] });
  assert.deepEqual(out[2].dropReason.mymod, { why: "demo" });
  assert.equal(out[2].dropCount, 1);
  assert.equal(out[2].mymod, undefined); // drop-only module attaches no namespaced signals
  assert.equal(out[0].dropReason, undefined); // other points untouched
});

test("analyze: a module exposing both screen and compute is used in both phases", () => {
  const both = {
    name: "both",
    screen: (p, q) => (q && p.lon === q.lon ? { dup: true } : null), // screen: drop a repeat lon
    compute: (ctx) => ({ doubled: ctx.hs.map((v) => v * 2) }), //      compute: a namespaced signal
  };
  const out = analyze(
    [
      { lat: 36, lon: 138, ele: 0, time: 0 }, //                kept
      { lat: 36, lon: 138, ele: 0, time: 2000 }, //             screen drops (same lon as last kept)
      { lat: 36, lon: 138 + STEP5, ele: 0, time: 4000 }, //     kept
    ],
    { modules: [both] },
  );
  assert.deepEqual(out[1].dropReason.both, { dup: true }); // screen fired
  assert.equal(typeof out[0].both.doubled, "number"); // compute fired on a kept point
  assert.equal(out[1].both, undefined); // dropped point has no compute-phase data
});

test("analyze: excluded points get no module data", () => {
  const m = { name: "m", compute: (ctx) => ({ a: ctx.hs }) };
  const out = analyze(
    [
      { lat: 36, lon: 138, ele: 0, time: 0 }, //  kept
      { lat: 36, lon: 138, ele: 0, time: 0 }, //  sameTime
    ],
    { modules: [m] },
  );
  assert.ok(out[0].m); //                  kept point has the module
  assert.ok(out[1].dropReason.sameTime); // dropped (sameTime)
  assert.equal(out[1].m, undefined); //    dropped point has no module data
});

test("analyze: with no timed points the centre falls back to all points", () => {
  const out = analyze([
    { lat: 36, lon: 138, ele: 1000, time: null },
    { lat: 37, lon: 139, ele: 1000, time: null },
  ]);
  assert.deepEqual(
    out.map((p) => Object.keys(p.dropReason)[0]),
    ["noTime", "noTime"],
  );
  assert.ok(out[0].x < 0 && out[1].x > 0, "centred between the two points");
});
