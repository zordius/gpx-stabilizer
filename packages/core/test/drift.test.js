import assert from "node:assert/strict";
import { test } from "node:test";
import { compute } from "../src/mods/drift.js";

// ctx with per-point arrays at 1 Hz; `flags[k]` = drift-like (random heading + flat + compact)
function ctxFor(flags) {
  const n = flags.length;
  return {
    n,
    t: Array.from({ length: n }, (_, i) => i),
    x: new Array(n).fill(0),
    y: new Array(n).fill(0),
    wander: flags.map((f) => (f ? 0.8 : 0.1)), // drift -> high circular variance
    vs: flags.map((f) => (f ? 0.05 : 0.5)), //    drift -> flat (low |vs|)
    hs: flags.map(() => 0), //                    stationary — inert for these tests (netd150 decides)
    netd150: flags.map((f) => (f ? 20 : 500)), // drift -> compact (went nowhere)
    netdShort: flags.map((f) => (f ? 20 : 500)), // mirrors netd150 — inert either way here
    g: {},
  };
}

test("drift: a sustained random-heading + flat-altitude run is dropped as one segment", () => {
  const flags = Array.from({ length: 200 }, (_, i) => i >= 40 && i <= 169); // 130 s block
  const { drift, drop } = compute(ctxFor(flags));
  assert.ok(drop[100] && drift[100], "mid-run point is dropped and labelled");
  assert.equal(drop[10], null, "outside the run -> kept");
  assert.equal(drift[100].npt, 130);
  assert.ok(drift[100].dur >= 120);
  assert.equal(drift[100].seg, 0);
});

test("drift: a run shorter than the minimum duration is not dropped", () => {
  const flags = Array.from({ length: 100 }, (_, i) => i >= 50 && i < 80); // 29 s < 120 s
  assert.ok(compute(ctxFor(flags)).drop.every((d) => d === null));
});

test("drift: needs random heading AND flat altitude AND compactness", () => {
  const n = 200;
  const base = {
    n,
    t: Array.from({ length: n }, (_, i) => i),
    x: new Array(n).fill(0),
    y: new Array(n).fill(0),
    hs: new Array(n).fill(0), // stationary — inert; netd150 alone decides compactness here
    netdShort: new Array(n).fill(500), // inert (large) — these cases test the long window only
    g: {},
  };
  const run = (w, v, d) =>
    compute({
      ...base,
      wander: new Array(n).fill(w),
      vs: new Array(n).fill(v),
      netd150: new Array(n).fill(d),
    });
  assert.ok(run(0.8, 0.6, 20).drop.every((x) => x === null)); // climbing -> |vs| fails
  assert.ok(run(0.1, 0.05, 20).drop.every((x) => x === null)); // steady heading -> wander fails
  assert.ok(run(0.8, 0.05, 500).drop.every((x) => x === null)); // moving away -> netd150 fails
  assert.ok(run(0.8, 0.05, 20).drop.some((x) => x !== null)); // all three hold -> drift
});

test("drift: a run only the short window confirms gets a much lower duration floor", () => {
  // Mirrors GX065132.MP4's real shape: netd150 undershoots the 100 m cutoff by only a hair (102 m —
  // diluted by real motion elsewhere in a short recording) EVERYWHERE, never just inside the run, so
  // the long window can never confirm this run at any duration; netdShort (local enough to stay
  // inside the wobble) and hs (already near-stationary) do, but only for a short ~4 s stretch. The
  // ORIGINAL 30 s floor would (wrongly) let a real short wobble like this through undetected.
  const n = 40;
  const inRun = (i) => i >= 15 && i <= 19; // t = 15..19 inclusive -> 4 s
  const ctx = {
    n,
    t: Array.from({ length: n }, (_, i) => i),
    x: new Array(n).fill(0),
    y: new Array(n).fill(0),
    wander: Array.from({ length: n }, (_, i) => (inRun(i) ? 0.8 : 0.1)),
    vs: Array.from({ length: n }, (_, i) => (inRun(i) ? 0.05 : 0.5)),
    hs: Array.from({ length: n }, (_, i) => (inRun(i) ? 1 : 5)), // slow only inside the run
    netd150: new Array(n).fill(102), // never compact by the long window's own cutoff, in or out
    netdShort: Array.from({ length: n }, (_, i) => (inRun(i) ? 20 : 500)),
    g: {},
  };
  const { drift, drop } = compute(ctx);
  assert.ok(drop[17] && drift[17], "the short, slow, compact wobble is caught");
  assert.equal(drop[0], null, "outside the run stays kept");
});

test("drift: a run relying on the long window keeps the original 30 s floor even when slow", () => {
  // hs being low is not, by itself, reason to relax the duration floor — only a run the long window
  // NEVER confirms (netd150 stays >= the cutoff throughout) gets the short floor. Here netd150 IS
  // compact (20 m), so even though hs is also low throughout, the original 30 s floor still applies.
  const flags = Array.from({ length: 100 }, (_, i) => i >= 50 && i < 80); // 29 s < 30 s
  const ctx = {
    n: 100,
    t: Array.from({ length: 100 }, (_, i) => i),
    x: new Array(100).fill(0),
    y: new Array(100).fill(0),
    wander: flags.map((f) => (f ? 0.8 : 0.1)),
    vs: flags.map((f) => (f ? 0.05 : 0.5)),
    hs: new Array(100).fill(1), // low throughout — must NOT be enough to relax the floor on its own
    netd150: flags.map((f) => (f ? 20 : 500)),
    netdShort: flags.map((f) => (f ? 20 : 500)),
    g: {},
  };
  assert.ok(compute(ctx).drop.every((d) => d === null));
});

test("drift: a fast, tight carve (low netdShort but NOT slow) is not misread as drift", () => {
  // The risk a short window adds: a few seconds of a genuinely fast, rhythmic S-turn carve can also
  // show small net displacement without being drift. Gating the short-window branch on hs already
  // being slow keeps this case entirely on the original long window, which a real ski run satisfies
  // (net progress over 150 s of skiing is never actually small) — so it must NOT be flagged.
  const n = 200;
  const ctx = {
    n,
    t: Array.from({ length: n }, (_, i) => i),
    x: new Array(n).fill(0),
    y: new Array(n).fill(0),
    wander: new Array(n).fill(0.8), // rhythmic S-turns read as high heading variance too
    vs: new Array(n).fill(0.05),
    hs: new Array(n).fill(8), // real carving speed — well above the 2 m/s gate
    netd150: new Array(n).fill(500), // real net progress over the long window
    netdShort: new Array(n).fill(20), // a tight carve's short-window net displacement CAN be small
    g: {},
  };
  assert.ok(compute(ctx).drop.every((d) => d === null));
});
