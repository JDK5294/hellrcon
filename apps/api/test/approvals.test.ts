import { test } from "node:test";
import assert from "node:assert/strict";
import { withIsolatedServer as withServer, jf } from "./harness.ts";

/*
 * The approvals spine, end to end: lacking the write turns the SAME action route into a filing
 * cabinet — validated exactly like an execution, then parked for a signature. No grant gates
 * asking (lacking the permission IS the ask). Who may sign is one rule (never the requester;
 * only someone who could do it themselves, there), lines resolve one by one with names on them,
 * denials carry reasons, and an approval that could not reach the game says so on the line
 * instead of reading as done.
 */

async function login(base: string, u: string, p: string) {
  const r = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: u, password: p }) });
  return { authorization: `Bearer ${r.body.token as string}` };
}
async function owner(base: string) {
  await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  const auth = await login(base, "owner", "pw");
  const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "t", host: "127.0.0.1", port: 1, password: "x" }) });
  return { auth, serverId: (created.body.server as { id: string }).id };
}
/** A user holding the given personal grants, logged in. */
async function staff(base: string, auth: Record<string, string>, username: string, grants: unknown[]) {
  await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username, password: "pw" }) });
  const id = ((await jf(`${base}/api/users`, { headers: auth })).body.users as any[]).find((u) => u.username === username).id as string;
  const r = await jf(`${base}/api/users/${id}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants }) });
  assert.equal(r.status, 200, `grants for ${username}: ${JSON.stringify(r.body)}`);
  return { id, auth: await login(base, username, "pw") };
}

test("lacking the write files the action instead of firing it; signatures, denials and stamps", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    // No action grants at all — asking needs none.
    const junior = await staff(base, auth, "junior", [
      { capability: "server.view", level: "read" },
    ]);

    // The same route, the same validation — bad input is refused BEFORE anything is filed.
    assert.equal((await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: junior.auth, body: JSON.stringify({ action: "message", playerId: "76561198000000001" }) })).status, 400, "a message with no text never becomes a request");

    const filed = await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: junior.auth, body: JSON.stringify({ action: "message", playerId: "76561198000000001", playerName: "Rowdy", message: "calm down please" }) });
    assert.equal(filed.status, 202, JSON.stringify(filed.body));
    assert.equal(filed.body.requested, true, "202: accepted, not performed");
    const requestId = filed.body.requestId as string;

    // The requester sees it under "mine"; it is nobody's to sign in their own queue.
    const mineView = await jf(`${base}/api/requests`, { headers: junior.auth });
    assert.equal((mineView.body.mine as any[]).length, 1);
    assert.equal((mineView.body.queue as any[]).length, 0, "your own request is never in your queue");
    const mineLine = (mineView.body.mine as any[])[0].lines[0];
    assert.equal(mineLine.state, "pending");
    assert.equal(mineLine.canSign, false, "the requester cannot sign their own line");

    // A write-holder sees it in the queue, annotated as signable.
    const q = await jf(`${base}/api/requests`, { headers: auth });
    const queued = (q.body.queue as any[]).find((r) => r.id === requestId);
    assert.ok(queued, "the owner's queue holds the request");
    assert.equal(queued.lines[0].canSign, true);

    // …while someone with no relevant write sees an empty queue.
    const bystander = await staff(base, auth, "bystander", [{ capability: "server.view", level: "read" }]);
    assert.equal(((await jf(`${base}/api/requests`, { headers: bystander.auth })).body.queue as any[]).length, 0);

    // The requester cannot sign it — not because it is theirs, but because they still lack the
    // write. (Gain the write later and they may cover it; see the promotion test.)
    const lineId = queued.lines[0].id as string;
    const selfTry = await jf(`${base}/api/requests/${requestId}/lines/${lineId}/approve`, { method: "POST", headers: junior.auth, body: "{}" });
    assert.equal(selfTry.status, 403);
    assert.match(String(selfTry.body.error?.message ?? ""), /you could do yourself/);

    // Denial requires a reason — it is the answer the requester is waiting for.
    assert.equal((await jf(`${base}/api/requests/${requestId}/lines/${lineId}/deny`, { method: "POST", headers: auth, body: "{}" })).status, 400);
    const denied = await jf(`${base}/api/requests/${requestId}/lines/${lineId}/deny`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "talk to them in Discord first" }) });
    assert.equal(denied.status, 200);
    // A second decision on the same line loses cleanly, whoever makes it.
    assert.equal((await jf(`${base}/api/requests/${requestId}/lines/${lineId}/deny`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "again" }) })).status, 409);

    // The lone line decided → the request settles, and the requester reads the reason.
    const after = ((await jf(`${base}/api/requests`, { headers: junior.auth })).body.mine as any[])[0];
    assert.equal(after.status, "resolved");
    assert.equal(after.lines[0].state, "denied");
    assert.equal(after.lines[0].denyReason, "talk to them in Discord first");
    assert.equal(after.lines[0].decidedByName, "owner");

    // The whole conversation is on the audit trail.
    const audit = (await jf(`${base}/api/audit`, { headers: auth })).body.entries as any[];
    assert.ok(audit.some((e) => e.action === "request.file"));
    assert.ok(audit.some((e) => e.action === "request.deny" && String(e.summary).includes("talk to them in Discord first")));

    // And nothing widened: the junior still cannot execute directly — a kick with no write
    // files a request rather than firing, whatever the action.
    const kick = await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: junior.auth, body: JSON.stringify({ action: "kick", playerId: "76561198000000001", reason: "x" }) });
    assert.equal(kick.status, 202, "a kick without the write files too");
    void repo;
  });
});

test("approval executes on the approver's authority, credited to the requester — modification only shrinks, failure is recorded on the line", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    const junior = await staff(base, auth, "junior2", [
      { capability: "server.view", level: "read" },
    ]);

    // A 10h temp ban, asked for by someone who cannot issue one (no grant needed to ask).
    const filed = await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: junior.auth, body: JSON.stringify({ action: "tempban", playerId: "76561198000000002", playerName: "Griefer", reason: "spawn camping", hours: 10 }) });
    assert.equal(filed.status, 202);
    const reqId = filed.body.requestId as string;
    const line = ((await jf(`${base}/api/requests/${reqId}`, { headers: auth })).body.request as any).lines[0];

    // Granting MORE than was asked is a new request, not a modification.
    const up = await jf(`${base}/api/requests/${reqId}/lines/${line.id}/approve`, { method: "POST", headers: auth, body: JSON.stringify({ modified: { hours: 24 } }) });
    assert.equal(up.status, 400);
    assert.match(String(up.body.error?.message ?? ""), /only be modified DOWN/);

    // Approve at 2h of the 10 asked. The game server is unreachable in this test, so the
    // approval STANDS but the line says plainly it was not applied — never a silent success.
    const ok = await jf(`${base}/api/requests/${reqId}/lines/${line.id}/approve`, { method: "POST", headers: auth, body: JSON.stringify({ modified: { hours: 2 } }) });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.applyError, "the dead server is reported, not swallowed");
    const settled = (await jf(`${base}/api/requests/${reqId}`, { headers: auth })).body.request as any;
    assert.equal(settled.status, "resolved");
    assert.equal(settled.lines[0].state, "approved");
    assert.deepEqual(settled.lines[0].modified, { hours: { requested: 10, granted: 2 } });
    assert.equal(settled.lines[0].applyError, ok.body.applyError);
    assert.ok(((await jf(`${base}/api/audit`, { headers: auth })).body.entries as any[])
      .some((e) => e.action === "request.approve" && String(e.summary).includes("10→2")));

    // A VIP grant on a PAUSED grant executes fully (the pause already took it off the game, so
    // nothing needs the unreachable server): the ledger moves and the approver signs the audit.
    const pid = "76561198000000003";
    await repo.vips.upsert({ serverId, playerId: pid, playerName: "Donor", expiration: new Date(Date.now() + 86_400_000).toISOString(), createdByName: "owner" });
    await repo.vips.setPause(serverId, pid, { until: new Date(Date.now() + 3_600_000).toISOString(), reason: "t", by: "owner" });
    // Asked for without a comment, it is refused before anything is filed — the line lands as a
    // grant once signed, so it carries the grant's comment from the start.
    const silentAsk = await jf(`${base}/api/servers/${serverId}/vips`, { method: "POST", headers: junior.auth, body: JSON.stringify({ playerId: pid, mode: "duration", days: 1, cumulative: true }) });
    assert.equal(silentAsk.status, 400, JSON.stringify(silentAsk.body));
    assert.match(String(silentAsk.body.error?.message ?? ""), /a comment is required for every VIP added/);
    const vipAsk = await jf(`${base}/api/servers/${serverId}/vips`, { method: "POST", headers: junior.auth, body: JSON.stringify({ playerId: pid, mode: "duration", days: 1, cumulative: true, comment: "event winner" }) });
    assert.equal(vipAsk.status, 202, JSON.stringify(vipAsk.body));
    const vipReq = (await jf(`${base}/api/requests/${vipAsk.body.requestId}`, { headers: auth })).body.request as any;
    const before = (await repo.vips.get(serverId, pid))!.expiration!;
    const approve = await jf(`${base}/api/requests/${vipReq.id}/lines/${vipReq.lines[0].id}/approve`, { method: "POST", headers: auth, body: "{}" });
    assert.equal(approve.status, 200);
    assert.equal(approve.body.applyError, null, "no game call needed — the pause has it off the game");
    assert.ok(Date.parse((await repo.vips.get(serverId, pid))!.expiration!) > Date.parse(before), "the day landed on the ledger");
    // Credit follows the ask: the grant is audited under the REQUESTER, with the approver who
    // authorised it and the request that carried it both recorded on the row.
    const vipRow = ((await jf(`${base}/api/audit`, { headers: auth })).body.entries as any[])
      .find((e) => e.action === "vip.grant" && e.data?.requestId === vipReq.id);
    assert.ok(vipRow, "the executed action is audited with the request threaded through");
    assert.equal(vipRow.actorName, "junior2", "the person who asked for it gets the credit");
    assert.equal(vipRow.data?.comment ?? (await repo.vips.get(serverId, pid))!.comment, "event winner", "with the comment they filed it under");
    assert.equal(vipRow.data?.approvedBy, "owner", "…and the person who signed it is on the row");
  });
});

test("approve-all signs only what THIS approver could do; withdraw and expiry close the rest", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    const junior = await staff(base, auth, "junior3", [
      { capability: "server.view", level: "read" },
    ]);
    // A mid-tier signer: may message, may NOT permaban.
    const mod = await staff(base, auth, "mod3", [{ capability: "action.message", level: "write" }]);

    // Two asks → two requests (the fast path files one action at a time; bundles are the builder's).
    const m = await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: junior.auth, body: JSON.stringify({ action: "message", playerId: "1", message: "hello" }) });
    const b = await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: junior.auth, body: JSON.stringify({ action: "permaban", playerId: "1", reason: "cheating" }) });
    assert.equal(m.status, 202); assert.equal(b.status, 202);

    // The mod's queue holds only the request they can help with.
    const modQ = (await jf(`${base}/api/requests`, { headers: mod.auth })).body.queue as any[];
    assert.equal(modQ.length, 1, "the permaban request is not offered to someone who cannot sign any of it");
    assert.equal(modQ[0].id, m.body.requestId);

    // Approve-all on the message request: signed (execution fails on the dead server, recorded).
    const all = await jf(`${base}/api/requests/${m.body.requestId}/approve-all`, { method: "POST", headers: mod.auth });
    assert.equal(all.status, 200);
    assert.equal((all.body.approved as any[]).length, 1);

    // Approve-all by the mod on the permaban request: nothing theirs to sign → a clean refusal.
    const none = await jf(`${base}/api/requests/${b.body.requestId}/approve-all`, { method: "POST", headers: mod.auth });
    assert.equal(none.status, 409);

    // Withdraw: only the requester, only while open. Decided lines would keep their stamps.
    assert.equal((await jf(`${base}/api/requests/${b.body.requestId}/withdraw`, { method: "POST", headers: mod.auth })).status, 403);
    const withdrawn = await jf(`${base}/api/requests/${b.body.requestId}/withdraw`, { method: "POST", headers: junior.auth });
    assert.equal(withdrawn.status, 200);
    assert.equal((withdrawn.body.request as any).status, "withdrawn");
    assert.equal((withdrawn.body.request as any).lines[0].state, "voided");

    // Expiry: an open request past its deadline ages out, lines voided, trail told.
    const f = await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: junior.auth, body: JSON.stringify({ action: "message", playerId: "2", message: "stale" }) });
    // Rewind its deadline (the route files at now+TTL; the sweep reads the stored expiry).
    const stale = await repo.approvals.get(f.body.requestId as string);
    assert.ok(stale);
    // Recreate the deadline in the past through the repo's own contract: withdraw is not it —
    // expireDue only reads expires_at, so set it by re-filing at repo level.
    const draft = await repo.approvals.create({ requesterUserId: stale!.requesterUserId, requesterName: stale!.requesterName });
    await repo.approvals.addLine(draft.id, { capability: "action.message", kind: "message", payload: { playerId: "3", message: "old" }, serverId, playerId: "3" });
    await repo.approvals.submit(draft.id, new Date(Date.now() - 1000).toISOString());
    // The deadline binds AT SIGNING, not only when the sweep gets around to it: in the window
    // between the deadline and the sweep the request still reads "open", and an approval there
    // would execute something the contract says aged out. It vanishes from queues the same way.
    const pastLine = (await repo.approvals.get(draft.id))!.lines[0]!;
    const late = await jf(`${base}/api/requests/${draft.id}/lines/${pastLine.id}/approve`, { method: "POST", headers: auth, body: "{}" });
    assert.equal(late.status, 403, JSON.stringify(late.body));
    assert.match(String(late.body.error?.message ?? ""), /expired/);
    assert.ok(!((await jf(`${base}/api/requests`, { headers: auth })).body.queue as any[]).some((r) => r.id === draft.id), "past-deadline requests are not offered in the queue");
    const expired = await repo.approvals.expireDue(new Date().toISOString());
    assert.ok(expired.some((r) => r.id === draft.id));
    const closed = await repo.approvals.get(draft.id);
    assert.equal(closed!.status, "expired");
    assert.equal(closed!.lines[0]!.state, "voided");

    // The race, at the store: the second decision on a pending line loses with null.
    const race = await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: junior.auth, body: JSON.stringify({ action: "message", playerId: "4", message: "race" }) });
    const raceReq = (await repo.approvals.get(race.body.requestId as string))!;
    const first = await repo.approvals.decideLine(raceReq.lines[0]!.id, { state: "denied", byUserId: "8d1a6f2e-0000-4000-8000-000000000001", byName: "A", denyReason: "no" });
    const second = await repo.approvals.decideLine(raceReq.lines[0]!.id, { state: "approved", byUserId: "8d1a6f2e-0000-4000-8000-000000000002", byName: "B" });
    assert.ok(first);
    assert.equal(second, null, "one winner, one 'already handled' — never a double execution");
  });
});

/*
 * The builder: request mode's server half. Capture runs the same validation as execution and
 * appends to the user's ONE draft; nothing reaches the game until submit, when lines the
 * requester holds at write execute under their own name and the rest file as one bundle.
 */
test("the builder captures validated lines, splits fates at submit, and leaves no draft behind", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    // Mixed authority: may message outright; a permaban is beyond them, so it can only file.
    const mixed = await staff(base, auth, "mixed", [
      { capability: "action.message", level: "write" },
    ]);

    // Nothing to submit yet.
    assert.equal((await jf(`${base}/api/requests/draft/submit`, { method: "POST", headers: mixed.auth, body: "{}" })).status, 400);

    // Capture validates exactly like execution — a message with no text never enters the cart.
    assert.equal((await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: mixed.auth, body: JSON.stringify({ action: "message", playerId: "9", draft: true }) })).status, 400);

    const c1 = await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: mixed.auth, body: JSON.stringify({ action: "message", playerId: "9", playerName: "Rowdy", message: "settle down", draft: true }) });
    assert.equal(c1.status, 202, JSON.stringify(c1.body));
    assert.equal(c1.body.captured, true);
    assert.equal(c1.body.lines, 1);
    const c2 = await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: mixed.auth, body: JSON.stringify({ action: "permaban", playerId: "9", playerName: "Rowdy", reason: "repeat offender", draft: true }) });
    assert.equal(c2.status, 202);
    assert.equal(c2.body.lines, 2);
    // One server per line — a scoped ban cannot be captured.
    assert.equal((await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: mixed.auth, body: JSON.stringify({ action: "permaban", playerId: "9", reason: "x", scope: { mode: "all" }, draft: true }) })).status, 400);

    // NOTHING fired: no message audit, no ban decision, while the cart was being filled.
    const audit0 = (await jf(`${base}/api/audit`, { headers: auth })).body.entries as any[];
    assert.ok(!audit0.some((e) => e.action === "player.message" || e.action === "player.permaban"), "capture executes nothing");

    // The review read: each line badged with its fate at THIS user's grants.
    const draft = (await jf(`${base}/api/requests/draft`, { headers: mixed.auth })).body.draft as any;
    assert.equal(draft.lines.length, 2);
    assert.equal(draft.lines.find((l: any) => l.kind === "message").fate, "immediate");
    assert.equal(draft.lines.find((l: any) => l.kind === "permaban").fate, "ask");

    // Reviewing means being able to drop a row: remove the message line, then re-add it.
    const msgLine = draft.lines.find((l: any) => l.kind === "message");
    assert.equal((await jf(`${base}/api/requests/draft/lines/${msgLine.id}`, { method: "DELETE", headers: mixed.auth })).status, 200);
    await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: mixed.auth, body: JSON.stringify({ action: "message", playerId: "9", playerName: "Rowdy", message: "settle down", draft: true }) });

    // Submit: the write-held line executes NOW under the requester's own name (the dead test
    // server makes it fail — recorded on the line, never silent); the ask line files.
    const sub = await jf(`${base}/api/requests/draft/submit`, { method: "POST", headers: mixed.auth, body: "{}" });
    assert.equal(sub.status, 200);
    assert.equal((sub.body.applied as any[]).length, 1);
    assert.ok((sub.body.applied as any[])[0].error, "the unreachable server is reported on the executed line");
    assert.ok(sub.body.filed, "the permaban went to the queue");

    // The draft is spent; the request is open on its ask line, with the executed line stamped.
    assert.equal((await jf(`${base}/api/requests/draft`, { headers: mixed.auth })).body.draft, null);
    const mine = ((await jf(`${base}/api/requests`, { headers: mixed.auth })).body.mine as any[])[0];
    assert.equal(mine.status, "open");
    assert.equal(mine.lines.find((l: any) => l.kind === "message").state, "executed");
    assert.equal(mine.lines.find((l: any) => l.kind === "message").decidedByName, "mixed");
    assert.equal(mine.lines.find((l: any) => l.kind === "permaban").state, "pending");

    // The owner signs the remaining line; the bundle resolves.
    const permaLine = mine.lines.find((l: any) => l.kind === "permaban");
    assert.equal((await jf(`${base}/api/requests/${mine.id}/lines/${permaLine.id}/approve`, { method: "POST", headers: auth, body: "{}" })).status, 200);
    assert.equal(((await jf(`${base}/api/requests/${mine.id}`, { headers: auth })).body.request as any).status, "resolved");

    // The trail reads the split plainly.
    assert.ok(((await jf(`${base}/api/audit`, { headers: auth })).body.entries as any[])
      .some((e) => e.action === "request.file" && String(e.summary).includes("1 applied under their own permissions, 1 filed")));

    // The cart takes ANY validated action, held or not — a VIP grant with no vip.grant at all
    // captures like everything else, and its fate is decided at submit.
    const silentLine = await jf(`${base}/api/servers/${serverId}/vips`, { method: "POST", headers: mixed.auth, body: JSON.stringify({ playerId: "9", mode: "duration", days: 1, draft: true }) });
    assert.equal(silentLine.status, 400, "a VIP line without its comment is refused, not captured");
    assert.match(String(silentLine.body.error?.message ?? ""), /a comment is required for every VIP added/);
    const vipAny = await jf(`${base}/api/servers/${serverId}/vips`, { method: "POST", headers: mixed.auth, body: JSON.stringify({ playerId: "9", mode: "duration", days: 1, draft: true, comment: "event winner" }) });
    assert.equal(vipAny.status, 202, JSON.stringify(vipAny.body));
    assert.equal(vipAny.body.captured, true);
    void repo;
  });
});

/*
 * The over-cap split: a temp ban past the actor's own hour cap executes AT the cap now — that
 * much was always theirs to give — and the remainder files for approval. Approval serves the
 * FULL sentence measured in time actually banned (a gap after the capped ban lapsed is playtime
 * nobody can retroactively unplay), by moving the SAME decision's expiry — one sentence, never a
 * ban/unban/ban zigzag. Denial needs no rollback.
 */
test("over-cap tempban: capped now, remainder approved (or voided by an unban)", async () => {
  const { fakeGameServer } = await import("./fake-hll-server.ts");
  await withServer(async (base, repo) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const token = l.body.token as string;
    const auth = { authorization: `Bearer ${token}` };
    const s = await fakeGameServer(base, token, "live");
    try {
      // A moderator capped at 2 hours.
      await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "capped", password: "pw" }) });
      const cappedRow = ((await jf(`${base}/api/users`, { headers: auth })).body.users as any[]).find((u) => u.username === "capped");
      assert.ok(cappedRow, "capped user exists");
      const limitSet = await jf(`${base}/api/users/${cappedRow.id}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants: [{ capability: "action.tempban", level: "write" }], limits: { "tempban.maxHours": 2 } }) });
      assert.equal(limitSet.status, 200, JSON.stringify(limitSet.body));
      const cl = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "capped", password: "pw" }) });
      const capped = { auth: { authorization: `Bearer ${cl.body.token as string}` } };

      const pid = "76561198000000501";
      const r = await jf(`${base}/api/servers/${s.serverId}/actions`, { method: "POST", headers: capped.auth, body: JSON.stringify({ action: "tempban", playerId: pid, playerName: "Griefer", reason: "teamkilling", hours: 10 }) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual({ a: r.body.split?.appliedHours, q: r.body.split?.requestedHours }, { a: 2, q: 10 }, "the split is announced");
      assert.equal(s.fake.tempBans.get(pid)?.hours, 2, "the game got the CAPPED ban immediately");
      const decision = (await repo.playerBans.list({ playerId: pid, activeOnly: true }))[0]!;
      const twoH = Date.parse(decision.expiresAt!) - Date.now();
      assert.ok(twoH > 1.9 * 3_600_000 && twoH < 2.1 * 3_600_000, "the decision records the capped sentence for now");

      // The extension sits in the queue with the arithmetic on it.
      const q = (await jf(`${base}/api/requests`, { headers: auth })).body.queue as any[];
      const ext = q.find((x) => x.id === r.body.split.requestId);
      assert.ok(ext, "the remainder was filed");
      assert.equal(ext.lines[0].kind, "tempban_extend");

      // Approved DOWN to 4h total: the same decision's expiry moves (served ≈ 0 here, so ≈ 4h
      // out), and the game gets the remainder — one sentence, no unban in the middle.
      const ok = await jf(`${base}/api/requests/${ext.id}/lines/${ext.lines[0].id}/approve`, { method: "POST", headers: auth, body: JSON.stringify({ modified: { hours: 4 } }) });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.applyError, null);
      const moved = (await repo.playerBans.get(decision.id))!;
      const fourH = Date.parse(moved.expiresAt!) - Date.now();
      assert.ok(fourH > 3.9 * 3_600_000 && fourH < 4.1 * 3_600_000, `the sentence grew to ~4h (got ${(fourH / 3_600_000).toFixed(2)}h)`);
      assert.ok((s.fake.tempBans.get(pid)?.hours ?? 0) >= 4, "the game holds the remainder");
      assert.ok(((await jf(`${base}/api/audit`, { headers: auth })).body.entries as any[])
        .some((e) => e.action === "player.tempban" && String(e.summary).includes("extended") && String(e.summary).includes("4h total")));

      // In the CART the same over-cap ban must not claim "applies immediately": executing it
      // would only bounce off the capper's own limit. The fate says ask, submit files it, and
      // the (uncapped) approver's signature executes the full sentence.
      const pid3 = "76561198000000503";
      assert.equal((await jf(`${base}/api/servers/${s.serverId}/actions`, { method: "POST", headers: capped.auth, body: JSON.stringify({ action: "tempban", playerId: pid3, playerName: "Third", reason: "x", hours: 10, draft: true }) })).status, 202);
      const draftView = (await jf(`${base}/api/requests/draft`, { headers: capped.auth })).body.draft as any;
      assert.equal(draftView.lines[0].fate, "ask", "over the actor's cap is not theirs to apply");
      const subm = await jf(`${base}/api/requests/draft/submit`, { method: "POST", headers: capped.auth, body: "{}" });
      assert.equal(subm.status, 200);
      assert.equal((subm.body.applied as any[]).length, 0, "nothing executed under a cap it exceeds");
      assert.ok(subm.body.filed, "the over-cap ban went for a signature");
      const filedReq = (await jf(`${base}/api/requests/${subm.body.filed}`, { headers: auth })).body.request as any;
      assert.equal((await jf(`${base}/api/requests/${filedReq.id}/lines/${filedReq.lines[0].id}/approve`, { method: "POST", headers: auth, body: "{}" })).status, 200);
      assert.equal(s.fake.tempBans.get(pid3)?.hours, 10, "the approver's signature lands the full ask");

      // An unban voids the extension: approving after a deliberate release must not re-ban.
      const pid2 = "76561198000000502";
      const r2 = await jf(`${base}/api/servers/${s.serverId}/actions`, { method: "POST", headers: capped.auth, body: JSON.stringify({ action: "tempban", playerId: pid2, playerName: "Other", reason: "x", hours: 10 }) });
      assert.equal(r2.status, 200);
      await repo.playerBans.liftAllFor(pid2, "owner", "temp");
      const q2 = (await jf(`${base}/api/requests`, { headers: auth })).body.queue as any[];
      const ext2 = q2.find((x) => x.id === r2.body.split.requestId);
      const gone = await jf(`${base}/api/requests/${ext2.id}/lines/${ext2.lines[0].id}/approve`, { method: "POST", headers: auth, body: "{}" });
      assert.equal(gone.status, 200);
      assert.match(String(gone.body.applyError), /lifted/, "the approval stands but honestly reports there was nothing to extend");
    } finally { s.fake.close(); }
  });
});

