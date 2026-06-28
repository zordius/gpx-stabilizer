// Extract a GoPro video's GPS track as package TrackPoints
// ({ lat, lon, ele, time, speed, fix, hdop, cts }). Uses gpmf-extract to pull the
// GPMF 'gpmd' track and gopro-telemetry to interpret it. The MP4 is streamed to
// mp4box in blocks so multi-GB files never load whole into RAM. No filtering:
// every GPS sample is kept (including pre-lock 0,0 points), matching the exiftool
// path. `cts` is the sample's media offset (ms from stream start) — the x-axis a
// consumer regresses UTC against to recover the true recording start (see
// telemetry.js regressStartUtc).
import { open } from "node:fs/promises";
import goproTelemetry from "gopro-telemetry";
import gpmfExtract from "gpmf-extract";
import MP4Box from "mp4box";

const CHUNK = 1 << 24; // 16 MiB read blocks
const PROBE_CHUNK = 1 << 16; // 64 KiB — enough to reach moov via mp4box's seek hints

// GPSF lock type (0 none / 2 2D / 3 3D) -> GPX <fix> token
function gpsFix(n) {
  return n === 3 ? "3d" : n === 2 ? "2d" : n === 0 ? "none" : null;
}

// gpmf-extract's Node "function" input mode: it hands us the mp4box file object
// and we feed the bytes ourselves, so we control memory for huge files.
function fileFeeder(path) {
  return async (mp4boxFile) => {
    const fh = await open(path, "r");
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      let offset = 0;
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, CHUNK, offset);
        if (bytesRead === 0) break;
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead);
        ab.fileStart = offset; // mp4box needs the absolute offset of each block
        mp4boxFile.appendBuffer(ab);
        offset += bytesRead;
      }
      mp4boxFile.flush();
    } finally {
      await fh.close();
    }
  };
}

// GoPro firmware prefix → camera model. HD5 / H21 verified against real files; the rest follow
// GoPro's documented firmware scheme (HD6–HD9 = HERO6–9, H22–H24 = HERO11–13).
const GOPRO_MODEL = {
  HD5: "HERO5",
  HD6: "HERO6",
  HD7: "HERO7",
  HD8: "HERO8",
  HD9: "HERO9",
  H21: "HERO10",
  H22: "HERO11",
  H23: "HERO12",
  H24: "HERO13",
};

/**
 * Camera model from a GoPro `FIRM` firmware string (e.g. "HD5.02.02.60.00" → "HERO5").
 * @param {string | null} firmware
 * @returns {string | null}  null for missing/unknown firmware
 */
export function goproModel(firmware) {
  return firmware ? (GOPRO_MODEL[firmware.slice(0, 3)] ?? null) : null;
}

/**
 * Read a GoPro `udta` atom's string from a moov-region buffer. GoPro stores camera info as
 * custom atoms `[4-byte BE size][4CC][ASCII data]` inside `udta` (FIRM=firmware, CAME=serial,
 * LENS, …) — non-standard boxes mp4box doesn't decode, so read them straight from the bytes.
 * @param {Buffer} buf     bytes covering the moov (including udta)
 * @param {string} fourcc  e.g. "FIRM"
 * @returns {string | null}
 */
export function readUdtaRaw(buf, fourcc) {
  const i = buf.indexOf(fourcc, 0, "latin1");
  if (i < 4) return null;
  const size = buf.readUInt32BE(i - 4); // the 4 bytes before the 4CC are the atom's byte size
  if (size < 8 || i - 4 + size > buf.length) return null;
  return buf.subarray(i + 4, i - 4 + size);
}

/**
 * A GoPro `udta` atom read as a trimmed ASCII string (`FIRM`, `LENS`, …), or null.
 * @param {Buffer} buf
 * @param {string} fourcc
 * @returns {string | null}
 */
export function readUdtaAtom(buf, fourcc) {
  const d = readUdtaRaw(buf, fourcc);
  return d ? d.toString("latin1").replace(/\0+$/, "").trim() || null : null;
}

// Parse the `HMMT` atom (GoPro highlight tags = the times the user pressed the tag button): a u32
// count, then that many u32 millisecond offsets. [TBC] format inferred from a count=0 sample; not
// verified against a clip with real highlights.
function parseHighlights(buf) {
  if (!buf || buf.length < 4) return [];
  const n = buf.readUInt32BE(0);
  const out = [];
  for (let k = 0; k < n && 8 + k * 4 <= buf.length; k++) out.push(buf.readUInt32BE(4 + k * 4));
  return out;
}

/**
 * @typedef {object} GoproMeta
 * @property {boolean} hasGps      whether a GPMF 'gpmd' track with samples is present
 * @property {number} gpmdSamples  number of gpmd payloads (GPS data chunks)
 * @property {number | null} width  video width in pixels
 * @property {number | null} height video height in pixels
 * @property {string | null} codec  video codec (e.g. "avc1.64002a")
 * @property {number | null} fps    video frame rate
 * @property {number | null} durationS video duration in seconds
 * @property {string | null} firmware  GoPro firmware string (e.g. "HD5.02.02.60.00"), or null
 * @property {string | null} model     camera model from the firmware (e.g. "HERO5"), or null
 * @property {string | null} serial    camera serial (udta `CAME`, hex) — tells two same-model bodies apart
 * @property {string | null} mediaId   global media id (udta `GUMI`, hex) — links a recording's chapter files
 * @property {number[]} highlights     user highlight-tag offsets in ms (udta `HMMT`); [] if none
 */

