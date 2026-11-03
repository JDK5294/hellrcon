/**
 * Registration over Discord, end to end against the fake game server (docs/vip-module.md §
 * registration): launcher press → server pick → live roster → code sent IN GAME → modal verify →
 * link + welcome bonus. Plus the guard rails: wrong codes, the lockout, and identity conflicts.
 *
 * The code the test types into the modal is read back out of the fake server's message log —
 * the same place the real player reads it. Nothing about the flow is stubbed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { createRepository } from "@app/db";
import { handleInteraction } from "../dist/discord.js";
import { PublicModuleRegistry, registerPublicModules, launcherMessage } from "../dist/discord-public.js";
import { dayBonusKey, REGISTRATION_KV_NS } from "../dist/economy.js";
import { FakeHllServer } from "./fake-hll-server.ts";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = (publicKey as KeyObject).export({ format: "der", type: "spki" }) as Buffer;
  const publicKeyHex = spki.subarray(spki.length - 32).toString("hex");
  const sign = (ts: string, body: string) => edSign(null, Buffer.from(ts + body), privateKey).toString("hex");
  return { publicKeyHex, sign };
}

/** One registration scene: a fake game with a roster, a server row pointing at it, the public
 *  registry, and a signed `call` helper that captures deferred follow-up PATCHes. */
/*
 * Roster ids are unique PER SCENE. They were fixed strings, which is fine on the in-memory store
 * (a scene builds its own repo) and quietly fatal on Postgres, where every test in the file
 * shares one database: the first test linked Alpha Wolf, and every later test met "you're
 * already linked" instead of the screen it was asserting. This file therefore had no Postgres
 * coverage at all — for the flow whose failures are the ones players actually report.
 */
let sceneSeq = 0;
async function scene() {
  const repo = await createRepository();
  const fake = new FakeHllServer("pw");
  const port = await fake.listen();
  const n = String(++sceneSeq).padStart(2, "0");
  const ALPHA = `765611980000${n}01`;
  const BRAVO = `765611980000${n}02`;
  const VN = `vn-0000-${n}01`;
  /** A Discord id that belongs to THIS scene. Same reason as the roster ids above: the literals
   *  repeat across tests, and on a shared database the second test to use one inherits the
   *  first's lockout or link instead of the clean slate it is asserting about. */
  const who = (id: string) => `${n}${id}`;
  fake.players = [
    { iD: ALPHA, name: "Alpha Wolf" },
    { iD: BRAVO, name: "Bravo Fox" },
  ];
  const server = await repo.servers.create({ name: "Reg Test #1", game: "hll", protocol: "binary-v2", host: "127.0.0.1", port, password: "pw", engagementMode: "active" } as never);
  const registry = new PublicModuleRegistry();
  registerPublicModules(registry, repo);

  const patches: { url: string; body: { content?: string; components?: unknown[] } }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    patches.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as { content?: string } });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const { publicKeyHex, sign } = keypair();
  const call = async (interaction: Record<string, unknown>) => {
    const body = JSON.stringify(interaction);
    const ts = String(Math.floor(Date.now() / 1000));
    return handleInteraction(repo, publicKeyHex, { signature: sign(ts, body), timestamp: ts }, body, { publicRegistry: registry, appId: "app9", fetchImpl });
  };
  /** The latest deferred screen: awaits the follow-up and returns what was PATCHed. */
  const deferred = async (r: Awaited<ReturnType<typeof call>>) => {
    assert.ok(r.followUp, "expected a deferred interaction");
    await r.followUp;
    return patches.at(-1)!.body;
  };
  return { repo, fake, server, call, deferred, patches, ALPHA, BRAVO, VN, who };
}

const user = (id: string) => ({ user: { id, username: `discord-${id}` } });
const press = (customId: string, discordUserId: string, ephemeral: boolean | { selected?: string[] } = true): Record<string, unknown> => {
  const opts = typeof ephemeral === "object" ? ephemeral : {};
  const eph = typeof ephemeral === "boolean" ? ephemeral : true;
  return {
    type: 3, token: "tok9",
    // `values` is how Discord reports a dropdown choice — the roster picker's payload.
    data: { custom_id: customId, ...(opts.selected ? { values: opts.selected } : {}) },
    member: user(discordUserId),
    message: { flags: eph ? 64 : 0 },
  };
};
const submit = (customId: string, values: Record<string, string>, discordUserId: string): Record<string, unknown> => ({
  type: 5, token: "tok9",
  data: { custom_id: customId, components: Object.entries(values).map(([id, value]) => ({ components: [{ custom_id: id, value }] })) },
  member: user(discordUserId), message: { flags: 64 },
});

type RosterOption = { label: string; value: string; description?: string };
/** A roster option found by NAME — the way a person finds themselves; the value is opaque. */
function rosterOption(view: { components?: unknown[] }, name: string): RosterOption {
  const select = ((view.components ?? []) as { components: { type: number; options?: RosterOption[] }[] }[])
    .flatMap((r) => r.components).find((c) => c.type === 3);
  const option = select?.options?.find((o) => o.label === name);
  assert.ok(option, `${name} is on the roster`);
  return option!;
}
/** A button's custom_id on a rendered screen, found by its label. */
function buttonId(view: { components?: unknown[] }, label: string): string {
  const button = ((view.components ?? []) as { components: { label?: string; custom_id: string }[] }[])
    .flatMap((r) => r.components).find((c) => c.label === label);
  assert.ok(button, `the screen has ${label}`);
  return button!.custom_id;
}

/** Walk the flow up to "code sent" and return the code from the fake's in-game message log. */
async function sendCodeTo(s: Awaited<ReturnType<typeof scene>>, discordId: string, platformId: string) {
  const roster = await s.deferred(await s.call(press(`pp:vip:roster:${s.server.id}:0`, discordId)));
  assert.match(roster.content!, /Pick yourself/);
  const name = s.fake.players.find((p) => p.iD === platformId)!.name;
  const sent = await s.deferred(await s.call(press(`pp:vip:pick:${s.server.id}`, discordId, { selected: [rosterOption(roster, name).value] })));
  // The LAST message to that player — the same platform id can receive several codes in one
  // test (two Discord users racing over one game account is exactly the conflict scenario).
  const msg = s.fake.messages.filter((m) => m.playerId === platformId).at(-1);
  assert.ok(msg, "the code went to the picked player, in game");
  return { sent, code: /(\d{6})/.exec(msg!.message)![1]! };
}

test("the public launcher opens a NEW ephemeral panel — never edits the shared message", async () => {
  const s = await scene();
  try {
    // The permanent launcher's button id is static and matches what the flow dispatches on.
    const launcherId = ((launcherMessage().components[0] as { components: { custom_id: string }[] }).components[0]!).custom_id;
    assert.equal(launcherId, "pp:vip::");
    const r = await s.call(press("pp:vip::", "500100200", false)); // pressed on the PUBLIC message
    const body = r.body as { type: number; data: { flags?: number; content: string } };
    assert.equal(body.type, 4, "a new message, not an update of the launcher");
    assert.equal(body.data.flags, 64, "and it is ephemeral");
    // Unlinked still gets a REAL panel — balance and all — not a locked door. That is the whole
    // point: points belong to the Discord account, and hiding them behind a link was a defect.
    assert.match(body.data.content, /Not linked yet/);
    assert.match(body.data.content, /Balance:/);
    // The same root press from the user's own ephemeral panel updates in place.
    const again = await s.call(press("pp:vip::", "500100200", true));
    assert.equal((again.body as { type: number }).type, 7);
  } finally {
    s.fake.close();
  }
});

