import assert from "node:assert/strict";
import { test } from "node:test";
import { finalize } from "../src/mods/tangleSnap.js";

const DEG_LAT_M = 110540;
const DEG_LON_M = 111320;
const ctx = { lat0: 0, lon0: 0 }; // lat0=0 -> mx = DEG_LON_M, keeps the expected math simple

function pt(over) {
  return { lat: 0, lon: 0, ...over };
}

// x/y (meters, ctx above) -> the lat/lon a raw point at that position would carry
function toLatLon(x, y) {
  return { lat: y / DEG_LAT_M, lon: x / DEG_LON_M };
}

test("tangleSnap: a straight, very-slow run stays on the same line after thin+reinflate", () => {
  // 60 points, 0.1m apart, 1s apart -> 0.1 m/s, well under the 0.6 m/s threshold
  const out = Array.from({ length: 60 }, (_, i) => {
    const { lat, lon } = toLatLon(i * 0.1, 0);
    return pt({ x: i * 0.1, y: 0, lat, lon, time: i * 1000 });
  });
  finalize(out, ctx);
  assert.equal(out[0].tangleSnap, undefined); // the run's own first point is never rewritten
  for (const p of out.slice(1)) {
    assert.ok(p.tangleSnap, "every later point in a thinned straight run gets a signal");
    assert.ok(Math.abs(p.tangleSnap.lat - 0) < 1e-9);
  }
  // reinflated x-positions stay monotonically increasing and close to the original spacing
  const xs = out.slice(1).map((p) => p.tangleSnap.lon * DEG_LON_M);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1]);
  assert.ok(Math.abs(xs.at(-1) - 5.9) < 0.05);
});

test("tangleSnap: reconstructs a real curve's curvature, not a straight chord, for interior anchors", () => {
  // half circle, radius 3m, centered at origin, walked in 0.05m steps (slow) -> ~94 points
  const R = 3;
  const totalAngle = Math.PI; // 180 degrees
  const stepArc = 0.05;
  const n = Math.round((R * totalAngle) / stepArc);
  const out = Array.from({ length: n + 1 }, (_, i) => {
    const theta = (i / n) * totalAngle;
    const x = R * Math.cos(theta);
    const y = R * Math.sin(theta);
    const { lat, lon } = toLatLon(x, y);
    return pt({ x, y, lat, lon, time: i * 1000 });
  });
  finalize(out, { ...ctx, g: { TANGLE_MIN_SPACING_M: 1 } });
  const withSignal = out.filter((p) => p.tangleSnap);
  assert.ok(withSignal.length > 10, "the run was thinned and reinflated");
  // interior points (skip the first/last ~15%, where a boundary anchor's forced kappa=0 biases the
  // curvature estimate low) should sit almost exactly back on the true circle of radius R
  const lo = Math.floor(withSignal.length * 0.2);
  const hi = Math.ceil(withSignal.length * 0.8);
  for (const p of withSignal.slice(lo, hi)) {
    const x = p.tangleSnap.lon * DEG_LON_M;
    const y = p.tangleSnap.lat * DEG_LAT_M;
    const r = Math.hypot(x, y);
    assert.ok(Math.abs(r - R) < 0.02, `expected radius ~${R}, got ${r}`);
  }
});

test("tangleSnap: points moving faster than the threshold are left untouched", () => {
  const out = Array.from({ length: 30 }, (_, i) => {
    const { lat, lon } = toLatLon(i * 5, 0); // 5m/s at 1Hz -> well above 0.6 m/s
    return pt({ x: i * 5, y: 0, lat, lon, time: i * 1000 });
  });
  finalize(out, ctx);
  assert.ok(out.every((p) => p.tangleSnap === undefined));
});

test("tangleSnap: prefers point.liftSnap's position over raw x/y when present", () => {
  // raw x/y traces a wandering path; liftSnap already corrected every point onto y=5 exactly.
  // If the module reads liftSnap first, the reconstructed run should stay flat at lat=5/DEG_LAT_M.
  const out = Array.from({ length: 60 }, (_, i) => {
    const rawY = i % 2 === 0 ? 4 : 6; // noisy raw position
    const { lat, lon } = toLatLon(i * 0.1, rawY);
    const corrected = toLatLon(i * 0.1, 5);
    return pt({ x: i * 0.1, y: rawY, lat, lon, liftSnap: corrected, time: i * 1000 });
  });
  finalize(out, ctx);
  for (const p of out.slice(1)) {
    assert.ok(p.tangleSnap, "still processed as a slow run");
    assert.ok(Math.abs(p.tangleSnap.lat * DEG_LAT_M - 5) < 0.05);
  }
});

test("tangleSnap: g.TANGLE_MAX_SPEED / g.TANGLE_MIN_SPACING_M override the defaults", () => {
  // 1.0 m/s -> NOT slow by default (0.6), but IS slow once the threshold is raised to 1.5
  const points = () =>
    Array.from({ length: 30 }, (_, i) => {
      const { lat, lon } = toLatLon(i * 1.0, 0);
      return pt({ x: i * 1.0, y: 0, lat, lon, time: i * 1000 });
    });
  const untouched = points();
  finalize(untouched, ctx);
  assert.ok(untouched.every((p) => p.tangleSnap === undefined));

  const touched = points();
  finalize(touched, { ...ctx, g: { TANGLE_MAX_SPEED: 1.5, TANGLE_MIN_SPACING_M: 2 } });
  assert.ok(touched.some((p) => p.tangleSnap));
});

test("tangleSnap: fewer than 3 kept points -> no-op, no crash", () => {
  const out = [pt({ x: 0, y: 0, time: 0 }), pt({ x: 0.1, y: 0, time: 1000 })];
  finalize(out, ctx);
  assert.ok(out.every((p) => p.tangleSnap === undefined));
});

test("tangleSnap: dropped points and points without time are excluded, no crash", () => {
  const out = [
    pt({ x: 0, y: 0, time: 0 }),
    pt({ x: 0.05, y: 0, time: 1000, dropReason: { stray: true } }),
    pt({ x: 0.1, y: 0, time: null }),
    pt({ x: 0.15, y: 0, time: 2000 }),
    pt({ x: 0.2, y: 0, time: 3000 }),
  ];
  assert.doesNotThrow(() => finalize(out, ctx));
});
