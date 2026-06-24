// Render adapter — turn GPS points into the Layer shapes html.js draws. Projection happens HERE
// (lat/lon → local-meter x/y, SVG y-down so north is up); html.js then plots x/y directly and a
// top-level <g> transform zooms to fit. Basic version: every input point in one "gps" track layer.
// (Future: split by dropReason, colour kept vs. dropped, mark outliers, etc.)

import { writeHtml } from "./html.js";
import { project } from "./measure.js";

/**
 * Enrich each point with SVG `x`/`y` (local meters, north up) while keeping its original fields.
 * Reuses measure.js's projection over all points (none excluded), then flips y so north points up
 * in SVG coordinates. Returns new point objects; inputs are not mutated.
 * @param {Array<{ lat: number, lon: number }>} points
 * @returns {Array<object>} the same points, each with `x`/`y` added
 */
export function withXY(points) {
  const { xAll, yAll } = project(
    points,
    points.map((_, i) => i),
  );
  return points.map((p, i) => ({ ...p, x: xAll[i], y: -yAll[i] })); // SVG y-down → north up
}

/**
 * Build render layers from a point array — one "gps" layer holding every (projected) point. The
 * geometry goes in `lines`; html.js draws a connected line when a line `width` is given, and/or
 * markers (dots) when there's no line or a point style (`pointColor`/`size`) is set. Points need
 * `lat`/`lon`; their other fields ride along.
 * @param {Array<{ lat: number, lon: number }>} points
 * @param {{ label?: string, color?: string, width?: number, pointColor?: string, size?: number, opacity?: number }} [opts]
 */
export function toLayers(points, opts = {}) {
  const layer = {
    label: opts.label ?? "gps",
    color: opts.color ?? "#06c",
    lines: [withXY(points)],
  };
  for (const k of ["width", "pointColor", "size", "opacity"])
    if (opts[k] != null) layer[k] = opts[k];
  return [layer];
}

/** Convenience: render points straight to one HTML document (a single panel, a single layer). */
export function toHtml(points, opts = {}) {
  const title = opts.title ?? "GPX Stabilizer Viewer";
  return writeHtml([{ layers: toLayers(points, opts) }], { title });
}

/** Min/max of an array via reduce (avoids spread-arg limits on long tracks). */
function minMax(nums) {
  return nums.reduce(([lo, hi], v) => [Math.min(lo, v), Math.max(hi, v)], [Infinity, -Infinity]);
}

/** Epoch ms → "YYYY-MM-DD HH:MM" (UTC). */
function fmtTime(ms) {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

/** Duration in ms → "Hh Mm" (or "Mm" under an hour). */
function fmtDur(ms) {
  const min = Math.round(ms / 60000);
  const h = Math.floor(min / 60);
  return h > 0 ? `${h}h ${min % 60}m` : `${min}m`;
}

/**
 * One-line summary for the document header: file count, overall start–end, and total recorded time
 * (sum of each track's own first→last span). Files with no timestamps contribute only to the count.
 * @param {Array<{ name: string, points: Array<{ time?: number | null }> }>} files
 * @returns {string}
 */
function summarize(files) {
  const n = files.length;
  const label = `${n} GPX file${n === 1 ? "" : "s"}`;
  const spans = files
    .map((f) => f.points.map((p) => p.time).filter((t) => t != null))
    .filter((ts) => ts.length > 0)
    .map((ts) => minMax(ts));
  if (spans.length === 0) return label;
  const start = Math.min(...spans.map(([a]) => a));
  const end = Math.max(...spans.map(([, b]) => b));
  const total = spans.reduce((s, [a, b]) => s + (b - a), 0);
  return `${label} · ${fmtTime(start)} – ${fmtTime(end)} · total ${fmtDur(total)}`;
}

/**
 * Render several GPS tracks into one HTML document — one scrolling panel per file, each titled with
 * its file name and preceded by a summary `<p>` (count, start–end, total time). Layer styling opts
 * (`color`/`width`/`pointColor`/`size`/`opacity`) apply to every panel.
 * @param {Array<{ name: string, points: Array<{ lat: number, lon: number }> }>} files
 * @param {{ title?: string, heading?: string, label?: string, color?: string, width?: number, pointColor?: string, size?: number, opacity?: number }} [opts]
 */
export function toHtmlFiles(files, opts = {}) {
  const panels = files.map((f) => ({ title: f.name, layers: toLayers(f.points, opts) }));
  return writeHtml(panels, {
    title: opts.title ?? "GPX Stabilizer",
    heading: opts.heading ?? "GPX Stabilizer",
    summary: summarize(files),
  });
}