test("registration end to end: roster → in-game code → modal verify → link + welcome bonus", async () => {
  const s = await scene();
  try {
    await s.repo.economy.setConfig({ registration: { bonusDays: 0, bonusPoints: 150, bonusAllGames: false } });
    const discordId = s.who("600100200300");

    // Link → the server picker names the server.
    const pick = await s.call(press("pp:vip:link:", discordId));
    assert.match((pick.body as { data: { content: string } }).data.content, /Which server/);

    // Roster (deferred: a real RCON read) → both fake players offered; the code goes in game.
    const { sent, code } = await sendCodeTo(s, discordId, s.ALPHA);
    assert.match(sent.content!, /Alpha Wolf/);

    // "Enter code" opens a modal IMMEDIATELY (a modal cannot follow a defer).
    const modal = await s.call(press("pp:vip:codem:", discordId));
    assert.equal((modal.body as { type: number }).type, 9);
    assert.equal(((modal.body as { data: { custom_id: string } }).data).custom_id, "pp:vip:verify:");

    // A wrong code burns an attempt and says so.
    const wrong = await s.deferred(await s.call(submit("pp:vip:verify:", { code: "000000" }, discordId)));
    assert.match(wrong.content!, /2 tries left/);

    // The right code writes the link, ensures the member, pays the once-ever welcome, audits.
    const done = await s.deferred(await s.call(submit("pp:vip:verify:", { code }, discordId)));
    assert.match(done.content!, /Linked! You are \*\*Alpha Wolf\*\*/);
    assert.match(done.content!, /150 Points/);
    const linked = await s.repo.externalLinks.findPlayers("discord", discordId);
    assert.equal(linked.length, 1);
    assert.equal(linked[0]!.platformId, s.ALPHA);
    assert.equal((await s.repo.economy.member(discordId))?.balance, 150);
    assert.ok((await s.repo.audit.list({})).some((a) => a.action === "player.link" && a.actorName === "registration"));

    // The root now knows them — and a replayed verify (stale modal) cannot double-pay.
    const root = await s.call(press("pp:vip::", discordId));
    assert.match((root.body as { data: { content: string } }).data.content, /Linked: \*\*Alpha Wolf\*\*/);
    const replay = await s.deferred(await s.call(submit("pp:vip:verify:", { code }, discordId)));
    assert.match(replay.content!, /no code waiting/);
    assert.equal((await s.repo.economy.member(discordId))?.balance, 150, "welcome paid exactly once");

    // A spent challenge is FORGOTTEN, not blanked. It used to be "cleared" by writing {} over it,
    // so the store kept one dead row per player who ever linked — growth with nothing to read it.
    assert.equal(await s.repo.pluginKv.get("vip-registration", discordId), undefined,
      "the finished challenge left nothing behind");
  } finally {
    s.fake.close();
  }
});

test("three wrong codes lock the flow, and the lockout survives a fresh code request", async () => {
  const s = await scene();
  try {
    const discordId = s.who("700100200300");
    const { code } = await sendCodeTo(s, discordId, s.BRAVO);
    for (const expect of [/2 tries left/, /1 try left/, /locked/]) {
      const r = await s.deferred(await s.call(submit("pp:vip:verify:", { code: "999999" }, discordId)));
      assert.match(r.content!, expect);
    }
    // Locked means locked — a new code request is refused too, pointing at staff.
    const again = await s.deferred(await s.call(press(`pp:vip:code:${s.server.id}:${s.BRAVO}`, discordId)));
    assert.match(again.content!, /locked/);
    // And the burned code is gone for good.
    assert.equal((await s.repo.externalLinks.findPlayers("discord", discordId)).length, 0);
    void code;
  } finally {
    s.fake.close();
  }
});

test("identity conflicts refuse instead of overwriting: a claimed player stays claimed", async () => {
  const s = await scene();
  try {
    // First user links Alpha Wolf the honest way.
    const first = s.who("800100200300");
    const a = await sendCodeTo(s, first, s.ALPHA);
    void a.sent;
    await s.deferred(await s.call(submit("pp:vip:verify:", { code: a.code }, first)));
    assert.equal((await s.repo.externalLinks.findPlayers("discord", first)).length, 1);

    /*
     * A second Discord user picks the SAME, already-registered player.
     *
     * This must be refused BEFORE the game hears about it. It used to be allowed: the code went
     * out, the registered player got an admin message in their chat for a registration they never
     * started, and the attempt only failed later at verify — where only the sender saw it. One
     * account per game is supposed to mean the holder is then left alone, and this is the assertion
     * that makes that true. A registered player is not a button anyone else can press.
     */
    const second = s.who("900100200300");
    const quiet = s.fake.messages.length;
    await s.deferred(await s.call(press(`pp:vip:roster:${s.server.id}:0`, second)));
    const blocked = await s.deferred(await s.call(press(`pp:vip:code:${s.server.id}:${s.ALPHA}`, second)));
    assert.match(blocked.content!, /already registered to a Discord account/);
    assert.equal(s.fake.messages.length, quiet, "the registered player was never messaged in game");
    assert.equal((await s.repo.externalLinks.findPlayers("discord", second)).length, 0);
    const holder = await s.repo.externalLinks.findPlayers("discord", first);
    assert.equal(holder[0]!.platformId, s.ALPHA, "the original link stands");

    // And a user who IS linked cannot even request a code for this game any more — the send
    // refuses BEFORE anything reaches the game. That ordering is the anti-spam property itself:
    // without it, anyone could pick a registered player off the roster and ping them in game
    // over and over from the panel.
    const before = s.fake.messages.length;
    const refused2 = await s.deferred(await s.call(press(`pp:vip:code:${s.server.id}:${s.BRAVO}`, first)));
    assert.match(refused2.content!, /already linked for \*\*Hell Let Loose\*\* as \*\*Alpha Wolf\*\*/);
    assert.equal(s.fake.messages.length, before, "no in-game message went out");
  } finally {
    s.fake.close();
  }
});

/*
 * "Who made my game tell me to enter a code?"
 *
 * The player-facing line carries no Discord name on purpose — a name in that message would let
 * anyone print arbitrary text into another player's chat. So the accountability lives in the trail
 * instead, and a staff member asked that question has to be able to answer it from the panel.
 */
test("every code send is on the record, naming the Discord account that asked for it", async () => {
  const s = await scene();
  try {
    const asker = s.who("700100200300");
    await sendCodeTo(s, asker, s.BRAVO);

    const entry = (await s.repo.audit.list({})).find((a) => a.action === "player.link.code");
    assert.ok(entry, "the send is audited");
    assert.equal(entry!.targetName, "Bravo Fox", "against the player who got messaged");
    assert.equal(entry!.serverId, s.server.id, "on the server it was sent to");
    assert.equal((entry!.data as { discordId?: string }).discordId, asker, "and names who asked");
    assert.match(entry!.summary, /requested by Discord/);
    // The code itself is a secret: the trail records that a send happened, never what was sent.
    const msg = s.fake.messages.filter((m) => m.playerId === s.BRAVO).at(-1)!;
    const code = /(\d{6})/.exec(msg.message)![1]!;
    assert.ok(!JSON.stringify(entry).includes(code), "the code never reaches the audit trail");
  } finally {
    s.fake.close();
  }
});

