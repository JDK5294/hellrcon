/**
 * The cutover import of an earlier bot's bot.db (docs/vip-module.md's last section): links with provenance, opening balances
 * on the ledger, registration markers — and convergence, the property the whole screen is named
 * for: run it twice, the second run changes nothing.
 *
 * The end-to-end test builds a REAL SQLite file (through the same flag-gated node:sqlite child
 * mechanism the extractor uses) and pushes its bytes through the route.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createIsolatedRepository } from "@app/db";
import { createHandler, createAppContext, type AppContext } from "../dist/app.js";
import { importBotDb } from "../dist/botdb-import.js";
import { dayBonusKey, REGISTRATION_KV_NS } from "../dist/economy.js";

const execFileAsync = promisify(execFile);

test("the merge: links at the old bot's clock, refused conflicts, idempotent balances, welcome markers", async () => {
  const { repo } = await createIsolatedRepository();
  // A player who already exists AND is already linked to somebody else — the conflict case.
  const taken = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000401", name: "Taken" });
  await repo.externalLinks.set(taken.id, "discord", "999999999999", "manual");

  const users = [
    { discord_id: "111222333444", discord_display_name: "Alpha", player_guid: "76561198000000402", last_ingame_name: "AlphaIG", balance: 500, registration_vip_granted_once: 1, updated_at: "2026-01-05T10:00:00Z" },
    { discord_id: "555666777888", discord_username: "beta", player_guid: "76561198000000401", last_ingame_name: "Taken", balance: 50, registration_vip_granted_once: 0, updated_at: "2026-01-06T10:00:00Z" },
    { discord_id: "121212121212", discord_name: "NoGuid", balance: 25 }, // balance but never registered
    { discord_id: "not a discord id", balance: 9999 }, // junk row: skipped entirely
  ];

  const first = await importBotDb(repo, users, "tester");
  assert.equal(first.usersSeen, 3);
  assert.equal(first.links.imported, 1, "Alpha linked");
  assert.equal(first.links.conflicts.length, 1, "Taken's guid stays with its current Discord");
  assert.match(first.links.conflicts[0]!, /already linked to another Discord/);
  assert.equal(first.balances.imported, 3);
  assert.equal(first.balances.totalPoints, 575);
  assert.equal(first.welcomeMarkers, 1);

  // The sighting carries the old bot's clock, not the import's — an import is not a sighting.
  const alpha = (await repo.externalLinks.findPlayers("discord", "111222333444"))[0]!;
  assert.equal(alpha.name, "AlphaIG");
  assert.equal(alpha.lastSeen, "2026-01-05T10:00:00.000Z");
  assert.equal((await repo.economy.member("111222333444"))?.balance, 500);
  assert.equal((await repo.economy.member("121212121212"))?.balance, 25);
  // The old bot's welcome flag became the new flow's marker, under the key registration checks.
  assert.equal(await repo.pluginKv.get(REGISTRATION_KV_NS, dayBonusKey("111222333444")), true);

  // Convergence: the second run imports NOTHING new — same links, same balances, no double pay.
  const second = await importBotDb(repo, users, "tester");
  assert.equal(second.links.imported, 0);
  assert.equal(second.links.already, 1);
  assert.equal(second.balances.imported, 0);
  assert.equal(second.balances.already, 3);
  assert.equal(second.welcomeMarkers, 0);
  assert.equal((await repo.economy.member("111222333444"))?.balance, 500, "opening balance paid once");
});

/*
 * The cutover happens while the new Vietnam server is already taking registrations.
 *
 * Everybody quickest to register there holds a Vietnam player row keyed by an EOS id before the
 * import ever runs. The old bot's database is entirely WW2 (it predates Vietnam), so their WW2 link is new
 * information, not a conflict — and treating any other linked account as one refused exactly the
 * members who were most eager, leaving them with a balance and no WW2 account attached to it.
 */
