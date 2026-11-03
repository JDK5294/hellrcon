/**
 * The HLL: Vietnam module — the game's own data behind the shared seam.
 *
 * Vietnam ships HLL's RCON wire for wire, so what these tests pin is everything that is
 * Vietnam's OWN: the identity rule (the one decision that can fork a human into twin rows),
 * the US/NVA side vocabulary reaching kill events and match outcomes, the platoon roles the
 * no-leader warnings depend on, and the weapon buckets built from the release reference export.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HLLV_GAME, HLL_GAME, classifyWeapon, getGame, listGames, playerIdentityOf, summarizeRoster } from "../dist/index.js";
import { parseMatchResult, sideFromTeam } from "../dist/hll/match.js";
import { normalizeLine } from "../dist/hll/log.js";

test("hllv is registered, offers HLL's protocols, and carries its OWN command table", () => {
  const mod = getGame("hllv");
  assert.equal(mod, HLLV_GAME);
  assert.ok(listGames().some((g) => g.id === "hllv"), "the Add Server form lists it");
  assert.deepEqual(mod!.protocols.map((p) => p.id), ["binary-v2", "legacy-text"]);
  // NOT the same object. Vietnam shares HLL's transport, but its command set diverges in the
  // places docs/hll-vietnam.md §2.2-2.4 lists, and this used to be the same table — which meant
  // sending HLL's spelling to a Vietnam server. See hllv-commands.test.ts for the deltas.
  assert.notEqual(mod!.commands, HLL_GAME.commands);
  assert.equal(mod!.commands.setWelcomeMessage!.binaryV2!.name, "SetNoticeMessage");
  assert.equal(HLL_GAME.commands.setWelcomeMessage!.binaryV2!.name, "SetWelcomeMessage");
});

// ---- identity: the EOS id is THE player id — it keys the row, always ----

test("identity: a Steam player is keyed by the EOS id — the id every command acts on", () => {
  // Vietnam's roster `Id` is the EOS id, and it is what AddVip/RemoveVip/Punish/Ban/Message all
  // mean by PlayerId. Keying by the Steam64 instead (the first version of this rule) stored rows
  // the game itself could not address: every panel action was accepted and matched nobody.
  const who = playerIdentityOf(HLLV_GAME, {
    name: "Lynx", platform: "steam", iD: "0002b45a7f5d4e8d9c1f000000000001", steamId: "76561198000000001",
  });
  assert.deepEqual(who, {
    platform: "steam",
    platformId: "0002b45a7f5d4e8d9c1f000000000001",
    links: [{ provider: "steam", externalId: "76561198000000001" }],
  });
});

test("identity: the short-form roster (no SteamId field) still keys by the same EOS id", () => {
  // The players LIST reports name/iD/platform; the detail read adds SteamId separately. Both
  // shapes must key the same human, or every poll would fork them into twins.
  const short = playerIdentityOf(HLLV_GAME, {
    name: "Lynx", platform: "steam", iD: "0002b45a7f5d4e8d9c1f000000000001",
  });
  assert.equal(short!.platformId, "0002b45a7f5d4e8d9c1f000000000001");
  assert.equal(short!.links, undefined, "nothing to link until the detail read supplies the Steam64");
});

test("identity: a console player is keyed by the EOS id under their platform", () => {
  const who = playerIdentityOf(HLLV_GAME, { name: "PadLad", platform: "psn", iD: "0002aaaa7f5d4e8d9c1f000000000002" });
  assert.deepEqual(who, { platform: "psn", platformId: "0002aaaa7f5d4e8d9c1f000000000002" });
});

test("identity: no id at all is null, never an empty-string row", () => {
  assert.equal(playerIdentityOf(HLLV_GAME, { name: "ghost" }), null);
});

// ---- sides: US/NVA reach kill events and match outcomes through the shared parsers ----

test("kill lines tagged US/NVA resolve to sides — the same parser, Vietnam's tokens", () => {
  const evt = normalizeLine(
    "[3 ms (1784761685)] KILL: Charlie(NVA/0002b45a7f5d4e8d9c1f000000000001) -> Grunt(US/76561198000000001) with RPD",
    { serverId: "s1" },
  );
  assert.ok(evt && evt.kind === "evt.kill");
  const data = (evt as { data?: Record<string, unknown> }).data ?? {};
  assert.equal(data.actorSide, "axis");
  assert.equal(data.victimSide, "allies");
  assert.equal(sideFromTeam("NVA"), "axis");
  assert.equal(sideFromTeam("US"), "allies");
});

test("MATCH ENDED understands the Vietnam vocabulary without re-reading HLL lines", () => {
  assert.equal(parseMatchResult("`Cam Ranh Port Warfare` NVA (5 - 0)").winner, "axis");
  assert.equal(parseMatchResult("`Van Tuong Warfare` US (3 - 2)").winner, "allies");
  // A layer id embedding OFFENSIVEUS is not the word US — no false winner from the map name;
  // the decisive score is what answers.
  assert.equal(parseMatchResult("WDEVE_OFFENSIVENVA_DAY (2 - 3)").winner, "axis");
  // HLL's own tokens still read first: ALLIED beats a stray US later in the line.
  assert.equal(parseMatchResult("ALLIED wins over US positions (2 - 3)").winner, "allies");
});

// ---- descriptor: platoons, their leaders, and the roles Vietnam actually has ----

test("descriptor: sides keep the app-wide allies/axis ids with US/NVA labels", () => {
  const d = HLLV_GAME.descriptor;
  assert.deepEqual(d.sides.map((s) => s.id), ["allies", "axis"]);
  assert.deepEqual(d.sides.map((s) => s.label), ["US", "NVA"]);
  assert.deepEqual(d.sides.map((s) => s.teamValues), [[1], [2]]);
});

test("descriptor: Vietnam's roles — the HLL gap at 1/2 is real, the new platoons are present", () => {
  const d = HLLV_GAME.descriptor;
  assert.equal(d.roles[0], "Rifleman");
  assert.equal(d.roles[1], undefined, "Vietnam has no Assault");
  assert.equal(d.roles[2], undefined, "Vietnam has no Automatic Rifleman");
  assert.equal(d.roles[14], "Mortar Observer");
  assert.equal(d.roles[16], "Pilot");
  assert.equal(d.roles[17], "Logistics Officer");
  assert.equal(d.roles[20], "Commander");
  assert.equal(d.squadLabel, "Platoon");
});

test("every squad type's leader counts, and the army commander does not", () => {
  // is_squad_leader in the reference export: {4, 9, 12, 14, 17, 20} — minus 20, the army
  // commander, who leads the team rather than a squad (the same line HLL draws).
  assert.deepEqual(HLLV_GAME.descriptor.squadLeaderRoles, [4, 9, 12, 14, 17]);

  // A mortar platoon led by its Observer and a helicopter crew led by its Logistics Officer must
  // NOT be flagged leaderless — that is the exact bug HLL artillery squads had (#299's cousin).
  const roster = [
    { team: 1, role: 14, platoon: "MORTAR" }, { team: 1, role: 15, platoon: "MORTAR" },
    { team: 1, role: 17, platoon: "PELICAN" }, { team: 1, role: 16, platoon: "PELICAN" },
    { team: 1, role: 0, platoon: "ABLE" }, { team: 1, role: 3, platoon: "ABLE" },
    { team: 2, role: 9, platoon: "BAKER" },
  ];
  const summary = summarizeRoster(roster, HLLV_GAME.descriptor);
  assert.deepEqual(summary.bySide.allies!.noSlSquads, ["ABLE"], "only the SL-less infantry squad");
  assert.deepEqual(summary.bySide.axis!.noSlSquads, []);
});

// ---- weapons: the buckets built from the release reference export ----

test("weapon classification: Vietnam's kit lands in the right buckets, order intact", () => {
  const d = HLLV_GAME.descriptor;
  const cls = (w: string) => classifyWeapon(d, w).id;
  assert.equal(cls("M16A1"), "rifle");
  assert.equal(cls("Type 56 w/Bayonet"), "rifle");
  assert.equal(cls("Type 53 w/N4"), "sniper", "the scoped Type 53 is a sniper before the rifle bucket can take it");
  assert.equal(cls("M40"), "sniper");
  assert.equal(cls("M79 Grenade Launcher"), "explosive", "named in Explosives & AT before GRENADE can claim it");
  assert.equal(cls("Type 67 Grenade"), "grenade");
  assert.equal(cls("MORTAR"), "mortar");
  assert.equal(cls("US Transport Helicopter"), "helicopter");
  assert.equal(cls("M60D"), "helicopter", "the door gun");
  assert.equal(cls("M60"), "mg");
  assert.equal(cls("RPD"), "mg");
  assert.equal(cls("100mm D-10T"), "armor");
  assert.equal(cls("M73"), "armor", "the tank coax");
  assert.equal(cls("Gaz 63 (Supply)"), "vehicle");
  assert.equal(cls("US Boat"), "vehicle");
  assert.equal(cls("M72 LAW"), "explosive");
  assert.equal(cls("M18 Claymore"), "explosive");
  assert.equal(cls("K-50M w/Drum"), "smg");
  assert.equal(cls("M1911A1"), "pistol");
  assert.equal(cls("IZh-58"), "shotgun");
  assert.equal(cls("Knife"), "melee");
  assert.ok(classifyWeapon(d, "Knife").melee, "the melee bucket is flagged for streak reporting");
});

/*
 * The Vietnam individual-weapon catalogue (hllrcon 2.0.0.3's kill-log names, verbatim) behind the
 * seeding picker. Pins the properties exact-match config depends on, plus canaries against anyone
 * "tidying" the game's own quirks out of the data.
 */
