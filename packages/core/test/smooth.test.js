import assert from "node:assert/strict";
import { test } from "node:test";
import { compute } from "../src/mods/smooth.js";

// variance of (a - b) elementwise
const sqErr = (a, b) => a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0) / a.length;

// ctx shape the module reads: { el, planarStep (per-point, padded), g }
const ctx = (el, step, win) => ({
  el,
  planarStep: new Array(el.length).fill(step),
  g: { SMOOTH_WIN_M: win },
});

test("smooth: preserves a constant-grade ramp (uniform spacing, symmetric window)", () => {
  const el = Array.from({ length: 11 }, (_, i) => i); // 0..10, +1 per 10 m step
  const { ele } = compute(ctx(el, 10, 25)); // ±25 m -> ±2 steps interior
  // interior points: mean of a symmetric uniform ramp == the centre value
  for (let i = 2; i <= 8; i++) assert.ok(Math.abs(ele[i] - el[i]) < 1e-9, `i=${i} ${ele[i]}`);
});

test("smooth: reduces per-sample noise vs the raw elevation (closer to truth)", () => {
  const truth = Array.from({ length: 41 }, (_, i) => i * 0.5); // gentle ramp
  const noise = truth.map((v, i) => v + (i % 2 ? 3 : -3)); // ±3 m alternating
  const { ele } = compute(ctx(noise, 10, 40)); // ±40 m window averages several samples
  assert.ok(sqErr(ele, truth) < sqErr(noise, truth), "smoothed must be closer to truth");
  assert.ok(sqErr(ele, truth) < 0.25 * sqErr(noise, truth), "and substantially closer");
});

test("smooth: window is distance-domain, not index — wide spacing shrinks the population", () => {
  const el = [0, 10, 20, 30, 40];
  // 100 m steps: ±30 m window contains ONLY the point itself -> output == input (no smoothing)
  const { ele } = compute(ctx(el, 100, 30));
  assert.deepEqual(ele, el);
});

test("smooth: endpoints use a shrinking one-sided window", () => {
  const el = [0, 2, 4, 6, 8]; // 10 m steps
  const { ele } = compute(ctx(el, 10, 15)); // ±15 m -> ±1 step
  assert.equal(ele[0], (0 + 2) / 2); // first point: itself + the next within +15 m
  assert.equal(ele[4], (6 + 8) / 2); // last point: itself + the previous
  assert.equal(ele[2], (2 + 4 + 6) / 3); // interior: ±1
});

test("smooth: empty input is handled", () => {
  assert.deepEqual(compute(ctx([], 10, 30)).ele, []);
});

test("smooth SMOOTH_ROBUST: a window median rejects an ele spike a mean would smear", () => {
  const el = [0, 1, 2, 100, 4, 5, 6]; // spike at index 3
  const base = { el, planarStep: new Array(el.length).fill(10) }; // 10 m steps
  const mean = compute({ ...base, g: { SMOOTH_WIN_M: 25 } }).ele; // ±2 steps
  const med = compute({ ...base, g: { SMOOTH_WIN_M: 25, SMOOTH_ROBUST: true } }).ele;
  assert.ok(mean[3] > 20, `mean smears the spike: ${mean[3]}`); // (1+2+100+4+5)/5 = 22.4
  assert.ok(med[3] < 6, `median rejects the spike: ${med[3]}`); // median([1,2,4,5,100]) = 4
  assert.equal(med[2], 2); // a neighbour is untouched by the spike (median = el[2])
});

test("smooth SMOOTH_ROBUST: still preserves a constant-grade ramp", () => {
  const el = Array.from({ length: 11 }, (_, i) => i);
  const { ele } = compute({
    el,
    planarStep: new Array(11).fill(10),
    g: { SMOOTH_WIN_M: 25, SMOOTH_ROBUST: true },
  });
  for (let i = 2; i <= 8; i++) assert.ok(Math.abs(ele[i] - el[i]) < 1e-9, `i=${i} ${ele[i]}`);
});
