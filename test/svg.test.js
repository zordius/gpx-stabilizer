import assert from "node:assert/strict";
import { test } from "node:test";
import { writeSvg } from "../src/svg.js";

const pts = (...latlon) => latlon.map(([lat, lon]) => ({ lat, lon }));

/** Extract the [x, y] pairs of the nth polyline. */
function polyline(svg, n = 0) {
  const all = [...svg.matchAll(/<polyline points="([^"]*)"/g)];
  return all[n] ? all[n][1].split(" ").map((s) => s.split(",").map(Number)) : [];
}

test("valid svg root with xmlns and a fixed 1280x720 viewBox", () => {
  const svg = writeSvg([{ label: "track", lines: [pts([0, 0], [1, 1])] }]);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /viewBox="0 0 1280 720"/);
  assert.match(svg, /width="1280" height="720"/);
  assert.match(svg, /preserveAspectRatio="xMidYMid meet"/);
  assert.match(svg, /<\/svg>/);
});

test("viewBox dimensions are configurable", () => {
  const svg = writeSvg([{ label: "t", lines: [pts([0, 0], [1, 1])] }], {
    viewWidth: 640,
    viewHeight: 480,
  });
  assert.match(svg, /viewBox="0 0 640 480"/);
  assert.match(svg, /width="640" height="480"/);
});

test("each layer becomes a labelled <g> with an id", () => {
  const svg = writeSvg([
    { label: "track", lines: [pts([0, 0], [1, 1])] },
    { label: "noise points", points: pts([0.5, 0.5]) },
  ]);
  assert.match(svg, /<g id="layer-track" class="layer"/);
  assert.match(svg, /<g id="layer-noise-points" class="layer"/);
});

test("lines render as polylines, points as markers", () => {
  const svg = writeSvg([
    { label: "a", lines: [pts([0, 0], [1, 1])] },
    { label: "b", points: pts([0.5, 0.5]) },
  ]);
  assert.equal([...svg.matchAll(/<polyline/g)].length, 1);
  assert.equal([...svg.matchAll(/<circle/g)].length, 1);
});

test("multiple lines in one layer", () => {
  const svg = writeSvg([{ label: "t", lines: [pts([0, 0], [1, 1]), pts([2, 2], [3, 3])] }]);
  assert.equal([...svg.matchAll(/<polyline/g)].length, 2);
});

test("shared projection across layers: north up, east right", () => {
  const svg = writeSvg([
    { label: "a", points: pts([10, 0], [20, 0]) }, // same lon, differing lat
    { label: "b", points: pts([0, 10], [0, 20]) }, // same lat, differing lon
  ]);
  const circles = [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)"/g)].map((m) => [
    Number(m[1]),
    Number(m[2]),
  ]);
  assert.ok(circles[1][1] < circles[0][1], "lat 20 above lat 10");
  assert.ok(circles[3][0] > circles[2][0], "lon 20 right of lon 10");
});

test("coordinates stay within the canvas", () => {
  const svg = writeSvg([{ label: "t", lines: [pts([10, 10], [20, 30], [15, 5])] }]);
  const [, w, h] = /width="([\d.]+)" height="([\d.]+)"/.exec(svg).map(Number);
  for (const [x, y] of polyline(svg)) {
    assert.ok(x >= 0 && x <= w);
    assert.ok(y >= 0 && y <= h);
  }
});

test("geometry is fit and centred within the viewBox", () => {
  const svg = writeSvg([{ label: "t", lines: [pts([0, 0], [10, 0])] }], { padding: 0 }); // a vertical line
  const ys = polyline(svg).map(([, y]) => y);
  const xs = polyline(svg).map(([x]) => x);
  assert.ok(Math.min(...ys) === 0 && Math.max(...ys) === 720, "fills full height");
  assert.ok(
    xs.every((x) => x === 640),
    "centred horizontally at 1280/2",
  );
});

