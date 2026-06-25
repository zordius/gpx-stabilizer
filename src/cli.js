#!/usr/bin/env node
// gpx-stabilize CLI — render one or more GPX files' analysed view.
//   gpx-stabilize FILE.gpx [...] [--png [--out DIR] [--width N] [--height N]] [--html FILE]
// Default is an interactive HTML document (all files, one scrolling panel each). `--png` writes one
// PNG per file instead (needs the @resvg/resvg-js dev dependency).
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { readGpx } from "./gpx.js";
import { savePng } from "./png.js";
import { analyzedSvg, toHtmlAnalyzedFiles } from "./view.js";

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const files = argv.filter((a) => !a.startsWith("--") && /\.gpx$/i.test(a));

if (!files.length) {
  console.error(
    "usage: gpx-stabilize FILE.gpx [...] [--png [--out DIR] [--width N] [--height N]] [--html FILE]",
  );
  process.exit(1);
}

const tracks = files.map((f) => ({ name: basename(f), points: readGpx(f).segments.flat() }));
for (const t of tracks) console.log(`${t.name}: ${t.points.length} points`);

if (has("png")) {
  const dir = opt("out", ".");
  const width = Number(opt("width", 1280));
  const height = Number(opt("height", 720));
  for (const t of tracks) {
    const path = `${dir}/${t.name.replace(/\.gpx$/i, "")}.png`;
    await savePng(analyzedSvg(t.points, { width, height }), path);
    console.log(`png -> ${path}`);
  }
} else {
  const out = opt("html", "out.html");
  writeFileSync(out, toHtmlAnalyzedFiles(tracks));
  console.log(`html -> ${out}`);
}
