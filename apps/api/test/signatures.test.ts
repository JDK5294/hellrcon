import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTION_NOTICE_HEADER, signedText, signerFor } from "../dist/routes/kit.js";
import { withIsolatedServer as withServer, jf, ownerAuth, askedFor } from "./harness.ts";
import { fakeGameServer } from "./fake-hll-server.ts";

test("signatures: nothing is signed until somebody says so, and the config round-trips", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);

    // Out of the box: a staff-line template, no second line, and nothing switched on. A feature
    // that silently started appending text to every ban would be a nasty surprise.
    const first = await jf(`${base}/api/signatures`, { headers: auth });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.actions, {});
    assert.equal(first.body.customLine, "");
    assert.match(first.body.staffLine, /\{staff\}/);
    // The signable list comes from the API so the page never invents an action of its own.
    assert.deepEqual((first.body.signable as any[]).map((s) => s.id), ["message", "kick", "punish", "tempban", "permaban"]);

    const put = await jf(`${base}/api/signatures`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({
        staffLine: "- {staff}", customLine: "Appeal at discord.gg/lynx",
        actions: { kick: { staff: true, custom: true }, message: { staff: true, custom: false } },
      }),
    });
    assert.equal(put.status, 200);
    const back = await jf(`${base}/api/signatures`, { headers: auth });
    assert.deepEqual(back.body.actions.kick, { staff: true, custom: true });
    assert.deepEqual(back.body.actions.message, { staff: true, custom: false });

    // An action a player never reads is not signable, so it must not survive being posted.
    const junk = await jf(`${base}/api/signatures`, {
      method: "PUT", headers: auth, body: JSON.stringify({ actions: { switch: { staff: true }, kick: { staff: true, custom: false } } }),
    });
    assert.equal(junk.status, 200);
    assert.deepEqual(Object.keys(junk.body.actions), ["kick"]);

    // A line long enough to push the real reason off the end of the game's display is refused.
    const long = await jf(`${base}/api/signatures`, { method: "PUT", headers: auth, body: JSON.stringify({ customLine: "x".repeat(201) }) });
    assert.equal(long.status, 400);

    // Changing what players are told is on the trail.
    const audit = await jf(`${base}/api/audit`, { headers: auth });
    assert.ok((audit.body.entries as any[]).some((e) => e.action === "signatures.update"));

    // Reading is open to anyone who can act — the action dialogs preview what will be sent — but
    // editing is the templates grant: anyone else can only ask for it.
    await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plain", password: "pw" }) });
    const plain = { authorization: `Bearer ${l.body.token as string}` };
    const config = async () => { const { signable: _, ...rest } = (await jf(`${base}/api/signatures`, { headers: auth })).body; return rest; };
    const before = await config();
    const asked = await jf(`${base}/api/signatures`, { method: "PUT", headers: plain, body: JSON.stringify({ customLine: "x" }) });
    assert.deepEqual(await askedFor(base, auth, asked), { capability: "templates.manage", serverId: null });
    assert.deepEqual(await config(), before, "nothing changed on the asking");
    assert.equal((await jf(`${base}/api/signatures`)).status, 401);
  });
});

/*
 * The part that actually reaches a player. `signerFor` is what the action routes wrap their reason
 * and message in, so this is the join between "what is configured" and "what is sent" — and it is
 * the join where the staff-name rule has to hold: the PANEL name, never the in-game one.
 */
