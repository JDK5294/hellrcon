import { test } from "node:test";
import assert from "node:assert/strict";
import { withIsolatedServer as withServer, jf, assertAsked } from "./harness.ts";

async function login(base: string, u: string, p: string) {
  const r = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: u, password: p }) });
  return { authorization: `Bearer ${r.body.token as string}` };
}

test("announcement read receipts: first-read stamped once, ack idempotent, drafts excluded", async () => {
  await withServer(async (base) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const owner = await login(base, "owner", "pw");
    await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "mod", password: "pw" }) });
    const mod = await login(base, "mod", "pw");

    const posted = await jf(`${base}/api/community/announcements`, { method: "POST", headers: owner, body: JSON.stringify({ title: "Rules v2", body: "read me", published: true }) });
    const draft = await jf(`${base}/api/community/announcements`, { method: "POST", headers: owner, body: JSON.stringify({ title: "wip", body: "later", published: false }) });
    const noticeId = posted.body.announcement.id as string;
    const draftId = draft.body.announcement.id as string;
    assert.ok(posted.body.announcement.publishedAt, "posting stamps publishedAt");
    assert.equal(draft.body.announcement.publishedAt, null);

    // The board attaches the caller's own read state; nothing read yet.
    const before = await jf(`${base}/api/community/announcements`, { headers: mod });
    assert.equal(before.body.announcements[0].myRead, null);

    // Rendering the board marks first reads. Draft ids are ignored even if sent.
    assert.equal((await jf(`${base}/api/community/announcements/read`, { method: "POST", headers: mod, body: JSON.stringify({ ids: [noticeId, draftId] }) })).status, 200);
    const after = await jf(`${base}/api/community/announcements`, { headers: mod });
    const firstReadAt = after.body.announcements[0].myRead.readAt as string;
    assert.ok(firstReadAt);
    assert.equal(after.body.announcements[0].myRead.acknowledgedAt, null);

    // Re-marking never overwrites the first read time.
    await new Promise((r) => setTimeout(r, 15));
    await jf(`${base}/api/community/announcements/read`, { method: "POST", headers: mod, body: JSON.stringify({ ids: [noticeId] }) });
    const again = await jf(`${base}/api/community/announcements`, { headers: mod });
    assert.equal(again.body.announcements[0].myRead.readAt, firstReadAt);

    // Acknowledge: sets acknowledgedAt once; ack on a draft is refused.
    const ack = await jf(`${base}/api/community/announcements/${noticeId}/ack`, { method: "POST", headers: mod });
    assert.equal(ack.status, 200);
    const ackAt = ack.body.read.acknowledgedAt as string;
    assert.ok(ackAt);
    await new Promise((r) => setTimeout(r, 15));
    const ack2 = await jf(`${base}/api/community/announcements/${noticeId}/ack`, { method: "POST", headers: mod });
    assert.equal(ack2.body.read.acknowledgedAt, ackAt); // first ack time kept
    assert.equal((await jf(`${base}/api/community/announcements/${draftId}/ack`, { method: "POST", headers: mod })).status, 404);
  });
});

test("read analytics are for board editors only, and answer who/when/how long", async () => {
  await withServer(async (base) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const owner = await login(base, "owner", "pw");
    await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "mod2", password: "pw" }) });
    const mod = await login(base, "mod2", "pw");

    const posted = await jf(`${base}/api/community/announcements`, { method: "POST", headers: owner, body: JSON.stringify({ title: "Event", body: "b", published: true }) });
    const id = posted.body.announcement.id as string;
    await jf(`${base}/api/community/announcements/read`, { method: "POST", headers: mod, body: JSON.stringify({ ids: [id] }) });
    await jf(`${base}/api/community/announcements/${id}/ack`, { method: "POST", headers: mod });

    // Plain staff can read the board but not the receipts of others.
    const denied = await jf(`${base}/api/community/announcements/${id}/reads`, { headers: mod });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error?.missing?.capability, "community.edit");
    assert.equal((await jf(`${base}/api/community/announcements/analytics`, { headers: mod })).status, 403);

    // The editor sees: who read it (with minutes-after-post ≥ 0 and ack), and who hasn't.
    const reads = await jf(`${base}/api/community/announcements/${id}/reads`, { headers: owner });
    assert.equal(reads.status, 200);
    assert.equal(reads.body.staffCount, 2);
    assert.equal(reads.body.reads.length, 1);
    assert.equal(reads.body.reads[0].name, "mod2");
    assert.ok(reads.body.reads[0].minutesToSee >= 0);
    assert.ok(reads.body.reads[0].acknowledgedAt);
    assert.deepEqual(reads.body.unread.map((u: { name: string }) => u.name), ["owner"]);

    const an = await jf(`${base}/api/community/announcements/analytics`, { headers: owner });
    assert.equal(an.status, 200);
    assert.equal(an.body.staffCount, 2);
    assert.equal(an.body.postedCount, 1);
    const row = an.body.notices.find((n: { id: string }) => n.id === id);
    assert.equal(row.readCount, 1);
    assert.equal(row.ackCount, 1);
    assert.equal(an.body.overallReadRate, 0.5);

    // Re-posting re-anchors publishedAt (a re-posted notice is a fresh ask to read it).
    const firstPublishedAt = posted.body.announcement.publishedAt as string;
    await jf(`${base}/api/community/announcements/${id}`, { method: "PATCH", headers: owner, body: JSON.stringify({ published: false }) });
    await new Promise((r) => setTimeout(r, 15));
    const reposted = await jf(`${base}/api/community/announcements/${id}`, { method: "PATCH", headers: owner, body: JSON.stringify({ published: true }) });
    assert.ok(Date.parse(reposted.body.announcement.publishedAt) > Date.parse(firstPublishedAt));
    assert.equal(reposted.body.announcement.nudgedAt, null); // fresh nudge cycle too
  });
});

