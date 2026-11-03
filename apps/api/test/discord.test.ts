import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { createRepository } from "@app/db";
import { verifyInteraction, handleInteraction, commandSchemas } from "../dist/discord.js";

/** Make an Ed25519 keypair and return the raw public-key hex + a signer, mimicking Discord. */
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = (publicKey as KeyObject).export({ format: "der", type: "spki" }) as Buffer;
  const publicKeyHex = spki.subarray(spki.length - 32).toString("hex");
  const sign = (ts: string, body: string) => edSign(null, Buffer.from(ts + body), privateKey).toString("hex");
  return { publicKeyHex, sign };
}

/** Discord's timestamps are unix seconds. Signatures are only accepted near the current clock, so
 *  every test that expects success has to sign for *now*, not a fixed instant in 2023. */
const nowTs = () => String(Math.floor(Date.now() / 1000));

test("verifyInteraction: accepts a valid signature, rejects tampering", () => {
  const { publicKeyHex, sign } = keypair();
  const ts = nowTs();
  const body = JSON.stringify({ type: 1 });
  const sig = sign(ts, body);
  assert.equal(verifyInteraction(publicKeyHex, sig, ts, body), true);
  assert.equal(verifyInteraction(publicKeyHex, sig, ts, body + " "), false); // body changed
  assert.equal(verifyInteraction(publicKeyHex, sig, String(Number(ts) + 1), body), false); // timestamp changed
  assert.equal(verifyInteraction(keypair().publicKeyHex, sig, ts, body), false); // wrong key
  assert.equal(verifyInteraction("", sig, ts, body), false);
  assert.equal(verifyInteraction(publicKeyHex, "zz", ts, body), false); // garbage signature
});

/*
 * Discord signs `timestamp + body`, so the timestamp cannot be altered — but a signature stays
 * valid forever unless something checks that the timestamp is RECENT. Anything that ever saw the
 * bytes of one interaction (a proxy log, a mirrored request, a captured webhook delivery) could
 * otherwise replay it against this endpoint indefinitely. Harmless for a read-only listing;
 * not harmless at all once a component interaction is a button press we act on.
 */
test("verifyInteraction: a captured interaction cannot be replayed later", () => {
  const { publicKeyHex, sign } = keypair();
  const ts = nowTs();
  const body = JSON.stringify({ type: 3, data: { custom_id: "mapvote:foy_warfare" } });
  const sig = sign(ts, body);

  // Genuine delivery: accepted.
  assert.equal(verifyInteraction(publicKeyHex, sig, ts, body), true);

  // The exact same bytes, replayed an hour later. The signature is still cryptographically valid —
  // freshness is the only thing that can reject it.
  const anHourLater = Date.now() + 3600_000;
  assert.equal(
    verifyInteraction(publicKeyHex, sig, ts, body, { now: anHourLater }),
    false,
    "a replayed interaction must be refused",
  );

  // A day later, and a week later, for good measure.
  assert.equal(verifyInteraction(publicKeyHex, sig, ts, body, { now: Date.now() + 86_400_000 }), false);
  assert.equal(verifyInteraction(publicKeyHex, sig, ts, body, { now: Date.now() + 7 * 86_400_000 }), false);
});

test("verifyInteraction: the freshness window tolerates clock skew both ways", () => {
  const { publicKeyHex, sign } = keypair();
  const ts = nowTs();
  const body = JSON.stringify({ type: 1 });
  const sig = sign(ts, body);
  const at = (offsetSeconds: number) => verifyInteraction(publicKeyHex, sig, ts, body, { now: Date.now() + offsetSeconds * 1000 });

  // Our clock behind Discord's, and ahead of it — both are ordinary and must still work.
  assert.equal(at(-120), true, "a clock 2 minutes behind must still accept");
  assert.equal(at(120), true, "a clock 2 minutes ahead must still accept");
  assert.equal(at(299), true, "just inside the window");
  assert.equal(at(400), false, "well outside the window");
  assert.equal(at(-400), false, "outside in the other direction too");
});

