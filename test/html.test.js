import assert from "node:assert/strict";
import { test } from "node:test";
import { toSvg, writeHtml } from "../src/html.js";

const pts = (...xy) => xy.map(([x, y]) => ({ x, y }));

test("svg root carries xmlns, preserveAspectRatio, and no fixed pixel size (CSS sizes it)", () => {
  const svg = toSvg([{ label: "track", lines: [pts([0, 0], [1, 1])] }]);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /preserveAspectRatio="xMidYMid meet"/);
  assert.doesNotMatch(svg, /^<svg [^>]*\bwidth=/); // no fixed width/height — CSS drives the size
  assert.match(svg, /<\/svg>/);
});

test("viewBox is the data's own bounding box, inset by the padding fraction", () => {
  // x 0..1, y 0..1; default padding 0.02 -> inset 0.02 each axis
  const svg = toSvg([{ label: "t", lines: [pts([0, 0], [1, 1])] }]);
  assert.match(svg, /viewBox="-0.02 -0.02 1.04 1.04"/);
  // padding 0 -> viewBox is exactly the bbox, keeping the data's aspect ratio (2:1 here)
  const tight = toSvg([{ label: "t", lines: [pts([0, 0], [100, 50])] }], { padding: 0 });
  assert.match(tight, /viewBox="0 0 100 50"/);
});

test("svg exposes the bbox aspect ratio as a --ar CSS variable (CSS sizes the element)", () => {
  // bbox 100 x 50 -> aspect ratio 2; CSS uses --ar to fit the largest box into the viewport
  const svg = toSvg([{ label: "t", lines: [pts([0, 0], [100, 50])] }], { padding: 0 });
  assert.match(svg, /style="--ar:2"/);
});

test("each layer becomes a labelled <g> with an id", () => {
  const svg = toSvg([
    { label: "track", lines: [pts([0, 0], [1, 1])] },
    { label: "noise points", points: pts([0.5, 0.5]) },
  ]);
  assert.match(svg, /<g id="layer-track" class="layer"/);
  assert.match(svg, /<g id="layer-noise-points" class="layer"/);
});

test("a line layer (width set) renders polylines; points render as one marker <path>", () => {
  const svg = toSvg([
    { label: "a", lines: [pts([0, 0], [1, 1])], width: 1.5 },
    { label: "b", points: pts([0.5, 0.5]) },
  ]);
  assert.equal([...svg.matchAll(/<polyline/g)].length, 1);
  assert.equal([...svg.matchAll(/<path /g)].length, 1);
});

test("multiple lines in one layer", () => {
  const svg = toSvg([
    { label: "t", lines: [pts([0, 0], [1, 1]), pts([2, 2], [3, 3])], width: 1.5 },
  ]);
  assert.equal([...svg.matchAll(/<polyline/g)].length, 2);
});

test("no line width: the line's points render as markers (dots)", () => {
  const svg = toSvg([{ label: "g", lines: [pts([0, 0], [1, 1])], color: "#06c" }]);
  assert.doesNotMatch(svg, /<polyline/);
  assert.match(svg, /<path d="M0,0 h0 M1,1 h0" stroke="#06c"/);
});

test("line + point style: the line's points are reused as markers, drawn on top", () => {
  const svg = toSvg([
    { label: "g", lines: [pts([0, 0], [1, 1])], width: 2, pointColor: "#c00", size: 3 },
  ]);
  assert.ok(svg.indexOf("<polyline") < svg.indexOf("<path "), "markers come after the line");
  assert.match(svg, /<path d="M0,0 h0 M1,1 h0" stroke="#c00" stroke-width="4"/); // size 3 -> 3+1
});

test("no baked-in zoom transform; coords are raw and the viewBox does the framing", () => {
  const svg = toSvg([{ label: "t", lines: [pts([0, 0], [100, 50])], width: 1.5 }], { padding: 0 });
  assert.doesNotMatch(svg, /<g transform=/); // no JS zoom — CSS + preserveAspectRatio fit it
  assert.match(svg, /<polyline points="0,0 100,50"/); // raw x/y, framed by the data-bbox viewBox
});

test("markers are a stroked dot path; square uses a square cap, size = stroke-width", () => {
  const svg = toSvg([{ label: "p", points: pts([0, 0]), shape: "square", size: 4 }]);
  assert.match(svg, /<path d="M0,0 h0" stroke="[^"]*" stroke-width="5" stroke-linecap="square"\/>/);
  assert.doesNotMatch(svg, /<circle|<rect/);
});

test("line paint hoists onto the group; a markers-only layer keeps a bare group + own path", () => {
  const line = toSvg([{ label: "l", lines: [pts([0, 0], [1, 1])], color: "red", width: 3 }]);
  assert.match(line, /<g id="layer-l" class="layer" fill="none" stroke="red" stroke-width="3">/);
  const dot = toSvg([{ label: "d", points: pts([0, 0]), color: "blue", opacity: 0.5 }]);
  assert.match(dot, /<g id="layer-d" class="layer">/); // points-only: bare group
  assert.match(
    dot,
    /<path [^>]*stroke="blue" stroke-width="3" stroke-linecap="round" opacity="0.5"\/>/,
  );
});