test("the search modal filters the roster; resends are rate-limited", async () => {
  const s = await scene();
  try {
    const discordId = s.who("110100200300");
    // Search opens instantly (modal), the submit re-reads the roster filtered.
    const modal = await s.call(press(`pp:vip:searchm:${s.server.id}`, discordId));
    assert.equal((modal.body as { type: number }).type, 9);
    const filtered = await s.deferred(await s.call(submit(`pp:vip:search:${s.server.id}`, { q: "bravo" }, discordId)));
    assert.match(filtered.content!, /matching "bravo"/);
    assert.match(filtered.content!, /1 player/);

    // A second code inside the cooldown does not send again — one in-game ping per minute.
    await sendCodeTo(s, discordId, s.BRAVO);
    const before = s.fake.messages.length;
    const again = await s.deferred(await s.call(press(`pp:vip:code:${s.server.id}:${s.BRAVO}`, discordId)));
    assert.match(again.content!, /less than a minute/);
    assert.equal(s.fake.messages.length, before, "no second in-game message");
  } finally {
    s.fake.close();
  }
});

/*
 * A full server must not strand you on page 1.
 *
 * The first cut of this picker drew one BUTTON per name — 20 of them, four rows — and then the
 * renderer, which reserves a row for "‹ Menu", silently sliced the fifth row off. That row held
 * Previous, Next and the search. The result rendered perfectly and was a dead end: "page 1/5"
 * with no way to reach page 2 and no way to search, which is exactly how it shipped.
 *
 * So the assertion is not "the code builds a nav row" — it is that the nav SURVIVES rendering,
 * checked against the component JSON Discord would actually receive.
 */
test("a full roster stays navigable: the picker is a dropdown, and paging survives rendering", async () => {
  const s = await scene();
  try {
    // 98 players, the size that broke it in production.
    s.fake.players = Array.from({ length: 98 }, (_, i) => ({
      iD: `7656119800000${String(i).padStart(4, "0")}`,
      name: `Player ${String(i).padStart(3, "0")}`,
    }));
    const view = await s.deferred(await s.call(press(`pp:vip:roster:${s.server.id}:0`, s.who("660100200300"))));
    const rows = (view.components ?? []) as { components: { type: number; custom_id: string; options?: unknown[]; disabled?: boolean }[] }[];
    const all = rows.flatMap((r) => r.components);

    // The names are a select (type 3), not 20 buttons — one row, 25 options, Discord's ceiling.
    const select = all.find((c) => c.type === 3);
    assert.ok(select, "the roster is a dropdown");
    assert.equal(select!.options!.length, 25);
    assert.equal(select!.custom_id, `pp:vip:pick:${s.server.id}`);

    // And the things that make 98 names usable are all actually present in the payload.
    const ids = all.map((c) => c.custom_id);
    assert.ok(ids.includes(`pp:vip:searchm:${s.server.id}`), "Find my name survived rendering");
    assert.ok(ids.includes(`pp:vip:roster:${s.server.id}:1`), "Next survived rendering");
    assert.ok(ids.some((i) => i === "pp:vip::"), "and the Menu row is still there");
    assert.match(view.content!, /page 1\/4/);

    // Picking from the dropdown sends the code to THAT player, exactly as the buttons did.
    const chosen = await s.deferred(await s.call(press(`pp:vip:pick:${s.server.id}`, s.who("660100200300"), { selected: [rosterOption(view, "Player 012").value] })));
    assert.match(chosen.content!, /Player 012/);
    assert.equal(s.fake.messages.at(-1)!.playerId, "76561198000000012", "the in-game code went to the picked player");
  } finally {
    s.fake.close();
  }
});

/*
 * Pressing Next actually reaches page 2.
 *
 * The test above rendered page 1 and stopped there, which is exactly why this shipped broken: on
 * page 1 the ids happen to be unique ("‹ Previous" is page −1), and only from page 2 onward did
 * "Refresh list" and "‹ Previous" both become `roster:<id>:0`. Discord rejects a message carrying
 * the same custom_id twice, so the edit never landed and the panel sat on page 1 forever — with 95
 * players, most of the server could not find themselves.
 *
 * So this walks the pages the way a person does, and checks the ids are unique on each.
 */
test("pressing Next moves through the roster, and no page repeats a custom_id", async () => {
  const s = await scene();
  try {
    s.fake.players = Array.from({ length: 98 }, (_, i) => ({
      iD: `7656119800000${String(i).padStart(4, "0")}`,
      name: `Player ${String(i).padStart(3, "0")}`,
    }));
    const idsOf = (view: { components?: unknown[] }) =>
      ((view.components ?? []) as { components: { custom_id: string }[] }[]).flatMap((r) => r.components).map((c) => c.custom_id);

    const seenFirst: string[] = [];
    for (let page = 0; page < 4; page++) {
      const view = await s.deferred(await s.call(press(`pp:vip:roster:${s.server.id}:${page}`, s.who("670100200300"))));
      assert.match(view.content!, new RegExp(`page ${page + 1}/4`), `page ${page + 1} rendered`);
      const ids = idsOf(view);
      assert.equal(new Set(ids).size, ids.length, `page ${page + 1} has no duplicate custom_id: ${ids.join(", ")}`);
      // Each page offers its own 25 names, so paging is actually reaching new people.
      const select = ((view.components ?? []) as { components: { type: number; options?: { value: string }[] }[] }[])
        .flatMap((r) => r.components).find((c) => c.type === 3)!;
      const first = select.options![0]!.value;
      assert.ok(!seenFirst.includes(first), `page ${page + 1} starts somewhere new`);
      seenFirst.push(first);
    }

    // Page 4 of 4 is the end: Next is there but disabled, rather than promising a page that isn't.
    const last = await s.deferred(await s.call(press(`pp:vip:roster:${s.server.id}:3`, s.who("670100200300"))));
    const nextBtn = ((last.components ?? []) as { components: { custom_id: string; disabled?: boolean }[] }[])
      .flatMap((r) => r.components).find((c) => c.custom_id.endsWith(":4"));
    assert.ok(nextBtn?.disabled, "Next is disabled on the last page");
  } finally {
    s.fake.close();
  }
});

/*
 * A search shows what it found and offers a way back — never a pager that would silently drop it.
 * The filter is not carried in the button id, so a Next inside a search would return the full
 * roster; and the button that DOES mean "show everyone" must not collide with anything else.
 */
test("a search narrows the list, keeps its ids unique, and offers the way back to everyone", async () => {
  const s = await scene();
  try {
    s.fake.players = Array.from({ length: 98 }, (_, i) => ({
      iD: `7656119800000${String(i).padStart(4, "0")}`,
      name: `Player ${String(i).padStart(3, "0")}`,
    }));
    const found = await s.deferred(await s.call(submit(`pp:vip:search:${s.server.id}`, { q: "Player 04" }, s.who("680100200300"))));
    const rows = (found.components ?? []) as { components: { type: number; custom_id: string; options?: unknown[] }[] }[];
    const all = rows.flatMap((r) => r.components);
    const ids = all.map((c) => c.custom_id);

    assert.equal(new Set(ids).size, ids.length, `a search page repeats no custom_id: ${ids.join(", ")}`);
    assert.equal(all.find((c) => c.type === 3)!.options!.length, 10, "Player 040..049 matched");
    assert.ok(ids.includes(`pp:vip:roster:${s.server.id}:0`), "the way back to the whole roster is offered");
    assert.ok(!ids.some((i) => i.endsWith(":1")), "and no pager that would throw the search away");
  } finally {
    s.fake.close();
  }
});

