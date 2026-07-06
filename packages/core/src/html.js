import { writeFileSync } from "node:fs";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * @typedef {{ x: number, y: number }} Point  any object carrying SVG x/y coordinates
 * @typedef {{ x: number, y: number, text: string }} Label  a positioned text label
 */

/**
 * One labelled, independently-styled layer. Carries lines, points, labels, or a mix; all share
 * the SVG's single projection. The `label` becomes the `<g>` id so HTML/CSS can toggle it.
 * @typedef {object} Layer
 * @property {string} label              names the group: `<g id="layer-{slug}" class="layer">`
 * @property {Point[][]} [lines]         the geometry (each inner array is one connected run); drawn
 *                                       as a line when `width` is set, otherwise as markers
 * @property {Point[]} [points]          extra explicit marker positions (always drawn as markers)
 * @property {Label[]} [labels]          text labels; rendered in a `<g class="label" font-size=…>`
 * @property {boolean} [polygon]         render lines as filled, closed polygons (color = fill)
 * @property {string} [color]            line stroke + default marker stroke; polygon/text fill (default "#0a6")
 * @property {number} [width]            line stroke-width; its presence is what draws the line
 * @property {string} [pointColor]       marker stroke; its presence also draws the line's points as markers
 * @property {number} [size]             marker size; dot diameter = size + 1 (default 2 → 3px); its
 *                                       presence also draws the line's points as markers
 * @property {"circle" | "square"} [shape] marker shape via stroke-linecap: round | square (default "circle")
 * @property {number} [fontSize]         label font-size in user units (default 12)
 * @property {number} [opacity]          element opacity 0..1
 * @property {boolean} [visible]         legend checkbox starts checked (default true) — future show/hide hook
 */

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