test("a line layer hoists its stroke to the group, leaving the polyline bare", () => {
  const svg = toSvg([{ label: "m", lines: [pts([0, 0], [1, 1])], color: "#c00", width: 1.5 }]);
  assert.match(svg, /<g id="layer-m" class="layer" fill="none" stroke="#c00" stroke-width="1.5">/);
  assert.match(svg, /<polyline points="[^"]+"\/>/); // bare, no per-element paint
});

test("a layer with a line + markers: group stroke for the line, own stroke on the marker path", () => {
  const svg = toSvg([
    {
      label: "x",
      lines: [pts([0, 0], [1, 1])],
      points: pts([0.5, 0.5]),
      color: "#06c",
      width: 1.5,
    },
  ]);
  assert.match(svg, /<g id="layer-x" class="layer" fill="none" stroke="#06c" stroke-width="1.5">/);
  assert.match(svg, /<polyline points="[^"]+"\/>/); // bare line, inherits the group stroke
  assert.match(svg, /<path [^>]*stroke="#06c" stroke-width="3"/); // markers carry their own (size 2 -> 3)
});

test("polygon mode fills the shape via the hoisted group color", () => {
  const svg = toSvg([
    { label: "area", lines: [pts([0, 0], [1, 0], [1, 1], [0, 1])], polygon: true, color: "#eee" },
  ]);
  assert.match(svg, /<g id="layer-area" class="layer" fill="#eee">/);
  assert.match(svg, /<polygon points="[^"]+"\/>/);
  assert.doesNotMatch(svg, /<polyline/);
});

test('labels render as <text> inside a class="label" group with font-size on the group', () => {
  const svg = toSvg([{ label: "lifts", labels: [{ x: 0, y: 0, text: "Lift A" }] }]);
  assert.match(svg, /<g class="label" font-size="12"[^>]*>/);
  assert.match(svg, /<text x="[\d.]+" y="[\d.]+">Lift A<\/text>/);
  // size lives once on the group, not repeated on each text
  assert.doesNotMatch(svg, /<text[^>]*font-size=/);
});

test("label font-size and fill follow the layer", () => {
  const svg = toSvg([
    { label: "x", color: "#333", fontSize: 20, labels: [{ x: 0, y: 0, text: "Hi" }] },
  ]);
  assert.match(svg, /<g class="label" font-size="20" fill="#333"/);
});

test("label text is XML-escaped", () => {
  const svg = toSvg([{ label: "x", labels: [{ x: 0, y: 0, text: "A & <B>" }] }]);
  assert.match(svg, /<text [^>]*>A &amp; &lt;B&gt;<\/text>/);
});

test("no <style> tag is ever emitted", () => {
  const svg = toSvg([{ label: "x", labels: [{ x: 0, y: 0, text: "Hi" }] }]);
  assert.doesNotMatch(svg, /<style/);
});

test("background option adds a rect covering the viewBox", () => {
  const svg = toSvg([{ label: "t", lines: [pts([0, 0], [1, 1])] }], {
    background: "#fff",
    padding: 0,
  });
  assert.match(svg, /<rect x="0" y="0" width="1" height="1" fill="#fff"\/>/);
});

test("no points yields an svg with no layers drawn", () => {
  const svg = toSvg([{ label: "empty", lines: [] }]);
  assert.doesNotMatch(svg, /<polyline|<circle|<rect/);
});

test("empty layer list yields a minimal svg", () => {
  assert.match(toSvg([]), /<svg[^>]*><\/svg>/);
});

test("toSvg returns a string and writes no file", () => {
  const svg = toSvg([{ label: "t", lines: [pts([0, 0], [1, 1])] }]);
  assert.equal(typeof svg, "string");
  assert.match(svg, /^<svg /);
});

test("writeHtml emits a full HTML document", () => {
  const html = writeHtml([{ layers: [{ label: "t", lines: [pts([0, 0], [1, 1])] }] }]);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<html lang="en">[\s\S]*<\/html>/);
  assert.match(html, /<head>[\s\S]*<\/head>/);
  assert.match(html, /<body>[\s\S]*<\/body>/);
});

test("writeHtml calls toSvg once per panel", () => {
  const panel = (lat) => ({ layers: [{ label: "t", points: pts([lat, 0]) }] });
  const html = writeHtml([panel(0), panel(1), panel(2)]);
  // count panel SVGs only (they carry xmlns); legend swatch SVGs don't
  assert.equal([...html.matchAll(/<svg xmlns/g)].length, 3);
});

test("writeHtml honours per-panel toSvg opts", () => {
  const html = writeHtml([
    {
      layers: [{ label: "t", lines: [pts([0, 0], [1, 1])] }],
      opts: { background: "#abc", padding: 0 },
    },
  ]);
  assert.match(html, /<rect x="0" y="0" width="1" height="1" fill="#abc"\/>/);
});

test("writeHtml sets and escapes the document title", () => {
  assert.match(writeHtml([], { title: "A & B" }), /<title>A &amp; B<\/title>/);
  assert.match(writeHtml([]), /<title>gpx-stabilizer<\/title>/);
});