/*
 * The builder's visibility ceiling: an OPEN DRAFT is the server-verifiable "I am building a
 * request", and while one exists the user's READ view widens — everything readable by default,
 * capped at what the configured ceiling role can see. Read only, ever: no write gate, submit
 * fate, or signature widens, and the elevation vanishes with the draft.
 */
test("an open draft elevates read under the ceiling — never write, gone with the draft", async () => {
  await withServer(async (base) => {
    const { auth } = await owner(base);
    const junior = await staff(base, auth, "peeker", [{ capability: "server.view", level: "read" }]);

    // Without a draft: the audit trail is not theirs to read.
    assert.equal((await jf(`${base}/api/audit`, { headers: junior.auth })).status, 403);

    // Open a draft → the default ceiling is "everything readable".
    assert.equal((await jf(`${base}/api/requests/draft`, { method: "POST", headers: junior.auth })).status, 200);
    assert.equal((await jf(`${base}/api/audit`, { headers: junior.auth })).status, 200, "an open draft elevates reads");
    // …but never write: a config change is not made — lacking the write, it becomes a line in the
    // draft, for whoever holds the permission to sign.
    const zoneBefore = (await jf(`${base}/api/app-config`, { headers: auth })).body.config?.timezone;
    const put = await jf(`${base}/api/app-config`, { method: "PUT", headers: junior.auth, body: JSON.stringify({ timezone: "Asia/Tokyo" }) });
    assert.equal(put.status, 202, "elevation is read-clamped: the write is asked for, not made");
    assert.equal(put.body.captured, true);
    assert.equal((await jf(`${base}/api/app-config`, { headers: auth })).body.config?.timezone, zoneBefore, "the setting did not change");

    // Cap the ceiling at a role that sees only the servers.
    const created = await jf(`${base}/api/roles`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Watcher", grants: [{ capability: "server.view", level: "read" }] }) });
    assert.equal(created.status, 201);
    const roleId = (created.body.role as any).id as string;
    assert.equal((await jf(`${base}/api/app-config`, { method: "PUT", headers: auth, body: JSON.stringify({ requestCeilingRoleId: roleId }) })).status, 200);
    assert.equal((await jf(`${base}/api/audit`, { headers: junior.auth })).status, 403, "the ceiling role does not see the audit trail, so neither does the builder");
    assert.equal((await jf(`${base}/api/servers`, { headers: junior.auth })).status, 200, "what the ceiling sees, the builder sees");

    // The ceiling must never dangle: deleting the role is refused; a bogus id never stores.
    assert.equal((await jf(`${base}/api/roles/${roleId}`, { method: "DELETE", headers: auth })).status, 400, "the ceiling role cannot be deleted out from under the builder");
    assert.equal((await jf(`${base}/api/app-config`, { method: "PUT", headers: auth, body: JSON.stringify({ requestCeilingRoleId: "00000000-0000-4000-8000-00000000dead" }) })).status, 400);

    // Back to no ceiling, discard the draft → the elevation goes with it.
    assert.equal((await jf(`${base}/api/app-config`, { method: "PUT", headers: auth, body: JSON.stringify({ requestCeilingRoleId: "" }) })).status, 200);
    assert.equal((await jf(`${base}/api/requests/draft`, { method: "DELETE", headers: junior.auth })).status, 200);
    assert.equal((await jf(`${base}/api/audit`, { headers: junior.auth })).status, 403, "no draft, no elevation");

    // The personal lockout outranks the elevation: a blocked account sees nothing, draft or not.
    const locked = await staff(base, auth, "locked", [{ capability: "*", level: "none" }]);
    assert.equal((await jf(`${base}/api/requests/draft`, { method: "POST", headers: locked.auth })).status, 200);
    assert.equal((await jf(`${base}/api/audit`, { headers: locked.auth })).status, 403, "a personal Block is absolute");
    assert.equal((await jf(`${base}/api/servers`, { headers: locked.auth })).status, 200, "the servers list itself never 403s — it scopes");
    assert.equal((((await jf(`${base}/api/servers`, { headers: locked.auth })).body.servers as any[]) ?? []).length, 0, "…and a locked-out account is scoped to none");
  });
});

/*
 * THE CASCADE: a signer covers what their own authority reaches, and the remainder climbs.
 *
 * The report this comes from: a 48h ban was approved by someone capped at 24h, and the whole
 * thing dead-ended — "approved, but not applied: your temp-ban limit is 24h (asked for 48h)".
 * Their real authority over the first 24 hours was thrown away and the request died in place.
 */
test("an approver covers what their cap allows and the remainder is filed onwards", async () => {
  const { fakeGameServer } = await import("./fake-hll-server.ts");
  await withServer(async (base, repo) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const auth = { authorization: `Bearer ${l.body.token as string}` };
    const s = await fakeGameServer(base, l.body.token as string, "live");
    try {
      const pid = "76561198000000801";
      s.fake.players = [{ iD: pid, name: "Griefer" }];
      // The asker holds nothing; the mid-tier approver may ban but only up to 24h.
      const junior = await staff(base, auth, "asker2", [{ capability: "server.view", level: "read" }]);
      await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "mid", password: "pw" }) });
      const midId = ((await jf(`${base}/api/users`, { headers: auth })).body.users as any[]).find((u) => u.username === "mid").id;
      assert.equal((await jf(`${base}/api/users/${midId}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants: [{ capability: "action.tempban", level: "write" }], limits: { "tempban.maxHours": 24 } }) })).status, 200);
      const mid = { auth: await login(base, "mid", "pw") };

      // A 48h ask.
      const filed = await jf(`${base}/api/servers/${s.serverId}/actions`, { method: "POST", headers: junior.auth, body: JSON.stringify({ action: "tempban", playerId: pid, playerName: "Griefer", reason: "Test", hours: 48 }) });
      assert.equal(filed.status, 202);
      const reqId = filed.body.requestId as string;
      const lineId = ((await jf(`${base}/api/requests/${reqId}`, { headers: auth })).body.request as any).lines[0].id as string;

      // The 24h approver signs: 24h LANDS, and the rest is filed onwards rather than lost.
      const signed = await jf(`${base}/api/requests/${reqId}/lines/${lineId}/approve`, { method: "POST", headers: mid.auth, body: "{}" });
      assert.equal(signed.status, 200, JSON.stringify(signed.body));
      assert.equal(signed.body.applyError, null, "the part they could cover must actually apply");
      assert.deepEqual({ a: signed.body.cascaded?.appliedHours, r: signed.body.cascaded?.requestedHours }, { a: 24, r: 48 });
      assert.equal(s.fake.tempBans.get(pid)?.hours, 24, "the game got the 24h this signer could give");

      // The line records what THEY signed for, not what was asked.
      const after = (await jf(`${base}/api/requests/${reqId}`, { headers: auth })).body.request as any;
      assert.equal(after.lines[0].state, "approved");
      assert.deepEqual(after.lines[0].modified, { hours: { requested: 48, granted: 24 } });

      // …and the remainder is a NEW request, in the original asker's name, waiting for someone
      // who can cover the rest. The 24h approver cannot sign it — that is the whole point.
      const onward = (await jf(`${base}/api/requests/${signed.body.cascaded.requestId}`, { headers: auth })).body.request as any;
      assert.equal(onward.requesterName, "asker2", "the ask stays the asker's, not the approver's");
      assert.equal(onward.lines[0].kind, "tempban_extend");
      assert.equal(onward.lines[0].payload.appliedHours, 24);
      assert.equal(onward.lines[0].payload.hours, 48);
      const midQueue = (await jf(`${base}/api/requests`, { headers: mid.auth })).body.queue as any[];
      assert.ok(!midQueue.some((r) => r.id === onward.id), "a 24h signer is not offered the 24h remainder");

      /*
       * A cap is a ceiling on the SENTENCE, not on each command. 24 of the 48 are filled, so no
       * 24h signer may advance it — not the one who signed the first half, not a second one, and
       * not the same person after the clock has run. Otherwise two 24h moderators (or one patient
       * one) could ratchet a player to 48h with nobody senior ever agreeing to it.
       */
      const mid2 = await staff(base, auth, "mid2", [{ capability: "action.tempban", level: "write" }]);
      assert.equal((await jf(`${base}/api/users/${mid2.id}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants: [{ capability: "action.tempban", level: "write" }], limits: { "tempban.maxHours": 24 } }) })).status, 200);
      const mid2Auth = { auth: await login(base, "mid2", "pw") };
      const secondTry = await jf(`${base}/api/requests/${onward.id}/lines/${onward.lines[0].id}/approve`, { method: "POST", headers: mid2Auth.auth, body: "{}" });
      assert.equal(secondTry.status, 403, JSON.stringify(secondTry.body));
      assert.match(String(secondTry.body.error?.message ?? ""), /does not reach past the 24h already applied/);
      assert.equal((await jf(`${base}/api/requests/${onward.id}`, { headers: auth })).body.request.lines[0].state, "pending", "the refusal left it for someone senior");

      // Even once the player has served most of the first 24h, the answer is the same: served
      // time is spent, and it does not buy a capped signer more authority. Filed through the repo
      // with a backdated start so the case holds on either store, not just in memory.
      const agedReq = await repo.approvals.create({ requesterUserId: junior.id, requesterName: "asker2" });
      await repo.approvals.addLine(agedReq.id, {
        serverId: s.serverId, capability: "action.tempban", kind: "tempban_extend",
        payload: { playerId: pid, playerName: "Griefer", hours: 48, appliedHours: 24, banStart: new Date(Date.now() - 20 * 3_600_000).toISOString(), banDecisionId: onward.lines[0].payload.banDecisionId },
        playerId: pid, playerName: "Griefer",
      });
      await repo.approvals.submit(agedReq.id, new Date(Date.now() + 3_600_000).toISOString());
      const agedLine = (await repo.approvals.get(agedReq.id))!.lines[0]!;
      const laterTry = await jf(`${base}/api/requests/${agedReq.id}/lines/${agedLine.id}/approve`, { method: "POST", headers: mid.auth, body: "{}" });
      assert.equal(laterTry.status, 403, "waiting does not promote anybody");
      assert.match(String(laterTry.body.error?.message ?? ""), /does not reach past the 24h already applied/);

      // The owner (uncapped) finishes the job: the SAME sentence extends to the full 48h.
      const top = await jf(`${base}/api/requests/${onward.id}/lines/${onward.lines[0].id}/approve`, { method: "POST", headers: auth, body: "{}" });
      assert.equal(top.status, 200, JSON.stringify(top.body));
      assert.equal(top.body.applyError, null);
      assert.ok((s.fake.tempBans.get(pid)?.hours ?? 0) >= 47, "the full sentence landed once someone senior covered it");

      /*
       * ONE BAN. The 48 hours were served in two signatures because of who may sign what — an
       * artefact of the chain, not a second decision — so the requester's record shows the ban
       * once. The trail still holds both rows (the extension is what says the sentence grew), and
       * the ban list still holds one decision.
       */
      const mine = (await jf(`${base}/api/audit/staff/${junior.id}`, { headers: auth })).body.analytics as any;
      assert.equal(mine.byCategory.bans, 1, "a 48h ban signed in two halves is one ban, not two");
      assert.equal(mine.byAction["player.tempban"], 1);
      // …and ONE request. The follow-up was filed in their name by the cascade, not by them: the
      // ask climbing a rung is the same ask, and their record must not read as two.
      assert.equal(mine.byCategory.requests, 1, "one ask, however many rungs it climbed");
      assert.equal(mine.byAction["request.file"], 1);
      const trail = (await jf(`${base}/api/audit?actor=${junior.id}&limit=50`, { headers: auth })).body.entries as any[];
      const rows = trail.filter((e) => e.action === "player.tempban");
      assert.equal(rows.length, 2, "the trail keeps both — only the counting collapses them");
      assert.equal(rows.filter((e) => e.data?.continues).length, 1, "and says which one continues the other");
      const filings = trail.filter((e) => e.action === "request.file");
      assert.equal(filings.length, 2, "both filings are in the trail");
      assert.equal(filings.filter((e) => e.data?.continues === reqId).length, 1, "the follow-up says which request it continues");
      assert.equal(((await jf(`${base}/api/bans`, { headers: auth })).body.bans as any[]).filter((b) => b.playerId === pid).length, 1);
      void repo;
    } finally { s.fake.close(); }
  });
});

