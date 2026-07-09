#!/usr/bin/env node
// gpx-from-gopro — extract GoPro GPS into merged GPX, one file per camera per local date.
//   gpx-from-gopro <dir|file.mp4> [...] [--out DIR] [--tz HOURS] [--rate HZ] [--cache-dir DIR | --no-cache]
//                                [--organize DIR] [--yes] [--mode core|ski]
//                                [--html] [--png [--width N] [--height N]]
//
// - --mode core|ski: runs the merged points through gpx-stabilizer's own `stabilizeTrack` (per
//   recording session — see the `--out` loop below) before writing, instead of shipping today's
//   default raw extraction. --html/--png (below) render under the SAME mode when both are given,
//   so the preview always matches what actually got written. Omitting --mode leaves every output
//   exactly as before (raw, unstabilized) — this is purely additive.
//
// - --html / --png: alongside the merged .gpx (never instead of it), also render each group's merged
//   track through the SAME analyzed view core's own CLI uses (clean track + drop markers) — an eval
//   aid for eyeballing a group before/after a pipeline change, no separate `gpx-stabilizer` step
//   needed. --html writes one <out>/gopro-view.html (one panel per group); --png writes one
//   <out>/<group>.png per group (needs @resvg/resvg-js — see core's png.js).
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
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { analyzedSvg, MODES, saveGpx, savePng, stabilizeTrack, toHtmlAnalyzedFiles } from "gpx-stabilizer";
import { buildGroups, family, fileNumber } from "./group.js";
import { cacheMovePlan, executeMove, findSidecars, planMove } from "./organize.js";
import { readGoproSamples } from "./telemetry.js";

const VIDEO_RE = /\.(mp4|mov|m4v|360)$/i;
const MEDIAN_N = 30;
const LOCAL_TZ = -new Date().getTimezoneOffset() / 60; // hours, may be fractional

// ---- args ----
const argv = process.argv.slice(2);
const WITH_VALUE = new Set(["out", "tz", "rate", "cache-dir", "organize", "width", "height", "mode"]);
const KNOWN_BOOL = new Set(["no-cache", "html", "png", "yes"]);
const USAGE =
  "usage: gpx-from-gopro <dir|file.mp4> [...] [--out DIR] [--tz HOURS] [--rate HZ]" +
  " [--cache-dir DIR | --no-cache] [--organize DIR] [--yes] [--mode core|ski]" +
  " [--html] [--png [--width N] [--height N]]";
const inputs = [];
const opts = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const name = a.slice(2);
    if (WITH_VALUE.has(name)) opts[name] = argv[++i];
    else if (KNOWN_BOOL.has(name)) opts[name] = true;
    else {
      // an unrecognized flag must fail loudly -- silently accepting it into `opts` would look like
      // it took effect while doing nothing.
      console.error(`gpx-from-gopro: unknown option --${name}\n\n${USAGE}`);
      process.exit(1);
    }
  } else inputs.push(a);
}
if (inputs.length === 0) {
  console.error(USAGE);
  process.exit(1);
}
if (opts.mode != null && !MODES[opts.mode]) {
  console.error(`gpx-from-gopro: unknown --mode "${opts.mode}" (use: ${Object.keys(MODES).join(", ")})\n\n${USAGE}`);
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
  // --mode stabilizes each recording session independently (stabilizeTrack analyzes a session's own
  // <trkseg>s as one continuous stream, same handling core itself gives a multi-segment track) --
  // sessions themselves stay separate <trk>s, matching buildGroups' own "one <trk> per recording"
  // design. Omitting --mode ships today's raw extraction unchanged.
  const tracks = opts.mode
    ? g.tracks.map((trk) => ({
        name: trk.name,
        segments: stabilizeTrack({ segments: trk.segments }, { mode: opts.mode }).segments,
      }))
    : g.tracks;
  const track = {
    tracks, // one <trk> per recording session, named after its own original video file
    meta: {
      name: g.name,
      time: g.startMs != null ? new Date(g.startMs).toISOString() : null,
      type: null,
    },
  };
  const path = join(outDir, `${g.name}.gpx`);
  saveGpx(track, path, { creator: "gpx-from-gopro" });
  const npts = tracks.reduce((s, t) => s + t.segments.reduce((s2, seg) => s2 + seg.length, 0), 0);
  const nseg = tracks.reduce((s, t) => s + t.segments.length, 0);
  written.push(`${g.name}.gpx (${npts} pts, ${tracks.length} trk, ${nseg} seg)`);
}

console.log(`\ndone. processed=${ok} skipped=${skipped} failed=${failed}`);
for (const w of written) console.log(`  -> ${join(outDir, w)}`);

// ---- --html / --png: eval visualization of each group's merged track, additive to the .gpx above ----
// (analyzedLayers/analyzedSvg run core's noise-removal pipeline over the flattened group, under the
// same --mode as the .gpx above (core's own default when --mode is omitted) — so drop reasons / hdop
// overlays are visible without a separate `gpx-stabilizer --html` pass on the merged .gpx.)
if (opts.html || opts.png) {
  // fed from the RAW groups (not the --mode-stabilized `tracks` written above) -- these views run
  // their OWN analyze()/stabilize() pass internally, so raw points go in and `analyzeOpts` (below)
  // carries the SAME --mode through, keeping the preview consistent with the .gpx without double
  // -stabilizing anything.
  const tracks = groups.map((g) => ({
    name: g.name,
    points: g.tracks.flatMap((t) => t.segments).flat(),
  }));
  const analyzeOpts = opts.mode ? { mode: opts.mode } : {};
  if (opts.html) {
    const htmlPath = join(outDir, "gopro-view.html");
    // one toHtmlAnalyzedFiles() call analyzes every group (potentially slow — full analyze() over
    // each merged day's track) with no other progress signal, so report per-group start/done.
    const onProgress = ({ name, index, total, phase, ms }) => {
      if (phase === "start") console.log(`  [${index + 1}/${total}] analyzing ${name}...`);
      else console.log(`  [${index + 1}/${total}] ${name} done (${(ms / 1000).toFixed(1)}s)`);
    };
    writeFileSync(htmlPath, toHtmlAnalyzedFiles(tracks, { ...analyzeOpts, onProgress }));
    console.log(`html -> ${htmlPath}`);
  }
  if (opts.png) {
    const width = Number(opts.width ?? 1280);
    const height = Number(opts.height ?? 720);
    for (const t of tracks) {
      const pngPath = join(outDir, `${t.name}.png`);
      await savePng(analyzedSvg(t.points, { ...analyzeOpts, width, height }), pngPath);
      console.log(`png -> ${pngPath}`);
    }
  }
}

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
