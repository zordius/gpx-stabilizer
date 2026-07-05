// Grouping policy for gpx-from-gopro: decide which extracted files merge into one
// GPX and how their points split into <trkseg>s. Kept pure (no IO) so it is unit
// testable; the CLI does the extraction/timezone/skip work and hands entries here.
import { basename } from "node:path";

const PLACEHOLDER = (p) => p.lat === 0 && p.lon === 0; // null-island pre-lock fix

// A single continuous recording's kept points are contiguous (chapter rollover is ~1 s); only a
// real break — a stop/restart a shared file-number missed, or a GPS-fix dropout that left no
// surviving points — exceeds this. Split there into a new <trkseg>. See buildGroups (signal A).
const BIG_GAP_MS = 120_000;

/**
 * Camera "family" from a GoPro filename: the coarse identity used when a file has
 * no body serial. A session's first file (GOPR####) and its continuation chapters
 * (GP01####, GP02####…) share the "GOPR" family; GX/GH are the newer scheme.
 * @param {string} file
 * @returns {string}
 */
export function family(file) {
  const b = basename(file).toUpperCase();
  if (/^GOPR\d+\./.test(b)) return "GOPR";
  if (/^GP\d\d\d+\./.test(b)) return "GOPR";
  if (/^GX\d\d\d+\./.test(b)) return "GX";
  if (/^GH\d\d\d+\./.test(b)) return "GH";
  const m = b.match(/^([A-Z]+)/);
  return m ? m[1] : "MISC";
}

/**
 * GoPro recording "file-number": the 4-digit id a recording's chapters share, so it keys a
 * recording session. `GOPR5134` / `GP015134` → "5134"; `GX015131` / `GX115131` → "5131" (the
 * leading 2 digits are the chapter index). A new recording — or a crash restart — gets a fresh
 * number. Null when the name has no 4-digit tail (an unknown scheme falls back to a time split).
 * @param {string} file
 * @returns {string | null}
 */
export function fileNumber(file) {
  const m = basename(file).match(/(\d{4})\.[^.]+$/);
  return m ? m[1] : null;
}

/**
 * @typedef {object} GroupEntry one extracted file's grouping inputs
 * @property {string} family    filename family (see {@link family})
 * @property {string} date      local date YYYYMMDD
 * @property {string | null} serial    body serial (udta CAME), or null
 * @property {string | null} session   recording id = filename file-number (a recording's
 *   chapters share it; a new recording / crash restart gets a new one), or null
 * @property {import("gpx-stabilizer").TrackPoint[]} points
 * @property {string} [file]    source video path — optional, unused by buildGroups() itself,
 *   carried through for organize.js's planMove() (see ./organize.js)
 */

/**
 * @typedef {object} GpxGroup one output GPX
 * @property {string} name      file stem (no extension)
 * @property {import("gpx-stabilizer").TrackPoint[][]} segments  one per <trkseg>
 * @property {number | null} startMs  earliest real fix (epoch ms), for meta.time
 */

/**
 * Merge key = (camera, day): serial when known (two same-model bodies stay separate), else
 * filename family. Exported so organize.js's planMove() can look a file's name up in the Map
 * groupNames() returns, without recomputing the key by a possibly-drifted copy.
 * @param {GroupEntry} e
 * @returns {string}
 */
export function gkeyOf(e) {
  return e.serial ? `${e.date}|s:${e.serial}` : `${e.date}|f:${e.family}`;
}

/**
 * The output name for each file's merge group (camera+day) — `<date>-<family>`, disambiguated
 * with a short serial suffix only when two cameras collide on the same family+date. This is
 * exactly the naming buildGroups() gives its `.gpx` files; exported so organize.js's planMove()
 * can name mp4 folders identically without re-deriving the same logic (and risking drift).
 * @param {GroupEntry[]} entries
 * @returns {Map<string, string>} gkey -> name
 */