/*
 * One linked account PER GAME — the rule the conflict guard actually means.
 *
 * HLL: Vietnam issues different player ids from HLL, so a member who plays both holds two game
 * accounts, and a Discord VIP purchase can only land on both games' servers if BOTH are linked to
 * the one Discord. The guard used to treat any second linked player as a conflict, which made the
 * WW2 link everyone already has a permanent bar to registering their Vietnam account.
 */
test("a member linked on WW2 can register their Vietnam account, and both links stand", async () => {
  const s = await scene();
  try {
    const discordId = s.who("700100200300");
    // Link the WW2 account the honest way.
    const a = await sendCodeTo(s, discordId, s.ALPHA);
    await s.deferred(await s.call(submit("pp:vip:verify:", { code: a.code }, discordId)));
    assert.equal((await s.repo.externalLinks.findPlayers("discord", discordId)).length, 1);

    // The Vietnam server: same fake (the wire protocol is identical), its own server row under
    // hllv, and an id from Vietnam's own namespace on the roster.
    s.fake.players.push({ iD: s.VN, name: "Alpha Wolf (VN)" } as never);
    const vn = await s.repo.servers.create({ name: "Reg Test VN", game: "hllv", protocol: "binary-v2", host: "127.0.0.1", port: s.server.port, password: "pw", engagementMode: "active" } as never);

    // Register the Vietnam account with the WW2 link already in place — this used to refuse.
    await s.deferred(await s.call(press(`pp:vip:roster:${vn.id}:0`, discordId)));
    await s.deferred(await s.call(press(`pp:vip:code:${vn.id}:${s.VN}`, discordId)));
    const code = /\b(\d{6})\b/.exec(s.fake.messages.filter((m) => m.playerId === s.VN).at(-1)!.message)![1]!;
    const done = await s.deferred(await s.call(submit("pp:vip:verify:", { code }, discordId)));
    assert.doesNotMatch(done.content ?? "", /already linked/i);

    // Both accounts now answer to the one Discord, each filed under its own game.
    const held = await s.repo.externalLinks.findPlayers("discord", discordId);
    assert.deepEqual(held.map((h) => [h.game, h.platformId]).sort(), [["hll", s.ALPHA], ["hllv", s.VN]]);

    // And a SECOND Vietnam account still refuses — per game, not per member, is the rule. The
    // refusal now lands at the roster AND at the code send, before anything reaches the game:
    // a registered game is closed until staff clear the link, not merely failed at verify.
    s.fake.players.push({ iD: "vn-0000-2202", name: "Someone Else" } as never);
    const rosterRefused = await s.deferred(await s.call(press(`pp:vip:roster:${vn.id}:0`, discordId)));
    assert.match(rosterRefused.content!, /already linked for \*\*Hell Let Loose: Vietnam\*\*/);
    const before = s.fake.messages.length;
    const codeRefused = await s.deferred(await s.call(press(`pp:vip:code:${vn.id}:vn-0000-2202`, discordId)));
    assert.match(codeRefused.content!, /already linked/i);
    assert.equal(s.fake.messages.length, before, "no code was messaged in game");
    // Their WW2 server, meanwhile, is spent too — and the server PICKER no longer offers either.
    const picker = await s.call(press("pp:vip:link:", discordId));
    assert.match((picker.body as { data: { content: string } }).data.content, /already registered for every game/);
  } finally {
    s.fake.close();
  }
});

/*
 * The welcome bonus lands only on the linked account's OWN game.
 *
 * The bonus days used to be granted on EVERY server with the one just-linked row — including the
 * other game's, where that row's id is one the server accepts and applies to nobody, leaving a
 * dead VIP row stored under an id the game can never act on.
 */
test("welcome bonus days reach the linked game's servers and never the other game's", async () => {
  const s = await scene();
  try {
    await s.repo.economy.setConfig({ registration: { bonusDays: 7, bonusPoints: 0, bonusAllGames: false } });
    // A Vietnam server row beside the WW2 one — same fake listener, the wire is identical.
    const vn = await s.repo.servers.create({ name: "Bonus VN", game: "hllv", protocol: "binary-v2", host: "127.0.0.1", port: s.server.port, password: "pw", engagementMode: "active" } as never);

    const { applyWelcomeBonus } = await import("../dist/discord-public.js");
    const player = await s.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000901", name: "Bonus Target" });
    const bits = await applyWelcomeBonus(s.repo, s.who("700100200300"), player);
    assert.equal(bits.length, 1, "the days were paid");

    assert.ok(await s.repo.vips.get(s.server.id, "76561198000000901"), "the WW2 grant landed");
    assert.equal(await s.repo.vips.get(vn.id, "76561198000000901"), null,
      "no dead grant row on the Vietnam server — its game cannot act on a WW2 id");
  } finally {
    s.fake.close();
  }
});

test("two registrations landing together pay the welcome VIP days once", async () => {
  const s = await scene();
  try {
    await s.repo.economy.setConfig({ registration: { bonusDays: 7, bonusPoints: 0, bonusAllGames: false } });
    const { applyWelcomeBonus } = await import("../dist/discord-public.js");
    const player = await s.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000911", name: "Double Press" });
    const who = s.who("700100200311");
    const [a, b] = await Promise.all([applyWelcomeBonus(s.repo, who, player), applyWelcomeBonus(s.repo, who, player)]);
    assert.equal(a.length + b.length, 1, "one of the two paid the days, the other walked away");
    const days = (Date.parse((await s.repo.vips.get(s.server.id, player.platformId))!.expiration!) - Date.now()) / 86_400_000;
    assert.ok(days > 6.9 && days < 7.1, `one welcome week, not two (got ${days.toFixed(2)} days)`);
  } finally {
    s.fake.close();
  }
});

/*
 * The all-games welcome switch — default off, and when ON it still never guesses an id.
 *
 * Each game's servers get the days with the member's linked account FOR THAT GAME; a game they
 * have not linked is skipped entirely, because its servers have no id of theirs to grant to.
 */
test("bonusAllGames grants each game with its own linked account, and skips unlinked games", async () => {
  const s = await scene();
  try {
    await s.repo.economy.setConfig({ registration: { bonusDays: 7, bonusPoints: 0, bonusAllGames: true } });
    const vn = await s.repo.servers.create({ name: "AllGames VN", game: "hllv", protocol: "binary-v2", host: "127.0.0.1", port: s.server.port, password: "pw", engagementMode: "active" } as never);
    const { applyWelcomeBonus } = await import("../dist/discord-public.js");

    // Member A holds BOTH games' accounts before the bonus fires (staff finishing a link late).
    const aWw2 = await s.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000801", name: "Both WW2" });
    const aVn = await s.repo.players.upsert({ game: "hllv", platform: "steam", platformId: "0002a-vn-801", name: "Both VN" });
    await s.repo.externalLinks.set(aWw2.id, "discord", s.who("800100200300"), "registration");
    await s.repo.externalLinks.set(aVn.id, "discord", s.who("800100200300"), "registration");
    await applyWelcomeBonus(s.repo, s.who("800100200300"), aWw2);
    assert.ok(await s.repo.vips.get(s.server.id, "76561198000000801"), "WW2 days under the WW2 id");
    assert.ok(await s.repo.vips.get(vn.id, "0002a-vn-801"), "Vietnam days under the VIETNAM id — never the WW2 one");
    assert.equal(await s.repo.vips.get(vn.id, "76561198000000801"), null, "no cross-game id anywhere");

    // Member B has only the WW2 account: the Vietnam server is skipped, not guessed at.
    const bWw2 = await s.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000802", name: "Solo WW2" });
    await s.repo.externalLinks.set(bWw2.id, "discord", s.who("800100200400"), "registration");
    await applyWelcomeBonus(s.repo, s.who("800100200400"), bWw2);
    assert.ok(await s.repo.vips.get(s.server.id, "76561198000000802"));
    assert.equal(await s.repo.vips.get(vn.id, "76561198000000802"), null, "unlinked game skipped");
  } finally {
    s.fake.close();
  }
});