test("square markers render as rects", () => {
  const svg = writeSvg([{ label: "p", points: pts([0, 0]), shape: "square", size: 4 }]);
  assert.match(svg, /<rect [^>]*width="8" height="8"/);
  assert.doesNotMatch(svg, /<circle/);
});

test("color, width, opacity are hoisted onto the layer group", () => {
  const line = writeSvg([{ label: "l", lines: [pts([0, 0], [1, 1])], color: "red", width: 3 }]);
  assert.match(line, /<g id="layer-l" class="layer" fill="none" stroke="red" stroke-width="3">/);
  const dot = writeSvg([{ label: "d", points: pts([0, 0]), color: "blue", opacity: 0.5 }]);
  assert.match(dot, /<g id="layer-d" class="layer" fill="blue" opacity="0.5">/);
  assert.match(dot, /<circle cx="[\d.]+" cy="[\d.]+" r="2"\/>/); // bare child, no repeated fill
});

test("a paint-homogeneous layer leaves children bare", () => {
  const svg = writeSvg([{ label: "m", points: pts([0, 0], [1, 1]), color: "#c00" }]);
  assert.match(svg, /<g id="layer-m" class="layer" fill="#c00">/);
  assert.doesNotMatch(svg, /<circle[^>]*fill=/);
});

test("a mixed stroke+fill layer keeps attributes per-element", () => {
  const svg = writeSvg([
    { label: "x", lines: [pts([0, 0], [1, 1])], points: pts([0.5, 0.5]), color: "#06c" },
  ]);
  assert.match(svg, /<g id="layer-x" class="layer">/); // no paint on the group
  assert.match(svg, /<polyline [^>]*stroke="#06c"/);
  assert.match(svg, /<circle [^>]*fill="#06c"/);
});

test("polygon mode fills the shape via the hoisted group color", () => {
  const svg = writeSvg([
    { label: "area", lines: [pts([0, 0], [1, 0], [1, 1], [0, 1])], polygon: true, color: "#eee" },
  ]);
  assert.match(svg, /<g id="layer-area" class="layer" fill="#eee">/);
  assert.match(svg, /<polygon points="[^"]+"\/>/);
  assert.doesNotMatch(svg, /<polyline/);
});

test('labels render as <text> inside a class="label" group with font-size on the group', () => {
  const svg = writeSvg([{ label: "lifts", labels: [{ lat: 0, lon: 0, text: "Lift A" }] }]);
  assert.match(svg, /<g class="label" font-size="12"[^>]*>/);
  assert.match(svg, /<text x="[\d.]+" y="[\d.]+">Lift A<\/text>/);
  // size lives once on the group, not repeated on each text
  assert.doesNotMatch(svg, /<text[^>]*font-size=/);
});

test("label font-size and fill follow the layer", () => {
  const svg = writeSvg([
    { label: "x", color: "#333", fontSize: 20, labels: [{ lat: 0, lon: 0, text: "Hi" }] },
  ]);
  assert.match(svg, /<g class="label" font-size="20" fill="#333"/);
});

test("label text is XML-escaped", () => {
  const svg = writeSvg([{ label: "x", labels: [{ lat: 0, lon: 0, text: "A & <B>" }] }]);
  assert.match(svg, /<text [^>]*>A &amp; &lt;B&gt;<\/text>/);
});

test("no <style> tag is ever emitted", () => {
  const svg = writeSvg([{ label: "x", labels: [{ lat: 0, lon: 0, text: "Hi" }] }]);
  assert.doesNotMatch(svg, /<style/);
});

test("background option adds a rect", () => {
  const svg = writeSvg([{ label: "t", lines: [pts([0, 0], [1, 1])] }], { background: "#fff" });
  assert.match(svg, /<rect width="100%" height="100%" fill="#fff"\/>/);
});

test("no points yields an svg with no layers drawn", () => {
  const svg = writeSvg([{ label: "empty", lines: [] }]);
  assert.doesNotMatch(svg, /<polyline|<circle|<rect/);
});

test("empty layer list yields a minimal svg", () => {
  assert.match(writeSvg([]), /<svg[^>]*><\/svg>/);
});
