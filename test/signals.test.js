import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addDrop,
  carveDensity,
  deltas,
  jitter,
  localShape,
  PARAMS,
  project,
  signals,
  speeds,
  windows,
} from "../src/signals.js";

// ════════════════════════════════════════════════════════════════════════════════════════
// Block units — each exported block is tested directly on clean local-meter inputs, so the
// assertions are exact and read without the lat/lon → meters projection in the way.
// ════════════════════════════════════════════════════════════════════════════════════════

const ramp = (n, f = (i) => i) => Array.from({ length: n }, (_, i) => f(i));

test("project: ok-only centre, projects all points, east=+x north=+y", () => {
  const points = [
    { lat: 36, lon: 138, ele: 100, time: 0 },
    { lat: 36.001, lon: 138.001, ele: 110, time: 1000 },
    { lat: 80, lon: 200, ele: 0, time: null }, // error — must not move the centre
  ];
  const { xAll, x, y, el, t } = project(points, [0, 1]);
  assert.equal(xAll.length, 3); //                every point projected
  assert.equal(x.length, 2); //                   sub-sequence is ok-only
  assert.ok(x[1] > x[0], "more east -> larger x");
  assert.ok(y[1] > y[0], "more north -> larger y");
  assert.ok(Math.abs(x[0]) < 100, "centre ignores the error point");
  assert.deepEqual(t, [0, 1]); //                 ms -> s
  assert.deepEqual(el, [100, 110]); //            elevation carried through
});

test("deltas: step distance and dt floored at 1 second", () => {
  const { dt, step } = deltas([0, 3, 3], [0, 4, 4], [0, 2, 2.5]); // t in seconds
  assert.deepEqual(
    step.map((v) => Math.round(v)),
    [5, 0], //   3-4-5 triangle, then no movement
  );
  assert.deepEqual(dt, [2, 1]); // 2 s, then 0.5 s floored to 1
});

test("speeds: hs ~ step/dt; vs signs with elevation change", () => {
  const n = 40;
  const step = new Array(n - 1).fill(5); // 5 m per step
  const dt = new Array(n - 1).fill(1); //  1 s per step
  const flat = new Array(n).fill(1000);
  const climb = ramp(n, (i) => 1000 + i); // +1 m/s
  const drop = ramp(n, (i) => 1000 - i); // -1 m/s
  assert.ok(Math.abs(speeds(step, dt, flat, PARAMS).hs[20] - 5) < 0.01);
  assert.ok(speeds(step, dt, climb, PARAMS).vs[20] > 0.5);
  assert.ok(speeds(step, dt, drop, PARAMS).vs[20] < -0.5);
});

test("localShape: straight ~ 1, zigzag < 1; steady ~ 0 for constant speed", () => {
  const n = 40;
  const xs = ramp(n);
  const hs = new Array(n).fill(5);
  const sawY = ramp(n, (i) => i % 2); // zig-zag across the path
  const line = localShape(xs, new Array(n).fill(0), hs, PARAMS);
  assert.ok(line.straight[20] > 0.99, `straight=${line.straight[20]}`);
  assert.ok(line.steady[20] < 0.01, `steady=${line.steady[20]}`);
  assert.ok(localShape(xs, sawY, hs, PARAMS).straight[20] < 0.95);
});

test("addDrop: records reasons and maintains dropReason + dropCount", () => {
  const p = {};
  addDrop(p, "outlier", { detour: 90 });
  addDrop(p, "drift", true);
  addDrop(p, "outlier", { detour: 95 }); // same key updates context, not the count
  assert.deepEqual(p.dropReason, { outlier: { detour: 95 }, drift: true });
  assert.equal(p.dropCount, 2);
});