test("verifyInteraction: a timestamp that is not a plain unix-seconds integer is refused", () => {
  const { publicKeyHex, sign } = keypair();
  const body = JSON.stringify({ type: 1 });
  // Number(" 12 ") is 12 and Number("") is 0 — a lenient parse would let these through and then
  // compare against the clock as if they were real.
  for (const bogus of ["", " ", "abc", "1e9", "-1700000000", "17000000.5", " 1700000000 ", "0x1", "Infinity", "NaN"]) {
    assert.equal(verifyInteraction(publicKeyHex, sign(bogus, body), bogus, body), false, `accepted timestamp ${JSON.stringify(bogus)}`);
  }
});

test("handleInteraction: unconfigured → 503", async () => {
  const repo = await createRepository();
  const r = await handleInteraction(repo, "", {}, "{}");
  assert.equal(r.status, 503);
});

test("handleInteraction: invalid signature → 401", async () => {
  const repo = await createRepository();
  const { publicKeyHex } = keypair();
  const r = await handleInteraction(repo, publicKeyHex, { signature: "00", timestamp: "1" }, JSON.stringify({ type: 1 }));
  assert.equal(r.status, 401);
});

test("handleInteraction: valid PING → PONG", async () => {
  const repo = await createRepository();
  const { publicKeyHex, sign } = keypair();
  const ts = nowTs();
  const body = JSON.stringify({ type: 1 });
  const r = await handleInteraction(repo, publicKeyHex, { signature: sign(ts, body), timestamp: ts }, body);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { type: 1 });
});

test("handleInteraction: the command answers ephemerally", async () => {
  const repo = await createRepository();
  const { publicKeyHex, sign } = keypair();
  const ts = nowTs();
  const body = JSON.stringify({ type: 2, data: { name: "staff" }, member: { user: { id: "1", username: "someone" } } });
  const r = await handleInteraction(repo, publicKeyHex, { signature: sign(ts, body), timestamp: ts }, body);
  assert.equal(r.status, 200);
  const b = r.body as { type: number; data: { content: string; flags: number } };
  assert.equal(b.type, 4);
  assert.equal(b.data.flags, 64, "everything the bot says to one person stays ephemeral");
  // No module registry is wired into this bare endpoint, so the panel itself cannot render — the
  // launcher's own behaviour lives in discord-modules.test.ts.
  assert.doesNotMatch(b.data.content, /Unknown command/);
});

test("handleInteraction: unknown command → friendly message, not an error", async () => {
  const repo = await createRepository();
  const { publicKeyHex, sign } = keypair();
  const ts = nowTs();
  const body = JSON.stringify({ type: 2, data: { name: "nope" } });
  const r = await handleInteraction(repo, publicKeyHex, { signature: sign(ts, body), timestamp: ts }, body);
  assert.equal(r.status, 200);
  assert.match((r.body as { data: { content: string } }).data.content, /Unknown command/);
});

test("handleInteraction: a replayed command is rejected at the door with 401", async () => {
  const repo = await createRepository();
  const { publicKeyHex, sign } = keypair();
  const ts = nowTs();
  const body = JSON.stringify({ type: 2, data: { name: "staff" } });
  const headers = { signature: sign(ts, body), timestamp: ts };

  assert.equal((await handleInteraction(repo, publicKeyHex, headers, body)).status, 200);
  const replayed = await handleInteraction(repo, publicKeyHex, headers, body, { now: Date.now() + 3600_000 });
  assert.equal(replayed.status, 401, "a stale interaction must never reach a command handler");
});

test("commandSchemas exposes the one command for registration", async () => {
  // The name comes from the stored config now (see discord-commands.test.ts); the default is
  // what a fresh install registers.
  const cfg = await (await createRepository()).discordCommands.get();
  assert.deepEqual(commandSchemas(cfg).map((c) => c.name), ["staff"]);
});