test("nudge config: editor-gated, validated, and enabling requires a channel", async () => {
  await withServer(async (base) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const owner = await login(base, "owner", "pw");
    await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "mod3", password: "pw" }) });
    const mod = await login(base, "mod3", "pw");

    assert.equal((await jf(`${base}/api/community/announcements/nudge-config`, { headers: mod })).status, 403);
    // A change is asked for, not made — the defaults below are untouched.
    assertAsked(await jf(`${base}/api/community/announcements/nudge-config`, { method: "PUT", headers: mod, body: JSON.stringify({ afterHours: 12 }) }));

    const defaults = await jf(`${base}/api/community/announcements/nudge-config`, { headers: owner });
    assert.equal(defaults.status, 200);
    assert.equal(defaults.body.config.enabled, false);
    assert.equal(defaults.body.config.afterHours, 48);

    // Bad inputs are refused; enabling without a channel is refused BEFORE anything is stored.
    assert.equal((await jf(`${base}/api/community/announcements/nudge-config`, { method: "PUT", headers: owner, body: JSON.stringify({ channelId: "not-a-channel" }) })).status, 400);
    assert.equal((await jf(`${base}/api/community/announcements/nudge-config`, { method: "PUT", headers: owner, body: JSON.stringify({ afterHours: 0 }) })).status, 400);
    assert.equal((await jf(`${base}/api/community/announcements/nudge-config`, { method: "PUT", headers: owner, body: JSON.stringify({ enabled: true }) })).status, 400);
    const still = await jf(`${base}/api/community/announcements/nudge-config`, { headers: owner });
    assert.equal(still.body.config.enabled, false);

    const saved = await jf(`${base}/api/community/announcements/nudge-config`, { method: "PUT", headers: owner, body: JSON.stringify({ enabled: true, channelId: "123456789012", afterHours: 24 }) });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.config, { enabled: true, channelId: "123456789012", afterHours: 24, excusedUserIds: [] });

    // The excused list: away staff the reminder never names. The GET ships the staff options
    // under the same editor gate, a made-up id is refused rather than stored as a phantom
    // excusal, and the real one round-trips.
    const withStaff = await jf(`${base}/api/community/announcements/nudge-config`, { headers: owner });
    const options = withStaff.body.staff as { id: string; name: string }[];
    assert.ok(options.some((s) => s.name === "mod3"), "the picker's options are the team");
    const modId = options.find((s) => s.name === "mod3")!.id;
    assert.equal((await jf(`${base}/api/community/announcements/nudge-config`, { method: "PUT", headers: owner, body: JSON.stringify({ excusedUserIds: ["00000000-0000-4000-8000-00000000dead"] }) })).status, 400);
    const excused = await jf(`${base}/api/community/announcements/nudge-config`, { method: "PUT", headers: owner, body: JSON.stringify({ excusedUserIds: [modId] }) });
    assert.equal(excused.status, 200, JSON.stringify(excused.body));
    assert.deepEqual(excused.body.config.excusedUserIds, [modId]);
    assert.deepEqual((await jf(`${base}/api/community/announcements/nudge-config`, { headers: owner })).body.config.excusedUserIds, [modId], "the excusal survives the store");
  });
});