/*
 * The record: everyone's FINISHED requests, behind its own permission.
 *
 * Filing and signing fall out of who you are, so neither needs a grant — but reading the whole
 * team's decisions is a different question, and it is the one thing here that is granted.
 */
test("request history is gated, covers everyone's finished work, and never leaks live or draft rows", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    const junior = await staff(base, auth, "historian", [{ capability: "server.view", level: "read" }]);

    // Two requests from the junior: one gets decided, one stays open.
    const decidedReq = await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: junior.auth, body: JSON.stringify({ action: "kick", playerId: "76561198000000601", playerName: "Rowdy", reason: "abuse" }) });
    const openReq = await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: junior.auth, body: JSON.stringify({ action: "kick", playerId: "76561198000000602", playerName: "Quiet", reason: "later" }) });
    assert.equal(decidedReq.status, 202); assert.equal(openReq.status, 202);
    const line = ((await jf(`${base}/api/requests/${decidedReq.body.requestId}`, { headers: auth })).body.request as any).lines[0];
    assert.equal((await jf(`${base}/api/requests/${decidedReq.body.requestId}/lines/${line.id}/deny`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "handled in Discord" }) })).status, 200);
    // Without the permission: refused, even for the person who filed them.
    assert.equal((await jf(`${base}/api/requests/history`, { headers: junior.auth })).status, 403);

    // …and a draft, which is private scratch and must never appear in the record.
    assert.equal((await jf(`${base}/api/requests/draft`, { method: "POST", headers: junior.auth })).status, 200);
    await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: junior.auth, body: JSON.stringify({ action: "kick", playerId: "76561198000000603", reason: "scratch", draft: true }) });

    /*
     * Note what the open draft just did: the builder's view elevation covers this surface like
     * any other read, so while someone is building a request they CAN reach the history. That is
     * the documented default ("everything readable"), and the lever for a community that does not
     * want it is the builder's view ceiling — not a special case carved out here, which would
     * only make the elevation mean something different on one page.
     */
    assert.equal((await jf(`${base}/api/requests/history`, { headers: junior.auth })).status, 200,
      "an open draft elevates reads, this page included — capped by the ceiling role when one is set");

    // With it: the finished line, whoever filed it — and nothing that is still live or unfiled.
    const reviewer = await staff(base, auth, "reviewer", [{ capability: "moderation.requests.history", level: "read" }]);
    const hist = await jf(`${base}/api/requests/history`, { headers: reviewer.auth });
    assert.equal(hist.status, 200);
    const rows = hist.body.decisions as any[];
    assert.equal(rows.length, 1, "only the decided request — the open one and the draft are not history");
    assert.equal(rows[0].requesterName, "historian", "someone else's request, which is the point of the permission");
    assert.equal(rows[0].state, "denied");
    assert.equal(rows[0].denyReason, "handled in Discord");
    assert.equal(rows[0].decidedByName, "owner");
    assert.equal(rows[0].playerName, "Rowdy", "the row names the player, not just their id");
    assert.ok(rows[0].decidedAt, "and when it was decided — the column it sorts by");
    void repo;
  });
});

