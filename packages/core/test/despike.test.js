import assert from "node:assert/strict";
import { test } from "node:test";
import { compute } from "../src/mods/despike.js";

// A ~150° single-vertex turn at index 1 (heading 0° then 150°), then continuing straight — no
// reversal, no big jump, so only the lone-hairpin rule is in play.
const mk = (g) => compute({ x: [0, 1, 0.134, -0.732], y: [0, 0, 0.5, 1.0], n: 4, g });

test("despike: DESPIKE_PROFILE switches the lone-hairpin threshold (core conservative, ski aggressive)", () => {
  const core = mk({}); // default profile = core (LONE 160°) → a ~150° turn is a real corner, kept
  const ski = mk({ DESPIKE_PROFILE: "ski" }); // ski (LONE 120°) → 150° exceeds it, flagged
  assert.equal(core.flagged[1], null);
  assert.ok(ski.flagged[1]?.lone !== undefined);
});

test("despike: per-key g.DESPIKE_* overrides the profile", () => {
  const overridden = mk({ DESPIKE_LONE: 120 }); // force a low lone threshold despite the core profile
  assert.ok(overridden.flagged[1]?.lone !== undefined);
});
