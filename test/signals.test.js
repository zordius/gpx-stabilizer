import assert from "node:assert/strict";
import { test } from "node:test";
import { signals } from "../src/signals.js";

// Local-meters-per-degree at the test latitude, matching signals.js's projection, so we can pick
// lon/lat steps that yield a known speed in m/s.
const LAT = 36;
const MX = Math.cos((LAT * Math.PI) / 180) * 111320;

/** Build a 1 Hz track. dlon/dlat advance per sample; dele is m/s of elevation change. */
function track({ n, lon = 138, lat = LAT, dlon = 0, dlat = 0, ele = 1000, dele = 0 }) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    pts.push({ lat: lat + i * dlat, lon: lon + i * dlon, ele: ele + i * dele, time: i * 1000 });
  }
  return pts;
}

const STEP5 = 5 / MX; // ~5 m/s eastward in degrees of longitude

test("returns one enriched point per input, original fields kept", () => {
  const out = signals(track({ n: 5, dlon: STEP5 }));
  assert.equal(out.length, 5);
  for (const p of out) {
    assert.equal(typeof p.lat, "number");
    assert.equal(typeof p.time, "number");
    for (const k of ["x", "y", "hs", "vs", "straight", "steady", "netsp", "wander", "carve"]) {
      assert.equal(typeof p[k], "number", `${k} is a number`);
    }
    assert.equal(typeof p.outlier, "boolean");
    assert.equal(typeof p.paused, "boolean");
  }
});

test("empty input yields an empty array", () => {
  assert.deepEqual(signals([]), []);
});

test("projection is local: file centre near origin, east +x, north +y", () => {
  const out = signals(track({ n: 121, dlon: STEP5 }));
  const mid = out[60];
  assert.ok(Math.abs(mid.x) < 1 && Math.abs(mid.y) < 1, "centre maps near (0,0)");
  assert.ok(out[120].x > out[0].x, "later (more east) is +x");
  const north = signals(track({ n: 3, dlat: 1e-4 }));
  assert.ok(north[2].y > north[0].y, "more north is +y");
});

test("horizontal speed recovers the true ~5 m/s in the interior", () => {
  const out = signals(track({ n: 121, dlon: STEP5 }));
  assert.ok(Math.abs(out[60].hs - 5) < 0.1, `hs=${out[60].hs}`);
  assert.ok(Math.abs(out[60].netsp - 5) < 0.2, `netsp=${out[60].netsp}`);
});

test("a straight run is straight, low-wander, no carve", () => {
  const out = signals(track({ n: 121, dlon: STEP5 }));
  assert.ok(out[60].straight > 0.99, `straight=${out[60].straight}`);
  assert.ok(out[60].wander < 0.05, `wander=${out[60].wander}`);
  assert.equal(out[60].carve, 0);
});

test("vertical speed signs with climb and descent", () => {
  const up = signals(track({ n: 121, dlon: STEP5, dele: 1 }));
  const down = signals(track({ n: 121, dlon: STEP5, dele: -1 }));
  assert.ok(up[60].vs > 0.5, `climb vs=${up[60].vs}`);
  assert.ok(down[60].vs < -0.5, `descent vs=${down[60].vs}`);
});

test("a stationary cluster is paused; a moving track is not", () => {
  const still = signals(track({ n: 131, dlon: 0 }));
  assert.equal(still[65].paused, true);
  const moving = signals(track({ n: 121, dlon: STEP5 }));
  assert.equal(moving[60].paused, false);
});

test("a perpendicular spike is flagged outlier with high jitter", () => {
  const pts = track({ n: 121, dlon: STEP5 });
  pts[60] = { ...pts[60], lat: pts[60].lat + 50 / 110540 }; // jump ~50 m north then back
  const out = signals(pts);
  assert.equal(out[60].outlier, true);
  assert.ok(out[60].maDist > 10, `maDist=${out[60].maDist}`);
});

test("missing elevations are interpolated, never NaN", () => {
  const pts = track({ n: 30, dlon: STEP5, dele: 1 });
  pts[10].ele = null;
  pts[11].ele = null;
  const out = signals(pts);
  for (const p of out) {
    assert.ok(Number.isFinite(p.vs) && Number.isFinite(p.maDist));
  }
});

test("a point with no time is gpsStatus error, not computed, others still compute", () => {
  const pts = track({ n: 5, dlon: STEP5 });
  pts[2] = { ...pts[2], time: null };
  const out = signals(pts);
  assert.equal(out[2].gpsStatus, "error");
  assert.equal(out[2].hs, undefined); // no time-based signal computed
  assert.ok(typeof out[2].x === "number"); // still projected
  assert.equal(out[0].gpsStatus, "ok");
  assert.equal(typeof out[0].hs, "number"); // valid points still computed
});

test("error/dupe points do not shift the projection centre", () => {
  const pts = track({ n: 121, dlon: STEP5 });
  pts.push({ lat: 80, lon: 200, ele: 0, time: null }); // wild, untimed → must be ignored by the mean
  const out = signals(pts);
  assert.equal(out[121].gpsStatus, "error");
  assert.ok(
    Math.abs(out[60].x) < 1 && Math.abs(out[60].y) < 1,
    "centre unaffected by the error point",
  );
});