/*
 * Reviewing the team's decisions is granted per server, and the history answered for every server
 * whatever the grant said: a reviewer trusted with one server read another's requests, who asked,
 * who signed, and why it was denied.
 */
test("request history shows a reviewer the decisions of the servers they may review", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId: alpha } = await owner(base);
    const bravo = ((await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "b", host: "127.0.0.1", port: 2, password: "x" }) })).body.server as { id: string }).id;
    const junior = await staff(base, auth, "asker", [{ capability: "server.view", level: "read" }]);
    for (const [serverId, playerId] of [[alpha, "76561198000000611"], [bravo, "76561198000000612"]] as const) {
      const filed = await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: junior.auth, body: JSON.stringify({ action: "kick", playerId, reason: "abuse" }) });
      assert.equal(filed.status, 202);
      const line = ((await jf(`${base}/api/requests/${filed.body.requestId}`, { headers: auth })).body.request as any).lines[0];
      assert.equal((await jf(`${base}/api/requests/${filed.body.requestId}/lines/${line.id}/deny`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "no" }) })).status, 200);
    }
    // A watchlist request belongs to no server.
    const watched = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000613", name: "Watched" });
    const watch = await jf(`${base}/api/players/${watched.id}/watch/reasons`, { method: "POST", headers: junior.auth, body: JSON.stringify({ reason: "suspected" }) });
    assert.equal(watch.status, 202);
    const watchLine = ((await jf(`${base}/api/requests/${watch.body.requestId}`, { headers: auth })).body.request as any).lines[0];
    assert.equal((await jf(`${base}/api/requests/${watch.body.requestId}/lines/${watchLine.id}/deny`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "no" }) })).status, 200);

    const scoped = await staff(base, auth, "alpha-reviewer", [{ capability: "moderation.requests.history", level: "read", scopeType: "server", scopeId: alpha }]);
    const seen = ((await jf(`${base}/api/requests/history`, { headers: scoped.auth })).body.decisions as any[]).map((d) => d.serverId);
    assert.deepEqual(seen, [alpha], "the one server they may review: not the other, and not the request of no server");
    const everywhere = await staff(base, auth, "all-reviewer", [{ capability: "moderation.requests.history", level: "read" }]);
    assert.deepEqual(((await jf(`${base}/api/requests/history`, { headers: everywhere.auth })).body.decisions as any[]).map((d) => d.serverId).sort(), [alpha, bravo, null].sort());
  });
});

/*
 * The chain must TERMINATE, and it must never authorise past a cap.
 *
 * A fractional limit is the case that breaks a naive rounding: 24.6 rounds up to 25, handing a cap
 * the authority to exceed itself, and 24.4 rounds down onto the 24 already applied — which still
 * counts as progress, so it approves, grants 24 again, files an identical follow-up, and the same
 * signer can do it again for ever, re-banning the player on every pass. Whole hours, floored, and
 * strictly more than what is already applied.
 */