test("jitter: zero distance on a smooth line, positive at an off-line point", () => {
  const n = 40;
  const xs = ramp(n);
  const el = new Array(n).fill(1000);
  const clean = jitter(xs, new Array(n).fill(0), el, PARAMS);
  assert.ok(clean.maDist[20] < 1e-9, `maDist=${clean.maDist[20]}`);
  assert.ok(Array.isArray(clean.cu.x), "cumulative vectors returned for windows()");
  const bumped = new Array(n).fill(0);
  bumped[20] = 30;
  assert.ok(jitter(xs, bumped, el, PARAMS).maDist[20] > 5);
});

test("windows: net speed/displacement, wander, and paused", () => {
  const n = 121;
  const xs = ramp(n); // 1 m/s east at 1 Hz
  const ys = new Array(n).fill(0);
  const el = new Array(n).fill(0);
  const t = ramp(n);
  const w = windows(xs, ys, t, jitter(xs, ys, el, PARAMS).cu, PARAMS);
  assert.ok(Math.abs(w.netsp[60] - 1) < 0.05, `netsp=${w.netsp[60]}`); // 1 m/s
  assert.ok(Math.abs(w.netd150[60] - 120) < 1, `netd150=${w.netd150[60]}`); // full-track disp
  assert.ok(w.wander[60] < 0.05, "straight -> low wander");
  assert.equal(w.paused[60], false);
  const still = new Array(n).fill(0);
  assert.equal(
    windows(still, still, t, jitter(still, still, el, PARAMS).cu, PARAMS).paused[60],
    true,
  );
  const zz = ramp(n, (i) => i % 2); // jitter in place -> high wander
  assert.ok(windows(zz, ys, t, jitter(zz, ys, el, PARAMS).cu, PARAMS).wander[60] > 0.5);
});

test("carveDensity: zero for a straight line, positive for an S-curve", () => {
  const n = 60;
  const xs = ramp(n);
  const straightY = new Array(n).fill(0);
  assert.equal(carveDensity(xs, straightY, deltas(xs, straightY, xs).step, PARAMS)[30], 0);
  const sineY = ramp(n, (i) => 10 * Math.sin(i / 3)); // sweeping S -> repeated crossings
  assert.ok(carveDensity(xs, sineY, deltas(xs, sineY, xs).step, PARAMS)[30] > 0);
});

// ════════════════════════════════════════════════════════════════════════════════════════
// signals() integration — wiring (blocks fed the right arrays), assembly, gpsStatus flow,
// resample, centre exclusion, and edges. Tracks use real lat/lon so projection is exercised.
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

test("signals: empty input yields an empty array", () => {
  assert.deepEqual(signals([]), []);
});

