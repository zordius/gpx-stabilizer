// Render adapter — turn GPS points into the Layer shapes html.js draws. Projection happens HERE
// (lat/lon → local-meter x/y, y flipped so north is up); html.js sizes/zooms via CSS. `toLayers`
// plots the raw points in one layer; `analyzedLayers` runs the pipeline and splits the result into
// a clean track plus per-reason drop markers.

import { analyze, isQualityDropped } from "./analyze.js";
import { toSvg, writeHtml } from "./html.js";
import { project, projectTo } from "./measure.js";
import { stabilize } from "./stabilize.js";

/**
 * Enrich each point with SVG `x`/`y` (local meters, north up) while keeping its original fields.
 * Reuses measure.js's projection over all points (none excluded), then flips y so north points up
 * in SVG coordinates. Returns new point objects; inputs are not mutated. The returned array also
 * carries `.origin` (`{ lat0, lon0 }`, the projection centre) — an extra property, not an element —
 * so a caller can pass it on to `toSvg` (embedded as `data-lat0`/`data-lon0` for the viewer's
 * click-to-show-coordinates feature) without changing the array's shape for existing consumers.
 * @param {Array<{ lat: number, lon: number }>} points
 * @returns {Array<object>} the same points, each with `x`/`y` added
 */
export function withXY(points) {
  const { xAll, yAll, lat0, lon0 } = project(
    points,
    points.map((_, i) => i),
  );
  const out = points.map((p, i) => ({ ...p, x: xAll[i], y: -yAll[i] })); // SVG y-down → north up
  out.origin = { lat0, lon0 };
  return out;
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
  const result = [layer];
  result.origin = xy.origin; // see withXY's doc — carried through for toHtml/toHtmlFiles
  return result;
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
  const layers = toLayers(points, opts);
  return writeHtml([{ layers, opts: { origin: layers.origin } }], { title });
}

/** analyze stores raw (south-down) y; flip it for north-up SVG, keeping every field. */
const flipY = (p) => ({ ...p, y: -p.y });

/** Split a time-ordered point array into runs, breaking wherever consecutive points are more than
 * `maxGapMs` apart — the shared `斷開` rule for anything derived from `stabilize()`'s export (which
 * carries no `dropReason` of its own to break on, unlike `analyze()`'s own kept points). */
