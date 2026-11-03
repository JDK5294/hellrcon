import { test } from "node:test";
import assert from "node:assert/strict";
import { withServer, jf, ownerAuth, askedFor } from "./harness.ts";

async function makeServer(base: string, auth: Record<string, string>) {
  const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "seed", host: "127.0.0.1", port: 1, password: "x" }) });
  return created.body.server.id as string;
}

test("seeding config GET returns defaults then round-trips a PUT", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);

    // GET before any config = defaults, configured:false, and the game's roles for the picker.
    const initial = await jf(`${base}/api/servers/${id}/seeding`, { headers: auth });
    assert.equal(initial.status, 200);
    assert.equal(initial.body.configured, false);
    assert.equal(initial.body.config.enabled, false);
    assert.ok(initial.body.roles && Object.keys(initial.body.roles).length > 0, "roles map served");

    // PUT a config; the disallowed role must be a real descriptor role id.
    const roleId = Number(Object.keys(initial.body.roles)[0]);
    const put = await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: auth, body: JSON.stringify({
      enabled: true, dryRun: false, seedTarget: 30, minPlayers: 4, disallowedRoles: [roleId], rewardHours: 48, rewardPoints: 250,
    }) });
    assert.equal(put.status, 200);
    assert.equal(put.body.config.enabled, true);
    assert.equal(put.body.config.seedTarget, 30);
    assert.deepEqual(put.body.config.disallowedRoles, [roleId]);
    assert.equal(put.body.config.rewardHours, 48);
    // Both halves of the reward round-trip: the worker reads these to decide what to pay.
    assert.equal(put.body.config.rewardPoints, 250);
    // The currency footnote ships with real default text, not an empty string — an existing server
    // that switches points on must not be silent to the seeders who cannot collect them.
    assert.match(String(put.body.config.rewardLinkedNote), /\{currency\}.*\{reward_points\}.*\{balance\}/);
    assert.match(String(put.body.config.rewardUnlinkedNote), /could have earned \{reward_points\}/);

    // GET again reflects the stored config.
    const after = await jf(`${base}/api/servers/${id}/seeding`, { headers: auth });
    assert.equal(after.body.configured, true);
    assert.equal(after.body.config.minPlayers, 4);
    assert.equal(after.body.config.rewardPoints, 250, "the points survive the store, not just the response");

    // audit recorded
    const audit = await jf(`${base}/api/audit`, { headers: auth });
    assert.ok((audit.body.entries as any[]).some((e) => e.action === "seeding.config"));
  });
});

test("seeding config PUT validation", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const put = (body: unknown) => jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: auth, body: JSON.stringify(body) });

    assert.equal((await put({ seedTarget: 0 })).status, 400); // out of range
    assert.equal((await put({ minPlayers: 40, seedTarget: 20 })).status, 400); // min >= target
    assert.equal((await put({ disallowedRoles: [99999] })).status, 400); // unknown role
    assert.equal((await put({ disallowedRoles: "not-an-array" })).status, 400);
    /*
     * The reward's two halves are independent — VIP, points, or both — so ZERO is a legitimate
     * value for each: it means "do not give this one". What cannot be stored is the reward being
     * switched on while both are zero, which promises the seeders something and hands them
     * nothing. Only the MERGE can be judged, because the two arrive from different fields and
     * often in different saves.
     */
    assert.equal((await put({ rewardEnabled: true, rewardHours: 0, rewardPoints: 500 })).status, 200, "points only is a reward");
    assert.equal((await put({ rewardEnabled: true, rewardHours: 12, rewardPoints: 0 })).status, 200, "VIP only is a reward");
    assert.equal((await put({ rewardEnabled: true, rewardHours: 12, rewardPoints: 500 })).status, 200, "both is a reward");
    // …and now zeroing the remaining half, one patch at a time, is what the merge has to catch.
    assert.equal((await put({ rewardPoints: 0 })).status, 200, "still has VIP hours");
    const empty = await put({ rewardHours: 0 });
    assert.equal(empty.status, 400, "on, with nothing to give");
    assert.match(String((empty.body as any).error?.message ?? ""), /gives nothing/);
    // Switched off, an empty reward is simply a reward nobody is offering.
    assert.equal((await put({ rewardEnabled: false, rewardHours: 0, rewardPoints: 0 })).status, 200);
    assert.equal((await put({ rewardPoints: -1 })).status, 400);
    assert.equal((await put({ rewardHours: -1 })).status, 400);
    assert.equal((await put({ rewardPoints: 2_000_000 })).status, 400);
    // The footnote halves are player-facing text, bounded like every other message the seeder sees.
    assert.equal((await put({ rewardLinkedNote: "x".repeat(1001) })).status, 400);
    assert.equal((await put({ rewardUnlinkedNote: "x".repeat(1001) })).status, 400);
    assert.equal((await put({ rewardLinkedNote: "", rewardUnlinkedNote: "" })).status, 200, "blank switches a half off");
    assert.equal((await jf(`${base}/api/servers/does-not-exist/seeding`, { method: "PUT", headers: auth, body: JSON.stringify({ enabled: true }) })).status, 404);
  });
});

test("seeding config requires admin.moderation; status needs server.view", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plain", password: "pw" }) });
    const plain = { authorization: `Bearer ${l.body.token as string}` };

    assert.equal((await jf(`${base}/api/servers/${id}/seeding`, { headers: plain })).status, 403);
    // A server-scoped WRITE without the permission is filed for approval now (202), not
    // refused — the read half beside it still is. See docs/approvals.md.
    assert.equal((await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: plain, body: JSON.stringify({ enabled: true }) })).status, 202);
    // status endpoint is gated by server.view, which the fresh plain user also lacks
    assert.equal((await jf(`${base}/api/servers/${id}/seeding/status`, { headers: plain })).status, 403);
    // unauthenticated
    assert.equal((await jf(`${base}/api/servers/${id}/seeding`)).status, 401);
  });
});

test("seeding status reflects config enabled/dryRun", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    let s = await jf(`${base}/api/servers/${id}/seeding/status`, { headers: auth });
    assert.equal(s.status, 200);
    assert.equal(s.body.enabled, false);

    await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: auth, body: JSON.stringify({ enabled: true, dryRun: true }) });
    s = await jf(`${base}/api/servers/${id}/seeding/status`, { headers: auth });
    assert.equal(s.body.enabled, true);
    assert.equal(s.body.dryRun, true);
    assert.equal(s.body.state, null); // worker hasn't written state in this API-only test
  });
});

/**
 * Weapon rules moved INTO the seeding config from the retired "Seeding rules" module: class chips
 * (validated against the game's own weapon-class table, the way roles are) plus bounded free-text
 * extras. The GET serves the class catalogue so the panel can render chips instead of asking staff
 * to type weapon names.
 */