test("a member who already registered on Vietnam still gets their old WW2 link imported", async () => {
  const { repo } = await createIsolatedRepository();
  const discordId = "313131313131";
  // They registered on the Vietnam server this week: an EOS-keyed row under game hllv.
  const nam = await repo.players.upsert({ game: "hllv", platform: "epic", platformId: "0002abcd-vn", name: "Wolf VN" });
  await repo.externalLinks.set(nam.id, "discord", discordId, "registration");

  const report = await importBotDb(repo, [
    { discord_id: discordId, discord_display_name: "Wolf", player_guid: "76561198000000601", last_ingame_name: "Wolf IG", balance: 300, registration_vip_granted_once: 0 },
  ], "tester");

  assert.equal(report.links.conflicts.length, 0, "the other GAME's account is not a conflict");
  assert.equal(report.links.imported, 1);
  const held = await repo.externalLinks.findPlayers("discord", discordId);
  assert.deepEqual(held.map((h) => [h.game, h.platformId]).sort(), [["hll", "76561198000000601"], ["hllv", "0002abcd-vn"]],
    "one account per game, both answering to the one Discord");

  // A SECOND WW2 guid for the same Discord is still a conflict — per game is the rule either way.
  const clash = await importBotDb(repo, [
    { discord_id: discordId, player_guid: "76561198000000602", last_ingame_name: "Someone Else", balance: 0, registration_vip_granted_once: 0 },
  ], "tester");
  assert.equal(clash.links.imported, 0);
  assert.match(clash.links.conflicts[0]!, /already linked to Wolf IG/);
});

/*
 * The old bot's welcome was paid in BOTH currencies, so the import has to spend both markers.
 *
 * The days ride a kv flag and the points ride a ledger ref. Marking only the flag left the points
 * ref unspent, so an imported member who then registered their Vietnam account — which is what the
 * whole community is doing this week — collected a welcome bonus the old bot had already given them.
 */
test("an imported member the old bot already welcomed does not collect it again on a second game", async () => {
  const { repo } = await createIsolatedRepository();
  const discordId = "414141414141";
  await repo.economy.setConfig({ registration: { bonusPoints: 100, bonusDays: 0, bonusAllGames: false, gameRoles: {} } });
  await importBotDb(repo, [
    { discord_id: discordId, discord_display_name: "Paid", player_guid: "76561198000000701", last_ingame_name: "Paid IG", balance: 250, registration_vip_granted_once: 1 },
  ], "tester");
  assert.equal((await repo.economy.member(discordId))?.balance, 250, "the opening balance and nothing else");

  // They now register their Vietnam account through the panel — the welcome must not pay twice.
  const { applyWelcomeBonus } = await import("../dist/discord-public.js");
  const nam = await repo.players.upsert({ game: "hllv", platform: "epic", platformId: "0002abcd-vn2", name: "Paid VN" });
  const bits = await applyWelcomeBonus(repo, discordId, nam);
  assert.deepEqual(bits, [], "nothing was paid");
  assert.equal((await repo.economy.member(discordId))?.balance, 250, "balance untouched");

  // Somebody the old bot never paid still collects theirs, once.
  const fresh = "515151515151";
  await importBotDb(repo, [
    { discord_id: fresh, discord_display_name: "Unpaid", player_guid: "76561198000000702", last_ingame_name: "Unpaid IG", balance: 0, registration_vip_granted_once: 0 },
  ], "tester");
  const ww2 = (await repo.externalLinks.findPlayers("discord", fresh))[0]!;
  assert.deepEqual(await applyWelcomeBonus(repo, fresh, ww2), ["**100 Points**"]);
  assert.equal((await repo.economy.member(fresh))?.balance, 100);
});

