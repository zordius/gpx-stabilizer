// Compute module "liftSnap" — FINALIZE phase, opt-in (ski mode only). Geometric reconstruction for
// runs `liftConfirm` actually confirmed as `lift` (reads `point.liftConfirm?.type === "lift"`, NOT
// `point.segment.type` — a fake/rejected lift must never get snapped). Must run AFTER `liftConfirm`
// in the `modules` array.
//
// Ported from the same pre-rewrite Python prototype as `liftConfirm` (SPEC.md "Prior art for the
// follow-ons above", 2026-07-07). Two physical premises about a real cable line:
//   1. It is a straight line (in the horizontal plane) — every point on a confirmed lift run gets
//      orthogonally projected onto that run's own best-fit line.
//   2. It never travels backward, only pauses — walk the along-line projection in time order and
//      require it non-decreasing; a point that would go backward is not deleted, it is reinterpreted
//      as a pause AT the lift's actual position (moved onto the current "high-water" anchor point,
//      in lat, lon, AND elevation) rather than discarded as noise.
//
// Emits a namespaced signal, `point.liftSnap = { lat, lon, ele? }` — never mutates the point itself
// (same non-destructive convention as `mods/smooth.js`/`mods/gradeBound.js`'s `point.smooth.ele` /
// `point.gradeBound.ele`). `ele` is present ONLY for a point moved onto an anchor (the pause case);
// every snapped point gets `lat`/`lon`, since the line-projection touches all of them. `stabilize`'s
// `opts.liftSnap` decides whether the export actually uses this signal (see stabilize.js).
//
// Fade at the run's own boundaries (2026-07-07): `liftConfirm`'s ⓪ trim step gives a run a hard
// start/end, but the real cable line doesn't begin/end exactly there — the last raw-position point
// before the confirmed core and the first fully-snapped point right after it would otherwise show a
// visible jump. So the snap weight ramps 0->1 over the first `LIFTSNAP_FADE_M` metres of along-line
// travel, and 1->0 over the last, blending the snapped position toward the point's own raw position
// near either end rather than snapping it outright.

import { unproject } from "../measure.js";

const LIFTSNAP_FADE_M = 20; // metres of along-line travel over which the snap weight ramps 0<->1

function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function lerp(a, b, w) {
  return a + w * (b - a);
}

// Group points by their (already contiguous, time-ordered) `segment.id` into per-run point arrays.
function groupRuns(points) {
  const map = new Map();
  for (const p of points) {
    if (!map.has(p.segment.id)) map.set(p.segment.id, []);
    map.get(p.segment.id).push(p);
  }
  return [...map.values()];
}

export const finalize = (out, ctx) => {
  const g = ctx.g ?? {};
  const fadeM = g.LIFTSNAP_FADE_M ?? LIFTSNAP_FADE_M;
  const confirmed = out.filter((p) => p.liftConfirm?.type === "lift");
  if (confirmed.length === 0) return;

  for (const run of groupRuns(confirmed)) {
    if (run.length < 3) continue; // too few points for a line fit to mean anything

    // total-least-squares line fit (2x2 covariance eigen-decomposition -> principal direction)
    const mx = mean(run.map((p) => p.x));
    const my = mean(run.map((p) => p.y));
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const p of run) {
      const dx = p.x - mx;
      const dy = p.y - my;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let ux = Math.cos(theta);
    let uy = Math.sin(theta);

    // along-line signed projection, oriented so travel goes first -> last (matches time order)
    const s = run.map((p) => (p.x - mx) * ux + (p.y - my) * uy);
    if (s.at(-1) < s[0]) {
      ux = -ux;
      uy = -uy;
      for (let i = 0; i < s.length; i++) s[i] = -s[i];
    }
    const snapped = s.map((si) => ({ x: mx + si * ux, y: my + si * uy }));

    // snap weight: 0 at either end of the run, ramping to 1 over fadeM metres of along-line travel
    // — blends the snapped position toward the point's own raw position near the boundaries instead
    // of snapping it outright (see module doc).
    const s0 = s[0];
    const sN = s.at(-1);
    const weightAt = (si) => {
      if (fadeM <= 0) return 1; // no fade distance -> always fully snapped (avoid a 0/0 at si === s0)
      const fromStart = si - s0;
      const fromEnd = sN - si;
      return Math.max(0, Math.min(1, Math.min(fromStart, fromEnd) / fadeM));
    };

    // a lift never travels backward, only pauses: walk `s` non-decreasing; a would-be-backward
    // point moves onto the current high-water anchor (lat, lon, AND elevation), also faded
    let smax = Number.NEGATIVE_INFINITY;
    let anchor = null;
    for (let i = 0; i < run.length; i++) {
      const w = weightAt(s[i]);
      const p = run[i];
      if (s[i] >= smax - 1e-6) {
        smax = Math.max(smax, s[i]);
        const bx = lerp(p.x, snapped[i].x, w);
        const by = lerp(p.y, snapped[i].y, w);
        anchor = { x: bx, y: by, ele: p.ele };
        p.liftSnap = unproject(bx, by, ctx.lat0, ctx.lon0);
      } else {
        const bx = lerp(p.x, anchor.x, w);
        const by = lerp(p.y, anchor.y, w);
        p.liftSnap = { ...unproject(bx, by, ctx.lat0, ctx.lon0), ele: lerp(p.ele, anchor.ele, w) };
      }
    }
  }
};
