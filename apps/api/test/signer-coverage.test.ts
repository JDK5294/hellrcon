/**
 * How many hours a signer may authorise, and whether signing moves the request anywhere.
 *
 * `signerCoverage` is where an hour cap becomes a decision, and its comment records a failure that
 * actually happened: rounding the cap onto the hours already applied left the line counting as
 * progress, so it approved, granted the same total again, filed an identical follow-up, and the
 * same signer could approve that one too — re-banning the player on every pass, for ever. The fix
 * is a Math.floor and a strictly-greater comparison, neither of which anything was holding to.
 *
 * The cap comes from tempbanMaxHours, so the principal here carries a real personal grant with a
 * real limit rather than a stubbed number — the union rule is part of what decides the answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRepository } from "@app/db";
import { signerCoverage } from "../dist/approvals.js";

/** A signer who may temp-ban on any server, capped at `maxHours` (omit for no cap). */
async function signerWith(maxHours?: number) {
  const repo = await createRepository();
  const user = await repo.users.create({ username: `s_${Math.random().toString(36).slice(2)}`, passwordHash: "h" });
  if (maxHours !== undefined) await repo.userLimits.replace(user.id, { "tempban.maxHours": maxHours });
  const grants = [{ capability: "action.tempban", scopeType: "global" as const, scopeId: null, level: "write" as const }];
  const p = { user, name: "Signer", grants, personalGrants: grants, roles: [], assignments: [] };
  return { ctx: { repo } as never, p: p as never };
}

const line = (over: Record<string, unknown> = {}) => ({
  kind: "tempban", serverId: "s1", payload: { hours: 48 }, ...over,
}) as never;

test("no cap: the signer covers whatever was asked for", async () => {
  const { ctx, p } = await signerWith();
  const c = await signerCoverage(ctx, p, line());
  assert.equal(c.covered, 48);
  assert.equal(c.partial, false);
  assert.equal(c.progress, true);
});

test("a fractional cap FLOORS — a 24.6h cap must not authorise 25h", async () => {
  // Rounding up here is a cap that does not cap, which is the whole reason the limit exists.
  const { ctx, p } = await signerWith(24.6);
  const c = await signerCoverage(ctx, p, line());
  assert.equal(c.covered, 24);
  assert.equal(c.partial, true, "24 of the 48 asked for — somebody else signs the rest");
  assert.equal(c.progress, true);
});

test("an extend that cannot beat what is already applied is NOT progress", async () => {
  /*
   * The re-ban loop. 24 hours are already signed for; this signer's cap floors to 24 as well, so
   * approving would grant the same total again and file an identical follow-up they could approve
   * again. Strictly-greater is what stops it: they are not moving the request anywhere.
   */
  const { ctx, p } = await signerWith(24.4);
  const c = await signerCoverage(ctx, p, line({ kind: "tempban_extend", payload: { hours: 48, appliedHours: 24 } }));
  assert.equal(c.applied, 24);
  assert.equal(c.covered, 24);
  assert.equal(c.progress, false, "equal is not progress — this is the loop the floor was added for");

  // One more whole hour of authority, and it moves.
  const better = await signerWith(25);
  const c2 = await signerCoverage(better.ctx, better.p, line({ kind: "tempban_extend", payload: { hours: 48, appliedHours: 24 } }));
  assert.equal(c2.covered, 25);
  assert.equal(c2.progress, true);
});

test("a cap under an hour authorises nothing at all", async () => {
  const { ctx, p } = await signerWith(0.5);
  const c = await signerCoverage(ctx, p, line());
  assert.equal(c.covered, 0, "hours are whole; half an hour of authority signs nothing");
  assert.equal(c.progress, false);
});

test("lines that are not temp bans have no coverage question to answer", async () => {
  const { ctx, p } = await signerWith(24);
  for (const kind of ["kick", "perma", "vip"]) {
    const c = await signerCoverage(ctx, p, line({ kind }));
    assert.deepEqual(c, { total: 0, covered: 0, applied: 0, partial: false, progress: true }, `${kind} is not capped by hours`);
  }
  // Nor is a temp ban with no hours on it.
  assert.equal((await signerCoverage(ctx, p, line({ payload: { hours: 0 } }))).progress, true);
});
