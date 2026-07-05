#!/usr/bin/env node
// gpx-from-gopro — extract GoPro GPS into merged GPX, one file per camera per local date.
//   gpx-from-gopro <dir|file.mp4> [...] [--out DIR] [--tz HOURS] [--rate HZ] [--cache-dir DIR | --no-cache]
//                                [--organize DIR] [--yes]
//
// - Recurses directories for video files (mp4/mov/m4v/360); skips .LRV/.THM and ._ AppleDouble.
// - Groups by (camera, local date): camera = the body serial (udta CAME) when known, so two
//   same-model bodies shot on the same day stay separate; falls back to the filename family
//   (GOPR/GP = old, GX/GH = new) for files without a serial. Crash-fragmented files still merge
//   (same serial+date), so a session GoPro split across a crash is rejoined into the day's file.
// - Within a day's file, points split into one <trkseg> per recording session, keyed on the
//   filename file-number (a recording's chapters share it), with a within-session time-gap
//   split for restarts/dropouts: an uncrashed activity is one segment; a crash (new file-number)
//   shows as a segment break, same file. (GUMI is per-chapter on some bodies, so unused here.)
// - Local date: timezone from the median longitude of the first valid fixes (round(lon/15)),
//   snapped to the machine's local timezone when within 1 hour; override with --tz.
// - One merged <YYYYMMDD>-<family>.gpx per group (a short serial suffix is added only when two
//   cameras collide on the same family+date), written to --out (default ".").
// - Tolerant: a file that fails to extract is logged and skipped, the run continues.
// - Caches each file's extracted points (sidecar <file>.gpxcache.json by default, or --cache-dir),
//   keyed by size+mtime+rate+version, so a killed run resumes without re-extracting done files.
// - --organize DIR: AFTER every .gpx has been written, reorganizes the source videos into
//   <DIR>/<group>/<session>/ (same group/session naming as the .gpx above), moving each file's
//   cache record alongside and — when --out was NOT explicitly given — the group's .gpx into its
//   folder too. Always previews the plan and asks before moving anything (--yes skips both
//   prompts, defaulting .LRV/.THM sidecars to delete); a non-interactive stdin without --yes does
//   nothing (never blocks waiting for input that will never come). See organize.js.
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { saveGpx } from "gpx-stabilizer";
import { buildGroups, family, fileNumber } from "./group.js";
import { cacheMovePlan, executeMove, findSidecars, planMove } from "./organize.js";
import { readGoproSamples } from "./telemetry.js";

const VIDEO_RE = /\.(mp4|mov|m4v|360)$/i;
const MEDIAN_N = 30;
const LOCAL_TZ = -new Date().getTimezoneOffset() / 60; // hours, may be fractional

// ---- args ----
const argv = process.argv.slice(2);
const WITH_VALUE = new Set(["out", "tz", "rate", "cache-dir", "organize"]);
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
  console.error(
    "usage: gpx-from-gopro <dir|file.mp4> [...] [--out DIR] [--tz HOURS] [--rate HZ]" +
      " [--cache-dir DIR | --no-cache] [--organize DIR] [--yes]",
  );
  process.exit(1);
}
const outExplicit = opts.out != null; // --organize only sweeps the .gpx along when this is false
const outDir = opts.out ?? ".";
const manualTZ = opts.tz != null ? Number(opts.tz) : null;
if (manualTZ != null && Number.isNaN(manualTZ)) {
  console.error(`invalid --tz: ${opts.tz}`);
  process.exit(1);
}
// --rate HZ -> downsample to that rate; omit for native (~18 Hz)
const rate = opts.rate ? Number(opts.rate) : undefined;
// per-file extraction cache (on by default): sidecar next to source; --cache-dir
// redirects to a managed dir; --no-cache disables
const cache = opts["no-cache"] ? false : opts["cache-dir"] ? { dir: opts["cache-dir"] } : true;

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

