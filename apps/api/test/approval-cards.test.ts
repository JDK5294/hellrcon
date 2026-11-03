/**
 * What an approver actually READS in Discord. The card is the only place some staff ever see a
 * request, so its sentences are asserted here rather than inferred from the relay's send.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// From dist: approval-cards.ts imports siblings by .js specifier, which strip-types cannot resolve
// back to .ts (same reason the analytics tests read dist).
import { renderCard, postApprovalCard, updateApprovalCard } from "../dist/approval-cards.js";
import { createAppContext } from "../dist/app.js";
import { createIsolatedRepository, APPROVALS_RELAY_KV_NS } from "@app/db";
import type { ApprovalLineRow, ApprovalRequestRow } from "@app/db";

function line(p: Partial<ApprovalLineRow>): ApprovalLineRow {
  return {
    id: "l1", requestId: "r1", seq: 0, serverId: "s1", capability: "player.kick", kind: "kick",
    payload: {}, playerId: "76561", playerName: "Bandit", state: "pending",
    decidedByUserId: null, decidedByName: null, decidedAt: null, denyReason: null, modified: null,
    appliedAt: null, applyError: null, createdAt: "2026-08-01T00:00:00.000Z",
    ...p,
  };
}

function request(lines: ApprovalLineRow[], p: Partial<ApprovalRequestRow> = {}): ApprovalRequestRow {
  return {
    id: "r1", requesterUserId: "u1", requesterName: "TrialMod", status: "open", note: null,
    createdAt: "2026-08-01T00:00:00.000Z", submittedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: null, resolvedAt: null, updatedAt: null, parkedAt: null, lines,
    ...p,
  };
}

const names = (id: string | null) => (id ? ({ s1: "Server 1" } as Record<string, string>)[id] ?? "?" : null);
const content = (r: ApprovalRequestRow) => String((renderCard(r, names, null) as { content: string }).content);

test("a server-scoped line names its server", () => {
  const c = content(request([line({ kind: "kick", payload: { reason: "team killing" } })]));
  assert.match(c, /\*\*Kick\*\* Bandit on Server 1/);
  assert.match(c, /“team killing”/);
});

test("a watchlist line names no server — it belongs to the person, not a server", () => {
  // Watch and unwatch are filed with serverId null (a watch follows the player community-wide).
  // Rendering them through a resolver that answers "?" for anything it cannot find used to print
  // "Add to watchlist Bandit on ?" — a card asking somebody to sign a decision about a server that
  // does not exist.
  const c = content(request([
    line({ id: "l1", serverId: null, capability: "player.watchlist", kind: "watch", payload: { reason: "smurf suspicion" } }),
    line({ id: "l2", seq: 1, serverId: null, capability: "player.watchlist.curate", kind: "unwatch", payload: {} }),
  ]));
  assert.match(c, /\*\*Add to watchlist\*\* Bandit · “smurf suspicion”/);
  assert.match(c, /\*\*Take off the watchlist\*\* Bandit(\n|$)/);
  assert.doesNotMatch(c, / on \?/);
  assert.doesNotMatch(c, / on null/);
});

test("a server that has since been deleted still reads as unknown, not as no server at all", () => {
  const c = content(request([line({ serverId: "gone" })]));
  assert.match(c, /on \?/);
});

test("a filed CALL reads as its label, names no player, and shows what it would send", () => {
  const c = content(request([line({
    kind: "route", capability: "action.message", playerId: null, playerName: null,
    payload: {
      method: "POST", route: "/api/servers/:id/broadcast/send", url: "/api/servers/s1/broadcast/send",
      params: { id: "s1" }, label: "Broadcast to the server",
      body: { message: "Restarting in 10 minutes", dryRun: false },
    },
  })]));
  assert.match(c, /\*\*Broadcast to the server\*\* on Server 1/);
  assert.match(c, /message: “Restarting in 10 minutes”/);
  assert.match(c, /dryRun: false/);
  // No "?" standing in for the player a call does not have.
  assert.doesNotMatch(c, /server\*\* \? on/);
});

test("a filed CALL whose subject lives in the path names it before its body", () => {
  // The card and the panel queue say the same words here (apps/panel/lib/requestLines.ts). Without
  // the path parameter this line read "Rename a map on Server 1 · name: ..." — an approver cannot
  // sign a rename without knowing which map. The server's own id stays out; the line has it.
  const c = content(request([line({
    kind: "route", capability: "maps.catalogue", playerId: null, playerName: null,
    payload: {
      method: "PUT", route: "/api/servers/:id/maps/:mapId/name", url: "/api/servers/s1/maps/foy_warfare/name",
      params: { id: "s1", mapId: "foy_warfare" }, label: "Rename a map", body: { name: "Foy (Warfare)" },
    },
  })]));
  // The underscore goes out escaped, which Discord shows as typed (see the card's typed-text test).
  assert.match(c, /\*\*Rename a map\*\* on Server 1 · mapId: foy\\_warfare · name: “Foy \(Warfare\)”/);
  assert.doesNotMatch(c, /id: s1/);
});

/*
 * Everything a card quotes was typed by somebody — the player's name above all, which the player
 * chose. Discord reads it as formatting: a clan tag "*KLM*" lost its asterisks to italics, and a
 * name or reason "[x](https://…)" showed as a link on the card people press Approve under.
 */
