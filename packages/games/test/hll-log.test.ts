import { test } from "node:test";
import assert from "node:assert/strict";
// Imported from dist (test script builds first): log.ts imports its sibling match.js, and
// strip-types can't resolve a .js specifier back to a .ts source — same pattern as @app/maps.
import { normalizeLine, normalizeLines, parseLogPrefix, logLineKey } from "../dist/hll/log.js";
import { sideFromTeam } from "../dist/hll/match.js";

const ctx = { serverId: "srv-1", ts: "2026-02-11T22:56:00.000Z" };

// Real lines observed from a live HLL v2 server (The [LYNX] Division).
test("parses a real prefixed KILL line and uses the embedded timestamp", () => {
  const line = "[13.8 sec (1784761672)] KILL: Peter(Allies/87e413ee56a32b73bc4199467a665391) -> ROBO DEWED(Axis/b491452aed63925c9fdfc17efe993107) with M1918A2 BAR";
  const e = normalizeLine(line, { serverId: "srv-1" }); // no ctx.ts -> derive from the line
  assert.equal(e?.kind, "evt.kill");
  assert.equal((e as any).playerName, "Peter");
  assert.equal((e as any).playerId, "87e413ee56a32b73bc4199467a665391");
  assert.equal((e as any).victimName, "ROBO DEWED");
  assert.equal((e as any).victimId, "b491452aed63925c9fdfc17efe993107");
  assert.equal((e as any).weapon, "M1918A2 BAR");
  assert.equal((e as any).ts, new Date(1784761672 * 1000).toISOString());
});

test("parses a real KILL with a bracketed vehicle weapon and 'ms' prefix", () => {
  const line = "[9.69 sec (1784761696)] KILL: CPT ROOK(Axis/a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1) -> Juniper91(Allies/b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2) with 75MM CANNON [Sd.Kfz.171 Panther]";
  const e = normalizeLine(line, { serverId: "srv-1" });
  assert.equal(e?.kind, "evt.kill");
  assert.equal((e as any).weapon, "75MM CANNON [Sd.Kfz.171 Panther]");
  // 'ms' unit prefix must also strip
  const e2 = normalizeLine("[3 ms (1784761685)] KILL: A(Allies/1) -> B(Axis/2) with M1 CARBINE", { serverId: "srv-1" });
  assert.equal(e2?.kind, "evt.kill");
});

test("dedup key is stable as the relative time changes across polls", () => {
  const poll1 = "[4.72 sec (1784761681)] KILL: HERON(Axis/c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3) -> SGT Marlow(Allies/d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4) with GEWEHR 43";
  const poll2 = "[14.8 sec (1784761681)] KILL: HERON(Axis/c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3) -> SGT Marlow(Allies/d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4) with GEWEHR 43";
  assert.equal(logLineKey(poll1), logLineKey(poll2)); // same event -> same key
});

test("two different kills at the same timestamp have different keys", () => {
  const a = "[14.8 sec (1784761691)] KILL: HERON(Axis/c3c) -> Alder(Allies/e5e) with GEWEHR 43";
  const b = "[14.3 sec (1784761691)] KILL: HERON(Axis/c3c) -> QUILLON14(Allies/f6f) with GEWEHR 43";
  assert.notEqual(logLineKey(a), logLineKey(b));
});

test("parseLogPrefix returns body unchanged when there is no prefix", () => {
  const r = parseLogPrefix("KILL: A(Allies/1) -> B(Axis/2) with X");
  assert.equal(r.body, "KILL: A(Allies/1) -> B(Axis/2) with X");
  assert.equal(r.ts, undefined);
});

test("parses a KILL line", () => {
  const e = normalizeLine(
    "KILL: wren(Allies/76561198000000043) -> ZX204(Axis/0f0f0f0f0f0f0f0f0f0f0f0f0f0f0) with M1 CARBINE",
    ctx,
  );
  assert.equal(e?.kind, "evt.kill");
  assert.equal((e as any).playerName, "wren");
  assert.equal((e as any).victimName, "ZX204");
  assert.equal((e as any).weapon, "M1 CARBINE");
  assert.equal((e as any).serverId, "srv-1");
});

