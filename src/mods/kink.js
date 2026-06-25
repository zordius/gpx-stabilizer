// Compute module "kink" — flag points where the track makes an unnaturally sharp turn: the heading
// change between the step arriving at the point and the step leaving it exceeds KINK_TURN (radians).
// A smooth track turns gradually; a lone sharp kink (a V out-and-back, or a jerk to one side and
// back) stands out against its neighbours. This LABELS only (point.kink.at), no drop — a yellow
// overlay to gauge how many "unnatural turns" a single turn-angle test catches. Tunable via
// g.KINK_TURN. Stationary steps (no heading) are skipped so jitter-at-rest doesn't read as a turn.

export const compute = (ctx) => {
  const { n, velocity, g } = ctx;
  const sharp = g.KINK_TURN ?? 1.6; // rad (~92°): a turn sharper than this is an unnatural kink
  const v = velocity.vec;

  // planar heading unit per step (ignore the vertical component for a path-shape turn)
  const hx = new Array(n);
  const hy = new Array(n);
  for (let i = 0; i < n; i++) {
    const m = Math.hypot(v.x[i], v.y[i]);
    hx[i] = m > 1e-9 ? v.x[i] / m : 0;
    hy[i] = m > 1e-9 ? v.y[i] / m : 0;
  }

  const at = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    if ((!hx[i] && !hy[i]) || (!hx[i - 1] && !hy[i - 1])) continue; // a stationary step has no heading
    const dot = hx[i] * hx[i - 1] + hy[i] * hy[i - 1];
    const turn = Math.acos(Math.min(1, Math.max(-1, dot)));
    if (turn > sharp) at[i] = { turn };
  }
  return { at }; // label only — no `drop`
};
