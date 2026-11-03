/**
 * The live read against a roster whose entries the identity rule cannot all key.
 *
 * An entry with no usable player id is a PERSON THE APP CANNOT SEE: no player row, no session,
 * no kills, no VIP — which is how a whole platform's population reads near-zero on the stats
 * pages while staff watch them play. The panel can only warn about that if the payload says it,
 * so the contract under test is the diagnostic itself: the count, the sample of field NAMES
 * (what fixing the parser needs), and the per-row mark — while the entry still renders in the
 * list. The id-spelling half pins the casing tolerance: the same field under any capitalization
 * the wire has produced must resolve, because "iD" vs "ID" is exactly how this breaks in the
 * field.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeGameServer } from "./fake-hll-server.ts";
import { withServer, jf } from "./harness.ts";

async function ownerToken(base: string): Promise<string> {
  await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw" }) });
  const login = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw" }) });
  return login.body.token as string;
}

test("unidentifiable roster entries are surfaced, not silently dropped, and odd id casings resolve", async () => {
  await withServer(async (base, repo) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const { fake, serverId } = await fakeGameServer(base, token);
    fake.players = [
      { iD: "76561100000000001", name: "Tracked", platform: "steam" },
      // The ghost: no id under ANY spelling — only the fields a broken build might send.
      { iD: "", name: "Ghost", platform: "EPlatformFamily::Steam", accountRef: "opaque-blob" },
      // Same field, different casing: must key the player, not drop them.
      { iD: "", ID: "76561100000000002", name: "OddCase", platform: "steam" },
    ];
    try {
      const live = await jf(`${base}/api/servers/${serverId}/live`, { headers: auth });
      assert.equal(live.status, 200);
      const players = live.body.players as { name: string; untracked: boolean; playerDbId: string | null }[];
      assert.equal(players.length, 3, "the ghost still renders — staff must SEE the person");

      const ghost = players.find((p) => p.name === "Ghost")!;
      assert.equal(ghost.untracked, true);
      assert.equal(ghost.playerDbId, null);
      assert.equal(live.body.untrackedCount, 1);
      assert.ok((live.body.untrackedSampleKeys as string[]).includes("accountRef"),
        "the diagnostic carries the mystery entry's field names — what fixing the parser needs");

      const odd = players.find((p) => p.name === "OddCase")!;
      assert.equal(odd.untracked, false, "the same id field under another casing resolves");
      assert.ok(odd.playerDbId, "and gets a real player row");
      const row = (await repo.players.directory({ q: "76561100000000002" })).find((p) => p.name === "OddCase");
      assert.ok(row, "the odd-cased player landed in the directory under the id the game will act on");

      const tracked = players.find((p) => p.name === "Tracked")!;
      assert.equal(tracked.untracked, false);
    } finally { fake.close(); }
  });
});