test("parses a TEAM KILL line distinctly from KILL", () => {
  const e = normalizeLine("TEAM KILL: Alpha(Allies/111) -> Bravo(Allies/222) with SATCHEL", ctx);
  assert.equal(e?.kind, "evt.teamkill");
  assert.equal((e as any).weapon, "SATCHEL");
});

test("parses CONNECTED / DISCONNECTED", () => {
  assert.equal(normalizeLine("CONNECTED NewRecruit (76561198000000001)", ctx)?.kind, "evt.player.connected");
  assert.equal(normalizeLine("DISCONNECTED NewRecruit (76561198000000001)", ctx)?.kind, "evt.player.disconnected");
});

test("parses team vs squad chat", () => {
  assert.equal(normalizeLine("CHAT[Team][Hollis(Allies/1)]: hello all", ctx)?.kind, "evt.chat.team");
  assert.equal(normalizeLine("CHAT[Unit][pellow(Allies/2)]: on me", ctx)?.kind, "evt.chat.squad");
  assert.equal(normalizeLine("CHAT[Squad][x(Axis/3)]: y", ctx)?.kind, "evt.chat.squad");
});

/*
 * Cross-platform: the same server carries PC players (17-digit Steam64) and console players
 * (32-hex EOS-style ids) at once, and chat is where several features meet the id — the Discord
 * relay, chat rules, and the map-vote surface. Both forms must come out of the line verbatim.
 */
test("chat parses PC (Steam64) and console (hex) ids alike", () => {
  const pc = normalizeLine("CHAT[Team][PCGuy(Allies/76561198000000043)]: gg", ctx) as { kind: string; playerId?: string } | null;
  assert.equal(pc?.kind, "evt.chat.team");
  assert.equal(pc?.playerId, "76561198000000043");
  const console_ = normalizeLine("CHAT[Team][PadGuy(Axis/0f0f0f0f0f0f0f0f0f0f0f0f0f0f0aaa)]: gg", ctx) as { kind: string; playerId?: string } | null;
  assert.equal(console_?.kind, "evt.chat.team");
  assert.equal(console_?.playerId, "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0aaa");
});

test("chat keeps the message body (for filters + relay)", () => {
  const e = normalizeLine("CHAT[Team][Hollis(Allies/1)]: move up on the point", ctx);
  assert.equal(e?.kind, "evt.chat.team");
  assert.equal((e as any).data?.message, "move up on the point");
});

test("parses teamswitch, match start/end (with map + result)", () => {
  assert.equal(normalizeLine("TEAMSWITCH QuietOtter (None > Allies)", ctx)?.kind, "evt.player.teamSwitched");
  const start = normalizeLine("MATCH START Carentan Warfare", ctx);
  assert.equal(start?.kind, "evt.match.started");
  assert.equal((start as any)?.data?.map, "Carentan Warfare");
  const end = normalizeLine("MATCH ENDED Carentan Allies (3 - 2)", ctx);
  assert.equal(end?.kind, "evt.match.ended");
  assert.equal((end as any)?.data?.result, "Carentan Allies (3 - 2)");
  assert.equal((end as any)?.data?.score, "3 - 2");
  // The modern line puts the second side label AFTER the parens; the score must still be found.
  const flanked = normalizeLine("MATCH ENDED `Kharkov Warfare` ALLIED (2 - 3) AXIS", ctx);
  assert.equal((flanked as any)?.data?.score, "2 - 3");
  assert.equal((flanked as any)?.data?.result, "`Kharkov Warfare` ALLIED (2 - 3) AXIS");
});

// Patterns cross-checked against CRCON's parse_log_line (authoritative HLL admin-log format).
test("parses VOTESYS start/complete (real vote format)", () => {
  const started = normalizeLine("VOTESYS: Player [NoodleArms] Started a vote of type (PVR_Kick_Abuse) against [buscO-sensei]. VoteID: [2]", ctx);
  assert.equal(started?.kind, "evt.vote.started");
  assert.equal((started as any).playerName, "NoodleArms");
  assert.equal((started as any).voteType, "PVR_Kick_Abuse");
  assert.equal((started as any).target, "buscO-sensei");
  assert.equal(normalizeLine("VOTESYS: Vote [2] completed. Result: PVR_Passed", ctx)?.kind, "evt.vote.completed");
});

