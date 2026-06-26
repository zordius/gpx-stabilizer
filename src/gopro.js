// Extract a GoPro video's GPS track as package TrackPoints
// ({ lat, lon, ele, time, speed }). Uses gpmf-extract to pull the GPMF 'gpmd'
// track and gopro-telemetry to interpret it. The MP4 is streamed to mp4box in
// blocks so multi-GB files never load whole into RAM. No filtering: every GPS
// sample is kept (including pre-lock 0,0 points), matching the exiftool path.
import { open } from "node:fs/promises";
import goproTelemetry from "gopro-telemetry";
import gpmfExtract from "gpmf-extract";

const CHUNK = 1 << 24; // 16 MiB read blocks

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
