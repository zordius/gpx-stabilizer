import assert from "node:assert/strict";
import { test } from "node:test";
import { toSvg } from "../src/html.js";
import { svgToPng } from "../src/png.js";

test("toSvg standalone: fixed pixel size + inline non-scaling-stroke", () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ];
  const svg = toSvg([{ label: "t", lines: [pts], width: 1.5 }], {
    standalone: true,
    width: 640,
    height: 480,
  });
  assert.match(svg, /<svg [^>]*\bwidth="640" height="480"/);
  assert.match(svg, /<style>polyline,path,line\{vector-effect:non-scaling-stroke\}<\/style>/);
});

test("svgToPng: rasterizes a standalone SVG to PNG bytes", async () => {
  const svg = toSvg(
    [
      {
        label: "t",
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        size: 4,
      },
    ],
    {
      standalone: true,
      width: 64,
      height: 64,
    },
  );
  const png = await svgToPng(svg);
  assert.ok(png.length > 0);
  // PNG magic number: 89 50 4E 47
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});
