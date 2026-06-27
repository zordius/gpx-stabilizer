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