/*
 * One player's ballot. The sentence is CRCON's own documented example, and the choice token is kept
 * verbatim rather than folded to a boolean: the game has three of them, and PV_Ignored (the popup
 * dismissed) is neither a yes nor a no. It is what the public scoreboard's nb_voted_yes /
 * nb_voted_no are counted from.
 */
test("parses a VOTESYS ballot, keeping the choice token", () => {
  const cast = normalizeLine("VOTESYS: Player [Dingbat252] voted [PV_Favour] for VoteID[2]", ctx);
  assert.equal(cast?.kind, "evt.vote.cast");
  assert.equal((cast as any).playerName, "Dingbat252");
  assert.equal((cast as any).data.choice, "PV_Favour");

  assert.equal((normalizeLine("VOTESYS: Player [Ana] voted [PV_Against] for VoteID[7]", ctx) as any).data.choice, "PV_Against");
  assert.equal((normalizeLine("VOTESYS: Player [Ana] voted [PV_Ignored] for VoteID[7]", ctx) as any).data.choice, "PV_Ignored");

  // The "Started a vote" sentence opens identically and must not be swallowed by the ballot rule.
  assert.equal(
    normalizeLine("VOTESYS: Player [Ana] Started a vote of type (PVR_Kick_Abuse) against [Bob]. VoteID: [9]", ctx)?.kind,
    "evt.vote.started",
  );
});

test("parses kick/ban incl. auto team-kill and perma", () => {
  const kick = normalizeLine("KICK: [Tommy] HAS BEEN KICKED. [Idle]", ctx);
  assert.equal(kick?.kind, "evt.player.kicked");
  assert.equal((kick as any).playerName, "Tommy");
  assert.equal((kick as any).reason, "Idle"); // clean reason, not the "HAS BEEN KICKED." boilerplate

  // Real production idle-kick line (from a live GetAdminLog dump).
  const idle = normalizeLine("[8.37 sec (1784826572)] KICK: [Beans] has been kicked. [YOU WERE KICKED FOR BEING IDLE]", ctx);
  assert.equal(idle?.kind, "evt.player.kicked");
  assert.equal((idle as any).playerName, "Beans");
  assert.equal((idle as any).reason, "YOU WERE KICKED FOR BEING IDLE");

  const tkKick = normalizeLine("KICK: [Rando] HAS BEEN KICKED. [YOU WERE KICKED FOR TEAM KILLING!]", ctx);
  assert.equal(tkKick?.kind, "evt.player.kicked");
  assert.equal((tkKick as any).auto, true);
  assert.equal((tkKick as any).reason, "YOU WERE KICKED FOR TEAM KILLING!");

  const ban = normalizeLine("BAN: [Cheater] HAS BEEN PERMANENTLY BANNED. [Anti-Cheat]", ctx);
  assert.equal(ban?.kind, "evt.player.banned");
  assert.equal((ban as any).banType, "perma");
  assert.equal((ban as any).auto, true);
  assert.equal((ban as any).reason, "Anti-Cheat");
});

test("parses an admin MESSAGE line", () => {
  const m = normalizeLine("MESSAGE: player [Alpha(76561198000000001)], content [Please move to your objective]", ctx);
  assert.equal(m?.kind, "evt.admin.message");
  assert.equal((m as any).playerName, "Alpha");
  assert.equal((m as any).data?.message, "Please move to your objective");
});

test("parses Team and Unit chat scopes", () => {
  assert.equal(normalizeLine("CHAT[Team][Hollis(Allies/1)]: hello all", ctx)?.kind, "evt.chat.team");
  assert.equal(normalizeLine("CHAT[Unit][pellow(Axis/2)]: on me", ctx)?.kind, "evt.chat.squad");
});

test("returns null for unrecognized / blank lines", () => {
  assert.equal(normalizeLine("something random", ctx), null);
  assert.equal(normalizeLine("   ", ctx), null);
});

test("normalizeLines drops unrecognized lines", () => {
  const events = normalizeLines(
    ["CONNECTED A (1)", "noise", "DISCONNECTED A (1)"],
    ctx,
  );
  assert.equal(events.length, 2);
});

