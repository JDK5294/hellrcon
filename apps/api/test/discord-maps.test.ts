/**
 * The Maps & vote module on the staff /command.
 *
 * What is actually under test:
 *   - the hub reads the ROUND off the game (current map, rotation's next) and the vote off our
 *     own state, and only a maps.next holder sees the write buttons;
 *   - a forged press without the grant refuses at press time — a button proves nothing;
 *   - change-map-now goes picker → consent screen → the shared changeMapNow core: a listed map
 *     switches, an unlisted one is STAGED into the rotation first (the silent-swallow lesson),
 *     both audited under the staff account;
 *   - set-next queues by rotation rewrite and leaves the round alone;
 *   - the objective walk carries row indices, applies through the shared core, and the game
 *     receives the layout;
 *   - the vote controls write the worker's runtime state with the routes' own audit rows.
 *
 * Everything drives the real handleInteraction with real signatures, like every panel test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { createIsolatedRepository, type Repository } from "@app/db";
import { handleInteraction } from "../dist/discord.js";
import { DiscordModuleRegistry, registerBuiltinModules } from "../dist/discord-modules.js";
import { FakeHllServer } from "./fake-hll-server.ts";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = (publicKey as KeyObject).export({ format: "der", type: "spki" }) as Buffer;
  return {
    publicKeyHex: spki.subarray(spki.length - 32).toString("hex"),
    sign: (ts: string, body: string) => edSign(null, Buffer.from(ts + body), privateKey).toString("hex"),
  };
}

type Body = { type: number; data: Record<string, unknown> };

const STAFF = "100000000000000001";

async function staffAccount(repo: Repository, caps: { capability: string; level?: "read" | "write"; scopeId?: string | null }[]) {
  const user = await repo.users.create({ username: `staff-${STAFF}`, discordId: STAFF });
  for (const c of caps) {
    await repo.grants.create({
      userId: user.id, capability: c.capability,
      scopeType: c.scopeId ? "server" : "global", scopeId: c.scopeId ?? null, level: c.level ?? "write",
    });
  }
  return user;
}

/** A live game with a small map world: two maps rotating, a third only installed. */
async function liveServer(repo: Repository) {
  const fake = new FakeHllServer("pw");
  fake.rotation = ["carentan_warfare", "foy_warfare"];
  fake.catalogue = ["carentan_warfare", "foy_warfare", "elalamein_warfare"];
  fake.session = { mapName: "CARENTAN", mapId: "carentan_warfare", playerCount: 37 };
  const port = await fake.listen();
  const server = await repo.servers.create({ name: "WW2 #1", host: "127.0.0.1", port, password: "pw", engagementMode: "active" });
  return { fake, server, key: server.id.replaceAll("-", "").slice(0, 8) };
}

function caller(repo: Repository) {
  const registry = new DiscordModuleRegistry();
  registerBuiltinModules(registry, repo, async () => {});
  const { publicKeyHex, sign } = keypair();
  return async (interaction: Record<string, unknown>): Promise<Body> => {
    const body = JSON.stringify(interaction);
    const ts = String(Math.floor(Date.now() / 1000));
    const r = await handleInteraction(repo, publicKeyHex, { signature: sign(ts, body), timestamp: ts }, body, { registry });
    await r.followUp;
    return r.body as Body;
  };
}

const press = (customId: string, extra: Record<string, unknown> = {}) => ({
  type: 3, token: "tok", channel_id: "900", channel: { id: "900", name: "staff-cmds" },
  message: { id: "m1", flags: 64 },
  data: { custom_id: customId, ...extra },
  member: { user: { id: STAFF, username: "admin" }, roles: [] },
});
const submit = (customId: string, values: Record<string, string>) => ({
  type: 5, token: "tok", channel_id: "900", channel: { id: "900", name: "staff-cmds" },
  message: { id: "m1", flags: 64 },
  data: {
    custom_id: customId,
    components: Object.entries(values).map(([id, value]) => ({ type: 1, components: [{ type: 4, custom_id: id, value }] })),
  },
  member: { user: { id: STAFF, username: "admin" }, roles: [] },
});

const content = (b: Body): string => String((b.data as { content?: unknown }).content ?? "");
const allIds = (b: Body): string[] => {
  const rows = ((b.data as { components?: unknown }).components ?? []) as { components: { custom_id?: string }[] }[];
  return rows.flatMap((r) => r.components.map((c) => String(c.custom_id ?? "")));
};

