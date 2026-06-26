// Extract a GoPro video's GPS track as package TrackPoints
// ({ lat, lon, ele, time, speed }). Uses gpmf-extract to pull the GPMF 'gpmd'
// track and gopro-telemetry to interpret it. The MP4 is streamed to mp4box in
// blocks so multi-GB files never load whole into RAM. No filtering: every GPS
// sample is kept (including pre-lock 0,0 points), matching the exiftool path.
import { open } from "node:fs/promises";
import goproTelemetry from "gopro-telemetry";
import gpmfExtract from "gpmf-extract";
import MP4Box from "mp4box";

const CHUNK = 1 << 24; // 16 MiB read blocks
const PROBE_CHUNK = 1 << 16; // 64 KiB — enough to reach moov via mp4box's seek hints

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

/**
 * @typedef {object} GoproMeta
 * @property {boolean} hasGps      whether a GPMF 'gpmd' track with samples is present
 * @property {number} gpmdSamples  number of gpmd payloads (GPS data chunks)
 * @property {number | null} width  video width in pixels
 * @property {number | null} height video height in pixels
 * @property {string | null} codec  video codec (e.g. "avc1.64002a")
 * @property {number | null} fps    video frame rate
 * @property {number | null} durationS video duration in seconds
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
    let pos = 0;
    while (pos < size && info === null && error === null) {
      const { bytesRead } = await fh.read(buf, 0, PROBE_CHUNK, pos);
      if (bytesRead === 0) break;
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
    return {
      hasGps: gpmd != null && gpmd.nb_samples > 0,
      gpmdSamples: gpmd?.nb_samples ?? 0,
      width: video?.video?.width ?? video?.track_width ?? null,
      height: video?.video?.height ?? video?.track_height ?? null,
      codec: video?.codec ?? null,
      fps: video && durationS ? video.nb_samples / durationS : null,
      durationS,
    };
  } finally {
    await fh.close();
  }
}

/**
 * Extract GPS samples from a GoPro MP4 as package TrackPoints, in capture order.
 * @param {string} path
 * @param {{ groupTimes?: number }} [opts] groupTimes=1000 -> ~1 Hz; omit for native ~18 Hz
 * @returns {Promise<import("./gpx.js").TrackPoint[]>}
 */
export async function extractGoproPoints(path, opts = {}) {
  const extracted = await gpmfExtract(fileFeeder(path));
  const telemetry = await goproTelemetry(extracted, {
    stream: ["GPS"], // auto-selects GPS5 (Hero5-10) or GPS9 (Hero11+)
    timeIn: "GPS", // derive sample time from GPS UTC, not the camera clock
    timeOut: "date", // we only need the per-sample date
    ...(opts.groupTimes ? { groupTimes: opts.groupTimes } : {}),
  });

  const points = [];
  for (const device of Object.values(telemetry ?? {})) {
    const streams = device?.streams ?? {};
    for (const [key, stream] of Object.entries(streams)) {
      if (!key.startsWith("GPS")) continue;
      for (const s of stream.samples ?? []) {
        const v = s.value;
        if (!Array.isArray(v)) continue;
        // GPS5 and GPS9 share value[0..3] = [lat, lon, altitude, 2D speed]
        const [lat, lon, ele, speed] = v;
        const time = s.date != null ? new Date(s.date).getTime() : Number.NaN;
        points.push({
          lat,
          lon,
          ele: ele == null ? null : ele,
          time: Number.isNaN(time) ? null : time,
          speed: speed == null ? null : speed,
        });
      }
    }
  }
  return points;
}
