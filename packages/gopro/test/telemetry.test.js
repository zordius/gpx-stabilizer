import assert from "node:assert/strict";
import { test } from "node:test";
import { recordingStartUtc, timezoneAt, timezoneOfPoints } from "../src/telemetry.js";

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
