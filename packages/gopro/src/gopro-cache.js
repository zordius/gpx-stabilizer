// Per-file extraction cache so a killed gpx-from-gopro run resumes cheaply.
// A record is keyed by the source's identity (v + size + mtime + rate); a rerun
// reuses it only when all four match, and writes are atomic (temp then rename)
// so a crash never leaves a half-written record a later run would trust.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

// Cache schema version: bump whenever the cached record's shape or the
// extraction output changes, so stale records read as a miss and re-extract.
// 3: points carry `cts` (media offset) and the record stores { meta, points }
// (was { hasGps, meta, points } at v2, pre-cts).
export const CACHE_V = 3;

/**
 * Cache-record path for a source file: sidecar `<file>.gpxcache.json` by
 * default, or a hashed name inside `cacheDir` (keeps the media tree clean).
 * @param {string} file
 * @param {string | null} [cacheDir]
 * @returns {string}
 */
export function cachePath(file, cacheDir = null) {
  if (cacheDir) {
    const h = createHash("sha1").update(resolve(file)).digest("hex").slice(0, 16);
    return join(cacheDir, `${basename(file)}.${h}.json`);
  }
  return `${file}.gpxcache.json`;
}

/**
 * Resolve the opt-in `cache` option to a record path, or null when caching is
 * off. Caching is ON by default: `undefined`/`true` → sidecar next to the
 * source; `{ dir }` → a hashed name under `dir` (keeps the media tree clean);
 * `false`/`null` → disabled.
 * @param {string} file
 * @param {boolean | { dir?: string | null } | null} [cache]
 * @returns {string | null}
 */
export function resolveCachePath(file, cache = true) {
  if (cache === false || cache == null) return null;
  const dir = typeof cache === "object" ? (cache.dir ?? null) : null;
  return cachePath(file, dir);
}

/**
 * Read a cache record, returning it only when it matches `ident`
 * (v + size + mtime + rate); missing/unreadable/stale all return null.
 * @param {string} path
 * @param {{ v: number, size: number, mtime: number, rate: number | null }} ident
 * @returns {object | null}
 */
export function readCache(path, ident) {
  let rec;
  try {
    rec = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null; // missing or unreadable -> miss
  }
  const fresh =
    rec.v === ident.v &&
    rec.size === ident.size &&
    rec.mtime === ident.mtime &&
    rec.rate === ident.rate;
  return fresh ? rec : null;
}

/**
 * Atomically write a cache record (temp file then rename), creating `cacheDir`
 * if given. Best-effort: returns false instead of throwing on failure, since a
 * cache is only an optimization.
 * @param {string} path
 * @param {object} record
 * @param {string | null} [cacheDir]
 * @returns {boolean} whether the write succeeded
 */
export function writeCache(path, record, cacheDir = null) {
  try {
    if (cacheDir) mkdirSync(cacheDir, { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}