/*
 * A welcome bonus is spent by landing, not by being attempted.
 *
 * The "already paid" flag used to be written BEFORE the grants ran. Register while the game server
 * is down — or read-only, or mid-restart — and the welcome VIP was marked paid without a day of it
 * reaching anybody, with no expiry on the flag and no repair path anywhere: the member simply never
 * got what they were promised, and nothing said so.
 */
test("a welcome bonus that reaches no server is not marked paid — the next attempt pays it", async () => {
  const s = await scene();
  try {
    await s.repo.economy.setConfig({ registration: { bonusDays: 7, bonusPoints: 0, bonusAllGames: false } });
    const { applyWelcomeBonus } = await import("../dist/discord-public.js");
    const discordId = s.who("700100200500");
    const platformId = "76561198000000903";
    const player = await s.repo.players.upsert({ game: "hll", platform: "steam", platformId, name: "Bonus Deferred" });

    // Read-only is what an unreachable game looks like to the grant: it refuses, nothing lands.
    await s.repo.servers.setEngagementMode(s.server.id, "observe");
    assert.deepEqual(await applyWelcomeBonus(s.repo, discordId, player), [], "nothing was paid");
    assert.equal(await s.repo.vips.get(s.server.id, platformId), null);
    assert.ok(!(await s.repo.pluginKv.get(REGISTRATION_KV_NS, dayBonusKey(discordId))), "and nothing was marked paid");

    // The server comes back: the next attempt pays it in full, and only then spends the flag.
    await s.repo.servers.setEngagementMode(s.server.id, "active");
    assert.equal((await applyWelcomeBonus(s.repo, discordId, player)).length, 1, "the days were paid");
    assert.ok(await s.repo.vips.get(s.server.id, platformId), "and landed in game");
    assert.equal(await s.repo.pluginKv.get(REGISTRATION_KV_NS, dayBonusKey(discordId)), true);
    // Once per Discord account still holds — a third call pays nothing.
    assert.deepEqual(await applyWelcomeBonus(s.repo, discordId, player), []);
  } finally {
    s.fake.close();
  }
});

/*
 * The link button tracks per-game registration state.
 *
 * It is there while ANY listed game is still open for this member, and gone only when every game
 * with a server is registered — its absence is how a fully linked member learns the job is done,
 * and its presence is what lets the WW2 veteran register their new Vietnam account.
 */
test("the root's link button stays while a game is open and disappears when every game is linked", async () => {
  const s = await scene();
  try {
    const discordId = s.who("550100200300");
    const vn = await s.repo.servers.create({ name: "Gate VN", game: "hllv", protocol: "binary-v2", host: "127.0.0.1", port: s.server.port, password: "pw", engagementMode: "active" } as never);
    void vn;
    const rootIds = async () => {
      const r = await s.call(press("pp:vip::", discordId));
      return ((r.body as { data: { components: { components: { custom_id: string }[] }[] } }).data.components ?? [])
        .flatMap((row) => row.components.map((c) => c.custom_id));
    };

    // Nothing linked: the primary "Link my game account" is there.
    assert.ok((await rootIds()).includes("pp:vip:link:"), "unlinked members are invited to link");

    // WW2 linked, Vietnam open: still there ("Link another account").
    const ww2 = await s.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000501", name: "Gate WW2" });
    await s.repo.externalLinks.set(ww2.id, "discord", discordId, "registration");
    assert.ok((await rootIds()).includes("pp:vip:link:"), "a second game still needs registering");
    // …and the labels per game appear once there is more than one game to tell apart.
    const labelled = await s.call(press("pp:vip::", discordId));
    assert.match((labelled.body as { data: { content: string } }).data.content, /\*\*Gate WW2\*\* \(Hell Let Loose\)/);

    // Both games linked: the button is gone, and the History/Refresh row survives.
    const vnAcct = await s.repo.players.upsert({ game: "hllv", platform: "steam", platformId: "vn-gate-501", name: "Gate VN Acct" });
    await s.repo.externalLinks.set(vnAcct.id, "discord", discordId, "registration");
    const ids = await rootIds();
    assert.ok(!ids.includes("pp:vip:link:"), "registered for every game = nothing left to register");
    assert.ok(ids.includes("pp:vip:history:0") && ids.some((i) => i === "pp:vip::"), "the rest of the row still renders");
  } finally {
    s.fake.close();
  }
});

/*
 * Staff choose which servers a member may register on.
 *
 * A server can exist and still not be open to registration — a test box, an event server, a game
 * mid-setup. The picker offers only what staff listed, and because the panel is stateless the
 * roster and code steps refuse a withheld server on their own: a button pressed from a panel that
 * was open before the restriction must land on the same answer as the screen would now show.
 *
 * The subtle half is the ROOT: if a member's only unregistered game has no open server, the link
 * button must not be drawn at all, or it invites them to a picker with nothing on it.
 */
