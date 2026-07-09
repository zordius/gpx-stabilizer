// Compute module "tangleSnap" — FINALIZE phase, opt-in, GENERAL-PURPOSE (not ski-specific — it
// happens to be sequenced after `liftSnap` in ski mode's `modes.js`, but has no data dependency on
// it beyond preferring an already-reconstructed position when one exists).
//
// At very low speed (<= TANGLE_MAX_SPEED, default 0.6 m/s — at 1 Hz that's a point-to-point distance
// <=0.6 m), GPS jitter is often LARGER than real movement, so the raw track self-intersects into a
// scribbled tangle instead of tracing the (near-stationary) truth. Fix, per contiguous slow run:
//   1. THIN — greedy min-spacing (TANGLE_MIN_SPACING_M, default 0.6 m): keep a point only once it's
//      at least this far from the last kept one. The run's own first/last point is always kept
//      (unconditionally), so it still connects cleanly to the surrounding faster-speed track.
//   2. RE-INFLATE back to the original point count by placing new points on a constant-speed,
//      constant-turn-rate arc between each pair of kept anchors — a circular arc (curvature 0
//      degenerates to a straight line), not the raw zigzag. The arc's curvature is the average of
//      the Menger (3-point circumradius) curvature at each of the two anchors bounding it, each
//      estimated from ITS own two neighbouring anchors — no separate tangent data needed. Placing
//      points at equal ANGLE increments along a circular arc gives equal ARC-LENGTH increments too
//      (and vice versa), so one sweep satisfies "constant speed" and "constant turn rate" together.
//
// Reads `point.liftSnap`'s position when present (a lift-confirmed point's real position for this
// purpose IS the already-reconstructed one), else the point's own `x`/`y`.
//
// Emits `point.tangleSnap = { lat, lon }` — non-destructive (same convention as
// `gradeBound`/`liftSnap`); `stabilize`'s `opts.tangleSnap` decides whether the export uses it (and
// takes priority over `liftSnap`'s own lat/lon there, since this module already folds liftSnap's
// position in as its own input). `ele` is left untouched — this only addresses horizontal tangle.

import { projectTo, unproject } from "../measure.js";

const TANGLE_MAX_SPEED = 0.6; // m/s — a point adjacent to a step at/under this speed is a candidate
const TANGLE_MIN_SPACING_M = 0.6; // m — thin kept points down to at least this far apart

function dist(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// The position to operate on: a lift-confirmed point's own reconstructed position, else raw x/y.
function posOf(p, lat0, lon0) {
  if (p.liftSnap) return projectTo(p.liftSnap.lat, p.liftSnap.lon, lat0, lon0);
  return { x: p.x, y: p.y };
}

// Signed Menger curvature (1/radius; positive = left turn) through three points.
function curvatureAt(a, b, c) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const bcx = c.x - b.x;
  const bcy = c.y - b.y;
  const cax = a.x - c.x;
  const cay = a.y - c.y;
  const area2 = abx * bcy - aby * bcx; // signed area x2 of triangle abc
  const ab = Math.hypot(abx, aby);
  const bc = Math.hypot(bcx, bcy);
  const ca = Math.hypot(cax, cay);
  const denom = ab * bc * ca;
  if (denom < 1e-9) return 0;
  return (2 * area2) / denom;
}

// `count` points along a constant-curvature arc from p0 to p1 (signed curvature kappa), evenly
// spaced in angle (== arc-length == constant speed AND constant turn rate). Excludes p0, includes
// p1 as the last point. kappa~0, or a degenerate chord, falls back to a straight line.
function arcPoints(p0, p1, kappa, count) {
  if (count <= 0) return [];
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const chord = Math.hypot(dx, dy);
  if (Math.abs(kappa) < 1e-6 || chord < 1e-9) {
    return Array.from({ length: count }, (_, k) => {
      const t = (k + 1) / count;
      return { x: p0.x + dx * t, y: p0.y + dy * t };
    });
  }
  const half = chord / 2;
  const r = Math.max(1 / Math.abs(kappa), half); // clamp: too-tight a curvature for this chord -> relax to the minimum valid arc
  const h = Math.sqrt(Math.max(0, r * r - half * half));
  const mx = (p0.x + p1.x) / 2;
  const my = (p0.y + p1.y) / 2;
  const ux = -dy / chord;
  const uy = dx / chord; // unit perpendicular, left of p0->p1
  const sign = kappa > 0 ? 1 : -1;
  const cx = mx + sign * h * ux;
  const cy = my + sign * h * uy;
  const a0 = Math.atan2(p0.y - cy, p0.x - cx);
  const a1raw = Math.atan2(p1.y - cy, p1.x - cx);
  let dTheta = a1raw - a0;
  if (sign > 0 && dTheta < 0) dTheta += 2 * Math.PI;
  if (sign < 0 && dTheta > 0) dTheta -= 2 * Math.PI;
  return Array.from({ length: count }, (_, k) => {
    const t = (k + 1) / count;
    const a = a0 + dTheta * t;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
}

function processRun(kept, pos, i0, j0, minSpacing, lat0, lon0) {
  const n = j0 - i0 + 1;
  if (n < 3) return; // nothing meaningful to thin/reinflate

  // thin: greedy min-spacing; the run's own first and last point are always kept
  const anchorIdx = [i0];
  for (let k = i0 + 1; k < j0; k++) {
    if (dist(pos[k], pos[anchorIdx.at(-1)]) >= minSpacing) anchorIdx.push(k);
  }
  anchorIdx.push(j0);
  if (anchorIdx.length < 2 || anchorIdx.length === n) return; // nothing was actually thinned

  const anchorPos = anchorIdx.map((k) => pos[k]);
  const kappa = anchorPos.map((_, a) =>
    a === 0 || a === anchorPos.length - 1
      ? 0
      : curvatureAt(anchorPos[a - 1], anchorPos[a], anchorPos[a + 1]),
  );

  for (let a = 0; a < anchorIdx.length - 1; a++) {
    const from = anchorIdx[a];
    const to = anchorIdx[a + 1];
    const count = to - from;
    const segKappa = (kappa[a] + kappa[a + 1]) / 2;
    const arc = arcPoints(anchorPos[a], anchorPos[a + 1], segKappa, count);
    for (let k = 0; k < count; k++) {
      kept[from + 1 + k].tangleSnap = unproject(arc[k].x, arc[k].y, lat0, lon0);
    }
  }
}

export const finalize = (out, ctx) => {
  const g = ctx.g ?? {};
  const maxSpeed = g.TANGLE_MAX_SPEED ?? TANGLE_MAX_SPEED;
  const minSpacing = g.TANGLE_MIN_SPACING_M ?? TANGLE_MIN_SPACING_M;
  const { lat0, lon0 } = ctx;

  const kept = out.filter((p) => !p.dropReason && p.time != null);
  if (kept.length < 3) return;
  const pos = kept.map((p) => posOf(p, lat0, lon0));

  const isSlow = new Array(kept.length).fill(false);
  for (let i = 1; i < kept.length; i++) {
    const dt = Math.max((kept[i].time - kept[i - 1].time) / 1000, 0.001);
    const speed = dist(pos[i], pos[i - 1]) / dt;
    if (speed <= maxSpeed) {
      isSlow[i - 1] = true;
      isSlow[i] = true;
    }
  }

  let i = 0;
  while (i < kept.length) {
    if (!isSlow[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < kept.length && isSlow[j + 1]) j++;
    processRun(kept, pos, i, j, minSpacing, lat0, lon0);
    i = j + 1;
  }
};
