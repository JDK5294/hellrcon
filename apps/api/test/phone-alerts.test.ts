/**
 * Phone notifications (phone-alerts.ts, web-push.ts, routes/push.ts), end to end against a stand-in
 * push service: what arrives is decrypted the way a browser would — with WebCrypto, not the
 * node:crypto the sender uses — and its signature checked against the key the browser was given.
 *
 * Who hears what is the panel's own rule each time: the watchlist for a watched player joining, the
 * server for its outages, chat and seeding, a line the queue would offer them for a request, the
 * server's automation history for an automatic kick or ban, and their own request for its outcome.
 * Nothing is sent to a device until its browser has handed over a subscription, and signing out
 * everywhere ends one. The options that came after the first three are off until picked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { createECDH, webcrypto } from "node:crypto";
import type { Repository } from "@app/db";
import { withIsolatedServer as withServer, jf } from "./harness.ts";
import { encryptFor } from "../dist/web-push.js";
import { PhoneAlerts } from "../dist/phone-alerts.js";
import { purchase } from "../dist/shop.js";
import { fakeGameServer } from "./fake-hll-server.ts";

const { subtle } = webcrypto;
/** A notification as the service worker gets it. */
interface Note { title: string; body: string; url: string; tag: string }
const b64 = (s: string) => Buffer.from(s, "base64url");
const text = (s: string) => new TextEncoder().encode(s);
const join = (...parts: Uint8Array[]) => Buffer.concat(parts);

test("the RFC's own example encrypts byte for byte", () => {
  // RFC 8291, Appendix A.
  const body = encryptFor(
    { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
    b64("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
    { privateKey: b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), salt: b64("DGv6ra1nlYgDCS1FRnbzlw") },
  );
  assert.equal(body.toString("base64url"),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});

/** A browser's side of a subscription: its key pair and secret, and how it reads what arrives. */
async function browser() {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as webcrypto.CryptoKeyPair;
  const publicRaw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const auth = webcrypto.getRandomValues(new Uint8Array(16));
  const hkdf = async (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, bits: number) =>
    new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), bits));
  return {
    keys: { p256dh: Buffer.from(publicRaw).toString("base64url"), auth: Buffer.from(auth).toString("base64url") },
    async read(body: Buffer): Promise<Note> {
      const salt = body.subarray(0, 16);
      assert.equal(body.readUInt32BE(16), 4096, "record size");
      const sender = body.subarray(21, 21 + body[20]!);
      const peer = await subtle.importKey("raw", sender, { name: "ECDH", namedCurve: "P-256" }, false, []);
      const secret = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: peer }, pair.privateKey, 256));
      const ikm = await hkdf(secret, auth, join(text("WebPush: info\0"), publicRaw, sender), 256);
      const key = await subtle.importKey("raw", await hkdf(ikm, salt, text("Content-Encoding: aes128gcm\0"), 128), "AES-GCM", false, ["decrypt"]);
      const plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: await hkdf(ikm, salt, text("Content-Encoding: nonce\0"), 96) }, key, body.subarray(21 + body[20]!)));
      assert.equal(plain[plain.length - 1], 2, "one record, marked the last");
      return JSON.parse(Buffer.from(plain.subarray(0, -1)).toString()) as Note;
    },
  };
}

interface Delivery { path: string; headers: IncomingHttpHeaders; body: Buffer }

