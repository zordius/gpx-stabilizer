import assert from "node:assert/strict";
import { test } from "node:test";
import {
  recordingStartUtc,
  regressStartUtc,
  resolveStartUtc,
  timezoneAt,
  timezoneOfPoints,
} from "../src/telemetry.js";

const pt = (over = {}) => ({
  lat: 35.68,
  lon: 139.69,
  ele: 10,
  time: 1_700_000_000_000,
  speed: 1,
  fix: "3d",
  hdop: 1,
  ...over,
});

test("timezoneAt: maps a finite lat/lon to its IANA zone", () => {
  assert.equal(timezoneAt({ lat: 35.68, lon: 139.69 }), "Asia/Tokyo");
});

test("timezoneAt: returns null for non-finite or missing input", () => {
  assert.equal(timezoneAt({ lat: Number.NaN, lon: 139.69 }), null);
  assert.equal(timezoneAt({ lat: 35.68, lon: null }), null);
  assert.equal(timezoneAt({}), null);
  assert.equal(timezoneAt(), null);
});

test("timezoneOfPoints: uses the first 3D-fix point", () => {
  const points = [pt({ fix: "none", lat: 0, lon: 0 }), pt({ fix: "3d", lat: 35.68, lon: 139.69 })];
  assert.equal(timezoneOfPoints(points), "Asia/Tokyo");
});

test("timezoneOfPoints: falls back to a 2D fix when no 3D exists", () => {
  const points = [pt({ fix: "none", lat: 0, lon: 0 }), pt({ fix: "2d", lat: 35.68, lon: 139.69 })];
  assert.equal(timezoneOfPoints(points), "Asia/Tokyo");
});

test("timezoneOfPoints: prefers a 3D fix over an earlier 2D fix", () => {
  const points = [
    pt({ fix: "2d", lat: 51.5, lon: -0.12 }), // London, earlier
    pt({ fix: "3d", lat: 35.68, lon: 139.69 }), // Tokyo, later but 3D
  ];
  assert.equal(timezoneOfPoints(points), "Asia/Tokyo");
});

test("timezoneOfPoints: null when no good-fix point exists", () => {
  assert.equal(timezoneOfPoints([pt({ fix: "none" }), pt({ fix: null })]), null);
  assert.equal(timezoneOfPoints([]), null);
  assert.equal(timezoneOfPoints(undefined), null);
});

test("timezoneOfPoints: skips a fixed point with non-finite lat/lon", () => {
  const points = [
    pt({ fix: "3d", lat: Number.NaN, lon: Number.NaN }),
    pt({ fix: "3d", lat: 35.68, lon: 139.69 }),
  ];
  assert.equal(timezoneOfPoints(points), "Asia/Tokyo");
});

test("recordingStartUtc: returns the first good-fix sample's time and fix", () => {
  const points = [
    pt({ fix: "none", time: 1000 }),
    pt({ fix: "3d", time: 2000 }),
    pt({ fix: "3d", time: 3000 }),
  ];
  assert.deepEqual(recordingStartUtc(points), { startUtc: 2000, fix: "3d" });
});

test("recordingStartUtc: falls back to a 2D fix", () => {
  const points = [pt({ fix: "none", time: 1000 }), pt({ fix: "2d", time: 2000 })];
  assert.deepEqual(recordingStartUtc(points), { startUtc: 2000, fix: "2d" });
});

test("recordingStartUtc: null pair when there is no good-fix sample", () => {
  assert.deepEqual(recordingStartUtc([pt({ fix: "none" })]), {
    startUtc: null,
    fix: null,
  });
  assert.deepEqual(recordingStartUtc([]), { startUtc: null, fix: null });
  assert.deepEqual(recordingStartUtc(undefined), { startUtc: null, fix: null });
});

test("recordingStartUtc: startUtc null but fix reported when the good-fix sample lacks a time", () => {
  assert.deepEqual(recordingStartUtc([pt({ fix: "3d", time: null })]), {
    startUtc: null,
    fix: "3d",
  });
});

const BASE = 1_700_000_000_000;
// good fixes on a perfect line: time = BASE + cts (slope 1) → true start at cts 0 = BASE
const lineFixes = () => {
  const out = [];
  for (let c = 1000; c <= 10000; c += 1000) out.push(pt({ fix: "3d", time: BASE + c, cts: c }));
  return out;
};

test("regressStartUtc: extrapolates UTC~cts to cts=0 to recover the true start", () => {
  const reg = regressStartUtc(lineFixes());
  assert.equal(reg.startUtc, BASE);
  assert.ok(Math.abs(reg.slope - 1) < 1e-6);
  assert.equal(reg.n, 10);
});

test("regressStartUtc: null for too few points, too short a span, or missing cts", () => {
  assert.equal(regressStartUtc([pt({ cts: 1000 }), pt({ cts: 2000 })]), null); // <5 points
  const short = [];
  for (let c = 0; c < 6; c++) short.push(pt({ fix: "3d", time: BASE + c, cts: c })); // 5ms span
  assert.equal(regressStartUtc(short), null);
  assert.equal(regressStartUtc(lineFixes().map((p) => ({ ...p, cts: null }))), null); // no cts
});

test("regressStartUtc: trusts a time~cts fit even with fix:'none' (chip synced UTC before a real fix)", () => {
  const unlocked = lineFixes().map((p) => ({ ...p, fix: "none" }));
  const reg = regressStartUtc(unlocked);
  assert.equal(reg.startUtc, BASE);
  assert.ok(Math.abs(reg.slope - 1) < 1e-6);
  assert.equal(reg.n, 10);
});

