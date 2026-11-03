import { test } from "node:test";
import assert from "node:assert/strict";
import { createIsolatedRepository } from "@app/db";
import { discoverServersFromEnv } from "../dist/discovery.js";

const env = {
  SERVER_1_HOST: "10.0.0.1",
  SERVER_1_PORT: "28865",
  SERVER_1_PASSWORD: "pw1",
  SERVER_2_HOST: "10.0.0.2",
  SERVER_2_PORT: "27230",
  SERVER_2_PASSWORD: "pw2",
  SERVER_2_NAME: "Second",
} as NodeJS.ProcessEnv;

test("creates servers from env in observe mode", async () => {
  const { repo } = await createIsolatedRepository();
  const result = await discoverServersFromEnv(repo, { env, resolveNames: false });
  assert.equal(result.created.length, 2);
  assert.equal(result.existing.length, 0);
  const all = await repo.servers.list();
  assert.equal(all.length, 2);
  assert.ok(all.every((s) => s.engagementMode === "observe"));
  const second = all.find((s) => s.host === "10.0.0.2");
  assert.equal(second?.name, "Second"); // fallback name from env
  assert.equal(second?.port, 27230);
});

test("is idempotent — re-running does not duplicate", async () => {
  const { repo } = await createIsolatedRepository();
  await discoverServersFromEnv(repo, { env, resolveNames: false });
  const second = await discoverServersFromEnv(repo, { env, resolveNames: false });
  assert.equal(second.created.length, 0);
  assert.equal(second.existing.length, 2);
  assert.equal((await repo.servers.list()).length, 2);
});

test("no env servers -> no-op", async () => {
  const { repo } = await createIsolatedRepository();
  const result = await discoverServersFromEnv(repo, { env: {} as NodeJS.ProcessEnv, resolveNames: false });
  assert.equal(result.created.length, 0);
  assert.equal((await repo.servers.list()).length, 0);
});

/*
 * The game an env-seeded server runs.
 *
 * This used to be unaskable: every env server was created as `hll` because nothing carried a game.
 * HLL: Vietnam speaks HLL's RCON wire for wire, so a mislabelled Vietnam server CONNECTS — and is
 * then read with HLL's roles, sides, weapon buckets and identity rule. Nothing errors; the data is
 * just quietly wrong, including the squad-leader set that drives the no-leader automod. So the
 * rule is: honour what the operator names, refuse what we cannot honour, never guess silently.
 */

test("a named game is honoured, with the game's own protocol", async () => {
  const { repo } = await createIsolatedRepository();
  const result = await discoverServersFromEnv(repo, {
    env: { SERVER_1_HOST: "10.0.0.9", SERVER_1_PORT: "28865", SERVER_1_PASSWORD: "pw", SERVER_1_GAME: "hllv" } as NodeJS.ProcessEnv,
    resolveNames: false,
  });
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0]!.game, "hllv");
  assert.equal(result.created[0]!.protocol, "binary-v2", "unset protocol takes the game's first");
});

test("an unnamed game still defaults to hll, so existing deployments are untouched", async () => {
  const { repo } = await createIsolatedRepository();
  const result = await discoverServersFromEnv(repo, {
    env: { SERVER_1_HOST: "10.0.0.8", SERVER_1_PORT: "28865", SERVER_1_PASSWORD: "pw" } as NodeJS.ProcessEnv,
    resolveNames: false,
  });
  assert.equal(result.created[0]!.game, "hll");
  assert.equal(result.skipped.length, 0);
});

test("a game we have no module for is REFUSED, never seeded as hll", async () => {
  const { repo } = await createIsolatedRepository();
  const result = await discoverServersFromEnv(repo, {
    env: { SERVER_1_HOST: "10.0.0.7", SERVER_1_PORT: "28865", SERVER_1_PASSWORD: "pw", SERVER_1_GAME: "hll2" } as NodeJS.ProcessEnv,
    resolveNames: false,
  });
  assert.equal(result.created.length, 0, "no server is created from a game we cannot read");
  assert.equal((await repo.servers.list()).length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0]!.reason, /SERVER_1_GAME='hll2'/);
  assert.match(result.skipped[0]!.reason, /hll, hllv/, "the refusal names the games that would work");
});

