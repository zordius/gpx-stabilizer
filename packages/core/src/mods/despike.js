// Compute module "despike" — flag suspicious points in two DERIVATIVE spaces, each with the test
// that fits it (proven empirically: a global robust baseline works for speed but RUNS AWAY on turn,
// which is zero-dominated). Detection only — aggressive on purpose; the pipeline-level bad-span glue
// (see analyze.js) makes the keep/drop decision, so isolated false flags are tolerated here.
//   turn  : ABSOLUTE thresholds (a turn has a physical limit at ski speed) —
//           (a) reversal: a >=REV out-and-back pair whose turns cancel (heading resumes) = a jut;
//           (b) lone hairpin: a single vertex turning >=LONE (well past real carves) = a one-sided spike.
//   speed : RELATIVE (no absolute scale: lift-slow vs ski-fast) — a robust IRLS-LOESS baseline of
//           log segment-length + global-MAD residual; a point whose BOTH adjacent segments are
//           length-outliers is displaced.
// Tunable via g.DESPIKE_*. Returns { drop } indexed by kept point (the "despike" drop reason).

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0;
};
const tricube = (u) => {
  const a = 1 - u * u * u;
  return a > 0 ? a * a * a : 0;
};
// weighted degree-1 LOESS value at i (value at t=0 of the local line)
function fitLin(vals, w, i, W) {
  const m = vals.length;
  let S0 = 0;
  let S1 = 0;
  let S2 = 0;
  let T0 = 0;
  let T1 = 0;
  const lo = Math.max(0, i - W);
  const hi = Math.min(m - 1, i + W);
  for (let j = lo; j <= hi; j++) {
    const ww = tricube(Math.abs(j - i) / (W + 1)) * w[j];
    if (ww <= 0) continue;
    const t = j - i;
    S0 += ww;
    S1 += ww * t;
    S2 += ww * t * t;
    T0 += ww * vals[j];
    T1 += ww * t * vals[j];
  }
  const det = S0 * S2 - S1 * S1;
  if (Math.abs(det) < 1e-9) return S0 > 0 ? T0 / S0 : vals[i];
  return (T0 * S2 - T1 * S1) / det;
}
// robust (IRLS Tukey) baseline of a sequence + flag |residual| > K x GLOBAL robust scale (MAD)
function robustOutliers(vals, K, W) {
  const m = vals.length;
  let w = new Array(m).fill(1);
  let fit = vals.slice();
  for (let it = 0; it < 4; it++) {
    fit = vals.map((_, i) => fitLin(vals, w, i, W));
    const r = vals.map((v, i) => Math.abs(v - fit[i]));
    const sigma = Math.max(1e-9, 1.4826 * median(r));
    w = r.map((ri) => {
      const u = ri / (6 * sigma);
      return u < 1 ? (1 - u * u) * (1 - u * u) : 0;
    });
  }
  const resid = vals.map((v, i) => Math.abs(v - fit[i]));
  const sigma = Math.max(1e-9, 1.4826 * median(resid));
  return resid.map((ri) => ri > K * sigma);
}

// Turn-threshold profiles (degrees), selected by g.DESPIKE_PROFILE (default "core"). The general
// "core" profile is CONSERVATIVE on turns: real everyday activities (walking/driving) have legitimate
// sharp corners / slow pivots up to ~150° (measured on public non-ski GPX), so a low threshold would
// cut REAL turns — core only flags near-180° lone hairpins and leans on speed/outlier/activity for
// general spikes. "ski" is tuned to skiing's gentler carves (95th ~73°) so it can cut at 120° safely.
// The speed-teleport detector + jut gate are activity-agnostic and stay shared (plain defaults below).
const PROFILES = {
  core: { LONE: 160, REV: 90, GAP: 3 },
  ski: { LONE: 120, REV: 90, GAP: 3 },
};

