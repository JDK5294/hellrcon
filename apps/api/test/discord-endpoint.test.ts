import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { withServer } from "./harness.ts";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = (publicKey as KeyObject).export({ format: "der", type: "spki" }) as Buffer;
  const publicKeyHex = spki.subarray(spki.length - 32).toString("hex");
  const sign = (ts: string, body: string) => edSign(null, Buffer.from(ts + body), privateKey).toString("hex");
  return { publicKeyHex, sign };
}

test("interactions endpoint: signed PING → PONG, unsigned → 401", async () => {
  const { publicKeyHex, sign } = keypair();
  const prev = process.env.DISCORD_PUBLIC_KEY;
  process.env.DISCORD_PUBLIC_KEY = publicKeyHex;
  try {
    await withServer(async (base) => {
      // Signatures are only honoured near the current clock, so this has to be signed for now.
      const ts = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({ type: 1 });
      const good = await fetch(`${base}/api/discord/interactions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-signature-ed25519": sign(ts, body), "x-signature-timestamp": ts },
        body,
      });
      assert.equal(good.status, 200);
      assert.deepEqual(await good.json(), { type: 1 });

      const bad = await fetch(`${base}/api/discord/interactions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-signature-ed25519": "00", "x-signature-timestamp": ts },
        body,
      });
      assert.equal(bad.status, 401);

      // A correctly-signed interaction from an hour ago: cryptographically valid, and still
      // refused. This is the whole endpoint, not just the verifier — a replay must not reach a
      // command handler no matter which layer it arrives through.
      const staleTs = String(Math.floor(Date.now() / 1000) - 3600);
      const replayed = await fetch(`${base}/api/discord/interactions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-signature-ed25519": sign(staleTs, body), "x-signature-timestamp": staleTs },
        body,
      });
      assert.equal(replayed.status, 401, "a replayed interaction must be refused at the endpoint");
    });
  } finally {
    if (prev === undefined) delete process.env.DISCORD_PUBLIC_KEY; else process.env.DISCORD_PUBLIC_KEY = prev;
  }
});