test("kill parsing: ANY faction token — never swallowed into the player id", () => {
  // Newer game versions write faction tokens outside any fixed list (SOV, CW, B8A, DAK, …). The
  // parser must take whatever precedes the slash as the team and keep the id clean — the old
  // hardcoded alternation produced ids like "SOV/7656…", minting phantom players that silently
  // absorbed every kill on current-version servers.
  const e = normalizeLine(
    "[5 sec (1784761700)] KILL: Ivan(SOV/76561198000000001) -> Tommy(B8A/9ab6d265061977a91c76f151fca7feb0) with MOSIN NAGANT",
    { serverId: "srv-1" },
  ) as { kind: string; playerId?: string; victimId?: string; data?: Record<string, unknown> };
  assert.equal(e.kind, "evt.kill");
  assert.equal(e.playerId, "76561198000000001");
  assert.equal(e.victimId, "9ab6d265061977a91c76f151fca7feb0");
  assert.equal(e.data?.playerTeam, "SOV");
  assert.equal(e.data?.victimTeam, "B8A");
  // The RESOLVED sides ride along on kill events so game-agnostic consumers (feed coloring)
  // never have to interpret raw faction tokens themselves.
  assert.equal(e.data?.actorSide, "allies");
  assert.equal(e.data?.victimSide, "allies");

  // No faction at all (some lines omit it): the id is still the id.
  const bare = normalizeLine(
    "[5 sec (1784761701)] KILL: A(76561198000000002) -> B(DAK/76561198000000003) with FLAMMENWERFER",
    { serverId: "srv-1" },
  ) as { playerId?: string; victimId?: string; data?: Record<string, unknown> };
  assert.equal(bare.playerId, "76561198000000002");
  assert.equal(bare.victimId, "76561198000000003");
  assert.equal(bare.data?.victimTeam, "DAK");
  assert.equal(bare.data?.actorSide, null); // no token → no side, never a guess
  assert.equal(bare.data?.victimSide, "axis");

  // Chat lines use the same player token — id must stay clean there too.
  const chat = normalizeLine(
    "[2 sec (1784761702)] CHAT[Team][Ivan(SOV/76561198000000001)]: push left",
    { serverId: "srv-1" },
  ) as { kind: string; playerId?: string };
  assert.equal(chat.kind, "evt.chat.team");
  assert.equal(chat.playerId, "76561198000000001");
});

test("sideFromTeam: newer faction tokens map to the right side", () => {
  assert.equal(sideFromTeam("SOV"), "allies");
  assert.equal(sideFromTeam("CW"), "allies");
  assert.equal(sideFromTeam("B8A"), "allies");
  assert.equal(sideFromTeam("DAK"), "axis");
  assert.equal(sideFromTeam("GER"), "axis");
  assert.equal(sideFromTeam("weird-future-faction"), null);
});

/*
 * A player id is whatever the game wrote between the parentheses — the character set has to stay
 * wide open, because task #158 was exactly the bug of narrowing it: an unlisted faction token
 * (SOV, CW, B8A, DAK, …) got swallowed into the id, minting phantom players and losing every kill
 * on servers running a newer game build.
 *
 * These pin both halves at once: everything that IS an id still parses, and the two shapes that
 * are not ids at all stop becoming players.
 */
test("hll log: any faction token still yields the real id (the #158 guarantee)", () => {
  const at = (line: string) => normalizeLine(line, ctx) as { playerId?: string; victimId?: string } | null;

  // Every faction token the game has shipped, plus one that does not exist yet.
  for (const faction of ["Allies", "Axis", "SOV", "CW", "B8A", "DAK", "GB", "NOT_A_REAL_FACTION_YET"]) {
    const e = at(`KILL: Ace(${faction}/76561198000000001) -> Bob(${faction}/76561198000000002) with MP40`);
    assert.equal(e?.playerId, "76561198000000001", `faction ${faction} swallowed the killer's id`);
    assert.equal(e?.victimId, "76561198000000002", `faction ${faction} swallowed the victim's id`);
  }

  // Ids that are not steam64 must survive untouched — console and hashed ids are not numeric.
  for (const id of ["abc123", "8a7f-2b1c-44de", "0123456789abcdef0123456789abcdef", "epic-player-9", "76561198000000001"]) {
    const e = at(`KILL: Ace(SOV/${id}) -> Bob(DAK/2) with MG42`);
    assert.equal(e?.playerId, id, `id ${id} was altered`);
  }

  // No faction token at all is still the old, valid shape.
  assert.equal(at("KILL: Ace(76561198000000001) -> Bob(76561198000000002) with MP40")?.playerId, "76561198000000001");
});

