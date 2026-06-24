import { writeFileSync } from "node:fs";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * @typedef {{ lat: number, lon: number }} Point  any object carrying lat/lon
 * @typedef {{ lat: number, lon: number, text: string }} Label  a positioned text label
 */

/**
 * One labelled, independently-styled layer. Carries lines, points, labels, or a mix; all share
 * the SVG's single projection. The `label` becomes the `<g>` id so HTML/CSS can toggle it.
 * @typedef {object} Layer
 * @property {string} label              names the group: `<g id="layer-{slug}" class="layer">`
 * @property {Point[][]} [lines]         polylines (each inner array is one connected line)
 * @property {Point[]} [points]          marker positions
 * @property {Label[]} [labels]          text labels; rendered in a `<g class="label" font-size=…>`
 * @property {boolean} [polygon]         render lines as filled, closed polygons (color = fill)
 * @property {string} [color]            stroke for lines; fill for points, polygons, and text (default "#0a6")
 * @property {number} [width]            line stroke-width (default 1.5)
 * @property {number} [size]             marker radius in px (default 2)
 * @property {"circle" | "square"} [shape] marker shape (default "circle")
 * @property {number} [fontSize]         label font-size in user units (default 12)
 * @property {number} [opacity]          element opacity 0..1
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

/**
 * Render labelled layers to one SVG string. Geometry is fit and centred inside a fixed
 * `viewWidth`×`viewHeight` viewBox (default 1280×720), so text uses real px-like sizes. Each
 * layer is wrapped in a toggleable `<g>`; every `<text>` also carries `class="label"`, and all
 * sizes/colours are presentation attributes — no `<style>` is emitted, so embedding HTML can
 * override everything by `class`.
 *
 * Projection is local equirectangular (longitude compressed by cos(lat)), north up.
 *
 * @param {Layer[]} layers
 * @param {{ viewWidth?: number, viewHeight?: number, padding?: number, background?: string }} [opts]
 * @returns {string}
 */
export function toSvg(layers = [], opts = {}) {
  const vw = opts.viewWidth ?? 1280;
  const vh = opts.viewHeight ?? 720;
  const pad = opts.padding ?? 16;
  const background = opts.background ?? null;

  const head = `<svg xmlns="${SVG_NS}" viewBox="0 0 ${vw} ${vh}" width="${vw}" height="${vh}" preserveAspectRatio="xMidYMid meet">`;

  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const layer of layers) {
    for (const p of layerPoints(layer)) {
      count++;
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }
  }
  if (count === 0) return `${head}</svg>\n`;

  const kx = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const minX = minLon * kx;
  const dataW = maxLon * kx - minX;
  const dataH = maxLat - minLat;
  const availW = vw - 2 * pad;
  const availH = vh - 2 * pad;
  const scale = Math.min(
    dataW > 0 ? availW / dataW : Number.POSITIVE_INFINITY,
    dataH > 0 ? availH / dataH : Number.POSITIVE_INFINITY,
  );
  const s = Number.isFinite(scale) ? scale : 1;
  const offX = (vw - dataW * s) / 2;
  const offY = (vh - dataH * s) / 2;
  const sx = (lon) => round(offX + (lon * kx - minX) * s);
  const sy = (lat) => round(offY + (maxLat - lat) * s); // flip so north is up

  const out = [head];
  if (background) out.push(`  <rect width="100%" height="100%" fill="${enc(background)}"/>`);
  for (const layer of layers) {
    const { groupAttrs, body } = renderLayer(layer, sx, sy);
    out.push(`  <g id="layer-${slug(layer.label)}" class="layer"${groupAttrs}>`);
    out.push(...body);
    out.push("  </g>");
  }
  out.push("</svg>", "");
  return out.join("\n");
}

/**
 * Emit one layer. Shared paint attributes are hoisted onto the layer `<g>` when the layer is
 * paint-homogeneous (all stroked, or all filled) so the children stay bare; a layer that mixes
 * stroked polylines with filled shapes keeps its attributes per-element to avoid a stroke leaking
 * onto markers. Returns the group's hoisted attribute string and the child element lines.
 */
