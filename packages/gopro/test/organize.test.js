import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cachePath } from "../src/gopro-cache.js";
import { cacheMovePlan, executeMove, findSidecars, moveFile, planMove } from "../src/organize.js";

const withTmp = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "gpxorganize-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// minimal GroupEntry — points are irrelevant to organize.js, only grouping fields + file matter
const entry = (over) => ({
  family: "GX",
  date: "20260628",
  serial: "s1",
  session: "5131",
  points: [],
  ...over,
});

// ---- planMove (pure) ----

test("planMove: places a file under <root>/<group>/<session>/", () => {
  const { files } = planMove([entry({ file: "/src/GX010001.MP4" })], { root: "/out" });
  assert.equal(files.length, 1);
  assert.equal(files[0].group, "20260628-GX");
  assert.equal(files[0].destDir, join("/out", "20260628-GX", "5131"));
  assert.equal(files[0].destPath, join("/out", "20260628-GX", "5131", "GX010001.MP4"));
});

test("planMove: different sessions land in different subfolders under the same group", () => {
  const { files } = planMove(
    [
      entry({ file: "/src/GX010001.MP4", session: "5131" }),
      entry({ file: "/src/GX010002.MP4", session: "5132" }),
    ],
    { root: "/out" },
  );
  assert.equal(files[0].destDir, join("/out", "20260628-GX", "5131"));
  assert.equal(files[1].destDir, join("/out", "20260628-GX", "5132"));
});

test("planMove: no file-number falls back to a 'no-session' subfolder", () => {
  const { files } = planMove([entry({ file: "/src/weird.mov", session: null })], { root: "/out" });
  assert.equal(files[0].destDir, join("/out", "20260628-GX", "no-session"));
});

test("planMove: group name matches groupNames()' serial-clash disambiguation (same as the .gpx)", () => {
  const { files } = planMove(
    [
      entry({ file: "/a/GX010001.MP4", serial: "aaaa1111" }),
      entry({ file: "/b/GX010001.MP4", serial: "bbbb2222" }),
    ],
    { root: "/out" },
  );
  const groups = files.map((f) => f.group).sort();
  assert.deepEqual(groups, ["20260628-GX-aaaa1111", "20260628-GX-bbbb2222"]);
});

test("planMove: entries without `file` are skipped, not crashed on", () => {
  const { files } = planMove([entry({ file: undefined }), entry({ file: "/src/a.mp4" })], {
    root: "/out",
  });
  assert.equal(files.length, 1);
});

test("planMove: includeGpx adds one from/to pair per distinct group, matching the .gpx filename", () => {
  const { gpx } = planMove(
    [
      entry({ file: "/src/GX010001.MP4", session: "5131" }),
      entry({ file: "/src/GX010002.MP4", session: "5132" }), // same group, different session
    ],
    { root: "/out", outDir: "/gpxout", includeGpx: true },
  );
  assert.equal(gpx.length, 1); // one group, not one per file
  assert.equal(gpx[0].from, join("/gpxout", "20260628-GX.gpx"));
  assert.equal(gpx[0].to, join("/out", "20260628-GX", "20260628-GX.gpx"));
});

test("planMove: gpx stays empty when includeGpx is false or outDir is omitted", () => {
  const entries = [entry({ file: "/src/a.mp4" })];
  assert.equal(planMove(entries, { root: "/out" }).gpx.length, 0);
  assert.equal(planMove(entries, { root: "/out", includeGpx: true }).gpx.length, 0); // no outDir
});

// ---- findSidecars (real fs) ----

test("findSidecars: finds same-stem .LRV/.THM, case-insensitively, ignores unrelated files", () => {
  withTmp((dir) => {
    writeFileSync(join(dir, "GX010001.MP4"), "x");
    writeFileSync(join(dir, "GX010001.LRV"), "x");
    writeFileSync(join(dir, "GX010001.thm"), "x"); // lowercase ext
    writeFileSync(join(dir, "GX010002.LRV"), "x"); // different stem -> not a match
    const found = findSidecars(join(dir, "GX010001.MP4")).sort();
    assert.deepEqual(found, [join(dir, "GX010001.LRV"), join(dir, "GX010001.thm")].sort());
  });
});

test("findSidecars: no sidecars -> empty array", () => {
  withTmp((dir) => {
    writeFileSync(join(dir, "GX010001.MP4"), "x");
    assert.deepEqual(findSidecars(join(dir, "GX010001.MP4")), []);
  });
});

test("findSidecars: a missing directory returns [] instead of throwing", () => {
  assert.deepEqual(findSidecars("/definitely/not/here/GX010001.MP4"), []);
});

// ---- moveFile (real fs + injected EXDEV fallback) ----

test("moveFile: happy path renames within the same filesystem", () => {
  withTmp((dir) => {
    const src = join(dir, "a.txt");
    const dest = join(dir, "b.txt");
    writeFileSync(src, "hello");
    moveFile(src, dest);
    assert.equal(existsSync(src), false);
    assert.equal(readFileSync(dest, "utf8"), "hello");
  });
});

test("moveFile: EXDEV from an injected rename falls back to copy+unlink", () => {
  withTmp((dir) => {
    const src = join(dir, "a.txt");
    const dest = join(dir, "b.txt");
    writeFileSync(src, "cross-device");
    const fakeRename = () => {
      const e = new Error("cross-device link");
      e.code = "EXDEV";
      throw e;
    };
    moveFile(src, dest, fakeRename);
    assert.equal(existsSync(src), false); // unlinked after copy
    assert.equal(readFileSync(dest, "utf8"), "cross-device");
  });
});