test("registration servers: the picker offers only what staff listed, and withheld servers refuse", async () => {
  const s = await scene();
  try {
    const discordId = s.who("570100200300");
    const vn = await s.repo.servers.create({ name: "Closed VN", game: "hllv", protocol: "binary-v2", host: "127.0.0.1", port: s.server.port, password: "pw", engagementMode: "active" } as never);
    s.fake.players.push({ iD: "vn-closed-1", name: "Nam Player" } as never);
    const rootIds = async () => {
      const r = await s.call(press("pp:vip::", discordId));
      return ((r.body as { data: { components: { components: { custom_id: string }[] }[] } }).data.components ?? [])
        .flatMap((row) => row.components.map((c) => c.custom_id));
    };
    const pickerIds = async () => {
      const r = await s.call(press("pp:vip:link:", discordId));
      return ((r.body as { data: { components?: { components: { custom_id: string }[] }[] } }).data.components ?? [])
        .flatMap((row) => row.components.map((c) => c.custom_id));
    };

    // Unrestricted (the default): both of THIS scene's servers are offered. A containment check
    // rather than an exact list — on a shared database the picker legitimately also lists servers
    // other tests created, and asserting the whole list would be asserting the database's history
    // rather than this rule.
    const unrestricted = (await pickerIds()).filter((i) => i.startsWith("pp:vip:roster:"));
    for (const id of [s.server.id, vn.id]) {
      assert.ok(unrestricted.includes(`pp:vip:roster:${id}:0`), `empty list means every server (missing ${id})`);
    }

    // Staff open registration on WW2 only.
    await s.repo.economy.setConfig({ registration: { bonusDays: 0, bonusPoints: 0, bonusAllGames: false, gameRoles: {}, serverIds: [s.server.id] } });
    assert.deepEqual((await pickerIds()).filter((i) => i.startsWith("pp:vip:roster:")),
      [`pp:vip:roster:${s.server.id}:0`], "only the listed server is offered");

    // The withheld server refuses at the roster AND at the code send — and sends nothing in game.
    const roster = await s.deferred(await s.call(press(`pp:vip:roster:${vn.id}:0`, discordId)));
    assert.match(roster.content!, /Registration isn't open on \*\*Closed VN\*\*/);
    const before = s.fake.messages.length;
    const code = await s.deferred(await s.call(press(`pp:vip:code:${vn.id}:vn-closed-1`, discordId)));
    assert.match(code.content!, /Registration isn't open on \*\*Closed VN\*\*/);
    assert.equal(s.fake.messages.length, before, "no code was messaged to a withheld server");

    // Register the one open game. Vietnam is unlinked but has no open server, so the root must
    // stop offering the link button rather than sending them to an empty picker.
    assert.ok((await rootIds()).includes("pp:vip:link:"), "WW2 is still open, so the button is there");
    const ww2 = await s.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000571", name: "Gate WW2" });
    await s.repo.externalLinks.set(ww2.id, "discord", discordId, "registration");
    assert.ok(!(await rootIds()).includes("pp:vip:link:"), "nothing left that they can register on");
    // …and the account labels still name both games — restricting registration is not a reason to
    // stop telling a WW2 account from a Vietnam one.
    const labelled = await s.call(press("pp:vip::", discordId));
    assert.match((labelled.body as { data: { content: string } }).data.content, /\*\*Gate WW2\*\* \(Hell Let Loose\)/);

    // A list naming nothing that still exists is "closed", said plainly rather than as an empty screen.
    await s.repo.economy.setConfig({ registration: { bonusDays: 0, bonusPoints: 0, bonusAllGames: false, gameRoles: {}, serverIds: ["deleted-server-id"] } });
    const none = await s.call(press("pp:vip:link:", s.who("580100200300")));
    assert.match((none.body as { data: { content: string } }).data.content, /isn't open on any server/);
  } finally {
    s.fake.close();
  }
});

/*
 * Per-game registration roles, through the real flow.
 *
 * The economy config names a community-guild role per game; finishing a registration puts it on
 * the member, and staff clearing the link takes it back. Discord is stubbed at global fetch —
 * the interaction host's own follow-ups ride the harness's fetchImpl, so the stub sees ONLY the
 * role calls.
 */
test("verifying a link assigns the game's configured role, and unlinking removes it", async () => {
  const s = await scene();
  const { DISCORD_TOKEN } = process.env;
  process.env.DISCORD_TOKEN = "bot-tok";
  const roleCalls: { method: string; url: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    roleCalls.push({ method: init?.method ?? "GET", url: String(url) });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    await s.repo.appConfig.set({ communityGuildId: "777000777" });
    await s.repo.economy.setConfig({ registration: { bonusDays: 0, bonusPoints: 0, bonusAllGames: false, gameRoles: { hll: "888000888" } } });
    const discordId = s.who("560100200300");

    // The honest flow: roster → code → verify. The verify is what makes the link real, so the
    // role lands there and not a moment sooner.
    const { code } = await sendCodeTo(s, discordId, s.ALPHA);
    assert.equal(roleCalls.length, 0, "no role call before the link exists");
    await s.deferred(await s.call(submit("pp:vip:verify:", { code }, discordId)));
    assert.deepEqual(roleCalls.map((c) => [c.method, c.url]), [
      ["PUT", `https://discord.com/api/v10/guilds/777000777/members/${discordId}/roles/888000888`],
    ], "the WW2 role was added in the community guild");

    // Staff clear the link from the profile — the role comes off with it.
    roleCalls.length = 0;
    const player = (await s.repo.externalLinks.findPlayers("discord", discordId))[0]!;
    await s.repo.externalLinks.set(player.id, "discord", null, "staff");
    const { syncGameRoles } = await import("../dist/discord-game-roles.js");
    await syncGameRoles(s.repo, discordId);
    assert.deepEqual(roleCalls.map((c) => c.method), ["DELETE"], "unlinked = the game's role is taken back");
    assert.ok(roleCalls[0]!.url.endsWith(`/members/${discordId}/roles/888000888`));

    // And with no token the sync is silent — the link itself must never depend on Discord.
    delete process.env.DISCORD_TOKEN;
    roleCalls.length = 0;
    await syncGameRoles(s.repo, discordId);
    assert.equal(roleCalls.length, 0, "no token, no calls, no throw");
  } finally {
    globalThis.fetch = realFetch;
    if (DISCORD_TOKEN === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = DISCORD_TOKEN;
    s.fake.close();
  }
});

/*
 * PER GAME: the welcome pays once for Hell Let Loose and again for Vietnam.
 *
 * The default is once per Discord account, ever — which means a member who registers WW2 and comes
 * back months later to register Vietnam is handed nothing for the second one, with no explanation
 * available to them or to staff. `bonusPerGame` makes each game's FIRST registration pay, while
 * still refusing a second payout for a game already claimed however many of its servers exist.
 */
test("bonusPerGame pays each game once — and still never twice for the same game", async () => {
  const s = await scene();
  try {
    await s.repo.economy.setConfig({ registration: { bonusDays: 7, bonusPoints: 25, bonusAllGames: false, bonusPerGame: true } });
    const vn = await s.repo.servers.create({ name: "PerGame VN", game: "hllv", protocol: "binary-v2", host: "127.0.0.1", port: s.server.port, password: "pw", engagementMode: "active" } as never);
    const { applyWelcomeBonus } = await import("../dist/discord-public.js");
    const who = s.who("900100200300");

    // First game: paid, and only on its own servers.
    const ww2 = await s.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000701", name: "PerGame WW2" });
    assert.equal((await applyWelcomeBonus(s.repo, who, ww2)).length, 2, "points and days for the first game");
    assert.ok(await s.repo.vips.get(s.server.id, "76561198000000701"));
    assert.equal(await s.repo.vips.get(vn.id, "76561198000000701"), null, "still never a dead row on the other game");
    assert.equal((await s.repo.economy.member(who))?.balance, 25);

    // Same game again (a re-run, staff finishing what the member started): nothing.
    assert.deepEqual(await applyWelcomeBonus(s.repo, who, ww2), [], "the same game never pays twice");
    assert.equal((await s.repo.economy.member(who))?.balance, 25, "and the points did not move");

    // SECOND game: pays again — the whole point of the setting.
    const vnPlayer = await s.repo.players.upsert({ game: "hllv", platform: "steam", platformId: "0002a-vn-701", name: "PerGame VN" });
    assert.equal((await applyWelcomeBonus(s.repo, who, vnPlayer)).length, 2, "the second game is its own welcome");
    assert.ok(await s.repo.vips.get(vn.id, "0002a-vn-701"), "Vietnam days under the VIETNAM id");
    assert.equal((await s.repo.economy.member(who))?.balance, 50, "and its points landed too");
  } finally {
    s.fake.close();
  }
});

/*
 * Off (the default) is unchanged: still once per Discord account, ever.
 *
 * Worth its own test because the switch reaches the ledger ref and the kv flag alike — a slip that
 * scoped one and not the other would pay the points twice while the days stayed silent, and the
 * two halves of one welcome disagreeing is the worst possible way for this to fail.
 */
test("with bonusPerGame off, a second game linked later still collects nothing", async () => {
  const s = await scene();
  try {
    await s.repo.economy.setConfig({ registration: { bonusDays: 7, bonusPoints: 25, bonusAllGames: false, bonusPerGame: false } });
    await s.repo.servers.create({ name: "OnceOnly VN", game: "hllv", protocol: "binary-v2", host: "127.0.0.1", port: s.server.port, password: "pw", engagementMode: "active" } as never);
    const { applyWelcomeBonus } = await import("../dist/discord-public.js");
    const who = s.who("900100200400");

    const ww2 = await s.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000702", name: "Once WW2" });
    assert.equal((await applyWelcomeBonus(s.repo, who, ww2)).length, 2);
    const vnPlayer = await s.repo.players.upsert({ game: "hllv", platform: "steam", platformId: "0002a-vn-702", name: "Once VN" });
    assert.deepEqual(await applyWelcomeBonus(s.repo, who, vnPlayer), [], "spent, so the second game pays nothing");
    assert.equal((await s.repo.economy.member(who))?.balance, 25, "points paid exactly once");
  } finally {
    s.fake.close();
  }
});

test("a claim check that cannot run refuses instead of waving the registration through", async () => {
  const s = await scene();
  try {
    // Alpha Wolf is legitimately claimed by the first user.
    const first = s.who("800100200301");
    const a = await sendCodeTo(s, first, s.ALPHA);
    void a.sent;
    await s.deferred(await s.call(submit("pp:vip:verify:", { code: a.code }, first)));

    /*
     * Now the check itself breaks. "Is this player already claimed?" used to answer a flat no when
     * its lookup failed, which is the one answer that lets the thing this guard exists to prevent
     * happen: a second Discord user takes a claim on an account somebody already holds, and the
     * held player gets an admin message in game for a registration they never started.
     */
    const second = s.who("900100200301");
    await s.deferred(await s.call(press(`pp:vip:roster:${s.server.id}:0`, second)));

    const realList = s.repo.externalLinks.list.bind(s.repo.externalLinks);
    s.repo.externalLinks.list = async () => { throw new Error("database is having a moment"); };
    const quiet = s.fake.messages.length;
    let refused;
    try {
      refused = await s.deferred(await s.call(press(`pp:vip:code:${s.server.id}:${s.ALPHA}`, second)));
    } finally {
      s.repo.externalLinks.list = realList;
    }

    assert.match(refused.content!, /[Cc]ould not check/, "it says the check did not run");
    assert.doesNotMatch(refused.content!, /already registered to a Discord account/, "and does not claim a fact it never established");
    assert.equal(s.fake.messages.length, quiet, "nothing reached the game, so nobody was pinged");
    assert.equal((await s.repo.externalLinks.findPlayers("discord", second)).length, 0, "and no claim was taken");

    // The holder is untouched, and once the lookup works again the refusal stands on its merits.
    const holder = await s.repo.externalLinks.findPlayers("discord", first);
    assert.equal(holder[0]!.platformId, s.ALPHA, "the original link stands");
    const blocked = await s.deferred(await s.call(press(`pp:vip:code:${s.server.id}:${s.ALPHA}`, second)));
    assert.match(blocked.content!, /already registered to a Discord account/);
  } finally {
    s.fake.close();
  }
});

/*
 * The roster picker is a public surface — anyone in the Discord can open it — and a select's
 * option values reach the reader's client even though Discord does not draw them. It used to
 * carry every connected player's platform id twice (the value, and the line under the name).
 */
test("the roster never shows a platform id: options carry a token, the line under a name says the platform", async () => {
  const s = await scene();
  try {
    s.fake.players = [
      { iD: s.ALPHA, name: "Alpha Wolf", platform: "steam" },
      { iD: s.BRAVO, name: "Bravo Fox", platform: "EPlatformFamily::PS5" }, // the wire's enum spelling
    ];
    const discordId = s.who("610100200300");
    const roster = await s.deferred(await s.call(press(`pp:vip:roster:${s.server.id}:0`, discordId)));
    // The whole payload, not only the labels.
    const wire = JSON.stringify(roster);
    assert.ok(!wire.includes(s.ALPHA) && !wire.includes(s.BRAVO), `no platform id in the picker: ${wire}`);
    assert.equal(rosterOption(roster, "Alpha Wolf").description, "Steam (PC)");
    assert.equal(rosterOption(roster, "Bravo Fox").description, "PlayStation");

    // The token reaches the right player in game, and the screen after it carries no id either.
    const sent = await s.deferred(await s.call(press(`pp:vip:pick:${s.server.id}`, discordId, { selected: [rosterOption(roster, "Alpha Wolf").value] })));
    assert.match(sent.content!, /Alpha Wolf/);
    assert.equal(s.fake.messages.filter((m) => m.playerId === s.ALPHA).length, 1, "the code went to Alpha Wolf");
    assert.ok(!JSON.stringify(sent).includes(s.ALPHA), "Send again carries the token, not the id");

    // Send again, past the cooldown, resolves the token against the live roster: a second code.
    const c = await s.repo.pluginKv.get("vip-registration", discordId) as Record<string, unknown>;
    await s.repo.pluginKv.set("vip-registration", discordId, { ...c, lastSentAt: Date.now() - 61_000 });
    const again = await s.deferred(await s.call(press(buttonId(sent, "Send again"), discordId)));
    assert.match(again.content!, /just sent to \*\*Alpha Wolf\*\*/);
    assert.equal(s.fake.messages.filter((m) => m.playerId === s.ALPHA).length, 2, "the resend reached the same player");
  } finally {
    s.fake.close();
  }
});

test("a code button drawn before the tokens still works, and the screen it draws carries no id", async () => {
  const s = await scene();
  try {
    const discordId = s.who("650100200300");
    const sent = await s.deferred(await s.call(press(`pp:vip:code:${s.server.id}:${s.ALPHA}`, discordId)));
    assert.match(sent.content!, /just sent to \*\*Alpha Wolf\*\*/);
    assert.equal(s.fake.messages.filter((m) => m.playerId === s.ALPHA).length, 1, "the old button reached the player");
    assert.ok(!JSON.stringify(sent).includes(s.ALPHA), "Send again was re-drawn with the token");
  } finally {
    s.fake.close();
  }
});

/** Slows the registration store's reads so presses overlap the way they do over a real network. */
function slowReads(s: Awaited<ReturnType<typeof scene>>): () => void {
  const realGet = s.repo.pluginKv.get.bind(s.repo.pluginKv);
  s.repo.pluginKv.get = async (ns: string, key: string) => {
    const v = await realGet(ns, key);
    await new Promise((r) => setTimeout(r, 30));
    return v;
  };
  return () => { s.repo.pluginKv.get = realGet; };
}

/*
 * The panel acknowledges a press with "thinking" in place and the button stays pressable while
 * the game is messaged, so a double-click is two sends. Both used to go out — two codes in the
 * player's chat, and only the one saved last worked.
 */
test("a double-click on a name sends ONE code, and that code works", async () => {
  const s = await scene();
  try {
    const discordId = s.who("630100200300");
    const roster = await s.deferred(await s.call(press(`pp:vip:roster:${s.server.id}:0`, discordId)));
    const pick = press(`pp:vip:pick:${s.server.id}`, discordId, { selected: [rosterOption(roster, "Alpha Wolf").value] });
    const restore = slowReads(s);
    try {
      const both = await Promise.all([s.call(pick), s.call(pick)]);
      await Promise.all(both.map((r) => r.followUp));
    } finally {
      restore();
    }
    const sent = s.fake.messages.filter((m) => m.playerId === s.ALPHA);
    assert.equal(sent.length, 1, "one code in game, not two");
    assert.match(s.patches.at(-1)!.body.content!, /just sent to \*\*Alpha Wolf\*\*/, "the panel ends on the real answer");
    const code = /(\d{6})/.exec(sent[0]!.message)![1]!;
    const done = await s.deferred(await s.call(submit("pp:vip:verify:", { code }, discordId)));
    assert.match(done.content!, /Linked!/);
  } finally {
    s.fake.close();
  }
});

/*
 * Codes entered at the same moment were each checked against the same "3 tries left" and each
 * saved "2 tries left": a burst was any number of guesses for the price of one.
 */
test("codes entered at once are checked one at a time: a burst is not extra guesses", async () => {
  const s = await scene();
  try {
    const discordId = s.who("640100200300");
    const { code } = await sendCodeTo(s, discordId, s.BRAVO);
    const before = s.patches.length;
    const restore = slowReads(s);
    try {
      // 000000 is never a code — they are drawn from 100000..999999.
      const burst = await Promise.all(Array.from({ length: 4 }, () => s.call(submit("pp:vip:verify:", { code: "000000" }, discordId))));
      await Promise.all(burst.map((r) => r.followUp));
    } finally {
      restore();
    }
    const answers = s.patches.slice(before).map((p) => p.body.content ?? "");
    assert.equal(answers.filter((a) => /tries? left|locked/.test(a)).length, 1, `one guess was checked: ${answers.join(" | ")}`);
    assert.equal(answers.filter((a) => /Checking the code you entered/.test(a)).length, 3, "the rest were told to wait");
    // The burst cost one try, so the right code still lands.
    const done = await s.deferred(await s.call(submit("pp:vip:verify:", { code }, discordId)));
    assert.match(done.content!, /Linked!/);
  } finally {
    s.fake.close();
  }
});

/*
 * Send again a minute later used to restore all three tries — two guesses, a resend, two more —
 * so the lockout never came. Tries carry over while the code they were spent on is still live.
 */
test("Send again does not bring back the tries: wrong codes count across resends until the code runs out", async () => {
  const s = await scene();
  try {
    const discordId = s.who("620100200300");
    const { sent } = await sendCodeTo(s, discordId, s.BRAVO);
    const wrong = await s.deferred(await s.call(submit("pp:vip:verify:", { code: "000000" }, discordId)));
    assert.match(wrong.content!, /2 tries left/);

    const age = async (patch: Record<string, unknown>) => {
      const c = await s.repo.pluginKv.get("vip-registration", discordId) as Record<string, unknown>;
      await s.repo.pluginKv.set("vip-registration", discordId, { ...c, ...patch });
    };
    // A minute on (past the resend cooldown), Send again: the new code keeps the count.
    await age({ lastSentAt: Date.now() - 61_000 });
    const resent = await s.deferred(await s.call(press(buttonId(sent, "Send again"), discordId)));
    assert.match(resent.content!, /just sent to \*\*Bravo Fox\*\*.*2 tries left/s, "the new code says what is left");
    const next = await s.deferred(await s.call(submit("pp:vip:verify:", { code: "000000" }, discordId)));
    assert.match(next.content!, /1 try left/, "and a wrong guess takes it down, not back to three");

    // A code left to run out starts the next one fresh.
    await age({ lastSentAt: Date.now() - 11 * 60_000, expiresAt: Date.now() - 60_000 });
    const fresh = await s.deferred(await s.call(press(buttonId(sent, "Send again"), discordId)));
    assert.match(fresh.content!, /just sent to \*\*Bravo Fox\*\*/);
    assert.doesNotMatch(fresh.content!, /left/, "three tries again, so nothing to warn about");
    const after = await s.deferred(await s.call(submit("pp:vip:verify:", { code: "000000" }, discordId)));
    assert.match(after.content!, /2 tries left/);
  } finally {
    s.fake.close();
  }
});

/*
 * The host's own guard, on the member's panel: a second press there while a slow one runs is
 * acknowledged and dropped — it never reaches the module, so nothing runs twice and nothing
 * flickers on the panel.
 */
test("a second press on the member's panel while a slow one runs is dropped by the host", async () => {
  const s = await scene();
  try {
    const discordId = s.who("690100200300");
    const roster = await s.deferred(await s.call(press(`pp:vip:roster:${s.server.id}:0`, discordId)));
    const pick = { ...press(`pp:vip:pick:${s.server.id}`, discordId, { selected: [rosterOption(roster, "Alpha Wolf").value] }), message: { id: "panel-1", flags: 64 } };
    const restore = slowReads(s);
    const before = s.patches.length;
    try {
      const first = await s.call(pick);
      const second = await s.call(pick);
      assert.equal((second.body as { type: number }).type, 6, "acknowledged");
      assert.equal(second.followUp, undefined, "and dropped before the module");
      await first.followUp;
    } finally {
      restore();
    }
    assert.equal(s.patches.length - before, 1, "one answer on the panel");
    assert.equal(s.fake.messages.filter((m) => m.playerId === s.ALPHA).length, 1, "one code in game");
  } finally {
    s.fake.close();
  }
});

/*
 * A code that could not be sent is said in words a member can act on. The panel is public, and
 * the reason in the server's own terms is not for it: a connection refused names the game
 * server's address and port. The reason goes to the log, for staff.
 */
test("a code that cannot be sent says so plainly, never with the game server's address", async () => {
  const s = await scene();
  try {
    const discordId = s.who("700100900");
    const roster = await s.deferred(await s.call(press(`pp:vip:roster:${s.server.id}:0`, discordId)));
    // The pick reads the roster again and then connects to send the code: the read answers, and
    // the server stops taking new connections before the send's.
    s.fake.onCommand = (name, content) => { if (name === "GetServerInformation" && String(content.Name) === "players") s.fake.close(); };
    const sent = await s.deferred(await s.call(press(`pp:vip:pick:${s.server.id}`, discordId, { selected: [rosterOption(roster, "Alpha Wolf").value] })));
    assert.match(sent.content!, /Could not message you in game/);
    assert.doesNotMatch(sent.content!, /127\.0\.0\.1|ECONNREFUSED/, "no address or socket error in a public reply");
    assert.ok(buttonId(sent, "Try again"), "and one tap to try again");
    assert.equal(s.fake.messages.length, 0, "nothing reached the game");
  } finally {
    s.fake.close();
  }
});

/*
 * The member's own game name, in Discord text: "*KLM* Fox" lost its asterisks to italics, and a
 * "[x](https://…)" name would have shown as a link.
 */
test("the member's game name shows as written when the code is sent and when they are linked", async () => {
  const s = await scene();
  try {
    s.fake.players = [{ iD: s.BRAVO, name: "*KLM* Fox_1" }];
    const discordId = s.who("600100200399");
    await s.call(press("pp:vip:link:", discordId));
    const { sent, code } = await sendCodeTo(s, discordId, s.BRAVO);
    assert.match(sent.content!, /sent to \*\*\\\*KLM\\\* Fox\\_1\*\*/);
    await s.call(press("pp:vip:codem:", discordId));
    const done = await s.deferred(await s.call(submit("pp:vip:verify:", { code }, discordId)));
    assert.match(done.content!, /Linked! You are \*\*\\\*KLM\\\* Fox\\_1\*\*/);
  } finally {
    s.fake.close();
  }
});
