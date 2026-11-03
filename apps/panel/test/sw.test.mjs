// The service worker (public/sw.js): it shows what the panel's server sends, and a tap opens the
// panel where the notification points — the open panel goes there itself, or a new window opens.
// Run in a sandbox standing in for the worker's global scope.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "public", "sw.js"), "utf8");

function worker({ windows = [] } = {}) {
  const on = {};
  const shown = [];
  const opened = [];
  const self = {
    addEventListener: (type, fn) => { on[type] = fn; },
    skipWaiting: () => {},
    location: { origin: "https://panel.example" },
    registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (url) => { opened.push(url); },
    },
  };
  vm.runInNewContext(SOURCE, { self, URL });
  const fire = async (type, event) => {
    const waits = [];
    on[type]({ ...event, waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  return { fire, shown, opened };
}

test("a push is shown as its title and words, tagged, and remembers where a tap goes", async () => {
  const w = worker();
  await w.fire("push", { data: { json: () => ({ title: "Watched player joined", body: "Sneaky joined Alpha.", url: "/#/players/~765", tag: "watch-765" }), text: () => "" } });
  assert.equal(w.shown.length, 1);
  assert.equal(w.shown[0].title, "Watched player joined");
  assert.equal(w.shown[0].options.body, "Sneaky joined Alpha.");
  assert.equal(w.shown[0].options.tag, "watch-765");
  assert.equal(w.shown[0].options.data.url, "/#/players/~765");
});

test("a push that is not what the panel sends still shows something — a browser stops delivering to a silent site", async () => {
  const w = worker();
  await w.fire("push", { data: { json: () => { throw new SyntaxError("not JSON"); }, text: () => "hello" } });
  await w.fire("push", { data: null });
  assert.equal(w.shown.length, 2);
  assert.equal(w.shown[0].options.body, "hello");
  assert.ok(w.shown.every((n) => n.title));
});

test("a tap: the open panel goes there and comes forward; with none open, a window opens there", async () => {
  const messages = [];
  let focused = 0;
  // Copied out: the worker's objects are made in its own sandbox.
  const panel = { url: "https://panel.example/#/live", postMessage: (m) => messages.push({ ...m }), focus: async () => { focused++; } };
  const elsewhere = { url: "https://other.example/", postMessage: () => assert.fail("another site's window"), focus: async () => assert.fail("another site's window") };
  const note = (url) => ({ notification: { data: { url }, close: () => {} } });

  const open = worker({ windows: [elsewhere, panel] });
  await open.fire("notificationclick", note("/#/moderation/requests"));
  assert.deepEqual(messages, [{ type: "open", url: "https://panel.example/#/moderation/requests" }]);
  assert.equal(focused, 1);
  assert.deepEqual(open.opened, []);

  const closed = worker({ windows: [elsewhere] });
  await closed.fire("notificationclick", note("/#/dashboard"));
  assert.deepEqual(closed.opened, ["https://panel.example/#/dashboard"]);

  // The public demo on the same address is not the panel: it is passed over, open before the panel
  // or alone, however its address is written.
  const demos = ["https://panel.example/demo/", "https://panel.example/demo", "https://panel.example/DEMO/#/live"].map((url) => ({
    url, postMessage: () => assert.fail(`the demo at ${url} was told where a notification points`), focus: async () => assert.fail(`the demo at ${url} came forward`),
  }));
  messages.length = 0;
  const both = worker({ windows: [...demos, panel] });
  await both.fire("notificationclick", note("/#/players"));
  assert.deepEqual(messages, [{ type: "open", url: "https://panel.example/#/players" }], "the panel, not the demo opened before it");
  const onlyDemo = worker({ windows: demos });
  await onlyDemo.fire("notificationclick", note("/#/players"));
  assert.deepEqual(onlyDemo.opened, ["https://panel.example/#/players"], "only the demo open: the panel opens in a window of its own");
});