test("the hub reads the round off the game, and the write buttons follow the grant", async () => {
  const { repo } = await createIsolatedRepository();
  const { fake, server, key } = await liveServer(repo);
  try {
    await staffAccount(repo, [
      { capability: "server.view", level: "read" },
      { capability: "maps.next", scopeId: server.id },
    ]);
    const call = caller(repo);

    const launcher = await call(press("sp:home::"));
    assert.match(content(launcher), /Maps & vote/);

    const pick = await call(press("sp:maps::"));
    assert.ok(allIds(pick).includes("sp:maps:srv:"), "the server select is there");

    const hub = await call(press("sp:maps:srv:", { values: [key] }));
    assert.match(content(hub), /Current map:.*Carentan/i);
    assert.match(content(hub), /37 player\(s\)/);
    assert.match(content(hub), /Next in rotation:.*Foy/i);
    assert.match(content(hub), /Map vote:.*not enabled/);
    assert.ok(allIds(hub).includes(`sp:maps:mp:${key}:c:0`), "the maps.next holder gets the change button");
    assert.ok(allIds(hub).includes(`sp:maps:ob:${key}`), "and the objectives door");
    assert.ok(!allIds(hub).includes(`sp:maps:obc:${key}`), "no clear-layout door on WW2 — it stores nothing to clear");
  } finally {
    fake.close();
  }
});