test("hll log: a blank id is dropped, not turned into a shared phantom player", () => {
  const at = (line: string) => normalizeLine(line, ctx) as { kind: string; playerId?: string; victimId?: string } | null;

  // "" was already dropped downstream. "   " was NOT — it is truthy, so it reached the player
  // upsert and became one real row that every malformed line on the server collapsed into,
  // accumulating everyone's kills under whatever name happened to be parsed beside it.
  for (const line of [
    "KILL: Ace() -> Bob() with MP40",
    "KILL: Ace(Allies/) -> Bob(Axis/) with MP40",
    "KILL: Ace(   ) -> Bob( ) with MP40",
    "KILL: Ace(Allies/   ) -> Bob(Axis/\t) with MP40",
  ]) {
    const e = at(line);
    assert.ok(e, `${line} stopped parsing entirely`);
    assert.equal(e?.kind, "evt.kill", "the kill itself must still be recorded");
    assert.equal(e?.playerId, undefined, `blank killer id survived in: ${line}`);
    assert.equal(e?.victimId, undefined, `blank victim id survived in: ${line}`);
  }

  assert.equal(at("CONNECTED Someone (   )")?.playerId, undefined);
  assert.equal(at("DISCONNECTED Someone ()")?.playerId, undefined);
});

test("hll log: a surrounding-space id is the same player, not a second one", () => {
  const at = (line: string) => normalizeLine(line, ctx) as { playerId?: string } | null;
  // Otherwise " 76561198000000001" and "76561198000000001" are two rows for one person.
  assert.equal(at("KILL: Ace(Allies/ 76561198000000001 ) -> Bob(Axis/2) with MP40")?.playerId, "76561198000000001");
  assert.equal(at("CONNECTED Someone ( 76561198000000001 )")?.playerId, "76561198000000001");
});

test("hll log: an absurdly long id is a mis-split line, not a player", () => {
  const at = (line: string) => normalizeLine(line, ctx) as { kind: string; playerId?: string } | null;
  // Real ids are short: steam64 is 17, a UUID 36, a T17 hex id 32.
  const long = "z".repeat(500);
  const e = at(`KILL: Ace(Allies/${long}) -> Bob(Axis/2) with MP40`);
  assert.equal(e?.kind, "evt.kill");
  assert.equal(e?.playerId, undefined, "a 500-character id must not become a player row");
  // …but a 64-character one is still plausibly real and must be kept.
  assert.equal(at(`KILL: Ace(Allies/${"a".repeat(64)}) -> Bob(Axis/2) with MP40`)?.playerId, "a".repeat(64));
});

/*
 * What the parser does with a line no human typed.
 *
 * The log is external input. The live one carries corrupted content (#158 was exactly that), and
 * the CRCON importer runs this same parser over an archive file from somebody else's install — so
 * "the game would never send that" is not a guarantee this code gets to rely on.
 */
