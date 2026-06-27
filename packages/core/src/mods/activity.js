// Compute module "activity" — positive-list each point into the human movement activities whose
// kinematic envelope it fits. Matched names attach as point.activity.modes (a label for colouring /
// segmentation); a point fitting NO enabled activity becomes the `implausible` drop reason.
//
// Each activity is a COUPLED box over altitude + speed + acceleration + turn — coupled so that e.g.
// only `flight` allows high speed AND high altitude together, and a GPS spike (high speed + ~180°
// reversal + huge acceleration) fits nothing. Axes come from the point-level measure bundle, so this
// is a point-level classifier; the robust axes (alt / hspeed / vspeed, 1st order) carry the call and
// the noisier 2nd-order `accel` bounds are kept generous. `alt` uses an UPPER bound only (a low/
// negative altitude is real terrain or just GPS/geoid noise) and never touches the horizontal x/y.
//
// Box per axis: [lo, hi], null = unbounded on that side. Units: alt m (absolute), hspeed/vspeed m/s
// (vspeed signed, + up), accel m/s², turn rad. Numbers are tunable heuristics from the
// human-movement envelope table, not hard facts.

import { speedOf } from "../measure.js";

const PI = Math.PI;

export const ACTIVITIES = {
  walking: { alt: [null, 9000], hspeed: [0, 2.5], vspeed: [-1, 1], accel: [0, 3], turn: [0, PI] },
  running: { alt: [null, 9000], hspeed: [0, 12], vspeed: [-1, 1], accel: [0, 4], turn: [0, PI] },
  cycling: { alt: [null, 4500], hspeed: [0, 25], vspeed: [-3, 3], accel: [0, 4], turn: [0, 2.5] },
  driving: { alt: [null, 4500], hspeed: [0, 40], vspeed: [-3, 3], accel: [0, 10], turn: [0, 2.0] },
  rail: { alt: [null, 2500], hspeed: [0, 95], vspeed: [-3, 3], accel: [0, 3], turn: [0, 1.5] },
  skiing: { alt: [null, 5000], hspeed: [0, 35], vspeed: [-8, 8], accel: [0, 15], turn: [0, 2.7] },
  flight: {
    alt: [null, 13000],
    hspeed: [60, 300],
    vspeed: [-30, 30],
    accel: [0, 5],
    turn: [0, 1.0],
  },
  // special — defined but NOT in the core default; opt in via opts.activities
  skydive: { alt: [null, 5000], hspeed: [0, 15], vspeed: [-90, 0], accel: [0, 50], turn: [0, PI] },
  coaster: { alt: [null, 200], hspeed: [0, 40], vspeed: [-30, 30], accel: [0, 50], turn: [0, PI] },
};

/** Activities enabled by default in core (everyday land travel + flight); specials are opt-in. */
export const CORE_DEFAULT = [
  "walking",
  "running",
  "cycling",
  "driving",
  "rail",
  "skiing",
  "flight",
];

const inBox = (v, [lo, hi]) => (lo == null || v >= lo) && (hi == null || v <= hi);

/** True iff the point features fall inside every axis of an activity box. */
function fits(box, f) {
  return (
    inBox(f.alt, box.alt) &&
    inBox(f.hspeed, box.hspeed) &&
    inBox(f.vspeed, box.vspeed) &&
    inBox(f.accel, box.accel) &&
    inBox(f.turn, box.turn)
  );
}

/** Heading change (rad) between step k and k-1 from the unit velocity directions; 0 at the start. */
function turnAt(dir, k) {
  if (k < 1) return 0;
  const dot = dir.x[k] * dir.x[k - 1] + dir.y[k] * dir.y[k - 1] + dir.z[k] * dir.z[k - 1];
  return Math.acos(Math.min(1, Math.max(-1, dot)));
}

export const compute = (ctx) => {
  const { el, velocity, acceleration, n, g } = ctx;
  const enabled = (g.activities ?? CORE_DEFAULT).filter((name) => ACTIVITIES[name]);
  const modes = new Array(n).fill(null);
  const drop = new Array(n).fill(null);
  if (velocity.mag.length === 0) return { modes, drop }; // fewer than 2 points: nothing to classify
  for (let p = 0; p < n; p++) {
    // every bundle array is per-point length n (the last point reuses its neighbour), so index by p
    const f = {
      alt: el[p],
      hspeed: speedOf(ctx, p), // device <speed> if present, else |horizontal velocity|
      vspeed: velocity.vec.z[p],
      accel: acceleration.mag[p],
      turn: turnAt(velocity.dir, p),
    };
    const matched = enabled.filter((name) => fits(ACTIVITIES[name], f));
    if (matched.length > 0) modes[p] = matched;
    else drop[p] = { ...f }; // implausible: no enabled activity explains this motion
  }
  return { modes, drop };
};
