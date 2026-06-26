import { readFileSync, writeFileSync } from "node:fs";

/**
 * @typedef {object} TrackPoint
 * @property {number} lat        latitude in degrees
 * @property {number} lon        longitude in degrees
 * @property {number | null} ele  elevation in metres, or null if absent
 * @property {number | null} time milliseconds since the Unix epoch (UTC), or null if absent
 * @property {number | null} speed device-reported speed in m/s (GPX `<speed>`), or null if absent
 */

/**
 * File-level metadata worth preserving in the output. All values are strings (decoded from
 * the source) or null when absent.
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
const SPEED_RE = /<speed>\s*([^<]*?)\s*<\/speed>/; // device speed (m/s), often inside <extensions>
const TRKSEG_RE = /<trkseg\b[^>]*>([\s\S]*?)<\/trkseg>/gi;
const TRKPT_RE = /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/gi;

const CREATOR_RE = /<gpx\b[^>]*\bcreator\s*=\s*["']([^"']*)["']/i;
const METADATA_RE = /<metadata\b[^>]*>([\s\S]*?)<\/metadata>/i;
const TRK_HEAD_RE = /<trk\b[^>]*>([\s\S]*?)<trkseg\b/i;
const NAME_RE = /<name>\s*([^<]*?)\s*<\/name>/i;
const META_TIME_RE = /<time>\s*([^<]*?)\s*<\/time>/i;
const TYPE_RE = /<type>\s*([^<]*?)\s*<\/type>/i;

const GPX_NS = "http://www.topografix.com/GPX/1/1";

/** First capture group of `re` in `text`, or null. */
function pick(text, re) {
  const m = text ? re.exec(text) : null;
  return m ? m[1] : null;
}

/** Decode the five predefined XML entities. */
function xmlDecode(s) {
  if (s === null) return null;
  return s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/** Encode text for XML (`&` first). */
function xmlEncode(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Cap precision and drop trailing zeros. */
function fmt(n, digits) {
  return Number(n.toFixed(digits)).toString();
}

/** Epoch ms → ISO 8601 at 0.1 s precision (one sub-second digit); a whole second drops the fraction. */
function isoTime(ms) {
  const iso = new Date(Math.round(ms / 100) * 100).toISOString(); // round to a tenth of a second
  return iso.replace(/\.(\d)\d\dZ$/, (_, d) => (d === "0" ? "Z" : `.${d}Z`));
}

/** Extract preserved file-level metadata. */
function parseMeta(xml) {
  const metaBlock = pick(xml, METADATA_RE) ?? "";
  const trkHead = pick(xml, TRK_HEAD_RE) ?? "";
  return {
    creator: xmlDecode(pick(xml, CREATOR_RE)),
    name: xmlDecode(pick(metaBlock, NAME_RE) ?? pick(trkHead, NAME_RE)),
    time: xmlDecode(pick(metaBlock, META_TIME_RE)),
    // <type> may sit after <trkseg> (e.g. FitoTrack); trkpts carry no <type>, so scan the doc.
    type: xmlDecode(pick(xml, TYPE_RE)),
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
      const speedM = SPEED_RE.exec(inner);
      const ele = eleM ? Number.parseFloat(eleM[1]) : Number.NaN;
      const time = timeM ? Date.parse(timeM[1]) : Number.NaN;
      const speed = speedM ? Number.parseFloat(speedM[1]) : Number.NaN;
      points.push({
        lat: latN,
        lon: lonN,
        ele: Number.isNaN(ele) ? null : ele,
        time: Number.isNaN(time) ? null : time,
        speed: Number.isNaN(speed) ? null : speed,
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

/**
 * Serialize a parsed track to a GPX 1.1 string, reproducing the preserved metadata.
 * The output `creator` defaults to the source's (so provenance is kept); override via opts.
 *
 * @param {Track} track
 * @param {{ creator?: string, latlonDigits?: number, eleDigits?: number, speedDigits?: number }} [opts]
 * @returns {string}
 */
export function writeGpx(track, opts = {}) {
  const { segments = [], meta = {} } = track ?? {};
  const creator = opts.creator ?? meta.creator ?? "gpx-stabilizer";
  const llDigits = opts.latlonDigits ?? 7;
  const eleDigits = opts.eleDigits ?? 2;
  const speedDigits = opts.speedDigits ?? 2;

  const out = ['<?xml version="1.0" encoding="UTF-8"?>'];
  out.push(`<gpx version="1.1" creator="${xmlEncode(creator)}" xmlns="${GPX_NS}">`);

  const metaLines = [];
  if (meta.name != null) metaLines.push(`    <name>${xmlEncode(meta.name)}</name>`);
  if (meta.time != null) metaLines.push(`    <time>${xmlEncode(meta.time)}</time>`);
  if (metaLines.length > 0) out.push("  <metadata>", ...metaLines, "  </metadata>");

  out.push("  <trk>");
  if (meta.name != null) out.push(`    <name>${xmlEncode(meta.name)}</name>`);
  if (meta.type != null) out.push(`    <type>${xmlEncode(meta.type)}</type>`);
  for (const seg of segments) {
    out.push("    <trkseg>");
    for (const p of seg) {
      let pt = `      <trkpt lat="${fmt(p.lat, llDigits)}" lon="${fmt(p.lon, llDigits)}">`;
      if (p.ele != null) pt += `<ele>${fmt(p.ele, eleDigits)}</ele>`;
      if (p.time != null) pt += `<time>${isoTime(p.time)}</time>`;
      // Device speed (m/s) goes in <extensions> (not a standard GPX 1.1 trkpt child); parseGpx reads it back.
      if (p.speed != null)
        pt += `<extensions><speed>${fmt(p.speed, speedDigits)}</speed></extensions>`;
      out.push(`${pt}</trkpt>`);
    }
    out.push("    </trkseg>");
  }
  out.push("  </trk>", "</gpx>", "");
  return out.join("\n");
}

/**
 * Serialize a parsed track and write it to a GPX file.
 * @param {Track} track
 * @param {string} path
 * @param {{ creator?: string, latlonDigits?: number, eleDigits?: number, speedDigits?: number }} [opts]
 */
export function saveGpx(track, path, opts) {
  writeFileSync(path, writeGpx(track, opts));
}