test("a protocol the game does not speak is refused", async () => {
  const { repo } = await createIsolatedRepository();
  // crcon-bridge is HLL's, not Vietnam's — asking for it here cannot be honoured.
  const result = await discoverServersFromEnv(repo, {
    env: {
      SERVER_1_HOST: "10.0.0.6", SERVER_1_PORT: "28865", SERVER_1_PASSWORD: "pw",
      SERVER_1_GAME: "hllv", SERVER_1_PROTOCOL: "crcon-bridge",
    } as NodeJS.ProcessEnv,
    resolveNames: false,
  });
  assert.equal(result.created.length, 0);
  assert.match(result.skipped[0]!.reason, /not supported by Hell Let Loose: Vietnam/);
});

test("crcon-bridge without a CRCON URL is refused rather than seeded unusable", async () => {
  const { repo } = await createIsolatedRepository();
  const result = await discoverServersFromEnv(repo, {
    env: {
      SERVER_1_HOST: "10.0.0.5", SERVER_1_PORT: "28865", SERVER_1_PASSWORD: "api-key",
      SERVER_1_PROTOCOL: "crcon-bridge",
    } as NodeJS.ProcessEnv,
    resolveNames: false,
  });
  assert.equal(result.created.length, 0);
  assert.match(result.skipped[0]!.reason, /SERVER_1_CRCON_URL/);

  // With the URL it goes through, and the URL is stored.
  const ok = await discoverServersFromEnv(repo, {
    env: {
      SERVER_1_HOST: "10.0.0.5", SERVER_1_PORT: "28865", SERVER_1_PASSWORD: "api-key",
      SERVER_1_PROTOCOL: "crcon-bridge", SERVER_1_CRCON_URL: "https://crcon.example.com",
    } as NodeJS.ProcessEnv,
    resolveNames: false,
  });
  assert.equal(ok.created.length, 1);
  assert.equal(ok.created[0]!.crconBaseUrl, "https://crcon.example.com");
});

test("the env never overwrites a server that already exists", async () => {
  const { repo } = await createIsolatedRepository();
  const seed = { SERVER_1_HOST: "10.0.0.4", SERVER_1_PORT: "28865", SERVER_1_PASSWORD: "pw", SERVER_1_GAME: "hllv" } as NodeJS.ProcessEnv;
  await discoverServersFromEnv(repo, { env: seed, resolveNames: false });
  // The operator later corrects the game in the panel; the stale env must not undo that.
  const [row] = await repo.servers.list();
  await repo.servers.setGame(row!.id, "hll", "binary-v2");
  const again = await discoverServersFromEnv(repo, { env: seed, resolveNames: false });
  assert.equal(again.created.length, 0);
  assert.equal(again.existing.length, 1);
  assert.equal((await repo.servers.findById(row!.id))!.game, "hll", "the panel's correction stands");
});

/*
 * A server that MOVED.
 *
 * A host can hand a community a new ip, port and password for a server that is, to everyone who
 * plays on it, the same server: same records, same bans, same stats, same settings, same public
 * page. Only its face changed. Discovery used to recognise a server by that face — so a move made
 * it unknown, and the next boot seeded the env block again as a SECOND, empty server while the
 * real one sat unreachable beside it holding every record. The env block's SLOT is the identity
 * now, and it does not move with the server.
 */

