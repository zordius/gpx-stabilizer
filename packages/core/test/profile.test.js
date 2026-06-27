import assert from "node:assert/strict";
import { test } from "node:test";
import { deltas, measure } from "../src/measure.js";
import {
  carveDensity,
  jitter,
  localShape,
  PARAMS,
  profile,
  speeds,
  windows,
} from "../src/profile.js";

// ════════════════════════════════════════════════════════════════════════════════════════
// Window-level blocks — each ±window descriptor tested directly on clean local-meter inputs,
// so the assertions are exact and read without the lat/lon → meters projection in the way.
// ════════════════════════════════════════════════════════════════════════════════════════

const ramp = (n, f = (i) => i) => Array.from({ length: n }, (_, i) => f(i));

test("speeds: hs ~ step/dt; vs signs with elevation change", () => {
  const n = 40;
  const planarStep = new Array(n - 1).fill(5); // 5 m per step
  const dt = new Array(n - 1).fill(1); //  1 s per step
  const flat = new Array(n).fill(1000);
  const climb = ramp(n, (i) => 1000 + i); // +1 m/s
  const drop = ramp(n, (i) => 1000 - i); // -1 m/s
  assert.ok(Math.abs(speeds(planarStep, dt, flat, PARAMS).hs[20] - 5) < 0.01);
  assert.ok(speeds(planarStep, dt, climb, PARAMS).vs[20] > 0.5);
  assert.ok(speeds(planarStep, dt, drop, PARAMS).vs[20] < -0.5);
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
  assert.equal(carveDensity(xs, straightY, deltas(xs, straightY, xs).planarStep, PARAMS)[30], 0);
  const sineY = ramp(n, (i) => 10 * Math.sin(i / 3)); // sweeping S -> repeated crossings
  assert.ok(carveDensity(xs, sineY, deltas(xs, sineY, xs).planarStep, PARAMS)[30] > 0);
});

test("profile: turns a measure bundle into the windowed descriptors", () => {
  const mx = Math.cos((36 * Math.PI) / 180) * 111320;
  const d = 5 / mx; // ~5 m/s east at 1 Hz
  const points = Array.from({ length: 121 }, (_, i) => ({
    lat: 36,
    lon: 138 + i * d,
    ele: 1000,
    time: i * 1000,
  }));
  const p = profile(measure(points, [...points.keys()]));
  assert.equal(p.hs.length, 121); // descriptors over the valid sub-sequence
  assert.ok(Math.abs(p.hs[60] - 5) < 0.1, `hs=${p.hs[60]}`);
  assert.ok(p.straight[60] > 0.99);
  assert.equal(p.paused[60], false);
});
