#!/usr/bin/env node
// gpx-stabilize CLI — by default, stabilize each input GPX to a cleaned file; visualisation is opt-in.
//   gpx-stabilize FILE.gpx [...]                 -> cleaned <name>.stabilized.gpx per input (the product)
//   gpx-stabilize FILE.gpx [...] --html [FILE]    -> ONE interactive HTML viewer (all files, default out.html)
//   gpx-stabilize FILE.gpx [...] --png [--width N] [--height N]  -> one PNG per input (needs @resvg/resvg-js)
//   --out DIR sets the output directory for the cleaned GPX / PNG (default ".").
//   --config FILE.json passes a whole analyze config (params + disable list); --disable name,... skips
//   built-in modules (merged onto the config). Both feed analyze() so runs are reproducible from JSON.
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { readGpx } from "./gpx.js";
import { savePng } from "./png.js";
import { stabilizeGpx } from "./stabilize.js";
import { analyzedSvg, toHtmlAnalyzedFiles } from "./view.js";

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
// like opt, but ignore a value that is itself a GPX input (so `--html a.gpx` doesn't name the doc a.gpx)
const optFile = (name, def) => {
  const v = opt(name, null);
  return v && !/\.gpx$/i.test(v) ? v : def;
};
const files = argv.filter((a) => !a.startsWith("--") && /\.gpx$/i.test(a));

if (!files.length) {
  console.error(
    "usage: gpx-stabilize FILE.gpx [...] [--html [FILE]] [--png [--width N] [--height N]]" +
      " [--out DIR] [--config FILE.json] [--disable name,...]",
  );
  process.exit(1);
}

const dir = opt("out", ".");
const base = (f) => basename(f).replace(/\.gpx$/i, "");

// analyze config: a whole JSON object (--config), with --disable merged onto its disable list
const cfgPath = opt("config", null);
const cfg = cfgPath ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
const dis = opt("disable", null);
if (dis) cfg.disable = [...(cfg.disable ?? []), ...dis.split(",")];

if (has("html")) {
  // one HTML document with a scrolling panel per file
  const tracks = files.map((f) => ({ name: basename(f), points: readGpx(f).segments.flat() }));
  for (const t of tracks) console.log(`${t.name}: ${t.points.length} points`);
  const out = optFile("html", "out.html");
  writeFileSync(out, toHtmlAnalyzedFiles(tracks, cfg));
  console.log(`html -> ${out}`);
} else if (has("png")) {
  // one PNG per file
  const width = Number(opt("width", 1280));
  const height = Number(opt("height", 720));
  for (const f of files) {
    const points = readGpx(f).segments.flat();
    console.log(`${basename(f)}: ${points.length} points`);
    const path = `${dir}/${base(f)}.png`;
    await savePng(analyzedSvg(points, { ...cfg, width, height }), path);
    console.log(`png -> ${path}`);
  }
} else {
  // default: stabilize each input to a cleaned GPX (the stabilizer's product)
  for (const f of files) {
    const path = `${dir}/${base(f)}.stabilized.gpx`;
    const clean = stabilizeGpx(f, path, cfg);
    const npts = clean.segments.reduce((sum, seg) => sum + seg.length, 0);
    console.log(`stabilized -> ${path} (${npts} points)`);
  }
}