/**
 * Read only the MP4 moov to report the metadata we use, without extracting any
 * samples. mp4box's appendBuffer returns the next byte offset it needs, which
 * skips past the (multi-GB) mdat straight to the moov — so this reads on the
 * order of the moov size (tens of KB to ~1 MB), not the whole file. Use the
 * returned `hasGps` as a cheap gate before the full (expensive) extraction.
 * @param {string} path
 * @returns {Promise<GoproMeta>}
 */
export async function probeGoproMeta(path) {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const file = MP4Box.createFile();
    let info = null;
    let error = null;
    file.onReady = (i) => {
      info = i;
    };
    file.onError = (e) => {
      error = e;
    };
    const buf = Buffer.allocUnsafe(PROBE_CHUNK);
    const moovChunks = []; // keep the moov-region bytes mp4box reads, to find GoPro's udta/FIRM
    let pos = 0;
    while (pos < size && info === null && error === null) {
      const { bytesRead } = await fh.read(buf, 0, PROBE_CHUNK, pos);
      if (bytesRead === 0) break;
      moovChunks.push(Buffer.from(buf.subarray(0, bytesRead))); // copy: buf is reused next loop
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead);
      ab.fileStart = pos; // absolute offset; mp4box uses it to place the block
      const next = file.appendBuffer(ab);
      // mp4box tells us where it wants data next — this hops over mdat to the moov
      pos = typeof next === "number" && next > pos ? next : pos + bytesRead;
    }
    if (error !== null) throw new Error(`mp4 parse failed: ${error}`);
    const tracks = info?.tracks ?? [];
    const gpmd = tracks.find((t) => t.codec === "gpmd");
    const video = tracks.find((t) => t.type === "video") ?? tracks.find((t) => t.video);
    const durationS = info?.duration && info?.timescale ? info.duration / info.timescale : null;
    // GoPro stows camera meta in moov's udta as custom atoms — read them from the moov bytes above
    // (already in hand, ~0 extra IO): FIRM=firmware, CAME=serial, GUMI=media id, HMMT=highlight tags.
    const moov = Buffer.concat(moovChunks);
    const firmware = readUdtaAtom(moov, "FIRM");
    const came = readUdtaRaw(moov, "CAME");
    const gumi = readUdtaRaw(moov, "GUMI");
    return {
      hasGps: gpmd != null && gpmd.nb_samples > 0,
      gpmdSamples: gpmd?.nb_samples ?? 0,
      width: video?.video?.width ?? video?.track_width ?? null,
      height: video?.video?.height ?? video?.track_height ?? null,
      codec: video?.codec ?? null,
      fps: video && durationS ? video.nb_samples / durationS : null,
      durationS,
      firmware,
      model: goproModel(firmware),
      serial: came ? came.toString("hex") : null,
      mediaId: gumi ? gumi.toString("hex") : null,
      highlights: parseHighlights(readUdtaRaw(moov, "HMMT")),
    };
  } finally {
    await fh.close();
  }
}

/**
 * Extract GPS samples from a GoPro MP4 as package TrackPoints, in capture order.
 * @param {string} path
 * @param {{ rate?: number, groupTimes?: number }} [opts] rate in Hz (public knob;
 *   omit for native ~18 Hz). `groupTimes` (ms) is the internal equivalent kept for
 *   existing callers; `rate` wins when both are given (groupTimes = 1000 / rate).
 * @returns {Promise<import("gpx-stabilizer").TrackPoint[]>}
 */
export async function extractGoproPoints(path, opts = {}) {
  const groupTimes = opts.rate ? Math.round(1000 / opts.rate) : opts.groupTimes;
  const cfg = { stream: ["GPS"], ...(groupTimes ? { groupTimes } : {}) }; // auto GPS5/GPS9
  const extracted = await gpmfExtract(fileFeeder(path));
  // Two interpretations of the SAME extraction. timeOut:'date' yields the GPS UTC
  // per sample but strips cts; timeIn:'MP4'/timeOut:'cts' yields the media offset
  // (ms within the video, cts 0 = first frame) but no date. We need both — UTC for
  // `time`, media cts as the x-axis the start regression extrapolates to 0.
  const telemetry = await goproTelemetry(extracted, { ...cfg, timeIn: "GPS", timeOut: "date" });
  const mediaTel = await goproTelemetry(extracted, { ...cfg, timeIn: "MP4", timeOut: "cts" });
  return buildGpsPoints(telemetry, mediaTel);
}

/**
 * @typedef {object} GoproStream
 * @property {string | null} name   stream description (e.g. "Accelerometer")
 * @property {any} units            stream units, as gopro-telemetry reports them
 * @property {{ cts: number | null, value: any }[]} samples  media-cts-timed samples
 */