test("a server that moved keeps its identity — the env never clones it", async () => {
  const { repo } = await createIsolatedRepository();
  const seed = { SERVER_2_HOST: "10.0.0.2", SERVER_2_PORT: "27230", SERVER_2_PASSWORD: "old" } as NodeJS.ProcessEnv;
  await discoverServersFromEnv(repo, { env: seed, resolveNames: false });
  const original = (await repo.servers.list())[0]!;
  assert.equal(original.seedSlot, 2, "the server remembers which env block seeded it");

  // The host moves it; staff repoint the panel at the new address.
  await repo.servers.updateConnection(original.id, { host: "10.9.9.9", port: 27999, password: "new" });

  // Next boot, env untouched — it still names the OLD address, which no longer exists.
  const again = await discoverServersFromEnv(repo, { env: seed, resolveNames: false });
  assert.equal(again.created.length, 0, "no second server is invented");
  assert.equal(again.existing.length, 1);
  const all = await repo.servers.list();
  assert.equal(all.length, 1, "still one server");
  assert.equal(all[0]!.id, original.id, "and it is the same one — every record stays attached");
  assert.equal(all[0]!.host, "10.9.9.9", "the panel's address stands; the stale env does not undo it");
  assert.equal(all[0]!.password, "new", "and so does the new credential");

  // Updating the env to match afterwards is also fine — same server, no duplicate.
  const updatedEnv = { SERVER_2_HOST: "10.9.9.9", SERVER_2_PORT: "27999", SERVER_2_PASSWORD: "new" } as NodeJS.ProcessEnv;
  const third = await discoverServersFromEnv(repo, { env: updatedEnv, resolveNames: false });
  assert.equal(third.created.length, 0);
  assert.equal((await repo.servers.list()).length, 1);
});

test("a server seeded before slots existed is adopted on the next boot", async () => {
  const { repo } = await createIsolatedRepository();
  // A row as an older install left it: from the env, but with no slot recorded.
  const legacy = await repo.servers.create({ name: "Legacy", host: "10.0.0.7", port: 28865, password: "pw" });
  assert.equal(legacy.seedSlot, null);

  const seed = { SERVER_3_HOST: "10.0.0.7", SERVER_3_PORT: "28865", SERVER_3_PASSWORD: "pw" } as NodeJS.ProcessEnv;
  const first = await discoverServersFromEnv(repo, { env: seed, resolveNames: false });
  assert.equal(first.created.length, 0, "matched by address, as before");
  assert.equal((await repo.servers.findById(legacy.id))!.seedSlot, 3, "and stamped with its slot");

  // Now protected: moving it no longer makes it unrecognisable.
  await repo.servers.updateConnection(legacy.id, { host: "10.9.9.7", port: 28999 });
  await discoverServersFromEnv(repo, { env: seed, resolveNames: false });
  assert.equal((await repo.servers.list()).length, 1, "no clone after the move");
});

test("a slot never steals a server another slot already holds", async () => {
  const { repo } = await createIsolatedRepository();
  const seed = {
    SERVER_1_HOST: "10.0.0.1", SERVER_1_PORT: "28865", SERVER_1_PASSWORD: "pw1",
    SERVER_2_HOST: "10.0.0.2", SERVER_2_PORT: "28865", SERVER_2_PASSWORD: "pw2",
  } as NodeJS.ProcessEnv;
  await discoverServersFromEnv(repo, { env: seed, resolveNames: false });
  const [one, two] = await repo.servers.list();

  // Slot 1 is moved onto slot 2's address — a fat-fingered env edit. It must not re-label the
  // server slot 2 owns; the claim is refused and slot 2 keeps its own server.
  const collide = { SERVER_1_HOST: "10.0.0.2", SERVER_1_PORT: "28865", SERVER_1_PASSWORD: "pw1" } as NodeJS.ProcessEnv;
  await discoverServersFromEnv(repo, { env: collide, resolveNames: false });
  assert.equal((await repo.servers.findById(one!.id))!.seedSlot, 1);
  assert.equal((await repo.servers.findById(two!.id))!.seedSlot, 2, "slot 2 still owns its server");
});

/*
 * The upgrade boot: the env was changed BEFORE the app learned about slots.
 *
 * This is the real sequence that prompted all of it. A host rotates a server onto a new address,
 * the operator puts it in the env — and the env is not a source of truth, so nothing happens and
 * the app keeps dialling the old address. Days later the app is upgraded. On that first boot
 * nothing carries a slot yet, so the slot lookup misses AND the address lookup misses, and the old
 * rule would have created an empty duplicate at the new address while the real server, holding
 * every record, sat unreachable beside it. Nothing about the slot mechanism saves that first boot,
 * because there is nothing stamped yet to save it with.
 */

