import assert from "node:assert/strict";
import { test } from "node:test";
import { resample } from "../src/resample.js";

// point at time t (ms) with optional fields
const p = (t, lat, lon, ele, speed) => ({
  lat,
  lon,
  ele,
  time: t,
  ...(speed != null ? { speed } : {}),
});

test("resample: uniform input passes through onto the same 1 Hz grid", () => {
  const pts = [p(0, 10, 20, 100), p(1000, 11, 21, 110), p(2000, 12, 22, 120), p(3000, 13, 23, 130)];
  const segs = resample(pts);
  assert.equal(segs.length, 1);
  assert.deepEqual(
    segs[0].map((q) => q.time),
    [0, 1000, 2000, 3000],
  );
  assert.equal(segs[0][2].lat, 12); // grid time == input time -> value unchanged
});

test("resample: linearly interpolates lat/lon/ele/speed at grid times", () => {
  const segs = resample([p(0, 0, 0, 100, 4), p(2000, 2, 4, 200, 8)]); // 1 Hz -> grid 0,1000,2000
  const mid = segs[0][1];
  assert.equal(mid.time, 1000);
  assert.equal(mid.lat, 1);
  assert.equal(mid.lon, 2);
  assert.equal(mid.ele, 150);
  assert.equal(mid.speed, 6); // speed carried + interpolated when present
});

test("resample: RESAMPLE_HZ sets the grid step", () => {
  const segs = resample([p(0, 0, 0, 0), p(1000, 1, 0, 0)], { RESAMPLE_HZ: 2 }); // step 500 ms
  assert.deepEqual(
    segs[0].map((q) => q.time),
    [0, 500, 1000],
  );
  assert.equal(segs[0][1].lat, 0.5);
});

test("resample: a gap longer than maxGap splits into separate segments (no straight bridge)", () => {
  const pts = [p(0, 0, 0, 0), p(1000, 1, 0, 0), p(20000, 5, 0, 0), p(21000, 6, 0, 0)];
  const segs = resample(pts); // default maxGap 10 s; the 19 s hole splits
  assert.equal(segs.length, 2);
  assert.equal(segs[0].at(-1).time, 1000);
  assert.equal(segs[1][0].time, 20000);
});

test("resample: a gap within maxGap is bridged (one segment, interpolated across)", () => {
  const segs = resample([p(0, 0, 0, 0), p(5000, 5, 0, 0)], { maxGap: 10 }); // 5 s hole < 10 s
  assert.equal(segs.length, 1);
  assert.equal(segs[0].length, 6); // 0..5000 at 1 Hz
  assert.equal(segs[0][3].lat, 3); // interpolated mid-gap
});

test("resample: a single point passes through; an empty / untimed input yields no segments", () => {
  assert.deepEqual(resample([p(5000, 1, 2, 3)]), [[{ lat: 1, lon: 2, ele: 3, time: 5000 }]]);
  assert.deepEqual(resample([]), []);
  assert.deepEqual(resample([{ lat: 1, lon: 2, ele: 3, time: null }]), []);
});

test("resample: a sub-step run keeps its real points rather than dropping them", () => {
  // span 300 ms at 1 Hz: no integer-second grid time lands inside -> keep the two real points
  const segs = resample([p(1300, 1, 1, 1), p(1600, 2, 2, 2)]);
  assert.equal(segs.length, 1);
  assert.deepEqual(
    segs[0].map((q) => q.time),
    [1300, 1600],
  );
});
