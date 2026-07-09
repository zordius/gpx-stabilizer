import assert from "node:assert/strict";
import { test } from "node:test";
import { finalize } from "../src/mods/noise.js";

// noise only reads x/y/time/ele/hdop/dropReason off assembled points — unit-test its own logic
// directly with hand-built points (same style as liftBoardingEle's own tests), not the full pipeline.
function pt(over) {
  return { x: 0, y: 0, time: 0, ele: 900, ...over };
}

// A straight line at constant speed and constant climb rate: every forward heading and every forward
// slope is identical, so both cumulative-diff sums should read (near) zero.
function straightTrack(n = 12) {
  return Array.from({ length: n }, (_, i) => pt({ x: i * 5, y: 0, time: i * 1000, ele: 900 + i }));
}

test("noise: a straight, constant-climb track scores ~0 on both turnSum and slopeSum", () => {
  const out = straightTrack();
  finalize(out, { g: {} });
  const scored = out.filter((p) => p.noise);
  assert.ok(scored.length > 0, "expected at least one point to get a noise score");
  for (const p of scored) {
    assert.ok(p.noise.turnSum < 1e-6, `expected ~0 turnSum, got ${p.noise.turnSum}`);
    assert.ok(p.noise.slopeSum < 1e-6, `expected ~0 slopeSum, got ${p.noise.slopeSum}`);
  }
});

test("noise: a zigzagging, oscillating-climb track scores high on both turnSum and slopeSum", () => {
  const out = Array.from({ length: 12 }, (_, i) =>
    pt({
      x: i % 2 === 0 ? 0 : 5, // alternates left/right -> sharp heading reversals every step
      y: i * 5,
      time: i * 1000,
      ele: 900 + (i % 2 === 0 ? i : -i), // alternates climbing/dropping -> slope reversals every step
    }),
  );
  finalize(out, { g: {} });
  const mid = out[6]; // an interior point, comfortably clear of the edge cutoff
  assert.ok(mid.noise, "expected an interior point to get a noise score");
  assert.ok(mid.noise.turnSum > 100, `expected a large turnSum, got ${mid.noise.turnSum}`);
  assert.ok(mid.noise.slopeSum > 1, `expected a large slopeSum, got ${mid.noise.slopeSum}`);
});

test("noise: hdopMax is the window's own worst hdop", () => {
  const out = straightTrack(40); // long enough that a far point's +/-10s window excludes the spike
  out[6].hdop = 7.5; // one spike, well inside point 5's window, well outside point 30's
  finalize(out, { g: {} });
  assert.equal(out[5].noise.hdopMax, 7.5);
  assert.equal(out[30].noise.hdopMax, 0); // spike is 24s away, outside this point's own +/-10s window
});

test("noise: too few points in a window (near track edges/short tracks) get no score", () => {
  const out = straightTrack(3); // only 3 points total -> every window has < 4 points
  finalize(out, { g: {} });
  assert.ok(out.every((p) => p.noise === undefined));
});

test("noise: a dropped point is excluded from both scoring and its neighbours' windows", () => {
  const out = straightTrack();
  out[6].dropReason = { outlier: {} };
  finalize(out, { g: {} });
  assert.equal(out[6].noise, undefined);
  assert.ok(out[5].noise); // neighbours still score, just without the dropped point in their window
});

test("noise: opts.g.NOISE_WIN_S overrides the default +/-10s window", () => {
  const out = straightTrack(20);
  finalize(out, { g: { NOISE_WIN_S: 2 } });
  // a much narrower window still finds a straight track has ~0 wander
  const mid = out[10];
  assert.ok(mid.noise);
  assert.ok(mid.noise.turnSum < 1e-6);
});