test("signerFor signs with the staff member's panel name, only for the actions that asked", async () => {
  await withServer(async (base, repo, ctx) => {
    const auth = await ownerAuth(base);
    await jf(`${base}/api/signatures`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({
        staffLine: "- {staff}", customLine: "Appeal at discord.gg/lynx",
        actions: { kick: { staff: true, custom: true }, punish: { staff: false, custom: true } },
      }),
    });

    // A staff member whose Discord nick differs from their login — the common case, and the one
    // that makes "which name" a real question rather than a detail.
    const user = await repo.users.create({ username: "jdoe", passwordHash: "x" });
    await repo.users.linkDiscord(user.id, { discordId: "1", username: "jdoe#0", nick: "Jane [LYNX]" });
    const p = { user: (await repo.users.findById(user.id))!, grants: [] } as never;

    const kick = await signerFor(ctx, "kick", p);
    assert.equal(kick("Team killing"), "Team killing\n- Jane [LYNX]\nAppeal at discord.gg/lynx");

    // Second half only: no name, still the appeal line.
    const punish = await signerFor(ctx, "punish", p);
    assert.equal(punish("Team killing"), "Team killing\nAppeal at discord.gg/lynx");

    // An action nobody configured is left exactly as typed.
    const ban = await signerFor(ctx, "permaban", p);
    assert.equal(ban("Aimbot"), "Aimbot");

    // An empty field stays empty — the action routes sign `message` and `reason` alike, and most
    // actions only carry one of them.
    assert.equal(kick(""), "");

    // The signature's own length is measured, so a caller can bound the WHOLE string rather than
    // just the part somebody typed.
    assert.equal(kick.overhead, "\n- Jane [LYNX]\nAppeal at discord.gg/lynx".length);
    assert.equal(ban.overhead, 0, "an unsigned action costs nothing");
  });
});

/*
 * The bound and the signature used to be applied in the wrong order: the typed reason was checked
 * against its 500-character limit and the signature was glued on afterwards, so what reached the
 * game could be nearly a thousand characters. The game truncates in silence, and the signature sits
 * at the END — so the piece it eats is the appeal link, the one part of a ban message that exists
 * to be read. Refused rather than trimmed: a staff member forty characters over can shorten their
 * own wording, but nobody can recover a message the game already swallowed.
 */
test("a reason plus its signature is bounded as one string, and the refusal says why", async () => {
  await withServer(async (base, repo, ctx) => {
    await ownerAuth(base);
    await ctx.repo.signatures.set({
      staffLine: "- {staff}", customLine: "Appeal at discord.gg/lynx",
      actions: { kick: { staff: true, custom: true } },
    });
    const user = await repo.users.create({ username: "jane", passwordHash: "x" });
    const p = { user: (await repo.users.findById(user.id))!, grants: [] } as never;
    const sign = await signerFor(ctx, "kick", p);

    // Exactly at the limit once signed: allowed, and the whole thing fits in 500.
    const room = 500 - sign.overhead;
    assert.equal(signedText(sign, "x".repeat(room), "reason").length, 500);

    // One character more is refused, and the message names the real limit and the reason for it —
    // "max 500" when the field visibly cuts off at 460 would read as a bug.
    assert.throws(() => signedText(sign, "x".repeat(room + 1), "reason"), (err: Error) => {
      assert.match(err.message, new RegExp(`max ${room} characters`));
      assert.match(err.message, /signature/);
      return true;
    });

    // Unsigned, the old limit is untouched: 500 typed characters still go through.
    const unsigned = await signerFor(ctx, "permaban", p);
    assert.equal(signedText(unsigned, "y".repeat(500), "reason").length, 500);
    assert.throws(() => signedText(unsigned, "y".repeat(501), "reason"), /max 500 characters/);
  });
});

/*
 * The game writes its own headline for some actions and not others. A perma ban arrives as
 * "PERMANENTLY BANNED BY THE ADMINISTRATOR!" above the typed reason; a kick arrives as the bare
 * reason. So a player kicked for "stop blocking the spawn" saw a notice that read like an admin
 * message, with an appeal link under it that made no sense, and never learned they were removed.
 *
 * We write the missing line ourselves — and it is part of the same bounded string as the reason
 * and the signature, because anything appended after the bound is what the game silently eats.
 */
