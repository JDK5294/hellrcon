/**
 * VIP for everyone selected in the Live view, then a message saying how much they have.
 *
 * Field report: the Live multi-select had no VIP at all, and a bulk message "won't get sent every
 * time". Pinned here: each player's message is filled AFTER their own grant (so {vip_until} is
 * the new time, not the old one), a paid permanent VIP is kept, and a message the game drops once
 * is retried rather than lost.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHllServer } from "./fake-hll-server.ts";
import { withServer, jf } from "./harness.ts";

async function setup(base: string, repo: Parameters<Parameters<typeof withServer>[0]>[1]) {
  await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  const auth = { authorization: `Bearer ${l.body.token as string}` };
  const fake = new FakeHllServer("pw");
  const port = await fake.listen();
  const srv = await repo.servers.create({ name: "WW2", game: "hll", protocol: "binary-v2", host: "127.0.0.1", port, password: "pw", engagementMode: "active" } as never);
  return { auth, fake, srv };
}

test("bulk VIP: every selected player gets it, then a message with THEIR new expiry", async () => {
  let fake: FakeHllServer | null = null;
  try {
    await withServer(async (base, repo) => {
      const s = await setup(base, repo);
      fake = s.fake;
      const paid = "76561198000000801", fresh = "76561198000000802", topped = "76561198000000803";
      await repo.vips.upsert({ serverId: s.srv.id, playerId: paid, expiration: null, createdByName: "staff" } as never);
      const inTwoDays = new Date(Date.now() + 2 * 86_400_000).toISOString();
      await repo.vips.upsert({ serverId: s.srv.id, playerId: topped, expiration: inTwoDays, createdByName: "staff" } as never);
      s.fake.dropFirstMessageTo.add(fresh); // the game loses the first send to this one

      const r = await jf(`${base}/api/servers/${s.srv.id}/vips/bulk`, {
        method: "POST", headers: s.auth,
        body: JSON.stringify({
          players: [{ playerId: paid, playerName: "Paid" }, { playerId: fresh, playerName: "Fresh" }, { playerId: topped, playerName: "Topped" }],
          mode: "duration", days: 1, cumulative: true, comment: "server seeded — thanks",
          message: "{player_name}: VIP {vip_remaining} left",
        }),
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.applied.length, 3);
      assert.equal(r.body.messageFailed, 0, "the dropped send was retried, not lost");

      // The paid permanent VIP is never shortened.
      assert.equal((await repo.vips.get(s.srv.id, paid))!.expiration, null);
      assert.match(r.body.applied.find((a: { playerId: string }) => a.playerId === paid).note, /already permanent — kept/);
      // Stacked: 2 days + 1 day.
      const toppedExp = Date.parse((await repo.vips.get(s.srv.id, topped))!.expiration!);
      assert.ok(Math.abs(toppedExp - (Date.now() + 3 * 86_400_000)) < 120_000, "one day added on top of the two they had");
      assert.ok(s.fake.vips.has(fresh) && s.fake.vips.has(topped), "the game was told");

      const got = new Map(s.fake.messages.map((m) => [m.playerId, m.message]));
      assert.match(got.get(paid)!, /^Paid: VIP permanent left/);
      assert.match(got.get(fresh)!, /^Fresh: VIP (1d|23h) left/, "the NEW grant, read after it was written");
      assert.match(got.get(topped)!, /^Topped: VIP (3d|2d 23h) left/, "their stacked total, not the two days they had before");
    });
  } finally {
    await (fake as FakeHllServer | null)?.close();
  }
});

test("bulk VIP without a message sends none; a missing length is refused", async () => {
  let fake: FakeHllServer | null = null;
  try {
    await withServer(async (base, repo) => {
      const s = await setup(base, repo);
      fake = s.fake;
      const bad = await jf(`${base}/api/servers/${s.srv.id}/vips/bulk`, { method: "POST", headers: s.auth, body: JSON.stringify({ players: [{ playerId: "76561198000000810" }], mode: "duration", days: 0, comment: "event" }) });
      assert.equal(bad.status, 400);
      // No comment: every VIP a person adds says who paid, what for, or which event.
      const silent = await jf(`${base}/api/servers/${s.srv.id}/vips/bulk`, { method: "POST", headers: s.auth, body: JSON.stringify({ players: [{ playerId: "76561198000000810" }], mode: "duration", hours: 6, comment: "  " }) });
      assert.equal(silent.status, 400);
      assert.match(String(silent.body.error?.message ?? ""), /a comment is required for every VIP added/);
      assert.equal(await repo.vips.get(s.srv.id, "76561198000000810"), null, "nothing was granted");
      const ok = await jf(`${base}/api/servers/${s.srv.id}/vips/bulk`, { method: "POST", headers: s.auth, body: JSON.stringify({ players: [{ playerId: "76561198000000810" }], mode: "duration", hours: 6, comment: "event" }) });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(s.fake.messages.length, 0);
    });
  } finally {
    await (fake as FakeHllServer | null)?.close();
  }
});

test("the Live view's bulk message retries a send the game dropped", async () => {
  let fake: FakeHllServer | null = null;
  try {
    await withServer(async (base, repo) => {
      const s = await setup(base, repo);
      fake = s.fake;
      s.fake.dropFirstMessageTo.add("76561198000000821");
      const r = await jf(`${base}/api/servers/${s.srv.id}/actions/bulk`, {
        method: "POST", headers: s.auth,
        body: JSON.stringify({ action: "message", message: "hello {player_name}", players: [{ playerId: "76561198000000820", playerName: "A" }, { playerId: "76561198000000821", playerName: "B" }] }),
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.applied.length, 2);
      assert.deepEqual(s.fake.messages.map((m) => m.playerId).sort(), ["76561198000000820", "76561198000000821"]);
    });
  } finally {
    await (fake as FakeHllServer | null)?.close();
  }
});

/*
 * "Replace" across several players must never CUT anyone's time: a member with 20 days who gets
 * a 1-day group or Live-view grant with stacking off keeps their 20 — time they may have paid for.
 */