function renderLayer(layer, sx, sy) {
  const color = layer.color ?? "#0a6";
  const width = layer.width ?? 1.5;
  const size = layer.size ?? 2;
  const shape = layer.shape ?? "circle";
  const fontSize = layer.fontSize ?? 12;
  const op = layer.opacity == null || layer.opacity === 1 ? "" : ` opacity="${layer.opacity}"`;

  const lines = (layer.lines ?? []).filter((line) => line.length > 0);
  const points = layer.points ?? [];
  const labels = layer.labels ?? [];
  const strokeBased = !layer.polygon && lines.length > 0; // polylines: fill=none + stroke
  const fillBased = (layer.polygon && lines.length > 0) || points.length > 0; // polygons + markers
  const hoist = !(strokeBased && fillBased); // mixed stroke+fill stays per-element

  let groupAttrs = "";
  if (hoist && strokeBased) {
    groupAttrs = ` fill="none" stroke="${enc(color)}" stroke-width="${width}"${op}`;
  } else if (hoist && fillBased) {
    groupAttrs = ` fill="${enc(color)}"${op}`;
  }
  // opacity that rode up to the <g> must not be repeated on inner elements (it would compound).
  const childOp = groupAttrs.includes("opacity") ? "" : op;
  const stroke = hoist ? "" : ` fill="none" stroke="${enc(color)}" stroke-width="${width}"${op}`;
  const fill = hoist ? "" : ` fill="${enc(color)}"${op}`;

  const body = [];
  for (const line of lines) {
    const pts = line.map((p) => `${sx(p.lon)},${sy(p.lat)}`).join(" ");
    body.push(
      layer.polygon
        ? `    <polygon points="${pts}"${fill}/>`
        : `    <polyline points="${pts}"${stroke}/>`,
    );
  }

  for (const p of points) {
    const cx = sx(p.lon);
    const cy = sy(p.lat);
    if (shape === "square") {
      const d = round(size * 2);
      body.push(
        `    <rect x="${round(cx - size)}" y="${round(cy - size)}" width="${d}" height="${d}"${fill}/>`,
      );
    } else {
      body.push(`    <circle cx="${cx}" cy="${cy}" r="${size}"${fill}/>`);
    }
  }

  if (labels.length > 0) {
    // font-size/fill/anchor are inherited presentation attributes: set once on the group so
    // embedding HTML can restyle every label by targeting `.label` (CSS beats the attribute).
    body.push(
      `    <g class="label" font-size="${fontSize}" fill="${enc(color)}" text-anchor="middle" dominant-baseline="central"${childOp}>`,
    );
    for (const lb of labels) {
      body.push(`      <text x="${sx(lb.lon)}" y="${sy(lb.lat)}">${enc(lb.text)}</text>`);
    }
    body.push("    </g>");
  }

  return { groupAttrs, body };
}

/**
 * One SVG's worth of input — the same `(layers, opts)` pair `toSvg` consumes, so a panel is
 * literally one `toSvg` call.
 * @typedef {object} Panel
 * @property {Layer[]} layers   the layers for this SVG
 * @property {Parameters<typeof toSvg>[1]} [opts]   per-SVG toSvg options
 */

/**
 * Render a standalone HTML document that stacks one SVG per panel vertically. Each panel is drawn
 * by `toSvg` and inlined (no intermediate files). A `<style>` block caps every `<svg>` at one
 * viewport (`max-width:100vw`, `max-height:100vh`); combined with each SVG's `preserveAspectRatio`
 * the drawing keeps its aspect ratio at any size.
 * @param {Panel[]} panels
 * @param {{ title?: string }} [opts]
 * @returns {string}  complete HTML document
 */
export function writeHtml(panels = [], opts = {}) {
  const title = enc(opts.title ?? "gpx-stabilizer");
  const svgs = panels.map((p) => toSvg(p.layers ?? [], p.opts)).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${title}</title>
<style>
body { margin: 0; }
svg { display: block; max-width: 100vw; max-height: 100vh; width: auto; height: auto; }
</style>
</head>
<body>
${svgs}</body>
</html>
`;
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