test("a card shows names and typed words as written, never as Discord formatting", () => {
  const c = content(request([
    line({ playerName: "*KLM* Sm_ith", payload: { reason: "said [free VIP](https://phish.example) in chat" } }),
    line({ id: "l2", seq: 1, kind: "vip", capability: "vip.grant", playerName: "[Click](https://evil.example)", payload: { days: 30, comment: "paid via ~~PayPal~~" },
      state: "denied", decidedByName: "_Head_", denyReason: "**no**" }),
  ], { requesterName: "trial*mod", note: "see `logs`" }));
  assert.match(c, /from \*\*trial\\\*mod\*\*/, "the requester's name");
  assert.match(c, /\n> see \\`logs\\`/, "the note");
  assert.match(c, /\*\*Kick\*\* \\\*KLM\\\* Sm\\_ith on Server 1/, "the clan tag keeps its asterisks");
  assert.match(c, /“said \\\[free VIP\\\]\(https:\/\/phish\.example\) in chat”/, "no disguised link, the address whole");
  assert.match(c, /\*\*Grant VIP\*\* \\\[Click\\\]\(https:\/\/evil\.example\) on Server 1/, "a name is never a link");
  assert.match(c, /comment “paid via \\~\\~PayPal\\~\\~”/);
  assert.match(c, /denied by \*\*\\_Head\\_\*\*: “\\\*\\\*no\\\*\\\*”/, "who decided, and why");
});

test("a card stays under Discord's limit whatever the request: long lines cut, the rest counted with where to find them", () => {
  // A bundle that does not fit in one Discord message is refused outright — it never posted, so
  // nobody approving from Discord ever saw it.
  const long = "x".repeat(900);
  const many = request(Array.from({ length: 40 }, (_, i) => line({ id: `l${i}`, seq: i, kind: "tempban", playerName: `Player${i}`, payload: { hours: 24, reason: `griefing the HQ on round ${i} — ${"spawn camping ".repeat(4)}` } })), { note: long });
  const c = content(many);
  assert.ok(c.length <= 1800, `the card is ${c.length} characters`);
  assert.match(c, /^✋ \*\*Approval request\*\* from \*\*TrialMod\*\*/, "the head always shows");
  assert.match(c, /Player0 on Server 1/, "the first lines show");
  assert.match(c, /…and \d+ more lines — every line is under Moderation → Requests in the panel$/);
  assert.ok(!c.includes(long), "a long note is cut");
  // One enormous line is cut on its own, not left to sink the card.
  const one = content(request([line({ payload: { reason: "r".repeat(1500) } })]));
  assert.ok(one.length <= 1800);
  assert.match(one, /…$/);
  // A request that fits shows every line and no footer.
  assert.doesNotMatch(content(request([line({})])), /more line/);
});

test("a VIP revoke says what signing ends: a permanent grant is flagged, a dated one says until when, the note shows", () => {
  const permanent = content(request([line({ kind: "vipRevoke", capability: "vip.revoke", playerName: "Donor", payload: { playerId: "76561", grant: { expiration: null, comment: "paid — PayPal" } } })]));
  assert.match(permanent, /\*\*Revoke VIP\*\* Donor on Server 1 · ⚠️ ends \*\*permanent\*\* VIP · note “paid — PayPal”/);
  const dated = content(request([line({ kind: "vipRevoke", capability: "vip.revoke", payload: { playerId: "76561", grant: { expiration: "2026-12-01T00:00:00.000Z", comment: null } } })]));
  assert.match(dated, /VIP until <t:\d+:D>/);
  assert.doesNotMatch(dated, /permanent|note/);
});

