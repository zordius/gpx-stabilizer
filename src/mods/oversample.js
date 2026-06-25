// Label module "oversample" — resample to ~1 Hz: drop points less than 1 s after the last kept
// point (i.e. points sampled denser than 1 Hz).
export const label = (p, q) => {
  if (!q || p.time == null) return null;
  const gap = p.time - q.time;
  return gap > 0 && gap < 1000 ? { drop: { gap } } : null;
};
