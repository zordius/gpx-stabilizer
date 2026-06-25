import assert from "node:assert/strict";
import { test } from "node:test";
import { deltas, kinematics, measure, project, speedOf } from "../src/measure.js";

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

test("deltas: planar step distance and dt floored at 1 second", () => {
  const { dt, planarStep } = deltas([0, 3, 3], [0, 4, 4], [0, 2, 2.5]); // t in seconds
  assert.deepEqual(
    planarStep.map((v) => Math.round(v)),
    [5, 0], //   3-4-5 triangle, then no movement
  );
  assert.deepEqual(dt, [2, 1]); // 2 s, then 0.5 s floored to 1
});

test("kinematics: velocity is Δposition/Δt; acceleration is Δvelocity/Δt (3D, vec/dir/mag)", () => {
  // three 1-second steps: east 3 m, then north 4 m, then up 5 m
  const x = [0, 3, 3, 3];
  const y = [0, 0, 4, 4];
  const el = [0, 0, 0, 5];
  const dt = [1, 1, 1];
  const { velocity, acceleration } = kinematics(x, y, el, dt);
  // velocity (1st derivative): vector, magnitude, unit direction
  assert.deepEqual(
    velocity.mag.map((v) => Math.round(v)),
    [3, 4, 5],
  );
  assert.deepEqual([velocity.dir.x[0], velocity.dir.y[0], velocity.dir.z[0]], [1, 0, 0]); // due east
  // acceleration (2nd derivative) = change of the velocity vector; [0] is the zero vector
  assert.deepEqual(
    [acceleration.vec.x[0], acceleration.vec.y[0], acceleration.vec.z[0]],
    [0, 0, 0],
  );
  assert.deepEqual(
    [acceleration.vec.x[1], acceleration.vec.y[1], acceleration.vec.z[1]],
    [-3, 4, 0], // (0,4,0) − (3,0,0)
  );
  assert.ok(Math.abs(acceleration.mag[1] - 5) < 1e-9, `mag=${acceleration.mag[1]}`);
});

test("kinematics: constant velocity -> zero acceleration, steady heading", () => {
  const x = [0, 1, 2, 3];
  const zero = [0, 0, 0, 0];
  const { velocity, acceleration } = kinematics(x, zero, zero, [1, 1, 1]);
  for (const v of velocity.dir.x) assert.equal(v, 1); // unit east every step
  for (const m of acceleration.mag) assert.equal(m, 0); // velocity never changes
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
  assert.equal(m.planarStep.length, 120); // adjacent-pair deltas over the sub-sequence
  assert.equal(m.dt.length, 120);
  assert.ok(Math.abs(m.planarStep[60] - 5) < 0.1, `planarStep=${m.planarStep[60]}`); // ~5 m/step
  assert.equal(m.dt[60], 1); // 1 s between samples
  // 3D kinematics: flat eastward constant-speed run -> speed == planar step, no acceleration
  assert.equal(m.velocity.dir.x.length, 120);
  assert.equal(m.velocity.mag.length, 120);
  assert.equal(m.acceleration.mag.length, 120);
  assert.ok(Math.abs(m.velocity.mag[60] - 5) < 0.1, `speed=${m.velocity.mag[60]}`);
  assert.ok(m.acceleration.mag[60] < 1e-6, `accMag=${m.acceleration.mag[60]}`);
  assert.equal(m.speed.length, 121); // device speed carried per valid point
  assert.equal(m.speed[60], null); // these synthetic points have no <speed>
});

test("speedOf: device speed when present, else the planar velocity magnitude", () => {
  const ctx = {
    speed: [null, 7, null],
    velocity: { vec: { x: [3, 3, 3], y: [4, 4, 4], z: [0, 0, 0] }, mag: [5, 5, 5] },
  };
  assert.equal(speedOf(ctx, 1), 7); // device <speed> present -> use it
  assert.ok(Math.abs(speedOf(ctx, 0) - 5) < 1e-9); // absent -> hypot(3, 4) = 5
});
