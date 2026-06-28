// Grouping policy for gpx-from-gopro: decide which extracted files merge into one
// GPX and how their points split into <trkseg>s. Kept pure (no IO) so it is unit
// testable; the CLI does the extraction/timezone/skip work and hands entries here.
import { basename } from "node:path";

const PLACEHOLDER = (p) => p.lat === 0 && p.lon === 0; // null-island pre-lock fix

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
 * @typedef {object} GroupEntry one extracted file's grouping inputs
 * @property {string} family    filename family (see {@link family})
 * @property {string} date      local date YYYYMMDD
 * @property {string | null} serial    body serial (udta CAME), or null
 * @property {string | null} mediaId   recording-session id (udta GUMI), or null
 * @property {import("gpx-stabilizer").TrackPoint[]} points
 */

/**
 * @typedef {object} GpxGroup one output GPX
 * @property {string} name      file stem (no extension)
 * @property {import("gpx-stabilizer").TrackPoint[][]} segments  one per <trkseg>
 * @property {number | null} startMs  earliest real fix (epoch ms), for meta.time
 */

/**
 * Group extracted files into output GPX tracks.
 *
 * - **Merge key = (camera, day).** Camera is the body `serial` (udta CAME) when
 *   known — so two same-model bodies shot the same day stay separate — and the
 *   filename `family` otherwise. `date` keeps each group to a single day, so a
 *   session GoPro split across a crash (several files, same serial+date) is
 *   rejoined into the day's file.
 * - **Segments = recording sessions.** Within a group, points split into one
 *   segment per `mediaId` (udta GUMI): an uncrashed activity is one segment, a
 *   crash (new GUMI) shows as a segment break — all still in the one daily file.
 *   Files with no GUMI share a single fallback segment (the old one-segment shape).
 * - Placeholder (0,0) pre-lock fixes are dropped per segment; a session that never
 *   locks drops to empty, and a group with no real fix lands in `skipped`.
 *
 * @param {GroupEntry[]} entries
 * @returns {{ groups: GpxGroup[], skipped: string[] }}
 */
export function buildGroups(entries) {
  // gkey -> { date, family, serial, segs: Map<sessionKey, points[]> }
  const groups = new Map();
  for (const e of entries) {
    const gkey = e.serial ? `${e.date}|s:${e.serial}` : `${e.date}|f:${e.family}`;
    if (!groups.has(gkey)) {
      groups.set(gkey, {
        date: e.date,
        family: e.family,
        serial: e.serial ?? null,
        segs: new Map(),
      });
    }
    const segs = groups.get(gkey).segs;
    const skey = e.mediaId ?? "__nogumi__";
    if (!segs.has(skey)) segs.set(skey, []);
    // loop-push, not push(...points): a file can carry tens of thousands of points
    // and spreading that many args overflows the call stack.
    const bucket = segs.get(skey);
    for (const p of e.points) bucket.push(p);
  }

  // Name a group <date>-<family>; only when two cameras collide on the same
  // family+date do we disambiguate with a short serial suffix, so the common
  // single-camera case keeps the readable name.
  const clash = new Map(); // "date-family" -> distinct group count
  for (const g of groups.values()) {
    const base = `${g.date}-${g.family}`;
    clash.set(base, (clash.get(base) ?? 0) + 1);
  }

  const out = [];
  const skipped = [];
  for (const g of groups.values()) {
    const base = `${g.date}-${g.family}`;
    const name = clash.get(base) > 1 && g.serial ? `${base}-${g.serial.slice(0, 8)}` : base;
    const segments = [];
    for (const pts of g.segs.values()) {
      const clean = pts.filter((p) => !PLACEHOLDER(p));
      if (clean.length === 0) continue;
      clean.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
      segments.push(clean);
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