test("signals: end-to-end wiring on a known straight run", () => {
  const m = signals(track({ n: 121, dlon: STEP5 }))[60];
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

test("signals: vs signs with climb and descent", () => {
  assert.ok(signals(track({ n: 121, dlon: STEP5, dele: 1 }))[60].vs > 0.5);
  assert.ok(signals(track({ n: 121, dlon: STEP5, dele: -1 }))[60].vs < -0.5);
});

test("signals: a GPS spike becomes an outlier drop reason with high jitter", () => {
  const pts = track({ n: 121, dlon: STEP5 });
  pts[60] = { ...pts[60], lat: pts[60].lat + 50 / 110540 }; // ~50 m sideways jump
  const out = signals(pts);
  assert.equal(out[60].dropCount, 1);
  assert.ok(out[60].dropReason.outlier.detour > PARAMS.D_JUMP);
  assert.ok(out[60].maDist > 10, `maDist=${out[60].maDist}`);
});

test("signals: missing elevations are interpolated, never NaN", () => {
  const pts = track({ n: 30, dlon: STEP5, dele: 1 });
  pts[10].ele = null;
  pts[11].ele = null;
  for (const p of signals(pts)) assert.ok(Number.isFinite(p.vs) && Number.isFinite(p.maDist));
});

test("signals: kept points get full signals; dropped points get only position + drop reasons", () => {
  const out = signals([
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

test("signals: resamples dense input to ~1 kept point per second", () => {
  const pts = Array.from({ length: 21 }, (_, i) => ({
    lat: 36,
    lon: 138 + i * 1e-5,
    ele: 1000,
    time: i * 100, // 10 Hz
  }));
  assert.equal(signals(pts).filter((p) => !p.dropReason).length, 3); // t = 0, 1000, 2000 ms
});

test("signals: a dropped point does not shift the projection centre", () => {
  const pts = track({ n: 121, dlon: STEP5 });
  pts.splice(61, 0, { lat: 80, lon: 200, ele: 0, time: 60500 }); // wild, < 1 s after a kept point
  const out = signals(pts);
  assert.ok(out[61].dropReason.oversample); // resampled out
  assert.ok(Math.abs(out[60].x) < 1, "centre unaffected by the dropped point");
});

test("signals: leading untimed point is dropped (noTime); the first timed point is kept", () => {
  const out = signals([
    { lat: 36, lon: 138, ele: 1000, time: null },
    { lat: 36, lon: 138 + STEP5, ele: 1000, time: 1000 },
    { lat: 36, lon: 138 + 2 * STEP5, ele: 1000, time: 2000 },
  ]);
  assert.ok(out[0].dropReason.noTime);
  assert.equal(out[1].dropReason, undefined);
  assert.equal(out[2].dropReason, undefined);
});

test("signals: a module's run output attaches under its name on each ok point", () => {
  const demo = {
    name: "demo",
    compute: (ctx) => ({ a: ctx.hs.map((v) => v * 2), q: ctx.hs.map(() => 7) }),
  };
  const out = signals(track({ n: 5, dlon: STEP5 }), { modules: [demo] });
  assert.deepEqual(Object.keys(out[2].demo).sort(), ["a", "q"]);
  assert.equal(out[2].demo.a, out[2].hs * 2); // the module saw the base signals
  assert.equal(out[2].demo.q, 7);
});

test("signals: a module adds a drop reason via a drop array under its name", () => {
  const mymod = {
    name: "mymod",
    compute: (ctx) => ({ drop: ctx.x.map((_, k) => (k === 2 ? { why: "demo" } : null)) }),
  };
  const out = signals(track({ n: 5, dlon: STEP5 }), { modules: [mymod] });
  assert.deepEqual(out[2].dropReason.mymod, { why: "demo" });
  assert.equal(out[2].dropCount, 1);
  assert.equal(out[2].mymod, undefined); // drop-only module attaches no namespaced signals
  assert.equal(out[0].dropReason, undefined); // other points untouched
});

test("signals: a module exposing both check and run is used in both phases", () => {
  const both = {
    name: "both",
    screen: (p, q) => (q && p.lon === q.lon ? { dup: true } : null), // screen: drop a repeat lon
    compute: (ctx) => ({ doubled: ctx.hs.map((v) => v * 2) }), //      compute: a namespaced signal
  };
  const out = signals(
    [
      { lat: 36, lon: 138, ele: 0, time: 0 }, //                kept
      { lat: 36, lon: 138, ele: 0, time: 2000 }, //             check drops (same lon as last kept)
      { lat: 36, lon: 138 + STEP5, ele: 0, time: 4000 }, //     kept
    ],
    { modules: [both] },
  );
  assert.deepEqual(out[1].dropReason.both, { dup: true }); // screen fired
  assert.equal(typeof out[0].both.doubled, "number"); // run fired (signal) on a kept point
  assert.equal(out[1].both, undefined); // dropped point has no signal-phase data
});

test("signals: excluded points get no module data", () => {
  const m = { name: "m", compute: (ctx) => ({ a: ctx.hs }) };
  const out = signals(
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

test("signals: with no timed points the centre falls back to all points", () => {
  const out = signals([
    { lat: 36, lon: 138, ele: 1000, time: null },
    { lat: 37, lon: 139, ele: 1000, time: null },
  ]);
  assert.deepEqual(
    out.map((p) => Object.keys(p.dropReason)[0]),
    ["noTime", "noTime"],
  );
  assert.ok(out[0].x < 0 && out[1].x > 0, "centred between the two points");
});
