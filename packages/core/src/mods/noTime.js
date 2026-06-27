// Label module "noTime" — a point with no timestamp can't join the motion time series, so drop it.
export const label = (p) => (p.time == null ? { drop: true } : null);
