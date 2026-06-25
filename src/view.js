// Render adapter — turn GPS points into the Layer shapes html.js draws. Projection happens HERE
// (lat/lon → local-meter x/y, y flipped so north is up); html.js sizes/zooms via CSS. `toLayers`
// plots the raw points in one layer; `analyzedLayers` runs the pipeline and splits the result into
// a clean track plus per-reason drop markers.

import { analyze } from "./analyze.js";
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

/** analyze stores raw (south-down) y; flip it for north-up SVG, keeping every field. */
const flipY = (p) => ({ ...p, y: -p.y });

/**
 * Run the analysis pipeline and split the result into render layers: the clean track (kept points as
 * a line) plus one marker layer per drop reason — `drift`, `outlier`, `activity`. All drops render
 * the same (red circles, 0.7 opacity); the separate layers exist only for the legend's per-reason
 * count + toggle. Each dropped point lands in exactly ONE layer by priority drift > outlier >
 * activity. Every point already carries `x`/`y` (dropped ones too), so drops plot where they were.
 * `opts` flows to `analyze` (e.g. `activities`, param overrides).
 * @param {import("./measure.js").TrackPoint[]} points
 * @param {Parameters<typeof analyze>[1]} [opts]
 */
export function analyzedLayers(points, opts = {}) {
  const out = analyze(points, opts);
  // a dropped point goes to its highest-priority reason's layer (so it isn't drawn twice)
  const droppedBy = (mod, not = []) =>
    out.filter((p) => p.dropReason?.[mod] && !not.some((m) => p.dropReason?.[m])).map(flipY);
  const dropLayer = (label, mod, not) => ({
    label,
    color: "#c00",
    size: 4,
    opacity: 0.7,
    points: droppedBy(mod, not),
  });
  return [
    {
      label: "clean",
      color: "#06c",
      width: 1.5,
      lines: [out.filter((p) => !p.dropReason).map(flipY)],
    },
    dropLayer("drift", "drift", []),
    dropLayer("outlier drop", "outlier", ["drift"]),
    dropLayer("activity drop", "activity", ["drift", "outlier"]),
  ];
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

/**
 * Like `toHtmlFiles`, but each panel shows the analysed result — the clean track plus drop markers
 * via `analyzedLayers`. `opts` flows to `analyze`.
 * @param {Array<{ name: string, points: import("./measure.js").TrackPoint[] }>} files
 * @param {Parameters<typeof analyze>[1] & { title?: string, heading?: string }} [opts]
 */
export function toHtmlAnalyzedFiles(files, opts = {}) {
  const panels = files.map((f) => ({ title: f.name, layers: analyzedLayers(f.points, opts) }));
  return writeHtml(panels, {
    title: opts.title ?? "GPX Stabilizer",
    heading: opts.heading ?? "GPX Stabilizer — analyzed",
    summary: summarize(files),
  });
}
