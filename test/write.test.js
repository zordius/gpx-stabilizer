import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGpx, writeGpx } from "../src/gpx.js";

const sample = {
  segments: [
    [
      { lat: 35.1, lon: 138.2, ele: 1200.5, time: Date.parse("2026-01-17T09:00:00Z"), speed: null },
      { lat: 35.2, lon: 138.3, ele: 1199, time: Date.parse("2026-01-17T09:00:01Z"), speed: null },
    ],
  ],
  meta: { creator: "FitoTrack", name: "Morning Ski", time: "2026-01-17T00:00:18Z", type: "ski" },
};

test("emits a valid GPX 1.1 header and structure", () => {
  const gpx = writeGpx(sample);
  assert.match(gpx, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(gpx, /<gpx version="1\.1" creator="FitoTrack"/);
  assert.match(gpx, /xmlns="http:\/\/www\.topografix\.com\/GPX\/1\/1"/);
  assert.match(gpx, /<trk>[\s\S]*<trkseg>[\s\S]*<\/trkseg>[\s\S]*<\/trk>/);
});

test("round-trips segments and meta through parse → write → parse", () => {
  const round = parseGpx(writeGpx(sample));
  assert.deepEqual(round.segments, sample.segments);
  assert.deepEqual(round.meta, sample.meta);
});

test("reproduces metadata (name, time) and track (name, type)", () => {
  const gpx = writeGpx(sample);
  assert.match(
    gpx,
    /<metadata>[\s\S]*<name>Morning Ski<\/name>[\s\S]*<time>2026-01-17T00:00:18Z<\/time>/,
  );
  assert.match(gpx, /<trk>[\s\S]*<name>Morning Ski<\/name>[\s\S]*<type>ski<\/type>/);
});

test("creator defaults to source, override via opts", () => {
  assert.match(writeGpx(sample), /creator="FitoTrack"/);
  assert.match(writeGpx(sample, { creator: "gpx-stabilizer" }), /creator="gpx-stabilizer"/);
  assert.match(writeGpx({ segments: [], meta: {} }), /creator="gpx-stabilizer"/);
});

test("omits <ele>/<time> for points that lack them", () => {
  const gpx = writeGpx({ segments: [[{ lat: 1, lon: 2, ele: null, time: null }]], meta: {} });
  assert.match(gpx, /<trkpt lat="1" lon="2"><\/trkpt>/);
  assert.doesNotMatch(gpx, /<ele>/);
  assert.doesNotMatch(gpx, /<trkpt[^>]*><time>/);
});

test("omits <metadata> block when there is no name or time", () => {
  const gpx = writeGpx({
    segments: [[{ lat: 1, lon: 2, ele: null, time: null }]],
    meta: { type: "ski" },
  });
  assert.doesNotMatch(gpx, /<metadata>/);
  assert.match(gpx, /<type>ski<\/type>/);
});

test("escapes and round-trips XML special characters in meta", () => {
  const t = {
    segments: [[{ lat: 1, lon: 2, ele: null, time: null }]],
    meta: { name: "A & B <c>" },
  };
  const gpx = writeGpx(t);
  assert.match(gpx, /<name>A &amp; B &lt;c&gt;<\/name>/);
  assert.equal(parseGpx(gpx).meta.name, "A & B <c>");
});

test("drops the millisecond suffix for whole-second times", () => {
  const gpx = writeGpx({
    segments: [[{ lat: 1, lon: 2, ele: null, time: Date.parse("2026-01-17T09:00:00Z") }]],
    meta: {},
  });
  assert.match(gpx, /<time>2026-01-17T09:00:00Z<\/time>/);
});

test("keeps sub-second precision when present", () => {
  const gpx = writeGpx({
    segments: [[{ lat: 1, lon: 2, ele: null, time: Date.parse("2026-01-17T09:00:00.5Z") }]],
    meta: {},
  });
  assert.match(gpx, /<time>2026-01-17T09:00:00\.500Z<\/time>/);
});

test("caps coordinate precision and drops trailing zeros", () => {
  const gpx = writeGpx({
    segments: [[{ lat: 40.00231093727052, lon: -122.6, ele: null, time: null }]],
    meta: {},
  });
  assert.match(gpx, /lat="40\.0023109" lon="-122\.6"/);
});
