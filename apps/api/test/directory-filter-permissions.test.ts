import { test } from "node:test";
import assert from "node:assert/strict";
import { jf, withIsolatedServer as withServer } from "./harness.ts";

/*
 * The directory's "only perma banned" lists who is banned for good: the Bans page's answer, which
 * its permission gates there and on the profile, and which no row of the directory shows. The
 * directory honoured it for anyone who sees a server, so a Viewer could list every banned player.
 * "Only VIPs" stays everyone's: every row marks a VIP holder, as the Live roster does.
 */
async function signIn(base: string, username: string) {
  const r = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password: "pw" }) });
  return { authorization: `Bearer ${r.body.token as string}` };
}

test("the directory's perma-banned filter answers only to the Bans permission", async () => {
  await withServer(async (base) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const owner = await signIn(base, "owner");
    const account = async (username: string, extra: { capability: string; level: string }[]) => {
      const made = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username, password: "pw" }) });
      const grants = [{ capability: "server.view", level: "read" }, ...extra].map((g) => ({ ...g, scopeType: "global", scopeId: null }));
      await jf(`${base}/api/users/${made.body.user.id as string}/grants`, { method: "PUT", headers: owner, body: JSON.stringify({ grants }) });
      return signIn(base, username);
    };
    const viewer = await account("viewer", []);
    assert.equal((await jf(`${base}/api/players`, { headers: viewer })).status, 200, "the directory itself is a viewer's");
    assert.equal((await jf(`${base}/api/players?watched=1`, { headers: viewer })).status, 200, "who is watched is everyone's");
    assert.equal((await jf(`${base}/api/players?vip=1`, { headers: viewer })).status, 200, "every row marks a VIP already");
    assert.equal((await jf(`${base}/api/players?permaBanned=1`, { headers: viewer })).status, 403, "who is banned is the Bans permission's");

    const bans = await account("banreader", [{ capability: "moderation.bans", level: "read" }]);
    assert.equal((await jf(`${base}/api/players?permaBanned=1`, { headers: bans })).status, 200);
  });
});
