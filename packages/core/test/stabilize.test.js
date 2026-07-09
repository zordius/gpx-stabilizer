import assert from "node:assert/strict";
import { test } from "node:test";
import { stabilize, stabilizeTrack } from "../src/stabilize.js";

const MX = Math.cos((36 * Math.PI) / 180) * 111320;
const STEP5 = 5 / MX; // ~5 m/s eastward in degrees of longitude

test("stabilize: drops flagged points and reduces survivors to plain track points", () => {
  const pts = [
    { lat: 36, lon: 138, ele: 1000, time: 0 }, //                   kept
    { lat: 36, lon: 138, ele: 1000, time: 200 }, //                 raw < 0.5 s burst -> dropped
    { lat: 36, lon: 138 + STEP5, ele: 1000, time: 1000 }, //        kept
    { lat: 36, lon: 138 + 2 * STEP5, ele: 1000, time: 2000 }, //    kept
  ];
  const clean = stabilize(pts);
  assert.ok(clean.length < pts.length); // the dense (< 0.5 s) sample is gone
  for (const p of clean) {
    // reduced to plain track points — no analysis signals carried through
    assert.deepEqual(Object.keys(p).sort(), ["ele", "lat", "lon", "time"]);
  }
});

test("stabilize: opts.liftSnap swaps lat/lon when point.liftSnap is present, else raw", () => {
  // a stand-in finalize module, not the real liftSnap.js — liftConfirm/liftSnap's OWN correctness
  // is covered by their dedicated test files; this only tests stabilize's own export branching.
  const fakeLiftSnap = {
    name: "fakeLiftSnap",
    finalize: (out) => {
      out[0].liftSnap = { lat: 99, lon: 88 };
    },
  };
  const pts = [
    { lat: 36, lon: 138, ele: 1000, time: 0 },
    { lat: 36, lon: 138 + STEP5, ele: 1000, time: 1000 },
  ];
  const withFlag = stabilize(pts, { modules: [fakeLiftSnap], liftSnap: true });
  assert.equal(withFlag[0].lat, 99);
  assert.equal(withFlag[0].lon, 88);
  assert.equal(withFlag[1].lat, 36); // untouched point stays raw

  const withoutFlag = stabilize(pts, { modules: [fakeLiftSnap] }); // module ran, export flag off
  assert.equal(withoutFlag[0].lat, 36); // stays raw even though point.liftSnap was computed
});

test("stabilize: opts.liftSnap's ele wins over gradeBound/smooth when present, else falls through", () => {
  const fakeLiftSnap = {
    name: "fakeLiftSnap",
    finalize: (out) => {
      out[0].liftSnap = { lat: out[0].lat, lon: out[0].lon, ele: 500 };
    },
  };
  const pts = [
    { lat: 36, lon: 138, ele: 1000, time: 0 },
    { lat: 36, lon: 138 + STEP5, ele: 1000, time: 1000 },
    { lat: 36, lon: 138 + 2 * STEP5, ele: 1000, time: 2000 },
  ];
  const out = stabilize(pts, { modules: [fakeLiftSnap], liftSnap: true, smooth: true });
  assert.equal(out[0].ele, 500); // liftSnap wins over smooth
  assert.notEqual(out[1].ele, 500); // no liftSnap.ele here -> falls through to smooth's value
});

test("stabilize: opts.tangleSnap swaps lat/lon ahead of liftSnap when point.tangleSnap is present", () => {
  const fakeSnaps = {
    name: "fakeSnaps",
    finalize: (out) => {
      out[0].liftSnap = { lat: 99, lon: 88 };
      out[0].tangleSnap = { lat: 11, lon: 22 };
    },
  };
  const pts = [
    { lat: 36, lon: 138, ele: 1000, time: 0 },
    { lat: 36, lon: 138 + STEP5, ele: 1000, time: 1000 },
  ];
  const withBoth = stabilize(pts, { modules: [fakeSnaps], liftSnap: true, tangleSnap: true });
  assert.equal(withBoth[0].lat, 11); // tangleSnap wins over liftSnap
  assert.equal(withBoth[0].lon, 22);

  const liftOnly = stabilize(pts, { modules: [fakeSnaps], liftSnap: true });
  assert.equal(liftOnly[0].lat, 99); // tangleSnap flag off -> falls through to liftSnap

  const neither = stabilize(pts, { modules: [fakeSnaps] });
  assert.equal(neither[0].lat, 36); // both flags off -> stays raw
});