test("same time + same position is dupe; same time + moved is error", () => {
  const pts = track({ n: 5, dlon: STEP5 });
  const dupe = { ...pts[2] }; //                       same time & position as pts[2]
  const moved = { ...pts[2], lat: pts[2].lat + 1e-4 }; // same time, different position
  const a = signals([pts[0], pts[1], pts[2], dupe, pts[3], pts[4]]);
  assert.equal(a[3].gpsStatus, "dupe");
  assert.equal(a[3].hs, undefined); // excluded from the time series
  const b = signals([pts[0], pts[1], pts[2], moved, pts[3], pts[4]]);
  assert.equal(b[3].gpsStatus, "error");
});

test("a sub-second gap from the last kept point is oversample and excluded", () => {
  const out = signals([
    { lat: 36, lon: 138, ele: 1000, time: 0 },
    { lat: 36, lon: 138 + STEP5, ele: 1000, time: 500 }, // 0.5 s after the kept point
    { lat: 36, lon: 138 + 2 * STEP5, ele: 1000, time: 1500 }, // 1.5 s after the kept point
  ]);
  assert.equal(out[0].gpsStatus, "ok");
  assert.equal(out[1].gpsStatus, "oversample");
  assert.equal(out[2].gpsStatus, "ok");
  assert.equal(out[1].hs, undefined); // excluded from the time series
  assert.equal(typeof out[1].x, "number"); // still projected
});

test("dense samples are resampled to ~1 ok point per second against the last kept point", () => {
  const pts = [];
  for (let i = 0; i <= 20; i++) {
    pts.push({ lat: 36, lon: 138 + i * STEP5 * 0.1, ele: 1000, time: i * 100 }); // 10 Hz
  }
  const out = signals(pts);
  const kept = out.filter((p) => p.gpsStatus === "ok");
  assert.equal(kept.length, 3); // kept at t = 0, 1000, 2000 ms
  assert.equal(out[0].gpsStatus, "ok");
  assert.equal(out[5].gpsStatus, "oversample");
  assert.equal(out[10].gpsStatus, "ok");
});

test("an oversample point is excluded from the projection centre", () => {
  const pts = track({ n: 121, dlon: STEP5 });
  pts.splice(61, 0, { lat: 80, lon: 200, ele: 0, time: 60500 }); // wild, 0.5 s after a kept point
  const out = signals(pts);
  assert.equal(out[61].gpsStatus, "oversample");
  assert.ok(Math.abs(out[60].x) < 1, "centre unaffected by the oversample point");
});

test("an oversample point does not advance the resample reference", () => {
  const out = signals([
    { lat: 36, lon: 138, ele: 1000, time: 0 }, //              ok → q = 0
    { lat: 36, lon: 138 + STEP5, ele: 1000, time: 600 }, //    0.6 s → oversample, q stays 0
    { lat: 36, lon: 138 + 2 * STEP5, ele: 1000, time: 1200 }, // 1.2 s after q=0 → ok
  ]);
  assert.equal(out[1].gpsStatus, "oversample");
  assert.equal(out[2].gpsStatus, "ok"); // measured from t0, not t600 — q never advanced
});

test("dupe and error points do not advance the resample reference", () => {
  const out = signals([
    { lat: 36, lon: 138, ele: 1000, time: 0 }, //               ok → q = 0
    { lat: 36, lon: 138, ele: 1000, time: 0 }, //               dupe (same time+pos), q stays 0
    { lat: 36, lon: 138 + STEP5, ele: 1000, time: 0 }, //       error (same time, moved), q stays 0
    { lat: 36, lon: 138 + 2 * STEP5, ele: 1000, time: 1200 }, // 1.2 s after q=0 → ok
  ]);
  assert.equal(out[1].gpsStatus, "dupe");
  assert.equal(out[2].gpsStatus, "error");
  assert.equal(out[3].gpsStatus, "ok"); // q held at t0 through the dupe + error
});

test("a leading point with no time is error; the first timed point is ok", () => {
  const out = signals([
    { lat: 36, lon: 138, ele: 1000, time: null }, //          no time → error
    { lat: 36, lon: 138 + STEP5, ele: 1000, time: 1000 }, //  first timed point → ok
    { lat: 36, lon: 138 + 2 * STEP5, ele: 1000, time: 2000 },
  ]);
  assert.equal(out[0].gpsStatus, "error");
  assert.equal(out[1].gpsStatus, "ok");
  assert.equal(out[2].gpsStatus, "ok");
});

test("with no timed points the centre falls back to all points", () => {
  const out = signals([
    { lat: 36, lon: 138, ele: 1000, time: null },
    { lat: 37, lon: 139, ele: 1000, time: null },
  ]);
  assert.equal(out[0].gpsStatus, "error");
  assert.equal(out[1].gpsStatus, "error");
  assert.ok(Number.isFinite(out[0].x) && Number.isFinite(out[1].x)); // still projected
  assert.ok(out[0].x < 0 && out[1].x > 0, "centred between the two points");
});

test("netd150 is the net displacement over the long window", () => {
  const out = signals(track({ n: 301, dlon: STEP5 })); // ~5 m/s for 5 minutes
  assert.ok(Math.abs(out[150].netd150 - 1500) < 5, `netd150=${out[150].netd150}`); // 5 m/s x 300 s
});

test("steady is near zero for a constant-speed run", () => {
  const out = signals(track({ n: 301, dlon: STEP5 }));
  assert.ok(out[150].steady < 0.05, `steady=${out[150].steady}`);
});
