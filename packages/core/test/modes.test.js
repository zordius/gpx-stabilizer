import assert from "node:assert/strict";
import { test } from "node:test";
import { measure } from "../src/measure.js";
import { MODES } from "../src/modes.js";
import { profile } from "../src/profile.js";

test("modes: core is the empty default; ski enables despike-ski profile + carve + kink", () => {
  assert.deepEqual(MODES.core, { params: {}, enable: [] });
  assert.equal(MODES.ski.params.DESPIKE_PROFILE, "ski");
  assert.equal(MODES.ski.params.CARVE, true);
  assert.ok(MODES.ski.enable.includes("kink"));
});

test("profile: carve is gated on g.CARVE (off → zeros, on → computed)", () => {
  const step = 5 / (Math.cos((36 * Math.PI) / 180) * 111320); // ~5 m/s east
  const track = Array.from({ length: 80 }, (_, i) => ({
    lat: 36 + 0.0005 * Math.sin(i / 3), // lateral S-weave → carve crossings
    lon: 138 + i * step,
    ele: 1000,
    time: i * 1000,
  }));
  const m = measure(
    track,
    track.map((_, i) => i),
  );
  const off = profile(m, {}).carve; // g.CARVE undefined → gated off
  const on = profile(m, { CARVE: true }).carve;
  assert.ok(
    off.every((v) => v === 0),
    "carve off → all zeros",
  );
  assert.ok(
    on.some((v) => v > 0),
    "carve on → S-weave yields nonzero carve",
  );
});
