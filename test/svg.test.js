import assert from "node:assert/strict";
import { test } from "node:test";
import { writeSvg } from "../src/svg.js";

/** Extract the [x, y] pairs of the nth polyline. */
function polyline(svg, n = 0) {
  const all = [...svg.matchAll(/<polyline points="([^"]*)"/g)];
  if (!all[n]) return [];
  return all[n][1].split(" ").map((s) => s.split(",").map(Number));
}

const seg = (...latlon) => latlon.map(([lat, lon]) => ({ lat, lon, ele: null, time: null }));

test("valid svg root with xmlns and viewBox", () => {
  const svg = writeSvg({ segments: [seg([0, 0], [1, 1])], meta: {} });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /viewBox="0 0 [\d.]+ [\d.]+"/);
  assert.match(svg, /<\/svg>/);
});

test("one polyline per non-empty segment", () => {
  const svg = writeSvg({
    segments: [seg([0, 0], [1, 1]), [], seg([2, 2], [3, 3])],
    meta: {},
  });
  assert.equal([...svg.matchAll(/<polyline/g)].length, 2);
});

test("north is up: higher lat maps to smaller y", () => {
  const p = polyline(writeSvg({ segments: [seg([10, 0], [20, 0])], meta: {} }));
  assert.ok(p[1][1] < p[0][1], "lat 20 should be above lat 10");
});

test("east is right: higher lon maps to larger x", () => {
  const p = polyline(writeSvg({ segments: [seg([0, 10], [0, 20])], meta: {} }));
  assert.ok(p[1][0] > p[0][0], "lon 20 should be right of lon 10");
});

test("coordinates stay within the canvas", () => {
  const svg = writeSvg({ segments: [seg([10, 10], [20, 30], [15, 5])], meta: {} });
  const [, w, h] = /width="([\d.]+)" height="([\d.]+)"/.exec(svg).map(Number);
  for (const [x, y] of polyline(svg)) {
    assert.ok(x >= 0 && x <= w, `x ${x} within 0..${w}`);
    assert.ok(y >= 0 && y <= h, `y ${y} within 0..${h}`);
  }
});

test("respects the size option (largest dimension fits)", () => {
  const svg = writeSvg({ segments: [seg([0, 0], [10, 5])], meta: {} }, { size: 400, padding: 0 });
  const [w, h] = [/width="([\d.]+)"/, /height="([\d.]+)"/].map((re) => Number(re.exec(svg)[1]));
  assert.equal(Math.max(w, h), 400);
});

test("background option adds a rect", () => {
  const svg = writeSvg({ segments: [seg([0, 0], [1, 1])], meta: {} }, { background: "#fff" });
  assert.match(svg, /<rect width="100%" height="100%" fill="#fff"\/>/);
  assert.doesNotMatch(writeSvg({ segments: [seg([0, 0], [1, 1])], meta: {} }), /<rect/);
});

test("stroke options are applied", () => {
  const svg = writeSvg(
    { segments: [seg([0, 0], [1, 1])], meta: {} },
    {
      stroke: "red",
      strokeWidth: 3,
    },
  );
  assert.match(svg, /stroke="red" stroke-width="3"/);
});

test("empty track yields an svg with no polyline", () => {
  const svg = writeSvg({ segments: [], meta: {} });
  assert.match(svg, /<svg[^>]*><\/svg>/);
  assert.doesNotMatch(svg, /<polyline/);
});

test("single point does not crash and stays in bounds", () => {
  const svg = writeSvg({ segments: [seg([45, 9])], meta: {} });
  assert.match(svg, /<polyline points="[\d.]+,[\d.]+"/);
});