test("a partial signature never exceeds the cap and never files a follow-up it could sign itself", async () => {
  const { fakeGameServer } = await import("./fake-hll-server.ts");
  await withServer(async (base, repo) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const auth = { authorization: `Bearer ${l.body.token as string}` };
    const s = await fakeGameServer(base, l.body.token as string, "live");
    try {
      const pid = "76561198000000902";
      s.fake.players = [{ iD: pid, name: "Griefer" }];
      const junior = await staff(base, auth, "asker3", [{ capability: "server.view", level: "read" }]);
      await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "frac", password: "pw" }) });
      const fracId = ((await jf(`${base}/api/users`, { headers: auth })).body.users as any[]).find((u) => u.username === "frac").id;
      // A limit that is not a whole number of hours, from either direction.
      assert.equal((await jf(`${base}/api/users/${fracId}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants: [{ capability: "action.tempban", level: "write" }], limits: { "tempban.maxHours": 24.6 } }) })).status, 200);
      const frac = { auth: await login(base, "frac", "pw") };

      const filed = await jf(`${base}/api/servers/${s.serverId}/actions`, { method: "POST", headers: junior.auth, body: JSON.stringify({ action: "tempban", playerId: pid, playerName: "Griefer", reason: "Test", hours: 48 }) });
      assert.equal(filed.status, 202);
      const reqId = filed.body.requestId as string;
      const lineId = ((await jf(`${base}/api/requests/${reqId}`, { headers: auth })).body.request as any).lines[0].id as string;

      const signed = await jf(`${base}/api/requests/${reqId}/lines/${lineId}/approve`, { method: "POST", headers: frac.auth, body: "{}" });
      assert.equal(signed.status, 200, JSON.stringify(signed.body));
      assert.equal(signed.body.cascaded?.appliedHours, 24, "floored to whole hours — a 24.6h cap never signs 25h");
      assert.equal(s.fake.tempBans.get(pid)?.hours, 24, "and the game gets no more than the cap allows");

      // The follow-up it just created must be beyond its own author: otherwise the same signer
      // grants the same 24 again, files another identical request, and the chain never ends.
      const onward = signed.body.cascaded.requestId as string;
      const onwardLine = (await repo.approvals.get(onward))!.lines[0]!;
      const again = await jf(`${base}/api/requests/${onward}/lines/${onwardLine.id}/approve`, { method: "POST", headers: frac.auth, body: "{}" });
      assert.equal(again.status, 403, JSON.stringify(again.body));
      assert.equal((await repo.approvals.list({ requesterUserId: junior.id })).filter((r) => r.status === "open").length, 1,
        "exactly one open follow-up — a signature that cannot advance the line files nothing");
    } finally { s.fake.close(); }
  });
});

/*
 * The promotion case. A moderator files what they cannot do and is promoted before anyone signs
 * it. Their signature is now worth exactly what their new authority is worth — no more — so they
 * may cover it themselves, and anything past their caps still climbs to somebody above them.
 * Refusing them outright (the old never-yourself rule) protected nothing and stranded the ask.
 */
test("a requester promoted after filing can sign their own request, bounded by their new authority", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    const junior = await staff(base, auth, "climber", [{ capability: "server.view", level: "read" }]);

    const filed = await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: junior.auth, body: JSON.stringify({ action: "kick", playerId: "76561198000000700", playerName: "Rowdy", reason: "abuse" }) });
    assert.equal(filed.status, 202);
    const reqId = filed.body.requestId as string;
    const lineId = ((await jf(`${base}/api/requests/${reqId}`, { headers: auth })).body.request as any).lines[0].id as string;

    // Before the promotion the line is not theirs to sign — they lack the write.
    assert.equal((await jf(`${base}/api/requests/${reqId}/lines/${lineId}/approve`, { method: "POST", headers: junior.auth, body: "{}" })).status, 403);

    // The promotion — the same grant change a Discord role sync would make.
    assert.equal((await jf(`${base}/api/users/${junior.id}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants: [{ capability: "server.view", level: "read" }, { capability: "action.kick", level: "write" }] }) })).status, 200);
    const promoted = { auth: await login(base, "climber", "pw") };

    // Now it IS theirs to sign, and the panel offers it on their own card.
    const mineNow = ((await jf(`${base}/api/requests`, { headers: promoted.auth })).body.mine as any[])[0];
    assert.equal(mineNow.lines[0].canSign, true, "the promotion opened the path");
    const done = await jf(`${base}/api/requests/${reqId}/lines/${lineId}/approve`, { method: "POST", headers: promoted.auth, body: "{}" });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const after = (await jf(`${base}/api/requests/${reqId}`, { headers: auth })).body.request as any;
    assert.equal(after.lines[0].state, "approved");
    assert.equal(after.lines[0].decidedByName, "climber");
    assert.equal(after.status, "resolved");
    void repo;
  });
});

/*
 * The commonest way an approval fails: the player left between filing and signing. Punish, kick,
 * message and the team switches only reach somebody CONNECTED, so the game refuses with an opaque
 * status line — "(500) command punishPlayer failed: Unable to perform request" — which reads to
 * the approver as the app being broken rather than the target having gone home.
 */
test("approving an action for a player who has left says so in words, not a wire error", async () => {
  const { fakeGameServer } = await import("./fake-hll-server.ts");
  await withServer(async (base, repo) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const auth = { authorization: `Bearer ${l.body.token as string}` };
    const s = await fakeGameServer(base, l.body.token as string, "live");
    try {
      const junior = await staff(base, auth, "asker", [{ capability: "server.view", level: "read" }]);
      const pid = "76561198000000901";
      // They were on the server when the request was filed…
      s.fake.players = [{ iD: pid, name: "Griefer" }];
      const filed = await jf(`${base}/api/servers/${s.serverId}/actions`, { method: "POST", headers: junior.auth, body: JSON.stringify({ action: "punish", playerId: pid, playerName: "Griefer", reason: "teamkilling" }) });
      assert.equal(filed.status, 202);
      // …and gone by the time anyone signs it.
      s.fake.players = [];
      const req = (await jf(`${base}/api/requests/${filed.body.requestId}`, { headers: auth })).body.request as any;
      const ok = await jf(`${base}/api/requests/${req.id}/lines/${req.lines[0].id}/approve`, { method: "POST", headers: auth, body: "{}" });
      assert.equal(ok.status, 200);
      const err = String(ok.body.applyError ?? "");
      assert.match(err, /Griefer is not on live right now/, `expected plain words, got: ${err}`);
      assert.match(err, /only reaches a player who is currently on this server/);
      assert.ok(!/punishPlayer|Unable to perform request/.test(err), `the wire error must not be what the approver reads: ${err}`);
      // The decision still STANDS and is recorded honestly — approved, not applied.
      const after = (await jf(`${base}/api/requests/${req.id}`, { headers: auth })).body.request as any;
      assert.equal(after.lines[0].state, "approved");
      assert.equal(after.lines[0].applyError, err);
      void repo;
    } finally { s.fake.close(); }
  });
});

/*
 * A request is read by someone who was not there, hours later — so it must name the player, not
 * just their platform id. The dialogs send the name with the action; anything filed without one
 * (an older row, a Discord or API filing) is resolved from the player directory at read time.
 */
test("request lines show the player's name, resolving it from the directory when it was not captured", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    const junior = await staff(base, auth, "namer", [{ capability: "server.view", level: "read" }]);
    const pid = "0ff4c9412aa7d6037f8393426354a25c"; // an xbox-shaped id: unreadable to a human
    await repo.players.upsert({ game: "hll", platform: "xbox", platformId: pid, name: "KREITZ [LYNX]" });

    // Filed WITH a name (what the dialogs now send): the name is kept verbatim.
    const withName = await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: junior.auth, body: JSON.stringify({ action: "kick", playerId: pid, playerName: "KREITZ [LYNX]", reason: "x" }) });
    assert.equal(withName.status, 202);
    const mine1 = ((await jf(`${base}/api/requests`, { headers: junior.auth })).body.mine as any[])[0];
    assert.equal(mine1.lines[0].playerName, "KREITZ [LYNX]");
    assert.equal(mine1.lines[0].playerId, pid, "the id rides along too — the panel shows both");

    // Filed WITHOUT one (an older client): the directory supplies it on the way out, so no
    // surface is left showing a bare id.
    const bare = await repo.approvals.create({ requesterUserId: junior.id, requesterName: "namer" });
    await repo.approvals.addLine(bare.id, { capability: "action.kick", kind: "kick", payload: { playerId: pid, reason: "y" }, serverId, playerId: pid });
    await repo.approvals.submit(bare.id, new Date(Date.now() + 3_600_000).toISOString());
    const seen = (await jf(`${base}/api/requests/${bare.id}`, { headers: auth })).body.request as any;
    assert.equal(seen.lines[0].playerName, "KREITZ [LYNX]", "an unnamed line is named from the directory");

    // An id the directory has never seen stays honestly nameless rather than inventing one.
    const ghost = await repo.approvals.create({ requesterUserId: junior.id, requesterName: "namer" });
    await repo.approvals.addLine(ghost.id, { capability: "action.kick", kind: "kick", payload: { playerId: "76561190000000000" }, serverId, playerId: "76561190000000000" });
    await repo.approvals.submit(ghost.id, new Date(Date.now() + 3_600_000).toISOString());
    assert.equal(((await jf(`${base}/api/requests/${ghost.id}`, { headers: auth })).body.request as any).lines[0].playerName, null);
  });
});

/*
 * Save draft parks the cart: the lines are kept and resume later, but a PARKED draft confers no
 * view elevation — leaving the builder ends the widened view server-side, not just in the nav.
 * Abandoned drafts are deleted by the sweep after the admin-set idle window.
 */
