import assert from "node:assert/strict";
import { test } from "node:test";
import { finalize } from "../src/mods/liftConfirm.js";

// liftConfirm only reads x/y/ele/time/hs/straightLong(orShort)/segment/dropReason off assembled
// points — unit-test its own logic directly with hand-built points (same style as outlier/stray's
// own tests), rather than driving the whole analyze() pipeline just to get realistic windowed
// signals.
function pt(over) {
  return { lat: 36, lon: 138, segment: { id: 0, type: "lift" }, ...over };
}

test("liftConfirm: a straight, moderate-speed, long-enough climb stays confirmed lift", () => {
  const out = Array.from({ length: 70 }, (_, i) =>
    pt({ x: i * 3, y: 0, ele: 1000 + i * 2, time: i * 1000, hs: 3, straightLong: 0.9 }),
  );
  finalize(out, { g: {} });
  assert.ok(out.every((p) => p.liftConfirm.type === "lift"));
  assert.equal(out[0].segment.type, "lift"); // segment.js's own output is never touched
});

test("liftConfirm: ⓪ trims a tail that turns away from the run's own core direction/speed", () => {
  // 80 s straight east at 2 m/s (a real lift ride), then 20 s turning north and slowing to 0.3 m/s
  // (walking off the platform) — segment.js would glue both into ONE run since vspeed never goes
  // negative; ⓪ should split the tail off as `ascent` before ①-⑤ ever see it, matching the real
  // 20260211-GOPR-c8713177.gpx case this step was built for (SPEC.md "Prior art for the follow-ons").
  const core = Array.from({ length: 80 }, (_, i) =>
    pt({ x: i * 2, y: 0, ele: 1000 + i, time: i * 1000, hs: 2, straightLong: 0.9 }),
  );
  const tail = Array.from({ length: 20 }, (_, i) =>
    pt({ x: 160, y: i * 0.3, ele: 1080 + i, time: (80 + i) * 1000, hs: 0.3, straightLong: 0.9 }),
  );
  const out = [...core, ...tail];
  finalize(out, { g: {} });
  assert.ok(core.slice(10, 70).every((p) => p.liftConfirm.type === "lift")); // safely inside the core
  assert.ok(tail.slice(5).every((p) => p.liftConfirm.type === "ascent")); // the turned-away tail
  assert.ok(tail.slice(5).every((p) => p.segment.type === "lift")); // segment.js's own output untouched
});

test("liftConfirm: not straight enough -> ascent", () => {
  const out = Array.from({ length: 70 }, (_, i) =>
    pt({ x: i, y: 0, ele: 1000 + i, time: i * 1000, hs: 3, straightLong: 0.2 }),
  );
  finalize(out, { g: {} });
  assert.ok(out.every((p) => p.liftConfirm.type === "ascent"));
});

test("liftConfirm: too fast for a cable -> powered", () => {
  const out = Array.from({ length: 70 }, (_, i) =>
    pt({ x: i * 10, y: 0, ele: 1000 + i, time: i * 1000, hs: 10, straightLong: 0.9 }),
  );
  finalize(out, { g: {} });
  assert.ok(out.every((p) => p.liftConfirm.type === "powered"));
});

test("liftConfirm: too short after merging -> ascent", () => {
  const out = Array.from({ length: 30 }, (_, i) =>
    pt({ x: i * 3, y: 0, ele: 1000 + i * 2, time: i * 1000, hs: 3, straightLong: 0.9 }),
  ); // 29 s < 60 s
  finalize(out, { g: {} });
  assert.ok(out.every((p) => p.liftConfirm.type === "ascent"));
});

// zigzag helper: alternating east/north legs, each `legM` metres long at `speed` m/s (1 sample/s) —
// 90 deg turns, well over the 40 m RDP epsilon so they survive simplification as real sharp turns.
function zigzag(legs, speed, legM) {
  const pts = [];
  let x = 0;
  let y = 0;
  let t = 0;
  const stepM = speed; // 1 Hz
  for (const [dx, dy] of legs) {
    for (let s = 0; s < legM / stepM; s++) {
      x += dx * stepM;
      y += dy * stepM;
      pts.push(pt({ x, y, ele: 1000 + t / 10, time: t * 1000, hs: speed, straightLong: 0.9 }));
      t++;
    }
  }
  return pts;
}

