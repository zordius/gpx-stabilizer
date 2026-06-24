import assert from "node:assert/strict";
import { test } from "node:test";
import {
  carveDensity,
  deltas,
  jitter,
  localShape,
  PARAMS,
  project,
  signals,
  speeds,
  spikes,
  triage,
  windows,
} from "../src/signals.js";

// ════════════════════════════════════════════════════════════════════════════════════════
// Block units — each exported block is tested directly on clean local-meter inputs, so the
// assertions are exact and read without the lat/lon → meters projection in the way.
// ════════════════════════════════════════════════════════════════════════════════════════

const ramp = (n, f = (i) => i) => Array.from({ length: n }, (_, i) => f(i));

test("triage: grades each point against the last kept ok point", () => {
  const at = (ms, lat = 36, lon = 138) => ({ lat, lon, ele: 0, time: ms });
  assert.deepEqual(
    triage([
      at(0), //          ok (first timed)
      at(0), //          dupe (same time + position)
      at(0, 36.1), //    error (same time, moved)
      at(500), //        oversample (< 1 s from the kept point)
      at(1500), //       ok (>= 1 s from the last kept point)
      { lat: 36, lon: 138, ele: 0, time: null }, // error (no time)
    ]),
    ["ok", "dupe", "error", "oversample", "ok", "error"],
  );
});

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

test("spikes: flags a perpendicular jump, clears a straight line", () => {
  const n = 40;
  const xs = ramp(n);
  const t = ramp(n);
  const hs = new Array(n).fill(1);
  const flat = new Array(n).fill(0);
  const clean = deltas(xs, flat, t);
  assert.equal(spikes(xs, flat, clean.step, hs, clean.dt, PARAMS)[20], false);
  const bumped = flat.slice();
  bumped[20] = 100; // one point jumps 100 m sideways
  const jumped = deltas(xs, bumped, t);
  assert.equal(spikes(xs, bumped, jumped.step, hs, jumped.dt, PARAMS)[20], true);
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
  assert.equal(m.gpsStatus, "ok");
  assert.equal(m.lat, 36); //   original fields preserved
  assert.equal(m.ele, 1000);
  assert.ok(Math.abs(m.hs - 5) < 0.1, `hs=${m.hs}`);
  assert.ok(Math.abs(m.netsp - 5) < 0.2, `netsp=${m.netsp}`);
  assert.ok(m.straight > 0.99);
  assert.ok(m.wander < 0.05);
  assert.equal(m.carve, 0);
  assert.equal(m.paused, false);
  assert.equal(m.outlier, false);
});

test("signals: vs signs with climb and descent", () => {
  assert.ok(signals(track({ n: 121, dlon: STEP5, dele: 1 }))[60].vs > 0.5);
  assert.ok(signals(track({ n: 121, dlon: STEP5, dele: -1 }))[60].vs < -0.5);
});

test("signals: a GPS spike surfaces as outlier with high jitter", () => {
  const pts = track({ n: 121, dlon: STEP5 });
  pts[60] = { ...pts[60], lat: pts[60].lat + 50 / 110540 }; // ~50 m sideways jump
  const out = signals(pts);
  assert.equal(out[60].outlier, true);
  assert.ok(out[60].maDist > 10, `maDist=${out[60].maDist}`);
});

test("signals: missing elevations are interpolated, never NaN", () => {
  const pts = track({ n: 30, dlon: STEP5, dele: 1 });
  pts[10].ele = null;
  pts[11].ele = null;
  for (const p of signals(pts)) assert.ok(Number.isFinite(p.vs) && Number.isFinite(p.maDist));
});

test("signals: ok points get full signals; excluded points get only position + status", () => {
  const out = signals([
    { lat: 36, lon: 138, ele: 1000, time: 0 }, //        ok
    { lat: 36, lon: 138, ele: 1000, time: 0 }, //        dupe
    { lat: 36, lon: 138.001, ele: 1000, time: 0 }, //    error (same time, moved)
    { lat: 36, lon: 138.002, ele: 1000, time: 500 }, //  oversample
    { lat: 36, lon: 138.01, ele: 1000, time: 1500 }, //  ok
    { lat: 36, lon: 138.02, ele: 1000, time: null }, //  error (no time)
  ]);
  assert.deepEqual(
    out.map((p) => p.gpsStatus),
    ["ok", "dupe", "error", "oversample", "ok", "error"],
  );
  for (const p of out) assert.equal(typeof p.x, "number"); // every point projected
  for (const i of [1, 2, 3, 5]) assert.equal(out[i].hs, undefined, `excluded #${i} has no signals`);
  assert.equal(typeof out[0].hs, "number"); // ok points carry signals
  assert.equal(typeof out[4].hs, "number");
});

test("signals: resamples dense input to ~1 ok point per second", () => {
  const pts = Array.from({ length: 21 }, (_, i) => ({
    lat: 36,
    lon: 138 + i * 1e-5,
    ele: 1000,
    time: i * 100, // 10 Hz
  }));
  assert.equal(signals(pts).filter((p) => p.gpsStatus === "ok").length, 3); // t = 0, 1000, 2000 ms
});

test("signals: an excluded point does not shift the projection centre", () => {
  const pts = track({ n: 121, dlon: STEP5 });
  pts.splice(61, 0, { lat: 80, lon: 200, ele: 0, time: 60500 }); // wild oversample
  const out = signals(pts);
  assert.equal(out[61].gpsStatus, "oversample");
  assert.ok(Math.abs(out[60].x) < 1, "centre unaffected by the excluded point");
});

test("signals: leading untimed point is error; the first timed point is ok", () => {
  const out = signals([
    { lat: 36, lon: 138, ele: 1000, time: null },
    { lat: 36, lon: 138.001, ele: 1000, time: 1000 },
    { lat: 36, lon: 138.002, ele: 1000, time: 2000 },
  ]);
  assert.deepEqual(
    out.map((p) => p.gpsStatus),
    ["error", "ok", "ok"],
  );
});

test("signals: with no timed points the centre falls back to all points", () => {
  const out = signals([
    { lat: 36, lon: 138, ele: 1000, time: null },
    { lat: 37, lon: 139, ele: 1000, time: null },
  ]);
  assert.deepEqual(
    out.map((p) => p.gpsStatus),
    ["error", "error"],
  );
  assert.ok(out[0].x < 0 && out[1].x > 0, "centred between the two points");
});
