/**
 * The staff command, drawn for the panel (Help's Discord walkthrough — discord-preview.ts).
 *
 * What is under test:
 *   - each person is drawn the panel THEIR permissions open in Discord: the launcher's parts, and
 *     each part's opening screen as the part itself draws it;
 *   - a part that starts by picking a server draws that server's screen, for a server the person
 *     can see, and refuses any other;
 *   - drawing it does nothing: no row is written (Discord records every press), nothing is posted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withIsolatedServer as withServer, jf, ownerAuth } from "./harness.ts";

type Message = { content: string; components: { components: { type: number; label?: string; custom_id?: string; placeholder?: string; options?: { label: string }[] }[] }[] };

const labels = (m: Message): string[] => m.components.flatMap((row) => row.components.map((c) => c.label ?? c.placeholder ?? ""));

async function staffAuth(base: string, owner: Record<string, string>, username: string, grants: { capability: string; level: string; scopeType?: string; scopeId?: string | null }[]) {
  const u = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username, password: "pw" }) });
  const put = await jf(`${base}/api/users/${u.body.user.id as string}/grants`, {
    method: "PUT", headers: owner,
    body: JSON.stringify({ grants: grants.map((g) => ({ scopeType: "global", scopeId: null, ...g })) }),
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password: "pw" }) });
  return { authorization: `Bearer ${l.body.token as string}` };
}

const keyOf = (id: string) => id.replaceAll("-", "").slice(0, 8);

test("the staff command is drawn with the parts the viewer's permissions open, each drawn by itself", async () => {
  await withServer(async (base) => {
    assert.equal((await jf(`${base}/api/discord/staff-panel`)).status, 401, "signed in only");
    const owner = await ownerAuth(base);
    const all = await jf(`${base}/api/discord/staff-panel`, { headers: owner });
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.deepEqual(all.body.command, { name: "staff", enabled: true });
    assert.equal(all.body.linked, false, "no Discord linked to this account");
    // The launcher lists the parts; the two Economy absorbs are reached through its doors.
    assert.deepEqual(labels(all.body.home), ["Servers", "Economy", "Moderation", "Maps & vote"]);
    assert.deepEqual(Object.keys(all.body.parts).sort(), ["economy", "maps", "moderation", "register", "servers", "viplauncher"]);
    const economy = all.body.parts.economy;
    assert.equal(economy.label, "Economy");
    assert.match(economy.message.content, /^\*\*Economy\*\*/);
    assert.ok(labels(economy.message).includes("Register / link accounts") && labels(economy.message).includes("Post the public VIP panel"), labels(economy.message).join(" | "));
    assert.ok(labels(economy.message).includes("‹ Back"), "the host's own Back row, as in Discord");
    assert.equal(economy.servers, false);
    assert.equal(all.body.parts.maps.servers, true, "Maps & vote starts by picking a server");
    assert.equal(all.body.parts.moderation.servers, true);
    assert.equal(all.body.parts.register.message.components.at(-1).components[0].custom_id, "sp:economy::", "an absorbed part's Back leads to Economy");

    // Someone who may look at servers and nothing else: the parts that need only that.
    const viewer = await staffAuth(base, owner, "viewer", [{ capability: "server.view", level: "read" }]);
    const theirs = await jf(`${base}/api/discord/staff-panel`, { headers: viewer });
    assert.deepEqual(labels(theirs.body.home), ["Servers", "Moderation", "Maps & vote"]);
    assert.deepEqual(Object.keys(theirs.body.parts).sort(), ["maps", "moderation", "servers"]);

    // Economy without linking accounts: the door is there, as in Discord, but not the part behind it.
    const banker = await staffAuth(base, owner, "banker", [{ capability: "economy.balances", level: "read" }]);
    const bank = await jf(`${base}/api/discord/staff-panel`, { headers: banker });
    assert.deepEqual(Object.keys(bank.body.parts), ["economy"]);
    assert.ok(labels(bank.body.parts.economy.message).includes("Register / link accounts"));
  });
});

test("a part that picks a server draws that server's screen, for a server the viewer can see", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const mine = await repo.servers.create({ name: "WW2 #1", host: "127.0.0.1", port: 1, password: "pw", engagementMode: "active" });
    const other = await repo.servers.create({ name: "WW2 #2", host: "127.0.0.1", port: 1, password: "pw", engagementMode: "active" });

    const maps = await jf(`${base}/api/discord/staff-panel/maps/${keyOf(mine.id)}`, { headers: owner });
    assert.equal(maps.status, 200, JSON.stringify(maps.body));
    assert.match(maps.body.message.content, /^\*\*Maps & vote\*\* — \*\*WW2 #1\*\*/);
    // Read from the game, as the card always is: this one is not there to answer.
    assert.match(maps.body.message.content, /could not reach the server/);
    assert.ok(labels(maps.body.message).includes("Change map now…") && labels(maps.body.message).includes("All servers"), labels(maps.body.message).join(" | "));

    const cart = await jf(`${base}/api/discord/staff-panel/moderation/${keyOf(mine.id)}`, { headers: owner });
    assert.match(cart.body.message.content, /^\*\*Moderation\*\* — \*\*WW2 #1\*\*/);
    assert.match(cart.body.message.content, /Targets \(0\)/, "an empty cart");
    assert.ok(labels(cart.body.message).includes("Add from roster") && labels(cart.body.message).includes("Review & send"));

    // A grant on the other server only: this one's screens are refused in the part's own words.
    const scoped = await staffAuth(base, owner, "scoped", [{ capability: "server.view", level: "read", scopeType: "server", scopeId: other.id }]);
    const refused = await jf(`${base}/api/discord/staff-panel/maps/${keyOf(mine.id)}`, { headers: scoped });
    assert.match(refused.body.message.content, /permissions don't reach it/);
    assert.ok(!labels(refused.body.message).includes("Change map now…"));
    const cartRefused = await jf(`${base}/api/discord/staff-panel/moderation/${keyOf(mine.id)}`, { headers: scoped });
    assert.match(cartRefused.body.message.content, /permissions don't reach that server/);
    const own = await jf(`${base}/api/discord/staff-panel/moderation/${keyOf(other.id)}`, { headers: scoped });
    assert.match(own.body.message.content, /\*\*WW2 #2\*\*/);

    // A part that picks no server, or one that is not theirs: nothing to draw.
    assert.equal((await jf(`${base}/api/discord/staff-panel/economy/${keyOf(mine.id)}`, { headers: owner })).status, 404);
    assert.equal((await jf(`${base}/api/discord/staff-panel/nothing/${keyOf(mine.id)}`, { headers: owner })).status, 404);
    const banker = await staffAuth(base, owner, "banker", [{ capability: "economy.balances", level: "read" }]);
    assert.equal((await jf(`${base}/api/discord/staff-panel/maps/${keyOf(mine.id)}`, { headers: banker })).status, 404);
  });
});

test("drawing the staff command records nothing, as no press was made", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const server = await repo.servers.create({ name: "WW2 #1", host: "127.0.0.1", port: 1, password: "pw", engagementMode: "active" });
    const rows = async () => (await repo.audit.list({ limit: 500 })).length;
    const before = await rows();
    await jf(`${base}/api/discord/staff-panel`, { headers: owner });
    await jf(`${base}/api/discord/staff-panel/maps/${keyOf(server.id)}`, { headers: owner });
    await jf(`${base}/api/discord/staff-panel/moderation/${keyOf(server.id)}`, { headers: owner });
    assert.equal(await rows(), before, "Discord records each press it gets; a drawing is none");
  });
});