test("a group or bulk VIP grant with stacking off never shortens anyone's existing VIP", async () => {
  let fake: FakeHllServer | null = null;
  try {
    await withServer(async (base, repo) => {
      const s = await setup(base, repo);
      fake = s.fake;
      const rich = "76561198000000831", fresh = "76561198000000832";
      const twentyDays = new Date(Date.now() + 20 * 86_400_000).toISOString();
      await repo.vips.upsert({ serverId: s.srv.id, playerId: rich, expiration: twentyDays, createdByName: "staff" } as never);

      const bulk = await jf(`${base}/api/servers/${s.srv.id}/vips/bulk`, {
        method: "POST", headers: s.auth,
        body: JSON.stringify({ players: [{ playerId: rich }, { playerId: fresh }], mode: "duration", days: 1, cumulative: false, comment: "event" }),
      });
      assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
      assert.equal((await repo.vips.get(s.srv.id, rich))!.expiration, twentyDays, "bulk: the 20 days stand");
      assert.ok((await repo.vips.get(s.srv.id, fresh))!.expiration, "bulk: the other player got their day");

      const made = await jf(`${base}/api/player-groups`, { method: "POST", headers: s.auth, body: JSON.stringify({ name: "regulars" }) });
      const gid = (made.body.group as { id: string }).id;
      await jf(`${base}/api/player-groups/${gid}/members`, { method: "POST", headers: s.auth, body: JSON.stringify({ playerId: rich, playerName: "Rich" }) });
      const grp = await jf(`${base}/api/player-groups/${gid}/apply`, {
        method: "POST", headers: s.auth,
        body: JSON.stringify({ action: "vip", serverId: s.srv.id, mode: "duration", days: 1, cumulative: false, comment: "event" }),
      });
      assert.equal(grp.status, 200, JSON.stringify(grp.body));
      assert.equal((await repo.vips.get(s.srv.id, rich))!.expiration, twentyDays, "group: the 20 days stand");
      const until = await jf(`${base}/api/player-groups/${gid}/apply`, {
        method: "POST", headers: s.auth,
        body: JSON.stringify({ action: "vip", serverId: s.srv.id, mode: "until", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), comment: "event" }),
      });
      assert.equal(until.status, 200);
      assert.equal((await repo.vips.get(s.srv.id, rich))!.expiration, twentyDays, "group, fixed date: still never cut");
    });
  } finally {
    await (fake as FakeHllServer | null)?.close();
  }
});

