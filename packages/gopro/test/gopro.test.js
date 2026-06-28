import assert from "node:assert/strict";
import { test } from "node:test";
import { goproModel, readUdtaAtom, readUdtaRaw } from "../src/gopro.js";

test("goproModel: maps a firmware prefix to the camera model", () => {
  assert.equal(goproModel("HD5.02.02.60.00"), "HERO5"); // verified real Hero5
  assert.equal(goproModel("H21.01.01.62.00"), "HERO10"); // verified real Hero10
  assert.equal(goproModel("HD8.01.00"), "HERO8");
  assert.equal(goproModel("ZZ9.00"), null); // unknown prefix
  assert.equal(goproModel(null), null);
});

test("readUdtaAtom: reads a GoPro udta atom string by 4CC", () => {
  const s = "HD5.02.02.60.00";
  const head = Buffer.alloc(4);
  head.writeUInt32BE(8 + s.length, 0); // atom size = 4 (size) + 4 (4CC) + data
  const buf = Buffer.concat([
    Buffer.from("....prefix...."),
    head,
    Buffer.from("FIRM"),
    Buffer.from(s),
  ]);
  assert.equal(readUdtaAtom(buf, "FIRM"), "HD5.02.02.60.00");
  assert.equal(readUdtaAtom(buf, "NOPE"), null); // absent 4CC
  assert.equal(readUdtaAtom(Buffer.from("FIRM short"), "FIRM"), null); // 4CC too early (no size prefix)
});

test("readUdtaRaw: returns the raw atom bytes (for binary atoms like CAME)", () => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(8 + 3, 0); // size = 4 (size) + 4 (4CC) + 3 (data)
  const buf = Buffer.concat([
    Buffer.from("xxxx"),
    head,
    Buffer.from("CAME"),
    Buffer.from([0xab, 0xcd, 0xef]),
  ]);
  assert.equal(readUdtaRaw(buf, "CAME")?.toString("hex"), "abcdef");
  assert.equal(readUdtaRaw(buf, "NONE"), null);
});