test("a parked draft keeps its lines but confers nothing; stale drafts are swept", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    const junior = await staff(base, auth, "saver", [{ capability: "server.view", level: "read" }]);

    // Build: open the draft, capture one line, elevated while active.
    assert.equal((await jf(`${base}/api/requests/draft`, { method: "POST", headers: junior.auth })).status, 200);
    const cap = await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: junior.auth, body: JSON.stringify({ action: "message", playerId: "7", playerName: "Rowdy", message: "hi", draft: true }) });
    assert.equal(cap.status, 202);
    assert.equal((await jf(`${base}/api/audit`, { headers: junior.auth })).status, 200, "building elevates");

    // Save draft: parked → the elevation is gone, the lines are not.
    assert.equal((await jf(`${base}/api/requests/draft/park`, { method: "POST", headers: junior.auth })).status, 200);
    assert.equal((await jf(`${base}/api/audit`, { headers: junior.auth })).status, 403, "a parked draft confers nothing");
    const kept = (await jf(`${base}/api/requests/draft`, { headers: junior.auth })).body.draft as any;
    assert.equal(kept.lines.length, 1, "the saved cart keeps its lines");
    assert.ok(kept.parkedAt, "the draft knows it is parked");

    // Resume: un-parked, elevated again, same cart.
    const resumed = await jf(`${base}/api/requests/draft`, { method: "POST", headers: junior.auth });
    assert.equal((resumed.body.draft as any).parkedAt, null);
    assert.equal((resumed.body.draft as any).lines.length, 1);
    assert.equal((await jf(`${base}/api/audit`, { headers: junior.auth })).status, 200, "resuming restores the elevation");

    // A capture is building too: a line landing in a PARKED draft un-parks it (a second tab
    // that kept capturing must never build blind, without the view its lines assume).
    assert.equal((await jf(`${base}/api/requests/draft/park`, { method: "POST", headers: junior.auth })).status, 200);
    assert.equal((await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: junior.auth, body: JSON.stringify({ action: "message", playerId: "8", playerName: "Loud", message: "yo", draft: true }) })).status, 202);
    assert.equal(((await jf(`${base}/api/requests/draft`, { headers: junior.auth })).body.draft as any).parkedAt, null, "a capture un-parks");
    assert.equal((await jf(`${base}/api/audit`, { headers: junior.auth })).status, 200, "…and the elevation follows the activity");

    // The idle sweep: a cutoff in the future catches this fresh draft; one in the past does not.
    assert.equal((await repo.approvals.discardStaleDrafts(new Date(Date.now() - 3_600_000).toISOString())).length, 0, "a live draft is not stale");
    const swept = await repo.approvals.discardStaleDrafts(new Date(Date.now() + 1000).toISOString());
    assert.equal(swept.length, 1);
    assert.equal(swept[0]!.requesterName, "saver");
    assert.equal(await repo.approvals.findDraft(junior.id), null, "the abandoned cart is gone");
    assert.equal((await jf(`${base}/api/audit`, { headers: junior.auth })).status, 403, "…and so is its elevation");

    // The window is admin-set and refuses nonsense.
    assert.equal((await jf(`${base}/api/app-config`, { method: "PUT", headers: auth, body: JSON.stringify({ requestDraftTtlHours: -1 }) })).status, 400);
    assert.equal((await jf(`${base}/api/app-config`, { method: "PUT", headers: auth, body: JSON.stringify({ requestDraftTtlHours: 0 }) })).status, 200, "0 = keep forever");
    assert.equal((await jf(`${base}/api/app-config`, { method: "PUT", headers: auth, body: JSON.stringify({ requestDraftTtlHours: 24 }) })).status, 200);
  });
});

/*
 * The Discord relay's buttons: a press on the card resolves through the presser's LINKED staff
 * account and flows through the same approveLine/denyLine as the panel — one permission model,
 * whichever surface pressed it. With no channel configured nothing ever posts (the relay is
 * optional by construction: armedRelay() is null without config, and these tests run that way).
 */
test("relay buttons decide through the linked staff account, with the panel's own checks", async () => {
  const { generateKeyPairSync, sign: edSign } = await import("node:crypto");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const publicKeyHex = spki.subarray(spki.length - 32).toString("hex");
  const signBody = (ts: string, body: string) => edSign(null, Buffer.from(ts + body), privateKey).toString("hex");
  const prev = process.env.DISCORD_PUBLIC_KEY;
  process.env.DISCORD_PUBLIC_KEY = publicKeyHex;
  try {
    await withServer(async (base, repo) => {
      const { serverId } = await owner(base);
      // A junior's filed request (repo-level: the route paths are covered above).
      const junior = await repo.users.create({ username: "jr", discordId: null });
      const draft = await repo.approvals.create({ requesterUserId: junior.id, requesterName: "jr" });
      await repo.approvals.addLine(draft.id, { capability: "action.message", kind: "message", payload: { playerId: "1", playerName: "Rowdy", message: "hi" }, serverId, playerId: "1", playerName: "Rowdy" });
      await repo.approvals.submit(draft.id, new Date(Date.now() + 3_600_000).toISOString());

      // A senior whose Discord IS linked to a staff account holding the write…
      const senior = await repo.users.create({ username: "sr", discordId: "d-900", discordUsername: "sr", discordManaged: true });
      await repo.grants.create({ userId: senior.id, capability: "action.message", scopeType: "global", scopeId: null, level: "write" });
      // …and a bystander whose Discord is linked to an account with no relevant write.
      await repo.users.create({ username: "nobody", discordId: "d-901", discordUsername: "nb", discordManaged: true });

      const press = async (discordUserId: string, customId: string, extra: Record<string, unknown> = {}) => {
        const ts = String(Math.floor(Date.now() / 1000));
        const body = JSON.stringify({ type: 3, id: "i1", token: "t1", data: { custom_id: customId }, member: { user: { id: discordUserId, username: "who" } }, ...extra });
        const res = await fetch(`${base}/api/discord/interactions`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-signature-ed25519": signBody(ts, body), "x-signature-timestamp": ts },
          body,
        });
        return { status: res.status, body: (await res.json()) as Record<string, any> };
      };

      const reqRow = (await repo.approvals.get(draft.id))!;

      // An unlinked/unauthorized presser is told plainly, and the line does not move.
      const nb = await press("d-901", `apr:${reqRow.id}:all`);
      assert.equal(nb.status, 200);
      assert.match(String(nb.body.data?.content), /Nothing signed/);
      assert.equal((await repo.approvals.get(reqRow.id))!.lines[0]!.state, "pending");

      // "Deny…" opens the reason modal — the reason is never optional, on any surface.
      const modal = await press("d-900", `apr:${reqRow.id}:deny`);
      assert.equal(modal.body.type, 9, "a modal, demanding the reason");

      // The senior's press signs the line in their PANEL name (execution fails on the dead test
      // server, reported in the sentence — never a silent success).
      const ok = await press("d-900", `apr:${reqRow.id}:all`);
      assert.equal(ok.status, 200);
      assert.match(String(ok.body.data?.content), /Approved 1 line/);
      const after = (await repo.approvals.get(reqRow.id))!;
      assert.equal(after.lines[0]!.state, "approved");
      assert.equal(after.lines[0]!.decidedByName, "sr");
      assert.equal(after.status, "resolved");

      // The modal's submitted reason denies through the same path (a second request).
      const d2 = await repo.approvals.create({ requesterUserId: junior.id, requesterName: "jr" });
      await repo.approvals.addLine(d2.id, { capability: "action.message", kind: "message", payload: { playerId: "2", message: "yo" }, serverId, playerId: "2" });
      await repo.approvals.submit(d2.id, new Date(Date.now() + 3_600_000).toISOString());
      const denied = await press("d-900", `apr:${d2.id}:denysub`, {
        type: 5,
        data: { custom_id: `apr:${d2.id}:denysub`, components: [{ type: 1, components: [{ type: 4, custom_id: "reason", value: "not warranted yet" }] }] },
      });
      assert.equal(denied.status, 200);
      assert.match(String(denied.body.data?.content), /Denied 1 line/);
      const den = (await repo.approvals.get(d2.id))!;
      assert.equal(den.lines[0]!.state, "denied");
      assert.equal(den.lines[0]!.denyReason, "not warranted yet");
    });
  } finally {
    if (prev === undefined) delete process.env.DISCORD_PUBLIC_KEY; else process.env.DISCORD_PUBLIC_KEY = prev;
  }
});

/*
 * CREDIT. The action is the requester's work; the approval is the approver's.
 *
 * It ran the other way round: every approved ban, kick and VIP grant was written into the
 * APPROVER's audit trail, so a senior admin who spent a night saying yes came out of it with a
 * moderation record they never earned, and the moderator who found the player, made the call and
 * wrote the reason had nothing on their profile but "filed a request".
 */
test("an approved action counts for the requester; the approver's trail shows the approval", async () => {
  const { fakeGameServer } = await import("./fake-hll-server.ts");
  await withServer(async (base, repo) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const auth = { authorization: `Bearer ${l.body.token as string}` };
    const s = await fakeGameServer(base, l.body.token as string, "live");
    try {
      const pid = "76561198000000901";
      s.fake.players = [{ iD: pid, name: "Griefer" }];
      const junior = await staff(base, auth, "asker4", [{ capability: "server.view", level: "read" }]);
      const ownerId = ((await jf(`${base}/api/users`, { headers: auth })).body.users as any[]).find((u) => u.username === "owner").id as string;
      // Sign temp bans, so the notice the PLAYER reads is part of what this test checks.
      assert.equal((await jf(`${base}/api/signatures`, { method: "PUT", headers: auth, body: JSON.stringify({ staffLine: "- {staff}", actions: { tempban: { staff: true } } }) })).status, 200);

      const filed = await jf(`${base}/api/servers/${s.serverId}/actions`, { method: "POST", headers: junior.auth, body: JSON.stringify({ action: "tempban", playerId: pid, playerName: "Griefer", reason: "Wall hacks", hours: 5 }) });
      assert.equal(filed.status, 202, JSON.stringify(filed.body));
      const reqId = filed.body.requestId as string;
      /*
       * They change their Discord nick while the request waits. Names follow the person here as
       * everywhere else, and a request can sit for two days per rung — signing yesterday's name
       * onto a ban notice sends the player to appeal to somebody nobody recognises.
       */
      await repo.users.linkDiscord(junior.id, { discordId: "9001", nick: "AskerRenamed" });
      const lineId = ((await jf(`${base}/api/requests/${reqId}`, { headers: auth })).body.request as any).lines[0].id as string;
      const signed = await jf(`${base}/api/requests/${reqId}/lines/${lineId}/approve`, { method: "POST", headers: auth, body: "{}" });
      assert.equal(signed.status, 200, JSON.stringify(signed.body));
      assert.equal(signed.body.applyError, null);

      /*
       * What the GAME was told, and what the player reads: the requester, not the approver. The
       * approver's authority is what permitted the ban; it is not their case, and telling the
       * player to take it up with someone who never saw it helps nobody.
       */
      const inGame = s.fake.tempBans.get(pid)!;
      assert.equal(inGame.by, "AskerRenamed", "the game gets the requester, under the name they go by NOW");
      assert.match(inGame.reason, /- AskerRenamed/, "…and signs the notice with it");
      assert.doesNotMatch(inGame.reason, /owner/);

      // The requester's profile: the ban is theirs, alongside the request they filed for it.
      const mine = (await jf(`${base}/api/audit/staff/${junior.id}`, { headers: auth })).body.analytics as any;
      assert.equal(mine.byAction["player.tempban"], 1, "the ban belongs to the person who asked for it");
      assert.equal(mine.byCategory.bans, 1);
      assert.equal(mine.byCategory.requests, 1, "their filing is paperwork, counted as such");
      assert.deepEqual(mine.topTargets.map((t: any) => t.name), ["Griefer"], "the player, not the request's uuid");

      // The approver's profile: one approval, and no moderation record they did not earn.
      const boss = (await jf(`${base}/api/audit/staff/${ownerId}`, { headers: auth })).body.analytics as any;
      assert.equal(boss.byAction["player.tempban"], undefined, "the approver did not ban anybody");
      assert.equal(boss.byCategory.bans, 0);
      assert.equal(boss.byAction["request.approve"], 1);
      assert.ok(boss.byCategory.requests >= 1, "approvals are their own category, not 'other'");
      assert.ok(!boss.topTargets.some((t: any) => t.name === "Griefer"), "the approver never touched the player");

      // …but the record still says on whose authority it happened — credit moved, accountability
      // did not.
      const trail = (await jf(`${base}/api/audit?actor=${junior.id}&limit=50`, { headers: auth })).body.entries as any[];
      const banRow = trail.find((e) => e.action === "player.tempban");
      assert.match(String(banRow.summary), /\(approved by owner\)/);
      assert.equal(banRow.data.approvedBy, "owner");

      // The ban decision itself is filed under the requester too — one story, not two.
      const bans = (await jf(`${base}/api/bans`, { headers: auth })).body.bans as any[];
      assert.equal(bans.find((b) => b.playerId === pid)?.by, "AskerRenamed");
    } finally { s.fake.close(); }
  });
});