test("stabilize: opts.liftBoardingEle's ele wins over liftSnap's when point.liftBoardingEle is present", () => {
  const fakeSnaps = {
    name: "fakeSnaps",
    finalize: (out) => {
      out[0].liftSnap = { lat: out[0].lat, lon: out[0].lon, ele: 500 };
      out[0].liftBoardingEle = { ele: 700 };
    },
  };
  const pts = [
    { lat: 36, lon: 138, ele: 1000, time: 0 },
    { lat: 36, lon: 138 + STEP5, ele: 1000, time: 1000 },
  ];
  const withBoth = stabilize(pts, { modules: [fakeSnaps], liftSnap: true, liftBoardingEle: true });
  assert.equal(withBoth[0].ele, 700); // liftBoardingEle wins over liftSnap

  const liftOnly = stabilize(pts, { modules: [fakeSnaps], liftSnap: true });
  assert.equal(liftOnly[0].ele, 500); // liftBoardingEle flag off -> falls through to liftSnap

  const neither = stabilize(pts, { modules: [fakeSnaps] });
  assert.equal(neither[0].ele, 1000); // both flags off -> stays raw
});

test("stabilize: opts.liftBoardingEle's null ele is a final DROP, not a fall-through to liftSnap/raw", () => {
  // liftBoardingEle's HEAD mechanism drops an unrecoverable queue-region elevation via `{ ele: null
  // }` rather than a `??`-transparent "no opinion" — presence of the field must win outright, same as
  // when it carries a real replacement value.
  const fakeSnaps = {
    name: "fakeSnaps",
    finalize: (out) => {
      out[0].liftSnap = { lat: out[0].lat, lon: out[0].lon, ele: 500 };
      out[0].liftBoardingEle = { ele: null };
    },
  };
  const pts = [
    { lat: 36, lon: 138, ele: 1000, time: 0 },
    { lat: 36, lon: 138 + STEP5, ele: 1000, time: 1000 },
  ];
  const withBoth = stabilize(pts, { modules: [fakeSnaps], liftSnap: true, liftBoardingEle: true });
  assert.equal(withBoth[0].ele, null); // dropped, not liftSnap's 500

  const liftOnly = stabilize(pts, { modules: [fakeSnaps], liftSnap: true });
  assert.equal(liftOnly[0].ele, 500); // liftBoardingEle flag off -> falls through to liftSnap as usual
});

// A gentle, long-wavelength lateral wobble (one sine cycle spans the whole run, ~1m amplitude) —
// large enough for liftSnap's best-fit line to visibly flatten, gentle enough to stay well within
// liftConfirm's straightness/turn-rate gates (unlike a per-step alternating jitter, which reads as a
// reversal/lone-hairpin to despike and gets points dropped before liftSnap ever sees them).
function wobblyClimb() {
  return Array.from({ length: 90 }, (_, i) => ({
    lat: 36 + 0.00001 * Math.sin(i / 6),
    lon: 138 + i * (3 / MX), // ~3 m/s east
    ele: 1000 + i * 0.5, // ~0.5 m/s climb — a sustained lift-like ride
    time: i * 1000,
  }));
}

test("stabilize: opts.mode='ski' auto-wires liftConfirm+liftSnap — a real lift run gets snapped without manually loading modules", () => {
  const pts = wobblyClimb();
  const out = stabilize(pts, { mode: "ski" });
  assert.equal(out.length, pts.length); // nothing dropped
  // interior points (well past liftSnap's own 20 m boundary fade) get pulled onto the fitted line —
  // the raw wobble should collapse, not survive into the export
  const range = (arr) => Math.max(...arr) - Math.min(...arr);
  const rawRange = range(pts.slice(15, 75).map((p) => p.lat));
  const outRange = range(out.slice(15, 75).map((p) => p.lat));
  assert.ok(outRange < rawRange * 0.5, "liftSnap flattened the lateral wobble");
});