function splitByGap(points, maxGapMs) {
  const runs = [];
  let cur = [];
  for (const p of points) {
    if (cur.length && p.time - cur[cur.length - 1].time > maxGapMs) {
      runs.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) runs.push(cur);
  return runs;
}

/**
 * Run the analysis pipeline and split the result into render layers: a faint `raw` line of every
 * input point (background reference), the clean track (kept points as a line), and a marker layer per
 * drop reason. The **direct** drops — `drift`, `stray`, `outlier`, `activity`, `fixQuality` — render
 * **red**; `badspan` (the derived glued-region decision) is **brown `#960`**. `despike` is now
 * detection-only (a SIGNAL, not a drop), so it is a **teal `#0c8` overlay** on every despike-flagged
 * point (kept unless its region was dense enough for badspan to glue it) — toggle it against badspan
 * to see what got glued. Plus two hdop GPS-quality overlays (`hdop 2–3`, `hdop ≥3`) — `fixQuality`'s
 * own signal (non-3D `fix`) is a core builtin now (2026-07-08), so it always shows as a real drop
 * layer rather than a separate independent-of-drop-status overlay. Each *dropped* point lands in
 * exactly ONE drop layer by priority drift > stray > outlier > activity > fixQuality > badspan
 * (direct reasons win). Every point already carries `x`/`y` (dropped ones too), so drops plot where
 * they were. The hdop overlays are independent of drop status (a kept point can still be flagged) and
 * self-gate to empty on a track with no `<hdop>`.
 * `opts` flows to `analyze` (e.g. `activities`, param overrides).
 * The clean track is split into separate polylines by `opts.breakLine(out) → runs`; the default
 * cuts it at every dropped point (a drop = a break, no line across the gap). This is the seam the
 * fuller `斷開` function (time/distance-gap cuts) plugs into.
 *
 * **`stabilized` line — ON BY DEFAULT** (`opts.stabilized: false` to turn it off): the actual
 * `stabilize(points, opts)` export (same `opts`, so `smooth`/`gradeBound`/`liftSnap` all apply
 * exactly as they would to the real shipped output) — NOT the same thing as `clean` above. `clean`
 * is `analyze()`'s own kept points at their analysis-time position; a survivor-repositioning module
 * (`liftSnap`) never touches that position, only the separate `point.liftSnap` signal
 * `stabilize()`'s export step reads. So for a ski-mode track with confirmed lift runs, `clean` and
 * `stabilized` diverge exactly where liftSnap moved something — seeing that divergence is the whole
 * point of this layer, so it defaults on rather than needing to be remembered. Projected
 * onto the SAME origin as everything else (`projectTo`, not a second `analyze()`/`project()` call,
 * which would each pick their own centre and silently shift one layer relative to the other). Broken
 * into runs at a `opts.stabilizedMaxGap`-second time gap (default 10, matching `resample.js`'s own
 * default) rather than one straight line across a dropped stretch.
 * @param {import("./measure.js").TrackPoint[]} points
 * @param {Parameters<typeof analyze>[1] & { breakLine?: (out: object[]) => object[][], stabilized?: boolean, stabilizedMaxGap?: number }} [opts]
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
  // "no valid fix") is excluded — those points now show via the "fix≠3d drop" layer instead (see
  // fixQuality.js); capping at <99 keeps the `>=3` band to genuinely poor-but-valid fixes (real hdop
  // tops out ~50).
  const hdopLayer = (label, lo, hi, color) => ({
    label,
    color,
    size: 3,
    opacity: 0.6,
    points: out.filter((p) => p.hdop != null && p.hdop >= lo && p.hdop < hi).map(flipY),
  });
  // default `斷開`: cut the clean line at every QUALITY-dropped point — accumulate kept points
  // into a run, and close the run whenever a real gap interrupts it, so no line is drawn across a
  // removed point. A POLICY-only drop (oversample/noTime) is not a real gap — it's a thinned-out
  // duplicate of essentially the same trajectory — so it's skipped rather than breaking the run;
  // without this, a source with a high native sample rate (e.g. a Hero10's raw ~10 Hz GPS5) has an
  // oversample-dropped point between nearly every survivor, shattering the clean line into
  // one-point runs (each drawn as a lone `M`, invisible — see docs/gpmf-sensors.md's badspan
  // dilution finding for the same-shaped bug in analyze.js's glueBadSpans, 2026-07-05).
  //
  // ALSO cut on a plain TIME gap between two consecutive kept points, even when NEITHER carries a
  // dropReason (2026-07-09): a source recording gap (e.g. a GPS dropout inside a GoPro clip, which
  // shows up as a genuine `<trkseg>` boundary once `readGpx` sees it — see `stabilizeTrack`'s own
  // doc) can leave a real multi-second/minute hole with no dropped point marking it at all — nothing
  // was measured there to drop. Without this check `clean` drew a single straight line across such a
  // hole while `stabilized`'s own `splitByGap` correctly broke there, an inconsistency found by eye:
  // the two lines diverging made `stabilized`'s break visible where it overlaid `clean`. Same
  // threshold/param as `stabilized` (`opts.stabilizedMaxGap`, default 10 s) so the two stay aligned.
  // opts.breakLine(out) can override with richer cut rules (e.g. distance gaps); it receives the
  // full ordered point list (drops included) and returns the runs of points to draw.
  const cleanMaxGapMs = (opts.stabilizedMaxGap ?? 10) * 1000;
  const splitAtDrops = (pts) => {
    const runs = [];
    let cur = [];
    for (const p of pts) {
      if (!p.dropReason) {
        if (cur.length && p.time - cur[cur.length - 1].time > cleanMaxGapMs) {
          runs.push(cur);
          cur = [];
        }
        cur.push(p);
      } else if (isQualityDropped(p)) {
        if (cur.length) runs.push(cur);
        cur = [];
      }
      // else: policy-only drop — skip the point, but don't break the run
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
    // fixQuality (core builtin, 2026-07-08): the GPS chip's own reported fix isn't a full 3D lock
    // (2d, or none — e.g. a pre-lock cold-start run). A direct drop like the others above, so red.
    dropLayer("fix≠3d drop", "fixQuality", ["drift", "stray", "outlier", "activity"]),
    // `badspan` is the glued-region decision (drops whole high-density garbage stretches) — a
    // DERIVED drop, so a distinct brown from the red direct drops. Lower priority than the direct
    // reasons, so a point with a direct drop still shows red.
    dropLayer(
      "badspan (glue)",
      "badspan",
      ["drift", "stray", "outlier", "activity", "fixQuality"],
      "#960",
    ),
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
    // liftBoardingEle-touched points (mods/liftBoardingEle.js — self-gates to empty when that
    // module wasn't loaded, e.g. outside ski mode): every point ANY of its three mechanisms wrote
    // to. All three now DROP rather than correct (`ele: null` — see that module's doc), so presence
    // of the field, not a non-null `ele`, is the marker; they all write the same namespaced field, so
    // this layer doesn't distinguish which mechanism fired.
    {
      label: "liftBoardingEle fix",
      color: "#0cf",
      size: 3,
      opacity: 0.7,
      points: out.filter((p) => p.liftBoardingEle != null).map(flipY),
    },
    // the first/last point of every segment.type==="lift" run — lets a render confirm where the
    // pipeline itself thinks a lift starts and ends, independent of liftConfirm's own verdict.
    {
      label: "lift start/end",
      color: "#f0c",
      size: 5,
      opacity: 0.8,
      points: (() => {
        // scan the KEPT track only — a dropped point in the middle of a lift run has no `.segment`
        // (segment.js labels kept points only), so scanning raw `out` would break the run at every
        // drop and re-open it right after, pushing a spurious (start,start) duplicate each time.
        const kept = out.filter((p) => !p.dropReason);
        const boundaries = [];
        let i = 0;
        while (i < kept.length) {
          if (kept[i].segment?.type !== "lift") {
            i++;
            continue;
          }
          const startIdx = i;
          const id = kept[i].segment.id;
          while (i < kept.length && kept[i].segment?.type === "lift" && kept[i].segment?.id === id) i++;
          boundaries.push(kept[startIdx], kept[i - 1]);
        }
        return boundaries.map(flipY);
      })(),
    },
    { label: "raw", color: "#888", width: 1, opacity: 0.7, lines: [out.map(flipY)] },
    cleanLayer,
  ];
  // the real stabilize() export, on top of clean, so a liftSnap-repositioned (or smooth/gradeBound-
  // rewritten) run visibly diverges from its own analysis-time position — ON by default, opt out
  // via opts.stabilized: false. stabilize()'s output carries no dropReason (already filtered away),
  // so — same `斷開` concern as the clean line's own splitAtDrops — break at a time gap
  // (opts.stabilizedMaxGap, default 10 s, matching resample.js's own maxGap default) rather than
  // drawing one straight line across a dropped stretch.
  if (opts.stabilized !== false) {
    const { lat0, lon0 } = out.origin;
    const shipped = stabilize(points, opts).map((p) => {
      const { x, y } = projectTo(p.lat, p.lon, lat0, lon0);
      return flipY({ ...p, x, y });
    });
    const runs = splitByGap(shipped, (opts.stabilizedMaxGap ?? 10) * 1000);
    layers.push({ label: "stabilized", color: "#0a0", width: 1.5, lines: runs });
  }
  // opts.labels → a black head/tail label per clean segment, on top (opts.labelSize sets font size)
  if (opts.labels) layers.push(segmentLabels(cleanLayer.lines, { fontSize: opts.labelSize }));
  layers.origin = out.origin; // see withXY's doc — carried through for toHtmlAnalyzedFiles/analyzedSvg
  return layers;
}

const ELE_TICK_M = 100; // elevation gridline/label spacing (metres)
const TIME_TICK_MS = 10 * 60 * 1000; // time gridline/label spacing (10 minutes)

const RAW_DOT_PX = 1; // red raw-point marker diameter
const LINE_PX = 1; // stabilized elevation line width
const LABEL_CHAR_PX = 10; // rough per-character width at the tick font-size, for label-skip spacing
const STAB_COLOR = "#0a0"; // stabilized line, outside any lift segment
const LIFT_COLOR = "#06f"; // stabilized line, inside a segment.type === "lift" run

/**
 * Split a run of consecutive points into contiguous same-`flag(p)` sub-runs, each carrying the
 * transition point on BOTH sides of the split (so adjacent sub-runs still share an endpoint and the
 * drawn line stays visually continuous across a color change instead of gapping).
 */
function splitByFlag(run, flag) {
  if (run.length === 0) return [];
  const segs = [];
  let curFlag = flag(run[0]);
  let cur = [run[0]];
  for (let i = 1; i < run.length; i++) {
    const f = flag(run[i]);
    cur.push(run[i]);
    if (f !== curFlag) {
      segs.push({ flag: curFlag, pts: cur });
      cur = [run[i]];
      curFlag = f;
    }
  }
  segs.push({ flag: curFlag, pts: cur });
  return segs;
}

/** Min/max of an array via reduce (avoids spread-arg limits on long tracks). */
function minMax(nums) {
  return nums.reduce(([lo, hi], v) => [Math.min(lo, v), Math.max(hi, v)], [Infinity, -Infinity]);
}

/**
 * A time-vs-elevation chart (own coordinate system, independent of the map's lat/lon projection) of
 * the real `stabilize(points, opts)` export's elevation — the same series the "stabilized" map layer
 * draws, just plotted against time instead of position — as a thin green line (blue wherever
 * `segment.type === "lift"`), with every RAW input
 * point (unfiltered, so a dropped/despiked point still shows) plotted underneath as small red dots,
 * so the cleaned line's effect is visible against the noise it replaced. The line is broken into
 * separate polylines at any `opts.stabilizedMaxGap`-second time gap (`splitByGap`, the same rule the
 * "stabilized" map layer uses), so a stretch the pipeline dropped shows as a visible break rather
 * than a straight bridge across the missing time. The TIME axis domain covers whichever of the raw
 * or stabilized series is wider, so neither ever clips off-canvas; the ELEVATION axis domain is the
 * stabilized series only, so a despiked-away raw outlier can't compress the scale (a raw dot outside
 * that range is clipped rather than widening it). Gridlines every `ELE_TICK_M` (100 m)
 * on elevation and every `TIME_TICK_MS` (10 min, aligned to the clock, e.g. :00/:10/:20…) on time;
 * time tick LABELS (not the gridlines) skip enough of those ticks to stay legible when the span is
 * long enough that every-10-min labels would overlap.
 *
 * Renders as its own full-viewport `<section>` (html.js's `Panel.chart`), one per panel, alternating
 * panel → chart → panel → chart — NOT an overlay on the map. Sized the same way as a map `<svg>`
 * (`section > svg { width:100vw; height:100vh }`, already in html.js's stylesheet) with
 * `preserveAspectRatio="xMidYMid meet"` (like `toSvg`'s own root element) so it scales UNIFORMLY —
 * unlike the map, this chart's own x/y (time/elevation) don't share a real-world unit that needs
 * preserving, but "none" stretching would distort the tick text/gridlines non-uniformly, so `meet`
 * (with some letterboxing when the viewport's aspect ratio doesn't match the chosen internal one) is
 * still the right choice here too.
 * @param {import("./measure.js").TrackPoint[]} points
 * @param {Parameters<typeof analyze>[1] & { stabilizedMaxGap?: number }} [opts]
 * @param {{ width?: number, height?: number }} [size]  the SVG's internal viewBox units
 * @returns {{ svg: string, total: number, kept: number, t0: number, t1: number } | null}  `svg` is a
 *   `class="elev-chart"` string; `total`/`kept` are point counts (for a caller-built title, e.g.
 *   `toHtmlAnalyzedFiles`'s `chartTitle`); null when there's nothing to draw
 */
export function elevationChartSvg(points, opts = {}, size = {}) {
  const shipped = stabilize(points, opts).filter((p) => Number.isFinite(p.ele) && p.time != null);
  if (shipped.length < 2) return null;
  const raw = points.filter((p) => Number.isFinite(p.ele) && p.time != null);
  const runs = splitByGap(shipped, (opts.stabilizedMaxGap ?? 10) * 1000);
  // segment.type === "lift" runs, for coloring the stabilized line — a separate `analyze()` pass
  // (stabilize() doesn't carry `segment` into its own {lat,lon,ele,time} output) over the same points,
  // so it sees the identical drop set (segment/liftConfirm aren't affected by the smooth/gradeBound
  // compute modules stabilize() may add on top).
  const liftTimes = new Set(
    analyze(points, opts)
      .filter((p) => !p.dropReason && p.segment?.type === "lift")
      .map((p) => p.time),
  );
  const isLift = (p) => liftTimes.has(p.time);

  // elevation domain is the STABILIZED (kept/adjusted) series only — a despiked-away raw outlier must
  // not compress the scale the stabilized line is read against.
  const [eleMin, eleMax] = minMax(shipped.map((p) => p.ele));
  const [t0S, t1S] = [shipped[0].time, shipped.at(-1).time];
  const [t0R, t1R] = minMax(raw.map((p) => p.time));
  const t0 = Math.min(t0S, t0R);
  const t1 = Math.max(t1S, t1R);
  const w = size.width ?? 1200;
  const h = size.height ?? 500;
  const padL = 70; // room for elevation tick labels
  const padR = 20;
  const padT = 20;
  const padB = 50; // room for time tick labels
  const eleSpan = Math.max(eleMax - eleMin, 1e-6);
  const tSpan = Math.max(t1 - t0, 1);
  const sx = (t) => padL + ((t - t0) / tSpan) * (w - padL - padR);
  const sy = (ele) => h - padB - ((ele - eleMin) / eleSpan) * (h - padT - padB); // higher ele -> higher on screen

  const parts = [`<rect x="0" y="0" width="${w}" height="${h}" fill="#fff" stroke="#000"/>`];

  for (let e = Math.ceil(eleMin / ELE_TICK_M) * ELE_TICK_M; e <= eleMax; e += ELE_TICK_M) {
    const y = sy(e).toFixed(1);
    parts.push(
      `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="#ccc" stroke-width="1"/>`,
      `<text x="${padL - 8}" y="${y}" font-size="18" text-anchor="end" dominant-baseline="middle">${e}m</text>`,
    );
  }
  // gridlines stay at every TIME_TICK_MS, but labels skip enough ticks to stay legible: estimate how
  // many ticks fit in the available width before "HH:MM" labels (5 chars) would start overlapping.
  const availW = w - padL - padR;
  const numTicks = Math.floor((t1 - t0) / TIME_TICK_MS) + 1;
  const pxPerTick = availW / Math.max(1, numTicks - 1);
  const labelStep = Math.max(1, Math.ceil((5 * LABEL_CHAR_PX) / Math.max(1, pxPerTick)));
  let tickIdx = 0;
  for (let t = Math.ceil(t0 / TIME_TICK_MS) * TIME_TICK_MS; t <= t1; t += TIME_TICK_MS, tickIdx++) {
    const x = sx(t).toFixed(1);
    parts.push(
      `<line x1="${x}" y1="${padT}" x2="${x}" y2="${h - padB}" stroke="#ccc" stroke-width="1"/>`,
    );
    if (tickIdx % labelStep === 0) {
      parts.push(
        `<text x="${x}" y="${h - padB + 20}" font-size="18" text-anchor="middle">${fmtTime(t).slice(-5)}</text>`,
      );
    }
  }

  // raw points (unfiltered — a dropped/despiked point still shows) as small red dots, UNDER the line
  const rawD = raw.map((p) => `M${sx(p.time).toFixed(1)},${sy(p.ele).toFixed(1)} h0`).join(" ");
  parts.push(
    `<path d="${rawD}" stroke="#f00" stroke-width="${RAW_DOT_PX}" stroke-linecap="round"/>`,
  );

  for (const run of runs) {
    for (const seg of splitByFlag(run, isLift)) {
      if (seg.pts.length < 2) continue; // a lone point can't draw a line segment
      const d = `M${seg.pts.map((p) => `${sx(p.time).toFixed(1)},${sy(p.ele).toFixed(1)}`).join(" ")}`;
      const color = seg.flag ? LIFT_COLOR : STAB_COLOR;
      parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${LINE_PX}"/>`);
    }
  }
  return {
    svg: `<svg class="elev-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">${parts.join("")}</svg>`,
    total: points.length,
    kept: shipped.length,
    t0: t0R, // the file's own raw time range (matches the page-level summarize()'s own convention),
    t1: t1R, // not just the kept/shipped subset — a dropped stretch still had a real timestamp
  };
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
  const panels = files.map((f) => {
    const layers = toLayers(f.points, opts);
    return { title: f.name, layers, opts: { origin: layers.origin } };
  });
  return writeHtml(panels, {
    title: opts.title ?? "GPX Stabilizer",
    heading: opts.heading ?? "GPX Stabilizer",
    summary: summarize(files),
  });
}

/**
 * Like `toHtmlFiles`, but each panel shows the analysed result — the clean track plus drop markers
 * via `analyzedLayers`. `opts` flows to `analyze`. Each panel is also followed by its own
 * `elevationChartSvg` chart section (see that function's doc) — same opt-out as the "stabilized" map
 * layer it's derived from (`opts.stabilized: false` skips both). The chart section gets its own
 * title (file name · raw time range · deleted/total point count), built from `elevationChartSvg`'s
 * returned counts.
 *
 * `opts.onProgress`, if given, is called twice per file — `{ name, index, total, phase: "start" }`
 * just before that file's (potentially slow — full analyze() + every ski-mode module) processing
 * begins, then `{ ..., phase: "done", ms }` right after — so a caller with many/large files (e.g.
 * the CLI's `--html`, one synchronous call with no other progress signal) can report progress. Never
 * reaches `analyze()` itself (stripped before `rest` is built), so it can't leak into `ctx.g`.
 * @param {Array<{ name: string, points: import("./measure.js").TrackPoint[] }>} files
 * @param {Parameters<typeof analyze>[1] & { title?: string, heading?: string, onProgress?: (info: { name: string, index: number, total: number, phase: "start" | "done", ms?: number }) => void }} [opts]
 */
export function toHtmlAnalyzedFiles(files, opts = {}) {
  const { onProgress, ...rest } = opts;
  const panels = files.map((f, i) => {
    const startedAt = Date.now();
    onProgress?.({ name: f.name, index: i, total: files.length, phase: "start" });
    const layers = analyzedLayers(f.points, rest);
    const chartResult = rest.stabilized !== false ? elevationChartSvg(f.points, rest) : null;
    onProgress?.({
      name: f.name,
      index: i,
      total: files.length,
      phase: "done",
      ms: Date.now() - startedAt,
    });
    const chartTitle = chartResult
      ? `${f.name} · ${fmtTime(chartResult.t0)} – ${fmtTime(chartResult.t1)} · ` +
        `${chartResult.total - chartResult.kept}/${chartResult.total} deleted`
      : null;
    return {
      title: f.name,
      layers,
      chart: chartResult?.svg ?? null,
      chartTitle,
      opts: { origin: layers.origin },
    };
  });
  return writeHtml(panels, {
    title: rest.title ?? "GPX Stabilizer",
    heading: rest.heading ?? "GPX Stabilizer — analyzed",
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
  const layers = analyzedLayers(points, opts);
  return toSvg(layers, {
    standalone: true,
    width: opts.width ?? 1280,
    height: opts.height ?? 720,
    origin: layers.origin,
  });
}
