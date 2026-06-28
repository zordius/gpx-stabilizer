// Compute module "stray" — drop points far outside the track's spatial bulk.
//
// `outlier` flags single-point spikes via a 3-point detour; it MISSES garbage that arrives as a
// CLUSTER — GPS cold-start null-island wander, early-lock wild fixes — because a cluster's interior
// points have a small local detour (neighbour-to-neighbour distance stays small). `stray` is the
// complementary, whole-track check born from the eval's bbox framing: take a robust centre (the
// component-wise median of the projected x/y, unmoved by far garbage) and a bulk radius (a high
// percentile of the distance from that centre), then drop any point beyond STRAY_FACTOR× that radius
// — with an absolute STRAY_FLOOR so a tiny track never self-triggers. A clean track's farthest point
// is ~its bulk radius, so a STRAY_FACTOR well above 1 drops nothing; only gross teleports go.
//
// Robust-by-construction: the median/percentile estimate the bulk even when a sizable minority of
// points are garbage, and the FACTOR (not a fixed percentile) means no legitimate point is ever
// dropped just for being at the track's natural edge.

const medianOf = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

const percentileOf = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

export const compute = ({ x, y, g }) => {
  const n = x.length;
  const drop = new Array(n).fill(null);
  // too few points to estimate a bulk reliably — leave it to `outlier`
  if (n < (g.STRAY_MIN_N ?? 16)) return { drop };

  const cx = medianOf(x);
  const cy = medianOf(y);
  const dist = new Array(n);
  for (let i = 0; i < n; i++) dist[i] = Math.hypot(x[i] - cx, y[i] - cy);

  const bulkR = percentileOf(
    [...dist].sort((a, b) => a - b),
    g.STRAY_BULK_PCT ?? 0.9,
  );
  const thresh = Math.max(bulkR * (g.STRAY_FACTOR ?? 6), g.STRAY_FLOOR ?? 500);

  for (let i = 0; i < n; i++) {
    if (dist[i] > thresh) drop[i] = { dist: Math.round(dist[i]), thresh: Math.round(thresh) };
  }
  return { drop };
};