/** The stand-in push service: keeps what it is sent, answers 201 — or what `answer` says. */
async function pushService() {
  const got: Delivery[] = [];
  let answer = (_path: string) => 201;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      got.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(answer(req.url ?? "")).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.PUSH_TEST_ORIGIN = origin;
  return {
    origin, got,
    answerWith(fn: (path: string) => number) { answer = fn; },
    to: (name: string) => got.filter((d) => d.path === `/push/${name}`),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Wait for `n` deliveries to a device — or, with n = 0, give a stray one time to turn up. */
async function deliveries(svc: Awaited<ReturnType<typeof pushService>>, name: string, n: number): Promise<Delivery[]> {
  const until = Date.now() + (n ? 5_000 : 400);
  while (Date.now() < until && svc.to(name).length < Math.max(n, 1)) await new Promise((r) => setTimeout(r, 25));
  if (!n) await new Promise((r) => setTimeout(r, 200));
  return svc.to(name);
}

async function login(base: string, username: string) {
  const r = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password: "pw" }) });
  return { authorization: `Bearer ${r.body.token as string}` };
}
async function owner(base: string) {
  await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  const auth = await login(base, "owner");
  const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Alpha", host: "127.0.0.1", port: 1, password: "x" }) });
  return { auth, serverId: (created.body.server as { id: string }).id };
}
async function staff(base: string, auth: Record<string, string>, username: string, grants: unknown[]) {
  await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username, password: "pw" }) });
  const id = ((await jf(`${base}/api/users`, { headers: auth })).body.users as { id: string; username: string }[]).find((u) => u.username === username)!.id;
  assert.equal((await jf(`${base}/api/users/${id}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants }) })).status, 200);
  return { id, auth: await login(base, username) };
}
/** Turn notifications on for a device named `name`, the way the panel does. */
async function turnOn(base: string, auth: Record<string, string>, svc: { origin: string }, name: string) {
  const b = await browser();
  const r = await jf(`${base}/api/me/push`, { method: "PUT", headers: auth, body: JSON.stringify({ endpoint: `${svc.origin}/push/${name}`, keys: b.keys, origin: "https://panel.example", device: "iPhone" }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return b;
}

test("a device is on only once its browser has subscribed; a push is encrypted for it and signed with the install's key", async () => {
  const svc = await pushService();
  try {
    await withServer(async (base) => {
      const { auth } = await owner(base);
      const before = await jf(`${base}/api/me/push`, { headers: auth });
      assert.deepEqual(before.body.devices, [], "off until turned on");
      const key = before.body.key as string;
      assert.equal(b64(key).length, 65, "the public key a browser subscribes with");
      assert.equal((await jf(`${base}/api/me/push`, { headers: auth })).body.key, key, "made once, kept");

      const b = await browser();
      const put = (endpoint: string, keys = b.keys) => jf(`${base}/api/me/push`, { method: "PUT", headers: auth, body: JSON.stringify({ endpoint, keys, origin: "https://panel.example" }) });
      assert.equal((await put("https://intranet.local/hook")).status, 400, "only a push service's address is posted to");
      assert.equal((await put("http://fcm.googleapis.com/fcm/send/x")).status, 400, "and only over https");
      assert.equal((await put(`${svc.origin}/push/a`, { p256dh: "AAAA", auth: b.keys.auth })).status, 400, "keys that are not a browser's");
      // A key written short (compressed) would be sealed to the wrong bytes, and the phone could not open it.
      const short = createECDH("prime256v1");
      short.generateKeys();
      assert.equal((await put(`${svc.origin}/push/a`, { p256dh: short.getPublicKey(undefined, "compressed").toString("base64url"), auth: b.keys.auth })).status, 400, "a compressed key");
      assert.equal((await put(`${svc.origin}/push/a`, { p256dh: b.keys.p256dh, auth: "AAAA" })).status, 400, "a secret that is not 16 bytes");
      assert.equal((await put(`${svc.origin}/push/a`)).status, 200);
      assert.deepEqual(((await jf(`${base}/api/me/push`, { headers: auth })).body.devices as { endpoint: string }[]).map((d) => d.endpoint), [`${svc.origin}/push/a`]);

      const sent = await jf(`${base}/api/me/push/test`, { method: "POST", headers: auth, body: JSON.stringify({ endpoint: `${svc.origin}/push/a` }) });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      const [d] = await deliveries(svc, "a", 1);
      assert.equal(d!.headers["content-encoding"], "aes128gcm");
      assert.ok(Number(d!.headers.ttl) > 0, "a TTL, which push services require");
      const note = await b.read(d!.body);
      assert.equal(note.title, "Notifications are on");
      assert.equal(note.url, "/#/settings");

      // Signed with the install's key, for that push service, naming the panel's address.
      const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(String(d!.headers.authorization));
      assert.ok(m, String(d!.headers.authorization));
      assert.equal(m[4], key);
      const verifier = await subtle.importKey("raw", b64(key), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      assert.ok(await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, b64(m[3]!), text(`${m[1]}.${m[2]}`)), "the signature checks out");
      const claims = JSON.parse(b64(m[2]!).toString()) as { aud: string; exp: number; sub: string };
      assert.equal(claims.aud, svc.origin);
      assert.equal(claims.sub, "https://panel.example");
      assert.ok(claims.exp * 1000 > Date.now() && claims.exp * 1000 <= Date.now() + 24 * 3_600_000, "expires within a day, as the push services require");

      // Someone else's account can neither test nor turn off this device.
      const other = await staff(base, auth, "other", [{ capability: "server.view", level: "read" }]);
      assert.equal((await jf(`${base}/api/me/push/test`, { method: "POST", headers: other.auth, body: JSON.stringify({ endpoint: `${svc.origin}/push/a` }) })).status, 404);
      await jf(`${base}/api/me/push/off`, { method: "POST", headers: other.auth, body: JSON.stringify({ endpoint: `${svc.origin}/push/a` }) });
      assert.equal(((await jf(`${base}/api/me/push`, { headers: auth })).body.devices as unknown[]).length, 1, "still on");
      assert.equal(svc.to("a").length, 1, "and nothing more was sent to it");

      // Off: the device is forgotten, and a test has nowhere to go.
      await jf(`${base}/api/me/push/off`, { method: "POST", headers: auth, body: JSON.stringify({ endpoint: `${svc.origin}/push/a` }) });
      assert.deepEqual((await jf(`${base}/api/me/push`, { headers: auth })).body.devices, []);
      assert.equal((await jf(`${base}/api/me/push/test`, { method: "POST", headers: auth, body: JSON.stringify({ endpoint: `${svc.origin}/push/a` }) })).status, 404);
    });
  } finally {
    await svc.close();
  }
});

test("a watched player joining: told to whoever may read the watchlist and see the server, by name, once per rejoin", async () => {
  const svc = await pushService();
  try {
    await withServer(async (base, repo, ctx) => {
      const { auth, serverId } = await owner(base);
      const viewer = await staff(base, auth, "viewer", [{ capability: "server.view", level: "read" }]);
      const watcher = await staff(base, auth, "watcher", [{ capability: "player.watchlist", level: "read" }]);
      const mine = await turnOn(base, auth, svc, "owner");
      await turnOn(base, viewer.auth, svc, "viewer");
      await turnOn(base, watcher.auth, svc, "watcher");
      await repo.playerFlags.set("76561198000000042", { watchlist: true, watchReason: "suspected aimbot" }, { userId: null, name: "staff" });
      const join = (playerId: string, name: string) => ctx.bus.emit("evt.player.connected", { kind: "evt.player.connected", serverId, ts: new Date().toISOString(), actorPlayerId: playerId, actorName: name });

      join("76561198000000042", "Sneaky");
      const [d] = await deliveries(svc, "owner", 1);
      const note = await mine.read(d!.body);
      assert.equal(note.title, "Watched player joined");
      assert.equal(note.body, "Sneaky joined Alpha.");
      assert.equal(note.url, "/#/players/~76561198000000042", "a tap opens their profile");
      assert.doesNotMatch(note.body, /7656|aimbot/, "a lock screen shows a name — no id, no watch reason");
      assert.equal((await deliveries(svc, "viewer", 0)).length, 0, "seeing the server is not reading the watchlist");
      assert.equal((await deliveries(svc, "watcher", 0)).length, 0, "reading the watchlist is not seeing the server");

      join("76561198000000042", "Sneaky");
      join("76561198000000099", "Nobody");
      assert.equal((await deliveries(svc, "owner", 0)).length, 1, "a rejoin straight after is not news, and an unwatched player never was");

      // Switched off in their own settings: nothing, though the next watched player joins.
      await jf(`${base}/api/me/prefs`, { method: "PUT", headers: auth, body: JSON.stringify({ phoneAlerts: { watch: false } }) });
      await repo.playerFlags.set("76561198000000043", { watchlist: true }, { userId: null, name: "staff" });
      join("76561198000000043", "Other");
      assert.equal((await deliveries(svc, "owner", 0)).length, 1);
    });
  } finally {
    await svc.close();
  }
});

test("a server that stops answering, and comes back: one notification each way, the second replacing the first", async () => {
  const svc = await pushService();
  try {
    await withServer(async (base, _repo, ctx) => {
      const { auth, serverId } = await owner(base);
      const outsider = await staff(base, auth, "outsider", [{ capability: "player.watchlist", level: "read" }]);
      const mine = await turnOn(base, auth, svc, "owner");
      await turnOn(base, outsider.auth, svc, "outsider");
      ctx.bus.emit("app.server.dark", { kind: "app.server.dark", serverId, ts: new Date().toISOString(), data: { minutes: 3 } });
      const [dark] = await deliveries(svc, "owner", 1);
      ctx.bus.emit("app.server.recovered", { kind: "app.server.recovered", serverId, ts: new Date().toISOString(), data: { minutes: 7 } });
      const both = await deliveries(svc, "owner", 2);
      const [a, b] = [await mine.read(dark!.body), await mine.read(both[1]!.body)];
      assert.equal(a.title, "Alpha stopped answering");
      assert.match(a.body, /3 minutes/);
      assert.equal(b.title, "Alpha is back");
      assert.match(b.body, /7 minutes/);
      assert.equal(a.tag, b.tag, "the same tag, so the phone shows the latest");
      assert.equal(dark!.headers.urgency, "high");
      assert.equal((await deliveries(svc, "outsider", 0)).length, 0, "nobody hears about a server they cannot see");
    });
  } finally {
    await svc.close();
  }
});

test("a request: whoever the queue would offer a line to, never the one who asked", async () => {
  const svc = await pushService();
  try {
    await withServer(async (base, repo) => {
      const { auth, serverId } = await owner(base);
      const junior = await staff(base, auth, "junior", [{ capability: "server.view", level: "read" }]);
      // Holds the ban, but under an hour of it — nothing a 48-hour ask could be signed for.
      const capped = await staff(base, auth, "capped", [{ capability: "server.view", level: "read" }, { capability: "action.tempban", level: "write" }]);
      await repo.userLimits.replace(capped.id, { "tempban.maxHours": 0.5 });
      const bystander = await staff(base, auth, "bystander", [{ capability: "server.view", level: "read" }]);
      const mine = await turnOn(base, auth, svc, "owner");
      await turnOn(base, junior.auth, svc, "junior");
      await turnOn(base, capped.auth, svc, "capped");
      await turnOn(base, bystander.auth, svc, "bystander");

      const filed = await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: junior.auth, body: JSON.stringify({ action: "tempban", playerId: "76561198000000001", playerName: "Rowdy", reason: "spawn camping", hours: 48 }) });
      assert.equal(filed.status, 202, JSON.stringify(filed.body));
      const [d] = await deliveries(svc, "owner", 1);
      const note = await mine.read(d!.body);
      assert.equal(note.title, "A request needs your approval");
      assert.equal(note.body, "junior asks for: Temp ban · Rowdy · 48h · Alpha.");
      assert.equal(note.url, "/#/moderation/requests");
      assert.equal((await deliveries(svc, "junior", 0)).length, 0, "never the requester");
      assert.equal((await deliveries(svc, "capped", 0)).length, 0, "nor someone whose limit cannot move it along");
      assert.equal((await deliveries(svc, "bystander", 0)).length, 0, "nor anyone who could not do it themselves");

      // Asking for more than your own limit: you could sign some of it yourself, but it is your ask.
      const asker = await staff(base, auth, "asker", [{ capability: "server.view", level: "read" }, { capability: "action.tempban", level: "write" }]);
      await repo.userLimits.replace(asker.id, { "tempban.maxHours": 2 });
      await turnOn(base, asker.auth, svc, "asker");
      const drafted = await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: asker.auth, body: JSON.stringify({ action: "tempban", playerId: "76561198000000002", playerName: "Camper", reason: "x", hours: 10, draft: true }) });
      assert.equal(drafted.status, 202, JSON.stringify(drafted.body));
      const submitted = await jf(`${base}/api/requests/draft/submit`, { method: "POST", headers: asker.auth, body: "{}" });
      assert.ok(submitted.body.filed, JSON.stringify(submitted.body));
      const both = await deliveries(svc, "owner", 2);
      assert.equal((await mine.read(both[1]!.body)).body, "asker asks for: Temp ban · Camper · 10h · Alpha.");
      assert.equal((await deliveries(svc, "asker", 0)).length, 0, "never the one who asked, whatever they could sign");
    });
  } finally {
    await svc.close();
  }
});

/** Pick one of the later options for an account: each is off until picked. */
async function pick(base: string, auth: Record<string, string>, choices: Record<string, boolean | string[]>) {
  assert.equal((await jf(`${base}/api/me/prefs`, { method: "PUT", headers: auth, body: JSON.stringify({ phoneAlerts: choices }) })).status, 200);
}
const pickNote = (n: Note) => ({ title: n.title, body: n.body });

test("a call for an admin in chat: told to whoever picked it and may see the server, with what they wrote, once a call", async () => {
  const svc = await pushService();
  try {
    await withServer(async (base, _repo, ctx) => {
      const { auth, serverId } = await owner(base);
      const viewer = await staff(base, auth, "viewer", [{ capability: "server.view", level: "read" }]);
      const quiet = await staff(base, auth, "quiet", [{ capability: "server.view", level: "read" }]);
      const outsider = await staff(base, auth, "outsider", [{ capability: "player.watchlist", level: "read" }]);
      const mine = await turnOn(base, auth, svc, "owner");
      await turnOn(base, viewer.auth, svc, "viewer");
      await turnOn(base, quiet.auth, svc, "quiet");
      await turnOn(base, outsider.auth, svc, "outsider");
      for (const who of [auth, viewer.auth, outsider.auth]) await pick(base, who, { admin: true });
      const say = (playerId: string, name: string, message: string, kind = "evt.chat.team") =>
        ctx.bus.emit(kind, { kind, serverId, ts: new Date().toISOString(), actorPlayerId: playerId, actorName: name, data: { message } });

      say("76561198000000001", "Medic", "!admin someone is team killing at HQ");
      const [d] = await deliveries(svc, "owner", 1);
      const note = await mine.read(d!.body);
      assert.equal(note.title, "Medic is asking for an admin");
      assert.equal(note.body, "On Alpha: someone is team killing at HQ");
      assert.equal(note.url, "/#/live");
      assert.equal(d!.headers.urgency, "high");
      assert.equal((await deliveries(svc, "viewer", 1)).length, 1, "whoever may see the server reads its chat");
      assert.equal((await deliveries(svc, "quiet", 0)).length, 0, "off until picked");
      assert.equal((await deliveries(svc, "outsider", 0)).length, 0, "nobody hears a server they cannot see");

      say("76561198000000001", "Medic", "!admin please");
      say("76561198000000002", "Chatty", "no need to !admin this", "evt.chat.squad");
      assert.equal((await deliveries(svc, "owner", 0)).length, 1, "typed again it is the same call, and talk about the trigger is no call");

      say("76561198000000002", "Chatty", "!ADMIN", "evt.chat.squad");
      const two = await deliveries(svc, "owner", 2);
      assert.equal((await mine.read(two[1]!.body)).body, "On Alpha.", "nothing after the trigger: just where");
    });
  } finally {
    await svc.close();
  }
});

test("a call for an admin uses the server's own trigger, the one its Discord alert listens for", async () => {
  const svc = await pushService();
  try {
    await withServer(async (base, repo, ctx) => {
      const { auth, serverId } = await owner(base);
      const relay = await repo.discordRelay.upsertConfig(serverId, {});
      await repo.discordRelay.upsertConfig(serverId, { alerts: { ...relay.alerts, adminPing: { ...relay.alerts.adminPing, trigger: "@staff" } } });
      const mine = await turnOn(base, auth, svc, "owner");
      await pick(base, auth, { admin: true });
      const say = (message: string) => ctx.bus.emit("evt.chat.team", { kind: "evt.chat.team", serverId, ts: new Date().toISOString(), actorPlayerId: "76561198000000001", actorName: "Medic", data: { message } });
      say("!admin hello?");
      assert.equal((await deliveries(svc, "owner", 0)).length, 0, "the default means nothing once staff changed it");
      say("@Staff hacker on the left flank");
      const [d] = await deliveries(svc, "owner", 1);
      assert.equal((await mine.read(d!.body)).body, "On Alpha: hacker on the left flank");
    });
  } finally {
    await svc.close();
  }
});

test("an automatic kick or ban: told to whoever picked it and may read that server's automation history — never a warning, a trial run or a failed try", async () => {
  const svc = await pushService();
  try {
    await withServer(async (base, _repo, ctx) => {
      const { auth, serverId } = await owner(base);
      const bravo = ((await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Bravo", host: "127.0.0.1", port: 2, password: "x" }) })).body.server as { id: string }).id;
      const seeder = await staff(base, auth, "seeder", [{ capability: "server.view", level: "read" }, { capability: "seeding.config", level: "read", scopeType: "server", scopeId: bravo }]);
      const viewer = await staff(base, auth, "viewer", [{ capability: "server.view", level: "read" }]);
      const mine = await turnOn(base, auth, svc, "owner");
      const theirs = await turnOn(base, seeder.auth, svc, "seeder");
      await turnOn(base, viewer.auth, svc, "viewer");
      for (const who of [auth, seeder.auth, viewer.auth]) await pick(base, who, { automod: true });
      const fired = (server: string, name: string, data: Record<string, unknown>) => ctx.bus.emit("app.enforcement", {
        kind: "app.enforcement", serverId: server, ts: new Date().toISOString(), actorName: name,
        data: { ruleName: "Team killing", reason: "x", hours: null, dryRun: false, error: null, ...data },
      });

      fired(serverId, "Rowdy", { action: "message" });
      fired(serverId, "Rowdy", { action: "punish" });
      fired(serverId, "Rowdy", { action: "kick", dryRun: true });
      fired(serverId, "Rowdy", { action: "tempban", hours: 2, error: "the server did not answer" });
      fired(serverId, "3 players inside a minute", { action: "DISABLED ITSELF (safety limit)" });
      fired(serverId, "Rowdy", { action: "kick" });
      const [kick] = await deliveries(svc, "owner", 1);
      const note = await mine.read(kick!.body);
      assert.equal(note.title, "Rowdy was kicked");
      assert.equal(note.body, "On Alpha, by the rule “Team killing”.");
      assert.equal(note.url, "/#/autosettings/history");
      assert.equal((await deliveries(svc, "owner", 0)).length, 1, "a warning, a punish, a trial run, a failed try and a rule stopping itself removed nobody");
      assert.equal((await deliveries(svc, "seeder", 0)).length, 0, "they read Bravo's automation, not Alpha's");
      assert.equal((await deliveries(svc, "viewer", 0)).length, 0, "seeing a server is not reading its automation history");

      // A rule's ban is temporary with hours and permanent without; the seeding rules kick too.
      const said: Note[] = [];
      const next = async () => {
        const got = await deliveries(svc, "seeder", said.length + 1);
        said.push(await theirs.read(got[said.length]!.body));
        return said[said.length - 1]!;
      };
      fired(bravo, "Camper", { action: "blacklist", hours: 24, ruleName: "Base camping" });
      assert.deepEqual([(await next()).title, said[0]!.body], ["Camper was banned for 24h", "On Bravo, by the rule “Base camping”."]);
      fired(bravo, "Cheater", { action: "blacklist", hours: null, ruleName: "Known cheaters" });
      assert.equal((await next()).title, "Cheater was banned for good");
      fired(bravo, "Spammer", { action: "tempban", hours: 6 });
      assert.equal((await next()).title, "Spammer was banned for 6h");
      ctx.bus.emit("app.seeding.kick", { kind: "app.seeding.kick", serverId: bravo, ts: new Date().toISOString(), actorPlayerId: "76561198000000003", actorName: "Sniper" });
      assert.deepEqual([(await next()).title, said[3]!.body], ["Sniper was kicked", "On Bravo, by the seeding rules."]);
      assert.equal((await deliveries(svc, "owner", 5)).length, 5, "the owner may read every server's");
    });
  } finally {
    await svc.close();
  }
});

test("a server's seeding: told to whoever picked it and may see the server, when it needs players and when it is live, once a change however it wavers", async () => {
  const svc = await pushService();
  try {
    await withServer(async (base, _repo, ctx) => {
      const { auth, serverId } = await owner(base);
      const bravo = ((await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Bravo", host: "127.0.0.1", port: 2, password: "x" }) })).body.server as { id: string }).id;
      const quiet = await staff(base, auth, "quiet", [{ capability: "server.view", level: "read" }]);
      const outsider = await staff(base, auth, "outsider", [{ capability: "player.watchlist", level: "read" }]);
      const mine = await turnOn(base, auth, svc, "owner");
      await turnOn(base, quiet.auth, svc, "quiet");
      await turnOn(base, outsider.auth, svc, "outsider");
      for (const who of [auth, outsider.auth]) await pick(base, who, { seeding: true });
      const phase = (server: string, from: string, to: string, count: number) =>
        ctx.bus.emit("app.seeding.phase", { kind: "app.seeding.phase", serverId: server, ts: new Date().toISOString(), data: { from, to, count, target: 40 } });
      const said: Note[] = [];
      const next = async () => {
        const got = await deliveries(svc, "owner", said.length + 1);
        said.push(await mine.read(got[said.length]!.body));
        return said[said.length - 1]!;
      };

      phase(serverId, "live", "seeding", 35);
      assert.deepEqual(pickNote(await next()), { title: "Alpha needs players", body: "It dropped to 35 players, under the 40 it takes to be live." });
      phase(serverId, "seeding", "live", 40);
      assert.deepEqual(pickNote(await next()), { title: "Alpha is live", body: "It reached 40 players." });
      assert.equal(said[0]!.tag, said[1]!.tag, "one tag, so live replaces needs players on the phone");
      phase(serverId, "live", "seeding", 36);
      phase(serverId, "seeding", "idle", 2);
      phase(serverId, "idle", "seeding", 4);
      phase(bravo, "idle", "live", 50);
      assert.equal((await deliveries(svc, "owner", 0)).length, 2, "a waver is not news again, an empty server never was, nor a full one that never seeded");

      phase(bravo, "idle", "seeding", 3);
      assert.deepEqual(pickNote(await next()), { title: "Bravo needs players", body: "Seeding has started: 3 players on, and it goes live at 40." });
      assert.equal((await deliveries(svc, "quiet", 0)).length, 0, "off until picked");
      assert.equal((await deliveries(svc, "outsider", 0)).length, 0, "nobody hears a server they cannot see");
    });
  } finally {
    await svc.close();
  }
});
test("a request you filed, decided: told to you alone, once, with what was decided and by whom — never a withdrawn one", async () => {
  const svc = await pushService();
  try {
    await withServer(async (base, _repo, ctx) => {
      const { auth, serverId } = await owner(base);
      const junior = await staff(base, auth, "junior", [{ capability: "server.view", level: "read" }]);
      const quiet = await staff(base, auth, "quiet", [{ capability: "server.view", level: "read" }]);
      await turnOn(base, auth, svc, "owner");
      const theirs = await turnOn(base, junior.auth, svc, "junior");
      await turnOn(base, quiet.auth, svc, "quiet");
      await pick(base, auth, { decided: true, requests: false });
      await pick(base, junior.auth, { decided: true });
      const ask = async (who: Record<string, string>, body: Record<string, unknown>) => {
        const filed = await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: who, body: JSON.stringify(body) });
        assert.equal(filed.status, 202, JSON.stringify(filed.body));
        return (await jf(`${base}/api/requests/${filed.body.requestId as string}`, { headers: auth })).body.request as { id: string; lines: { id: string }[] };
      };
      const decide = async (r: { id: string; lines: { id: string }[] }, verdict: "approve" | "deny", line = 0) => {
        const out = await jf(`${base}/api/requests/${r.id}/lines/${r.lines[line]!.id}/${verdict}`, { method: "POST", headers: auth, body: JSON.stringify(verdict === "deny" ? { reason: "talk to them first" } : {}) });
        assert.equal(out.status, 200, JSON.stringify(out.body));
      };

      const first = await ask(junior.auth, { action: "message", playerId: "76561198000000001", playerName: "Rowdy", message: "calm down please" });
      await decide(first, "approve");
      const [d] = await deliveries(svc, "junior", 1);
      const note = await theirs.read(d!.body);
      assert.equal(note.title, "Your request was approved");
      assert.equal(note.body, "Message · Rowdy · Alpha — by owner.");
      assert.equal(note.url, "/#/moderation/requests");
      await ctx.phoneAlerts.requestDecided(first.id);
      assert.equal((await deliveries(svc, "junior", 0)).length, 1, "once");

      const second = await ask(junior.auth, { action: "kick", playerId: "76561198000000002", playerName: "Camper", reason: "x" });
      await decide(second, "deny");
      const both = await deliveries(svc, "junior", 2);
      assert.deepEqual(pickNote(await theirs.read(both[1]!.body)), { title: "Your request was denied", body: "Kick · Camper · Alpha — by owner." });

      // Withdrawn, with one of its lines already approved: it was theirs to stop, and they did.
      for (const [id, name] of [["76561198000000003", "Sniper"], ["76561198000000005", "Gunner"]]) {
        assert.equal((await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: junior.auth, body: JSON.stringify({ action: "kick", playerId: id, playerName: name, reason: "x", draft: true }) })).status, 202);
      }
      const submitted = await jf(`${base}/api/requests/draft/submit`, { method: "POST", headers: junior.auth, body: "{}" });
      const pulled = (await jf(`${base}/api/requests/${submitted.body.filed as string}`, { headers: auth })).body.request as { id: string; lines: { id: string }[] };
      await decide(pulled, "approve");
      assert.equal((await jf(`${base}/api/requests/${pulled.id}/withdraw`, { method: "POST", headers: junior.auth, body: "{}" })).status, 200);
      const unpicked = await ask(quiet.auth, { action: "kick", playerId: "76561198000000004", playerName: "Medic", reason: "x" });
      await decide(unpicked, "deny");
      assert.equal((await deliveries(svc, "junior", 0)).length, 2, "withdrawing is nobody's decision");
      assert.equal((await deliveries(svc, "quiet", 0)).length, 0, "off until picked");
      assert.equal((await deliveries(svc, "owner", 0)).length, 0, "only the one who asked hears the outcome");
    });
  } finally {
    await svc.close();
  }
});

test("a request decided line by line: told once the last line is decided, counting only what someone else decided", async () => {
  const svc = await pushService();
  try {
    await withServer(async (base, repo, ctx) => {
      const { auth, serverId } = await owner(base);
      // May kick, and ban for two hours: a ten-hour ban in the same request goes for a signature.
      const asker = await staff(base, auth, "asker", [{ capability: "server.view", level: "read" }, { capability: "action.kick", level: "write" }, { capability: "action.tempban", level: "write" }]);
      await repo.userLimits.replace(asker.id, { "tempban.maxHours": 2 });
      const theirs = await turnOn(base, asker.auth, svc, "asker");
      await pick(base, asker.auth, { decided: true });
      const add = async (body: Record<string, unknown>) =>
        assert.equal((await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: asker.auth, body: JSON.stringify({ ...body, draft: true }) })).status, 202);
      await add({ action: "kick", playerId: "76561198000000001", playerName: "Rowdy", reason: "x" });
      await add({ action: "tempban", playerId: "76561198000000002", playerName: "Camper", reason: "x", hours: 10 });
      await add({ action: "message", playerId: "76561198000000003", playerName: "Medic", message: "please stop" });
      const submitted = await jf(`${base}/api/requests/draft/submit`, { method: "POST", headers: asker.auth, body: "{}" });
      assert.equal((submitted.body.applied as unknown[]).length, 1, "the kick was theirs to do");
      const r = (await jf(`${base}/api/requests/${submitted.body.filed as string}`, { headers: auth })).body.request as { id: string; lines: { id: string; kind: string }[] };
      const line = (kind: string) => r.lines.find((l) => l.kind === kind)!.id;

      assert.equal((await jf(`${base}/api/requests/${r.id}/lines/${line("message")}/approve`, { method: "POST", headers: auth, body: "{}" })).status, 200);
      assert.equal((await deliveries(svc, "asker", 0)).length, 0, "not decided yet: a line is still waiting");
      assert.equal((await jf(`${base}/api/requests/${r.id}/lines/${line("tempban")}/deny`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "too long" }) })).status, 200);
      const [d] = await deliveries(svc, "asker", 1);
      assert.deepEqual(pickNote(await theirs.read(d!.body)), { title: "Your request was decided", body: "1 approved, 1 denied — by owner." });

      // The last two lines decided at the same moment both say so: still told once.
      const again = await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: asker.auth, body: JSON.stringify({ action: "message", playerId: "76561198000000003", playerName: "Medic", message: "last warning" }) });
      const line2 = ((await repo.approvals.get(again.body.requestId as string))!.lines[0])!;
      const boss = (await repo.users.findByUsername("owner"))!;
      await repo.approvals.markExecuted(line2.id, { userId: boss.id, name: "owner" });
      await repo.approvals.settle(again.body.requestId as string);
      await Promise.all([ctx.phoneAlerts.requestDecided(again.body.requestId as string), ctx.phoneAlerts.requestDecided(again.body.requestId as string)]);
      assert.equal((await deliveries(svc, "asker", 0)).length, 2, "one notification, not two");
    });
  } finally {
    await svc.close();
  }
});

/** The app's own notifications swapped for a set with short windows, for the tests of runs and
 *  purchases; stopped again when done. */
async function shortWindows<T>(repo: Repository, ctx: { phoneAlerts: { stop(): void }; bus: unknown }, fn: () => Promise<T>): Promise<T> {
  ctx.phoneAlerts.stop();
  const alerts = new PhoneAlerts({ repo, bus: ctx.bus as never, runMs: 700, shopGatherMs: 200 });
  alerts.start();
  try { return await fn(); } finally { alerts.stop(); }
}

test("a staff member's ban: to whoever picked staff bans — anyone's, or only by the roles they picked — or bans for good, and may read the ban record; never the one who banned", async () => {
  const svc = await pushService();
  try {
    await withServer(async (base) => {
      const { auth, serverId: alpha } = await owner(base);
      const { fake, serverId } = await fakeGameServer(base, auth.authorization.slice("Bearer ".length), "Bravo");
      try {
        const banner = [{ capability: "server.view", level: "read" }, { capability: "action.tempban", level: "write" }, { capability: "action.permaban", level: "write" }];
        const role = async (name: string, more: unknown[] = []) => {
          const r = await jf(`${base}/api/roles`, { method: "POST", headers: auth, body: JSON.stringify({ name, grants: [...banner, ...more] }) });
          assert.equal(r.status, 201, JSON.stringify(r.body));
          return (r.body.role as { id: string }).id;
        };
        const trialRole = await role("Trial mod", [{ capability: "moderation.bans", level: "read" }]);
        const seniorRole = await role("Senior admin");
        const member = async (username: string, roles: { roleId: string; scopeId: string | null }[]) => {
          const s = await staff(base, auth, username, []);
          assert.equal((await jf(`${base}/api/users/${s.id}/roles`, { method: "PUT", headers: auth, body: JSON.stringify({ roles }) })).status, 200);
          return s;
        };
        const trial = await member("trial", [{ roleId: trialRole, scopeId: null }]);
        const senior = await member("senior", [{ roleId: seniorRole, scopeId: null }]);
        // A trial mod on Alpha, but a senior admin everywhere: on Bravo they act as the senior.
        const mixed = await member("mixed", [{ roleId: trialRole, scopeId: alpha }, { roleId: seniorRole, scopeId: null }]);
        const record = [{ capability: "moderation.bans", level: "read" }];
        const lead = await staff(base, auth, "lead", record);
        const everyone = await staff(base, auth, "everyone", record);
        const forGood = await staff(base, auth, "forgood", record);
        const blind = await staff(base, auth, "blind", [{ capability: "server.view", level: "read" }]);
        const leadPhone = await turnOn(base, lead.auth, svc, "lead");
        await turnOn(base, everyone.auth, svc, "everyone");
        const goodPhone = await turnOn(base, forGood.auth, svc, "forgood");
        await turnOn(base, blind.auth, svc, "blind");
        await turnOn(base, trial.auth, svc, "trial");
        await pick(base, lead.auth, { bans: true, banRoles: [trialRole] });
        await pick(base, everyone.auth, { bans: true });
        await pick(base, forGood.auth, { permabans: true });
        await pick(base, blind.auth, { bans: true, permabans: true });
        await pick(base, trial.auth, { bans: true });
        const ban = async (who: { auth: Record<string, string> }, body: Record<string, unknown>) => {
          const r = await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: who.auth, body: JSON.stringify(body) });
          assert.equal(r.status, 200, JSON.stringify(r.body));
        };

        await ban(trial, { action: "tempban", playerId: "76561198000000001", playerName: "Rowdy", reason: "spawn camping", hours: 24 });
        const [d] = await deliveries(svc, "lead", 1);
        const note = await leadPhone.read(d!.body);
        assert.deepEqual(pickNote(note), { title: "trial banned Rowdy", body: "For 24h, on Bravo: spawn camping" });
        assert.equal(note.url, "/#/moderation/bans");
        assert.equal((await deliveries(svc, "everyone", 1)).length, 1, "every staff member's bans");
        assert.equal((await deliveries(svc, "trial", 0)).length, 0, "never the one who banned, though they may read the record");
        assert.equal((await deliveries(svc, "forgood", 0)).length, 0, "a temp ban is not a ban for good");
        assert.equal((await deliveries(svc, "blind", 0)).length, 0, "seeing the server is not reading the ban record");

        await ban(senior, { action: "permaban", playerId: "76561198000000002", playerName: "Cheater", reason: "aimbot" });
        const [good] = await deliveries(svc, "forgood", 1);
        assert.deepEqual(pickNote(await goodPhone.read(good!.body)), { title: "senior banned Cheater", body: "For good, on Bravo: aimbot" });
        assert.equal((await deliveries(svc, "everyone", 2)).length, 2);
        await ban(mixed, { action: "tempban", playerId: "76561198000000003", playerName: "Camper", reason: "x", hours: 2 });
        assert.equal((await deliveries(svc, "everyone", 3)).length, 3);
        assert.equal((await deliveries(svc, "lead", 0)).length, 1, "not a role they picked — a trial mod on Alpha is not one on Bravo");
      } finally {
        fake.close();
      }
    });
  } finally {
    await svc.close();
  }
});

test("a run of bans from one staff member, such as an uploaded list, is one notification and then a count", async () => {
  const svc = await pushService();
  try {
    await withServer(async (base, repo, ctx) => {
      const { auth, serverId } = await owner(base);
      const uploader = await staff(base, auth, "uploader", [{ capability: "action.tempban", level: "write" }]);
      const lead = await staff(base, auth, "lead", [{ capability: "moderation.bans", level: "read" }]);
      const mine = await turnOn(base, lead.auth, svc, "lead");
      await pick(base, lead.auth, { bans: true });
      await shortWindows(repo, ctx, async () => {
        const banned = (name: string) => repo.audit.create({ actorUserId: uploader.id, actorName: "uploader", action: "player.tempban", targetType: "player", targetId: name, targetName: name, serverId, summary: `ran tempban on ${name}`, data: { hours: 2, reason: "from the list" } });
        for (const name of ["P1", "P2", "P3", "P4", "P5"]) await banned(name);
        const first = await deliveries(svc, "lead", 1);
        const a = await mine.read(first[0]!.body);
        assert.equal(a.title, "uploader banned P1");
        const two = await deliveries(svc, "lead", 2);
        const b = await mine.read(two[1]!.body);
        assert.deepEqual(pickNote(b), { title: "uploader banned 4 more players", body: "P2, P3, P4 and 1 more, on Alpha." });
        assert.equal(a.tag, b.tag, "one tag: the count takes the first one's place on the phone");
        // A quiet window ends the run: the next ban is told as itself, and starts a run of its own.
        await new Promise((r) => setTimeout(r, 1600));
        await banned("P6");
        await banned("P7");
        const four = await deliveries(svc, "lead", 4);
        assert.deepEqual(await Promise.all(four.slice(2).map(async (x) => (await mine.read(x.body)).title)), ["uploader banned P6", "uploader banned P7"]);
        assert.equal((await deliveries(svc, "lead", 0)).length, 4);
      });
    });
  } finally {
    await svc.close();
  }
});

test("a ban for good by the automatic rules reaches whoever picked bans for good, once even if they picked the rules' actions too", async () => {
  const svc = await pushService();
  try {
    await withServer(async (base, _repo, ctx) => {
      const { auth, serverId } = await owner(base);
      const forGood = await staff(base, auth, "forgood", [{ capability: "moderation.bans", level: "read" }]);
      const both = await staff(base, auth, "both", [{ capability: "moderation.bans", level: "read" }, { capability: "admin.moderation", level: "read" }]);
      const theirs = await turnOn(base, forGood.auth, svc, "forgood");
      const bothPhone = await turnOn(base, both.auth, svc, "both");
      await pick(base, forGood.auth, { permabans: true });
      await pick(base, both.auth, { permabans: true, automod: true });
      const fired = (name: string, data: Record<string, unknown>) => ctx.bus.emit("app.enforcement", {
        kind: "app.enforcement", serverId, ts: new Date().toISOString(), actorName: name,
        data: { ruleName: "Known cheaters", reason: "x", dryRun: false, error: null, ...data },
      });
      fired("Camper", { action: "blacklist", hours: 24 });
      fired("Cheater", { action: "blacklist", hours: null });
      const [d] = await deliveries(svc, "forgood", 1);
      const note = await theirs.read(d!.body);
      assert.deepEqual(pickNote(note), { title: "Cheater was banned for good", body: "On Alpha, by the rule “Known cheaters”." });
      assert.equal(note.url, "/#/moderation/bans", "a tap opens the ban record: the automation history is not theirs to open");
      assert.equal((await deliveries(svc, "forgood", 0)).length, 1, "a ban for 24 hours is not one for good");
      const two = await deliveries(svc, "both", 2);
      assert.equal(two.length, 2, "both of the rules' bans, the one for good once");
      assert.deepEqual(await Promise.all(two.map(async (x) => (await bothPhone.read(x.body)).url)), ["/#/autosettings/history", "/#/autosettings/history"], "who may read the automation history goes there");
    });
  } finally {
    await svc.close();
  }
});

test("a setting changed: to whoever picked it and may read that change on Staff activity, in plain words; never the one who changed it", async () => {
  const svc = await pushService();
  try {
    await withServer(async (base, repo) => {
      const { auth, serverId: alpha } = await owner(base);
      const { fake, serverId } = await fakeGameServer(base, auth.authorization.slice("Bearer ".length), "Bravo");
      try {
        const auditor = await staff(base, auth, "auditor", [{ capability: "audit.trail", level: "read" }]);
        const scoped = await staff(base, auth, "scoped", [{ capability: "audit.trail", level: "read", scopeType: "server", scopeId: alpha }]);
        const viewer = await staff(base, auth, "viewer", [{ capability: "server.view", level: "read" }]);
        const admin = await staff(base, auth, "admin", [{ capability: "admin.users", level: "write" }]);
        const quiet = await staff(base, auth, "quiet", [{ capability: "audit.trail", level: "read" }]);
        await turnOn(base, quiet.auth, svc, "quiet");
        const phone = await turnOn(base, auditor.auth, svc, "auditor");
        await turnOn(base, scoped.auth, svc, "scoped");
        await turnOn(base, viewer.auth, svc, "viewer");
        await turnOn(base, auth, svc, "owner");
        for (const who of [auditor.auth, scoped.auth, viewer.auth, auth]) await pick(base, who, { settings: true });

        assert.equal((await jf(`${base}/api/servers/${serverId}/config`, { method: "POST", headers: auth, body: JSON.stringify({ autoBalanceEnabled: true }) })).status, 200);
        const [d] = await deliveries(svc, "auditor", 1);
        const note = await phone.read(d!.body);
        assert.deepEqual(pickNote(note), { title: "owner changed server settings", body: "On Bravo: Auto-balance is now on." });
        assert.equal(note.url, "/#/admin/activity");
        assert.equal((await deliveries(svc, "scoped", 0)).length, 0, "they read Alpha's staff activity, not Bravo's");
        assert.equal((await deliveries(svc, "viewer", 0)).length, 0, "seeing a server is not reading its staff activity");
        assert.equal((await deliveries(svc, "owner", 0)).length, 0, "never the one who changed it");
        assert.equal((await deliveries(svc, "quiet", 0)).length, 0, "off until picked");

        // A change that belongs to no server: to whoever may read every server's staff activity.
        assert.equal((await jf(`${base}/api/roles`, { method: "POST", headers: admin.auth, body: JSON.stringify({ name: "Helper", grants: [] }) })).status, 201);
        const two = await deliveries(svc, "auditor", 2);
        assert.deepEqual(pickNote(await phone.read(two[1]!.body)), { title: "admin changed roles and permissions", body: "Created role \"Helper\" (0 grants)." });
        assert.equal((await deliveries(svc, "scoped", 0)).length, 0, "reading one server's is not reading everything");

        // A server added is the news itself, not something that happened on it.
        assert.equal((await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Charlie", host: "127.0.0.1", port: 3, password: "x" }) })).status, 201);
        const three = await deliveries(svc, "auditor", 3);
        assert.deepEqual(pickNote(await phone.read(three[2]!.body)), { title: "owner changed the servers", body: "Added the server Charlie." });

        // The app changing its own settings, and staff doing what is not a setting, are not news here.
        await repo.audit.create({ actorUserId: null, actorName: "auto-settings", action: "autosettings.config", targetType: "server", targetId: serverId, serverId, summary: "applied profile Night" });
        await repo.audit.create({ actorUserId: auditor.id, actorName: "auditor", action: "player.message", targetType: "player", targetId: "x", serverId, summary: "messaged someone" });
        assert.equal((await deliveries(svc, "auditor", 0)).length, 3);
      } finally {
        fake.close();
      }
    });
  } finally {
    await svc.close();
  }
});

test("settings saved several times by one person are one notification and then a count", async () => {
  const svc = await pushService();
  try {
    await withServer(async (base, repo, ctx) => {
      const { auth, serverId } = await owner(base);
      const editor = await staff(base, auth, "editor", [{ capability: "server.config", level: "write" }]);
      const auditor = await staff(base, auth, "auditor", [{ capability: "audit.trail", level: "read" }]);
      const phone = await turnOn(base, auditor.auth, svc, "auditor");
      await pick(base, auditor.auth, { settings: true });
      await shortWindows(repo, ctx, async () => {
        const set = (value: number) => repo.audit.create({ actorUserId: editor.id, actorName: "editor", action: "config.set", targetType: "server", targetId: serverId, targetName: "Alpha", serverId, summary: `set idleKick = ${value} on Alpha`, data: { field: "idleKick", value } });
        for (const v of [5, 6, 7]) await set(v);
        const one = await deliveries(svc, "auditor", 1);
        assert.deepEqual(pickNote(await phone.read(one[0]!.body)), { title: "editor changed server settings", body: "On Alpha: Idle kick (minutes) is now 5." });
        const two = await deliveries(svc, "auditor", 2);
        assert.deepEqual(pickNote(await phone.read(two[1]!.body)), { title: "editor changed server settings again", body: "On Alpha: 2 more changes." });
        assert.equal((await deliveries(svc, "auditor", 0)).length, 2);
      });
    });
  } finally {
    await svc.close();
  }
});

test("a notice posted on the staff board: to whoever picked it, never its author; a draft once it is posted", async () => {
  const svc = await pushService();
  try {
    await withServer(async (base) => {
      const { auth } = await owner(base);
      const editor = await staff(base, auth, "editor", [{ capability: "community.edit", level: "write" }]);
      const reader = await staff(base, auth, "reader", [{ capability: "server.view", level: "read" }]);
      const quiet = await staff(base, auth, "quiet", [{ capability: "server.view", level: "read" }]);
      const phone = await turnOn(base, reader.auth, svc, "reader");
      await turnOn(base, editor.auth, svc, "editor");
      await turnOn(base, quiet.auth, svc, "quiet");
      await pick(base, reader.auth, { notices: true });
      await pick(base, editor.auth, { notices: true });
      const post = (title: string, published: boolean) => jf(`${base}/api/community/announcements`, { method: "POST", headers: editor.auth, body: JSON.stringify({ title, body: "Read this.", published }) });

      const draft = await post("Server rules, version 2", false);
      assert.equal(draft.status, 201, JSON.stringify(draft.body));
      assert.equal((await deliveries(svc, "reader", 0)).length, 0, "a draft is nobody's news yet");
      const id = (draft.body.announcement as { id: string }).id;
      assert.equal((await jf(`${base}/api/community/announcements/${id}`, { method: "PATCH", headers: editor.auth, body: JSON.stringify({ published: true }) })).status, 200);
      const [d] = await deliveries(svc, "reader", 1);
      const note = await phone.read(d!.body);
      assert.deepEqual(pickNote(note), { title: "New notice from editor", body: "Server rules, version 2" });
      assert.equal(note.url, "/#/announcements");
      assert.equal((await post("Event on Saturday", true)).status, 201);
      assert.equal((await deliveries(svc, "reader", 2)).length, 2);
      assert.equal((await deliveries(svc, "editor", 0)).length, 0, "never its author");
      assert.equal((await deliveries(svc, "quiet", 0)).length, 0, "off until picked");
    });
  } finally {
    await svc.close();
  }
});

test("an admin in the admin camera: to whoever picked it and may read the camera log, once a visit", async () => {
  const svc = await pushService();
  try {
    await withServer(async (base, _repo, ctx) => {
      const { auth, serverId } = await owner(base);
      const watcher = await staff(base, auth, "watcher", [{ capability: "server.admins", level: "read" }]);
      const viewer = await staff(base, auth, "viewer", [{ capability: "server.view", level: "read" }]);
      const quiet = await staff(base, auth, "quiet", [{ capability: "server.admins", level: "read" }]);
      const phone = await turnOn(base, watcher.auth, svc, "watcher");
      await turnOn(base, viewer.auth, svc, "viewer");
      await turnOn(base, quiet.auth, svc, "quiet");
      for (const who of [watcher.auth, viewer.auth]) await pick(base, who, { camera: true });
      const cam = (name: string, entered: boolean | null) => ctx.bus.emit("evt.admin.camera", { kind: "evt.admin.camera", serverId, ts: new Date().toISOString(), actorPlayerId: `id-${name}`, actorName: name, data: { entered, message: entered ? "Entered Admin Camera" : "Left Admin Camera" } });

      cam("AdminBob", true);
      const [d] = await deliveries(svc, "watcher", 1);
      const note = await phone.read(d!.body);
      assert.deepEqual(pickNote(note), { title: "AdminBob is in the admin camera", body: "On Alpha." });
      assert.equal(note.url, "/#/history/admincam");
      cam("AdminBob", false);
      cam("AdminBob", true);
      cam("Somebody", null);
      assert.equal((await deliveries(svc, "watcher", 0)).length, 1, "leaving, coming straight back and a line that says neither are no news");
      cam("AdminSue", true);
      assert.equal((await deliveries(svc, "watcher", 2)).length, 2, "another admin is");
      assert.equal((await deliveries(svc, "viewer", 0)).length, 0, "seeing the server is not reading its camera log");
      assert.equal((await deliveries(svc, "quiet", 0)).length, 0, "off until picked");
    });
  } finally {
    await svc.close();
  }
});

test("a shop purchase: to whoever picked it and may read members' balances, once for all its servers", async () => {
  const svc = await pushService();
  try {
    await withServer(async (base, repo, ctx) => {
      const { auth } = await owner(base);
      const one = await fakeGameServer(base, auth.authorization.slice("Bearer ".length), "Bravo");
      const two = await fakeGameServer(base, auth.authorization.slice("Bearer ".length), "Charlie");
      try {
        const bank = await staff(base, auth, "bank", [{ capability: "economy.balances", level: "read" }]);
        const viewer = await staff(base, auth, "viewer", [{ capability: "server.view", level: "read" }]);
        const quiet = await staff(base, auth, "quiet", [{ capability: "economy.balances", level: "read" }]);
        const phone = await turnOn(base, bank.auth, svc, "bank");
        await turnOn(base, viewer.auth, svc, "viewer");
        await turnOn(base, quiet.auth, svc, "quiet");
        for (const who of [bank.auth, viewer.auth]) await pick(base, who, { shop: true });
        assert.equal((await jf(`${base}/api/economy/config`, { method: "PUT", headers: auth, body: JSON.stringify({
          currencyName: "Points", balanceCap: null,
          claims: { daily: { enabled: false, min: 15, max: 25 }, monthly: { enabled: false, min: 475, max: 525 } },
          gifting: { enabled: true, minAmount: 5, maxAmount: null }, vipGifting: { enabled: true },
          offers: [{ id: "two_weeks", label: "Two Weeks", points: 250, days: 14, scope: { mode: "servers", serverIds: [one.serverId, two.serverId] }, enabled: true }],
        }) })).status, 200);
        const buyer = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000077", name: "Buyer" });
        await repo.externalLinks.set(buyer.id, "discord", "123456789012345", "registration");
        await repo.economy.apply({ discordId: "123456789012345", delta: 300, reason: "seed" });
        await shortWindows(repo, ctx, async () => {
          const out = await purchase(repo, { buyerDiscordId: "123456789012345", offerId: "two_weeks", ref: "buy:screen-1", actorName: "shop", memberName: "BEAST" });
          assert.equal(out.status, "ok", JSON.stringify(out));
          const [d] = await deliveries(svc, "bank", 1);
          const note = await phone.read(d!.body);
          assert.deepEqual(pickNote(note), { title: "BEAST bought 14 days of VIP", body: "For Buyer, on Bravo, Charlie." });
          assert.equal(note.url, "/#/players/economy");
          // VIP paid out, or a registration bonus, goes through the same grant and is not a purchase.
          await repo.audit.create({ actorUserId: null, actorName: "payouts", action: "vip.grant", targetType: "player", targetId: "x", targetName: "Winner", serverId: one.serverId, summary: "granted VIP", data: { days: 7, ref: "payout:1", via: "bulk payout" } });
          await new Promise((r) => setTimeout(r, 800));
          assert.equal((await deliveries(svc, "bank", 0)).length, 1, "one notification for both servers, and none for a payout");
          assert.equal((await deliveries(svc, "viewer", 0)).length, 0, "seeing a server is not reading members' balances");
          assert.equal((await deliveries(svc, "quiet", 0)).length, 0, "off until picked");
        });
      } finally {
        one.fake.close();
        two.fake.close();
      }
    });
  } finally {
    await svc.close();
  }
});

test("signing out everywhere ends a device; one its browser has dropped is forgotten", async () => {
  const svc = await pushService();
  try {
    await withServer(async (base, repo, ctx) => {
      const { auth, serverId } = await owner(base);
      const other = await staff(base, auth, "other", [{ capability: "server.view", level: "read" }]);
      await turnOn(base, auth, svc, "owner");
      await turnOn(base, other.auth, svc, "other");
      assert.equal((await jf(`${base}/api/users/${other.id}/revoke-sessions`, { method: "POST", headers: auth })).status, 200);
      const again = await login(base, "other");
      assert.deepEqual((await jf(`${base}/api/me/push`, { headers: again })).body.devices, [], "signed in again, the old device is not listed as on");
      svc.answerWith((path) => (path === "/push/owner" ? 410 : 201));
      ctx.bus.emit("app.server.dark", { kind: "app.server.dark", serverId, ts: new Date().toISOString(), data: { minutes: 2 } });
      await deliveries(svc, "owner", 1);
      assert.equal((await deliveries(svc, "other", 0)).length, 0, "a signed-out account's phone hears nothing more");
      for (let i = 0; i < 40 && (await repo.pushSubscriptions.list()).length; i++) await new Promise((r) => setTimeout(r, 25));
      assert.deepEqual(await repo.pushSubscriptions.list(), [], "both devices are forgotten");

      // Turned on again under the new sign-in, it hears the next one.
      const back = await turnOn(base, again, svc, "other-again");
      ctx.bus.emit("app.server.recovered", { kind: "app.server.recovered", serverId, ts: new Date().toISOString(), data: { minutes: 4 } });
      const [d] = await deliveries(svc, "other-again", 1);
      assert.equal((await back.read(d!.body)).title, "Alpha is back");
    });
  } finally {
    await svc.close();
  }
});
