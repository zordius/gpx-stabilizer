import assert from "node:assert/strict";
import { test } from "node:test";
import { finalize } from "../src/mods/liftSnap.js";

const DEG_LON_M = 111320;
const ctx = { lat0: 0, lon0: 0 }; // lat0=0 -> mx = DEG_LON_M, keeps the expected math simple

function pt(over) {
  return { lat: 0, lon: 0, liftConfirm: { type: "lift" }, segment: { id: 0 }, ...over };
}

test("liftSnap: a straight run gets snapped onto its own line, at least 20m from either end", () => {
  // span 0..90m: points at x=20..70 sit >=20m (LIFTSNAP_FADE_M) from BOTH ends -> full snap (w=1).
  const out = Array.from({ length: 10 }, (_, i) =>
    pt({ x: i * 10, y: 0, ele: 1000 + i, time: i * 1000 }),
  );
  finalize(out, ctx);
  for (const p of out.slice(2, 8)) {
    assert.ok(Math.abs(p.liftSnap.lon - p.x / DEG_LON_M) < 1e-9);
    assert.ok(Math.abs(p.liftSnap.lat - 0) < 1e-9); // y=0 throughout -> lat stays 0
    assert.equal(p.liftSnap.ele, undefined); // no `hs` set -> never a pause event -> ele untouched
  }
});

test("liftSnap: fades the snap weight 0->1 over the first/last 20m, not a hard on/off", () => {
  // a wobbly (not perfectly straight) run, so raw != fully-snapped and the blend is observable.
  // Run it twice — default fade vs LIFTSNAP_FADE_M:0 (hard on/off, the pre-fade behaviour) — points
  // outside the fade zone must match exactly; points inside must differ (fading actually changed
  // something) and land strictly between raw and the hard-snap reference.
  const points = () =>
    Array.from({ length: 10 }, (_, i) => pt({ x: i * 10, y: i % 2 === 0 ? 0 : 6, time: i * 1000 }));
  const faded = points();
  const hard = points();
  finalize(faded, ctx);
  finalize(hard, { ...ctx, g: { LIFTSNAP_FADE_M: 0 } });

  // x=0 is 0m from the start -> weight 0 -> stays at its own raw position regardless of the fit
  assert.ok(Math.abs(faded[0].liftSnap.lat - 0) < 1e-9);
  assert.notEqual(faded[0].liftSnap.lat, hard[0].liftSnap.lat, "fading changed the boundary point");

  // x=40 (index 4) sits 40m from the start and 50m from the end — both past the 20m fade -> weight 1
  // -> identical to the hard-snap reference (fading doesn't touch the interior)
  assert.equal(faded[4].liftSnap.lat, hard[4].liftSnap.lat);

  // x=10 (index 1, 10m in — half the fade distance) lands strictly between raw and the hard-snapped
  // reference, not equal to either
  const raw1 = faded[1].y / 110540;
  const hardSnapped1 = hard[1].liftSnap.lat;
  const lo = Math.min(raw1, hardSnapped1);
  const hi = Math.max(raw1, hardSnapped1);
  assert.ok(faded[1].liftSnap.lat > lo && faded[1].liftSnap.lat < hi);
});

test("liftSnap: a pause EVENT (hysteresis on hs) moves every point in it onto the SAME anchor position and elevation", () => {
  // span 0..150m; hs drops to 0.1 m/s (well under the 0.5 HS_ON default) for a 1s stretch (indices
  // 3-4) while x holds at 100 -- a genuine stop, well inside the fade-free core (>=20m from either
  // end) so weight=1 throughout and this exercises the anchor-snap alone, undiluted by fading.
  const out = [0, 50, 100, 100, 100, 150].map((x, i) =>
    pt({ x, y: 0, ele: 1000 + i, time: i * 1000, hs: [5, 5, 5, 0.1, 0.1, 5][i] }),
  );
  finalize(out, ctx);
  assert.equal(out[3].liftSnap.lat, out[2].liftSnap.lat);
  assert.equal(out[3].liftSnap.lon, out[2].liftSnap.lon);
  assert.equal(out[4].liftSnap.lat, out[2].liftSnap.lat); // both event points share ONE anchor
  assert.equal(out[4].liftSnap.lon, out[2].liftSnap.lon);
  assert.equal(out[3].liftSnap.ele, out[4].liftSnap.ele); // both event points share ONE elevation
  assert.equal(out[3].liftSnap.ele, (out[3].ele + out[4].ele) / 2); // the event's own median raw ele
  assert.ok(out[5].liftSnap.lon > out[2].liftSnap.lon); // forward points keep progressing past it
});

