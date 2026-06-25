import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGpx } from "../src/gpx.js";

test("parses a segment with lat/lon/ele/time", () => {
  const gpx = `<gpx><trk><trkseg>
    <trkpt lat="35.1" lon="138.2"><ele>1200.5</ele><time>2026-01-17T09:00:00Z</time></trkpt>
    <trkpt lat="35.2" lon="138.3"><ele>1199.0</ele><time>2026-01-17T09:00:01Z</time></trkpt>
  </trkseg></trk></gpx>`;
  const { segments } = parseGpx(gpx);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].length, 2);
  assert.deepEqual(segments[0][0], {
    lat: 35.1,
    lon: 138.2,
    ele: 1200.5,
    time: Date.parse("2026-01-17T09:00:00Z"),
    speed: null,
  });
  assert.equal(segments[0][1].lat, 35.2);
});

test("reads device <speed> (m/s) from extensions, null when absent", () => {
  const gpx = `<gpx><trk><trkseg>
    <trkpt lat="35.1" lon="138.2"><ele>1200</ele>
      <extensions><speed>3.29</speed></extensions>
      <time>2026-01-17T09:00:00Z</time></trkpt>
    <trkpt lat="35.2" lon="138.3"><time>2026-01-17T09:00:01Z</time></trkpt>
  </trkseg></trk></gpx>`;
  const { segments } = parseGpx(gpx);
  assert.equal(segments[0][0].speed, 3.29); // read from <extensions>
  assert.equal(segments[0][1].speed, null); // absent → null
});

test("splits multiple trksegs into separate segments", () => {
  const gpx = `<gpx><trk>
    <trkseg><trkpt lat="1" lon="2"/></trkseg>
    <trkseg><trkpt lat="3" lon="4"/><trkpt lat="5" lon="6"/></trkseg>
  </trk></gpx>`;
  const { segments } = parseGpx(gpx);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].length, 1);
  assert.equal(segments[1].length, 2);
});

test("missing ele/time become null", () => {
  const { segments } = parseGpx(`<trkseg><trkpt lat="1" lon="2"></trkpt></trkseg>`);
  assert.equal(segments[0][0].ele, null);
  assert.equal(segments[0][0].time, null);
});

test("self-closing trkpt", () => {
  const { segments } = parseGpx(`<trkseg><trkpt lat="1.5" lon="2.5" /></trkseg>`);
  assert.deepEqual(segments[0][0], { lat: 1.5, lon: 2.5, ele: null, time: null, speed: null });
});

test("attribute order lon-before-lat and single quotes", () => {
  const { segments } = parseGpx(`<trkseg><trkpt lon='2' lat='1'/></trkseg>`);
  assert.equal(segments[0][0].lat, 1);
  assert.equal(segments[0][0].lon, 2);
});

test("negative coordinates", () => {
  const { segments } = parseGpx(`<trkseg><trkpt lat="-45.5" lon="-122.6"/></trkseg>`);
  assert.equal(segments[0][0].lat, -45.5);
  assert.equal(segments[0][0].lon, -122.6);
});

test("collects trksegs across multiple tracks", () => {
  const gpx = `<gpx>
    <trk><trkseg><trkpt lat="1" lon="1"/></trkseg></trk>
    <trk><trkseg><trkpt lat="2" lon="2"/></trkseg></trk>
  </gpx>`;
  assert.equal(parseGpx(gpx).segments.length, 2);
});

test("trkpt without a trkseg wrapper is one segment", () => {
  const { segments } = parseGpx(`<gpx><trkpt lat="1" lon="2"/></gpx>`);
  assert.equal(segments.length, 1);
  assert.equal(segments[0][0].lat, 1);
});

test("skips a trkpt missing lat or lon", () => {
  const { segments } = parseGpx(`<trkseg>
    <trkpt lon="2"/>
    <trkpt lat="1" lon="2"/>
  </trkseg>`);
  assert.equal(segments[0].length, 1);
  assert.equal(segments[0][0].lat, 1);
});

test("no trackpoints yields empty segments", () => {
  assert.deepEqual(parseGpx("<gpx></gpx>").segments, []);
});

test("tolerates whitespace and newlines in tags and values", () => {
  const gpx = `<trkseg>
    <trkpt   lat="1.0"   lon="2.0" >
      <ele> 100.0 </ele>
      <time> 2026-01-17T09:00:00Z </time>
    </trkpt>
  </trkseg>`;
  const p = parseGpx(gpx).segments[0][0];
  assert.equal(p.ele, 100);
  assert.equal(p.time, Date.parse("2026-01-17T09:00:00Z"));
});

test("throws on non-string input", () => {
  assert.throws(() => parseGpx(null), TypeError);
});

test("captures meta: creator, name, time, type", () => {
  const gpx = `<gpx creator="FitoTrack" version="1.1">
    <metadata><name>Morning Ski</name><time>2026-01-17T00:00:18Z</time></metadata>
    <trk><name>Morning Ski</name><src>FitoTrack</src>
      <trkseg><trkpt lat="1" lon="2"/></trkseg>
      <type>ski</type>
    </trk>
  </gpx>`;
  assert.deepEqual(parseGpx(gpx).meta, {
    creator: "FitoTrack",
    name: "Morning Ski",
    time: "2026-01-17T00:00:18Z",
    type: "ski",
  });
});

test("meta name falls back to <trk> name when metadata has none", () => {
  const gpx = `<gpx creator="X"><metadata><time>2026-01-01T00:00:00Z</time></metadata>
    <trk><name>Trk Name</name><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>`;
  assert.equal(parseGpx(gpx).meta.name, "Trk Name");
});

test("meta captures <type> placed after <trkseg>", () => {
  const gpx = `<gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg><type>ski</type></trk></gpx>`;
  assert.equal(parseGpx(gpx).meta.type, "ski");
});

test("meta time ignores per-point <time>", () => {
  const gpx = `<gpx><trk><trkseg>
    <trkpt lat="1" lon="2"><time>2026-01-17T09:00:00Z</time></trkpt>
  </trkseg></trk></gpx>`;
  assert.equal(parseGpx(gpx).meta.time, null);
});

test("absent meta fields are null", () => {
  const { meta } = parseGpx(`<gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>`);
  assert.deepEqual(meta, { creator: null, name: null, time: null, type: null });
});