test("a group or bulk VIP grant keeps the note on VIP someone already had — its comment is the new VIP's note and in everyone's history", async () => {
  /*
   * Every VIP a person adds carries a comment, so a group or bulk grant always has one. It is the
   * note of the VIP it creates; a player who already had VIP keeps their own note — a paid grant's
   * receipt is not replaced because the selection they were in got a day — whether the time
   * stacked, was set, or met permanent VIP. The comment is in every one of their VIP histories.
   */
  let fake: FakeHllServer | null = null;
  try {
    await withServer(async (base, repo) => {
      const s = await setup(base, repo);
      fake = s.fake;
      const paid = "76561198000000841", fresh = "76561198000000842";
      const receipt = "paid $5 — receipt 4411";
      await repo.vips.upsert({ serverId: s.srv.id, playerId: paid, comment: receipt, expiration: new Date(Date.now() + 5 * 86_400_000).toISOString(), createdByName: "staff" } as never);
      const commentsFor = async (playerId: string) =>
        (await repo.audit.list({ action: "vip.grant", targetId: playerId, limit: 50 })).map((e) => (e.data as { comment?: string } | null)?.comment ?? null);

      const bulk = await jf(`${base}/api/servers/${s.srv.id}/vips/bulk`, {
        method: "POST", headers: s.auth,
        body: JSON.stringify({ players: [{ playerId: paid }, { playerId: fresh }], mode: "duration", days: 1, cumulative: true, comment: "server seeded — thanks" }),
      });
      assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
      assert.equal((await repo.vips.get(s.srv.id, paid))!.comment, receipt, "bulk: the receipt note stands on time it extended");
      assert.equal((await repo.vips.get(s.srv.id, fresh))!.comment, "server seeded — thanks", "a new VIP's note is the comment");
      assert.ok((await commentsFor(paid)).includes("server seeded — thanks"), "and the comment is in the history of the VIP it extended");

      const made = await jf(`${base}/api/player-groups`, { method: "POST", headers: s.auth, body: JSON.stringify({ name: "note keepers" }) });
      const gid = (made.body.group as { id: string }).id;
      await jf(`${base}/api/player-groups/${gid}/members`, { method: "POST", headers: s.auth, body: JSON.stringify({ playerId: paid, playerName: "Paid" }) });
      const silent = await jf(`${base}/api/player-groups/${gid}/apply`, {
        method: "POST", headers: s.auth, body: JSON.stringify({ action: "vip", serverId: s.srv.id, mode: "duration", days: 1, cumulative: true }),
      });
      assert.equal(silent.status, 400, "group: no comment, no VIP");
      assert.match(String(silent.body.error?.message ?? ""), /a comment is required for every VIP added/);
      const grp = await jf(`${base}/api/player-groups/${gid}/apply`, {
        method: "POST", headers: s.auth, body: JSON.stringify({ action: "vip", serverId: s.srv.id, mode: "duration", days: 1, cumulative: true, comment: "event winner" }),
      });
      assert.equal(grp.status, 200, JSON.stringify(grp.body));
      assert.equal((await repo.vips.get(s.srv.id, paid))!.comment, receipt, "group: the receipt note stands");
      assert.ok((await commentsFor(paid)).includes("event winner"), "and the comment is in their history");
      // Made permanent: a set length the store's floor turns away leaves the note as well.
      await repo.vips.upsert({ serverId: s.srv.id, playerId: paid, expiration: null, createdByName: "staff" } as never);
      const setTo = await jf(`${base}/api/player-groups/${gid}/apply`, {
        method: "POST", headers: s.auth, body: JSON.stringify({ action: "vip", serverId: s.srv.id, mode: "duration", days: 1, cumulative: false, comment: "season pass" }),
      });
      assert.equal(setTo.status, 200);
      const after = (await repo.vips.get(s.srv.id, paid))!;
      assert.equal(after.expiration, null, "still permanent");
      assert.equal(after.comment, receipt, "a permanent VIP's note is not restamped by a grant that did not make it");
    });
  } finally {
    await (fake as FakeHllServer | null)?.close();
  }
});

