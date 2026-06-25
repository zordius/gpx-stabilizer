// Compute module "drift" — detect stationary satellite-signal drift (typically a person stopped
// indoors): a contiguous time run where the heading is random (`wander` high) but the altitude is
// flat (`|vs|` low). The receiver isn't going anywhere, yet the reported position scatters — so the
// horizontal speed lies (drift fakes it) while the vertical axis stays honest. Those points are not
// real positions, so the whole run is dropped; the drop context carries the SEGMENT (id, time span,
// point count, centroid) so a later stage can collapse it into one `stay` marker rather than just
// discarding it. Thresholds are tunable via opts (flow through `g.DRIFT_*`).

export const compute = (ctx) => {
  const { n, t, x, y, wander, vs, g } = ctx;
  const wHi = g.DRIFT_WANDER ?? 0.5; //   random heading (circular variance)
  const vLo = g.DRIFT_VS ?? 0.2; //       flat altitude (m/s) — the clean tell, drift can't fake it
  const gap = g.DRIFT_GAP ?? 60; //       merge rest-like points within this many seconds
  const minDur = g.DRIFT_MIN ?? 120; //   a drift segment must last at least this long (s)

  const isDrift = (k) => wander[k] > wHi && Math.abs(vs[k]) < vLo;
  const drift = new Array(n).fill(null);
  const drop = new Array(n).fill(null);

  let run = []; // indices of the current candidate run of rest-like points
  let segId = 0;
  const flush = () => {
    if (run.length && t[run[run.length - 1]] - t[run[0]] >= minDur) {
      let sx = 0;
      let sy = 0;
      for (const k of run) {
        sx += x[k];
        sy += y[k];
      }
      const seg = {
        seg: segId++,
        t0: t[run[0]],
        t1: t[run[run.length - 1]],
        dur: t[run[run.length - 1]] - t[run[0]],
        npt: run.length,
        cx: sx / run.length, // centroid — where the receiver actually sat
        cy: sy / run.length,
      };
      for (const k of run) {
        drift[k] = seg;
        drop[k] = seg;
      }
    }
    run = [];
  };
  for (let k = 0; k < n; k++) {
    if (!isDrift(k)) continue;
    if (run.length && t[k] - t[run[run.length - 1]] > gap) flush(); // time gap too big -> new run
    run.push(k);
  }
  flush();
  return { drift, drop };
};