test("seeding weapon rules: the class catalogue is served, chips validate, extras are bounded", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);

    const initial = await jf(`${base}/api/servers/${id}/seeding`, { headers: auth });
    const classes = initial.body.weaponClasses as { id: string; label: string }[];
    assert.ok(Array.isArray(classes) && classes.length > 0, "the weapon-class catalogue is served for the chips");
    assert.ok(classes.some((c) => c.id === "artillery"), "HLL's artillery class is among them");

    // Round-trip: chips + one free-text extra.
    const put = await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: auth, body: JSON.stringify({
      disallowedWeaponClasses: ["artillery", "armor"], disallowedWeapons: ["150mm"],
    }) });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.config.disallowedWeaponClasses, ["artillery", "armor"]);
    assert.deepEqual(put.body.config.disallowedWeapons, ["150MM"], "extras are stored upper-cased, as they match");

    // A typo'd class id would sit silent in the config matching nothing — refused at the door.
    assert.equal((await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: auth,
      body: JSON.stringify({ disallowedWeaponClasses: ["artilery"] }) })).status, 400);
    // One-character extras would match most of the weapon table.
    assert.equal((await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: auth,
      body: JSON.stringify({ disallowedWeapons: ["M"] }) })).status, 400);
    assert.equal((await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: auth,
      body: JSON.stringify({ disallowedWeapons: Array.from({ length: 41 }, (_, i) => `GUN${i}`) }) })).status, 400);

    // The refusals changed nothing.
    const after = await jf(`${base}/api/servers/${id}/seeding`, { headers: auth });
    assert.deepEqual(after.body.config.disallowedWeaponClasses, ["artillery", "armor"]);
  });
});

/**
 * Individual weapons + commander restrictions. The GET serves the game's whole weapon table
 * (classified, so the panel groups the picker without mirroring the pattern rules) and its
 * commander kill-abilities; picks are validated against those tables the way roles and classes
 * are — they are PICKED, never typed, so an unknown name is a stale client, not a preference.
 */
test("seeding individual weapons and commander abilities: catalogue served, picks validated, both round-trip", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);

    const initial = await jf(`${base}/api/servers/${id}/seeding`, { headers: auth });
    const weapons = initial.body.weapons as { name: string; classId: string }[];
    assert.ok(Array.isArray(weapons) && weapons.length > 100, "the individual weapon table is served");
    const mg42 = weapons.find((w) => w.name === "MG42");
    assert.ok(mg42, "exact CRCON kill-log names are in it");
    assert.equal(mg42!.classId, "mg", "each name arrives already classified for grouping");
    const abilities = initial.body.commanderAbilities as string[];
    assert.deepEqual([...abilities].sort(), ["BOMBING RUN", "PRECISION STRIKE", "STRAFING RUN"],
      "HLL's three commander kill-abilities, nothing else");
    assert.ok(!weapons.some((w) => abilities.includes(w.name)),
      "abilities are their own lever, not rows of the weapon picker");

    // Round-trip: a picked name is stored upper-cased (how it matches), abilities likewise.
    const put = await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: auth, body: JSON.stringify({
      disallowedWeaponNames: ["MG42", "Sherman M4A3E2"], disallowedCommanderAbilities: ["bombing run"],
    }) });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.config.disallowedWeaponNames, ["MG42", "SHERMAN M4A3E2"]);
    assert.deepEqual(put.body.config.disallowedCommanderAbilities, ["BOMBING RUN"]);

    // Unknown names and abilities are refused at the door, and refusals change nothing.
    assert.equal((await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: auth,
      body: JSON.stringify({ disallowedWeaponNames: ["MG-42"] }) })).status, 400, "a near-miss spelling is not a pick");
    assert.equal((await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: auth,
      body: JSON.stringify({ disallowedCommanderAbilities: ["NAPALM STRIKE"] }) })).status, 400);
    const after = await jf(`${base}/api/servers/${id}/seeding`, { headers: auth });
    assert.deepEqual(after.body.config.disallowedWeaponNames, ["MG42", "SHERMAN M4A3E2"]);
    assert.deepEqual(after.body.config.disallowedCommanderAbilities, ["BOMBING RUN"]);
  });
});

/*
 * Switching a server's game clears the seeding config's game-scoped vocabulary. Role numbers,
 * weapon classes, weapon names and commander abilities are one game's language — kept across a
 * switch they would enforce a policy nobody wrote AND wedge the page (every save re-validates the
 * whole config against the new game's tables, refusing ids the UI no longer renders). Free-text
 * extras are plain substrings and survive, as do thresholds, messages and rewards.
 */
test("switching game clears the seeding vocabulary but keeps the behaviour settings", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: auth, body: JSON.stringify({
      disallowedRoles: [1], disallowedWeaponClasses: ["artillery"], disallowedWeaponNames: ["MG42"],
      disallowedCommanderAbilities: ["BOMBING RUN"], disallowedWeapons: ["150MM"], seedTarget: 35,
    }) });

    const sw = await jf(`${base}/api/servers/${id}/game`, { method: "POST", headers: auth, body: JSON.stringify({ game: "hllv" }) });
    assert.equal(sw.status, 200);

    // The audit names the game it CAME from. (The in-memory store hands findById callers a live
    // reference, so before the route captured the old identity up front, setGame's own mutation
    // made this line read "was hllv" — and made the clear below never fire.)
    const audit = await jf(`${base}/api/audit`, { headers: auth });
    const entry = (audit.body.entries as any[]).find((e) => e.action === "server.game");
    assert.match(String(entry?.summary), /was hll \(/, "the audit remembers the old game");
    assert.equal(entry?.data?.seedingCleared, true);

    const after = await jf(`${base}/api/servers/${id}/seeding`, { headers: auth });
    assert.deepEqual(after.body.config.disallowedRoles, [], "role 1 is HLL's Assault and nothing in Vietnam");
    assert.deepEqual(after.body.config.disallowedWeaponClasses, []);
    assert.deepEqual(after.body.config.disallowedWeaponNames, []);
    assert.deepEqual(after.body.config.disallowedCommanderAbilities, []);
    assert.deepEqual(after.body.config.disallowedWeapons, ["150MM"], "free-text substrings are game-neutral");
    assert.equal(after.body.config.seedTarget, 35, "behaviour settings survive");

    // The page is NOT wedged: a full-config PUT (what the editor sends) still saves.
    const resave = await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: auth, body: JSON.stringify(after.body.config) });
    assert.equal(resave.status, 200);
  });
});

