#!/usr/bin/env node
// gpx-from-gopro — extract GoPro GPS into merged GPX, grouped by camera family + local date.
//   gpx-from-gopro <dir|file.mp4> [...] [--out DIR] [--tz HOURS] [--rate HZ]
//
// - Recurses directories for video files (mp4/mov/m4v/360); skips .LRV/.THM and ._ AppleDouble.
// - Groups by (filename family, local date): GOPR/GP = old camera, GX/GH = new camera; a session's
//   first file (GOPR) and its continuation chapters (GP..) merge into one family.
// - Local date: timezone from the median longitude of the first valid fixes (round(lon/15)),
//   snapped to the machine's local timezone when within 1 hour; override with --tz.
// - One merged <YYYYMMDD>-<family>.gpx per group, written to --out (default ".").
// - Tolerant: a file that fails to extract is logged and skipped, the run continues.
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { extractGoproPoints, probeGoproMeta } from "./gopro.js";
import { saveGpx } from "./gpx.js";

const VIDEO_RE = /\.(mp4|mov|m4v|360)$/i;
const MEDIAN_N = 30;
const LOCAL_TZ = -new Date().getTimezoneOffset() / 60; // hours, may be fractional

// ---- args ----
const argv = process.argv.slice(2);
const WITH_VALUE = new Set(["out", "tz", "rate"]);
const inputs = [];
const opts = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const name = a.slice(2);
    if (WITH_VALUE.has(name)) opts[name] = argv[++i];
    else opts[name] = true;
  } else inputs.push(a);
}
if (inputs.length === 0) {
  console.error("usage: gpx-from-gopro <dir|file.mp4> [...] [--out DIR] [--tz HOURS] [--rate HZ]");
  process.exit(1);
}
const outDir = opts.out ?? ".";
const manualTZ = opts.tz != null ? Number(opts.tz) : null;
if (manualTZ != null && Number.isNaN(manualTZ)) {
  console.error(`invalid --tz: ${opts.tz}`);
  process.exit(1);
}
// --rate HZ -> group samples to that rate; omit for native (~18 Hz)
const groupTimes = opts.rate ? Math.round(1000 / Number(opts.rate)) : undefined;

// ---- camera family from filename ----
function family(file) {
  const b = basename(file).toUpperCase();
  if (/^GOPR\d+\./.test(b)) return "GOPR";
  if (/^GP\d\d\d+\./.test(b)) return "GOPR";
  if (/^GX\d\d\d+\./.test(b)) return "GX";
  if (/^GH\d\d\d+\./.test(b)) return "GH";
  const m = b.match(/^([A-Z]+)/);
  return m ? m[1] : "MISC";
}

// ---- timezone from median longitude of the first valid fixes ----
function medianLon(points) {
  const lons = [];
  for (const p of points) {
    if (p.lat === 0 && p.lon === 0) continue;
    lons.push(p.lon);
    if (lons.length >= MEDIAN_N) break;
  }
  if (lons.length === 0) return null;
  lons.sort((a, b) => a - b);
  const mid = Math.floor(lons.length / 2);
  return lons.length % 2 ? lons[mid] : (lons[mid - 1] + lons[mid]) / 2;
}
function decideTZ(lon) {
  if (manualTZ != null) return manualTZ;
  if (lon == null || Number.isNaN(lon)) return LOCAL_TZ;
  const approx = Math.round(lon / 15);
  return Math.abs(approx - LOCAL_TZ) <= 1 ? LOCAL_TZ : approx;
}
// epoch ms + tz offset -> YYYYMMDD local date
function localDate(ms, tz) {
  return new Date(ms + tz * 3600e3).toISOString().slice(0, 10).replaceAll("-", "");
}

// ---- collect video files ----
function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.error(`skip dir ${dir}: ${e.message}`);
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith("._")) continue; // macOS AppleDouble sidecar
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (VIDEO_RE.test(e.name)) out.push(p);
  }
  return out;
}
function collect(input) {
  let st;
  try {
    st = statSync(input);
  } catch (e) {
    console.error(`skip ${input}: ${e.message}`);
    return [];
  }
  if (st.isDirectory()) return walk(input);
  return VIDEO_RE.test(input) ? [input] : [];
}

// ---- main ----
const videos = inputs.flatMap(collect).sort();
if (videos.length === 0) {
  console.error("no video files found");
  process.exit(0);
}
console.log(`found ${videos.length} video file(s)`);

const groups = new Map(); // key "YYYYMMDD-FAMILY" -> { points, family, date }
let ok = 0;
let skipped = 0;
let failed = 0;
for (const file of videos) {
  // Cheap moov probe first: skip files with no GPMF GPS track without the
  // (slow) full extraction. Catches stitched products and non-GoPro videos.
  let meta;
  try {
    meta = await probeGoproMeta(file);
  } catch (e) {
    console.error(`  FAILED probe ${basename(file)}: ${(e?.message ?? String(e)).split("\n")[0]}`);
    failed++;
    continue;
  }
  if (!meta.hasGps) {
    const dim = meta.width && meta.height ? `${meta.width}x${meta.height}` : "?";
    console.error(`  no GPS track, skip: ${basename(file)} (${dim} ${meta.codec ?? "?"})`);
    skipped++;
    continue;
  }
  let points;
  try {
    points = await extractGoproPoints(file, groupTimes ? { groupTimes } : {});
  } catch (e) {
    console.error(`  FAILED ${basename(file)}: ${(e?.message ?? String(e)).split("\n")[0]}`);
    failed++;
    continue;
  }
  if (points.length === 0) {
    console.error(`  no GPS, skip: ${basename(file)}`);
    skipped++;
    continue;
  }
  const fam = family(file);
  const fix = points.find((p) => !(p.lat === 0 && p.lon === 0)) ?? points[0];
  const tz = decideTZ(medianLon(points));
  const date = fix.time != null ? localDate(fix.time, tz) : null;
  if (date == null) {
    console.error(`  bad time, skip: ${basename(file)}`);
    skipped++;
    continue;
  }
  const key = `${date}-${fam}`;
  if (!groups.has(key)) groups.set(key, { points: [], family: fam, date });
  groups.get(key).points.push(...points);
  console.log(`  ${basename(file)}: ${points.length} pts -> ${key}`);
  ok++;
}

mkdirSync(outDir, { recursive: true });
const written = [];
for (const [key, g] of groups) {
  g.points.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  // metadata start time = earliest real (non 0,0) fix, avoiding pre-lock placeholder times
  const realTimes = g.points
    .filter((p) => !(p.lat === 0 && p.lon === 0) && p.time != null)
    .map((p) => p.time);
  const startMs = realTimes.length ? Math.min(...realTimes) : null;
  const track = {
    segments: [g.points],
    meta: {
      name: key,
      time: startMs != null ? new Date(startMs).toISOString() : null,
      type: null,
    },
  };
  const path = join(outDir, `${key}.gpx`);
  saveGpx(track, path, { creator: "gpx-from-gopro" });
  written.push(`${key}.gpx (${g.points.length} pts)`);
}

console.log(`\ndone. processed=${ok} skipped=${skipped} failed=${failed}`);
for (const w of written) console.log(`  -> ${join(outDir, w)}`);