export const compute = (ctx) => {
  const { x, y, n, g } = ctx;
  const DEG = Math.PI / 180;
  // turn thresholds come from the selected profile (default "core"); per-key g.DESPIKE_* still wins
  const prof = PROFILES[g.DESPIKE_PROFILE] ?? PROFILES.core;
  const REV = (g.DESPIKE_REV ?? prof.REV) * DEG; // reversal candidate threshold
  const LONE = (g.DESPIKE_LONE ?? prof.LONE) * DEG; // lone hairpin threshold
  const GAP = g.DESPIKE_GAP ?? prof.GAP; // max vertices an out-and-back may span
  const KS = g.DESPIKE_KS ?? 3.5; // speed log-baseline MAD factor (aggressive)
  const W = g.DESPIKE_W ?? 30; // speed baseline half-window
  const JUT = g.DESPIKE_JUT ?? 3; // m: absolute influence gate — only drop a jump that would pull the line this far off
  const drop = new Array(n).fill(null);
  if (n < 3) return { drop };
  // each detector tags its own key on the point's drop context (rev/lone/speed may co-occur), so the
  // per-step contribution stays inspectable in the output instead of collapsing into one reason.
  const flag = (k, key, val) => {
    if (!drop[k]) drop[k] = {};
    drop[k][key] = val;
  };

  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const head = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) head[i] = Math.atan2(y[i + 1] - y[i], x[i + 1] - x[i]);
  const turn = new Array(n).fill(0); // signed per-vertex turn, defined 1..n-2
  for (let i = 1; i < n - 1; i++) turn[i] = wrap(head[i] - head[i - 1]);

  // (a) reversal out-and-back: a >=REV turn cancelled by an opposite >=REV turn within GAP vertices
  let i = 1;
  while (i < n - 1) {
    if (Math.abs(turn[i]) < REV) {
      i++;
      continue;
    }
    let acc = turn[i];
    let found = -1;
    for (let j = i + 1; j <= Math.min(n - 2, i + GAP); j++) {
      acc += turn[j];
      if (
        Math.sign(turn[j]) !== Math.sign(turn[i]) &&
        Math.abs(turn[j]) >= REV &&
        Math.abs(acc) < REV
      ) {
        found = j;
        break;
      }
    }
    if (found >= 0) {
      for (let k = i; k < found; k++) flag(k, "rev", turn[k]);
      i = found;
    } else i++;
  }
  // (b) lone hairpin
  for (let k = 1; k < n - 1; k++) if (Math.abs(turn[k]) >= LONE) flag(k, "lone", turn[k]);

  // (c) speed: a point is displaced when its TWO adjacent segments are log-length outliers vs the
  // robust baseline AND that long pair is LOCALLY ISOLATED — the segments just outside it are normal.
  // A real teleport is a lone out-and-back (normal · LONG · LONG · normal); sustained fast skiing is a
  // RUN of long segments (every interior point would have both neighbours long), so requiring the
  // flanking segments to be non-outliers rejects fast-skiing speed variation, keeping only true jumps.
  const logSeg = new Array(n - 1);
  for (let k = 0; k < n - 1; k++)
    logSeg[k] = Math.log(Math.max(0.1, Math.hypot(x[k + 1] - x[k], y[k + 1] - y[k])));
  const sf = robustOutliers(logSeg, KS, W);
  const isOut = (s) => s >= 0 && s < n - 1 && sf[s];
  for (let k = 1; k < n - 1; k++) {
    if (!(sf[k - 1] && sf[k] && !isOut(k - 2) && !isOut(k + 1))) continue;
    // absolute influence gate: only drop if keeping the point would pull the line > JUT m off the
    // chord through its neighbours (small juts are absorbed by reconstruction — not worth dropping).
    const dx = x[k + 1] - x[k - 1];
    const dy = y[k + 1] - y[k - 1];
    const L = Math.hypot(dx, dy);
    const jut =
      L < 1e-6
        ? Math.hypot(x[k] - x[k - 1], y[k] - y[k - 1])
        : Math.abs((x[k] - x[k - 1]) * dy - (y[k] - y[k - 1]) * dx) / L;
    if (jut > JUT) flag(k, "speed", true);
  }

  return { drop };
};
