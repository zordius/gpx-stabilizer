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

test("modes: ski also enables segment + liftConfirm + liftSnap, and turns on the liftSnap export", () => {
  assert.equal(MODES.ski.params.liftSnap, true);
  // segment must load before liftConfirm/liftSnap — they read point.segment/point.liftConfirm
  const enable = MODES.ski.enable;
  assert.ok(enable.indexOf("segment") < enable.indexOf("liftConfirm"));
  assert.ok(enable.indexOf("liftConfirm") < enable.indexOf("liftSnap"));
});

test("modes: ski also enables tangleSnap, loaded after liftSnap, and turns on its export", () => {
  assert.equal(MODES.ski.params.tangleSnap, true);
  const enable = MODES.ski.enable;
  assert.ok(enable.includes("tangleSnap"));
  assert.ok(enable.indexOf("liftSnap") < enable.indexOf("tangleSnap"));
});

test("modes: ski turns on gradeBound (elevation despike) by default", () => {
  assert.equal(MODES.ski.params.gradeBound, true);
});

test("modes: ski also enables liftBoardingEle, loaded after liftConfirm, and turns on its export", () => {
  assert.equal(MODES.ski.params.liftBoardingEle, true);
  const enable = MODES.ski.enable;
  assert.ok(enable.includes("liftBoardingEle"));
  assert.ok(enable.indexOf("liftConfirm") < enable.indexOf("liftBoardingEle"));
});

test("modes: ski turns on gradeBound's own post-despike smoothing pass via GRADE_SMOOTH_WIN_M", () => {
  assert.equal(MODES.ski.params.GRADE_SMOOTH_WIN_M, 30);
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
