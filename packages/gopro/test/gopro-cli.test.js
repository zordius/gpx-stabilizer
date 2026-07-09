import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// The CLI's arg-parsing is top-level script logic (not an exported function), so this is the one
// place these tests can only be exercised by actually spawning it as a subprocess.
const CLI = fileURLToPath(new URL("../src/gopro-cli.js", import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

test("gopro-cli: an unrecognized --xxx option exits with an error, before touching any input", () => {
  // "no-such-file.mp4" is never opened: the unknown flag must fail during arg-parsing, ahead of
  // any file access.
  const res = run(["--frobnicate", "no-such-file.mp4"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown option --frobnicate/);
});

test("gopro-cli: an unrecognized boolean-style flag (no value) also exits with an error", () => {
  const res = run(["--bogus", "no-such-file.mp4"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown option --bogus/);
});

test("gopro-cli: no inputs at all still exits with the usage error (unaffected by the new check)", () => {
  const res = run([]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /usage: gpx-from-gopro/);
});

test("gopro-cli: --mode is a recognized flag now (stabilizes the output via gpx-stabilizer's own MODES)", () => {
  // a valid --mode value must NOT be rejected as an unknown option -- it fails later, same as any
  // other run against a nonexistent file (no video files found), never on arg-parsing.
  const res = run(["--mode", "ski", "no-such-file.mp4"]);
  assert.doesNotMatch(res.stderr, /unknown option --mode/);
  assert.match(res.stderr, /no video files found/);
});

test("gopro-cli: an unknown --mode value exits with an error listing the real modes, before touching any input", () => {
  const res = run(["--mode", "nope", "no-such-file.mp4"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown --mode "nope"/);
  assert.match(res.stderr, /core, ski/);
});