test("moveFile: a non-EXDEV error from rename propagates", () => {
  const boom = () => {
    throw new Error("boom");
  };
  assert.throws(() => moveFile("/a", "/b", boom), /boom/);
});

// ---- cacheMovePlan ----

test("cacheMovePlan: sidecar mode moves <file>.gpxcache.json alongside", () => {
  const plan = cacheMovePlan("/src/GX010001.MP4", "/out/g/5131/GX010001.MP4", true);
  assert.deepEqual(plan, {
    from: "/src/GX010001.MP4.gpxcache.json",
    to: "/out/g/5131/GX010001.MP4.gpxcache.json",
  });
});

test("cacheMovePlan: caching off -> null (nothing to move)", () => {
  assert.equal(cacheMovePlan("/src/a.mp4", "/out/a.mp4", false), null);
});

test("cacheMovePlan: --cache-dir mode re-derives the hashed name for the NEW path", () => {
  const cache = { dir: "/cachedir" };
  const plan = cacheMovePlan("/src/GX010001.MP4", "/out/g/5131/GX010001.MP4", cache);
  assert.equal(plan.from, cachePath("/src/GX010001.MP4", "/cachedir"));
  assert.equal(plan.to, cachePath("/out/g/5131/GX010001.MP4", "/cachedir"));
  assert.notEqual(plan.from, plan.to); // different resolved source path -> different hash
});

// ---- executeMove (real fs, end-to-end) ----

test("executeMove: moves mp4 + its sidecar cache, deletes LRV/THM by default", () => {
  withTmp((dir) => {
    const src = join(dir, "src");
    const root = join(dir, "root");
    mkdirSync(src, { recursive: true });
    const mp4 = join(src, "GX010001.MP4");
    writeFileSync(mp4, "video");
    writeFileSync(`${mp4}.gpxcache.json`, "{}");
    writeFileSync(join(src, "GX010001.LRV"), "preview");
    writeFileSync(join(src, "GX010001.THM"), "thumb");

    const plan = planMove([entry({ file: mp4 })], { root });
    const summary = executeMove(plan, { cache: true, sidecarAction: "delete" });

    const destPath = join(root, "20260628-GX", "5131", "GX010001.MP4");
    assert.equal(existsSync(destPath), true);
    assert.equal(existsSync(mp4), false);
    assert.equal(existsSync(`${destPath}.gpxcache.json`), true);
    assert.equal(existsSync(join(src, "GX010001.LRV")), false); // deleted
    assert.equal(existsSync(join(src, "GX010001.THM")), false); // deleted
    assert.deepEqual(summary, {
      moved: 1,
      gpxMoved: 0,
      cacheMoved: 1,
      sidecarsMoved: 0,
      sidecarsDeleted: 2,
      skippedCollisions: 0,
      errors: [],
    });
  });
});

test("executeMove: sidecarAction 'move' relocates LRV/THM alongside instead of deleting", () => {
  withTmp((dir) => {
    const mp4 = join(dir, "GX010001.MP4");
    writeFileSync(mp4, "video");
    writeFileSync(join(dir, "GX010001.LRV"), "preview");
    const root = join(dir, "root");

    const plan = planMove([entry({ file: mp4 })], { root });
    const summary = executeMove(plan, { cache: false, sidecarAction: "move" });

    const destDir = join(root, "20260628-GX", "5131");
    assert.equal(existsSync(join(destDir, "GX010001.LRV")), true);
    assert.equal(summary.sidecarsMoved, 1);
    assert.equal(summary.sidecarsDeleted, 0);
  });
});

test("executeMove: never overwrites an existing destination — skips and counts the collision", () => {
  withTmp((dir) => {
    const mp4 = join(dir, "GX010001.MP4");
    writeFileSync(mp4, "new content");
    const root = join(dir, "root");
    const destDir = join(root, "20260628-GX", "5131");
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "GX010001.MP4"), "already here");

    const plan = planMove([entry({ file: mp4 })], { root });
    const summary = executeMove(plan);

    assert.equal(summary.skippedCollisions, 1);
    assert.equal(summary.moved, 0);
    assert.equal(existsSync(mp4), true); // untouched — never overwritten, never deleted
    assert.equal(readFileSync(join(destDir, "GX010001.MP4"), "utf8"), "already here");
  });
});

test("executeMove: moves the group's .gpx into its folder when planned", () => {
  withTmp((dir) => {
    const src = join(dir, "src");
    const outDir = join(dir, "gpxout");
    const root = join(dir, "root");
    mkdirSync(src, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    const mp4 = join(src, "GX010001.MP4");
    writeFileSync(mp4, "video");
    writeFileSync(join(outDir, "20260628-GX.gpx"), "<gpx/>");

    const plan = planMove([entry({ file: mp4 })], { root, outDir, includeGpx: true });
    const summary = executeMove(plan, { cache: false, sidecarAction: "skip" });

    assert.equal(existsSync(join(root, "20260628-GX", "20260628-GX.gpx")), true);
    assert.equal(existsSync(join(outDir, "20260628-GX.gpx")), false);
    assert.equal(summary.gpxMoved, 1);
  });
});

test("executeMove: a gpx that was never written (group skipped) is silently left alone", () => {
  withTmp((dir) => {
    const mp4 = join(dir, "GX010001.MP4");
    writeFileSync(mp4, "video");
    const root = join(dir, "root");
    const outDir = join(dir, "gpxout"); // no .gpx ever written here

    const plan = planMove([entry({ file: mp4 })], { root, outDir, includeGpx: true });
    const summary = executeMove(plan, { cache: false, sidecarAction: "skip" });

    assert.equal(summary.gpxMoved, 0);
    assert.deepEqual(summary.errors, []);
  });
});
