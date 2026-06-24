// Screen module "noTime" — a point with no timestamp can't join the motion time series.
export const screen = (p) => (p.time == null ? true : null);