test("a reader sees the story but no writes — and a forged press refuses at press time", async () => {
  const { repo } = await createIsolatedRepository();
  const { fake, key } = await liveServer(repo);
  try {
    await staffAccount(repo, [{ capability: "server.view", level: "read" }]);
    const call = caller(repo);

    const hub = await call(press("sp:maps:srv:", { values: [key] }));
    assert.match(content(hub), /Current map:/);
    assert.ok(!allIds(hub).includes(`sp:maps:mp:${key}:c:0`), "no change button without maps.next");

    // A custom_id typed by hand is still checked against the presser's own grants.
    const forged = await call(press(`sp:maps:cma:${key}:foy_warfare`));
    assert.match(content(forged), /don't hold maps\.next/);
    assert.equal(fake.changedTo, null, "the game never heard about it");
  } finally {
    fake.close();
  }
});

test("change map now: picker → consent → switch; an unlisted map is staged into the rotation first", async () => {
  const { repo } = await createIsolatedRepository();
  const { fake, server, key } = await liveServer(repo);
  try {
    const staff = await staffAccount(repo, [
      { capability: "server.view", level: "read" },
      { capability: "maps.next", scopeId: server.id },
    ]);
    const call = caller(repo);

    const picker = await call(press(`sp:maps:mp:${key}:c:0`));
    assert.match(content(picker), /Change map now/);
    assert.match(content(picker), /3 map\(s\)/, "rotation first, then the rest of the catalogue");

    const confirm = await call(press(`sp:maps:mps:${key}:c:0`, { values: ["foy_warfare"] }));
    assert.match(content(confirm), /round in progress ends/i, "changing NOW is never one press");
    assert.ok(allIds(confirm).includes(`sp:maps:cma:${key}:foy_warfare`));

    const done = await call(press(`sp:maps:cma:${key}:foy_warfare`));
    assert.match(content(done), /Told the server to load .*Foy/i);
    assert.equal(fake.changedTo, "foy_warfare", "the game really switched");

    // The map only the CATALOGUE has: ChangeMap would swallow it, so the core stages it first.
    const modal = await call(press(`sp:maps:mpm:${key}:c`));
    assert.equal(modal.type, 9);
    const confirm2 = await call(submit(`sp:maps:mpc:${key}:c`, { mapid: "elalamein_warfare" }));
    assert.ok(allIds(confirm2).includes(`sp:maps:cma:${key}:elalamein_warfare`));
    const done2 = await call(press(`sp:maps:cma:${key}:elalamein_warfare`));
    assert.match(content(done2), /added to the rotation first/);
    assert.ok(fake.rotation.includes("elalamein_warfare"), "staged for real");
    assert.equal(fake.changedTo, "elalamein_warfare");

    const trail = await repo.audit.list({ actions: ["map.change"], limit: 5 });
    assert.equal(trail.length, 2);
    for (const row of trail) assert.equal(row.actorUserId, staff.id);
  } finally {
    fake.close();
  }
});

test("set next map queues by rotation rewrite and leaves the round alone; the objective walk lands in the game", async () => {
  const { repo } = await createIsolatedRepository();
  const { fake, server, key } = await liveServer(repo);
  try {
    await staffAccount(repo, [
      { capability: "server.view", level: "read" },
      { capability: "maps.next", scopeId: server.id },
    ]);
    fake.objectiveRows = [
      ["A1", "A2", "A3"], ["B1", "B2", "B3"], ["C1", "C2", "C3"], ["D1", "D2", "D3"], ["E1", "E2", "E3"],
    ];
    const call = caller(repo);

    const queued = await call(press(`sp:maps:mps:${key}:n:0`, { values: ["foy_warfare"] }))
      .then(() => call(press(`sp:maps:nma:${key}:foy_warfare`)));
    assert.match(content(queued), /plays after this round/);
    assert.equal(fake.changedTo, null, "queueing never ends the round");
    assert.equal((await repo.audit.list({ actions: ["map.next"], limit: 5 })).length, 1);

    // The five-sector walk: indices ride in the custom_id, names never do.
    const s1 = await call(press(`sp:maps:ob:${key}`));
    assert.match(content(s1), /sector 1 of 5/);
    let step = await call(press(`sp:maps:obs:${key}:0:`, { values: ["0"] }));
    step = await call(press(`sp:maps:obs:${key}:1:0`, { values: ["1"] }));
    step = await call(press(`sp:maps:obs:${key}:2:01`, { values: ["2"] }));
    step = await call(press(`sp:maps:obs:${key}:3:012`, { values: ["r"] }));
    step = await call(press(`sp:maps:obs:${key}:4:012r`, { values: ["0"] }));
    assert.match(content(step), /review/);
    assert.match(content(step), /Sector 1: \*\*A1\*\*/);
    assert.match(content(step), /Sector 4: \*\*🎲 random\*\*/);

    const applied = await call(press(`sp:maps:oba:${key}:012r0`));
    assert.match(content(applied), /✅ Objectives set: A1 \/ B2 \/ C3 \/ D\d \/ E1/);
    assert.ok(fake.sectorLayout, "the game received the layout");
    assert.equal((await repo.audit.list({ actions: ["map.objectives"], limit: 5 })).length, 1);
  } finally {
    fake.close();
  }
});

test("vote controls write the worker's runtime state with the routes' own audit rows", async () => {
  const { repo } = await createIsolatedRepository();
  const { fake, server, key } = await liveServer(repo);
  try {
    const staff = await staffAccount(repo, [
      { capability: "server.view", level: "read" },
      { capability: "mapvote.control", scopeId: server.id },
    ]);
    const call = caller(repo);

    const paused = await call(press(`sp:maps:vp:${key}:1`));
    assert.match(content(paused), /Vote paused/);
    let st = await repo.mapVote.getState(server.id);
    assert.equal(st?.paused, true);
    assert.equal(st?.pauseReason, "staff", "a staff pause never lifts itself");

    const started = await call(press(`sp:maps:vn:${key}`));
    assert.match(content(started), /brand-new vote/);
    st = await repo.mapVote.getState(server.id);
    assert.equal(st?.paused, false);
    assert.equal(st?.startNow, true);

    const trail = await repo.audit.list({ actions: ["mapvote.pause", "mapvote.start"], limit: 5 });
    assert.equal(trail.length, 2);
    for (const row of trail) assert.equal(row.actorUserId, staff.id);
  } finally {
    fake.close();
  }
});

test("a forged objectives walk refuses cleanly instead of throwing into the failure banner", async () => {
  const { repo } = await createIsolatedRepository();
  const { fake, server, key } = await liveServer(repo);
  try {
    await staffAccount(repo, [
      { capability: "server.view", level: "read" },
      { capability: "maps.next", scopeId: server.id },
    ]);
    fake.objectiveRows = [
      ["A1", "A2", "A3"], ["B1", "B2", "B3"], ["C1", "C2", "C3"], ["D1", "D2", "D3"], ["E1", "E2", "E3"],
    ];
    const call = caller(repo);

    // custom_ids are attacker-influenceable by design. An accumulator longer than the five
    // sectors is refused as stale — never a TypeError in the host's failure banner.
    const long = await call(press(`sp:maps:obs:${key}:9:9999999`, { values: ["0"] }));
    assert.ok(!/failed:/.test(content(long)), "no failure banner");
    assert.match(content(long), /went stale/);

    // A forged sector COUNTER, too: -7 walked past the bounded accumulator into rows[-6].map —
    // undefined.map, the same TypeError banner — and 99 must not mint a review out of thin air.
    for (const forged of ["-7", "99"]) {
      const bent = await call(press(`sp:maps:obs:${key}:${forged}:`, { values: ["0"] }));
      assert.ok(!/failed:/.test(content(bent)), `no failure banner for counter ${forged}`);
      assert.match(content(bent), /went stale/);
    }

    // Digits past the grid render as placeholders on the review, and Apply's own live-grid
    // guard still refuses — nothing reaches the game.
    const weird = await call(press(`sp:maps:obs:${key}:4:9999`, { values: ["9"] }));
    assert.ok(!/failed:/.test(content(weird)), "no failure banner on the review either");
    assert.match(content(weird), /review/);
    const applied = await call(press(`sp:maps:oba:${key}:99999`));
    assert.match(content(applied), /grid changed under the walk/);
    assert.equal(fake.sectorLayout, null, "nothing reached the game");
  } finally {
    fake.close();
  }
});

test("Vietnam-shaped digit options wear their taught names in the sector walk", async () => {
  const { repo } = await createIsolatedRepository();
  const { fake, server, key } = await liveServer(repo);
  try {
    await staffAccount(repo, [
      { capability: "server.view", level: "read" },
      { capability: "maps.next", scopeId: server.id },
    ]);
    // What Vietnam's wire actually answers: bare digits, no names.
    fake.objectiveRows = [
      ["0", "1", "2"], ["0", "1", "2"], ["0", "1", "2"], ["0", "1", "2"], ["0", "1", "2"],
    ];
    // The taught layer, keyed by the map family the session names.
    await repo.objectivePoints.set("hll", "carentan", 0, 0, { name: "Convoy Ambush" });
    const call = caller(repo);

    await call(press(`sp:maps:ob:${key}`));
    // Picking the taught option shows its NAME on the walk…
    const s2 = await call(press(`sp:maps:obs:${key}:0:`, { values: ["0"] }));
    assert.match(content(s2), /Sector 1: Convoy Ambush/);
    // …and an untaught digit still reads as an honest placeholder, never a bare "1".
    const s3 = await call(press(`sp:maps:obs:${key}:1:0`, { values: ["1"] }));
    assert.match(content(s3), /Sector 2: Option 2/);
  } finally {
    fake.close();
  }
});

test("a Vietnam apply saves per-map and the confirmation speaks taught names, not wire digits", async () => {
  const { repo } = await createIsolatedRepository();
  const fake = new FakeHllServer("pw");
  fake.session = { mapName: "VAN TUONG", mapId: "vantuong_warfare", playerCount: 20 };
  fake.objectiveRows = [
    ["0", "1", "2"], ["0", "1", "2"], ["0", "1", "2"], ["0", "1", "2"], ["0", "1", "2"],
  ];
  const port = await fake.listen();
  const server = await repo.servers.create({ name: "NAM #1", game: "hllv", host: "127.0.0.1", port, password: "pw", engagementMode: "active" });
  const key = server.id.replaceAll("-", "").slice(0, 8);
  try {
    await staffAccount(repo, [
      { capability: "server.view", level: "read" },
      { capability: "maps.next", scopeId: server.id },
    ]);
    await repo.objectivePoints.set("hllv", "vantuong", 0, 1, { name: "Hilltop Radio" });
    const call = caller(repo);

    // The review's apply control on Vietnam is a SELECT: the value is how long the layout
    // stands. "3" = our worker clears it after the third play of the map.
    const applied = await call(press(`sp:maps:oba:${key}:10201`, { values: ["3"] }));
    // The confirmation is the review screen's language: taught names for the digit wires, and
    // "saved", because that is what Vietnam DID — the old line echoed "1 / 0 / 2 / 0 / 1".
    assert.match(content(applied), /✅ Layout saved for the next 3 play\(s\) of this map: Hilltop Radio \/ Option 1 \/ Option 3 \/ Option 1 \/ Option 2/);
    // And the store proves the hllv wire carried the MapId from this surface too.
    assert.deepEqual(fake.storedLayouts.get("vantuong_warfare"), [1, 0, 2, 0, 1]);
    // The countdown row exists, pinned so the round already running is never counted.
    const expiry = await repo.layoutExpiries.get(server.id, "vantuong_warfare");
    assert.equal(expiry?.playsLeft, 3);
    // The hub the confirmation lands on SHOWS the standing layout — the panel's saved line has
    // a Discord twin now, so the Clear door below it is never a button into the dark.
    assert.match(content(applied), /Saved objective layout \(current map\):\*\* standing — next 3 play\(s\), then back to random/);
    // The hub offers the exit alongside the entrance — Vietnam only.
    assert.ok(allIds(applied).includes(`sp:maps:obc:${key}`), "the Vietnam hub has the clear-layout door");

    // Consent first (no game dialed yet), then the press that clears.
    const consent = await call(press(`sp:maps:obc:${key}`));
    assert.match(content(consent), /forgets the objectives stored for the CURRENT map/);
    assert.ok(allIds(consent).includes(`sp:maps:obcy:${key}`));
    const cleared = await call(press(`sp:maps:obcy:${key}`));
    assert.match(content(cleared), /✅ Saved layout cleared for/);
    assert.equal(fake.storedLayouts.size, 0, "RemoveSectorLayout reached the game");
    const trail = await repo.audit.list({ actions: ["map.objectives"], limit: 5 });
    assert.ok(trail.some((r) => (r.data as { cleared?: boolean })?.cleared === true), "the clear is on the audit trail");
  } finally {
    fake.close();
  }
});