/**
 * Extract a GoPro MP4's FULL telemetry: GPS `points` plus every NON-GPS stream
 * (IMU `ACCL`/`GYRO`, `GRAV`/`CORI`, `SCEN`, exposure `SHUT`/ISO, …) as raw
 * cts-timed samples, for multi-sensor analysis. One `gpmf-extract` (the IO, done
 * once) then three cheap parse passes — reading more streams costs ~0 extra IO
 * (all streams share the one gpmd track; the filter is post-parse). `rate` /
 * `groupTimes` downsamples only the GPS `points`; **aux streams stay native**
 * (the IMU's ~200 Hz is the whole point).
 * @param {string} path
 * @param {{ rate?: number, groupTimes?: number }} [opts]
 * @returns {Promise<{ points: import("gpx-stabilizer").TrackPoint[], streams: Record<string, GoproStream> }>}
 */
export async function extractGoproAll(path, opts = {}) {
  const groupTimes = opts.rate ? Math.round(1000 / opts.rate) : opts.groupTimes;
  const cfg = { stream: ["GPS"], ...(groupTimes ? { groupTimes } : {}) };
  const extracted = await gpmfExtract(fileFeeder(path));
  const telemetry = await goproTelemetry(extracted, { ...cfg, timeIn: "GPS", timeOut: "date" });
  const mediaTel = await goproTelemetry(extracted, { ...cfg, timeIn: "MP4", timeOut: "cts" });
  // every stream (no filter), on the media-cts clock, at native rate — the aux channels
  const allTel = await goproTelemetry(extracted, { timeIn: "MP4", timeOut: "cts" });
  return { points: buildGpsPoints(telemetry, mediaTel), streams: buildAuxStreams(allTel) };
}

// Collapse every NON-GPS stream of a parsed telemetry object into raw cts-timed
// samples (GPS is excluded — it's the `points` channel, processed separately).
function buildAuxStreams(tel) {
  const out = {};
  for (const device of Object.values(tel ?? {})) {
    for (const [key, stream] of Object.entries(device?.streams ?? {})) {
      if (key.startsWith("GPS")) continue;
      out[key] = {
        name: stream.name ?? null,
        units: stream.units ?? null,
        samples: (stream.samples ?? []).map((s) => ({
          cts: typeof s.cts === "number" ? s.cts : null,
          value: s.value,
        })),
      };
    }
  }
  return out;
}

// Build GPS TrackPoints by zipping the two GPS passes: `telemetry` (timeOut:'date'
// → UTC `time`) with `mediaTel` (timeOut:'cts' → media `cts`) by sample index (same
// stream + groupTimes ⇒ same order/count; a length guard drops cts if that fails).
function buildGpsPoints(telemetry, mediaTel) {
  const mediaCts = [];
  for (const device of Object.values(mediaTel ?? {})) {
    for (const [key, stream] of Object.entries(device?.streams ?? {})) {
      if (!key.startsWith("GPS")) continue;
      for (const s of stream.samples ?? []) mediaCts.push(typeof s.cts === "number" ? s.cts : null);
    }
  }
  const points = [];
  for (const device of Object.values(telemetry ?? {})) {
    const streams = device?.streams ?? {};
    for (const [key, stream] of Object.entries(streams)) {
      if (!key.startsWith("GPS")) continue;
      // GPS5 reports fix/precision once per ~1 Hz payload as sticky values; sticky
      // semantics are "applies to all successive samples", so carry them forward
      // onto every (18 Hz) point. precision is DOP x100. GPS9 (Hero11+) instead
      // carries them per-sample in value[7..8] = [DOP, fix] — read those directly.
      const isGps9 = key === "GPS9";
      let fix = null;
      let hdop = null;
      for (const s of stream.samples ?? []) {
        const v = s.value;
        if (!Array.isArray(v)) continue;
        // GPS5 and GPS9 share value[0..3] = [lat, lon, altitude, 2D speed]
        const [lat, lon, ele, speed] = v;
        const time = s.date != null ? new Date(s.date).getTime() : Number.NaN;
        if (isGps9) {
          // value = [lat, lon, alt, 2Dspeed, 3Dspeed, days, secs, DOP, fix]
          fix = gpsFix(v[8]);
          // GPS9 DOP is already in DOP units (not x100 like GPS5's sticky.precision).
          // [TBC] exact scale unverified — no Hero11+ sample on hand to confirm.
          hdop = typeof v[7] === "number" ? v[7] : null;
        } else {
          const sticky = s.sticky ?? {};
          if (sticky.fix != null) fix = gpsFix(sticky.fix);
          if (typeof sticky.precision === "number") hdop = sticky.precision / 100;
        }
        points.push({
          lat,
          lon,
          ele: ele == null ? null : ele,
          time: Number.isNaN(time) ? null : time,
          speed: speed == null ? null : speed,
          fix,
          hdop,
          cts: null, // filled by the media-cts zip below
        });
      }
    }
  }
  // zip media cts onto the points by index; only when the two passes agree in count
  if (mediaCts.length === points.length) {
    for (let i = 0; i < points.length; i++) points[i].cts = mediaCts[i];
  }
  return points;
}