test("hllv weapon catalogue: unique names, quirks verbatim, abilities separate", async () => {
  const { HLLV_WEAPON_NAMES, HLLV_COMMANDER_ABILITIES } = await import("../src/hllv/weapon-names.ts");
  assert.ok(HLLV_WEAPON_NAMES.length >= 60, "the whole table, not a sample");
  const upper = HLLV_WEAPON_NAMES.map((n) => n.toUpperCase());
  assert.equal(new Set(upper).size, upper.length, "no duplicates, even after case folding");
  // Canaries against tidying: the game's own typo and its own missing space stay verbatim.
  assert.ok(HLLV_WEAPON_NAMES.includes("Dhsk"), "the spelling is the game's own");
  assert.ok(HLLV_WEAPON_NAMES.includes("M48Patton"), "the missing space is the game's own");
  // The export's "M79 " arrives TRIMMED: the log normalizer trims every kill's weapon field, so a
  // name with outer whitespace could never match anything.
  assert.ok(HLLV_WEAPON_NAMES.includes("M79"));
  for (const n of HLLV_WEAPON_NAMES) assert.equal(n, n.trim(), JSON.stringify(n));
  assert.deepEqual(HLLV_COMMANDER_ABILITIES, ["NAPALM STRIKE", "STRAFING RUN", "Artillery Strike", "PRECISION STRIKE"]);
  for (const a of HLLV_COMMANDER_ABILITIES) assert.ok(!HLLV_WEAPON_NAMES.includes(a), a);
  // No "Unknown" placeholders — a picker row nobody can fire is noise.
  assert.ok(!upper.includes("UNKNOWN"));
});

