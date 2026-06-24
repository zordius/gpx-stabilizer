import assert from "node:assert/strict";
import { test } from "node:test";
import { toHtml, toLayers, withXY } from "../src/view.js";

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

test("toLayers: every point goes into one gps layer as a polyline", () => {
  const layers = toLayers(pts);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].label, "gps");
  assert.equal(layers[0].lines.length, 1); // one line...
  assert.equal(layers[0].lines[0].length, 3); // ...holding every point
  assert.equal(typeof layers[0].lines[0][0].x, "number"); // points carry x/y
});

test("toHtml: produces an HTML document with the gps layer (markers by default)", () => {
  const html = toHtml(pts);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<g id="layer-gps"/);
  assert.match(html, /<path d="M/); // no line width -> the track renders as markers
});