/*
 * THE WATCHLIST asks like everything else.
 *
 * It was the one action on the player menu with no approval path: it fired the moment it was
 * confirmed even while the request builder was up promising "nothing executed", and a moderator
 * without the permission could only be refused — "please watch this player" was the one thing
 * they could not ask for. Both directions now capture and file: adding is the base write, taking
 * somebody off closes every reason on them and is the curate one.
 */
test("watching a player captures into the builder and files for approval like any other action", async () => {
  await withServer(async (base, repo) => {
    const { auth } = await owner(base);
    const junior = await staff(base, auth, "watcher", [{ capability: "player.watchlist", level: "read" }]);
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000701", name: "Suspect" });

    // No write → the same validated call files a request instead of 403ing.
    const filed = await jf(`${base}/api/players/${player.id}/watch/reasons`, { method: "POST", headers: junior.auth, body: JSON.stringify({ reason: "sus aim" }) });
    assert.equal(filed.status, 202, JSON.stringify(filed.body));
    assert.equal(filed.body.requested, true);
    // …and it is still validated first: an empty reason is refused before anything is filed.
    assert.equal((await jf(`${base}/api/players/${player.id}/watch/reasons`, { method: "POST", headers: junior.auth, body: JSON.stringify({ reason: "" }) })).status, 400);
    assert.equal((await repo.playerFlags.get(player.id))?.watchlist ?? false, false, "nothing happened yet — it is a request");

    // The line carries no server: a watch is a fact about a person, everywhere.
    const reqId = filed.body.requestId as string;
    const line = ((await jf(`${base}/api/requests/${reqId}`, { headers: auth })).body.request as any).lines[0];
    assert.equal(line.kind, "watch");
    assert.equal(line.serverId, null);
    assert.equal(line.playerName, "Suspect");

    // The owner signs it, and the watch lands — credited to the requester, like every other line.
    const signed = await jf(`${base}/api/requests/${reqId}/lines/${line.id}/approve`, { method: "POST", headers: auth, body: "{}" });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    assert.equal(signed.body.applyError, null);
    const flags = await repo.playerFlags.get(player.id);
    assert.equal(flags?.watchlist, true);
    assert.equal(flags?.watchReason, "sus aim");
    assert.match(String(flags?.watchBy), /watcher/);

    // Taking them off is the OTHER permission, so a watcher who may add cannot remove — they ask.
    const off = await jf(`${base}/api/players/${player.id}/flags`, { method: "PATCH", headers: junior.auth, body: JSON.stringify({ watchlist: false }) });
    assert.equal(off.status, 202, JSON.stringify(off.body));
    const offLine = ((await jf(`${base}/api/requests/${off.body.requestId}`, { headers: auth })).body.request as any).lines[0];
    assert.equal(offLine.kind, "unwatch");
    assert.equal((await repo.playerFlags.get(player.id))?.watchlist, true, "still watched — the removal is only a request");
    const lifted = await jf(`${base}/api/requests/${off.body.requestId}/lines/${offLine.id}/approve`, { method: "POST", headers: auth, body: "{}" });
    assert.equal(lifted.status, 200, JSON.stringify(lifted.body));
    assert.equal((await repo.playerFlags.get(player.id))?.watchlist, false);

    // While the cart is open it CAPTURES, whoever you are — the owner included. This is what the
    // bar means by "nothing executed", and the watchlist used to be the exception to it.
    await jf(`${base}/api/requests/draft`, { method: "POST", headers: auth, body: "{}" });
    const captured = await jf(`${base}/api/players/${player.id}/watch/reasons`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "second look", draft: true }) });
    assert.equal(captured.status, 202, JSON.stringify(captured.body));
    assert.equal(captured.body.captured, true);
    assert.equal((await repo.playerFlags.get(player.id))?.watchlist, false, "captured, not executed");
  });
});

/*
 * REVOKING VIP asks too. `vipRevoke` was an approvable kind the executor could always run and
 * nothing could produce: granting VIP filed a request when you lacked the permission, taking it
 * away dead-ended in a 403. "This donor's VIP expired months ago, please pull it" had no path.
 */
test("revoking VIP files for approval, and the signature reaches the game", async () => {
  const { fakeGameServer } = await import("./fake-hll-server.ts");
  await withServer(async (base, repo) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const auth = { authorization: `Bearer ${l.body.token as string}` };
    const s = await fakeGameServer(base, l.body.token as string, "live");
    try {
      const pid = "76561198000000702";
      const junior = await staff(base, auth, "vipasker", [{ capability: "vip.grant", level: "read" }]);
      await repo.vips.upsert({ serverId: s.serverId, playerId: pid, playerName: "Donor", expiration: null, createdByName: "owner" });
      s.fake.vips.set(pid, { playerId: pid, comment: "Donor" });

      const filed = await jf(`${base}/api/servers/${s.serverId}/vips/${pid}`, { method: "DELETE", headers: junior.auth });
      assert.equal(filed.status, 202, JSON.stringify(filed.body));
      assert.equal(filed.body.requested, true);
      assert.ok(await repo.vips.get(s.serverId, pid), "the grant is untouched until somebody signs");

      const line = ((await jf(`${base}/api/requests/${filed.body.requestId}`, { headers: auth })).body.request as any).lines[0];
      assert.equal(line.kind, "vipRevoke");
      // The line says who, and what signing ends — the card and the queue show both.
      assert.equal(line.playerName, "Donor");
      assert.deepEqual(line.payload.grant, { expiration: null, comment: null });
      const signed = await jf(`${base}/api/requests/${filed.body.requestId}/lines/${line.id}/approve`, { method: "POST", headers: auth, body: "{}" });
      assert.equal(signed.status, 200, JSON.stringify(signed.body));
      assert.equal(signed.body.applyError, null);
      assert.equal(await repo.vips.get(s.serverId, pid), null);
      assert.ok(!s.fake.vips.has(pid), "and the game was told");
    } finally { s.fake.close(); }
  });
});

test("a revoke never ends a permanent grant nobody signing was shown: one that turned permanent after filing is refused", async () => {
  const { fakeGameServer } = await import("./fake-hll-server.ts");
  await withServer(async (base, repo) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const auth = { authorization: `Bearer ${l.body.token as string}` };
    const s = await fakeGameServer(base, l.body.token as string, "live");
    try {
      const pid = "76561198000000703";
      const junior = await staff(base, auth, "vipasker2", [{ capability: "vip.grant", level: "read" }]);
      const inAWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();
      await repo.vips.upsert({ serverId: s.serverId, playerId: pid, playerName: "Trial", expiration: inAWeek, comment: "trial week", createdByName: "owner" });
      s.fake.vips.set(pid, { playerId: pid, comment: "Trial" });
      const filed = await jf(`${base}/api/servers/${s.serverId}/vips/${pid}`, { method: "DELETE", headers: junior.auth });
      assert.equal(filed.status, 202, JSON.stringify(filed.body));
      const line = ((await jf(`${base}/api/requests/${filed.body.requestId}`, { headers: auth })).body.request as any).lines[0];
      assert.deepEqual(line.payload.grant, { expiration: inAWeek, comment: "trial week" }, "filed against a dated grant");

      // They pay for permanent VIP before anybody signs.
      await repo.vips.upsert({ serverId: s.serverId, playerId: pid, playerName: "Trial", expiration: null, replacePermanent: true, createdByName: "owner" } as any);
      assert.equal((await repo.vips.get(s.serverId, pid))?.expiration, null);
      const signed = await jf(`${base}/api/requests/${filed.body.requestId}/lines/${line.id}/approve`, { method: "POST", headers: auth, body: "{}" });
      assert.equal(signed.status, 200, JSON.stringify(signed.body));
      assert.match(String(signed.body.applyError), /their VIP is permanent, and this request did not show that/);
      assert.equal((await repo.vips.get(s.serverId, pid))?.expiration, null, "the permanent grant stands");
      assert.ok(s.fake.vips.has(pid), "and the game still has it");

      // A grant a group perk holds cannot be revoked, so it is not filed for somebody to sign into a failure.
      const held = "76561198000000704";
      await repo.vips.startGroupHold({ serverId: s.serverId, playerId: held, playerName: "Clan", groups: [{ id: "g1", name: "Clan VIP", severanceMinutes: 0 }], createdByName: "perk" });
      const refused = await jf(`${base}/api/servers/${s.serverId}/vips/${held}`, { method: "DELETE", headers: junior.auth });
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.match(String((refused.body.error as { message?: string })?.message ?? refused.body.error), /remove them from the group to end it/);
    } finally { s.fake.close(); }
  });
});

test("a grant made permanent while a signed revoke is reaching the game keeps its row, and its game entry", async () => {
  // The check above runs before the game call and the delete after it. A purchase landing in
  // between turned the grant permanent, and the unconditional delete then ended a paid VIP that
  // nobody signing was shown.
  const { fakeGameServer } = await import("./fake-hll-server.ts");
  await withServer(async (base, repo) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const auth = { authorization: `Bearer ${l.body.token as string}` };
    const s = await fakeGameServer(base, l.body.token as string, "live");
    try {
      const pid = "76561198000000705";
      const junior = await staff(base, auth, "vipasker3", [{ capability: "vip.grant", level: "read" }]);
      await repo.vips.upsert({ serverId: s.serverId, playerId: pid, playerName: "Trial", expiration: new Date(Date.now() + 7 * 86_400_000).toISOString(), createdByName: "owner" });
      s.fake.vips.set(pid, { playerId: pid, comment: "Trial" });
      const filed = await jf(`${base}/api/servers/${s.serverId}/vips/${pid}`, { method: "DELETE", headers: junior.auth });
      assert.equal(filed.status, 202, JSON.stringify(filed.body));
      const line = ((await jf(`${base}/api/requests/${filed.body.requestId}`, { headers: auth })).body.request as any).lines[0];

      // The permanent purchase lands while the game is answering the RemoveVip.
      s.fake.onCommand = async (name) => {
        if (name === "RemoveVip") {
          await repo.vips.upsert({ serverId: s.serverId, playerId: pid, playerName: "Trial", expiration: null, replacePermanent: true, createdByName: "shop" } as any);
        }
      };
      const signed = await jf(`${base}/api/requests/${filed.body.requestId}/lines/${line.id}/approve`, { method: "POST", headers: auth, body: "{}" });
      s.fake.onCommand = null;
      assert.equal(signed.status, 200, JSON.stringify(signed.body));
      assert.match(String(signed.body.applyError), /changed while this was being applied — it is now permanent/);
      assert.equal((await repo.vips.get(s.serverId, pid))?.expiration, null, "the permanent grant stands");
      assert.ok(s.fake.vips.has(pid), "and the game got back the entry the revoke took");
      assert.equal((await repo.audit.list({ actions: ["vip.revoke"] })).length, 0, "no revoke is on the record");
    } finally { s.fake.close(); }
  });
});