test("hll log: a pathological line cannot stall the parser", async () => {
  const { normalizeLine } = await import("../dist/hll/log.js");
  // A pinned `ts`, because these lines carry no timestamp prefix and the fallback is `now` — two
  // calls a millisecond apart would otherwise differ on the clock rather than on the parse.
  const ctx = { serverId: "s1", ts: "2026-02-11T22:56:00.000Z" };

  // The player patterns are a lazy run followed by a bracket, which backtracks quadratically on a
  // line full of brackets that never completes a match: measured at 66ms for 8k characters, 4.1s
  // for 32k, minutes for 200k. `exec` is synchronous and the worker runs every server's ingest,
  // auto-mod, map vote and heartbeat on one event loop, so that is the whole process stopped.
  // Bounded, not merely "fast" — and asserted WITHOUT a stopwatch, because a wall-clock threshold
  // on a machine running the rest of the suite in parallel is a coin flip, and a ratio between two
  // millisecond-resolution readings is worse (the 4k baseline can measure as 0ms, and nothing is
  // `<= 0 * 3`). This says the thing the cap actually guarantees: the parser never looks past it.
  // Two lines that agree for the first MAX_LINE_LEN characters and diverge wildly after must give
  // identical answers. Uncapped they cannot — the weapon runs to end-of-line.
  const complete = "KILL: Alice(Allies/76561198000000001) -> Bob(Axis/76561198000000002) with M1 GARAND";
  const pad = " ".repeat(4_000); // pushes the divergence past the cap
  assert.deepEqual(
    normalizeLine(complete + pad + "TAIL-ONE", ctx),
    normalizeLine(complete + pad + "A-COMPLETELY-DIFFERENT-TAIL", ctx),
    "everything past the line cap must be invisible to the parser",
  );

  // A generous stopwatch backstop as well, sized to catch the regression rather than to measure
  // performance: the quadratic version took 4.1s at 32k and 163s at 200k, so seconds of headroom
  // still fails loudly while never flaking on a busy machine.
  const t0 = Date.now();
  normalizeLine("KILL: " + "(".repeat(200_000), ctx);
  const ms = Date.now() - t0;
  assert.ok(ms < 5_000, `a 200k-character line took ${ms}ms — the line cap is not being applied`);

  // And none of the obvious malformations throw. A throw here does not lose one line: it rejects
  // the whole batch the line arrived in, and takes the good events with it.
  for (const line of ["", "   ", "KILL:", "KILL: a(Allies/1 -> b", "CHAT[Team][", "X".repeat(100_000)]) {
    assert.doesNotThrow(() => normalizeLine(line, ctx));
  }
});

test("hll log: an absurd name is clipped, an absurd id is dropped", async () => {
  const { normalizeLine } = await import("../dist/hll/log.js");
  const ctx = { serverId: "s1" };

  // A name is what a human reads the event by, so half of it beats none of it.
  const long = normalizeLine(`KILL: ${"N".repeat(500)}(Allies/76561198000000001) -> Bob(Axis/76561198000000002) with M1 GARAND`, ctx);
  assert.equal(long?.kind, "evt.kill", "the kill still counts");
  assert.ok((long as { playerName?: string }).playerName!.length <= 128,
    `the name reached the store at ${(long as { playerName?: string }).playerName!.length} characters`);
  assert.equal((long as { victimName?: string }).victimName, "Bob", "a normal name is untouched");

  // An id is an identity: a wrong one invents a player, so it is dropped rather than clipped.
  const badId = normalizeLine(`KILL: Alice(Allies/${"9".repeat(500)}) -> Bob(Axis/76561198000000002) with M1 GARAND`, ctx);
  assert.equal(badId?.kind, "evt.kill");
  assert.equal((badId as { playerId?: string }).playerId, undefined, "an unusable id is not stored as a player");
  assert.equal((badId as { victimId?: string }).victimId, "76561198000000002");
});

/*
 * Admin camera. The line was going unparsed entirely — the CRCON importer produced these events
 * from somebody else's archive, but the live log never did, so a server's OWN spectator use left
 * no record at all. `entered` is decided here rather than downstream, because three readers each
 * deciding what "Left Admin Camera" means is three chances to disagree.
 */
