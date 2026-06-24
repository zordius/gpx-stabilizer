// Screen module "sameTime" — drop points that share the last kept point's timestamp: an exact
// duplicate (not moved), or a conflict (moved: two positions claiming the same instant).
export const screen = (p, q) => {
  if (!q || p.time == null || p.time !== q.time) return null;
  return { moved: p.lat !== q.lat || p.lon !== q.lon };
};
