// mp4 directory reorganization for gpx-from-gopro: move each source video into
// <root>/<group-name>/<session>/, mirroring the exact naming buildGroups() gives the
// corresponding .gpx (group.js's groupNames()/gkeyOf() — the single source of truth
// for that name, so the two never drift apart). planMove() is pure (no IO) so it's
// unit testable; gopro-cli.js prompts/prints and calls executeMove() to touch disk.
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveCachePath } from "./gopro-cache.js";
import { gkeyOf, groupNames } from "./group.js";

const NO_SESSION = "no-session"; // folder for files with no parseable file-number
const SIDECAR_EXTS = ["lrv", "thm"]; // GoPro's per-chapter low-res preview / thumbnail

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * @typedef {object} FilePlan
 * @property {string} file      source video path
 * @property {string} group     the file's group name (matches its .gpx base name)
 * @property {string} destDir   <root>/<group>/<session-or-"no-session">
 * @property {string} destPath  destDir/basename(file)
 */

/**
 * @typedef {object} GpxPlan
 * @property {string} group  group name
 * @property {string} from   current .gpx path (in --out)
 * @property {string} to     <root>/<group>/<group>.gpx
 */

/**
 * Plan where each source video — and, when requested, its group's .gpx — should
 * move to. Pure: no filesystem access, so it's cheap to unit test.
 * @param {import("./group.js").GroupEntry[]} entries  must carry `file`
 * @param {{ root: string, outDir?: string, includeGpx?: boolean }} opts
 *   `includeGpx` moves each group's `<outDir>/<group>.gpx` into its folder too
 *   (skip when the caller wants gpx left in an explicitly-chosen --out).
 * @returns {{ files: FilePlan[], gpx: GpxPlan[] }}
 */
export function planMove(entries, { root, outDir, includeGpx = false }) {
  const names = groupNames(entries);
  const files = [];
  const groupsSeen = new Set();
  for (const e of entries) {
    if (!e.file) continue;
    const group = names.get(gkeyOf(e));
    groupsSeen.add(group);
    const session = e.session ?? NO_SESSION;
    const destDir = join(root, group, session);
    files.push({ file: e.file, group, destDir, destPath: join(destDir, basename(e.file)) });
  }
  const gpx = [];
  if (includeGpx && outDir != null) {
    for (const group of groupsSeen) {
      gpx.push({
        group,
        from: join(outDir, `${group}.gpx`),
        to: join(root, group, `${group}.gpx`),
      });
    }
  }
  return { files, gpx };
}

/**
 * Sidecar files GoPro drops next to a chapter (same stem, `.LRV`/`.THM`) that
 * actually exist on disk — a directory listing + case-insensitive match, not a
 * handful of casing guesses, so it works on both case-sensitive and
 * case-insensitive filesystems without double-counting.
 * @param {string} mp4Path
 * @returns {string[]} existing sidecar paths
 */
export function findSidecars(mp4Path) {
  const dir = dirname(mp4Path);
  const stem = basename(mp4Path).replace(/\.[^.]+$/, "");
  const re = new RegExp(`^${escapeRegExp(stem)}\\.(${SIDECAR_EXTS.join("|")})$`, "i");
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => re.test(n)).map((n) => join(dir, n));
}

/**
 * Move src -> dest via rename; falls back to copy+unlink on EXDEV (rename can't
 * cross filesystems/devices — an SD card to an external drive, most commonly).
 * `rename` is injectable so the EXDEV fallback is testable without a real
 * cross-device pair.
 * @param {string} src
 * @param {string} dest
 * @param {(src: string, dest: string) => void} [rename]
 */
export function moveFile(src, dest, rename = renameSync) {
  try {
    rename(src, dest);
  } catch (e) {
    if (e?.code !== "EXDEV") throw e;
    copyFileSync(src, dest);
    unlinkSync(src);
  }
}

/**
 * Where a file's cache record currently lives (if caching is on) and where it
 * should move to alongside the file — reuses resolveCachePath(), the SAME
 * function the extraction cache itself uses, so this works for both the
 * default sidecar mode and --cache-dir mode with no special-casing.
 * @param {string} file
 * @param {string} destPath
 * @param {boolean | { dir?: string | null } | null} cache
 * @returns {{ from: string, to: string } | null}  null when caching is off
 */
export function cacheMovePlan(file, destPath, cache) {
  const from = resolveCachePath(file, cache);
  if (from == null) return null;
  return { from, to: resolveCachePath(destPath, cache) };
}

/**
 * @typedef {object} MoveSummary
 * @property {number} moved              mp4 files moved
 * @property {number} gpxMoved
 * @property {number} cacheMoved
 * @property {number} sidecarsMoved
 * @property {number} sidecarsDeleted
 * @property {number} skippedCollisions  a destination already existed — never overwritten
 * @property {{ file: string, error: string }[]} errors
 */

/**
 * Execute a plan built by planMove(): create dest dirs, move each mp4 (skip — never
 * overwrite — on a destination collision), move its cache record alongside
 * (best-effort; see cacheMovePlan), move each group's .gpx when plan.gpx has entries,
 * and handle sidecars per `sidecarAction`.
 * @param {{ files: FilePlan[], gpx: GpxPlan[] }} plan
 * @param {{ cache?: boolean | { dir?: string|null } | null, sidecarAction?: "delete"|"move"|"skip" }} [opts]
 * @returns {MoveSummary}
 */
export function executeMove(plan, { cache = true, sidecarAction = "delete" } = {}) {
  const summary = {
    moved: 0,
    gpxMoved: 0,
    cacheMoved: 0,
    sidecarsMoved: 0,
    sidecarsDeleted: 0,
    skippedCollisions: 0,
    errors: [],
  };

  for (const f of plan.files) {
    try {
      if (existsSync(f.destPath)) {
        summary.skippedCollisions++;
        continue;
      }
      // sidecars are keyed off the file's ORIGINAL path (dirname/basename of a string,
      // not a live handle), so finding them before or after the mp4 itself has moved
      // is equivalent — the mp4's disappearance doesn't affect scanning its old directory.
      const sidecars = sidecarAction !== "skip" ? findSidecars(f.file) : [];
      const cachePlan = cacheMovePlan(f.file, f.destPath, cache);

      mkdirSync(f.destDir, { recursive: true });
      moveFile(f.file, f.destPath);
      summary.moved++;

      if (cachePlan && existsSync(cachePlan.from)) {
        try {
          moveFile(cachePlan.from, cachePlan.to);
          summary.cacheMoved++;
        } catch {
          // best-effort: losing a cache record only costs a future re-extraction
        }
      }

      for (const side of sidecars) {
        if (sidecarAction === "delete") {
          unlinkSync(side);
          summary.sidecarsDeleted++;
        } else {
          const dest = join(f.destDir, basename(side));
          if (!existsSync(dest)) {
            moveFile(side, dest);
            summary.sidecarsMoved++;
          }
        }
      }
    } catch (e) {
      summary.errors.push({ file: f.file, error: e?.message ?? String(e) });
    }
  }

  for (const g of plan.gpx) {
    try {
      if (!existsSync(g.from)) continue; // nothing written for this group (e.g. it was skipped)
      if (existsSync(g.to)) {
        summary.skippedCollisions++;
        continue;
      }
      mkdirSync(dirname(g.to), { recursive: true });
      moveFile(g.from, g.to);
      summary.gpxMoved++;
    } catch (e) {
      summary.errors.push({ file: g.from, error: e?.message ?? String(e) });
    }
  }

  return summary;
}