test("admin camera enter/leave is parsed, and an unreadable one is stored without guessing", () => {
  const ctx = { serverId: "s1", ts: "2026-01-01T00:00:00.000Z" };
  const inCam = normalizeLine("CAMERA [Mod Jane (76561198000000009)] Entered Admin Camera", ctx) as any;
  assert.equal(inCam?.kind, "evt.admin.camera");
  assert.equal(inCam.playerName, "Mod Jane");
  assert.equal(inCam.playerId, "76561198000000009");
  assert.equal(inCam.data.entered, true);

  const out = normalizeLine("CAMERA [Mod Jane (76561198000000009)] Left Admin Camera", ctx) as any;
  assert.equal(out.data.entered, false);

  // The punctuation varies between the legacy text log and v2 GetAdminLog, and a pattern that
  // insisted on one spelling would go quiet on the other with nothing to say it had.
  const terse = normalizeLine("CAMERA: Mod Jane(76561198000000009) Entering Admin Camera", ctx) as any;
  assert.equal(terse?.kind, "evt.admin.camera");
  assert.equal(terse.data.entered, true);

  // A wording we don't recognise is still stored — but as neither, so the pairing skips it rather
  // than opening a session that swallows the next real one.
  const odd = normalizeLine("CAMERA [Mod Jane (76561198000000009)] did something new", ctx) as any;
  assert.equal(odd?.kind, "evt.admin.camera");
  assert.equal(odd.data.entered, null);
});

/**
 * The relative age in a log-line prefix is not always a decimal number.
 *
 * Under a minute the game writes "13.8 sec" / "3 ms". Over a minute it switches to clock time —
 * "1:03 min", "1:02:33 hours" — and the colon is the whole difficulty: a prefix pattern built
 * only from digits and dots does not match those lines, so the prefix is never stripped, the body
 * still starts with "[1:03 min …", and every `^`-anchored matcher below misses. The line parses
 * as nothing.
 *
 * That failure is invisible for anything frequent: a kill is read while it is still seconds old,
 * and the minutes-old copies of it are duplicates we already stored. It is total for anything
 * that happens once. An admin entering spectator emits a single CAMERA line, and if that line was
 * not read inside its first minute the visit left no trace anywhere in the app.
 */
test("a prefix in clock time parses like one in seconds — every unit, both halves", () => {
  const ctx = { serverId: "srv-1" };
  const body = "KILL: A(Allies/1) -> B(Axis/2) with M1 CARBINE";
  for (const age of ["3 ms", "13.8 sec", "59 sec", "1:03 min", "12:45 min", "1:02:33 hours", "2 days"]) {
    const e = normalizeLine(`[${age} (1784761672)] ${body}`, ctx);
    assert.equal(e?.kind, "evt.kill", `a "${age}" prefix must not swallow the line`);
    // The prefix's own timestamp is the event time whatever the age reads as.
    assert.equal(e?.ts, new Date(1784761672 * 1000).toISOString(), `a "${age}" prefix must still yield the embedded time`);
  }
});

test("the same event at different ages keeps ONE dedup key, across the minute boundary", () => {
  // The relative age changes every poll while the unix timestamp does not — that is what makes
  // the key stable. When the prefix failed to parse the key fell back to the whole raw line, so
  // an event crossing 60s started producing a new key on every single poll: the `seen` set could
  // no longer recognise it, and only the database's own dedup stopped it being re-stored.
  const line = (age: string) => `[${age} (1784761672)] CAMERA[Mod Jane (76561198000000009)] Entered Admin Camera`;
  const keys = new Set(["45.2 sec", "59 sec", "1:03 min", "4:31 min", "1:02:33 hours"].map((a) => logLineKey(line(a))));
  assert.equal(keys.size, 1, `one event must have one key, got ${[...keys].join(" / ")}`);
});

test("a camera visit is recorded from a prefixed line, not just a bare one", () => {
  // Every camera test above this one used a bare line with no prefix at all, which is exactly how
  // the prefix gap hid: the parser was proven against input the worker never actually sees.
  const ctx = { serverId: "srv-1" };
  const entered = normalizeLine("[2:14 min (1784761672)] CAMERA[Mod Jane (76561198000000009)] Entered Admin Camera", ctx);
  assert.equal(entered?.kind, "evt.admin.camera");
  assert.ok(entered && "playerName" in entered, "a camera event names its player");
  assert.equal(entered.playerName, "Mod Jane");
  assert.equal(entered.playerId, "76561198000000009");
  assert.equal(entered.data!.entered, true);

  const left = normalizeLine("[17:02 min (1784762000)] CAMERA[Mod Jane (76561198000000009)] Left Admin Camera", ctx);
  assert.equal(left?.kind, "evt.admin.camera");
  assert.equal(left!.data!.entered, false);
});
