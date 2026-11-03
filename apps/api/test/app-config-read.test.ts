import { test } from "node:test";
import assert from "node:assert/strict";
import { jf, withIsolatedServer as withServer } from "./harness.ts";

/*
 * Every staff screen reads the community's clock from the app-wide settings, and the Discord bot's
 * setup tab shows the values it saves there. The read asked for View servers, so a shop manager, an
 * analyst or a bot-setup-only account was refused it: their screens fell back to UTC as if it were
 * the community's clock, and the setup tab showed its own saved values as blank — a badge added
 * there and saved replaced every badge it could not see.
 */
async function signIn(base: string, username: string) {
  const r = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password: "pw" }) });
  return { authorization: `Bearer ${r.body.token as string}` };
}

test("every signed-in account reads the app-wide settings, whatever it may do; nobody signed out does", async () => {
  await withServer(async (base) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const owner = await signIn(base, "owner");
    const saved = await jf(`${base}/api/app-config`, { method: "PUT", headers: owner, body: JSON.stringify({ timezone: "America/New_York", communityGuildId: "123456789012345678" }) });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    for (const [username, grants] of [
      ["shop", [{ capability: "economy.shop", level: "write" }]],
      ["botsetup", [{ capability: "discord.setup", level: "write" }]],
      ["analyst", [{ capability: "analytics.player", level: "read" }]],
      ["nobody", []],
    ] as const) {
      const made = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username, password: "pw" }) });
      await jf(`${base}/api/users/${made.body.user.id as string}/grants`, { method: "PUT", headers: owner, body: JSON.stringify({ grants: grants.map((g) => ({ ...g, scopeType: "global", scopeId: null })) }) });
      const read = await jf(`${base}/api/app-config`, { headers: await signIn(base, username) });
      assert.equal(read.status, 200, `${username} reads the community's settings`);
      assert.equal(read.body.config.timezone, "America/New_York", `${username} reads the community's own clock, not UTC`);
      assert.equal(read.body.config.communityGuildId, "123456789012345678");
    }
    assert.equal((await jf(`${base}/api/app-config`)).status, 401, "signed out, nothing");
  });
});
