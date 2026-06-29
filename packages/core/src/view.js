// Render adapter — turn GPS points into the Layer shapes html.js draws. Projection happens HERE
// (lat/lon → local-meter x/y, y flipped so north is up); html.js sizes/zooms via CSS. `toLayers`
// plots the raw points in one layer; `analyzedLayers` runs the pipeline and splits the result into
// a clean track plus per-reason drop markers.

import { analyze } from "./analyze.js";
import { toSvg, writeHtml } from "./html.js";
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
 * Build render layers from points — one "gps" layer whose `lines` holds the geometry. `points` is
 * either ONE track (`Point[]`) or SEVERAL segments/tracks (`Point[][]`); each track becomes its own
 * entry in `lines`, so a broken-up track draws as separate polylines (no line across the gap). All
 * tracks share ONE projection centre so they stay aligned in the chart. html.js draws a connected
 * line per segment when a line `width` is given, and/or markers (dots) when there's no line or a
 * point style (`pointColor`/`size`) is set. Points need `lat`/`lon`; their other fields ride along.
 * @param {Array<{ lat: number, lon: number }> | Array<Array<{ lat: number, lon: number }>>} points
 * @param {{ label?: string, color?: string, width?: number, pointColor?: string, size?: number, opacity?: number }} [opts]
 */
export function toLayers(points, opts = {}) {
  const tracks = Array.isArray(points[0]) ? points : [points];
  const xy = withXY(tracks.flat()); // shared projection centre across all tracks
  const lines = [];
  let k = 0;
  for (const t of tracks) {
    lines.push(xy.slice(k, k + t.length));
    k += t.length;
  }
  const layer = { label: opts.label ?? "gps", color: opts.color ?? "#06c", lines };
  for (const key of ["width", "pointColor", "size", "opacity"])
    if (opts[key] != null) layer[key] = opts[key];
  return [layer];
}

/**
 * Build a labels layer marking each line segment's head and tail: segment k (1-based, in the order
 * given) gets a "{k}s" label at its first point and "{k}e" at its last. Black text on its own layer —
 * append it LAST so it draws on top. Font size is in user units (`opts.fontSize`, default 12); it
 * scales with zoom, which is fine. Text is black at `opts.opacity` (default 0.8). Pass the SAME
 * `lines` a track layer draws (already projected).
 * @param {Array<Array<{ x: number, y: number }>>} lines
 * @param {{ label?: string, fontSize?: number, opacity?: number }} [opts]
 * @returns {object} a labels layer ({ label, color: "#000", fontSize, opacity, labels })
 */
export function segmentLabels(lines, opts = {}) {
  const labels = [];
  lines.forEach((seg, i) => {
    if (!seg.length) return;
    const head = seg[0];
    const tail = seg[seg.length - 1];
    labels.push({ x: head.x, y: head.y, text: `${i + 1}s` });
    labels.push({ x: tail.x, y: tail.y, text: `${i + 1}e` });
  });
  return {
    label: opts.label ?? "labels",
    color: "#000",
    fontSize: opts.fontSize ?? 12,
    opacity: opts.opacity ?? 0.8,
    labels,
  };
}

/** Convenience: render points straight to one HTML document (a single panel, a single layer). */
export function toHtml(points, opts = {}) {
  const title = opts.title ?? "GPX Stabilizer Viewer";
  return writeHtml([{ layers: toLayers(points, opts) }], { title });
}

/** analyze stores raw (south-down) y; flip it for north-up SVG, keeping every field. */
const flipY = (p) => ({ ...p, y: -p.y });

/**
 * Run the analysis pipeline and split the result into render layers: a faint `raw` line of every
 * input point (background reference), the clean track (kept points as a line), and a marker layer per
 * drop reason. The **direct** drops — `drift`, `stray`, `outlier`, `activity` — render **red**;
 * `badspan` (the derived glued-region decision) is **brown `#960`**. `despike` is now detection-only
 * (a SIGNAL, not a drop), so it is a **teal `#0c8` overlay** on every despike-flagged point (kept
 * unless its region was dense enough for badspan to glue it) — toggle it against badspan to see what
 * got glued. Plus two GPS-quality overlays (`hdop 2–3`, `hdop ≥3`). Each *dropped* point lands in
 * exactly ONE drop layer by priority drift > stray > outlier > activity > badspan (direct reasons
 * win). Every point already carries `x`/`y` (dropped ones too), so drops plot where they were.
 * The hdop overlays are independent of drop status (a kept point can still be flagged) and self-gate
 * to empty on a track with no `<hdop>`.
 * `opts` flows to `analyze` (e.g. `activities`, param overrides).
 * The clean track is split into separate polylines by `opts.breakLine(out) → runs`; the default
 * cuts it at every dropped point (a drop = a break, no line across the gap). This is the seam the
 * fuller `斷開` function (time/distance-gap cuts) plugs into.
 * @param {import("./measure.js").TrackPoint[]} points
 * @param {Parameters<typeof analyze>[1] & { breakLine?: (out: object[]) => object[][] }} [opts]
 */