test("staff profile aggregates notice engagement: read rate, acks, time-to-see, unread", async () => {
  await withServer(async (base) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const owner = await login(base, "owner", "pw");
    await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "reader", password: "pw" }) });
    const reader = await login(base, "reader", "pw");
    const readerId = ((await jf(`${base}/api/users`, { headers: owner })).body.users as { id: string; username: string }[])
      .find((u) => u.username === "reader")!.id;

    // Two posted notices + one draft (drafts never count against anyone).
    const mk = async (title: string, published: boolean) =>
      (await jf(`${base}/api/community/announcements`, { method: "POST", headers: owner, body: JSON.stringify({ title, body: "b", published }) })).body.announcement.id as string;
    const a1 = await mk("one", true);
    await mk("two", true);
    await mk("draft", false);

    // The reader sees notice one and acknowledges it; notice two stays unread.
    await jf(`${base}/api/community/announcements/read`, { method: "POST", headers: reader, body: JSON.stringify({ ids: [a1] }) });
    await jf(`${base}/api/community/announcements/${a1}/ack`, { method: "POST", headers: reader });

    const prof = await jf(`${base}/api/audit/staff/${readerId}`, { headers: owner });
    assert.equal(prof.status, 200);
    const n = prof.body.notices;
    assert.equal(n.postedCount, 2);
    assert.equal(n.readCount, 1);
    assert.equal(n.unreadCount, 1);
    assert.equal(n.ackCount, 1);
    assert.equal(n.readRate, 0.5);
    assert.ok(n.avgMinutesToSee !== null && n.avgMinutesToSee >= 0);
    assert.ok(n.medianMinutesToSee !== null && n.medianMinutesToSee >= 0);

    // A staff member who read nothing: zeros, not nulls (posted notices still count against them).
    const ownerId = ((await jf(`${base}/api/users`, { headers: owner })).body.users as { id: string; username: string }[])
      .find((u) => u.username === "owner")!.id;
    const prof2 = await jf(`${base}/api/audit/staff/${ownerId}`, { headers: owner });
    const n2 = prof2.body.notices;
    assert.equal(n2.postedCount, 2);
    assert.equal(n2.readCount, 0);
    assert.equal(n2.unreadCount, 2);
    assert.equal(n2.readRate, 0);
    assert.equal(n2.avgMinutesToSee, null);
  });
});

test("editing a notice keeps the create route's bounds: no blank titles, no unbounded bodies", async () => {
  await withServer(async (base) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const owner = await login(base, "owner", "pw");
    const posted = await jf(`${base}/api/community/announcements`, { method: "POST", headers: owner, body: JSON.stringify({ title: "Rules", body: "read me", published: true }) });
    const id = posted.body.announcement.id as string;

    // A blank (or whitespace) title/body is refused — an edit must not blank what a create requires.
    assert.equal((await jf(`${base}/api/community/announcements/${id}`, { method: "PATCH", headers: owner, body: JSON.stringify({ title: "   " }) })).status, 400);
    assert.equal((await jf(`${base}/api/community/announcements/${id}`, { method: "PATCH", headers: owner, body: JSON.stringify({ body: "" }) })).status, 400);
    // Over the same ceilings the create route enforces — refused, not stored.
    assert.equal((await jf(`${base}/api/community/announcements/${id}`, { method: "PATCH", headers: owner, body: JSON.stringify({ title: "x".repeat(201) }) })).status, 400);
    assert.equal((await jf(`${base}/api/community/announcements/${id}`, { method: "PATCH", headers: owner, body: JSON.stringify({ body: "x".repeat(5001) }) })).status, 400);
    // A legal edit still lands, trimmed.
    const ok = await jf(`${base}/api/community/announcements/${id}`, { method: "PATCH", headers: owner, body: JSON.stringify({ title: "  Rules v2  " }) });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.announcement.title, "Rules v2");
    assert.equal(ok.body.announcement.body, "read me", "the untouched field stays");
  });
});

/*
 * The board a page at a time, with how many there are: it read the newest fifty posted notices,
 * an editor's the newest hundred, and nothing older could be found on it. The reach shown beside
 * each notice is read for the same page.
 */
test("the board comes a page at a time, with how many there are, and its reach for the same page", async () => {
  await withServer(async (base) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const owner = await login(base, "owner", "pw");
    // Five posted and two drafts.
    for (let i = 0; i < 7; i++) {
      await jf(`${base}/api/community/announcements`, { method: "POST", headers: owner, body: JSON.stringify({ title: `Notice ${i}`, body: "b", published: i % 3 !== 2 }) });
    }
    const ids = (r: { body: Record<string, any> }) => (r.body.announcements as { id: string }[]).map((a) => a.id);
    const posted = await jf(`${base}/api/community/announcements?limit=500`, { headers: owner });
    assert.equal(posted.body.total, 5);
    assert.equal(posted.body.announcements.length, 5);
    const two = await jf(`${base}/api/community/announcements?offset=2&limit=2`, { headers: owner });
    assert.deepEqual(ids(two), ids(posted).slice(2, 4), "the posted notices, two down");
    assert.equal(two.body.total, 5, "with how many there are on every page");
    const all = await jf(`${base}/api/community/announcements/all?limit=500`, { headers: owner });
    assert.equal(all.body.total, 7, "an editor's, drafts included");
    const last = await jf(`${base}/api/community/announcements/all?offset=6&limit=3`, { headers: owner });
    assert.deepEqual(ids(last), ids(all).slice(6), "an editor's last page");
    const reach = await jf(`${base}/api/community/announcements/analytics?offset=3&limit=2`, { headers: owner });
    assert.deepEqual(reach.body.notices.map((n: { id: string }) => n.id), ids(all).slice(3, 5), "the reach of the same notices, in the same order");
  });
});