test("a VIP grant says what signing grants: a permanent one is called out, a dated one says until when, and its comment shows", () => {
  // Every VIP added carries a comment — who paid, what for, which event — and the approver is the
  // one vouching for it, so the card shows it beside what the grant gives.
  const permanent = content(request([line({ kind: "vip", capability: "vip.grant", playerName: "Donor", payload: { playerId: "76561", mode: "permanent", comment: "paid $25 — PayPal" } })]));
  assert.match(permanent, /\*\*Grant VIP\*\* Donor on Server 1 · \*\*permanent\*\* VIP · comment “paid \$25 — PayPal”/);
  const dated = content(request([line({ kind: "vip", capability: "vip.grant", payload: { playerId: "76561", mode: "until", expiresAt: "2026-12-01T00:00:00.000Z", comment: "event winner" } })]));
  assert.match(dated, /\*\*Grant VIP\*\* Bandit on Server 1 · VIP until <t:\d+:D> · comment “event winner”/);
  assert.doesNotMatch(dated, /permanent/);
  const length = content(request([line({ kind: "vip", capability: "vip.grant", payload: { playerId: "76561", mode: "duration", days: 30, comment: "paid $10 for 30 days" } })]));
  assert.match(length, /\*\*Grant VIP\*\* Bandit on Server 1 · 30d · comment “paid \$10 for 30 days”/);
  // A selection's grant is a filed call, and its comment comes fifth in the body: it is read
  // first all the same, rather than left behind "+N more".
  const selection = content(request([line({
    kind: "route", capability: "vip.grant", playerId: null, playerName: null,
    payload: {
      method: "POST", route: "/api/servers/:id/vips/bulk", url: "/api/servers/s1/vips/bulk",
      params: { id: "s1" }, label: "Grant VIP to the selection",
      body: { players: [{ playerId: "76561" }], mode: "duration", days: 1, hours: 0, cumulative: true, comment: "seeded the server" },
    },
  })]));
  assert.match(selection, /\*\*Grant VIP to the selection\*\* on Server 1 · comment: “seeded the server” · mode: “duration” · days: 1 · hours: 0 · \+1 more · changes players/);
});

test("an open card carries the buttons; a resolved one keeps the story without the levers", () => {
  const open = renderCard(request([line({})]), names, "9") as { components: unknown[]; content: string };
  assert.equal(open.components.length, 1);
  assert.match(open.content, /^<@&9> ✋ \*\*Approval request\*\* from \*\*TrialMod\*\*/);
  const closed = renderCard(
    request([line({ state: "approved", decidedByName: "SeniorSam" })], { status: "resolved" }),
    names, "9",
  ) as { components: unknown[]; content: string };
  assert.deepEqual(closed.components, []);
  assert.match(closed.content, /approved by \*\*SeniorSam\*\*/);
  // No role ping on a card nobody has to act on.
  assert.doesNotMatch(closed.content, /<@&9>/);
});

/**
 * The record the expiry sweep depends on.
 *
 * A request that nobody signs in time is expired by the WORKER, which knows nothing about how a
 * request is worded — so the card kept its ✋ and its working Approve/Deny buttons on something
 * that had closed days before. The API leaves the rendered text beside the message id, and that is
 * what lets the sweep close the card without re-rendering it. If this stops being stored, the
 * sweep silently stops closing cards.
 */
test("posting a card stores its text with the message id, and an edit keeps that copy current", async () => {
  const { repo, cleanup } = await createIsolatedRepository();
  const realFetch = globalThis.fetch;
  const priorToken = process.env.DISCORD_TOKEN;
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify({ id: "msg1" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  process.env.DISCORD_TOKEN = "t";
  try {
    const ctx = await createAppContext(repo, { port: 0, sessionSecret: "test", webRoot: null });
    await repo.appConfig.set({ approvalsChannelId: "chan1" });
    const user = await repo.users.create({ username: "trialmod", passwordHash: "x" });
    const req = await repo.approvals.create({ requesterUserId: user.id, requesterName: "TrialMod", status: "open" });
    await repo.approvals.addLine(req.id, {
      serverId: null, capability: "player.watchlist", kind: "watch",
      payload: { reason: "smurf suspicion" }, playerId: "765", playerName: "Bandit",
    });
    await repo.approvals.submit(req.id, new Date(Date.now() + 3_600_000).toISOString());

    await postApprovalCard(ctx, req.id);
    const stored = (await repo.pluginKv.get(APPROVALS_RELAY_KV_NS, req.id)) as { channelId?: string; messageId?: string; content?: string } | null;
    assert.equal(stored?.channelId, "chan1");
    assert.equal(stored?.messageId, "msg1");
    assert.equal(stored?.content, sent[0]!.body.content, "the stored text is exactly what was posted");
    assert.match(String(stored?.content), /Add to watchlist\*\* Bandit/);

    // A decision re-renders the card; the stored copy has to follow, or the sweep would close an
    // expired request with the text it had before any of its lines were signed.
    const lineId = (await repo.approvals.get(req.id))!.lines[0]!.id;
    await repo.approvals.decideLine(lineId, { state: "denied", byUserId: user.id, byName: "SeniorSam", denyReason: "not enough" });
    await updateApprovalCard(ctx, req.id);
    const after = (await repo.pluginKv.get(APPROVALS_RELAY_KV_NS, req.id)) as { content?: string } | null;
    assert.match(String(after?.content), /denied by \*\*SeniorSam\*\*/);
    assert.notEqual(after?.content, stored?.content);
  } finally {
    globalThis.fetch = realFetch;
    if (priorToken === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = priorToken;
    await cleanup();
  }
});