test("the first boot after the env changed does not invent a duplicate", async () => {
  const { repo } = await createIsolatedRepository();
  // The database as the upgrade finds it: the server at its OLD address, no slot recorded.
  const real = await repo.servers.create({ name: "Second", host: "10.0.0.2", port: 27230, password: "old" });
  await repo.players.upsert({ platform: "steam", platformId: "76561198000000001", name: "Regular", game: "hll" });

  // The env already names the NEW address — changed days ago, and never honoured.
  const movedEnv = { SERVER_2_HOST: "10.9.9.9", SERVER_2_PORT: "27999", SERVER_2_PASSWORD: "new" } as NodeJS.ProcessEnv;
  const boot = await discoverServersFromEnv(repo, { env: movedEnv, resolveNames: false });

  assert.equal(boot.created.length, 0, "nothing is created");
  const all = await repo.servers.list();
  assert.equal(all.length, 1, "still exactly one server — no empty duplicate");
  assert.equal(all[0]!.id, real.id, "and it is the one holding the records");
  assert.equal(all[0]!.host, "10.0.0.2", "left at its stored address for a human to correct");

  // It says so, names both sides, and says what to do.
  assert.equal(boot.skipped.length, 1);
  assert.match(boot.skipped[0]!.reason, /SERVER_2/);
  assert.match(boot.skipped[0]!.reason, /10\.9\.9\.9:27999/, "the address the env wants");
  assert.match(boot.skipped[0]!.reason, /"Second" at 10\.0\.0\.2:27230/, "the server it might be");
  assert.match(boot.skipped[0]!.reason, /Administration → Connections/, "and where to fix it");

  // Staff repoint it in the panel. The next boot matches by address and stamps the slot.
  await repo.servers.updateConnection(real.id, { host: "10.9.9.9", port: 27999, password: "new" });
  const second = await discoverServersFromEnv(repo, { env: movedEnv, resolveNames: false });
  assert.equal(second.created.length, 0);
  assert.equal(second.existing.length, 1);
  assert.equal((await repo.servers.list()).length, 1, "still one server");
  assert.equal((await repo.servers.findById(real.id))!.seedSlot, 2, "now stamped, and protected from here on");
});

test("a first install still seeds normally — nothing to be confused by", async () => {
  const { repo } = await createIsolatedRepository();
  const result = await discoverServersFromEnv(repo, {
    env: { SERVER_1_HOST: "10.0.0.1", SERVER_1_PORT: "28865", SERVER_1_PASSWORD: "pw1" } as NodeJS.ProcessEnv,
    resolveNames: false,
  });
  assert.equal(result.created.length, 1, "an empty database has no unexplained server, so seeding works as always");
  assert.equal(result.skipped.length, 0);
  assert.equal(result.created[0]!.seedSlot, 1);
});

test("once every env server is stamped, a genuinely new block is still seeded", async () => {
  const { repo } = await createIsolatedRepository();
  const one = { SERVER_1_HOST: "10.0.0.1", SERVER_1_PORT: "28865", SERVER_1_PASSWORD: "pw1" } as NodeJS.ProcessEnv;
  await discoverServersFromEnv(repo, { env: one, resolveNames: false });

  // Everything the env accounts for is stamped, so adding a second block is unambiguous.
  const two = { ...one, SERVER_2_HOST: "10.0.0.2", SERVER_2_PORT: "28865", SERVER_2_PASSWORD: "pw2" } as NodeJS.ProcessEnv;
  const grown = await discoverServersFromEnv(repo, { env: two, resolveNames: false });
  assert.equal(grown.created.length, 1, "the new block is seeded");
  assert.equal(grown.created[0]!.seedSlot, 2);
  assert.equal((await repo.servers.list()).length, 2);
});
