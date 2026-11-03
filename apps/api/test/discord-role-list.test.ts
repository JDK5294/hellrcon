import { test } from "node:test";
import assert from "node:assert/strict";
import { jf, withIsolatedServer as withServer } from "./harness.ts";

/*
 * The Discord role list names roles wherever the panel offers them. A rules editor needs it for a
 * rule's "only players holding" gate and its exemptions, and a group manager to tie a group to a
 * role — but the read asked for user admin, the economy or the bot's setup, so a rules editor was
 * shown an empty exemption list (and a hint to go and set up the public Discord server), and could
 * not keep a punishing rule off their own staff.
 */
async function signIn(base: string, username: string) {
  const r = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password: "pw" }) });
  return { authorization: `Bearer ${r.body.token as string}` };
}

test("every screen that names Discord roles can read them: rules, player groups, the economy, the bot's setup, the role map", async () => {
  await withServer(async (base) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const owner = await signIn(base, "owner");
    const account = async (username: string, capability: string) => {
      const made = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username, password: "pw" }) });
      await jf(`${base}/api/users/${made.body.user.id as string}/grants`, { method: "PUT", headers: owner, body: JSON.stringify({ grants: [{ capability, level: "read", scopeType: "global", scopeId: null }] }) });
      return signIn(base, username);
    };
    for (const [username, capability] of [["rules", "admin.moderation"], ["groups", "player.groups"], ["shop", "economy.config"], ["bot", "discord.setup"], ["users", "admin.users"]] as const) {
      const read = await jf(`${base}/api/discord/roles?guild=community`, { headers: await account(username, capability) });
      assert.equal(read.status, 200, `${capability} reads the role list`);
      assert.ok(Array.isArray(read.body.roles));
    }
    assert.equal((await jf(`${base}/api/discord/roles?guild=community`, { headers: await account("viewer", "server.view") })).status, 403, "seeing servers names no roles");
  });
});
