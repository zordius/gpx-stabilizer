// Compute module "noise" — FINALIZE phase, opt-in (bundled by MODES.ski). Diagnostic-only: emits a
// signal, no drop, no rewrite. Exploratory (2026-07-08) — for eyeballing via the "noise" map/chart
// layer (see view.js) while deciding whether/how to act on it; no threshold or correction logic here.
//
// Per point, over a +/-NOISE_WIN_S window: `turnSum` is the sum of ABS CONSECUTIVE DIFFERENCES across
// the window's own forward headings, and `slopeSum` the same shape vertically (forward per-step
// Δele/Δt). Summing differences (not just the single worst turn/slope-change) captures frequency AND
// magnitude of back-and-forth wander together — the same score whether the window has one big swing
// or many small ones ("亂數式走法的頻度"). `slopeSum` uses a raw per-step vertical rate, never divided
// by horizontal distance — a true grade RATIO blows up at low speed, the exact trap this session's
// very first check (grade45_scan.mjs) already hit; a difference-of-rates has no such singularity.
// `hdopMax` rides along (the window's own worst hdop) so a consumer can check whether the GPS chip's
// own quality signal moves WITH the derived wander or stays silent while it spikes.
//
// Emits `point.noise = { turnSum, slopeSum, hdopMax }` (namespaced; no other module reads this).

const WIN_S = 10; // +/- window (s)

function heading(a, b) {
  return Math.atan2(b.x - a.x, b.y - a.y);
}
// smallest signed-magnitude angle (0..180 deg) between two headings (radians)
function angDiffDeg(a, b) {
  return (Math.abs(((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 180) / Math.PI;
}

export const finalize = (out, ctx) => {
  const g = ctx.g ?? {};
  const winS = g.NOISE_WIN_S ?? WIN_S;
  const kept = out.filter((p) => !p.dropReason && p.time != null && Number.isFinite(p.ele));
  const n = kept.length;
  if (n < 4) return;
  const t = kept.map((p) => p.time / 1000);

  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    while (t[i] - t[lo] > winS) lo++;
    while (hi < n - 1 && t[hi + 1] - t[i] <= winS) hi++;
    if (hi - lo < 3) continue; // need at least 4 points (3 steps, 2 diffs) to score a window

    const win = kept.slice(lo, hi + 1);
    const hdg = [];
    const slope = [];
    for (let j = 0; j < win.length - 1; j++) {
      hdg.push(heading(win[j], win[j + 1]));
      const dt = Math.max(0.1, (win[j + 1].time - win[j].time) / 1000);
      slope.push((win[j + 1].ele - win[j].ele) / dt);
    }
    let turnSum = 0;
    for (let j = 1; j < hdg.length; j++) turnSum += angDiffDeg(hdg[j], hdg[j - 1]);
    let slopeSum = 0;
    for (let j = 1; j < slope.length; j++) slopeSum += Math.abs(slope[j] - slope[j - 1]);
    let hdopMax = 0;
    for (const p of win) hdopMax = Math.max(hdopMax, p.hdop ?? 0);

    kept[i].noise = { turnSum, slopeSum, hdopMax };
  }
};