test("liftSnap: GPS jitter inside a pause event doesn't split it — every point still gets the SAME median elevation", () => {
  // the bug this replaces: per-point along-line regression flipped individual points inside a real
  // pause between "still advancing" (no ele) and "paused" (anchored ele) whenever position jitter
  // pushed one sample's projection a hair past the running high-water mark. Speed-based event
  // detection doesn't care about that jitter at all -- every point here has hs=0.1 (a real stop), so
  // all four must land in ONE event with ONE shared elevation despite the raw ele wobbling.
  const xs = [100, 100.001, 99.999, 100.0005];
  const eles = [1058.05, 1057.97, 1058.05, 1057.97]; // noisy raw ele, median = 1058.01
  const out = [
    pt({ x: 0, y: 0, ele: 1000, time: 0, hs: 5 }),
    pt({ x: 50, y: 0, ele: 1050, time: 1000, hs: 5 }),
    ...xs.map((x, i) => pt({ x, y: 0, ele: eles[i], time: (2 + i) * 1000, hs: 0.1 })),
    pt({ x: 150, y: 0, ele: 1100, time: 6000, hs: 5 }),
  ];
  finalize(out, ctx);
  const eventPts = out.slice(2, 6);
  const eleValues = new Set(eventPts.map((p) => p.liftSnap.ele));
  assert.equal(eleValues.size, 1, "every point in the pause shares exactly one elevation value");
  const expectedMedian = (1057.97 + 1058.05) / 2; // median of the 4 sorted raw eles
  assert.equal([...eleValues][0], expectedMedian);
  assert.ok(eventPts.every((p) => p.liftSnap.ele !== undefined), "no point in the event is left out");
});

test("liftSnap: a low-speed dip shorter than LIFTSNAP_PAUSE_MIN_S is not treated as a pause", () => {
  // hs dips to 0.1 for a single 0-duration sample (index 3 alone) then immediately recovers -- too
  // brief to trust as a real stop, so it stays on the forward branch (no ele override).
  const out = [0, 50, 100, 150].map((x, i) =>
    pt({ x, y: 0, ele: 1000 + i, time: i * 1000, hs: [5, 5, 0.1, 5][i] }),
  );
  finalize(out, ctx);
  assert.equal(out[2].liftSnap.ele, undefined);
});

test("liftSnap: a point with unknown hs never triggers or clears a pause on its own", () => {
  // hs missing throughout (as in most of this file's other tests) -> never enters a pause, even
  // though x briefly holds still at index 2-3 -- purely positional stillness is no longer the signal.
  const out = [0, 50, 100, 100, 150].map((x, i) => pt({ x, y: 0, ele: 1000 + i, time: i * 1000 }));
  finalize(out, ctx);
  assert.ok(out.every((p) => p.liftSnap.ele === undefined));
});

test("liftSnap: only confirmed-lift runs get a signal; other verdicts are untouched", () => {
  const lift = Array.from({ length: 3 }, (_, i) =>
    pt({ segment: { id: 0 }, x: i * 10, y: 0, ele: 1000, time: i * 1000 }),
  );
  const ascent = pt({
    segment: { id: 1 },
    liftConfirm: { type: "ascent" },
    x: 100,
    y: 0,
    ele: 1000,
    time: 5000,
  });
  const out = [...lift, ascent];
  finalize(out, ctx);
  assert.ok(lift.every((p) => p.liftSnap));
  assert.equal(ascent.liftSnap, undefined);
});

test("liftSnap: a run under 3 points is too few to fit a line -> no signal", () => {
  const out = Array.from({ length: 2 }, (_, i) => pt({ x: i * 10, y: 0, time: i * 1000 }));
  finalize(out, ctx);
  assert.ok(out.every((p) => p.liftSnap === undefined));
});

test("liftSnap: no-op when nothing is confirmed as lift", () => {
  const out = [pt({ x: 0, y: 0, liftConfirm: { type: "ascent" } })];
  finalize(out, ctx);
  assert.equal(out[0].liftSnap, undefined);
});