export function analyzedLayers(points, opts = {}) {
  const out = analyze(points, opts);
  // a dropped point goes to its highest-priority reason's layer (so it isn't drawn twice)
  const droppedBy = (mod, not = []) =>
    out.filter((p) => p.dropReason?.[mod] && !not.some((m) => p.dropReason?.[m])).map(flipY);
  const dropLayer = (label, mod, not, color = "#c00") => ({
    label,
    color, // direct drops are red (#c00); detection/derived drops get their own colour (see below)
    size: 4,
    opacity: 0.7,
    points: droppedBy(mod, not),
  });
  // GPS-reported quality overlay (independent of drop status): mark every point whose device hdop
  // falls in a band, so a render shows where the receiver itself flagged low precision. Self-gating:
  // a track without `<hdop>` (e.g. FitoTrack) yields empty layers. The 99.99 sentinel (fix=none,
  // "no valid fix") is excluded — those points are already shown via the drift layer; capping at <99
  // keeps the `>=3` band to genuinely poor-but-valid fixes (real hdop tops out ~50).
  const hdopLayer = (label, lo, hi, color) => ({
    label,
    color,
    size: 3,
    opacity: 0.6,
    points: out.filter((p) => p.hdop != null && p.hdop >= lo && p.hdop < hi).map(flipY),
  });
  // default `斷開`: cut the clean line at every dropped point — accumulate kept points into a run,
  // and close the run whenever a drop interrupts it, so no line is drawn across a removed point.
  // opts.breakLine(out) can override with richer cut rules (time/distance gaps); it receives the
  // full ordered point list (drops included) and returns the runs of points to draw.
  const splitAtDrops = (pts) => {
    const runs = [];
    let cur = [];
    for (const p of pts) {
      if (p.dropReason) {
        if (cur.length) runs.push(cur);
        cur = [];
      } else {
        cur.push(p);
      }
    }
    if (cur.length) runs.push(cur);
    return runs;
  };
  const breakLine = opts.breakLine ?? splitAtDrops;
  const cleanLayer = {
    label: "clean",
    color: "#06c",
    width: 1.5,
    bbox: true, // the kept track alone sets the viewBox; drops/raw are drawn but don't grow the frame
    lines: breakLine(out).map((run) => run.map(flipY)),
  };
  // Layers render back-to-front: drops + kink first, then the raw track, then the clean line LAST so
  // it sits on top of raw. `out` is every point in order (drops included) → the full raw line.
  const layers = [
    dropLayer("drift", "drift", []),
    dropLayer("stray", "stray", ["drift"]),
    dropLayer("outlier drop", "outlier", ["drift", "stray"]),
    dropLayer("activity drop", "activity", ["drift", "stray", "outlier"]),
    // `badspan` is the glued-region decision (drops whole high-density garbage stretches) — a
    // DERIVED drop, so a distinct brown from the red direct drops. Lower priority than the direct
    // reasons, so a point with a direct drop still shows red.
    dropLayer("badspan (glue)", "badspan", ["drift", "stray", "outlier", "activity"], "#960"),
    // despike is detection-only now (a SIGNAL, not a drop) — teal OVERLAY on every despike-flagged
    // point (kept unless its region was dense enough for badspan to glue it). It feeds the bad-span
    // density; on its own it never drops a point. (Toggle it against badspan to see what got glued.)
    {
      label: "despike (flag)",
      color: "#0c8",
      size: 4,
      opacity: 0.7,
      points: out.filter((p) => p.despike?.flagged).map(flipY),
    },
    // hdop quality overlay: orange = moderately poor (2–3), purple = poor-but-valid (3–99)
    hdopLayer("hdop 2–3", 2, 3, "#f80"),
    hdopLayer("hdop ≥3", 3, 99, "#a0e"),
    // "garbage-zone" candidates the pipeline currently KEEPS: poor hdop (≥3) while big-picture
    // stationary (profile `paused` = net speed below NETSTAY). `paused` rides only on kept points, so
    // this layer is exactly the leaked stationary-noise — eyeball it before deciding to drop wholesale.
    {
      label: "hdop≥3 paused",
      color: "#d0006a",
      size: 4,
      opacity: 0.7,
      points: out
        .filter((p) => p.paused && p.hdop != null && p.hdop >= 3 && p.hdop < 99)
        .map(flipY),
    },
    // kink is a label, not a drop — yellow overlay on points that stay in the clean track
    {
      label: "kink",
      color: "#fc0",
      size: 4,
      opacity: 0.7,
      points: out.filter((p) => p.kink?.at).map(flipY),
    },
    { label: "raw", color: "#888", width: 1, opacity: 0.7, lines: [out.map(flipY)] },
    cleanLayer,
  ];
  // opts.labels → a black head/tail label per clean segment, on top (opts.labelSize sets font size)
  if (opts.labels) layers.push(segmentLabels(cleanLayer.lines, { fontSize: opts.labelSize }));
  return layers;
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

/**
 * One file's analysed view as a standalone SVG string (clean track + drop markers), sized for PNG
 * rasterization. `width`/`height` are the output pixels (default 1280×720); other `opts` flow to
 * `analyze`. Pair with png.js's `savePng` to write a PNG.
 * @param {import("./measure.js").TrackPoint[]} points
 * @param {Parameters<typeof analyze>[1] & { width?: number, height?: number }} [opts]
 */
export function analyzedSvg(points, opts = {}) {
  return toSvg(analyzedLayers(points, opts), {
    standalone: true,
    width: opts.width ?? 1280,
    height: opts.height ?? 720,
  });
}
