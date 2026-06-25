// Compute module "outlier" — GPS spike detector (position 3-point detour, or impossible
// acceleration). Returns { drop } where each entry is { detour, accel } when flagged, else null,
// so spikes become the "outlier" drop reason. This is also the reference compute-module shape.
export const compute = ({ x, y, planarStep, hs, dt, g }) => {
  const n = x.length;
  const detour = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const d02 = Math.hypot(x[i + 1] - x[i - 1], y[i + 1] - y[i - 1]);
    detour[i] = planarStep[i - 1] + planarStep[i] - d02;
  }
  const drop = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const accel = i >= 1 ? Math.abs(hs[i] - hs[i - 1]) / dt[i - 1] : 0;
    if (detour[i] > g.D_JUMP || accel > g.A_MAX) drop[i] = { detour: detour[i], accel };
  }
  return { drop };
};