test("Vietnam servers get their own weapon table and commander abilities", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const made = await jf(`${base}/api/servers`, { method: "POST", headers: auth,
      body: JSON.stringify({ name: "viet", host: "127.0.0.1", port: 3, password: "x", game: "hllv", protocol: "binary-v2" }) });
    const id = made.body.server.id as string;

    const initial = await jf(`${base}/api/servers/${id}/seeding`, { headers: auth });
    const weapons = initial.body.weapons as { name: string; classId: string }[];
    assert.ok(weapons.length >= 60, "Vietnam's table is served too");
    assert.ok(weapons.some((w) => w.name === "M79"), "the grenade launcher is there, trimmed the way the log reports it");
    assert.deepEqual(initial.body.commanderAbilities, ["NAPALM STRIKE", "STRAFING RUN", "Artillery Strike", "PRECISION STRIKE"]);

    // A Vietnam pick round-trips (upper-cased in storage, like everything the matcher compares).
    const put = await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: auth, body: JSON.stringify({
      disallowedWeaponNames: ["M79"], disallowedCommanderAbilities: ["Artillery Strike"],
    }) });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.config.disallowedWeaponNames, ["M79"]);
    assert.deepEqual(put.body.config.disallowedCommanderAbilities, ["ARTILLERY STRIKE"]);
  });
});

test("the seeding GET serves the announcement exactly as a player will read it", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);

    // Out of the box nothing is restricted, so the preview is the default greeting verbatim —
    // no dangling "Not allowed while seeding:" heading with nothing under it.
    const fresh = await jf(`${base}/api/servers/${id}/seeding`, { headers: auth });
    assert.equal(fresh.body.announcePreview, fresh.body.config.announceMessage);
    assert.ok(!String(fresh.body.announcePreview).includes("Not allowed"));

    await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: auth, body: JSON.stringify({
      announceMessage: "We are seeding!",
      disallowedRoles: [13], disallowedWeaponClasses: ["artillery"],
      disallowedWeaponNames: ["MG42"], disallowedCommanderAbilities: ["BOMBING RUN"],
    }) });

    const after = await jf(`${base}/api/servers/${id}/seeding`, { headers: auth });
    const preview = after.body.announcePreview as string;
    // Composed by the same @app/db code the worker sends with, so the editor cannot show one
    // thing while the server says another — and it renders LABELS, not stored ids.
    assert.match(preview, /^We are seeding!/);
    assert.match(preview, /Roles: Commander/);
    assert.match(preview, /Weapons: Artillery, MG42/);
    assert.match(preview, /Commander abilities: BOMBING RUN/);
    assert.ok(!preview.includes("13"), "role ids never reach a player");
  });
});

/*
 * The seeding texts are the ones the app SENDS TO PLAYERS on a schedule, and they were the only
 * player-facing text with no length limit — a one-shot broadcast is capped at 1000 characters, a
 * message to everyone is capped at 1000, and these were unbounded while going out to every joining
 * player, every cycle. The announcement gained the restriction list on top of that.
 */
test("seeding messages are bounded like every other text the game receives", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const put = (body: unknown) => jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: auth, body: JSON.stringify(body) });

    for (const field of ["announceMessage", "warnMessage", "punishMessage", "kickMessage", "rewardMessage"]) {
      const tooLong = await put({ [field]: "x".repeat(1001) });
      assert.equal(tooLong.status, 400, `${field} must refuse 1001 characters`);
      assert.match(JSON.stringify(tooLong.body), /1000 characters/);
      // The generous-but-sane size still saves: this is a limit, not a straitjacket.
      assert.equal((await put({ [field]: "x".repeat(1000) })).status, 200, `${field} accepts 1000`);
    }
  });
});

test("cap-fight rule round-trips, and the caps threshold keeps CRCON's 2-4 bounds", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const put = (body: unknown) => jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: auth, body: JSON.stringify(body) });

    // Defaults: off, threshold 3, warn first — matching CRCON's enforce_cap_fight defaults.
    const initial = await jf(`${base}/api/servers/${id}/seeding`, { headers: auth });
    assert.equal(initial.body.config.capFightEnabled, false);
    assert.equal(initial.body.config.capFightMaxCaps, 3);
    assert.equal(initial.body.config.capFightSkipWarning, false);

    const saved = await put({ capFightEnabled: true, capFightMaxCaps: 4, capFightSkipWarning: true });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.config.capFightEnabled, true);
    assert.equal(saved.body.config.capFightMaxCaps, 4);
    assert.equal(saved.body.config.capFightSkipWarning, true);
    const after = await jf(`${base}/api/servers/${id}/seeding`, { headers: auth });
    assert.equal(after.body.config.capFightMaxCaps, 4, "stored, not just echoed");

    // CRCON bounds max_caps to ge=2 le=4: below a team always "wins", above the match is over.
    assert.equal((await put({ capFightMaxCaps: 1 })).status, 400);
    assert.equal((await put({ capFightMaxCaps: 5 })).status, 400);
    assert.equal((await put({ capFightMaxCaps: "three" })).status, 400);
    const unchanged = await jf(`${base}/api/servers/${id}/seeding`, { headers: auth });
    assert.equal(unchanged.body.config.capFightMaxCaps, 4, "a refused save changed nothing");
  });
});

test("containment zones: the editor's map list is served, zones validate and round-trip", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const put = (body: unknown) => jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: auth, body: JSON.stringify(body) });

    // The GET hands the editor its map list — zone keys the worker will actually compute.
    const initial = await jf(`${base}/api/servers/${id}/seeding`, { headers: auth });
    const maps = initial.body.containMaps as { key: string; label: string }[];
    assert.ok(Array.isArray(maps) && maps.length > 0, "containMaps served");
    assert.ok(maps.some((m) => m.key === "carentan"), "WW2 families are in the list");

    // A drawn map round-trips; empty maps are dropped rather than stored as noise.
    const zones = {
      carentan: { allies: ["A1", "B2"], axis: ["J10"], shared: ["E5", "F6"] },
      foy: { allies: [], axis: [], shared: [] },
    };
    const saved = await put({ containEnabled: true, containGraceSec: 45, containMaxPlayers: 55, containZones: zones });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.config.containEnabled, true);
    assert.equal(saved.body.config.containGraceSec, 45);
    assert.deepEqual(saved.body.config.containZones.carentan.shared, ["E5", "F6"]);
    assert.equal(saved.body.config.containZones.foy, undefined, "an all-empty map says nothing and stores nothing");
    const after = await jf(`${base}/api/servers/${id}/seeding`, { headers: auth });
    assert.deepEqual(after.body.config.containZones.carentan.allies, ["A1", "B2"], "zones survive the store");

    // The sector vocabulary is closed: only A1–J10, and the shape is exactly three lists.
    assert.equal((await put({ containZones: { carentan: { allies: ["K1"], axis: [], shared: [] } } })).status, 400, "K is off the grid");
    assert.equal((await put({ containZones: { carentan: { allies: ["A11"], axis: [], shared: [] } } })).status, 400, "row 11 does not exist");
    assert.equal((await put({ containZones: { carentan: { allies: "A1", axis: [], shared: [] } } })).status, 400, "a list, not a string");
    assert.equal((await put({ containZones: { "Bad Key!": { allies: ["A1"], axis: [], shared: [] } } })).status, 400, "keys are folded family names");
    assert.equal((await put({ containZones: [] })).status, 400);
    assert.equal((await put({ containGraceSec: -1 })).status, 400);
    // Lower-case cells are normalized, not refused — the picker sends upper, but a preset import may not.
    const lower = await put({ containZones: { carentan: { allies: ["a1"], axis: [], shared: [] } } });
    assert.equal(lower.status, 200);
    assert.deepEqual(lower.body.config.containZones.carentan.allies, ["A1"]);
  });
});