test("every hllv catalogue weapon lands in a real bucket", async () => {
  // The data modules directly — the game barrel can't load under strip-types (compiled .js
  // specifiers), and classes are all the classifier reads. Same stub the HLL weapons test uses.
  const { HLLV_WEAPON_NAMES } = await import("../src/hllv/weapon-names.ts");
  const { HLLV_WEAPON_CLASSES } = await import("../src/hllv/data.ts");
  const { classifyWeapon } = await import("../src/weapons.ts");
  const desc = { weaponClasses: HLLV_WEAPON_CLASSES } as import("../src/types.ts").GameDescriptor;
  const strays = HLLV_WEAPON_NAMES.filter((n) => classifyWeapon(desc, n).id === "other");
  assert.deepEqual(strays, []);
});

test("identity: a console player's companion id is filed under its REAL namespace, not 'steam'", () => {
  // The wire calls the field `steamId` for everyone, but for an Xbox player it carries their
  // XUID (16 digits in the 25332… range) — not a Steam id and never was. Filing it under
  // 'steam' printed an Xbox account id beneath a STEAM heading on the profile, and the
  // cross-game account join (which matches on provider + id) could never meet the same XUID
  // filed correctly from the other side.
  const xbox = playerIdentityOf(HLLV_GAME, {
    name: "CrimePays", platform: "xbox", iD: "0002cb51e95e40538440e20a11491f36", steamId: "2533274823952388",
  });
  assert.deepEqual(xbox!.links, [{ provider: "xbox", externalId: "2533274823952388" }]);

  // A real Steam64 keeps its name…
  const steam = playerIdentityOf(HLLV_GAME, {
    name: "PC", platform: "steam", iD: "0002b45a7f5d4e8d9c1f000000000003", steamId: "76561198000000001",
  });
  assert.deepEqual(steam!.links, [{ provider: "steam", externalId: "76561198000000001" }]);

  // …and a shape we cannot place is still kept, under the honest name for "account id of an
  // unknown namespace" rather than a wrong one.
  const other = playerIdentityOf(HLLV_GAME, {
    name: "PS", platform: "psn", iD: "0002b45a7f5d4e8d9c1f000000000004", steamId: "9876543210",
  });
  assert.deepEqual(other!.links, [{ provider: "account", externalId: "9876543210" }]);
});
