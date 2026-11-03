import { test } from "node:test";
import assert from "node:assert/strict";
import { withServer, jf, ownerAuth } from "./harness.ts";

// The repo rides along: console-admin grants are planted directly because the POST route also
// writes the game, and there is no game on the other end of a unit test.

test("community role badges: the config round-trips, keeps identity, and refuses malformed rows", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);

    const put = (roleBadges: unknown) => jf(`${base}/api/app-config`, { method: "PUT", headers: auth, body: JSON.stringify({ roleBadges }) });

    // A fresh install has none — the field is always an array, never undefined, so no reader
    // needs a null branch.
    const fresh = await jf(`${base}/api/app-config`, { headers: auth });
    assert.deepEqual(fresh.body.config.roleBadges, []);

    const saved = await put([
      { emoji: "🛡️", label: "Community member", roleIds: ["12345678901234567", "22345678901234567"] },
      { emoji: "🏆", label: "Tournament team", roleIds: ["32345678901234567"] },
    ]);
    assert.equal(saved.status, 200);
    const [member, team] = saved.body.config.roleBadges as { id: string; emoji: string; roleIds: string[] }[];
    assert.equal(member!.emoji, "🛡️");
    assert.deepEqual(member!.roleIds, ["12345678901234567", "22345678901234567"], "several roles on one badge");
    assert.ok(member!.id, "the server assigns the identity");

    // Sending a row back WITH its id keeps it — edits don't reshuffle identities.
    const again = await put(saved.body.config.roleBadges);
    assert.equal((again.body.config.roleBadges as { id: string }[])[0]!.id, member!.id);
    assert.equal((again.body.config.roleBadges as { id: string }[])[1]!.id, team!.id);

    // A multi-codepoint emoji survives whole. The family is 11 UTF-16 units and the flag is 6 —
    // both were refused, or cut into the .notdef box, while this was measured by .length.
    const complex = await put([
      { emoji: "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}", label: "Family", roleIds: ["12345678901234567"] },
      { emoji: "\u{1F3F3}\uFE0F\u200D\u{1F308}", label: "Pride", roleIds: ["22345678901234567"] },
    ]);
    assert.equal(complex.status, 200);
    assert.equal((complex.body.config.roleBadges as { emoji: string }[])[0]!.emoji, "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}");
    assert.equal((complex.body.config.roleBadges as { emoji: string }[])[1]!.emoji, "\u{1F3F3}\uFE0F\u200D\u{1F308}");

    // An emoji already mangled by some other length cap is REPAIRED rather than stored as a box.
    const mangled = await put([{ emoji: "\u{1F468}\u200D\u{1F469}\u200D".slice(0, 5), label: "Cut", roleIds: ["12345678901234567"] }]);
    assert.equal(mangled.status, 200);
    const repaired = (mangled.body.config.roleBadges as { emoji: string }[])[0]!.emoji;
    assert.ok(!/[\uD800-\uDFFF]/.test(repaired.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")), "no half surrogate stored");
    assert.ok(!/\u200D$/.test(repaired), "no dangling joiner stored");

    // Put the two real badges back for the assertions below.
    await put([
      { emoji: "\u{1F6E1}\uFE0F", label: "Community member", roleIds: ["12345678901234567", "22345678901234567"] },
      { emoji: "\u{1F3C6}", label: "Tournament team", roleIds: ["32345678901234567"] },
    ]);

    // Refusals: no emoji, no roles, junk role ids, too many badges.
    assert.equal((await put([{ emoji: "", label: "x", roleIds: ["12345678901234567"] }])).status, 400);
    assert.equal((await put([{ emoji: "🛡️", label: "x", roleIds: [] }])).status, 400);
    assert.equal((await put([{ emoji: "🛡️", label: "x", roleIds: ["not-a-role"] }])).status, 400);
    assert.equal((await put(Array.from({ length: 21 }, (_, i) => ({ emoji: "🛡️", label: `b${i}`, roleIds: ["12345678901234567"] })))).status, 400);

    // The refusals changed nothing.
    const after = await jf(`${base}/api/app-config`, { headers: auth });
    assert.equal((after.body.config.roleBadges as unknown[]).length, 2);
  });
});

test("the profile reports console-admin grants like it reports VIP, and expired ones don't count", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const made = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "srv", host: "127.0.0.1", port: 1, password: "x" }) });
    const serverId = made.body.server.id as string;
    const player = await repo.players.upsert({ platformId: "76561198000000001", platform: "steam", game: "hll", name: "CamHolder" });

    // No grant: an empty list, not undefined — the viewer holds server.admins, so the field exists.
    const before = await jf(`${base}/api/players/${player.id}`, { headers: auth });
    assert.deepEqual(before.body.consoleAdminStatus, []);
    // Badges ride the same response; with none configured (and no Discord) it is just empty.
    assert.deepEqual(before.body.roleBadges, []);

    await repo.consoleAdmins.upsert({ serverId, playerId: "76561198000000001", playerName: "CamHolder", adminGroup: "spectator", comment: null, expiration: null, createdByUserId: null, createdByName: "test" });
    const withGrant = await jf(`${base}/api/players/${player.id}`, { headers: auth });
    assert.equal(withGrant.body.consoleAdminStatus.length, 1);
    assert.equal(withGrant.body.consoleAdminStatus[0].adminGroup, "spectator");
    assert.equal(withGrant.body.consoleAdminStatus[0].serverName, "srv", "named for people, not by uuid");

    // A lapsed grant is a memory, not a camera — the sweep just hasn't collected it yet.
    await repo.consoleAdmins.upsert({ serverId, playerId: "76561198000000001", playerName: "CamHolder", adminGroup: "spectator", comment: null, expiration: new Date(Date.now() - 60_000).toISOString(), createdByUserId: null, createdByName: "test" });
    const lapsed = await jf(`${base}/api/players/${player.id}`, { headers: auth });
    assert.deepEqual(lapsed.body.consoleAdminStatus, []);
  });
});