/*
 * The ground rules (containment, pace, the position switch, layout learning) answer to the rules
 * permission on the wire, not just in the panel — admin.moderation on the server, the permission
 * of the Map zones page they are configured on: read to see them, write to change them. A
 * seeding-config staffer without it gets a config that is simply complete without those fields,
 * and their PUT cannot touch them (dropped, so the rest of the save still lands). The restricted
 * screen's permission is no longer any part of it.
 */
test("ground rules answer to the rules permission: absent without it, untouchable without it at write", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const id = await makeServer(base, owner);
    const staffOf = async (username: string, caps: { capability: string; level: string }[]) => {
      const created = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username, password: "pw" }) });
      await jf(`${base}/api/users/${(created.body.user as { id: string }).id}/grants`, {
        method: "PUT", headers: owner,
        body: JSON.stringify({ grants: caps.map((c) => ({ ...c, scopeType: "global", scopeId: null })) }),
      });
      const login = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password: "pw" }) });
      return { authorization: `Bearer ${login.body.token as string}` };
    };
    const blind = await staffOf("blind", [{ capability: "seeding.config", level: "write" }]);
    const cleared = await staffOf("cleared", [{ capability: "seeding.config", level: "write" }, { capability: "admin.moderation", level: "write" }]);
    const reader = await staffOf("reader", [{ capability: "seeding.config", level: "write" }, { capability: "admin.moderation", level: "read" }]);

    // Without the permission: the fields do not exist on the wire, and the editor's map list is
    // not served.
    const blindGet = await jf(`${base}/api/servers/${id}/seeding`, { headers: blind });
    assert.equal(blindGet.status, 200);
    assert.ok(!("containEnabled" in (blindGet.body.config as object)), "the switch is not in their config");
    assert.ok(!("positionalEnabled" in (blindGet.body.config as object)), "nor the position-rules switch");
    assert.ok(!("containZones" in (blindGet.body.config as object)), "nor the zones");
    assert.ok(!("containMaps" in (blindGet.body as object)), "nor the map list");

    // Their PUT silently cannot arm it — 200 (they do hold seeding.config write), nothing stored.
    const smuggle = await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: blind, body: JSON.stringify({
      enabled: true, containEnabled: true, positionalEnabled: true, containZones: { carentan: { allies: ["A1"], axis: [], shared: [] } },
    }) });
    assert.equal(smuggle.status, 200, JSON.stringify(smuggle.body));
    assert.ok(!("containEnabled" in (smuggle.body.config as object)), "the PUT's echo is stripped like the GET");
    // A preset's config body never travels to a browser at all — the snapshot may hold fields its
    // saver isn't cleared to read back.
    const preset = await jf(`${base}/api/presets/seeding`, { method: "POST", headers: blind, body: JSON.stringify({ name: "blind-snap", serverId: id }) });
    assert.equal(preset.status, 200, JSON.stringify(preset.body));
    assert.ok(!("config" in (preset.body.preset as object)), "the save response is the listing shape, not the row");
    const ownerGet = await jf(`${base}/api/servers/${id}/seeding`, { headers: owner });
    assert.equal(ownerGet.body.config.containEnabled, false, "the blind write did not arm containment");
    assert.equal(ownerGet.body.config.positionalEnabled, false, "nor the position-based rules — off by default");
    assert.deepEqual(ownerGet.body.config.containZones, {}, "and drew nothing");
    assert.equal(ownerGet.body.config.enabled, true, "while the field they may set went through");

    // With it at write: the full round trip, exactly as the owner has.
    const set = await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: cleared, body: JSON.stringify({
      containEnabled: true, positionalEnabled: true, containZones: { carentan: { allies: ["A1"], axis: [], shared: [] } },
    }) });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.config.containEnabled, true, "the echo carries them back");
    const clearedGet = await jf(`${base}/api/servers/${id}/seeding`, { headers: cleared });
    assert.equal(clearedGet.body.config.containEnabled, true);
    assert.equal(clearedGet.body.config.positionalEnabled, true, "the switch is set in the app and saved");
    assert.deepEqual(clearedGet.body.config.containZones.carentan.allies, ["A1"]);
    assert.ok(Array.isArray(clearedGet.body.containMaps), "the editor's map list is theirs");

    // At read: they see what is set, and cannot change it.
    const readerGet = await jf(`${base}/api/servers/${id}/seeding`, { headers: reader });
    assert.equal(readerGet.body.config.containEnabled, true, "a reader sees the ground rules");
    const readerPut = await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: reader, body: JSON.stringify({ containEnabled: false, warnMessage: "from the reader" }) });
    assert.equal(readerPut.status, 200, JSON.stringify(readerPut.body));
    const afterReader = await jf(`${base}/api/servers/${id}/seeding`, { headers: owner });
    assert.equal(afterReader.body.config.containEnabled, true, "changing them takes the rules permission at write");
    assert.equal(afterReader.body.config.warnMessage, "from the reader", "while the rest of their save went through");
  });
});

/*
 * Presets are the side door the PUT's fence does not guard: apply writes to the store directly,
 * under seeding.config alone. So the ground rules never ride a preset — left out of the snapshot,
 * and stripped again on apply — or a staffer could overwrite (or arm) rules that take the rules
 * permission to change, and an old snapshot could silently repaint zones drawn since it was saved.
 */
test("presets carry no ground rules: apply cannot touch zones or pace from any hand", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const id = await makeServer(base, owner);
    const armed = await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: owner, body: JSON.stringify({
      containEnabled: true, containZones: { carentan: { allies: ["A1"], axis: [], shared: [] } },
      paceEnabled: true, paceUnlockMinutes: [0, 0, 15, 30, 60],
      warnMessage: "before",
    }) });
    assert.equal(armed.status, 200, JSON.stringify(armed.body));
    // Snapshot NOW (the store holds the armed config), then move both halves on.
    const saved = await jf(`${base}/api/presets/seeding`, { method: "POST", headers: owner, body: JSON.stringify({ name: "armed-snap", serverId: id }) });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: owner, body: JSON.stringify({
      containZones: { carentan: { allies: ["B2"], axis: [], shared: [] } }, paceUnlockMinutes: [0, 0, 20, 40, 60], warnMessage: "after",
    }) });
    // Applying the snapshot restores the open behaviour — and ONLY the open behaviour.
    const applied = await jf(`${base}/api/servers/${id}/presets/seeding/apply`, { method: "POST", headers: owner, body: JSON.stringify({ name: "armed-snap" }) });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    const after = await jf(`${base}/api/servers/${id}/seeding`, { headers: owner });
    assert.equal(after.body.config.warnMessage, "before", "open behaviour came back");
    assert.deepEqual(after.body.config.containZones.carentan.allies, ["B2"], "the zones stayed as drawn since the snapshot");
    assert.deepEqual(after.body.config.paceUnlockMinutes, [0, 0, 20, 40, 60], "and so did the pace schedule");
    assert.equal(after.body.config.containEnabled, true, "apply did not flip the ground rules' switches");
    assert.equal(after.body.config.paceEnabled, true);
  });
});