const entries = []; // one per extracted file -> buildGroups
let ok = 0;
let skipped = 0;
let failed = 0;
for (const file of videos) {
  let meta;
  let points;
  let fromCache;
  try {
    ({ meta, points, fromCache } = await readGoproSamples(file, { rate, cache }));
  } catch (e) {
    console.error(`  FAILED ${basename(file)}: ${(e?.message ?? String(e)).split("\n")[0]}`);
    failed++;
    continue;
  }
  // No GPMF GPS track (caught cheaply by the moov probe) or an extraction that
  // yielded nothing — skip either way.
  if (!meta.hasGps || points.length === 0) {
    const dim = meta.width && meta.height ? `${meta.width}x${meta.height}` : "?";
    console.error(
      `  no GPS track, skip${fromCache ? " (cached)" : ""}: ${basename(file)} (${dim} ${meta.codec ?? "?"})`,
    );
    skipped++;
    continue;
  }

  const fam = family(file);
  const fix = points.find((p) => !(p.lat === 0 && p.lon === 0));
  if (!fix) {
    // Every sample is a (0,0) pre-lock placeholder — the GPS never got a position fix (indoor /
    // no sky view). buildGroups would drop them all and skip the resulting empty group anyway;
    // catch it here so the log is honest. A fallback date off points[0] would be the GoPro's
    // pre-satellite clock default (e.g. 2021), which reads deceptively like a real misdated file.
    console.error(`  no real fix, skip: ${basename(file)} (0/${points.length} fixed)`);
    skipped++;
    continue;
  }
  const tz = decideTZ(medianLon(points));
  const date = fix.time != null ? localDate(fix.time, tz) : null;
  if (date == null) {
    console.error(`  bad time, skip: ${basename(file)}`);
    skipped++;
    continue;
  }
  // Hand the grouping inputs to buildGroups: serial (CAME) splits cameras, the filename
  // file-number splits recording sessions into <trkseg>s (+ a time-gap split). See ./group.js.
  entries.push({ family: fam, date, serial: meta.serial, session: fileNumber(file), points, file });
  const tag = meta.serial ? `${date}-${fam}#${meta.serial.slice(0, 4)}` : `${date}-${fam}`;
  console.log(`  ${basename(file)}: ${points.length} pts -> ${tag}${fromCache ? " (cached)" : ""}`);
  ok++;
}

mkdirSync(outDir, { recursive: true });
const { groups, skipped: emptyGroups } = buildGroups(entries);
for (const name of emptyGroups) console.error(`  no real fix, skip group: ${name}`);
const written = [];
for (const g of groups) {
  const track = {
    segments: g.segments,
    meta: {
      name: g.name,
      time: g.startMs != null ? new Date(g.startMs).toISOString() : null,
      type: null,
    },
  };
  const path = join(outDir, `${g.name}.gpx`);
  saveGpx(track, path, { creator: "gpx-from-gopro" });
  const npts = g.segments.reduce((s, seg) => s + seg.length, 0);
  written.push(`${g.name}.gpx (${npts} pts, ${g.segments.length} seg)`);
}

console.log(`\ndone. processed=${ok} skipped=${skipped} failed=${failed}`);
for (const w of written) console.log(`  -> ${join(outDir, w)}`);

// ---- --organize: only after every .gpx above is safely on disk ----
async function promptLine(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

if (opts.organize) {
  const includeGpx = !outExplicit; // --out was explicit -> leave the .gpx where the user put it
  const plan = planMove(entries, { root: opts.organize, outDir, includeGpx });
  if (plan.files.length === 0) {
    console.log("\n--organize: nothing to move (no successfully-extracted videos).");
  } else {
    const byDestDir = new Map();
    let sidecarTotal = 0;
    let cacheTotal = 0;
    for (const f of plan.files) {
      if (!byDestDir.has(f.destDir)) byDestDir.set(f.destDir, []);
      byDestDir.get(f.destDir).push(f);
      sidecarTotal += findSidecars(f.file).length;
      const cp = cacheMovePlan(f.file, f.destPath, cache);
      if (cp && existsSync(cp.from)) cacheTotal++;
    }

    console.log(`\n--organize preview: ${plan.files.length} video(s) -> ${opts.organize}`);
    for (const [destDir, list] of byDestDir) {
      console.log(`  ${destDir}/`);
      for (const f of list) console.log(`    ${basename(f.file)}`);
    }
    if (plan.gpx.length)
      console.log(`  + ${plan.gpx.length} .gpx file(s) moving into their group folder`);
    if (cacheTotal) console.log(`  + ${cacheTotal} cache file(s) moving alongside (never deleted)`);
    if (sidecarTotal) console.log(`  + ${sidecarTotal} .LRV/.THM sidecar file(s) found`);

    let sidecarAction = "delete";
    let confirmed = true;
    if (!opts.yes) {
      if (!process.stdin.isTTY) {
        console.log(
          "--organize: stdin is not interactive — skipping without --yes (nothing moved).",
        );
        confirmed = false;
      } else {
        if (sidecarTotal > 0) {
          const raw = await promptLine(
            `  delete or move the ${sidecarTotal} sidecar file(s)? [delete/move] (default delete): `,
          );
          sidecarAction = raw.trim().toLowerCase().startsWith("m") ? "move" : "delete";
        }
        const raw = await promptLine(`\nProceed with moving ${plan.files.length} file(s)? [y/N] `);
        confirmed = ["y", "yes"].includes(raw.trim().toLowerCase());
      }
    }

    if (!confirmed) {
      console.log("--organize: cancelled, nothing moved.");
    } else {
      const summary = executeMove(plan, { cache, sidecarAction });
      console.log(
        `\n--organize done. moved=${summary.moved} gpxMoved=${summary.gpxMoved} cacheMoved=${summary.cacheMoved} ` +
          `sidecars(moved=${summary.sidecarsMoved},deleted=${summary.sidecarsDeleted}) ` +
          `skippedCollisions=${summary.skippedCollisions} errors=${summary.errors.length}`,
      );
      for (const e of summary.errors) console.error(`  ERROR ${e.file}: ${e.error}`);
    }
  }
}
