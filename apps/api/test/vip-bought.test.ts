/**
 * A VIP shop purchase's dates in the points history (vip-bought.ts, discord-public.ts): read back
 * from each server's grant in the trail, worded as small lines under the purchase, and kept inside
 * what one Discord message holds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createIsolatedRepository } from "@app/db";
import { historyPage, vipBoughtLines } from "../dist/discord-public.js";
import { vipBought, withVipBought } from "../dist/vip-bought.js";

const DAY = 86_400_000;

test("a purchase's dates: its days start at the new end less the days; odd or missing records give what they can", async () => {
  const { repo } = await createIsolatedRepository();
  const one = await repo.servers.create({ name: "One", host: "10.0.0.1", port: 1, password: "x" });
  const grant = (ref: unknown, data: Record<string, unknown>, serverId: string | null = one!.id) => repo.audit.create({
    actorUserId: null, actorName: "shop", action: "vip.grant", targetType: "player", targetId: "p-target", serverId, summary: "granted",
    data: { ref, via: "VIP shop", ...data },
  });
  await grant("buy:a", { playerId: "p1", expiration: "2026-12-15T00:00:00.000Z", days: 14 });
  await grant("buy:b", { playerId: "p1", groupHeld: true, bankedMs: DAY, days: 14 });
  await grant("buy:c", { expiration: "2026-12-15T00:00:00.000Z" }); // no days, no playerId
  await grant("buy:d", { playerId: "p1", expiration: "not a date", days: 3 }, "no-such-server");
  await grant("bonus:x", { playerId: "p1", expiration: "2026-12-15T00:00:00.000Z", days: 7 }); // the welcome bonus's days
  const bought = await vipBought(repo, [
    { ref: "buy:a" }, { ref: "buy:b" }, { ref: "buy:c" }, { ref: "buy:d" }, { ref: "bonus:x" }, { ref: null }, { ref: "buy:none" },
  ]);
  assert.deepEqual([...bought.keys()].sort(), ["buy:a", "buy:b", "buy:c", "buy:d"], "purchases only, and only those with a grant");
  assert.deepEqual(bought.get("buy:a"), [{ serverId: one!.id, serverName: "One", playerId: "p1", from: "2026-12-01T00:00:00.000Z", until: "2026-12-15T00:00:00.000Z", held: false }]);
  assert.deepEqual(bought.get("buy:b"), [{ serverId: one!.id, serverName: "One", playerId: "p1", from: null, until: null, held: true }], "held: no dates, the days wait");
  assert.deepEqual(bought.get("buy:c"), [{ serverId: one!.id, serverName: "One", playerId: "p-target", from: null, until: "2026-12-15T00:00:00.000Z", held: false }], "no days: the end alone; the account from the row's target");
  assert.deepEqual(bought.get("buy:d"), [{ serverId: "no-such-server", serverName: "a removed server", playerId: "p1", from: null, until: null, held: false }]);
  assert.deepEqual(await vipBought(repo, [{ ref: "gift:a" }, { ref: null }]), new Map(), "nothing to look up: nothing read");

  // Worded for Discord: the end alone when the start is unknown, nothing when neither is.
  assert.deepEqual(vipBoughtLines([...bought.get("buy:a")!, ...bought.get("buy:b")!, ...bought.get("buy:c")!, ...bought.get("buy:d")!]), [
    `-# One: VIP from <t:${Date.parse("2026-12-01T00:00:00.000Z") / 1000}:f> until <t:${Date.parse("2026-12-15T00:00:00.000Z") / 1000}:f>`,
    "-# One: days saved for when the group's permanent VIP ends",
    `-# One: VIP until <t:${Date.parse("2026-12-15T00:00:00.000Z") / 1000}:f>`,
  ]);
  assert.deepEqual(vipBoughtLines(undefined), []);

  // As the panel reads them: `vip` on a purchase found, nothing added to the rest.
  const rows = withVipBought([{ id: "1", ref: "buy:a" }, { id: "2", ref: "t:seed" }, { id: "3", ref: null }], bought);
  assert.deepEqual(rows.map((r) => r.vip?.length ?? 0), [1, 0, 0]);
  assert.ok(!("vip" in rows[1]!) && !("vip" in rows[2]!), "no empty field on the others");
});

test("a history page keeps every line whole: dates give way from the oldest line up when a page would run past the limit", () => {
  const entry = (n: number, dates: number) => ({ line: `line ${n} ${"x".repeat(80)}`, dates: Array.from({ length: dates }, (_, i) => `-# date ${n}.${i} ${"y".repeat(60)}`) });
  const entries = [entry(1, 2), entry(2, 2), entry(3, 2), entry(4, 2)];
  const all = historyPage("head", entries);
  assert.equal(all.split("\n").length, 1 + 4 + 8, "it fits: every line and every date");
  // A limit that holds every line and only some of the dates.
  const full = all.length;
  const tight = historyPage("head", entries, full - 100);
  const lines = tight.split("\n");
  assert.ok(tight.length <= full - 100, `inside the limit (${tight.length})`);
  assert.deepEqual(lines.filter((l) => l.startsWith("line ")).map((l) => l.split(" ")[1]), ["1", "2", "3", "4"], "every line stays");
  assert.ok(lines.includes(entries[0]!.dates[0]!) && !lines.some((l) => l.startsWith("-# date 4.")), "the newest keep their dates; the oldest gives way first");
  assert.equal(lines.indexOf(entries[0]!.dates[0]!), lines.indexOf(entries[0]!.line) + 1, "dates sit under their own line");
  // Not even the lines fit: all dates go, the lines stay for the host's cut.
  const none = historyPage("head", entries, 50);
  assert.equal(none.split("\n").length, 5);
  // The real budget: ten purchases over three servers, with long names.
  const ten = Array.from({ length: 10 }, (_, n) => ({
    line: `**-250** — VIP shop: Two Weeks — <t:1790000000:R>`,
    dates: vipBoughtLines(Array.from({ length: 3 }, (_, s) => ({ serverId: `s${s}`, serverName: `A long server name number ${s} ${n}`, playerId: "p", from: "2026-12-01T00:00:00.000Z", until: "2026-12-15T00:00:00.000Z", held: false }))),
  }));
  const page = historyPage("**Gold Coins history** — balance **0**, newest first.", ten);
  assert.ok(page.length <= 1900, `inside what the host sends (${page.length})`);
  assert.equal(page.split("\n").filter((l) => l.startsWith("**-250**")).length, 10, "all ten purchases listed");
});
