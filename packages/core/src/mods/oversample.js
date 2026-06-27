// Label module "oversample" — drop points closer than 0.5 s to the last kept point (denser than
// ~2 Hz). The threshold is 0.5 s, not 1 s, on purpose: the repair phase reconstructs second-resolution
// duplicates at 0.5 s spacing, so a 0.5 s gate KEEPS those re-timed points AND their real 1 Hz
// neighbours (gating on the edit instead would keep the re-timed point but then drop the real next
// fix, which sits 0.5 s after it). Only genuine >2 Hz bursts are discarded.
export const label = (p, q) => {
  if (!q || p.time == null) return null;
  const gap = p.time - q.time;
  return gap > 0 && gap < 500 ? { drop: { gap } } : null;
};