test("liftConfirm: winding at moderate-plus speed -> powered (switchbacking road, not a rope)", () => {
  // legM=200 (well over LIFT_RDP_EPS(40) so each corner's deviation is unambiguous even after the
  // ⓪ trim step's head cut shifts the effective start-end chord — a shorter leg length left this
  // borderline: the trimmed core's OWN chord could put every corner's perpendicular distance just
  // under the RDP epsilon by coincidence of the exact geometry, though the trim step's aliasing on
  // a perfectly-regular repeating zigzag is itself real, not just a short-leg artifact) @ 6 m/s ->
  // duration way over LIFT_MIN_DUR(60), so step② doesn't downgrade it before step③'s turn-check runs.
  // ⓪ trims the head (the repeating pattern's smeared local heading looks self-consistent enough to
  // read as a "core" for most of the run, but not the very start) — check the confirmed CORE, not
  // every single point (the trimmed head is legitimately its own, separate `ascent` verdict now).
  const out = zigzag(
    [
      [1, 0],
      [0, 1],
      [1, 0],
      [0, 1],
      [1, 0],
      [0, 1],
    ],
    6,
    200,
  );
  finalize(out, { g: {} });
  const core = out.slice(60, 140); // safely inside the confirmed core, away from the trimmed head/tail
  assert.ok(core.every((p) => p.liftConfirm.type === "powered"));
});

test("liftConfirm: winding but slow -> stays lift (a lift's own angle-station turns)", () => {
  const out = zigzag(
    [
      [1, 0],
      [0, 1],
      [1, 0],
      [0, 1],
    ],
    2,
    200,
  );
  finalize(out, { g: {} });
  const core = out.slice(150, 250); // safely inside the confirmed core (see prior test's note)
  assert.ok(core.every((p) => p.liftConfirm.type === "lift"));
});

test("liftConfirm: whole-run wander+confined+slow -> noise, and drops the points", () => {
  // small-radius scatter around a fixed centre, no net progress, slow — straightLong is fed in
  // directly (bypassing the windowed-signal subtlety this module's own doc flags vs. `drift`) so
  // this isolates step ④'s own independent whole-run wander check. 25 points @ 3 s apart = 72 s,
  // over LIFT_MIN_DUR(60) so step② doesn't downgrade it to ascent before step④ ever runs.
  const out = [];
  for (let i = 0; i < 25; i++) {
    const ang = (((i * 137) % 360) * Math.PI) / 180; // pseudo-random scatter directions
    out.push(
      pt({
        x: 10 * Math.cos(ang),
        y: 10 * Math.sin(ang),
        ele: 1000 + (i % 2),
        time: i * 3000,
        hs: 1,
        straightLong: 0.9,
      }),
    );
  }
  finalize(out, { g: {} });
  assert.ok(out.every((p) => p.liftConfirm.type === "noise"));
  assert.ok(out.every((p) => p.dropReason?.liftConfirm));
});

test("liftConfirm: powered-sandwich absorbs an isolated ascent run between two powered runs", () => {
  // id0/id2: powered (fast climb, 65 points @ 1 Hz = 64 s each — over LIFT_MIN_DUR so step③'s
  // fakeV check actually runs instead of step② downgrading them to ascent first). id1: a short,
  // non-straight lift-candidate (-> ascent on its own, via straightness). id1 should be absorbed
  // into powered by the sandwich pass.
  const powered1 = Array.from({ length: 65 }, (_, i) =>
    pt({
      segment: { id: 0, type: "lift" },
      x: i * 10,
      y: 0,
      ele: 1000 + i,
      time: i * 1000,
      hs: 10,
      straightLong: 0.9,
    }),
  );
  const ascentBase = 65000;
  const ascent = Array.from({ length: 10 }, (_, i) =>
    pt({
      segment: { id: 1, type: "lift" },
      x: 650 + i,
      y: 0,
      ele: 1065 + i,
      time: ascentBase + i * 1000,
      hs: 1,
      straightLong: 0.1, // fails straightness on its own -> would be "ascent" alone
    }),
  );
  const powered2Base = 75000;
  const powered2 = Array.from({ length: 65 }, (_, i) =>
    pt({
      segment: { id: 2, type: "lift" },
      x: 660 + i * 10,
      y: 0,
      ele: 1075 + i,
      time: powered2Base + i * 1000,
      hs: 10,
      straightLong: 0.9,
    }),
  );
  const out = [...powered1, ...ascent, ...powered2];
  finalize(out, { g: {} });
  assert.ok(powered1.every((p) => p.liftConfirm.type === "powered"));
  assert.ok(powered2.every((p) => p.liftConfirm.type === "powered"));
  assert.ok(ascent.every((p) => p.liftConfirm.type === "powered")); // absorbed, not left as ascent
});

test("liftConfirm: no lift candidates -> no-op", () => {
  const out = [{ lat: 36, lon: 138, segment: { id: 0, type: "descent" } }];
  finalize(out, { g: {} });
  assert.equal(out[0].liftConfirm, undefined);
});

test("liftConfirm: GPSQ_-style overrides via g.LIFT_* work", () => {
  const out = Array.from({ length: 70 }, (_, i) =>
    pt({ x: i * 3, y: 0, ele: 1000 + i * 2, time: i * 1000, hs: 3, straightLong: 0.9 }),
  );
  finalize(out, { g: { LIFT_HS_MAX: 2 } }); // now 3 m/s fails the speed cap
  assert.ok(out.every((p) => p.liftConfirm.type === "ascent"));
});