/*
 * The trail is read under audit.trail, not the rules permission the ground rules answer to, and an
 * audit row used to carry the whole saved patch — zones and pace schedule included — to anyone who
 * could read it. The row still records that the config changed and by whom; the ground rules'
 * VALUES stay off it.
 */
test("the audit trail's seeding rows say nothing about the ground rules", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const id = await makeServer(base, owner);
    const put = await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: owner, body: JSON.stringify({
      warnMessage: "audited", containEnabled: true, containZones: { carentan: { allies: ["A1"], axis: [], shared: [] } },
      paceEnabled: true, paceUnlockMinutes: [0, 0, 15, 30, 60], paceNotice: "hold the line",
    }) });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const trail = await jf(`${base}/api/audit?action=seeding.config`, { headers: owner });
    assert.equal(trail.status, 200, JSON.stringify(trail.body));
    const rows = trail.body.entries as Record<string, unknown>[];
    assert.ok(rows.length >= 1, "the save is on the trail");
    const raw = JSON.stringify(rows);
    for (const word of ["containZones", "containEnabled", "paceUnlockMinutes", "paceNotice", "hold the line"]) {
      assert.ok(!raw.includes(word), `the trail mentions ${word}`);
    }
    assert.ok(raw.includes("audited"), "the open half of the patch is still the record");
  });
});

/*
 * A bridge stop is per-server wiring (this server's seeders get VIP on THAT one), and a preset
 * carried it like behaviour. Applied elsewhere, it skipped every check the seeding screen makes on a
 * stop: the server it was applied to could end up paying a stop on itself (twice a round there), and
 * whoever applied it needed no VIP key on any stop. Presets now leave the bridge alone both ways.
 */
test("a seeding preset never carries the reward bridge, and leaves the server's own as it was", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const mk = async (name: string, port: number) =>
      (await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name, host: "127.0.0.1", port, password: "x" }) })).body.server.id as string;
    const alpha = await mk("preset-alpha", 51);
    const bravo = await mk("preset-bravo", 52);
    const charlie = await mk("preset-charlie", 53);
    const seed = (id: string, body: unknown) => jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: auth, body: JSON.stringify(body) });
    assert.equal((await seed(alpha, { rewardEnabled: true, rewardHours: 24, rewardBridge: [{ serverId: bravo, hours: 24 }], warnMessage: "seed it" })).status, 200);
    assert.equal((await seed(charlie, { rewardBridge: [{ serverId: alpha, hours: 12 }] })).status, 200);
    const name = `bridge-preset-${alpha.slice(0, 8)}`;
    assert.equal((await jf(`${base}/api/presets/seeding`, { method: "POST", headers: auth, body: JSON.stringify({ name, serverId: alpha }) })).status, 200);
    assert.ok(!("rewardBridge" in ((await repo.featurePresets.get("seeding", name))!.config)), "the snapshot leaves the bridge out");

    // Someone who may change seeding on Bravo and Charlie and holds no VIP key anywhere.
    const u = await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: `seeder-${alpha.slice(0, 8)}`, password: "pw" }) });
    await jf(`${base}/api/users/${u.body.user.id as string}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants: [bravo, charlie].map((scopeId) => ({ capability: "seeding.config", level: "write", scopeType: "server", scopeId })) }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: `seeder-${alpha.slice(0, 8)}`, password: "pw" }) });
    const seeder = { authorization: `Bearer ${l.body.token as string}` };
    const config = async (id: string) => (await jf(`${base}/api/servers/${id}/seeding`, { headers: auth })).body.config;
    for (const id of [bravo, charlie]) {
      const before = (await config(id)).rewardBridge;
      assert.equal((await jf(`${base}/api/servers/${id}/presets/seeding/apply`, { method: "POST", headers: seeder, body: JSON.stringify({ name }) })).status, 200);
      const after = await config(id);
      assert.equal(after.warnMessage, "seed it", "the behaviour arrives");
      assert.deepEqual(after.rewardBridge, before, "and the bridge stays the server's own");
    }
    // A preset saved before this, still holding a bridge, cannot bring it in either.
    await repo.featurePresets.save({ feature: "seeding", name: `${name}-old`, config: { rewardBridge: [{ serverId: bravo, hours: 48 }] }, game: "hll", createdByName: "t" });
    assert.equal((await jf(`${base}/api/servers/${bravo}/presets/seeding/apply`, { method: "POST", headers: seeder, body: JSON.stringify({ name: `${name}-old` }) })).status, 200);
    assert.deepEqual((await config(bravo)).rewardBridge, [], "no stop on itself");
  });
});

test("the bridge: stops round-trip, answer to vip.grant THERE, and the shapes that lie are refused", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const seeded = await makeServer(base, auth);
    const mk = async (name: string, port: number, game?: string) =>
      (await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name, host: "127.0.0.1", port, password: "x", ...(game ? { game, protocol: "binary-v2" } : {}) }) })).body.server.id as string;
    const ww2 = await mk("bridge-ww2", 45);
    const viet = await mk("bridge-viet", 46, "hllv");
    const put = (body: unknown, headers = auth) => jf(`${base}/api/servers/${seeded}/seeding`, { method: "PUT", headers, body: JSON.stringify(body) });

    // Shapes that lie: the seeded server as its own stop, the same stop twice, a stop that pays
    // nothing, a server that does not exist, and a retired server (a parked server takes no new
    // payouts — the worker skips one that retires later, this refuses saving one already parked).
    assert.equal((await put({ rewardBridge: [{ serverId: seeded, hours: 24 }] })).status, 400);
    assert.equal((await put({ rewardBridge: [{ serverId: ww2, hours: 24 }, { serverId: ww2, hours: 48 }] })).status, 400);
    assert.equal((await put({ rewardBridge: [{ serverId: ww2, hours: 0 }] })).status, 400);
    assert.equal((await put({ rewardBridge: [{ serverId: "00000000-0000-4000-8000-00000000dead", hours: 24 }] })).status, 400);
    const parked = await mk("bridge-parked", 47);
    await jf(`${base}/api/servers/${parked}/retire`, { method: "POST", headers: auth });
    const onParked = await put({ rewardBridge: [{ serverId: parked, hours: 24 }] });
    assert.equal(onParked.status, 400);
    assert.match(JSON.stringify(onParked.body), /retired/);

    // The real thing — 3 days on the same game, 1 day across it — survives the store.
    const ok = await put({ rewardBridge: [{ serverId: ww2, hours: 72 }, { serverId: viet, hours: 24 }] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const back = await jf(`${base}/api/servers/${seeded}/seeding`, { headers: auth });
    assert.deepEqual(back.body.config.rewardBridge, [{ serverId: ww2, hours: 72 }, { serverId: viet, hours: 24 }]);

    // The key rule: a stop grants VIP on ANOTHER server, so adding or changing one answers to
    // vip.grant THERE — the seeding keys here are not that key. An untouched stop keeps standing on
    // its original authority, so holding the key to one server does not lock a colleague out of
    // the rest of the seeding screen. (The bridge is part of the seed reward, so the colleague
    // holds Seeding rewards here too, as every seeding holder did after the upgrade split it off.)
    const u = await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "bridge-mod", password: "pw" }) });
    await jf(`${base}/api/users/${u.body.user.id as string}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants: [
      { capability: "seeding.config", level: "write", scopeType: "server", scopeId: seeded },
      { capability: "seeding.rewards", level: "write", scopeType: "server", scopeId: seeded },
      { capability: "vip.grant", level: "write", scopeType: "server", scopeId: ww2 },
    ] }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "bridge-mod", password: "pw" }) });
    const mod = { authorization: `Bearer ${l.body.token as string}` };
    // Touching the Vietnam stop without vip.grant there: asked for, not saved. The request names
    // the server whose seeding screen it changes (that is where it is replayed); signing it
    // re-checks the key on the stop's own server.
    const asked = await put({ rewardBridge: [{ serverId: ww2, hours: 72 }, { serverId: viet, hours: 48 }] }, mod);
    assert.deepEqual(await askedFor(base, auth, asked), { capability: "vip.grant", serverId: seeded });
    assert.deepEqual((await jf(`${base}/api/servers/${seeded}/seeding`, { headers: auth })).body.config.rewardBridge, [{ serverId: ww2, hours: 72 }, { serverId: viet, hours: 24 }], "nothing saved on the asking");
    // Changing only the stop they hold the key to, restating the other as it stands: fine.
    const edited = await put({ rewardBridge: [{ serverId: ww2, hours: 96 }, { serverId: viet, hours: 24 }] }, mod);
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.deepEqual(edited.body.config.rewardBridge, [{ serverId: ww2, hours: 96 }, { serverId: viet, hours: 24 }]);
    // Removing a stop narrows the reward and needs no key at all.
    const narrowed = await put({ rewardBridge: [{ serverId: ww2, hours: 96 }] }, mod);
    assert.equal(narrowed.status, 200);

    // A stop whose target retires LATER must never brick the screen: the panel restates the whole
    // config on every save, so the standing row passes untouched (the worker skips it at payout,
    // with the reason on every receipt) — only CHANGING that stop re-opens the question, and the
    // answer is the same retired refusal a new row gets.
    await jf(`${base}/api/servers/${ww2}/retire`, { method: "POST", headers: auth });
    const restated = await put({ rewardBridge: [{ serverId: ww2, hours: 96 }], warnMessage: "unrelated edit still saves" });
    assert.equal(restated.status, 200, JSON.stringify(restated.body));
    const bumped = await put({ rewardBridge: [{ serverId: ww2, hours: 120 }] });
    assert.equal(bumped.status, 400);
    assert.match(JSON.stringify(bumped.body), /retired/);
  });
});

