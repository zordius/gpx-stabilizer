// PNG output via @resvg/resvg-js — an OPTIONAL dev tool, NOT a runtime dependency. It is imported
// dynamically so the core stays zero-dependency; if the package isn't installed the call throws a
// clear "install it" message rather than crashing at import time. Feed it a standalone SVG string
// (toSvg(..., { standalone: true })), which carries its own pixel size and non-scaling-stroke.

import { writeFileSync } from "node:fs";

/**
 * Rasterize a standalone SVG string to a PNG. The SVG's own `width`/`height` set the pixel size.
 * @param {string} svg  a self-contained SVG (use toSvg with `standalone: true`)
 * @returns {Promise<Buffer>} the PNG bytes
 */
export async function svgToPng(svg) {
  let resvg;
  try {
    resvg = await import("@resvg/resvg-js");
  } catch {
    throw new Error("PNG output needs @resvg/resvg-js — install it: npm i -D @resvg/resvg-js");
  }
  return new resvg.Resvg(svg).render().asPng();
}

/**
 * Rasterize a standalone SVG and write it to a PNG file.
 * @param {string} svg
 * @param {string} path
 */
export async function savePng(svg, path) {
  writeFileSync(path, await svgToPng(svg));
}
