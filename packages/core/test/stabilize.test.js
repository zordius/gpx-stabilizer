import assert from "node:assert/strict";
import { test } from "node:test";
import { stabilize, stabilizeTrack } from "../src/stabilize.js";

const MX = Math.cos((36 * Math.PI) / 180) * 111320;
const STEP5 = 5 / MX; // ~5 m/s eastward in degrees of longitude

test("stabilize: drops flagged points and reduces survivors to plain track points", () => {
  const pts = [
    { lat: 36, lon: 138, ele: 1000, time: 0 }, //                   kept
    { lat: 36, lon: 138, ele: 1000, time: 200 }, //                 raw < 0.5 s burst -> dropped
    { lat: 36, lon: 138 + STEP5, ele: 1000, time: 1000 }, //        kept
    { lat: 36, lon: 138 + 2 * STEP5, ele: 1000, time: 2000 }, //    kept
  ];
  const clean = stabilize(pts);
  assert.ok(clean.length < pts.length); // the dense (< 0.5 s) sample is gone
  for (const p of clean) {
    // reduced to plain track points — no analysis signals carried through
    assert.deepEqual(Object.keys(p).sort(), ["ele", "lat", "lon", "time"]);
  }
});

test("stabilize: opts.liftSnap swaps lat/lon when point.liftSnap is present, else raw", () => {
  // a stand-in finalize module, not the real liftSnap.js — liftConfirm/liftSnap's OWN correctness
  // is covered by their dedicated test files; this only tests stabilize's own export branching.
  const fakeLiftSnap = {
    name: "fakeLiftSnap",
    finalize: (out) => {
      out[0].liftSnap = { lat: 99, lon: 88 };
    },
  };
  const pts = [
    { lat: 36, lon: 138, ele: 1000, time: 0 },
    { lat: 36, lon: 138 + STEP5, ele: 1000, time: 1000 },
  ];
  const withFlag = stabilize(pts, { modules: [fakeLiftSnap], liftSnap: true });
  assert.equal(withFlag[0].lat, 99);
  assert.equal(withFlag[0].lon, 88);
  assert.equal(withFlag[1].lat, 36); // untouched point stays raw

  const withoutFlag = stabilize(pts, { modules: [fakeLiftSnap] }); // module ran, export flag off
  assert.equal(withoutFlag[0].lat, 36); // stays raw even though point.liftSnap was computed
});

test("stabilize: opts.liftSnap's ele wins over gradeBound/smooth when present, else falls through", () => {
  const fakeLiftSnap = {
    name: "fakeLiftSnap",
    finalize: (out) => {
      out[0].liftSnap = { lat: out[0].lat, lon: out[0].lon, ele: 500 };
    },
  };
  const pts = [
    { lat: 36, lon: 138, ele: 1000, time: 0 },
    { lat: 36, lon: 138 + STEP5, ele: 1000, time: 1000 },
    { lat: 36, lon: 138 + 2 * STEP5, ele: 1000, time: 2000 },
  ];
  const out = stabilize(pts, { modules: [fakeLiftSnap], liftSnap: true, smooth: true });
  assert.equal(out[0].ele, 500); // liftSnap wins over smooth
  assert.notEqual(out[1].ele, 500); // no liftSnap.ele here -> falls through to smooth's value
});

test("stabilize: opts.tangleSnap swaps lat/lon ahead of liftSnap when point.tangleSnap is present", () => {
  const fakeSnaps = {
    name: "fakeSnaps",
    finalize: (out) => {
      out[0].liftSnap = { lat: 99, lon: 88 };
      out[0].tangleSnap = { lat: 11, lon: 22 };
    },
  };
  const pts = [
    { lat: 36, lon: 138, ele: 1000, time: 0 },
    { lat: 36, lon: 138 + STEP5, ele: 1000, time: 1000 },
  ];
  const withBoth = stabilize(pts, { modules: [fakeSnaps], liftSnap: true, tangleSnap: true });
  assert.equal(withBoth[0].lat, 11); // tangleSnap wins over liftSnap
  assert.equal(withBoth[0].lon, 22);

  const liftOnly = stabilize(pts, { modules: [fakeSnaps], liftSnap: true });
  assert.equal(liftOnly[0].lat, 99); // tangleSnap flag off -> falls through to liftSnap

  const neither = stabilize(pts, { modules: [fakeSnaps] });
  assert.equal(neither[0].lat, 36); // both flags off -> stays raw
});

test("stabilizeTrack: stabilizes each segment and preserves meta", () => {
  const track = {
    segments: [
      [
        { lat: 36, lon: 138, ele: 1000, time: 0 },
        { lat: 36, lon: 138, ele: 1000, time: 0 }, // duplicate -> re-timed to 0.5 s, kept
        { lat: 36, lon: 138 + STEP5, ele: 1000, time: 1000 },
      ],
    ],
    meta: { name: "demo" },
  };
  const out = stabilizeTrack(track);
  assert.equal(out.meta.name, "demo"); // metadata preserved
  assert.equal(out.segments.length, 1);
  assert.equal(out.segments[0].length, 3); // duplicate re-timed and kept (0, 0.5, 1 s)
});