/*
 * PAY LAST SEED: the missed-payout lever. The endpoint only QUEUES a replay of the archived
 * cycle — refusing the cases where a replay would be wrong (already paid, nobody qualified,
 * nothing archived) — and the worker consumes the request exactly once.
 */
test("pay last seed: refuses paid or empty cycles, queues an unpaid one exactly once", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const id = await makeServer(base, owner);
    const url = `${base}/api/servers/${id}/seeding/pay-last`;
    const pay = () => jf(url, { method: "POST", headers: owner, body: "{}" });

    assert.equal((await pay()).status, 400, "seeding disabled: nothing to run the payout");
    const cfg = await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: owner, body: JSON.stringify({ enabled: true, rewardEnabled: true, rewardHours: 24, minSeedMinutes: 10 }) });
    assert.equal(cfg.status, 200, JSON.stringify(cfg.body));
    // A replay that could only SIMULATE is refused up front — dry-run first, then observe mode.
    await repo.seeding.setLastCycle(id, { endedAt: "2026-09-25T12:00:00.000Z", rewarded: false, entries: [{ playerId: "p1", name: "A", seconds: 900 }] });
    assert.match(JSON.stringify((await pay()).body), /dry-run is on/);
    await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: owner, body: JSON.stringify({ dryRun: false }) });
    // A new server starts in observe mode (the schema default).
    assert.match(JSON.stringify((await pay()).body), /observe mode/);
    const activated = await jf(`${base}/api/servers/${id}/engagement`, { method: "POST", headers: owner, body: JSON.stringify({ mode: "active" }) });
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    // A cycle that drained, or a go-live the delay suppressed, is not a missed payout.
    await repo.seeding.setLastCycle(id, { endedAt: "2026-09-25T12:00:00.000Z", rewarded: false, wentLive: false, entries: [{ playerId: "p1", name: "A", seconds: 900 }] });
    assert.match(JSON.stringify((await pay()).body), /without going live/);
    await repo.seeding.setLastCycle(id, { endedAt: "2026-09-25T12:00:00.000Z", rewarded: false, debounced: true, entries: [{ playerId: "p1", name: "A", seconds: 900 }] });
    assert.match(JSON.stringify((await pay()).body), /reward delay/);
    await repo.seeding.setLastCycle(id, { endedAt: "2026-09-25T12:00:00.000Z", rewarded: false, entries: [] });

    const none = await pay();
    assert.equal(none.status, 400);
    assert.match(JSON.stringify(none.body), /minimum seed time/i, "an empty cycle has nobody to pay");

    await repo.seeding.setLastCycle(id, { endedAt: "2026-09-25T12:00:00.000Z", rewarded: true, entries: [{ playerId: "p1", name: "A", seconds: 900 }] });
    assert.match(JSON.stringify((await pay()).body), /already paid/i);

    await repo.seeding.setLastCycle(id, { endedAt: "2026-09-25T12:00:00.000Z", rewarded: false, entries: [{ playerId: "p1", name: "A", seconds: 60 }] });
    assert.match(JSON.stringify((await pay()).body), /minimum seed time/i);

    await repo.seeding.setLastCycle(id, { endedAt: "2026-09-25T12:00:00.000Z", rewarded: false, entries: [
      { playerId: "p1", name: "A", seconds: 900 }, { playerId: "p2", name: "B", seconds: 30 },
    ] });
    // The panel's button reads the summary off the status route.
    const st = await jf(`${base}/api/servers/${id}/seeding/status`, { headers: owner });
    assert.equal(st.body.lastCycle.rewarded, false);
    assert.equal(st.body.lastCycle.qualifying, 1);
    const ok = await pay();
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.qualifying, 1);
    // The worker only runs the consuming UPDATE when the state row it already reads says a
    // request is waiting — so the flag must read true here, and false once consumed.
    assert.equal((await repo.seeding.getState(id))?.payRequested, true, "the waiting request shows on the state row");
    // …and the worker's side of the handshake fires exactly once per request.
    assert.equal(await repo.seeding.takePayRequest(id), true);
    assert.ok(!(await repo.seeding.getState(id))?.payRequested, "consumed: nothing waiting (no row, or a row that says false)");
    assert.equal(await repo.seeding.takePayRequest(id), false, "a consumed request never pays twice");
  });
});

