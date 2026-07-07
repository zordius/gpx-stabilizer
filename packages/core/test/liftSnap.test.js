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
    assert.equal(p.liftSnap.ele, undefined); // forward points: ele untouched
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

test("liftSnap: a backward point (well inside the fade-free core) moves onto the anchor (lat, lon, AND elevation)", () => {
  // span 0..150m, backward event at x=80 (70m from the start, 50m from the end — both well past the
  // 20m fade) so weight=1 throughout and this exercises the anchor-snap alone, undiluted by fading.
  const out = [0, 50, 100, 80, 150].map((x, i) => pt({ x, y: 0, ele: 1000 + i, time: i * 1000 }));
  finalize(out, ctx);
  assert.equal(out[3].liftSnap.lat, out[2].liftSnap.lat);
  assert.equal(out[3].liftSnap.lon, out[2].liftSnap.lon);
  assert.equal(out[3].liftSnap.ele, out[2].ele); // the anchor's ORIGINAL elevation
  assert.ok(out[4].liftSnap.lon > out[2].liftSnap.lon); // forward points keep progressing past it
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
