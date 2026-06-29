import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze } from "../src/analyze.js";
import { ACTIVITIES, CORE_DEFAULT, compute } from "../src/mods/activity.js";

// Two per-point points carrying the features under test (measure bundles are padded to length n).
function ctxFor({ alt = 1000, hspeed = 0, vspeed = 0, accel = 0 }, g = {}) {
  const dup = (v) => [v, v];
  return {
    el: [alt, alt],
    n: 2,
    vz: dup(vspeed), // the separate vertical axis (B decomposition) — feeds the vspeed envelope
    velocity: {
      vec: { x: dup(hspeed), y: dup(0) }, // planar
      dir: { x: dup(1), y: dup(0) },
      mag: dup(hspeed), // horizontal speed
    },
    acceleration: {
      vec: { x: dup(accel), y: dup(0) },
      dir: { x: dup(1), y: dup(0) },
      mag: dup(accel),
    },
    g,
  };
}

test("activity registry: core defaults are everyday land travel + flight; specials are opt-in", () => {
  assert.deepEqual(CORE_DEFAULT, [
    "walking",
    "running",
    "cycling",
    "driving",
    "rail",
    "skiing",
    "flight",
  ]);
  assert.ok(ACTIVITIES.skydive && !CORE_DEFAULT.includes("skydive")); // defined but not default
});

test("activity: a skiing-speed point matches skiing and is not dropped", () => {
  const { modes, drop } = compute(ctxFor({ hspeed: 20, vspeed: -5, accel: 2 }));
  assert.ok(modes[0].includes("skiing"));
  assert.equal(drop[0], null);
});

test("activity: an implausible point (too fast + huge accel) matches nothing -> drop", () => {
  const { modes, drop } = compute(ctxFor({ hspeed: 120, accel: 80 }));
  assert.equal(modes[0], null);
  assert.equal(drop[0].hspeed, 120); // records the offending features
});

test("activity: flight needs the coupled box; skydive must be opted in", () => {
  // 80 m/s + low accel + low turn -> flight (in core)
  assert.ok(compute(ctxFor({ hspeed: 80, accel: 2 })).modes[0].includes("flight"));
  // freefall: high downward vspeed + big accel — core can't explain it, skydive can
  const fall = { alt: 3000, hspeed: 2, vspeed: -60, accel: 40 };
  assert.equal(compute(ctxFor(fall)).modes[0], null);
  assert.ok(
    compute(ctxFor(fall, { activities: [...CORE_DEFAULT, "skydive"] })).modes[0].includes(
      "skydive",
    ),
  );
});

test("activity: uses device <speed> for hspeed when present (overrides position-derived)", () => {
  // computed horizontal velocity is ~0 (stationary geometry), but the device says 80 m/s
  const ctx = ctxFor({ hspeed: 0, accel: 2 });
  ctx.speed = [80, 80]; // device <speed> per valid point
  const { modes } = compute(ctx);
  assert.ok(modes[0].includes("flight")); // classified by the device speed (80 m/s), not the 0
});

test("activity: integrates as a core builtin — a clean ski-speed track keeps every point", () => {
  const mx = Math.cos((36 * Math.PI) / 180) * 111320;
  const step = 15 / mx; // ~15 m/s eastward
  const pts = Array.from({ length: 20 }, (_, i) => ({
    lat: 36,
    lon: 138 + i * step,
    ele: 1500,
    time: i * 1000,
  }));
  const out = analyze(pts);
  for (const p of out) assert.equal(p.dropReason, undefined); // all explained (skiing/driving/…)
  assert.ok(out[10].activity.modes.length > 0); // and positively labelled
});