/*
 * The payouts view: the receipts, per server, grouped by round — with a FAILED seeder shown as
 * failed (the silence that made a round look like it paid "only staff"), and bridge receipts
 * written here for a round seeded elsewhere kept out of this server's list.
 */
test("seed payouts: receipts grouped by round, failures flagged, bridge rows excluded", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const id = await makeServer(base, owner);
    const receipt = (targetId: string, summary: string, data: Record<string, unknown>) => repo.audit.create({
      actorUserId: null, actorName: "seeding", action: "seed.reward", targetType: "player",
      targetId, targetName: targetId, serverId: id, summary, data,
    });
    await receipt("a", "granted 1d of VIP to a (seed reward)", { round: "seed:r1", hours: 24 });
    await receipt("b", "seed reward FAILED for b: (400) command AddVip failed", { round: "seed:r1", failed: "(400)" });
    await receipt("c", "granted 100 Points to c (seed reward) — VIP NOT granted, the game refused", { round: "seed:r1", vipFailed: "the game refused" });
    await receipt("d", "granted 1d of VIP to d on Other (seed reward bridge from X)", { bridgeFrom: "elsewhere", hours: 24 });
    await receipt("e", "granted 1d of VIP to e (seed reward)", { round: "seed:r2", hours: 24, pointsSkipped: "no link" });

    const r = await jf(`${base}/api/servers/${id}/seeding/payouts`, { headers: owner });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rounds = r.body.rounds as { round: string; receipts: { playerId: string; outcome: string }[] }[];
    assert.equal(rounds.length, 2, "two rounds; the bridge row is not a seeder of this server");
    const r1 = rounds.find((x) => x.round === "seed:r1")!;
    assert.deepEqual(r1.receipts.map((x) => x.playerId).sort(), ["a", "b", "c"]);
    assert.equal(r1.receipts.find((x) => x.playerId === "b")!.outcome, "failed");
    assert.equal(r1.receipts.find((x) => x.playerId === "c")!.outcome, "failed", "VIP refused is a failure, even with points paid");
    assert.equal(r1.receipts.find((x) => x.playerId === "a")!.outcome, "paid");
    assert.equal(rounds.find((x) => x.round === "seed:r2")!.receipts[0]!.outcome, "partial");
  });
});

/*
 * RETRY: a round that paid but did not finish paying everyone is retried for its owed parts —
 * the same button, a "retry" mode. And the payouts view shows each seeder's CURRENT state: a
 * retry's receipt carries the original round id and supersedes the FAILED one.
 */
test("pay last seed retries a paid round's still-owed seeders, and the view shows the retry", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const id = await makeServer(base, owner);
    await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: owner, body: JSON.stringify({ enabled: true, dryRun: false, rewardEnabled: true, rewardHours: 24, minSeedMinutes: 10 }) });
    await jf(`${base}/api/servers/${id}/engagement`, { method: "POST", headers: owner, body: JSON.stringify({ mode: "active" }) });
    const pay = () => jf(`${base}/api/servers/${id}/seeding/pay-last`, { method: "POST", headers: owner, body: "{}" });
    const entries = [{ playerId: "p1", name: "A", seconds: 900 }, { playerId: "p2", name: "B", seconds: 900 }];

    // Paid with nothing owed: still "already paid".
    await repo.seeding.setLastCycle(id, { endedAt: "2026-09-25T12:00:00.000Z", rewarded: true, round: "seed:R", failed: [], entries });
    assert.match(JSON.stringify((await pay()).body), /already paid/);

    // Paid, one seeder still owed their VIP: a retry is queued, for them alone.
    await repo.seeding.setLastCycle(id, { endedAt: "2026-09-25T12:00:00.000Z", rewarded: true, round: "seed:R", entries,
      failed: [{ playerId: "p2", name: "B", needVip: true, needPoints: false, needBridge: false, reason: "the game refused" }] });
    const st = await jf(`${base}/api/servers/${id}/seeding/status`, { headers: owner });
    assert.equal(st.body.lastCycle.owed, 1, "the panel is told what is owed");
    const r = await pay();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.mode, "retry");
    assert.equal(r.body.qualifying, 1);
    assert.equal(await repo.seeding.takePayRequest(id), true, "one request for the worker to take");

    // The view: the retry's receipt (same round id, newer) supersedes the FAILED one. A few ms
    // apart, so the newest-first order the view relies on is never a timestamp tie.
    const receipt = async (targetId: string, summary: string, data: Record<string, unknown>) => { await new Promise((ok) => setTimeout(ok, 5)); return repo.audit.create({
      actorUserId: null, actorName: "seeding", action: "seed.reward", targetType: "player",
      targetId, targetName: targetId, serverId: id, summary, data,
    }); };
    await receipt("p1", "granted 1d of VIP to p1 (seed reward)", { round: "seed:R", hours: 24 });
    await receipt("p2", "granted nothing to p2 (seed reward) — VIP NOT granted, the game refused", { round: "seed:R", vipFailed: "the game refused" });
    await receipt("p3", "granted 1d of VIP to p3 (seed reward)", { round: "seed:OTHER", hours: 24 });
    await receipt("p2", "granted 1d of VIP to p2 (seed reward)", { round: "seed:R", hours: 24, manual: true, retry: true });
    const v = await jf(`${base}/api/servers/${id}/seeding/payouts`, { headers: owner });
    const rounds = v.body.rounds as { round: string; manual: boolean; receipts: { playerId: string; outcome: string }[] }[];
    const R = rounds.find((x) => x.round === "seed:R")!;
    assert.equal(rounds.filter((x) => x.round === "seed:R").length, 1, "the retry joined its round, even with another round between");
    assert.deepEqual(R.receipts.map((x) => `${x.playerId}:${x.outcome}`).sort(), ["p1:paid", "p2:paid"], "p2's current state is paid");
    assert.equal(R.manual, true, "the round shows it was partly paid late");
  });
});

/*
 * Per-LAYER zones and learned layouts. A layer key ("@stmereeglise_warfare") is paint in its own
 * right; the learned layouts — with the prefill each implies — reach only holders of the rules
 * permission, and the learning switch is guarded like every other ground rule.
 */
