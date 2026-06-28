// Track resampling — regularise cleaned survivors onto a uniform TIME grid, for consumers that
// sample the track at their own cadence (movie-layers reading a position per video frame). This is
// the export-layer half of "track smoothing": unlike every analyze stage (per-point — it labels /
// measures / drops the EXISTING points, so cardinality only shrinks), resample SYNTHESISES points by
// interpolation, changing cardinality and the grid — hence a track→track transform here, not a
// per-point module (analyze's assemble maps signals back by original index, which a cardinality
// change would break). Runs AFTER drops + elevation smoothing, once every decision is settled on the
// real-fix analysis grid; a resampled position is interpolated, so it is never used for IMU witness
// work (SPEC "Two grids"). A time gap longer than `maxGap` is NOT bridged — the output splits into
// separate segments there, so a hole (stop / GPS dropout / GoPro crash break) becomes a <trkseg>
// break rather than an invented straight line.

const lerp = (a, b, f) => a + (b - a) * f;

/** Linearly interpolate a point at grid time `gt` between bracketing survivors `a` (≤ gt) and `b`. */
function interpAt(a, b, gt) {
  const span = b.time - a.time;
  const f = span > 0 ? (gt - a.time) / span : 0;
  const out = {
    lat: lerp(a.lat, b.lat, f),
    lon: lerp(a.lon, b.lon, f),
    ele: a.ele != null && b.ele != null ? lerp(a.ele, b.ele, f) : (a.ele ?? b.ele ?? null),
    time: gt,
  };
  if (a.speed != null && b.speed != null) out.speed = lerp(a.speed, b.speed, f);
  return out;
}

/** Plain {lat,lon,ele,time}(+speed) copy — used where a real point passes through unchanged. */
function clone(p) {
  const out = { lat: p.lat, lon: p.lon, ele: p.ele ?? null, time: p.time };
  if (p.speed != null) out.speed = p.speed;
  return out;
}

/**
 * Resample one gap-free run onto a uniform grid of `stepMs`, anchored to absolute-time multiples of
 * the step (so grid times are round and align across segments). A run shorter than one step lands no
 * grid time — its real points are kept rather than dropped.
 */
function resampleRun(run, stepMs) {
  if (run.length === 0) return [];
  if (run.length === 1) return [clone(run[0])];
  const t0 = run[0].time;
  const tEnd = run[run.length - 1].time;
  const out = [];
  let j = 0;
  for (let gt = Math.ceil(t0 / stepMs) * stepMs; gt <= tEnd; gt += stepMs) {
    while (j < run.length - 2 && run[j + 1].time < gt) j++; // bracket: run[j].time ≤ gt ≤ run[j+1].time
    out.push(interpAt(run[j], run[j + 1], gt));
  }
  return out.length ? out : run.map(clone);
}

/**
 * Resample cleaned survivors onto a uniform time grid, splitting at gaps longer than `maxGap`.
 * @param {import("./gpx.js").TrackPoint[]} points  cleaned, time-ordered survivors
 * @param {{ RESAMPLE_HZ?: number, maxGap?: number }} [opts]
 *   `RESAMPLE_HZ` output rate (default 1 Hz); `maxGap` split threshold in seconds (default 10)
 * @returns {import("./gpx.js").TrackPoint[][]}  one or more uniform segments (split at holes)
 */
export function resample(points, opts = {}) {
  const stepMs = 1000 / (opts.RESAMPLE_HZ ?? 1);
  const maxGapMs = (opts.maxGap ?? 10) * 1000;
  const timed = points.filter((p) => p.time != null).sort((a, b) => a.time - b.time);
  if (timed.length === 0) return [];

  // split into gap-free runs at holes longer than maxGap (don't interpolate across a hole)
  const runs = [];
  let run = [timed[0]];
  for (let i = 1; i < timed.length; i++) {
    if (timed[i].time - timed[i - 1].time > maxGapMs) {
      runs.push(run);
      run = [];
    }
    run.push(timed[i]);
  }
  runs.push(run);

  return runs.map((r) => resampleRun(r, stepMs)).filter((s) => s.length > 0);
}
