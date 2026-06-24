import { writeFileSync } from "node:fs";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Round to 2 decimals for compact output. */
function round(n) {
  return Math.round(n * 100) / 100;
}

/** XML-encode text for attribute/markup safety. */
function enc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Render a parsed track as an SVG string: a top-down, north-up view with one polyline per
 * segment. Pure geometry, zero dependencies — meant for eyeballing results in a browser.
 *
 * Uses a local equirectangular projection (longitude compressed by cos(lat)) and scales the
 * data to fit `size` while preserving aspect ratio.
 *
 * @param {import("./gpx.js").Track} track
 * @param {{ size?: number, padding?: number, stroke?: string, strokeWidth?: number, background?: string }} [opts]
 * @returns {string}
 */
export function writeSvg(track, opts = {}) {
  const { segments = [] } = track ?? {};
  const size = opts.size ?? 800;
  const pad = opts.padding ?? 16;
  const stroke = opts.stroke ?? "#0a6";
  const strokeWidth = opts.strokeWidth ?? 1.5;
  const background = opts.background ?? null;

  const pts = segments.flat();
  if (pts.length === 0) {
    const d = pad * 2;
    return `<svg xmlns="${SVG_NS}" width="${d}" height="${d}" viewBox="0 0 ${d} ${d}"></svg>\n`;
  }

  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  const kx = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const minX = minLon * kx;
  const dataW = maxLon * kx - minX;
  const dataH = maxLat - minLat;
  const extent = Math.max(dataW, dataH);
  const scale = extent > 0 ? (size - 2 * pad) / extent : 1;
  const width = round(dataW * scale + 2 * pad);
  const height = round(dataH * scale + 2 * pad);
  const sx = (lon) => round(pad + (lon * kx - minX) * scale);
  const sy = (lat) => round(pad + (maxLat - lat) * scale); // flip so north is up

  const out = [
    `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  ];
  if (background) out.push(`  <rect width="100%" height="100%" fill="${enc(background)}"/>`);
  for (const seg of segments) {
    if (seg.length === 0) continue;
    const points = seg.map((p) => `${sx(p.lon)},${sy(p.lat)}`).join(" ");
    out.push(
      `  <polyline points="${points}" fill="none" stroke="${enc(stroke)}" stroke-width="${strokeWidth}"/>`,
    );
  }
  out.push("</svg>", "");
  return out.join("\n");
}

/**
 * Render a parsed track to an SVG file.
 * @param {import("./gpx.js").Track} track
 * @param {string} path
 * @param {Parameters<typeof writeSvg>[1]} [opts]
 */
export function saveSvg(track, path, opts) {
  writeFileSync(path, writeSvg(track, opts));
}
