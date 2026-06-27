import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cachePath, readCache, writeCache } from "../src/gopro-cache.js";

const ident = { v: 1, size: 100, mtime: 200, rate: null };
const withTmp = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "gpxcache-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("writeCache then readCache round-trips when identity matches", () => {
  withTmp((dir) => {
    const p = join(dir, "x.json");
    const rec = { ...ident, hasGps: true, points: [{ lat: 1, lon: 2 }] };
    assert.equal(writeCache(p, rec), true);
    assert.deepEqual(readCache(p, ident), rec);
  });
});

test("readCache misses on any identity mismatch (v/size/mtime/rate)", () => {
  withTmp((dir) => {
    const p = join(dir, "x.json");
    writeCache(p, { ...ident, hasGps: false });
    assert.equal(readCache(p, { ...ident, v: 2 }), null);
    assert.equal(readCache(p, { ...ident, size: 999 }), null);
    assert.equal(readCache(p, { ...ident, mtime: 999 }), null);
    assert.equal(readCache(p, { ...ident, rate: 1000 }), null);
    assert.deepEqual(readCache(p, ident), { ...ident, hasGps: false }); // exact match still hits
  });
});

test("readCache returns null for a missing or unreadable file", () => {
  assert.equal(readCache(join(tmpdir(), "definitely-not-here-9f8a.json"), ident), null);
});

test("cachePath: sidecar by default, hashed name under cacheDir", () => {
  assert.equal(cachePath("/a/b/GX01.MP4"), "/a/b/GX01.MP4.gpxcache.json");
  assert.match(cachePath("/a/b/GX01.MP4", "/cache"), /^\/cache\/GX01\.MP4\.[0-9a-f]{16}\.json$/);
});

test("writeCache creates a missing cacheDir and is atomic (no .tmp left)", () => {
  withTmp((base) => {
    const sub = join(base, "nested", "deeper");
    const p = join(sub, "x.json");
    assert.equal(writeCache(p, { ...ident }, sub), true);
    assert.deepEqual(readCache(p, ident), { ...ident });
    assert.equal(readCache(`${p}.tmp`, ident), null); // temp was renamed away
  });
});
