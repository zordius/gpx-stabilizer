import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzedLayers, segmentLabels, toHtml, toLayers, withXY } from "../src/view.js";

const pts = [
  { lat: 0, lon: 0 },
  { lat: 1, lon: 1 },
  { lat: 0.5, lon: 2 },
];

test("withXY: adds x/y to each point and keeps the original fields", () => {
  const out = withXY(pts);
  assert.equal(out.length, 3);
  assert.equal(out[0].lat, 0); // original fields preserved
  assert.equal(typeof out[0].x, "number");
  assert.equal(typeof out[0].y, "number");
  assert.notEqual(out[0], pts[0]); // not mutated
});

test("withXY: .origin carries the projection centre (mean lat/lon), not an array element", () => {
  const out = withXY(pts);
  assert.equal(out.length, 3); // origin doesn't show up when iterating/indexing
  assert.ok(Math.abs(out.origin.lat0 - (0 + 1 + 0.5) / 3) < 1e-9);
  assert.ok(Math.abs(out.origin.lon0 - (0 + 1 + 2) / 3) < 1e-9);
});

test("toLayers: one track becomes a single line segment holding every point", () => {
  const layers = toLayers(pts);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].label, "gps");
  assert.equal(layers[0].lines.length, 1); // one segment...
  assert.equal(layers[0].lines[0].length, 3); // ...holding every point
  assert.equal(typeof layers[0].lines[0][0].x, "number"); // points carry x/y
  assert.ok(layers.origin); // carried through from withXY for toHtml/toHtmlFiles
});

test("toLayers: several tracks become separate segments sharing ONE projection centre", () => {
  const a = [
    { lat: 0, lon: 0 },
    { lat: 1, lon: 1 },
  ];
  const b = [
    { lat: 0.5, lon: 2 },
    { lat: 0.6, lon: 3 },
  ];
  const layers = toLayers([a, b], { width: 1.5 });
  assert.equal(layers[0].lines.length, 2); // one segment per track — stays broken across the gap
  assert.deepEqual([layers[0].lines[0].length, layers[0].lines[1].length], [2, 2]);
  // shared projection: projecting all four together must match the per-segment x/y exactly
  const all = withXY([...a, ...b]);
  assert.deepEqual(
    [...layers[0].lines[0], ...layers[0].lines[1]].map((p) => [p.x, p.y]),
    all.map((p) => [p.x, p.y]),
  );
});

test("toHtml: produces an HTML document with the gps layer (markers by default)", () => {
  const html = toHtml(pts);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<g id="layer-gps"/);
  assert.match(html, /<path [^>]*d="M/); // no line width -> the track renders as markers
  assert.match(html, /data-lat0="[\d.]+" data-lon0="[\d.]+"/); // click-to-show-coordinates origin
});

test("analyzedLayers: .origin carries the projection centre through from analyze()", () => {
  const track = [
    { lat: 36, lon: 138, ele: 1000, time: 0 },
    { lat: 36.001, lon: 138.001, ele: 1000, time: 1000 },
  ];
  const layers = analyzedLayers(track);
  assert.ok(layers.origin);
  assert.ok(Math.abs(layers.origin.lat0 - 36.0005) < 1e-6);
});

test("analyzedLayers: stabilized layer is ON by default; opts.stabilized: false turns it off", () => {
  const track = [
    { lat: 36, lon: 138, ele: 1000, time: 0 },
    { lat: 36.001, lon: 138.001, ele: 1000, time: 1000 },
  ];
  assert.ok(analyzedLayers(track).find((l) => l.label === "stabilized"));
  assert.equal(
    analyzedLayers(track, { stabilized: false }).find((l) => l.label === "stabilized"),
    undefined,
  );
});

test("analyzedLayers: opts.stabilized diverges from clean exactly where a repositioning module fires", () => {
  // a stand-in finalize module (not real liftSnap.js — that has its own dedicated tests) that
  // shifts one point's position, so we can see `clean` (analyze()'s own kept-point position,
  // untouched by any repositioning module) and `stabilized` (the real stabilize() export, which
  // reads liftSnap-shaped signals) genuinely disagree — the whole point of this layer.
  const fakeReposition = {
    name: "fakeReposition",
    finalize: (out) => {
      out[1].liftSnap = { lat: out[1].lat + 0.01, lon: out[1].lon };
    },
  };
  const mx = Math.cos((36 * Math.PI) / 180) * 111320;
  const step = 5 / mx;
  const track = Array.from({ length: 5 }, (_, i) => ({
    lat: 36,
    lon: 138 + i * step,
    ele: 1000,
    time: i * 1000,
  }));
  const layers = analyzedLayers(track, { modules: [fakeReposition], liftSnap: true });
  const clean = layers.find((l) => l.label === "clean");
  const stabilized = layers.find((l) => l.label === "stabilized");
  assert.ok(stabilized);
  // both layers cover the shifted point, but at different y (north/south) since lat moved
  assert.notEqual(clean.lines[0][1].y, stabilized.lines[0][1].y);
  // every OTHER point is untouched -> same position in both layers
  assert.equal(clean.lines[0][0].y, stabilized.lines[0][0].y);
});

