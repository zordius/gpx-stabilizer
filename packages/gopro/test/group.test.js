import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGroups, family, fileNumber, gkeyOf, groupNames } from "../src/group.js";

// minimal TrackPoint
const pt = (lat, lon, time) => ({ lat, lon, time });
const GAP = 200_000; // > BIG_GAP_MS (120 s) — forces a within-session time split

test("family: maps a GoPro filename to its camera family", () => {
  assert.equal(family("GOPR1234.MP4"), "GOPR"); // session first file
  assert.equal(family("GP011234.MP4"), "GOPR"); // continuation chapter -> same family
  assert.equal(family("GX011234.MP4"), "GX"); // newer scheme
  assert.equal(family("GH011234.MP4"), "GH");
  assert.equal(family("/path/to/DJI_0001.MP4"), "DJI"); // unknown -> leading letters
});

test("fileNumber: the 4-digit recording id a recording's chapters share", () => {
  assert.equal(fileNumber("GOPR5134.MP4"), "5134"); // first chapter
  assert.equal(fileNumber("GP015134.MP4"), "5134"); // GOPR continuation -> same number
  assert.equal(fileNumber("GP105134.MP4"), "5134"); // 10th chapter -> still same
  assert.equal(fileNumber("GX015131.MP4"), "5131"); // newer scheme, chapter 01
  assert.equal(fileNumber("GX115131.MP4"), "5131"); // chapter 11 -> same recording
  assert.equal(fileNumber("/a/b/GX015132.MP4"), "5132"); // next recording
  assert.equal(fileNumber("weird.mov"), null); // no 4-digit tail -> fallback
});

test("buildGroups: two same-model bodies on one day split by serial, names disambiguated", () => {
  const { groups } = buildGroups([
    { family: "GX", date: "20260628", serial: "aaaa1111", session: "5131", points: [pt(1, 1, 10)] },
    { family: "GX", date: "20260628", serial: "bbbb2222", session: "5131", points: [pt(2, 2, 20)] },
  ]);
  assert.equal(groups.length, 2);
  const names = groups.map((g) => g.name).sort();
  // same family+date collides -> short serial suffix on both
  assert.deepEqual(names, ["20260628-GX-aaaa1111", "20260628-GX-bbbb2222"]);
});