test("a kick says it is a kick, and the header is inside the length bound", async () => {
  await withServer(async (base, repo, ctx) => {
    await ownerAuth(base);
    await ctx.repo.signatures.set({
      staffLine: "- {staff}", customLine: "Appeal at discord.gg/lynx",
      actions: { kick: { staff: true, custom: true } },
    });
    const user = await repo.users.create({ username: "jane", passwordHash: "x" });
    const p = { user: (await repo.users.findById(user.id))!, grants: [] } as never;
    const sign = await signerFor(ctx, "kick", p);
    const header = ACTION_NOTICE_HEADER.kick!;

    // Header first, then what the admin typed, then the signature — the order the player reads it.
    const notice = signedText(sign, "Spawn blocking", "reason", 500, header);
    assert.equal(notice, "YOU HAVE BEEN KICKED\nSpawn blocking\n- jane\nAppeal at discord.gg/lynx");

    // No reason given is still a complete message: being told you were kicked is the point.
    assert.equal(signedText(sign, "", "reason", 500, header), "YOU HAVE BEEN KICKED\n- jane\nAppeal at discord.gg/lynx");

    // The header spends the same budget as the signature. Exactly at the limit passes…
    const room = 500 - sign.overhead - (header.length + 1);
    assert.equal(signedText(sign, "x".repeat(room), "reason", 500, header).length, 500);
    // …and one over is refused, naming BOTH costs so the number is explicable.
    assert.throws(() => signedText(sign, "x".repeat(room + 1), "reason", 500, header), (err: Error) => {
      assert.match(err.message, new RegExp(`max ${room} characters`));
      assert.match(err.message, /signature/);
      assert.match(err.message, /YOU HAVE BEEN KICKED/);
      return true;
    });

    // Only the actions the game leaves bare get one. A perma ban already has the game's own
    // headline, and a second would say it twice.
    assert.equal(ACTION_NOTICE_HEADER.permaban, undefined);
    assert.equal(ACTION_NOTICE_HEADER.message, undefined);
  });
});

/*
 * The welcome/notice message: the one signable thing that is a SETTING, not an action. Nobody
 * sends it, so the staff half must be impossible to arm — and the second line must land on BOTH
 * games' wire spellings (SetWelcomeMessage on WW2, SetNoticeMessage on Vietnam), because "the
 * join screen carries our Discord invite" is a community decision, not a per-game one.
 */
test("the welcome/notice message takes only the second line — on both games' wire, never a staff name", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const token = auth.authorization.slice("Bearer ".length);

    // A smuggled staff:true cannot survive the round trip.
    const put = await jf(`${base}/api/signatures`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ staffLine: "- {staff}", customLine: "discord.gg/lynx", actions: { welcome: { staff: true, custom: true } } }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.actions.welcome, { staff: false, custom: true });

    // WW2: the game's word is SetWelcomeMessage, and the saved text gains exactly the second line.
    const ww2 = await fakeGameServer(base, token, "ww2");
    try {
      const r = await jf(`${base}/api/servers/${ww2.serverId}/config`, {
        method: "POST", headers: auth, body: JSON.stringify({ welcomeMessage: "Welcome to the server!" }),
      });
      assert.equal(r.status, 200);
      assert.deepEqual(ww2.fake.welcomeSet, { command: "SetWelcomeMessage", message: "Welcome to the server!\ndiscord.gg/lynx" });
    } finally { ww2.fake.close(); }

    // Vietnam: same logical field, and the game table's own spelling — the line rides along.
    const nam = await fakeGameServer(base, token, "nam", "hllv");
    try {
      const r = await jf(`${base}/api/servers/${nam.serverId}/config`, {
        method: "POST", headers: auth, body: JSON.stringify({ welcomeMessage: "Welcome to the jungle!" }),
      });
      assert.equal(r.status, 200);
      assert.deepEqual(nam.fake.welcomeSet, { command: "SetNoticeMessage", message: "Welcome to the jungle!\ndiscord.gg/lynx" });
    } finally { nam.fake.close(); }

    // Row switched off: what staff type is exactly what the game gets, byte for byte.
    await jf(`${base}/api/signatures`, { method: "PUT", headers: auth, body: JSON.stringify({ actions: { welcome: { custom: false } } }) });
    const off = await fakeGameServer(base, token, "off");
    try {
      await jf(`${base}/api/servers/${off.serverId}/config`, {
        method: "POST", headers: auth, body: JSON.stringify({ welcomeMessage: "Plain text" }),
      });
      assert.deepEqual(off.fake.welcomeSet, { command: "SetWelcomeMessage", message: "Plain text" });
    } finally { off.fake.close(); }
  });
});