test("analyzedLayers: a policy drop (oversample) doesn't break the clean line", () => {
  // A high native-sample-rate source (e.g. a Hero10's raw ~10 Hz GPS5): oversample thins it to the
  // 0.5 s gate, so a policy-dropped point sits between nearly every survivor. Those must NOT break
  // the clean line into one-point runs (each a lone, invisible `M` — the real-world bug this
  // regression-tests: docs/gpmf-sensors.md's badspan dilution finding's view.js counterpart,
  // 2026-07-05) — the line should stay ONE continuous run.
  const mx = Math.cos((36 * Math.PI) / 180) * 111320;
  const step = 5 / mx / 10; // ~5 m/s eastward at 10 Hz
  const track = Array.from({ length: 50 }, (_, i) => ({
    lat: 36,
    lon: 138 + i * step,
    ele: 1000,
    time: i * 100, // 10 Hz — every point but every 5th is oversample-thinned
  }));
  const layers = analyzedLayers(track);
  const clean = layers.find((l) => l.label === "clean");
  assert.equal(clean.lines.length, 1, "oversample thinning stays one continuous run, not many");
  assert.ok(clean.lines[0].length >= 10); // holds every surviving (non-oversample-dropped) point
});

test("analyzedLayers: clean track line + per-reason drop layers, unified red circles", () => {
  const mx = Math.cos((36 * Math.PI) / 180) * 111320;
  const step = 5 / mx; // ~5 m/s eastward
  const track = Array.from({ length: 30 }, (_, i) => ({
    lat: 36,
    lon: 138 + i * step,
    ele: 1000,
    time: i * 1000,
  }));
  track[15] = { ...track[15], lat: track[15].lat + 60 / 110540 }; // a ~60 m sideways spike
  // stabilized (on by default) is a separate concern with its own tests — turn it off here so this
  // test stays focused on the original drop-layer/clean-line set.
  const layers = analyzedLayers(track, { stabilized: false });
  const clean = layers.find((l) => l.label === "clean");
  assert.equal(layers[layers.length - 1].label, "clean"); // clean renders LAST = on top
  assert.ok(clean.width > 0);
  // a drop = a break: the outlier spike at 15 cuts the clean line into two runs
  assert.equal(clean.lines.length, 2);
  assert.ok(clean.lines.every((run) => run.length > 0)); // both runs hold kept points
  assert.ok(clean.lines[0].every((p) => typeof p.y === "number")); // y carried (flipped)

  const byLabel = Object.fromEntries(layers.map((l) => [l.label, l]));
  assert.ok(byLabel.raw && byLabel.raw.lines[0].length === track.length); // raw = every input point
  assert.ok(byLabel.drift && byLabel["outlier drop"] && byLabel["activity drop"]); // one layer/reason
  for (const l of [byLabel.drift, byLabel["outlier drop"], byLabel["activity drop"]]) {
    assert.equal(l.color, "#c00"); // all drops look the same…
    assert.equal(l.opacity, 0.7);
    assert.equal(l.shape, undefined); // …default circle, no per-reason shape
  }
  assert.ok(byLabel["outlier drop"].points.length >= 1, "the spike is an outlier drop");
});

test("segmentLabels: head/tail label per segment, 1-based, black, on its own layer", () => {
  const lines = [
    [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 0 },
    ],
    [
      { x: 5, y: 5 },
      { x: 6, y: 6 },
    ],
  ];
  const layer = segmentLabels(lines, { fontSize: 30 });
  assert.equal(layer.color, "#000");
  assert.equal(layer.fontSize, 30);
  assert.deepEqual(layer.labels, [
    { x: 0, y: 0, text: "1s" }, // seg 1 head
    { x: 2, y: 0, text: "1e" }, // seg 1 tail
    { x: 5, y: 5, text: "2s" }, // seg 2 head
    { x: 6, y: 6, text: "2e" }, // seg 2 tail
  ]);
});

test("analyzedLayers: opts.labels appends a black labels layer LAST (on top)", () => {
  const mx = Math.cos((36 * Math.PI) / 180) * 111320;
  const step = 5 / mx; // ~5 m/s eastward — a realistic track that survives the pipeline
  const track = Array.from({ length: 30 }, (_, i) => ({
    lat: 36,
    lon: 138 + i * step,
    ele: 1000,
    time: i * 1000,
  }));
  const layers = analyzedLayers(track, { labels: true, labelSize: 20 });
  const top = layers[layers.length - 1];
  assert.equal(top.label, "labels"); // appended LAST = on top
  assert.equal(top.color, "#000");
  assert.equal(top.fontSize, 20);
  assert.ok(top.labels.length >= 2 && top.labels[0].text === "1s"); // first segment head
});