test("buildGroups: a lone camera keeps the readable <date>-<family> name (no serial suffix)", () => {
  const { groups } = buildGroups([
    { family: "GX", date: "20260628", serial: "aaaa1111", session: "5131", points: [pt(1, 1, 10)] },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "20260628-GX");
});

test("buildGroups: no serial -> falls back to family grouping", () => {
  const { groups } = buildGroups([
    { family: "GOPR", date: "20260628", serial: null, session: "5131", points: [pt(1, 1, 10)] },
    { family: "GOPR", date: "20260628", serial: null, session: "5131", points: [pt(2, 2, 20)] },
  ]);
  assert.equal(groups.length, 1); // both merge by family+date
  assert.equal(groups[0].name, "20260628-GOPR");
  assert.equal(groups[0].tracks.length, 1); // one recording -> one <trk>
  assert.equal(groups[0].tracks[0].segments.length, 1); // -> one segment
  assert.equal(groups[0].tracks[0].segments[0].length, 2);
});

test("buildGroups (B): a recording's chapters share a file-number -> one merged <trk>, one segment", () => {
  // the Hero10 over-split fix: many chapters of one continuous recording, contiguous in time
  const { groups } = buildGroups([
    { family: "GX", date: "20260628", serial: "s1", session: "5131", points: [pt(3, 3, 300)] },
    { family: "GX", date: "20260628", serial: "s1", session: "5131", points: [pt(1, 1, 100)] },
    { family: "GX", date: "20260628", serial: "s1", session: "5131", points: [pt(2, 2, 200)] },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].tracks.length, 1); // all one recording -> one <trk>
  assert.equal(groups[0].tracks[0].segments.length, 1);
  assert.deepEqual(
    groups[0].tracks[0].segments[0].map((p) => p.time),
    [100, 200, 300], // chapters merged and time-sorted
  );
});

test("buildGroups (B): different file-numbers are separate <trk>s, ordered by start time", () => {
  const { groups } = buildGroups([
    // later recording listed first; recording 5131 spans two chapter files (same number)
    { family: "GX", date: "20260628", serial: "s1", session: "5132", points: [pt(5, 5, 500)] },
    { family: "GX", date: "20260628", serial: "s1", session: "5131", points: [pt(1, 1, 100)] },
    { family: "GX", date: "20260628", serial: "s1", session: "5131", points: [pt(2, 2, 200)] },
  ]);
  assert.equal(groups.length, 1);
  const tracks = groups[0].tracks;
  assert.equal(tracks.length, 2); // two distinct sessions -> two <trk>s, not one track/two segments
  assert.deepEqual(
    tracks[0].segments[0].map((p) => p.time),
    [100, 200],
  );
  assert.deepEqual(
    tracks[1].segments[0].map((p) => p.time),
    [500],
  );
  assert.equal(groups[0].startMs, 100);
});

test("buildGroups (B): back-to-back recordings with a tiny gap still split (file-number partitions)", () => {
  // two separate presses, only 50 ms apart — a pure time split would wrongly merge; the
  // file-number keeps them apart (A may only sub-split within a number, never merge across).
  const { groups } = buildGroups([
    { family: "GX", date: "20260628", serial: "s1", session: "5131", points: [pt(1, 1, 100)] },
    { family: "GX", date: "20260628", serial: "s1", session: "5132", points: [pt(2, 2, 150)] },
  ]);
  assert.equal(groups[0].tracks.length, 2);
});

test("buildGroups: a crash (new file-number, same serial+date) rejoins into one daily file, two <trk>s", () => {
  const { groups } = buildGroups([
    { family: "GX", date: "20260628", serial: "s1", session: "5131", points: [pt(1, 1, 100)] },
    { family: "GX", date: "20260628", serial: "s1", session: "5132", points: [pt(2, 2, 300)] },
  ]);
  assert.equal(groups.length, 1); // one file (rejoined)
  assert.equal(groups[0].tracks.length, 2); // crash shows as a genuinely separate <trk>
});

test("buildGroups (A): a large time gap within one file-number sub-splits (restart / dropout hole)", () => {
  const { groups } = buildGroups([
    {
      family: "GX",
      date: "20260628",
      serial: "s1",
      session: "5131",
      points: [pt(1, 1, 0), pt(1, 1, 1000), pt(2, 2, 1000 + GAP)],
    },
  ]);
  assert.equal(groups[0].tracks.length, 1); // still one session -> one <trk>
  const segs = groups[0].tracks[0].segments;
  assert.equal(segs.length, 2); // the > BIG_GAP jump sub-splits it into two <trkseg>s
  assert.deepEqual(
    segs[0].map((p) => p.time),
    [0, 1000],
  );
  assert.deepEqual(
    segs[1].map((p) => p.time),
    [1000 + GAP],
  );
});

test("buildGroups (A): with no file-number, the time gap is the sole session clusterer", () => {
  const { groups } = buildGroups([
    {
      family: "DJI",
      date: "20260628",
      serial: null,
      session: null,
      points: [pt(1, 1, 100), pt(1, 1, 200), pt(2, 2, 200 + GAP)],
    },
  ]);
  assert.equal(groups[0].tracks.length, 1); // one fallback bucket -> one <trk>
  assert.equal(groups[0].tracks[0].segments.length, 2); // near points cluster; the far one splits off
});

test("buildGroups: each <trk>'s name is the earliest (chapter-order) contributing file's basename", () => {
  const { groups } = buildGroups([
    {
      family: "GX",
      date: "20260628",
      serial: "s1",
      session: "5131",
      points: [pt(1, 1, 100)],
      file: "/media/GX020042.MP4", // chapter 2
    },
    {
      family: "GX",
      date: "20260628",
      serial: "s1",
      session: "5131",
      points: [pt(2, 2, 200)],
      file: "/media/GX010042.MP4", // chapter 1 -- alphabetically first, should win
    },
  ]);
  assert.equal(groups[0].tracks.length, 1);
  assert.equal(groups[0].tracks[0].name, "GX010042");
});

test("buildGroups: a <trk> with no contributing file path at all gets a null name", () => {
  const { groups } = buildGroups([
    { family: "GX", date: "20260628", serial: "s1", session: "5131", points: [pt(1, 1, 100)] },
  ]);
  assert.equal(groups[0].tracks[0].name, null);
});

test("groupNames: matches buildGroups' naming (readable name, serial-clash suffix)", () => {
  const entries = [
    { family: "GX", date: "20260628", serial: "aaaa1111", session: "5131", points: [pt(1, 1, 10)] },
    { family: "GX", date: "20260628", serial: "bbbb2222", session: "5131", points: [pt(2, 2, 20)] },
    { family: "GOPR", date: "20260629", serial: null, session: "9001", points: [pt(3, 3, 30)] },
  ];
  const names = groupNames(entries);
  assert.equal(names.get(gkeyOf(entries[0])), "20260628-GX-aaaa1111");
  assert.equal(names.get(gkeyOf(entries[1])), "20260628-GX-bbbb2222");
  assert.equal(names.get(gkeyOf(entries[2])), "20260629-GOPR"); // lone camera -> no suffix
});

test("groupNames: gkeyOf merges same serial+date regardless of family/session", () => {
  const a = { family: "GX", date: "20260628", serial: "s1", session: "5131", points: [] };
  const b = { family: "GX", date: "20260628", serial: "s1", session: "5132", points: [] };
  assert.equal(gkeyOf(a), gkeyOf(b));
  const names = groupNames([a, b]);
  assert.equal(names.size, 1); // one gkey -> one name, shared by both sessions
});

test("buildGroups: drops (0,0) placeholder fixes; an all-placeholder session is skipped", () => {
  const { groups, skipped } = buildGroups([
    {
      family: "GX",
      date: "20260628",
      serial: "s1",
      session: "5131",
      points: [pt(0, 0, 1), pt(1, 1, 100)],
    },
    {
      family: "GX",
      date: "20260629",
      serial: "s1",
      session: "5132",
      points: [pt(0, 0, 1), pt(0, 0, 2)],
    },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "20260628-GX");
  assert.equal(groups[0].tracks[0].segments[0].length, 1); // placeholder dropped
  assert.equal(groups[0].tracks[0].segments[0][0].lat, 1);
  assert.deepEqual(skipped, ["20260629-GX"]); // never-locked session reported as skipped
});