/*
 * THE REST OF THE APP asks too.
 *
 * Map work, votes, seeding, console and the configuration screens are all server-scoped writes
 * behind one wrapper, and that wrapper is where they became requestable — no branch of their own
 * in the executor, no second list to keep in step. An approved line IS the call that was refused,
 * replayed: the handler that would have run runs, with the approver's authority and the
 * requester's name on everything it writes.
 */
test("a map-vote action files as a request, reads as words, and runs on the signature", async () => {
  const { fakeGameServer } = await import("./fake-hll-server.ts");
  await withServer(async (base, repo) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const auth = { authorization: `Bearer ${l.body.token as string}` };
    const s = await fakeGameServer(base, l.body.token as string, "live");
    try {
      const junior = await staff(base, auth, "mapasker", [{ capability: "server.view", level: "read" }]);

      // No mapvote.control → the same call files instead of 403ing, and says what it would do.
      const filed = await jf(`${base}/api/servers/${s.serverId}/mapvote/skip`, { method: "POST", headers: junior.auth, body: JSON.stringify({ skip: true }) });
      assert.equal(filed.status, 202, JSON.stringify(filed.body));
      assert.equal(filed.body.requested, true);
      assert.equal(filed.body.label, "Skip the map vote");
      const req = (await jf(`${base}/api/requests/${filed.body.requestId}`, { headers: auth })).body.request as any;
      assert.equal(req.lines[0].kind, "route");
      assert.equal(req.lines[0].payload.label, "Skip the map vote");
      assert.equal(req.lines[0].capability, "mapvote.control");
      // The trail says what was asked for, not "route".
      const filing = ((await jf(`${base}/api/audit?actor=${junior.id}&limit=20`, { headers: auth })).body.entries as any[])
        .find((e) => e.action === "request.file");
      assert.match(String(filing.summary), /Skip the map vote/);
      assert.equal(req.lines[0].serverId, s.serverId);
      assert.equal((await repo.mapVote.getState(s.serverId))?.skipNext ?? false, false, "nothing was skipped — it is a request");

      // The owner signs it: the handler runs, and the record is the requester's.
      const signed = await jf(`${base}/api/requests/${req.id}/lines/${req.lines[0].id}/approve`, { method: "POST", headers: auth, body: "{}" });
      assert.equal(signed.status, 200, JSON.stringify(signed.body));
      assert.equal(signed.body.applyError, null);
      assert.equal((await repo.mapVote.getState(s.serverId))?.skipNext, true, "the skip landed");
      const trail = (await jf(`${base}/api/audit?actor=${junior.id}&limit=20`, { headers: auth })).body.entries as any[];
      const skipRow = trail.find((e) => e.action === "mapvote.skip");
      assert.ok(skipRow, "credited to whoever asked for it");
      // …and the row the HANDLER wrote still says where it came from: same provenance a player
      // action carries, stamped on its way past.
      assert.equal(skipRow.data.requestId, req.id);
      assert.equal(skipRow.data.approvedBy, "owner");
      assert.match(String(skipRow.summary), /\(approved by owner\)/);

      // While a request is being built, the same call is CAPTURED — for the owner too, who holds
      // the permission: that is what the bar means by "nothing executed".
      await jf(`${base}/api/requests/draft`, { method: "POST", headers: auth, body: "{}" });
      const captured = await jf(`${base}/api/servers/${s.serverId}/mapvote/pause`, { method: "POST", headers: auth, body: JSON.stringify({ paused: true }) });
      assert.equal(captured.status, 202, JSON.stringify(captured.body));
      assert.equal(captured.body.captured, true);
      assert.equal((await repo.mapVote.getState(s.serverId))?.paused ?? false, false, "captured, not executed");

      // …and submitting the cart is when it happens: the owner holds the permission, so their own
      // line applies at submit rather than waiting for a signature — through the same replay.
      const submitted = await jf(`${base}/api/requests/draft/submit`, { method: "POST", headers: auth, body: "{}" });
      assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
      assert.deepEqual((submitted.body.applied as any[]).map((a) => a.error), [null], "applied under their own permission");
      assert.equal((await repo.mapVote.getState(s.serverId))?.paused, true, "the pause landed on submit");

      /*
       * A route RE-GATED while the request waited: the line's capability is a snapshot, the
       * registry knows what the route wants now, and the weaker snapshot must not be what decides.
       * (The replay skips the wrapper's own check, so nothing else would catch it.)
       */
      {
        const { REPLAYABLE_WRITES, replayKey } = await import("../dist/routes/kit.js");
        const key = replayKey("POST", "/api/servers/:id/mapvote/reroll");
        const original = REPLAYABLE_WRITES.get(key)!;
        // An approver who holds exactly the permission the LINE names — the owner's wildcard would
        // cover the new one too and prove nothing.
        const voteAdmin = await staff(base, auth, "voteadmin", [{ capability: "mapvote.control", level: "write" }, { capability: "server.view", level: "read" }]);
        const asked = await jf(`${base}/api/servers/${s.serverId}/mapvote/reroll`, { method: "POST", headers: junior.auth, body: "{}" });
        assert.equal(asked.status, 202, JSON.stringify(asked.body));
        const line = ((await jf(`${base}/api/requests/${asked.body.requestId}`, { headers: auth })).body.request as any).lines[0];
        REPLAYABLE_WRITES.set(key, { ...original, capability: "nobody.holds.this" });
        try {
          const signed = await jf(`${base}/api/requests/${asked.body.requestId}/lines/${line.id}/approve`, { method: "POST", headers: voteAdmin.auth, body: "{}" });
          assert.equal(signed.status, 200, JSON.stringify(signed.body));
          assert.match(String(signed.body.applyError), /nobody\.holds\.this/, "the CURRENT permission decides, and says so");
        } finally { REPLAYABLE_WRITES.set(key, original); }
      }

      // …and a refusal from the handler itself lands on the line as the sentence it wrote, rather
      // than as a silent success. A rotation remove for a map that is not there says so.
      // An approver signing "Broadcast to the server" has to SEE the message: a filed call carries
      // its body, and both the panel and the Discord card render it from there.
      const bcast = await jf(`${base}/api/servers/${s.serverId}/broadcast/send`, { method: "POST", headers: junior.auth, body: JSON.stringify({ message: "Server restarting in 10" }) });
      assert.equal(bcast.status, 202, JSON.stringify(bcast.body));
      const bcastLine = ((await jf(`${base}/api/requests/${bcast.body.requestId}`, { headers: auth })).body.request as any).lines[0];
      assert.equal((bcastLine.payload.body as any).message, "Server restarting in 10");

      const bad = await jf(`${base}/api/servers/${s.serverId}/maprotation/remove`, { method: "POST", headers: junior.auth, body: JSON.stringify({ mapId: "not_a_map" }) });
      assert.equal(bad.status, 202);
      const badReq = (await jf(`${base}/api/requests/${bad.body.requestId}`, { headers: auth })).body.request as any;
      const badSigned = await jf(`${base}/api/requests/${badReq.id}/lines/${badReq.lines[0].id}/approve`, { method: "POST", headers: auth, body: "{}" });
      assert.equal(badSigned.status, 200, JSON.stringify(badSigned.body));
      assert.ok(badSigned.body.applyError, "the handler's own refusal is what the approver reads");
    } finally { s.fake.close(); }
  });
});

/**
 * The cascade has to reach the surface the signature came from.
 *
 * A capped signer covers what their limit reaches and the remainder is filed onwards as a fresh
 * request. Pressed in the panel, the API posts a card for that follow-up. Pressed in DISCORD, it
 * did not: 24 of 48 hours applied, a new request appeared in a panel queue nobody was looking at,
 * the channel heard nothing, and the presser was told "Approved 1 line" as if the ask were done.
 */
test("approving from Discord posts a card for the remainder it could not cover", async () => {
  const { fakeGameServer } = await import("./fake-hll-server.ts");
  const { decideFromDiscord } = await import("../dist/approvals-relay.js");
  await withServer(async (base, repo, ctx) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const auth = { authorization: `Bearer ${l.body.token as string}` };
    const s = await fakeGameServer(base, l.body.token as string, "live");
    const realFetch = globalThis.fetch;
    const priorToken = process.env.DISCORD_TOKEN;
    const posts: { url: string; content: string }[] = [];
    // Only Discord is faked — the test drives the API over real HTTP.
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (!u.startsWith("https://discord.com")) return realFetch(url as never, init);
      const body = JSON.parse(String(init?.body ?? "{}")) as { content?: string };
      if ((init?.method ?? "GET") === "POST") posts.push({ url: u, content: String(body.content ?? "") });
      return new Response(JSON.stringify({ id: `m${posts.length}` }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    process.env.DISCORD_TOKEN = "t";
    try {
      await repo.appConfig.set({ approvalsChannelId: "chan1" });
      const pid = "76561198000000901";
      s.fake.players = [{ iD: pid, name: "Griefer" }];
      const junior = await staff(base, auth, "asker3", [{ capability: "server.view", level: "read" }]);
      await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "mid3", password: "pw" }) });
      const midId = ((await jf(`${base}/api/users`, { headers: auth })).body.users as any[]).find((u) => u.username === "mid3").id as string;
      await jf(`${base}/api/users/${midId}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants: [{ capability: "action.tempban", level: "write" }], limits: { "tempban.maxHours": 24 } }) });
      await repo.users.linkDiscord(midId, { discordId: "discord-mid3" });

      const filed = await jf(`${base}/api/servers/${s.serverId}/actions`, { method: "POST", headers: junior.auth, body: JSON.stringify({ action: "tempban", playerId: pid, playerName: "Griefer", reason: "Test", hours: 48 }) });
      assert.equal(filed.status, 202);
      const reqId = filed.body.requestId as string;
      const cardsAfterFiling = posts.length;
      assert.equal(cardsAfterFiling, 1, "the original ask got a card");

      const said = await decideFromDiscord(ctx, { discordUserId: "discord-mid3", requestId: reqId, verb: "all" });
      assert.match(said, /Approved 1 line/);
      assert.match(said, /filed for a longer limit/, "the presser is told the ask is not finished");

      // The remainder exists...
      const onward = ((await jf(`${base}/api/requests`, { headers: auth })).body.queue as any[])
        .find((r) => r.id !== reqId && r.lines.some((li: any) => li.kind === "tempban_extend"));
      assert.ok(onward, "the remainder was filed onwards");
      // ...and the channel was told about it, which is the whole point of the relay.
      const newCards = posts.slice(cardsAfterFiling).filter((m) => /Extend temp ban/.test(m.content));
      assert.equal(newCards.length, 1, `the follow-up got its own card (posts: ${JSON.stringify(posts.map((m) => m.content.slice(0, 60)))})`);
      assert.match(newCards[0]!.content, /asker3/, "and it is still the asker's request");
    } finally {
      globalThis.fetch = realFetch;
      if (priorToken === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = priorToken;
      s.fake.close();
    }
  });
});
