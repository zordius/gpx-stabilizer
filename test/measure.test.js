import assert from "node:assert/strict";
import { test } from "node:test";
import {
  carveDensity,
  deltas,
  jitter,
  localShape,
  measure,
  PARAMS,
  project,
  speeds,
  windows,
} from "../src/measure.js";

// ════════════════════════════════════════════════════════════════════════════════════════
// Block units — each exported block is tested directly on clean local-meter inputs, so the
// assertions are exact and read without the lat/lon → meters projection in the way.
// ════════════════════════════════════════════════════════════════════════════════════════

const ramp = (n, f = (i) => i) => Array.from({ length: n }, (_, i) => f(i));

test("project: valid-only centre, projects all points, east=+x north=+y", () => {
  const points = [
    { lat: 36, lon: 138, ele: 100, time: 0 },
    { lat: 36.001, lon: 138.001, ele: 110, time: 1000 },
    { lat: 80, lon: 200, ele: 0, time: null }, // excluded — must not move the centre
  ];
  const { xAll, x, y, el, t } = project(points, [0, 1]);
  assert.equal(xAll.length, 3); //                every point projected
  assert.equal(x.length, 2); //                   sub-sequence is valid-only
  assert.ok(x[1] > x[0], "more east -> larger x");
  assert.ok(y[1] > y[0], "more north -> larger y");
  assert.ok(Math.abs(x[0]) < 100, "centre ignores the excluded point");
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

test("measure: runs the blocks over the valid sub-sequence into one bundle", () => {
  const mx = Math.cos((36 * Math.PI) / 180) * 111320;
  const d = 5 / mx; // ~5 m/s east at 1 Hz
  const points = Array.from({ length: 121 }, (_, i) => ({
    lat: 36,
    lon: 138 + i * d,
    ele: 1000,
    time: i * 1000,
  }));
  const m = measure(points, [...points.keys()]);
  assert.equal(m.xAll.length, 121); // every point projected
  assert.equal(m.hs.length, 121); // signals over the valid sub-sequence
  assert.equal(m.n, 121);
  assert.ok(Math.abs(m.hs[60] - 5) < 0.1, `hs=${m.hs[60]}`);
  assert.ok(m.straight[60] > 0.99);
});
