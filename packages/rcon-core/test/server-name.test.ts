import { test } from "node:test";
import assert from "node:assert/strict";
import { serverNameFromSession } from "../src/server-name.ts";

test("reads a top-level ServerName", () => {
  assert.equal(serverNameFromSession({ ServerName: "Alpha", MapName: "carentan" }), "Alpha");
});

test("falls back through candidate keys", () => {
  assert.equal(serverNameFromSession({ name: "lowercase name" }), "lowercase name");
  assert.equal(serverNameFromSession({ Hostname: "host name" }), "host name");
});

test("reads a nested name (wrapped response)", () => {
  assert.equal(serverNameFromSession({ Result: { ServerName: "Nested" } }), "Nested");
  assert.equal(serverNameFromSession({ session: { Name: "Deep" } }), "Deep");
});

test("returns null when no name-like field exists", () => {
  assert.equal(serverNameFromSession({ MapName: "carentan", PlayerCount: 40 }), null);
});

test("ignores empty / non-string names and bad input", () => {
  assert.equal(serverNameFromSession({ ServerName: "   " }), null);
  assert.equal(serverNameFromSession({ ServerName: 123 }), null);
  assert.equal(serverNameFromSession(null), null);
  assert.equal(serverNameFromSession("a string"), null);
});

test("trims surrounding whitespace", () => {
  assert.equal(serverNameFromSession({ ServerName: "  Trimmed  " }), "Trimmed");
});
