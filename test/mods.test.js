import assert from "node:assert/strict";
import { test } from "node:test";
import { screen } from "../src/analyze.js";
import { deltas } from "../src/measure.js";
import { builtins, loadModule, validateModule } from "../src/mods/index.js";
import { PARAMS } from "../src/profile.js";

const outlier = builtins.find((m) => m.name === "outlier");
const screenMods = builtins.filter((m) => m.screen); // noTime, sameTime, oversample (in order)
const ramp = (n, f = (i) => i) => Array.from({ length: n }, (_, i) => f(i));

// ── registry / contract / loader ──

test("mods: builtins are the four named modules, routed by callback", () => {
  assert.deepEqual(
    builtins.map((m) => m.name),
    ["noTime", "sameTime", "oversample", "outlier"],
  );
  assert.deepEqual(
    screenMods.map((m) => m.name),
    ["noTime", "sameTime", "oversample"],
  );
  assert.equal(typeof outlier.compute, "function");
  assert.equal(outlier.screen, undefined); // outlier is compute-only
});

test("validateModule: rejects a module with no callbacks", () => {
  assert.throws(() => validateModule("bad", {}), /screen and\/or compute/);
  assert.throws(() => validateModule("", { compute: () => ({}) }), /non-empty string/);
  const ok = validateModule("ok", { screen: () => null });
  assert.equal(ok.name, "ok");
});

test("loadModule: a bare name falls back to the internal mods file", async () => {
  const m = await loadModule("noTime"); // no cwd file / npm pkg → resolves ./mods/noTime.js
  assert.equal(m.name, "noTime");
  assert.equal(typeof m.screen, "function");
});

test("loadModule: an unresolvable name throws", async () => {
  await assert.rejects(loadModule("definitely_not_a_module_xyz"), /cannot resolve module/);
});

// ── screen-phase modules (noTime, sameTime, oversample) ──

test("screen: drops sameTime/oversample/noTime against the last kept point, keeps the rest", () => {
  const at = (ms, lat = 36, lon = 138) => ({ lat, lon, ele: 0, time: ms });
  const pre = screen(
    [
      at(0), //          kept (first timed)
      at(0), //          sameTime (same time + position)
      at(0, 36.1), //    sameTime conflict (same time, moved)
      at(500), //        oversample (< 1 s from the kept point)
      at(1500), //       kept (>= 1 s from the last kept point)
      { lat: 36, lon: 138, ele: 0, time: null }, // noTime
    ],
    screenMods,
  );
  assert.equal(pre[0], null); // kept
  assert.deepEqual(pre[1], { sameTime: { moved: false } });
  assert.deepEqual(pre[2], { sameTime: { moved: true } });
  assert.deepEqual(pre[3], { oversample: { gap: 500 } });
  assert.equal(pre[4], null); // kept (measured from the first point, not the dropped ones)
  assert.deepEqual(pre[5], { noTime: true });
});

// ── compute-phase module (outlier) ──

test("outlier module: flags a perpendicular jump, clears a straight line", () => {
  const n = 40;
  const xs = ramp(n);
  const t = ramp(n);
  const hs = new Array(n).fill(1);
  const flat = new Array(n).fill(0);
  const run = (y, d) => outlier.compute({ x: xs, y, step: d.step, hs, dt: d.dt, g: PARAMS }).drop;
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
  const { step, dt } = deltas(xs, ys, ramp(n));
  const hs = new Array(n).fill(1);
  hs[20] = 70; // sudden speed spike -> accel ~ 69 > A_MAX, but the path stays straight
  const drop = outlier.compute({ x: xs, y: ys, step, hs, dt, g: PARAMS }).drop;
  assert.ok(drop[20] && drop[20].accel > PARAMS.A_MAX, `accel=${drop[20]?.accel}`);
  assert.ok(drop[20].detour <= PARAMS.D_JUMP); // not the detour trigger
  assert.equal(drop[19], null); // neighbour before the spike is clean
});