test("layer zones round-trip; learned layouts and the learn switch are need-to-know", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const id = await makeServer(base, owner);
    const put = await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: owner, body: JSON.stringify({
      containZones: { "@stmereeglise_warfare": { allies: ["A1"], axis: ["J10"], shared: [] } },
      layoutLearnEnabled: false,
    }) });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body.config.containZones["@stmereeglise_warfare"].allies, ["A1"]);
    assert.equal(put.body.config.layoutLearnEnabled, false);
    assert.equal((await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: owner, body: JSON.stringify({
      containZones: { "@Bad Layer!": { allies: ["A1"], axis: [], shared: [] } } }) })).status, 400, "layer keys are folded ids");

    // Two agreeing rounds teach the layer. A second vote from the SAME match (a worker restart
    // mid-round) is ignored, so one round can never count twice.
    assert.ok(await repo.mapLayouts.record("StMereEglise_Warfare", { axis: "x", alliesDir: -1, separation: 90_000, round: "m1" }));
    assert.equal(await repo.mapLayouts.record("stmereeglise_warfare", { axis: "x", alliesDir: -1, separation: 90_000, round: "m1" }), null, "same match, no second vote");
    assert.equal((await repo.mapLayouts.get("stmereeglise_warfare"))!.xNeg, 1);
    await repo.mapLayouts.record("stmereeglise_warfare", { axis: "x", alliesDir: -1, separation: 90_000, round: "m2" });
    await repo.mapLayouts.record("foy_warfare", { axis: "y", alliesDir: 1, separation: 70_000 });
    const got = await jf(`${base}/api/servers/${id}/seeding`, { headers: owner });
    const learned = got.body.learnedLayouts as Record<string, { status: string; axis?: string; prefill?: { allies: string[]; shared: string[] } }>;
    assert.equal(learned["@stmereeglise_warfare"]!.status, "learned");
    assert.equal(learned["@stmereeglise_warfare"]!.axis, "x");
    assert.ok(learned["@stmereeglise_warfare"]!.prefill!.allies.includes("B1"), "the prefill paints the allies' end…");
    assert.ok(!learned["@stmereeglise_warfare"]!.prefill!.allies.includes("A1"), "…less its HQ line, which nobody is judged on");
    assert.deepEqual(learned["@stmereeglise_warfare"]!.prefill!.shared, [], "and the middle is left empty, free for both");
    assert.equal(learned["@foy_warfare"]!.status, "learning", "one round is still learning");
    // Auto zones fences warfare layers only — the painter shows its zones there — and a paint
    // on the layer's family covers it too, so the family key rides along.
    const entry = (k: string) => learned[k] as unknown as { autoZone?: boolean; family?: string };
    assert.equal(entry("@stmereeglise_warfare").autoZone, true);
    assert.equal(entry("@stmereeglise_warfare").family, "stmereeglise");
    await repo.mapLayouts.record("foy_offensive_ger", { axis: "y", alliesDir: 1, separation: 70_000, round: "o1" });
    await repo.mapLayouts.record("foy_offensive_ger", { axis: "y", alliesDir: 1, separation: 70_000, round: "o2" });
    const off = (await jf(`${base}/api/servers/${id}/seeding`, { headers: owner })).body.learnedLayouts["@foy_offensive_ger"] as { status: string; autoZone?: boolean };
    assert.equal(off.status, "learned");
    assert.equal(off.autoZone, false, "an offensive layer is never auto-zoned");

    // Without the rules permission: no learned layouts, no switch, and a PUT cannot flip it.
    const created = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "blind-layout", password: "pw" }) });
    await jf(`${base}/api/users/${(created.body.user as { id: string }).id}/grants`, { method: "PUT", headers: owner,
      body: JSON.stringify({ grants: [{ capability: "seeding.config", level: "write", scopeType: "global", scopeId: null }] }) });
    const login = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "blind-layout", password: "pw" }) });
    const blind = { authorization: `Bearer ${login.body.token as string}` };
    const blindGet = await jf(`${base}/api/servers/${id}/seeding`, { headers: blind });
    assert.ok(!("learnedLayouts" in (blindGet.body as object)));
    assert.ok(!("layoutLearnEnabled" in (blindGet.body.config as object)));
    await jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: blind, body: JSON.stringify({ layoutLearnEnabled: true }) });
    assert.equal((await jf(`${base}/api/servers/${id}/seeding`, { headers: owner })).body.config.layoutLearnEnabled, false, "the blind write did not flip it");
  });
});

test("seeding check speed: set in the app, bounded, blank = the default", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const put = (body: unknown) => jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: auth, body: JSON.stringify(body) });
    const set = await put({ checkSec: 60, chaseCheckSec: 15 });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const read = await jf(`${base}/api/servers/${id}/seeding`, { headers: auth });
    assert.equal(read.body.config.checkSec, 60);
    assert.equal(read.body.config.chaseCheckSec, 15);
    assert.equal((await put({ checkSec: 2 })).status, 400, "too fast would hammer the game server");
    assert.equal((await put({ checkSec: 3600 })).status, 400, "too slow would leave the rules asleep");
    assert.equal((await put({ chaseCheckSec: 120 })).status, 400);
    assert.equal((await put({ checkSec: null, chaseCheckSec: "" })).status, 200);
    const back = await jf(`${base}/api/servers/${id}/seeding`, { headers: auth });
    assert.equal(back.body.config.checkSec, null, "blank = the install default again");
    assert.equal(back.body.config.chaseCheckSec, null);
  });
});

test("seed repeat window: the already-paid message saves, is bounded, and has a default", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const first = await jf(`${base}/api/servers/${id}/seeding`, { headers: auth });
    assert.equal(first.body.config.rewardDelaySec, 3600, "an hour by default");
    assert.match(first.body.config.rewardRepeatMessage as string, /\{window\}/, "the default names the window");
    const put = (body: unknown) => jf(`${base}/api/servers/${id}/seeding`, { method: "PUT", headers: auth, body: JSON.stringify(body) });
    assert.equal((await put({ rewardRepeatMessage: "Seeded! See you in {window}.", rewardDelaySec: 5400 })).status, 200);
    const read = await jf(`${base}/api/servers/${id}/seeding`, { headers: auth });
    assert.equal(read.body.config.rewardRepeatMessage, "Seeded! See you in {window}.");
    assert.equal(read.body.config.rewardDelaySec, 5400);
    assert.equal((await put({ rewardRepeatMessage: "x".repeat(1001) })).status, 400, "sent in game, so capped like the reward message");
    assert.equal((await put({ rewardRepeatMessage: "" })).status, 200, "blank = say nothing");
    assert.equal((await jf(`${base}/api/servers/${id}/seeding`, { headers: auth })).body.config.rewardRepeatMessage, "");
  });
});
