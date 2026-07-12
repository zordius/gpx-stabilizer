import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzedLayers,
  elevationChartSvg,
  segmentLabels,
  toHtml,
  toHtmlAnalyzedFiles,
  toLayers,
  withXY,
} from "../src/view.js";

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

test("analyzedLayers: 'liftBoardingEle fix' layer covers exactly the points that module overrode", () => {
  const fakeBoardingFix = {
    name: "fakeBoardingFix",
    finalize: (out) => {
      out[1].liftBoardingEle = { ele: out[1].ele + 5 };
      out[2].liftBoardingEle = { ele: out[2].ele + 3 };
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
  const layers = analyzedLayers(track, { modules: [fakeBoardingFix] });
  const fix = layers.find((l) => l.label === "liftBoardingEle fix");
  assert.ok(fix);
  assert.equal(fix.points.length, 2);
});

test("analyzedLayers: 'liftBoardingEle fix' layer also covers points the module DROPPED (ele: null)", () => {
  // the HEAD mechanism now drops a queue region's elevation rather than correcting it (see
  // mods/liftBoardingEle.js) — the field is still present, just with a null `ele`, and this layer's
  // job is "did the module touch this point at all", so it must not disappear from view.
  const fakeBoardingDrop = {
    name: "fakeBoardingDrop",
    finalize: (out) => {
      out[1].liftBoardingEle = { ele: null };
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
  const layers = analyzedLayers(track, { modules: [fakeBoardingDrop] });
  const fix = layers.find((l) => l.label === "liftBoardingEle fix");
  assert.equal(fix.points.length, 1);
});

test("analyzedLayers: 'lift start/end' layer covers the first+last point of each segment.type===\"lift\" run", () => {
  const fakeLiftSegment = {
    name: "fakeLiftSegment",
    finalize: (out) => {
      for (let i = 1; i <= 3; i++) out[i].segment = { id: 0, type: "lift" };
    },
  };
  const mx = Math.cos((36 * Math.PI) / 180) * 111320;
  const step = 5 / mx;
  const track = Array.from({ length: 6 }, (_, i) => ({
    lat: 36,
    lon: 138 + i * step,
    ele: 1000,
    time: i * 1000,
  }));
  const layers = analyzedLayers(track, { modules: [fakeLiftSegment] });
  const boundary = layers.find((l) => l.label === "lift start/end");
  assert.ok(boundary);
  assert.equal(boundary.points.length, 2); // just index 1 (start) and index 3 (end), not the middle
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

test("analyzedLayers: clean also breaks on a plain TIME gap between two kept points, not just a drop", () => {
  // a source recording gap (e.g. a GPS dropout) can leave two adjacent KEPT points (neither carries a
  // dropReason -- nothing was measured there to drop) far apart in time. Barely moving during the gap
  // keeps this from also tripping an implausible-motion drop, isolating the time-gap check itself.
  const mx = Math.cos((36 * Math.PI) / 180) * 111320;
  const step = 5 / mx; // ~5 m/s eastward
  const before = Array.from({ length: 10 }, (_, i) => ({
    lat: 36,
    lon: 138 + i * step,
    ele: 1000,
    time: i * 1000,
  }));
  const after = Array.from({ length: 10 }, (_, i) => ({
    lat: 36,
    lon: 138 + (10 + i) * step,
    ele: 1000,
    time: 30000 + i * 1000, // 21 s gap from the last `before` point (9000 -> 30000)
  }));
  const layers = analyzedLayers([...before, ...after], { stabilized: false });
  const clean = layers.find((l) => l.label === "clean");
  assert.equal(
    clean.lines.length,
    2,
    "a plain time gap between two kept points still breaks clean",
  );
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

test("analyzedLayers: fix≠3d drop layer marks points the core fixQuality builtin actually dropped", () => {
  const mx = Math.cos((36 * Math.PI) / 180) * 111320;
  const step = 5 / mx; // ~5 m/s eastward
  const track = Array.from({ length: 10 }, (_, i) => ({
    lat: 36,
    lon: 138 + i * step,
    ele: 1000,
    time: i * 1000,
    fix: i < 3 ? "none" : i === 5 ? "2d" : "3d", // a leading cold-start run + one later 2d sample
  }));
  const layers = analyzedLayers(track, { stabilized: false });
  const fixLayer = layers.find((l) => l.label === "fix≠3d drop");
  assert.ok(fixLayer);
  assert.equal(fixLayer.color, "#c00"); // a direct drop, red like drift/stray/outlier/activity
  assert.equal(fixLayer.points.length, 4); // indices 0,1,2 ("none") + 5 ("2d") — actually dropped
});

test("analyzedLayers: fix≠3d drop layer self-gates to empty when the source has no <fix>", () => {
  const mx = Math.cos((36 * Math.PI) / 180) * 111320;
  const step = 5 / mx;
  const track = Array.from({ length: 10 }, (_, i) => ({
    lat: 36,
    lon: 138 + i * step,
    ele: 1000,
    time: i * 1000,
  }));
  const layers = analyzedLayers(track, { stabilized: false });
  assert.equal(layers.find((l) => l.label === "fix≠3d drop").points.length, 0);
});

function straightClimb(n = 10) {
  const mx = Math.cos((36 * Math.PI) / 180) * 111320;
  const step = 5 / mx; // ~5 m/s eastward
  return Array.from({ length: n }, (_, i) => ({
    lat: 36,
    lon: 138 + i * step,
    ele: 1000 + i,
    time: i * 1000,
  }));
}

// The elevation LINE's own path "d" attributes specifically (not the raw-dots path, which also has
// its own "M"s — one per dot — and not the root tag's `preserveAspectRatio="xMidYMid meet"`, which
// contains two capital "M"s of its own). A gap-split or lift/non-lift color-split run renders as
// several sibling `<path>` elements rather than one multi-"M" path, so collect ALL of them (joined)
// — the "count the Ms" assertions below stay meaningful across either shape.
function pathD(svg) {
  return [...svg.matchAll(/<path d="([^"]+)" fill="none" stroke="#0a0"/g)]
    .map((m) => m[1])
    .join(" ");
}

test("elevationChartSvg: draws one path over a normal, gapless track", () => {
  const chart = elevationChartSvg(straightClimb());
  assert.ok(chart);
  assert.match(chart.svg, /class="elev-chart"/);
  assert.equal([...pathD(chart.svg).matchAll(/M/g)].length, 1); // one continuous run -> one "M" subpath
});

test("elevationChartSvg: returns total/kept point counts and the raw time range", () => {
  const track = straightClimb();
  const chart = elevationChartSvg(track);
  assert.equal(chart.total, track.length);
  assert.equal(chart.kept, track.length); // nothing dropped in this fixture
  assert.equal(chart.t0, track[0].time);
  assert.equal(chart.t1, track.at(-1).time);
});

test("elevationChartSvg: embeds data-t0/t1/elemin/elemax/pad* on the root svg for click-to-show-value", () => {
  // straightClimb(): time 0..9000ms, ele 1000..1009 -> exact expected values, no drops in this fixture
  const chart = elevationChartSvg(straightClimb());
  assert.match(chart.svg, /data-t0="0" data-t1="9000" data-elemin="1000" data-elemax="1009"/);
  assert.match(chart.svg, /data-padl="70" data-padr="20" data-padt="20" data-padb="50"/);
});

test("elevationChartSvg: raw points render as small red dots under the 1px green line", () => {
  const chart = elevationChartSvg(straightClimb());
  assert.match(
    chart.svg,
    /<path d="M[^"]+" stroke="#f00" stroke-width="1" stroke-linecap="round"\/>/,
  );
  assert.match(chart.svg, /<path d="M[^"]+" fill="none" stroke="#0a0" stroke-width="1"\/>/);
  // red dots come BEFORE the green line in the markup (drawn underneath it)
  assert.ok(chart.svg.indexOf('stroke="#f00"') < chart.svg.indexOf('stroke="#0a0"'));
});

// A single spatially-continuous straight line (no position reset, unlike naively concatenating two
// independent straightClimb() calls) with one time gap inserted between index 2 and 3 — isolates the
// "does a time gap split the chart" behaviour from any spatial-discontinuity noise the pipeline
// would otherwise legitimately flag and drop.
function straightClimbWithGap(gapMs) {
  const mx = Math.cos((36 * Math.PI) / 180) * 111320;
  const step = 5 / mx;
  return Array.from({ length: 6 }, (_, i) => ({
    lat: 36,
    lon: 138 + i * step,
    ele: 1000 + i,
    time: i < 3 ? i * 1000 : i * 1000 + gapMs,
  }));
}

test("elevationChartSvg: a big time gap between survivors splits into separate subpaths", () => {
  const chart = elevationChartSvg(straightClimbWithGap(20000)); // 20 s gap > default 10 s cap
  assert.ok(chart);
  assert.equal([...pathD(chart.svg).matchAll(/M/g)].length, 2); // two runs -> two "M" subpaths
});

test("elevationChartSvg: a tighter opts.stabilizedMaxGap splits sooner", () => {
  const track = straightClimbWithGap(3000); // 3 s gap
  assert.equal([...pathD(elevationChartSvg(track).svg).matchAll(/M/g)].length, 1); // 3s < default 10s -> one run
  assert.equal(
    [...pathD(elevationChartSvg(track, { stabilizedMaxGap: 2 }).svg).matchAll(/M/g)].length,
    2, // 3 s gap > a 2 s cap -> splits
  );
});

test("elevationChartSvg: plots the STABILIZED elevation, not raw — a liftSnap-shaped override changes the shape", () => {
  const fakeReposition = {
    name: "fakeReposition",
    finalize: (out) => {
      out[1].liftSnap = { lat: out[1].lat, lon: out[1].lon, ele: out[1].ele + 1000 }; // huge override
    },
  };
  const track = straightClimb(3); // raw ele: 1000, 1001, 1002 — a near-flat raw line
  const chart = elevationChartSvg(track, { modules: [fakeReposition], liftSnap: true });
  // extract the 3 y-coordinates from the (green line's) single "M x,y x,y x,y" subpath
  const coords = pathD(chart.svg)
    .slice(1) // drop the leading "M"
    .trim()
    .split(/\s+/)
    .map((pair) => Number(pair.split(",")[1]));
  assert.equal(coords.length, 3);
  // if raw ele were used, all 3 points sit on a near-flat line (barely distinguishable y); the
  // liftSnap-overridden middle point (+1000 m) must stand far apart from both neighbours
  assert.ok(
    Math.abs(coords[1] - coords[0]) > 20,
    `expected the override to move the middle point far apart, got ${coords}`,
  );
});

test("elevationChartSvg: a dropped-ele point between close-together survivors still splits the line, even under stabilizedMaxGap", () => {
  // 5 points 1 s apart (well under the default 10 s cap) — the middle one has its `ele` discarded by
  // an ele-rewriting mod. A pure time-gap check would draw one continuous line straight across it
  // (2026-07-10 bug, found on real data); it must still break here even though nothing is anywhere
  // near opts.stabilizedMaxGap.
  const fakeDrop = {
    name: "fakeDrop",
    finalize: (out) => {
      out[2].liftBoardingEle = { ele: null };
    },
  };
  const track = straightClimb(5);
  const chart = elevationChartSvg(track, { modules: [fakeDrop], liftBoardingEle: true });
  assert.equal([...pathD(chart.svg).matchAll(/M/g)].length, 2); // split around the dropped point
});

test("elevationChartSvg: null when fewer than 2 points survive stabilize()", () => {
  assert.equal(elevationChartSvg([]), null);
  assert.equal(elevationChartSvg([straightClimb(1)[0]]), null);
});

test("toHtmlAnalyzedFiles: embeds each file's elevation chart, opts.stabilized:false omits it", () => {
  const files = [{ name: "a", points: straightClimb() }];
  assert.match(toHtmlAnalyzedFiles(files), /class="elev-chart"/);
  assert.doesNotMatch(toHtmlAnalyzedFiles(files, { stabilized: false }), /class="elev-chart"/);
});

test("toHtmlAnalyzedFiles: the chart section gets a title — file name, raw time range, deleted/total", () => {
  const track = straightClimb(30);
  track[15] = { ...track[15], lat: track[15].lat + 60 / 110540 }; // a ~60 m sideways spike -> outlier drop
  const html = toHtmlAnalyzedFiles([{ name: "myfile.gpx", points: track }]);
  const h2 = html.match(/<header><h2>([^<]+)<\/h2><\/header><svg class="elev-chart"/)[1];
  assert.match(h2, /^myfile\.gpx · /);
  assert.match(h2, / · 3\/30 deleted$/); // the spike plus its glued neighbours, out of 30 raw points
});

test("elevationChartSvg: time tick labels skip when the span is too long to fit them all legibly", () => {
  // a 10-hour span at 10-min tick spacing = 60 ticks — every-tick labels would overlap badly
  const mx = Math.cos((36 * Math.PI) / 180) * 111320;
  const step = 1 / mx; // slow (~1 m/s), so a long span doesn't trip drift/activity
  const longTrack = Array.from({ length: 200 }, (_, i) => ({
    lat: 36,
    lon: 138 + i * step,
    ele: 1000 + (i % 5),
    time: i * 180000, // 3-minute steps -> 200*3min ≈ 10 hours
  }));
  const chart = elevationChartSvg(longTrack);
  assert.ok(chart);
  const gridlines = [...chart.svg.matchAll(/<line x1="[\d.]+" y1="20"/g)].length; // time gridlines
  const labels = [...chart.svg.matchAll(/<text x="[\d.]+" y="470"/g)].length; // time tick labels
  assert.ok(gridlines > 10, `expected many gridlines, got ${gridlines}`); // still one per 10 min
  assert.ok(
    labels < gridlines,
    `expected fewer labels than gridlines, got ${labels} >= ${gridlines}`,
  );
});

test("toHtmlAnalyzedFiles: opts.onProgress fires start/done per file, in order", () => {
  const files = [
    { name: "a", points: straightClimb() },
    { name: "b", points: straightClimb() },
  ];
  const events = [];
  toHtmlAnalyzedFiles(files, { onProgress: (e) => events.push(e) });
  assert.deepEqual(
    events.map((e) => [e.name, e.index, e.total, e.phase]),
    [
      ["a", 0, 2, "start"],
      ["a", 0, 2, "done"],
      ["b", 1, 2, "start"],
      ["b", 1, 2, "done"],
    ],
  );
  assert.ok(typeof events[1].ms === "number" && events[1].ms >= 0); // "done" carries elapsed ms
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
