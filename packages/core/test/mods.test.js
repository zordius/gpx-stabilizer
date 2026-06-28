import assert from "node:assert/strict";
import { test } from "node:test";
import { label } from "../src/analyze.js";
import { deltas } from "../src/measure.js";
import { builtins, loadModule, validateModule } from "../src/mods/index.js";
import { PARAMS } from "../src/profile.js";

const outlier = builtins.find((m) => m.name === "outlier");
const labelMods = builtins.filter((m) => m.label); // noTime, oversample (in order)
const ramp = (n, f = (i) => i) => Array.from({ length: n }, (_, i) => f(i));

// ── registry / contract / loader ──

test("mods: builtins are the named modules, routed by callback", () => {
  assert.deepEqual(
    builtins.map((m) => m.name),
    ["dequantizeTime", "noTime", "oversample", "outlier", "stray", "activity", "drift", "despike"],
  );
  assert.deepEqual(
    labelMods.map((m) => m.name),
    ["noTime", "oversample"],
  );
  assert.equal(
    builtins.find((m) => m.name === "dequantizeTime").repair instanceof Function,
    true, // dequantizeTime is repair-only
  );
  assert.equal(typeof outlier.compute, "function");
  assert.equal(outlier.label, undefined); // outlier is compute-only
});

test("validateModule: rejects a module with no callbacks", () => {
  assert.throws(() => validateModule("bad", {}), /repair, label and\/or compute/);
  assert.throws(() => validateModule("", { compute: () => ({}) }), /non-empty string/);
  const ok = validateModule("ok", { repair: () => {} });
  assert.equal(ok.name, "ok");
});

test("loadModule: a bare name falls back to the internal mods file", async () => {
  const m = await loadModule("noTime"); // no cwd file / npm pkg → resolves ./mods/noTime.js
  assert.equal(m.name, "noTime");
  assert.equal(typeof m.label, "function");
});

test("loadModule: an unresolvable name throws", async () => {
  await assert.rejects(loadModule("definitely_not_a_module_xyz"), /cannot resolve module/);
});

// ── label-phase modules (noTime, oversample) — drop via the reserved `drop` key ──

test("label: oversample drops sub-0.5 s points and noTime drops untimed, against the last kept", () => {
  const at = (ms) => ({ lat: 36, lon: 138, ele: 0, time: ms });
  const bags = label(
    [
      at(0), //          kept (first timed)
      at(300), //        oversample (< 0.5 s from the kept point)
      at(1300), //       kept (>= 0.5 s from the last kept point)
      at(1500), //       oversample (0.2 s from the 1300 point)
      { lat: 36, lon: 138, ele: 0, time: null }, // noTime
    ],
    labelMods,
  );
  assert.equal(bags[0], null); // kept
  assert.deepEqual(bags[1], { oversample: { drop: { gap: 300 } } });
  assert.equal(bags[2], null); // kept (measured from the first point, not the dropped one)
  assert.deepEqual(bags[3], { oversample: { drop: { gap: 200 } } });
  assert.deepEqual(bags[4], { noTime: { drop: true } });
});

// ── compute-phase module (outlier) ──

test("outlier module: flags a perpendicular jump, clears a straight line", () => {
  const n = 40;
  const xs = ramp(n);
  const t = ramp(n);
  const hs = new Array(n).fill(1);
  const flat = new Array(n).fill(0);
  const run = (y, d) =>
    outlier.compute({ x: xs, y, planarStep: d.planarStep, hs, dt: d.dt, g: PARAMS }).drop;
  assert.equal(run(flat, deltas(xs, flat, t))[20], null); // clean -> no context
  const bumped = flat.slice();
  bumped[20] = 100; // one point jumps 100 m sideways
  const ctx = run(bumped, deltas(xs, bumped, t))[20];
  assert.ok(ctx && ctx.detour > PARAMS.D_JUMP); // flagged with the evidence
});

test("outlier module: an acceleration spike alone flags an outlier", () => {
  const n = 40;
  const xs = ramp(n); // straight line -> detour ~ 0
  const ys = new Array(n).fill(0);
  const { planarStep, dt } = deltas(xs, ys, ramp(n));
  const hs = new Array(n).fill(1);
  hs[20] = 70; // sudden speed spike -> accel ~ 69 > A_MAX, but the path stays straight
  const drop = outlier.compute({ x: xs, y: ys, planarStep, hs, dt, g: PARAMS }).drop;
  assert.ok(drop[20] && drop[20].accel > PARAMS.A_MAX, `accel=${drop[20]?.accel}`);
  assert.ok(drop[20].detour <= PARAMS.D_JUMP); // not the detour trigger
  assert.equal(drop[19], null); // neighbour before the spike is clean
});
