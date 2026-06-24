import assert from "node:assert/strict";
import { test } from "node:test";
import { deltas, measure, project } from "../src/measure.js";

// ════════════════════════════════════════════════════════════════════════════════════════
// Point-level blocks — projection + adjacent deltas, the parameter-free core. Tested directly
// on clean inputs; windowed descriptors live in profile.test.js.
// ════════════════════════════════════════════════════════════════════════════════════════

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

test("measure: projects all points and takes adjacent deltas over the valid sub-sequence", () => {
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
  assert.equal(m.n, 121);
  assert.equal(m.step.length, 120); // adjacent-pair deltas over the sub-sequence
  assert.equal(m.dt.length, 120);
  assert.ok(Math.abs(m.step[60] - 5) < 0.1, `step=${m.step[60]}`); // ~5 m between samples
  assert.equal(m.dt[60], 1); // 1 s between samples
});