test("a player listed twice in one bulk grant gets the time once", async () => {
  let fake: FakeHllServer | null = null;
  try {
    await withServer(async (base, repo) => {
      const s = await setup(base, repo);
      fake = s.fake;
      const id = "76561198000000851";
      const r = await jf(`${base}/api/servers/${s.srv.id}/vips/bulk`, {
        method: "POST", headers: s.auth,
        body: JSON.stringify({ players: [{ playerId: id }, { playerId: id }], mode: "duration", days: 1, cumulative: true, comment: "event" }),
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.applied.length, 1);
      const left = Date.parse((await repo.vips.get(s.srv.id, id))!.expiration!) - Date.now();
      assert.ok(left < 1.5 * 86_400_000, "one day, not two");
    });
  } finally {
    await (fake as FakeHllServer | null)?.close();
  }
});

test("bulk VIP: an oversized list is refused fast — the de-duplication before the cap is one pass", async () => {
  let fake: FakeHllServer | null = null;
  try {
    await withServer(async (base, repo) => {
      const s = await setup(base, repo);
      fake = s.fake;
      // Distinct ids are the worst case for a pairwise de-duplication, and it ran before the cap
      // that refuses them. The Live view never sends more than a server holds; a crafted call can.
      const players = Array.from({ length: 40_000 }, (_, i) => ({ playerId: `p${i}` }));
      const started = performance.now();
      const r = await jf(`${base}/api/servers/${s.srv.id}/vips/bulk`, { method: "POST", headers: s.auth, body: JSON.stringify({ players, mode: "duration", hours: 1, comment: "event" }) });
      const ms = performance.now() - started;
      assert.equal(r.status, 400);
      assert.match(r.body.error.message, /too many players/);
      assert.ok(ms < 1000, `refusing the list took ${Math.round(ms)}ms`);
    });
  } finally {
    await (fake as FakeHllServer | null)?.close();
  }
});


/*
 * A VIP list uploaded from a file (the VIPs page's Upload): each player their own end, from the
 * list, and the same rule as every bulk grant — VIP is only ever added or lengthened. A paid
 * permanent stays permanent, a longer grant keeps its length, and a line the game should not get
 * (a date already past) is skipped with the reason while the rest go through.
 */
test("an uploaded VIP list gives each player their own end and only ever adds or lengthens VIP", async () => {
  let fake: FakeHllServer | null = null;
  try {
    await withServer(async (base, repo) => {
      const s = await setup(base, repo);
      fake = s.fake;
      const day = 86_400_000;
      const at = (days: number) => new Date(Date.now() + days * day).toISOString();
      const id = (n: number) => `76561198000000${n}`;
      const [paid, longer, shorter, fresh, fresh2, past] = [id(901), id(902), id(903), id(904), id(905), id(906)];
      await repo.vips.upsert({ serverId: s.srv.id, playerId: paid, expiration: null, comment: "bought permanent", createdByName: "staff" } as never);
      await repo.vips.upsert({ serverId: s.srv.id, playerId: longer, expiration: at(30), comment: "30 days", createdByName: "staff" } as never);
      await repo.vips.upsert({ serverId: s.srv.id, playerId: shorter, expiration: at(2), comment: "2 days", createdByName: "staff" } as never);
      const upload = (players: unknown[]) => jf(`${base}/api/servers/${s.srv.id}/vips/bulk`, {
        method: "POST", headers: s.auth, body: JSON.stringify({ upload: true, mode: "permanent", comment: "restored after the wipe", players }),
      });

      const r = await upload([
        { playerId: paid, until: at(10) },
        { playerId: longer, until: at(10) },
        { playerId: shorter, until: at(10) },
        { playerId: fresh, until: null, comment: "paid monthly" },
        { playerId: fresh2, until: at(10) },
        { playerId: past, until: at(-1) },
      ]);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const exp = async (id: string) => (await repo.vips.get(s.srv.id, id))?.expiration;
      const near = (iso: string | null | undefined, days: number) => iso != null && Math.abs(Date.parse(iso) - (Date.now() + days * day)) < 120_000;
      assert.equal(await exp(paid), null, "a paid permanent stays permanent");
      assert.ok(near(await exp(longer), 30), "a longer grant keeps its length");
      assert.ok(near(await exp(shorter), 10), "a shorter one is lengthened to the list's end");
      assert.equal(await exp(fresh), null, "permanent, as the list said");
      assert.ok(near(await exp(fresh2), 10));
      assert.equal((await repo.vips.get(s.srv.id, fresh))!.comment, "paid monthly", "the list's own comment");
      assert.equal((await repo.vips.get(s.srv.id, fresh2))!.comment, "restored after the wipe", "else the upload's");
      assert.equal((await repo.vips.get(s.srv.id, shorter))!.comment, "2 days", "a grant already there keeps its note");
      assert.equal(await repo.vips.get(s.srv.id, past), null);
      assert.match(r.body.skipped.find((x: { playerId: string }) => x.playerId === past).reason, /in the past/);
      assert.ok(s.fake.vips.has(fresh) && s.fake.vips.has(shorter), "the game was told");
      const trail = await repo.audit.list({ action: "vip.grant" });
      assert.ok(trail.some((a) => a.targetId === fresh && /from an uploaded list/.test(a.summary)), "the trail says where it came from");

      // A line with no end of its own would take the call's mode, which the list never chose.
      const loose = await upload([{ playerId: "76561198000000907" }]);
      assert.equal(loose.status, 400);
      assert.equal(await repo.vips.get(s.srv.id, "76561198000000907"), null);
    });
  } finally {
    await (fake as FakeHllServer | null)?.close();
  }
});