test("regressStartUtc: still drops the null-island sentinel regardless of fix", () => {
  const withSentinels = [
    ...lineFixes().map((p) => ({ ...p, fix: "none", lat: 0, lon: 0, time: 0 })), // pre-sync junk
    ...lineFixes().map((p) => ({ ...p, fix: "none" })),
  ];
  const reg = regressStartUtc(withSentinels);
  assert.equal(reg.startUtc, BASE);
  assert.equal(reg.n, 10); // the (0,0) sentinels never entered the fit
});

test("regressStartUtc: robust fit drops a contaminated PRE-SYNC PREFIX, position never resolved at all", () => {
  // mirrors a real HERO10 clip: every single sample stuck at (0,0)/fix:'none' the
  // whole way through — position never resolves — but a contiguous prefix carries
  // a firmware boot-time constant (unrelated to cts) ahead of a clean slope-1 run
  // once the chip's UTC sync kicks in. A position-based filter (the previous
  // approach) would discard ALL of these points, missing the valid clock entirely.
  const junk = [];
  for (let c = 0; c < 1500; c += 100) {
    junk.push(pt({ fix: "none", lat: 0, lon: 0, time: 1_615_075_203_300 + c * 2.67, cts: c }));
  }
  const synced = [];
  for (let c = 1500; c <= 10_000; c += 100) {
    synced.push(pt({ fix: "none", lat: 0, lon: 0, time: BASE + c, cts: c }));
  }
  const reg = regressStartUtc([...junk, ...synced]);
  assert.equal(reg.startUtc, BASE);
  assert.ok(Math.abs(reg.slope - 1) < 1e-6);
  assert.equal(reg.n, synced.length); // every junk sample excluded, every synced sample kept
});

test("regressStartUtc: WITHOUT a referenceUtc, a MAJORITY junk cluster can win — its own slope is also ≈1", () => {
  // the junk isn't always scattered noise or a small prefix: mirrors a real clip
  // where 80% of samples are an internally-consistent-but-WRONG cluster (a
  // free-running clock ticking at ~1x, just never corrected to true UTC) and only
  // 20% are the real, correct cluster. Theil-Sen's median has no way to prefer the
  // correct cluster over the bigger one without an outside anchor — this documents
  // that limitation rather than asserting a specific (wrong) answer.
  const WRONG_BASE = 1_615_075_203_300; // the same firmware constant seen on real HERO10 clips
  const majorityWrong = [];
  for (let c = 0; c < 8000; c += 100) majorityWrong.push(pt({ fix: "none", time: WRONG_BASE + c, cts: c }));
  const minorityRight = [];
  for (let c = 8000; c <= 10_000; c += 100) minorityRight.push(pt({ fix: "none", time: BASE + c, cts: c }));
  const reg = regressStartUtc([...majorityWrong, ...minorityRight]);
  assert.ok(reg); // a fit is found — just not necessarily the right one, which is the point
  assert.ok(Math.abs(reg.slope - 1) < 1e-3); // both clusters are independently slope-≈1
  assert.notEqual(reg.startUtc, BASE); // the majority (wrong) cluster wins the tie unresolved
});

test("regressStartUtc: referenceUtc breaks the majority/minority tie in favor of the plausible cluster", () => {
  const WRONG_BASE = 1_615_075_203_300;
  const majorityWrong = [];
  for (let c = 0; c < 7000; c += 50) majorityWrong.push(pt({ fix: "none", time: WRONG_BASE + c, cts: c }));
  const minorityRight = [];
  for (let c = 7000; c <= 14_000; c += 200) minorityRight.push(pt({ fix: "none", time: BASE + c, cts: c }));
  assert.ok(majorityWrong.length > minorityRight.length); // still the smaller cluster by count
  // WRONG_BASE is a multi-year outlier relative to this reference, well outside the
  // ±30-day window, regardless of which cluster has more points.
  const reg = regressStartUtc([...majorityWrong, ...minorityRight], { referenceUtc: BASE + 5000 });
  assert.equal(reg.startUtc, BASE);
  assert.equal(reg.n, minorityRight.length);
});

test("regressStartUtc: a genuinely random/inconsistent time~cts relationship still fails to verify", () => {
  // sanity check that dropping the fix/position gates didn't also drop the actual
  // safety net: unrelated time values (no real cts correlation at all) must not
  // spuriously pass as a robust fit.
  const noisy = lineFixes().map((p, i) => ({ ...p, fix: "none", time: BASE + (i % 2 === 0 ? 1 : -1) * 50_000 }));
  const reg = regressStartUtc(noisy);
  if (reg) assert.ok(Math.abs(reg.slope - 1) > 0.05);
});

test("resolveStartUtc: verified true-start when slope ≈ 1, else first-fix fallback", () => {
  assert.deepEqual(resolveStartUtc(lineFixes()), {
    startUtc: BASE,
    confidence: "gps",
    verified: true,
    slope: 1,
  });
  const bad = lineFixes().map((p) => ({ ...p, time: BASE + (p.cts * 3) / 2 })); // slope 1.5
  const rb = resolveStartUtc(bad);
  assert.equal(rb.verified, false);
  assert.equal(rb.startUtc, BASE + 1500); // first good fix (cts 1000)
  assert.equal(rb.confidence, "gps");
});
