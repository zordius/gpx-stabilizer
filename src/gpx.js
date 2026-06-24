import { readFileSync } from "node:fs";

/**
 * @typedef {object} TrackPoint
 * @property {number} lat        latitude in degrees
 * @property {number} lon        longitude in degrees
 * @property {number | null} ele  elevation in metres, or null if absent
 * @property {number | null} time milliseconds since the Unix epoch (UTC), or null if absent
 */

/**
 * File-level metadata worth preserving in the output. All values are raw strings (as they
 * appear in the source) or null when absent.
 * @typedef {object} Meta
 * @property {string | null} creator software that produced the source (`<gpx creator>`)
 * @property {string | null} name     track name (`<metadata>` name, falling back to `<trk>`)
 * @property {string | null} time     start time, ISO 8601 (`<metadata><time>`)
 * @property {string | null} type     activity type, e.g. "ski" (`<trk><type>`)
 */

/**
 * @typedef {object} Track
 * @property {TrackPoint[][]} segments one array of points per <trkseg>, in document order
 * @property {Meta} meta               preserved file-level metadata
 */

const LAT_RE = /\blat\s*=\s*["']([^"']+)["']/;
const LON_RE = /\blon\s*=\s*["']([^"']+)["']/;
const ELE_RE = /<ele>\s*([^<]*?)\s*<\/ele>/;
const TIME_RE = /<time>\s*([^<]*?)\s*<\/time>/;
const TRKSEG_RE = /<trkseg\b[^>]*>([\s\S]*?)<\/trkseg>/gi;
const TRKPT_RE = /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/gi;

const CREATOR_RE = /<gpx\b[^>]*\bcreator\s*=\s*["']([^"']*)["']/i;
const METADATA_RE = /<metadata\b[^>]*>([\s\S]*?)<\/metadata>/i;
const TRK_HEAD_RE = /<trk\b[^>]*>([\s\S]*?)<trkseg\b/i;
const NAME_RE = /<name>\s*([^<]*?)\s*<\/name>/i;
const META_TIME_RE = /<time>\s*([^<]*?)\s*<\/time>/i;
const TYPE_RE = /<type>\s*([^<]*?)\s*<\/type>/i;

/** First capture group of `re` in `text`, or null. */
function pick(text, re) {
  const m = text ? re.exec(text) : null;
  return m ? m[1] : null;
}

/** Extract preserved file-level metadata. */
function parseMeta(xml) {
  const metaBlock = pick(xml, METADATA_RE) ?? "";
  const trkHead = pick(xml, TRK_HEAD_RE) ?? "";
  return {
    creator: pick(xml, CREATOR_RE),
    name: pick(metaBlock, NAME_RE) ?? pick(trkHead, NAME_RE),
    time: pick(metaBlock, META_TIME_RE),
    // <type> may sit after <trkseg> (e.g. FitoTrack); trkpts carry no <type>, so scan the doc.
    type: pick(xml, TYPE_RE),
  };
}

/**
 * Parse GPX text into track segments plus preserved metadata. Zero-dependency and
 * regex-based: it reads the regular `<trkpt>` structure that real devices and apps emit,
 * not arbitrary XML.
 *
 * Trackpoints are grouped by `<trkseg>` (in document order, across all `<trk>`s). If the
 * file has no `<trkseg>`, every `<trkpt>` is returned as a single segment.
 *
 * @param {string} xml GPX file contents
 * @returns {Track}
 */
export function parseGpx(xml) {
  if (typeof xml !== "string") {
    throw new TypeError("parseGpx expects a string");
  }
  const segChunks = [...xml.matchAll(TRKSEG_RE)].map((m) => m[1]);
  const chunks = segChunks.length > 0 ? segChunks : [xml];
  const segments = [];
  for (const chunk of chunks) {
    const points = [];
    for (const m of chunk.matchAll(TRKPT_RE)) {
      const attrs = m[1];
      const inner = m[2] ?? "";
      const lat = LAT_RE.exec(attrs);
      const lon = LON_RE.exec(attrs);
      if (lat === null || lon === null) continue;
      const latN = Number.parseFloat(lat[1]);
      const lonN = Number.parseFloat(lon[1]);
      if (Number.isNaN(latN) || Number.isNaN(lonN)) continue;
      const eleM = ELE_RE.exec(inner);
      const timeM = TIME_RE.exec(inner);
      const ele = eleM ? Number.parseFloat(eleM[1]) : Number.NaN;
      const time = timeM ? Date.parse(timeM[1]) : Number.NaN;
      points.push({
        lat: latN,
        lon: lonN,
        ele: Number.isNaN(ele) ? null : ele,
        time: Number.isNaN(time) ? null : time,
      });
    }
    if (points.length > 0) segments.push(points);
  }
  return { segments, meta: parseMeta(xml) };
}

/**
 * Read a GPX file from disk and parse it.
 * @param {string} path
 * @returns {Track}
 */
export function readGpx(path) {
  return parseGpx(readFileSync(path, "utf8"));
}