test("the upload route end to end: a real SQLite file in, a converging report out", async () => {
  const { repo } = await createIsolatedRepository();
  const ctx: AppContext = await createAppContext(repo, { port: 0, sessionSecret: "test", webRoot: null });
  const handler = createHandler(ctx);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = await mkdtemp(join(tmpdir(), "botdb-test-"));
  try {
    await fetch(`${base}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "owner", password: "pw" }) });
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "owner", password: "pw" }) });
    const token = ((await login.json()) as { token: string }).token;

    // Build the fixture with the SAME flag-gated child mechanism the extractor relies on.
    const dbPath = join(dir, "bot.db");
    await execFileAsync(process.execPath, ["--experimental-sqlite", "-e", `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      db.exec("CREATE TABLE users (discord_id TEXT PRIMARY KEY, discord_name TEXT, discord_username TEXT, discord_display_name TEXT, discord_global_name TEXT, discord_nick TEXT, player_guid TEXT, last_ingame_name TEXT, last_seen_ingame_name TEXT, balance INTEGER NOT NULL DEFAULT 0, registered_at TEXT, registration_source TEXT, registration_vip_granted_once INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT)");
      const ins = db.prepare("INSERT INTO users (discord_id, discord_display_name, player_guid, last_ingame_name, balance, registration_vip_granted_once, updated_at) VALUES (?,?,?,?,?,?,?)");
      ins.run("111000111000", "Wolf", "76561198000000501", "Wolf IG", 750, 1, "2026-02-01T00:00:00Z");
      ins.run("222000222000", "Fox", "76561198000000502", "Fox IG", 0, 0, "2026-02-02T00:00:00Z");
      db.close();
    `, dbPath]);
    const bytes = await readFile(dbPath);

    const post = (body: NonNullable<RequestInit["body"]>) => fetch(`${base}/api/economy/import-botdb`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body,
    });

    // Junk is refused before any child process runs.
    const junk = await post(Buffer.from("definitely not sqlite"));
    assert.equal(junk.status, 400);

    const r1 = await post(new Uint8Array(bytes));
    assert.equal(r1.status, 200);
    const report = (await r1.json()) as { usersSeen: number; links: { imported: number }; balances: { imported: number; totalPoints: number } };
    assert.equal(report.usersSeen, 2);
    assert.equal(report.links.imported, 2);
    assert.equal(report.balances.totalPoints, 750);
    assert.equal((await repo.externalLinks.findPlayers("discord", "111000111000"))[0]?.name, "Wolf IG");
    assert.equal((await repo.economy.member("111000111000"))?.balance, 750);
    assert.ok((await repo.audit.list({})).some((a) => a.action === "economy.import"));

    // Re-run: converges.
    const r2 = await post(new Uint8Array(bytes));
    const again = (await r2.json()) as { links: { imported: number; already: number }; balances: { imported: number } };
    assert.equal(again.links.imported, 0);
    assert.equal(again.links.already, 2);
    assert.equal(again.balances.imported, 0);
    assert.equal((await repo.economy.member("111000111000"))?.balance, 750);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/*
 * The cap, on the import path and afterwards.
 *
 * `apply` clamps credits only when it is TOLD the cap, and this one caller — alone among claim,
 * purchase, gift and staff-adjust — omitted the argument, so an imported balance of 3,069 landed whole
 * against a 1,000 ceiling and showed up on the public leaderboard. The clamp is at write time and
 * nothing revisits a balance, so the overshoot is permanent and the spent ref makes re-importing
 * converge on the wrong figure — which is why the repair has to exist alongside the fix.
 */
test("import respects the balance cap, and over-cap balances can be trimmed afterwards", async () => {
  const { repo } = await createIsolatedRepository();
  await repo.economy.setConfig({ balanceCap: 1000 });

  const users = [
    { discord_id: "111111111111111111", discord_username: "over", balance: 3069 },
    { discord_id: "222222222222222222", discord_username: "under", balance: 70 },
  ];
  const report = await importBotDb(repo, users, "staff");

  const over = (await repo.economy.members()).find((m) => m.discordId === "111111111111111111")!;
  const under = (await repo.economy.members()).find((m) => m.discordId === "222222222222222222")!;
  assert.equal(over.balance, 1000, "3,069 trims to the cap instead of landing whole");
  assert.equal(under.balance, 70, "a balance under the cap is untouched");
  // The report counts what LANDED, not what the old bot held — otherwise the recap overstates the import.
  assert.equal(report.balances.totalPoints, 1070);
  // And the ledger records the trimmed figure, so the member's history adds up to their balance.
  assert.equal((await repo.economy.ledger("111111111111111111"))[0]!.delta, 1000);

  // The repair, for balances that landed before the fix. Write one directly with NO cap — exactly
  // what the buggy caller did — then confirm the trim brings it back and says so on the ledger.
  await repo.economy.apply({ discordId: "333333333333333333", delta: 2465, reason: "pre-fix import", ref: "v4:opening:333333333333333333", actorName: "staff" });
  assert.deepEqual(await repo.economy.overCap(1000), { members: 1, excess: 1465 });

  const trim = await repo.economy.trimToCap(1000, "staff");
  assert.deepEqual(trim, { members: 1, removed: 1465 });
  const fixed = (await repo.economy.members()).find((m) => m.discordId === "333333333333333333")!;
  assert.equal(fixed.balance, 1000);
  const entries = await repo.economy.ledger("333333333333333333");
  assert.equal(entries[0]!.delta, -1465, "the correction is a real ledger row, not a silent edit");
  assert.match(entries[0]!.reason, /cap/i);

  // Idempotent by construction: nobody is over any more, so a second run is a no-op.
  assert.deepEqual(await repo.economy.trimToCap(1000, "staff"), { members: 0, removed: 0 });
  assert.deepEqual(await repo.economy.overCap(1000), { members: 0, excess: 0 });
  // An uncapped economy has nothing to report and nothing to do.
  assert.deepEqual(await repo.economy.overCap(null), { members: 0, excess: 0 });
});

/*
 * The registration role, on the import path.
 *
 * Every path that writes a Discord link reconciles the per-game role right after — self-service
 * verify, manual link/unlink, the profile's Set Discord. The cutover import was the sixth such path and
 * the only one that did not, so its members carried the link and the balance and never got the
 * role. Nothing revisits a role on its own, which left hand-relinking as the only repair.
 */
test("importing a link reconciles the registration role, and every linked member can be re-reconciled", async () => {
  const { repo } = await createIsolatedRepository();
  await repo.economy.setConfig({ registration: { bonusDays: 0, bonusPoints: 0, bonusAllGames: false, gameRoles: { hll: "5550001" }, serverIds: [] } });

  // Discord's API is not reachable from a test, and must not be: syncGameRoles is best-effort by
  // design and swallows what it cannot do. So the assertion is on the CONTRACT the import owes —
  // that the reconcile is invoked for what it linked and its outcome reaches the report — rather
  // than on Discord's response. Without a token it reports zeroes instead of throwing.
  const report = await importBotDb(repo, [
    { discord_id: "111111111111111111", discord_username: "linked", player_guid: "76561198000000901", balance: 5 },
  ], "staff");
  assert.equal(report.links.imported, 1);
  assert.ok(report.roles, "the report carries the role outcome, so a silent no-op is visible");
  assert.deepEqual(report.roles, { applied: 0, removed: 0, absent: 0, refused: 0 });

  // The bulk repair walks DISTINCT Discord identities — one entry per account, not per game link.
  const p2 = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000902", name: "Second" });
  await repo.externalLinks.set(p2.id, "discord", "111111111111111111", "manual");
  const p3 = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000903", name: "Third" });
  await repo.externalLinks.set(p3.id, "discord", "222222222222222222", "manual");
  assert.deepEqual(await repo.externalLinks.distinctExternalIds("discord"),
    ["111111111111111111", "222222222222222222"], "two accounts, three links");
});