export function groupNames(entries) {
  const seen = new Map(); // gkey -> { date, family, serial }
  for (const e of entries) {
    const gkey = gkeyOf(e);
    if (!seen.has(gkey))
      seen.set(gkey, { date: e.date, family: e.family, serial: e.serial ?? null });
  }
  const clash = new Map(); // "date-family" -> distinct group count
  for (const g of seen.values()) {
    const base = `${g.date}-${g.family}`;
    clash.set(base, (clash.get(base) ?? 0) + 1);
  }
  const names = new Map();
  for (const [gkey, g] of seen) {
    const base = `${g.date}-${g.family}`;
    names.set(gkey, clash.get(base) > 1 && g.serial ? `${base}-${g.serial.slice(0, 8)}` : base);
  }
  return names;
}

/**
 * Group extracted files into output GPX tracks.
 *
 * - **Merge key = (camera, day).** Camera is the body `serial` (udta CAME) when
 *   known — so two same-model bodies shot the same day stay separate — and the
 *   filename `family` otherwise. `date` keeps each group to a single day, so a
 *   session GoPro split across a crash (several files, same serial+date) is
 *   rejoined into the day's file.
 * - **Segments = recording sessions**, split by two composed signals:
 *   - **(B) file-number** — the primary key: a recording's chapters share it, so they merge;
 *     a new recording or a crash restart gets a new number, so it splits. (Replaces the old
 *     udta-GUMI key, which is per-chapter on some bodies (Hero10) and over-splits — see
 *     TODO.md.) `session` is null when the filename has no parseable number.
 *   - **(A) time gap** — a refinement applied *within* each file-number: a jump > BIG_GAP_MS
 *     between kept points starts a new segment (a same-number restart, or a dropout hole). It
 *     only ever sub-splits, never merges across file-numbers; for files with no number it is the
 *     sole clusterer (they share one fallback bucket that A then cleaves by time).
 *   A crash still lands in the one daily file (merge key is serial+date) as a separate segment.
 * - Placeholder (0,0) pre-lock fixes are dropped per segment; a session that never
 *   locks drops to empty, and a group with no real fix lands in `skipped`.
 *
 * @param {GroupEntry[]} entries
 * @returns {{ groups: GpxGroup[], skipped: string[] }}
 */
export function buildGroups(entries) {
  const names = groupNames(entries);
  // gkey -> sessions: Map<fileNumber, points[]>
  const groups = new Map();
  for (const e of entries) {
    const gkey = gkeyOf(e);
    if (!groups.has(gkey)) groups.set(gkey, { sessions: new Map() });
    const sessions = groups.get(gkey).sessions;
    // (B) bucket by file-number; files with none share one fallback bucket that (A) below splits.
    const skey = e.session ?? "__nofilenum__";
    if (!sessions.has(skey)) sessions.set(skey, []);
    // loop-push, not push(...points): a file can carry tens of thousands of points
    // and spreading that many args overflows the call stack.
    const bucket = sessions.get(skey);
    for (const p of e.points) bucket.push(p);
  }

  const out = [];
  const skipped = [];
  for (const [gkey, g] of groups) {
    const name = names.get(gkey);
    const segments = [];
    for (const pts of g.sessions.values()) {
      const clean = pts.filter((p) => !PLACEHOLDER(p));
      if (clean.length === 0) continue;
      clean.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
      // (A) sub-split this session wherever consecutive kept points jump more than BIG_GAP_MS.
      let run = [clean[0]];
      for (let i = 1; i < clean.length; i++) {
        if ((clean[i].time ?? 0) - (clean[i - 1].time ?? 0) > BIG_GAP_MS) {
          segments.push(run);
          run = [];
        }
        run.push(clean[i]);
      }
      segments.push(run);
    }
    if (segments.length === 0) {
      skipped.push(name);
      continue;
    }
    // order segments by start time so the day's trksegs read chronologically
    segments.sort((A, B) => (A[0].time ?? 0) - (B[0].time ?? 0));
    let startMs = null;
    for (const seg of segments) {
      for (const p of seg) {
        if (p.time != null && (startMs === null || p.time < startMs)) startMs = p.time;
      }
    }
    out.push({ name, segments, startMs });
  }
  return { groups: out, skipped };
}
