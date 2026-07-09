import assert from "node:assert/strict";
import { test } from "node:test";
import { compute } from "../src/mods/gradeBound.js";

// ctx: el + per-point planarStep + dt; 10 m steps at 1 s ⇒ hs = 10 m/s, bound kMax = aMax/100
const ctx = (el, g = {}) => ({
  el,
  planarStep: new Array(el.length).fill(10),
  dt: new Array(el.length).fill(1),
  g,
});

test("gradeBound: clamps a physically-impossible ele spike toward the line", () => {
  const el = Array.from({ length: 11 }, (_, i) => i); // constant 10% grade (curvature 0 → in-bound)
  el[5] = 50; // a huge impossible spike
  const { ele } = compute(ctx(el, { GRADE_AMAX: 1.5 }));
  assert.ok(ele[5] < 15, `spike clamped from 50 → ${ele[5]}`); // pulled back toward ~5
  assert.ok(Math.abs(ele[1] - 1) < 1, `far neighbour preserved: ${ele[1]}`);
  assert.equal(ele[0], 0); // endpoints untouched
  assert.equal(ele[10], 10);
});

test("gradeBound: leaves in-bound real terrain (gentle curve) untouched — no over-flatten", () => {
  // ele = 0.5·i²: curvature = 2nd-diff/ds² = 1/100 = 0.01 < bound 0.015 (aMax 1.5 @ 10 m/s) → in-bound
  const el = Array.from({ length: 11 }, (_, i) => 0.5 * i * i);
  const { ele } = compute(ctx(el, { GRADE_AMAX: 1.5 }));
  for (let i = 0; i < el.length; i++)
    assert.ok(Math.abs(ele[i] - el[i]) < 1e-6, `i=${i} ${ele[i]} vs ${el[i]}`);
});

test("gradeBound: a steeper-than-bound curve is relaxed toward the chord (curvature reduced)", () => {
  const el = Array.from({ length: 11 }, (_, i) => 2 * i * i); // convex-up, curvature 0.04 > bound 0.015
  const chordMid = (el[0] + el[10]) / 2; // = 100; reducing convex curvature lifts the middle toward it
  const { ele } = compute(ctx(el, { GRADE_AMAX: 1.5 }));
  assert.ok(
    ele[5] > el[5] && ele[5] < chordMid,
    `relaxed toward chord (not flattened to it): ${ele[5]}`,
  );
});

test("gradeBound: fewer than 3 points returns ele unchanged", () => {
  assert.deepEqual(compute(ctx([10, 20])).ele, [10, 20]);
  assert.deepEqual(compute(ctx([])).ele, []);
});

test("gradeBound: GRADE_SMOOTH_WIN_M defaults to 0 (off) — no change from the despike-only result", () => {
  const el = Array.from({ length: 11 }, (_, i) => 0.5 * i * i);
  const despikeOnly = compute(ctx(el, { GRADE_AMAX: 1.5 })).ele;
  const noWin = compute(ctx(el, { GRADE_AMAX: 1.5, GRADE_SMOOTH_WIN_M: 0 })).ele;
  assert.deepEqual(noWin, despikeOnly);
});

test("gradeBound: a nonzero GRADE_SMOOTH_WIN_M smooths the POST-despike series, not the raw input", () => {
  // a spike for despike to fix, plus a noisy alternation the boxcar mean should flatten out —
  // 10 m steps at 1 s each (see ctx doc), so a ±30 m window spans ~6 points either side.
  const el = Array.from({ length: 21 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
  el[10] = 500; // impossible spike, well beyond anything a 30 m boxcar mean alone would erase
  const despikeOnly = compute(ctx(el, { GRADE_AMAX: 1.5 })).ele;
  const smoothed = compute(ctx(el, { GRADE_AMAX: 1.5, GRADE_SMOOTH_WIN_M: 30 })).ele;

  assert.ok(despikeOnly[10] < 200, `despike alone already clamps the spike: ${despikeOnly[10]}`);
  // the alternating ±1 noise should be averaged away by the boxcar mean, which the despike-only
  // pass (a targeted curvature clamp, not a general smoother) leaves in place
  const noiseRange = (arr) => Math.max(...arr.slice(2, 8)) - Math.min(...arr.slice(2, 8));
  assert.ok(noiseRange(smoothed) < noiseRange(despikeOnly), "smoothing pass flattens residual noise");
});