test("stabilize: opts.mode='ski' preset flags are defaults — an explicit opt still overrides them", () => {
  const pts = wobblyClimb();
  const out = stabilize(pts, { mode: "ski", liftSnap: false });
  assert.equal(out.length, pts.length);
  const rawInterior = pts.slice(15, 75).map((p) => p.lat);
  const outInterior = out.slice(15, 75).map((p) => p.lat);
  assert.deepEqual(outInterior, rawInterior); // export flag explicitly off -> raw lat passes through
});

test("stabilize: an unknown opts.mode throws a clear error", () => {
  const pts = [{ lat: 36, lon: 138, ele: 1000, time: 0 }];
  assert.throws(() => stabilize(pts, { mode: "nope" }), /unknown mode "nope"/);
});

test("stabilizeTrack: stabilizes each segment and preserves meta", () => {
  const track = {
    segments: [
      [
        { lat: 36, lon: 138, ele: 1000, time: 0 },
        { lat: 36, lon: 138, ele: 1000, time: 0 }, // duplicate -> re-timed to 0.5 s, kept
        { lat: 36, lon: 138 + STEP5, ele: 1000, time: 1000 },
      ],
    ],
    meta: { name: "demo" },
  };
  const out = stabilizeTrack(track);
  assert.equal(out.meta.name, "demo"); // metadata preserved
  assert.equal(out.segments.length, 1);
  assert.equal(out.segments[0].length, 3); // duplicate re-timed and kept (0, 0.5, 1 s)
});

test("stabilizeTrack: re-splits at ORIGINAL segment boundaries even with zero time gap between them", () => {
  // two source <trkseg>s that continue seamlessly (same direction/speed, no gap at all) -- e.g. a
  // GoPro clip switch with no real interruption. The boundary must still show up in the OUTPUT: it's
  // tracked by which source segment a point came from, not by any gap/drop heuristic.
  const track = {
    segments: [
      [
        { lat: 36, lon: 138, ele: 1000, time: 0 },
        { lat: 36, lon: 138 + STEP5, ele: 1001, time: 1000 },
      ],
      [
        { lat: 36, lon: 138 + 2 * STEP5, ele: 1002, time: 2000 },
        { lat: 36, lon: 138 + 3 * STEP5, ele: 1003, time: 3000 },
      ],
    ],
  };
  const out = stabilizeTrack(track);
  assert.equal(out.segments.length, 2); // original boundary preserved despite zero gap
  assert.equal(out.segments[0].length, 2);
  assert.equal(out.segments[1].length, 2);
  assert.equal(out.segments[1][0].time, 2000); // second output segment starts exactly at the source's
  assert.ok(!("origSeg" in out.segments[0][0])); // internal bookkeeping stripped from the public shape
});

test("stabilizeTrack: analyzes across the ORIGINAL boundary as one continuous stream (merged, not per-segment)", () => {
  // a step in elevation exactly at the source boundary -- if each segment were smoothed in ISOLATION
  // (the old behaviour), segment 1's own smoothed ele could never see segment 2's 2000 m readings at
  // all, so it would stay exactly 1000 throughout it. Seeing it pulled up near the boundary proves the
  // whole track was analyzed as one continuous stream before being re-split for output.
  const track = {
    segments: [
      Array.from({ length: 10 }, (_, i) => ({ lat: 36, lon: 138 + i * STEP5, ele: 1000, time: i * 1000 })),
      Array.from({ length: 10 }, (_, i) => ({
        lat: 36,
        lon: 138 + (10 + i) * STEP5,
        ele: 2000,
        time: (10 + i) * 1000,
      })),
    ],
  };
  const out = stabilizeTrack(track, { smooth: true });
  assert.equal(out.segments.length, 2); // the boundary is still preserved in the output
  const lastOfFirst = out.segments[0].at(-1);
  assert.ok(lastOfFirst.ele > 1000, `expected smoothing to reach across the boundary, got ${lastOfFirst.ele}`);
});