/** Make a label safe to use as an element id. */
function slug(label) {
  return String(label)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Iterate every point referenced by a layer (lines + points + labels). */
function* layerPoints(layer) {
  for (const line of layer.lines ?? []) yield* line;
  yield* layer.points ?? [];
  yield* layer.labels ?? [];
}

/** Count a layer's drawn elements (line vertices + explicit markers + text labels). Used both for the
 * legend "(N)" and as the emptiness test in writeHtml — so a labels-only layer must count its labels,
 * else it reads as empty and gets filtered out before render. */
function countPoints(layer) {
  let n = (layer.points?.length ?? 0) + (layer.labels?.length ?? 0);
  for (const line of layer.lines ?? []) n += line.length;
  return n;
}

/**
 * Render labelled layers to one SVG string. Points are plotted with their RAW `x`/`y` coordinates
 * (no projection here — produce x/y upstream, e.g. via view.js). The `viewBox` is set to the data's
 * OWN bounding box (inset proportionally by `padding`), so the SVG keeps the data's original aspect
 * ratio and bakes in NO zoom. CSS sizes the `<svg>` to the real viewport (e.g. 100vw × 100vh) and
 * `preserveAspectRatio="xMidYMid meet"` lets the browser compute the best-fit scale for that ACTUAL
 * aspect ratio — the fit is pure CSS, not baked-in JS. Each layer is a toggleable `<g id="layer-…">`;
 * every `<text>` carries `class="label"`; no `<style>` is emitted, so embedding HTML can restyle.
 *
 * `standalone` mode (for rasterizing to PNG, where there's no host CSS) instead emits explicit pixel
 * `width`/`height` and an internal `<style>` so markers/lines keep a constant stroke under the fit.
 *
 * @param {Layer[]} layers  points carry `x`, `y` (and `text` for labels)
 * @param {{ padding?: number, background?: string, standalone?: boolean, width?: number, height?: number, origin?: { lat0: number, lon0: number } }} [opts]
 * @returns {string}
 */
export function toSvg(layers = [], opts = {}) {
  const pad = opts.padding ?? 0.02;
  const background = opts.background ?? null;
  const standalone = opts.standalone ?? false;

  // The viewBox frames only the points that should set the default view, while EVERY layer is still
  // drawn. A layer opts in as a frame driver with `bbox: true` (analyzedLayers marks the clean track),
  // so dropped/raw/garbage points are drawn but never shrink the frame to a dot — pan/zoom can still
  // reach them outside it. If no layer opts in, all layers drive the frame (back-compat). `opts.bbox`
  // ({ minX, maxX, minY, maxY }) is an explicit override.
  const scan = (ls) => {
    let mnX = Number.POSITIVE_INFINITY;
    let mxX = Number.NEGATIVE_INFINITY;
    let mnY = Number.POSITIVE_INFINITY;
    let mxY = Number.NEGATIVE_INFINITY;
    let c = 0;
    for (const layer of ls) {
      for (const p of layerPoints(layer)) {
        c++;
        if (p.x < mnX) mnX = p.x;
        if (p.x > mxX) mxX = p.x;
        if (p.y < mnY) mnY = p.y;
        if (p.y > mxY) mxY = p.y;
      }
    }
    return { minX: mnX, maxX: mxX, minY: mnY, maxY: mxY, count: c };
  };
  const drivers = layers.filter((l) => l.bbox === true);
  let box;
  if (opts.bbox) box = { ...opts.bbox, count: 1 };
  else if (drivers.length) {
    box = scan(drivers);
    if (box.count === 0) box = scan(layers); // drivers carried no points (all-dropped track) → fall back
  } else box = scan(layers);
  const { minX, maxX, minY, maxY, count } = box;
  if (count === 0) return `<svg xmlns="${SVG_NS}"></svg>\n`;

  // viewBox = the data's own bounding box, inset by `padding` on each axis (a fraction of that
  // axis's extent, so the box keeps the data's aspect ratio). No zoom is baked in: CSS sizes the
  // <svg> to the viewport and preserveAspectRatio="meet" computes the best fit for its real shape.
  const dataW = Math.max(maxX - minX, 1e-9);
  const dataH = Math.max(maxY - minY, 1e-9);
  const vbX = round(minX - dataW * pad);
  const vbY = round(minY - dataH * pad);
  const vbW = round(dataW * (1 + 2 * pad));
  const vbH = round(dataH * (1 + 2 * pad));
  // Expose the bbox aspect ratio (width/height) as a CSS variable so the stylesheet can size the
  // <svg> element to the largest box of this ratio that fits the real viewport — the zoom-to-fit is
  // computed in CSS from `--ar` and vw/vh, not baked in here.
  const ar = Math.round((vbW / vbH) * 1e6) / 1e6;
  // HTML-embed: no fixed size, expose `--ar` for the host CSS. Standalone (PNG): fixed px size.
  const sizeAttr = standalone
    ? ` width="${opts.width ?? 1280}" height="${opts.height ?? 720}"`
    : ` style="--ar:${ar}"`;
  // font-family/weight set once on the root <svg> so every <text> (labels) inherits one style —
  // sans-serif to match the HTML legend, thinnest weight (degrades to nearest available).
  // `opts.origin` (the projection centre, `{ lat0, lon0 }`) rides as data attributes so the viewer's
  // click-to-show-coordinates script can invert a clicked x/y back to lat/lon — harmless (ignored)
  // in standalone/PNG mode, where nothing reads them.
  const originAttr = opts.origin
    ? ` data-lat0="${opts.origin.lat0}" data-lon0="${opts.origin.lon0}"`
    : "";
  const head = `<svg xmlns="${SVG_NS}" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" preserveAspectRatio="xMidYMid meet" font-family="sans-serif" font-weight="100"${sizeAttr}${originAttr}>`;

  const out = [head];
  // standalone has no host CSS, so carry the non-scaling-stroke rule inline (constant marker/line px)
  if (standalone) out.push("  <style>polyline,path,line{vector-effect:non-scaling-stroke}</style>");
  if (background) {
    out.push(
      `  <rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="${enc(background)}"/>`,
    );
  }
  // `opts.ontop` (viewer only): also emit, at the END of the svg, a hidden <use> of each layer's line
  // AND marker <path> (shares the geometry, no `d` copied), painted last so the legend's hover rule can
  // reveal it on top. The line <use> needs the layer's paint, so the dupe <g> carries `groupAttrs`. Ids
  // need a document-unique `idPrefix` (the panel id).
  const prefix = opts.ontop ? (opts.idPrefix ?? "p") : null;
  const ontopCopies = [];
  for (const layer of layers) {
    const lslug = slug(layer.label);
    const id = prefix && layer.label ? `${prefix}-${lslug}` : null;
    const { groupAttrs, body, hasLine, hasMarkers } = renderLayer(layer, id);
    out.push(`  <g id="layer-${lslug}" class="layer layer-${lslug}"${groupAttrs}>`);
    out.push(...body);
    out.push("  </g>");
    if (id) {
      const uses =
        (hasLine ? `<use href="#${id}-l"/>` : "") + (hasMarkers ? `<use href="#${id}-m"/>` : "");
      if (uses) ontopCopies.push(`  <g class="ontop ontop-${lslug}"${groupAttrs}>${uses}</g>`);
    }
  }
  out.push(...ontopCopies);
  out.push("</svg>", "");
  return out.join("\n");
}

/**
 * Emit one layer. Shared paint attributes are hoisted onto the layer `<g>` when the layer is
 * paint-homogeneous (all stroked, or all filled) so the children stay bare; a layer that mixes
 * stroked polylines with filled shapes keeps its attributes per-element to avoid a stroke leaking
 * onto markers. Returns the group's hoisted attribute string and the child element lines.
 */
function renderLayer(layer, id) {
  const color = layer.color ?? "#0a6";
  const fontSize = layer.fontSize ?? 12;
  const op = layer.opacity == null || layer.opacity === 1 ? "" : ` opacity="${layer.opacity}"`;

  const lines = (layer.lines ?? []).filter((line) => line.length > 0);
  const labels = layer.labels ?? [];
  const hasLines = lines.length > 0;

  // A line is drawn when a line `width` is set (a polygon when `polygon` is set); otherwise the
  // geometry shows as markers. Markers are ALSO drawn — reusing the line's points, on top of the
  // line — when a point style (`pointColor` or `size`) is set. `layer.points` adds explicit markers.
  const drawPolygon = layer.polygon && hasLines;
  const drawLine = !layer.polygon && layer.width != null && hasLines;
  const pointStyled = layer.pointColor != null || layer.size != null;
  const lineAsMarkers = hasLines && (pointStyled || (!drawLine && !drawPolygon));

  const markerPts = [...(layer.points ?? [])];
  if (lineAsMarkers) for (const line of lines) markerPts.push(...line);

  // Hoist the LINE paint onto the layer <g> so polylines/polygons stay bare; the marker <path> and
  // labels carry their own paint.
  let groupAttrs = "";
  if (drawPolygon) groupAttrs = ` fill="${enc(color)}"${op}`;
  else if (drawLine)
    groupAttrs = ` fill="none" stroke="${enc(color)}" stroke-width="${layer.width}"${op}`;
  // opacity that rode up to the <g> must not be repeated on inner elements (it would compound).
  const elOp = groupAttrs.includes("opacity") ? "" : op;

  const body = [];
  // line/polygon first, so the markers land on top of it
  if (drawPolygon) {
    for (const line of lines) {
      const pts = line.map((p) => `${round(p.x)},${round(p.y)}`).join(" ");
      body.push(`    <polygon points="${pts}"/>`);
    }
  } else if (drawLine) {
    // ONE <path> for every segment; each segment starts with M (pen up) so a broken-up track stays
    // broken — no line drawn across the gap. One element keeps the DOM small when `斷開` cuts the
    // track into many runs, and inherits the group's stroke just like the old per-segment polylines.
    const d = lines
      .map((line) => `M${line.map((p) => `${round(p.x)},${round(p.y)}`).join(" ")}`)
      .join(" ");
    body.push(`    <path${id ? ` id="${id}-l"` : ""} d="${d}"/>`);
  }

  // markers: one stroked <path> of zero-length dots — the dot diameter IS the stroke-width (size + 1),
  // so the `non-scaling-stroke` CSS rule keeps both line and marker size constant under zoom. round
  // cap = circle, square cap = square. `pointColor`/`size` style them independently of the line.
  const hasMarkers = markerPts.length > 0;
  if (hasMarkers) {
    const d = markerPts.map((p) => `M${round(p.x)},${round(p.y)} h0`).join(" ");
    const cap = layer.shape === "square" ? "square" : "round";
    const mColor = layer.pointColor ?? color;
    const mSize = layer.size ?? 2;
    const idAttr = id ? ` id="${id}-m"` : ""; // unique id so an <use> can share this path
    body.push(
      `    <path${idAttr} d="${d}" stroke="${enc(mColor)}" stroke-width="${round(mSize + 1)}" stroke-linecap="${cap}"${elOp}/>`,
    );
  }

  if (labels.length > 0) {
    // font-size/fill/anchor are inherited presentation attributes: set once on the group so
    // embedding HTML can restyle every label by targeting `.label` (CSS beats the attribute).
    body.push(
      `    <g class="label" font-size="${fontSize}" fill="${enc(color)}" text-anchor="middle" dominant-baseline="central"${elOp}>`,
    );
    for (const lb of labels) {
      body.push(`      <text x="${round(lb.x)}" y="${round(lb.y)}">${enc(lb.text)}</text>`);
    }
    body.push("    </g>");
  }

  return { groupAttrs, body, hasLine: drawLine, hasMarkers };
}

/**
 * One SVG's worth of input — the same `(layers, opts)` pair `toSvg` consumes, so a panel is
 * literally one `toSvg` call.
 * @typedef {object} Panel
 * @property {Layer[]} layers   the layers for this SVG
 * @property {string} [title]   panel heading, rendered as a sticky `<h2>` above the SVG (e.g. file name)
 * @property {Parameters<typeof toSvg>[1]} [opts]   per-SVG toSvg options
 */

/**
 * Render a standalone HTML document (semantic markup, no `<div>`): a page `<header>` with the `<h1>`
 * heading and an optional summary `<p>`, then one `<section>` per panel — each holding a sticky
 * `<header>` (the panel title as `<h2>` plus an overlaid legend) and one full-viewport SVG that
 * scrolls past underneath. Each panel is drawn by `toSvg` and inlined (no intermediate files). A
 * `<style>` block sizes every `<svg>` to one viewport (`100vw` x `100vh`, white card on a grey
 * page); combined with each SVG's `preserveAspectRatio` the drawing scales to fill and stays
 * centred, keeping its aspect ratio. Any element's hover fade eases in over 0.3 s and out over 0.7 s.
 * @param {Panel[]} panels
 * @param {{ title?: string, heading?: string, summary?: string }} [opts]
 * @returns {string}  complete HTML document
 */
export function writeHtml(panels = [], opts = {}) {
  const title = enc(opts.title ?? "gpx-stabilizer");
  const heading = enc(opts.heading ?? "GPX Stabilizer");
  const summary = opts.summary == null ? "" : `<p>${enc(opts.summary)}</p>\n`;
  // Index links in the intro: each titled panel becomes an anchor jump to its section. Only worth it
  // with more than one panel — a single panel needs no jump list.
  const indexItems =
    panels.length > 1
      ? panels
          .filter((p) => p.title != null)
          .map((p) => `<li><a href="#${slug(p.title)}">${enc(p.title)}</a></li>`)
          .join("")
      : "";
  const nav = indexItems ? `<nav><ul>${indexItems}</ul></nav>\n` : "";
  // Drop empty layers entirely — a layer with no drawn points renders no <g>, no legend item, and
  // no toggle rule (so e.g. a "no outliers" run shows nothing for that layer).
  const panelLayers = panels.map((p) => (p.layers ?? []).filter((l) => countPoints(l) > 0));
  const body = panels
    .map((p, i) => {
      const layers = panelLayers[i];
      const id = p.title != null ? slug(p.title) : null;
      const open = id ? `<section id="${id}">` : "<section>";
      const svg = toSvg(layers, { ...p.opts, ontop: true, idPrefix: id ?? `p${i}` });
      return `${open}\n${renderHead(p.title, layers, id)}${svg}\n</section>`;
    })
    .join("\n");
  // Pure-CSS rules per labelled layer slug: unchecking a panel's legend checkbox dims that panel's
  // matching <g> to opacity 0.1, and hovering the row enlarges its paths (scoped to the section). A
  // pure-point layer gets the full marker enlarge (10 px); a layer that also draws a line/polygon only
  // goes to 4 px so the stroke isn't ballooned.
  const slugs = new Set();
  const lineSlugs = new Set(); // slugs whose layer draws a line/polygon (not pure points)
  for (const layers of panelLayers)
    for (const l of layers) {
      if (!l.label) continue;
      const s = slug(l.label);
      slugs.add(s);
      const hasLines = (l.lines ?? []).some((line) => line.length > 0);
      if (hasLines && (l.polygon || l.width != null)) lineSlugs.add(s);
    }
  const toggles = [...slugs]
    .map((s) => {
      const sw = lineSlugs.has(s) ? 4 : 10;
      return (
        // dim an unchecked layer — but NOT while its legend row is hovered, so hovering still previews
        // it (the dim out-specificities the hover rules, so it has to be lifted, not just overridden)
        `section:has(.t-${s} input:not(:checked)):not(:has(.t-${s}:hover)) .layer-${s} { opacity: 0.1; }\n` +
        `section:has(.t-${s}:hover) .layer-${s} path, section:has(.t-${s}:hover) .ontop-${s} { stroke-width: ${sw}; }\n` +
        `section:has(.t-${s}:hover) .ontop-${s} { opacity: 1; }`
      );
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${title}</title>
<style>
html { scroll-behavior: smooth; }
html, body { margin: 0; padding: 0; }
h1 { padding: 10px; }
p { margin: 10px; padding: 0; }
nav ul { list-style: none; margin: 0; padding: 0 10px 10px; font: 14px/1.8 sans-serif; }
nav a { color: #06c; }
section { overflow: clip; display: grid; content-visibility: auto; contain-intrinsic-size: 100vw 100vh; }
section > header { grid-area: 1 / 1; align-self: start; position: sticky; top: 0; z-index: 1; }
section h2 { margin: 0; padding: 4px 8px; background: #aaa8; cursor: pointer; }
section h2 a { color: inherit; text-decoration: none; display: block; }
section h2:hover { background: #aaa3; }
section ul { position: absolute; top: 100%; left: 0; margin: 10px; padding: 5px; list-style: none; font: 12px/1.5 sans-serif; background: #fffa; border: 1px solid #000; }
section li { padding: 5px; cursor: pointer; }
section li:hover { background: #ffffaa; }
section li label { display: flex; align-items: center; gap: 8px; cursor: pointer; }
section li input { appearance: none; -webkit-appearance: none; margin: 0; width: 18px; height: 18px; border: 2px solid #888; border-radius: 4px; display: grid; place-content: center; cursor: pointer; }
section li input:checked { border-color: #06c; }
section li input::before { content: ""; width: 11px; height: 11px; transform: scale(0); background: #06c; clip-path: polygon(14% 44%, 0 65%, 50% 100%, 100% 16%, 80% 0%, 43% 62%); }
section li input:checked::before { transform: scale(1); }
section > svg { grid-area: 1 / 1; display: block; width: 100vw; height: 100vh; cursor: zoom-in; }
section > svg polyline, section > svg path { vector-effect: non-scaling-stroke; }
.ontop { opacity: 0; pointer-events: none; }
* { transition: opacity 0.7s ease, background-color 0.7s ease, stroke-width 0.3s ease; }
*:hover { transition-duration: 0.3s; }
${toggles}
</style>
</head>
<body>
<header>
<h1>${heading}</h1>
${summary}${nav}</header>
${body}
<script>
// click a chart — a panel must be the current # anchor before it zooms (so the FIRST click on any
// panel, including on load when # is empty, just selects it):
//  - not the # anchor          -> click its title (sets # and scrolls it into view)
//  - the # anchor, out of view  -> scrollIntoView (# unchanged, so a title click wouldn't move it)
//  - the # anchor, in viewport  -> zoom to the clicked point at 1 m = 5 px, then DRAG to pan
//  - already zoomed, plain click (no drag) -> show the clicked point's lat/lon bottom-left
// Zoom out with a RIGHT-CLICK or the bottom-right "zoom out" button. One panel zoomed; legend/header ignored.
let zoomed = null;
let drag = null;
let lastDragMoved = false; // did the most recent pointerdown->up actually pan (vs. a plain click)?
// Both controls are grid-area:1/1 siblings of the zoomed panel's own header/svg (moved into that
// section on zoom-in, below) and use sticky positioning, not fixed — so they stay pinned to their
// corner ONLY while that panel is on screen, and scroll away with it once the page scrolls past.
const btn = document.createElement("button");
btn.textContent = "zoom out";
btn.style.cssText =
  "grid-area:1/1;align-self:end;justify-self:end;position:sticky;bottom:12px;right:12px;z-index:9;display:none;padding:6px 12px;cursor:pointer;font:14px sans-serif";
const coordBox = document.createElement("div");
// Deliberately clickable/selectable (not pointer-events:none): a click here must do nothing (it
// isn't inside a panel's svg, so the pan/zoom logic below already ignores it) rather than fall
// through to the panel underneath, and the text must be selectable so the coordinates can be copied.
coordBox.style.cssText =
  "grid-area:1/1;align-self:end;justify-self:start;position:sticky;bottom:12px;left:12px;z-index:9;display:none;padding:6px 10px;font:14px sans-serif;background:#fffc;border:1px solid #000;cursor:default;user-select:text";
// invert a clicked SVG-space point back to lat/lon via the panel's own projection centre
// (data-lat0/data-lon0, embedded by html.js's toSvg) — same formula as measure.js's project(),
// run backwards: x = (lon-lon0)*mx, svgY = -(lat-lat0)*DEG_LAT_M.
const DEG_LAT_M = 110540, DEG_LON_M = 111320;
const showCoords = (svg, clientX, clientY) => {
  const lat0 = Number(svg.dataset.lat0);
  const lon0 = Number(svg.dataset.lon0);
  if (!Number.isFinite(lat0) || !Number.isFinite(lon0)) return; // no origin embedded -> nothing to show
  const u = new DOMPoint(clientX, clientY).matrixTransform(svg.getScreenCTM().inverse());
  const mx = Math.cos((lat0 * Math.PI) / 180) * DEG_LON_M;
  const lat = lat0 - u.y / DEG_LAT_M;
  const lon = lon0 + u.x / mx;
  coordBox.textContent = lat.toFixed(6) + ", " + lon.toFixed(6);
  coordBox.style.display = "block";
};
const restore = () => {
  if (zoomed) {
    zoomed.setAttribute("viewBox", zoomed.dataset.orig);
    zoomed.style.cursor = "";
  }
  zoomed = null;
  btn.style.display = "none";
  coordBox.style.display = "none";
};
document.body.addEventListener("pointerdown", (e) => {
  if (!zoomed || e.target.closest("section > svg") !== zoomed) return; // drag only the zoomed panel
  drag = {
    x: e.clientX,
    y: e.clientY,
    moved: false,
    vb: zoomed.getAttribute("viewBox").split(" ").map(Number),
  };
  zoomed.style.cursor = "grabbing";
  zoomed.setPointerCapture?.(e.pointerId);
});
document.body.addEventListener("pointermove", (e) => {
  if (!drag) return;
  if (Math.abs(e.clientX - drag.x) > 3 || Math.abs(e.clientY - drag.y) > 3) drag.moved = true;
  const r = zoomed.getBoundingClientRect();
  const [vx, vy, vw, vh] = drag.vb;
  // preserveAspectRatio="meet" scales the viewBox UNIFORMLY (the smaller-axis fit), so one screen px
  // is the same metres on BOTH axes. Use that single scale, not vw/width & vh/height separately
  // (those only agree when the viewBox and element share an aspect ratio) so the content tracks 1:1.
  const mPerPx = Math.max(vw / r.width, vh / r.height); // = 1 / min(width/vw, height/vh)
  const nx = vx - (e.clientX - drag.x) * mPerPx;
  const ny = vy - (e.clientY - drag.y) * mPerPx;
  zoomed.setAttribute("viewBox", nx + " " + ny + " " + vw + " " + vh);
});
document.body.addEventListener("pointerup", () => {
  if (drag) {
    lastDragMoved = drag.moved;
    drag = null;
    if (zoomed) zoomed.style.cursor = "grab";
  }
});
document.body.addEventListener("contextmenu", (e) => {
  if (zoomed) {
    e.preventDefault(); // zoomed -> right-click zooms out, then keeps the panel in view
    const svg = zoomed;
    restore();
    svg.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const svg = e.target.closest("section > svg");
  if (!svg) return; // not over a panel (header/legend/nav) -> leave the normal menu alone
  e.preventDefault(); // over a panel -> right-click scrolls it into view (so block the menu)
  svg.scrollIntoView({ behavior: "smooth", block: "start" });
});
document.body.addEventListener("click", (e) => {
  if (e.target === btn) return restore();
  const svg = e.target.closest("section > svg");
  if (svg && svg === zoomed) {
    if (!lastDragMoved) showCoords(svg, e.clientX, e.clientY); // plain click (no pan) -> show lat/lon
    return;
  }
  if (!svg) return;
  if (zoomed) restore(); // clicking another panel un-zooms the previous one
  const section = svg.closest("section");
  const a = section && section.querySelector("h2 a");
  // not the current # anchor yet -> select it (the title click sets # and scrolls it into view)
  if (a && section.id && location.hash !== "#" + section.id) return a.click();
  // it IS the # anchor: scroll to it if it's out of view, otherwise zoom to the clicked point
  const rect = svg.getBoundingClientRect();
  const mid = innerHeight / 2;
  if (rect.top >= mid || rect.bottom <= mid)
    return svg.scrollIntoView({ behavior: "smooth", block: "start" });
  if (!svg.dataset.orig) svg.dataset.orig = svg.getAttribute("viewBox");
  const u = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
  const r = svg.getBoundingClientRect();
  const w = r.width / 5, h = r.height / 5; // viewBox span (metres) so 1 m maps to 5 px
  svg.setAttribute("viewBox", (u.x - w / 2) + " " + (u.y - h / 2) + " " + w + " " + h);
  svg.style.cursor = "grab";
  zoomed = svg;
  section.appendChild(btn); // move into THIS panel's grid so sticky is scoped to it, not the viewport
  section.appendChild(coordBox);
  btn.style.display = "block";
});
</script>
</body>
</html>
`;
}

/**
 * Sticky panel header: the `<h2>` title plus a `<ul>` legend of each layer's colour + label.
 * Wrapped in a sticky `<header>` so both pin to the top together; the legend is positioned `absolute`
 * below the h2 so it overlays the SVG without taking layout space. The `<h2>` is an `<a href="#id">`
 * anchor so clicking it smooth-scrolls (pure CSS) to align this panel's section. Returns "" when
 * there is nothing to show (no title, no labelled layers).
 * @param {string} [title]
 * @param {Layer[]} layers
 * @param {string} [id]  the section id this header's anchor links to
 * @returns {string}
 */
function renderHead(title, layers, id) {
  const h2 = title == null ? "" : `<h2><a href="#${id}">${enc(title)}</a></h2>`;
  const items = layers
    .filter((l) => l.label)
    .map((l) => {
      const checked = l.visible === false ? "" : " checked";
      const cls = `t-${slug(l.label)}`; // ties this legend row to its `#layer-{slug}` group
      return `<li class="${cls}"><label><input type="checkbox"${checked}/>${legendSwatch(l)}${enc(l.label)} (${countPoints(l)})</label></li>`;
    })
    .join("");
  const legend = items ? `<ul>${items}</ul>` : "";
  if (!h2 && !legend) return "";
  return `<header>${h2}${legend}</header>\n`;
}

/**
 * A legend swatch: a tiny inline SVG that previews exactly what the layer draws — a line segment at
 * its real colour and width, and/or a marker at its real colour, size, and shape (circle vs square).
 * A layer that draws both shows both, so line-vs-point colour, line width, and point size are all
 * distinguishable; the draw decisions mirror `renderLayer`.
 * @param {Layer} layer
 * @returns {string}
 */
function legendSwatch(layer) {
  const color = layer.color ?? "#0a6";
  const polygon = Boolean(layer.polygon);
  const drawLine = !polygon && layer.width != null;
  const pointStyled = layer.pointColor != null || layer.size != null;
  const hasPoints = (layer.points?.length ?? 0) > 0;
  // markers appear when point-styled, when there is no line/polygon (geometry falls back to dots),
  // or when the layer carries explicit points — same as renderLayer.
  const drawMarker = hasPoints || pointStyled || (!drawLine && !polygon);

  const w = 30;
  const h = 16;
  const cx = w / 2;
  const cy = h / 2;
  const parts = [];
  if (polygon) {
    parts.push(`<rect x="3" y="3" width="${w - 6}" height="${h - 6}" fill="${enc(color)}"/>`);
  } else if (drawLine) {
    const lw = Math.min(layer.width, h - 2);
    parts.push(
      `<line x1="2" y1="${cy}" x2="${w - 2}" y2="${cy}" stroke="${enc(color)}" stroke-width="${lw}"/>`,
    );
  }
  if (drawMarker) {
    const mColor = enc(layer.pointColor ?? color);
    const r = Math.min(((layer.size ?? 2) + 1) / 2, cy - 1); // radius = (size+1)/2 (diameter = size+1)
    if ((layer.shape ?? "circle") === "square") {
      const side = round(2 * r);
      parts.push(
        `<rect x="${round(cx - r)}" y="${round(cy - r)}" width="${side}" height="${side}" fill="${mColor}"/>`,
      );
    } else {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${round(r)}" fill="${mColor}"/>`);
    }
  }
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${parts.join("")}</svg>`;
}

/**
 * Render panels to an HTML file.
 * @param {Panel[]} panels
 * @param {string} path
 * @param {Parameters<typeof writeHtml>[1]} [opts]
 */
export function saveHtml(panels, path, opts) {
  writeFileSync(path, writeHtml(panels, opts));
}
