import { test } from "node:test";
import assert from "node:assert/strict";
import { packHeader, unpackHeader, headerSize, xor, MAGIC_HEADER_VALUE } from "../src/protocol/binary-v2/frame.ts";

test("magic header round-trips", () => {
  const h = packHeader("magic", 7, 123);
  assert.equal(h.length, headerSize("magic"));
  const p = unpackHeader("magic", h);
  assert.equal(p.magic, MAGIC_HEADER_VALUE);
  assert.equal(p.requestId, 7);
  assert.equal(p.bodyLen, 123);
});

test("legacy header round-trips (no magic)", () => {
  const h = packHeader("legacy", 42, 999);
  assert.equal(h.length, headerSize("legacy"));
  const p = unpackHeader("legacy", h);
  assert.equal(p.magic, undefined);
  assert.equal(p.requestId, 42);
  assert.equal(p.bodyLen, 999);
});

test("bad magic is rejected", () => {
  const buf = Buffer.alloc(12);
  buf.writeUInt32LE(0x12345678, 0);
  assert.throws(() => unpackHeader("magic", buf), /Invalid magic/);
});

test("xor is symmetric (encrypt then decrypt)", () => {
  const key = Buffer.from([0x01, 0x02, 0x03, 0xff, 0x7a]);
  const plain = Buffer.from(JSON.stringify({ name: "GetServerInformation", contentBody: "players" }), "utf8");
  const enc = xor(plain, key);
  assert.notDeepEqual(enc, plain);
  const dec = xor(enc, key);
  assert.deepEqual(dec, plain);
});

test("xor with no key is a no-op (pre-handshake)", () => {
  const plain = Buffer.from("ServerConnect", "utf8");
  assert.deepEqual(xor(plain, null), plain);
  assert.deepEqual(xor(plain, Buffer.alloc(0)), plain);
});
