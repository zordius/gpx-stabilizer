import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGroups, family } from "../src/group.js";

// minimal TrackPoint
const pt = (lat, lon, time) => ({ lat, lon, time });

test("family: maps a GoPro filename to its camera family", () => {
  assert.equal(family("GOPR1234.MP4"), "GOPR"); // session first file
  assert.equal(family("GP011234.MP4"), "GOPR"); // continuation chapter -> same family
  assert.equal(family("GX011234.MP4"), "GX"); // newer scheme
  assert.equal(family("GH011234.MP4"), "GH");
  assert.equal(family("/path/to/DJI_0001.MP4"), "DJI"); // unknown -> leading letters
});

test("buildGroups: two same-model bodies on one day split by serial, names disambiguated", () => {
  const { groups } = buildGroups([
    { family: "GX", date: "20260628", serial: "aaaa1111", mediaId: "m1", points: [pt(1, 1, 10)] },
    { family: "GX", date: "20260628", serial: "bbbb2222", mediaId: "m2", points: [pt(2, 2, 20)] },
  ]);
  assert.equal(groups.length, 2);
  const names = groups.map((g) => g.name).sort();
  // same family+date collides -> short serial suffix on both
  assert.deepEqual(names, ["20260628-GX-aaaa1111", "20260628-GX-bbbb2222"]);
});

test("buildGroups: a lone camera keeps the readable <date>-<family> name (no serial suffix)", () => {
  const { groups } = buildGroups([
    { family: "GX", date: "20260628", serial: "aaaa1111", mediaId: "m1", points: [pt(1, 1, 10)] },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "20260628-GX");
});

test("buildGroups: no serial -> falls back to family grouping", () => {
  const { groups } = buildGroups([
    { family: "GOPR", date: "20260628", serial: null, mediaId: null, points: [pt(1, 1, 10)] },
    { family: "GOPR", date: "20260628", serial: null, mediaId: null, points: [pt(2, 2, 20)] },
  ]);
  assert.equal(groups.length, 1); // both merge by family+date
  assert.equal(groups[0].name, "20260628-GOPR");
  assert.equal(groups[0].segments.length, 1); // no GUMI -> single fallback segment
  assert.equal(groups[0].segments[0].length, 2);
});

test("buildGroups: GUMI splits recording sessions into <trkseg>s, ordered by start time", () => {
  const { groups } = buildGroups([
    // later session listed first; chapters of session A span two files (same mediaId)
    { family: "GX", date: "20260628", serial: "s1", mediaId: "B", points: [pt(5, 5, 500)] },
    { family: "GX", date: "20260628", serial: "s1", mediaId: "A", points: [pt(1, 1, 100)] },
    { family: "GX", date: "20260628", serial: "s1", mediaId: "A", points: [pt(2, 2, 200)] },
  ]);
  assert.equal(groups.length, 1);
  const segs = groups[0].segments;
  assert.equal(segs.length, 2); // session A + session B
  // segment A is earlier -> comes first; its two chapter files merged & time-sorted
  assert.deepEqual(
    segs[0].map((p) => p.time),
    [100, 200],
  );
  assert.deepEqual(
    segs[1].map((p) => p.time),
    [500],
  );
  assert.equal(groups[0].startMs, 100);
});

test("buildGroups: a crash (new GUMI, same serial+date) rejoins into one daily file, two segments", () => {
  const { groups } = buildGroups([
    { family: "GX", date: "20260628", serial: "s1", mediaId: "before", points: [pt(1, 1, 100)] },
    { family: "GX", date: "20260628", serial: "s1", mediaId: "after", points: [pt(2, 2, 300)] },
  ]);
  assert.equal(groups.length, 1); // one file (rejoined)
  assert.equal(groups[0].segments.length, 2); // crash shows as a segment break
});

test("buildGroups: drops (0,0) placeholder fixes; an all-placeholder session is skipped", () => {
  const { groups, skipped } = buildGroups([
    {
      family: "GX",
      date: "20260628",
      serial: "s1",
      mediaId: "real",
      points: [pt(0, 0, 1), pt(1, 1, 100)],
    },
    {
      family: "GX",
      date: "20260629",
      serial: "s1",
      mediaId: "dead",
      points: [pt(0, 0, 1), pt(0, 0, 2)],
    },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "20260628-GX");
  assert.equal(groups[0].segments[0].length, 1); // placeholder dropped
  assert.equal(groups[0].segments[0][0].lat, 1);
  assert.deepEqual(skipped, ["20260629-GX"]); // never-locked session reported as skipped
});
