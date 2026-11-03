/**
 * The reconciler is the thing that lets an import be called done. So these tests care as much
 * about it FAILING correctly as passing: a checker that cannot see a missing row is worse than no
 * checker, because it manufactures confidence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRepository } from "@app/db";
import type { SqlClient } from "../src/crcon-import/from-database.ts";
const { reconcile, formatReport } = await import("../dist/crcon-import/reconcile.js");
const { resolveServerId } = await import("../dist/crcon-import/db-import-cli-resolve.js");

/** CRCON's side: just the aggregate queries the reconciler asks for. */
function fakeCrcon(opts: {
  logs?: { type: string; server: string; at: string }[];
  rounds?: { server: number; start: string; ended: boolean }[];
  scoreboardLines?: { server: number; start: string; ended: boolean }[];
  sessions?: { server: number; start: string }[];
}): SqlClient {
  const logs = opts.logs ?? [], rounds = opts.rounds ?? [];
  const sbl = opts.scoreboardLines ?? [], sess = opts.sessions ?? [];
  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
      const cutoff = params[1] as string | undefined;
      const before = (ts: string) => !cutoff || ts < cutoff;
      if (sql.includes("max(event_time)")) {
        const server = String(params[0]);
        const mine = logs.filter((l) => l.server === server).map((l) => l.at).sort();
        return { rows: [{ t: mine[mine.length - 1] ?? null }] as T[] };
      }
      if (sql.includes("FROM log_lines")) {
        const server = String(params[0]);
        const by = new Map<string, number>();
        for (const l of logs) {
          if (l.server !== server || !before(l.at)) continue;
          by.set(l.type, (by.get(l.type) ?? 0) + 1);
        }
        return { rows: [...by].map(([type, n]) => ({ type, n })) as T[] };
      }
      const server = Number(params[0]);
      if (sql.includes("FROM map_history WHERE")) {
        return { rows: [{ n: rounds.filter((r) => r.server === server && r.ended && before(r.start)).length }] as T[] };
      }
      if (sql.includes("FROM player_stats ps")) {
        return { rows: [{ n: sbl.filter((r) => r.server === server && r.ended && before(r.start)).length }] as T[] };
      }
      if (sql.includes("FROM player_sessions")) {
        return { rows: [{ n: sess.filter((r) => r.server === server && before(r.start)).length }] as T[] };
      }
      return { rows: [] };
    },
  };
}

const T = (n: number) => `2021-03-0${n}T00:00:00.000Z`;

async function setup() {
  const repo = await createRepository({});
  const server = await repo.servers.create({ name: "one", host: "127.0.0.1", port: 1, password: "x" });
  const p = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000001", name: "Alpha" });
  return { repo, server, p };
}

/** Insert a kill the way the transform does — a crcon-keyed event. */
const kill = (serverId: string, pid: string, id: string, ts: string) => ({
  serverId, ts, kind: "evt.kill", actorPlayerId: pid, actorName: "Alpha",
  victimPlayerId: pid, victimName: "Alpha", weapon: "W", data: null, dedupeKey: `crcon:${id}`,
});

test("a complete import reconciles clean", async () => {
  const { repo, server, p } = await setup();
  await repo.events.insert([kill(server.id, p.id, "1", T(1)), kill(server.id, p.id, "2", T(2))]);
  const crcon = fakeCrcon({ logs: [{ type: "KILL", server: "1", at: T(1) }, { type: "KILL", server: "1", at: T(2) }] });

  const rep = await reconcile(crcon, repo, server.id, 1);
  assert.equal(rep.complete, true, "every category agrees");
  const kills = rep.lines.find((l) => l.category === "log_kill")!;
  assert.deepEqual([kills.source, kills.destination, kills.delta], [2, 2, 0]);
});

test("a missing row is caught, named, and blocks completeness", async () => {
  const { repo, server, p } = await setup();
  // CRCON has three kills; only two landed. This is exactly the failure the reconciler exists for.
  await repo.events.insert([kill(server.id, p.id, "1", T(1)), kill(server.id, p.id, "2", T(2))]);
  const crcon = fakeCrcon({ logs: [
    { type: "KILL", server: "1", at: T(1) }, { type: "KILL", server: "1", at: T(2) }, { type: "KILL", server: "1", at: T(3) },
  ] });

  const rep = await reconcile(crcon, repo, server.id, 1);
  assert.equal(rep.complete, false, "an incomplete import cannot report complete");
  const kills = rep.lines.find((l) => l.category === "log_kill")!;
  assert.deepEqual([kills.source, kills.destination, kills.delta, kills.ok], [3, 2, -1, false]);
  assert.match(formatReport(rep), /FAIL log_kill/, "the report names the failing category");
  assert.match(formatReport(rep), /INCOMPLETE/);
});

test("the other server's rows are not counted as this server's shortfall", async () => {
  const { repo, server, p } = await setup();
  await repo.events.insert([kill(server.id, p.id, "1", T(1))]);
  // Server 2 has a hundred kills. None of them are server 1's business.
  const crcon = fakeCrcon({ logs: [
    { type: "KILL", server: "1", at: T(1) },
    ...Array.from({ length: 100 }, () => ({ type: "KILL", server: "2", at: T(2) })),
  ] });

  const rep = await reconcile(crcon, repo, server.id, 1);
  assert.equal(rep.complete, true, "a clean single-server import stays clean beside a busy sibling");
});

test("rows after the cutoff are the live tracker's, and are excluded from both sides", async () => {
  const { repo, server, p } = await setup();
  // A local event at T(5) sets the cutoff; the import legitimately stops there.
  await repo.events.insert([{
    serverId: server.id, ts: T(5), kind: "evt.kill", actorPlayerId: p.id, actorName: "Alpha",
    victimPlayerId: null, victimName: "M", weapon: "X", data: null, dedupeKey: "local-1",
  }]);
  await repo.events.insert([kill(server.id, p.id, "1", T(1))]);
  const crcon = fakeCrcon({ logs: [
    { type: "KILL", server: "1", at: T(1) },
    { type: "KILL", server: "1", at: T(9) }, // after the cutoff — never imported, by design
  ] });

  const rep = await reconcile(crcon, repo, server.id, 1);
  assert.equal(rep.cutoff, T(5));
  assert.equal(rep.complete, true, "a deliberate skip is not a shortfall");
  const kills = rep.lines.find((l) => l.category === "log_kill")!;
  assert.equal(kills.source, 1, "the source count applies the same cutoff the import does");
});

test("an unimported action family is surfaced rather than silently widening the count", async () => {
  const { repo, server } = await setup();
  const crcon = fakeCrcon({ logs: [{ type: "SOMETHING NEW", server: "1", at: T(1) }] });
  const rep = await reconcile(crcon, repo, server.id, 1);
  assert.equal(rep.complete, false, "a family we do not import blocks completeness until explained");
  assert.deepEqual(rep.unmappedLogRows, [{ type: "SOMETHING NEW", count: 1 }]);
  assert.match(formatReport(rep), /SOMETHING NEW/);
});

test("the coverage seam is reported: a window neither system recorded is named, not blamed", async () => {
  const { repo, server, p } = await setup();
  // CRCON's record ends March 1st; local tracking began June 1st. The three months between were
  // recorded by NOBODY — the reconciler must say so, or the light careers get blamed on the import.
  await repo.events.insert([{
    serverId: server.id, ts: "2021-06-01T00:00:00.000Z", kind: "evt.kill", actorPlayerId: p.id, actorName: "Alpha",
    victimPlayerId: null, victimName: "M", weapon: "X", data: null, dedupeKey: "local-1",
  }]);
  await repo.events.insert([kill(server.id, p.id, "1", T(1))]);
  const rep = await reconcile(fakeCrcon({ logs: [{ type: "KILL", server: "1", at: T(1) }] }), repo, server.id, 1);
  assert.ok(rep.seam, "the seam is detected");
  assert.equal(rep.seam!.sourceLastLog, T(1));
  assert.ok(rep.seam!.uncoveredHours > 2000, "roughly three months of uncovered time");
  assert.match(formatReport(rep), /coverage seam/);
  assert.equal(rep.complete, true, "a seam is a fact about the record, not an import failure");

  // And when the source's record reaches the cutoff, no seam is claimed.
  const { repo: r2, server: s2, p: p2 } = await setup();
  await r2.events.insert([{
    serverId: s2.id, ts: T(2), kind: "evt.kill", actorPlayerId: p2.id, actorName: "Alpha",
    victimPlayerId: null, victimName: "M", weapon: "X", data: null, dedupeKey: "local-1",
  }]);
  await r2.events.insert([kill(s2.id, p2.id, "1", T(1))]);
  const clean = await reconcile(fakeCrcon({ logs: [
    { type: "KILL", server: "1", at: T(1) }, { type: "KILL", server: "1", at: T(2) },
  ] }), r2, s2.id, 1);
  assert.equal(clean.seam, null, "a record that reaches the cutoff has no seam");
});

test("profile moderation events are accounted for, not compared against the log", async () => {
  const { repo, server, p } = await setup();
  // A received_actions ban: same kind as a log ban, but no log line behind it. Comparing it
  // against the (empty) admin log would fail a perfectly correct import.
  await repo.events.insert([{
    serverId: server.id, ts: T(1), kind: "evt.player.banned", actorPlayerId: p.id, actorName: "Alpha",
    victimPlayerId: null, victimName: null, weapon: null, data: null,
    dedupeKey: `crcon:ra:76561198000000001:${T(1)}:PERMABAN`,
  }]);
  const rep = await reconcile(crcon0(), repo, server.id, 1);
  assert.equal(rep.complete, true, "a profile-sourced ban does not read as an unexplained surplus");
  const line = rep.lines.find((l) => l.category === "profile moderation events")!;
  assert.equal(line.destination, 1);
  assert.match(line.note ?? "", /received_actions/);
  function crcon0() { return fakeCrcon({}); }
});

test("round lines may exceed the scoreboard (kill attribution adds lines), but a shortfall fails", async () => {
  const { repo, server, p } = await setup();
  await repo.matches.importOne({ serverId: server.id, map: "foy_warfare", startedAt: T(1), endedAt: T(2), winner: "allies", result: null });
  const m = (await repo.matches.list(server.id))[0]!;
  await repo.matches.importScoreboard({
    serverId: server.id, map: "foy_warfare", startedAt: T(1), endedAt: T(2), alliedScore: 1, axisScore: 0,
    stats: [{ playerId: p.id, playerName: "Alpha", side: "allies", kills: 1, deaths: 0, teamkills: 0, combat: 10, offense: 0, defense: 0, support: 0, vehicleKills: 0, vehiclesDestroyed: 0, timeSeconds: 60 }],
  });
  void m;
  // Source claims one line and one round: ours has exactly that → clean. Source claiming TWO
  // lines while ours holds one is a shortfall → FAIL (a scoreboard row failed to land).
  const okRep = await reconcile(fakeCrcon({ rounds: [{ server: 1, start: T(1), ended: true }], scoreboardLines: [{ server: 1, start: T(1), ended: true }] }), repo, server.id, 1);
  assert.equal(okRep.lines.find((l) => l.category === "scoreboard lines")!.ok, true);
  const short = await reconcile(fakeCrcon({ rounds: [{ server: 1, start: T(1), ended: true }], scoreboardLines: [{ server: 1, start: T(1), ended: true }, { server: 1, start: T(1), ended: true }] }), repo, server.id, 1);
  const line = short.lines.find((l) => l.category === "scoreboard lines")!;
  assert.deepEqual([line.ok, line.delta], [false, -1], "a missing scoreboard line still fails hard");
  assert.equal(short.complete, false);
});

test("sessions may exceed the source, because we also rebuild them from the log", async () => {
  const { repo, server, p } = await setup();
  await repo.sessions.importOne({ playerId: p.id, serverId: server.id, connectedAt: T(1), disconnectedAt: T(2), durationSec: 3600 });
  await repo.sessions.importOne({ playerId: p.id, serverId: server.id, connectedAt: T(3), disconnectedAt: T(4), durationSec: 3600 });
  // CRCON itself only kept one of them.
  const rep = await reconcile(fakeCrcon({ sessions: [{ server: 1, start: T(1) }] }), repo, server.id, 1);
  const line = rep.lines.find((l) => l.category === "sessions")!;
  assert.equal(line.ok, true, "a surplus is expected and explained");
  assert.match(line.note ?? "", /connect\/disconnect/);
  assert.equal(rep.complete, true);
});

test("--server takes the name staff actually have, not a uuid the panel never shows", async () => {
  const repo = await createRepository({});
  const a = await repo.servers.create({ name: "Lynx Division #1", host: "127.0.0.1", port: 1, password: "x" });
  const b = await repo.servers.create({ name: "Lynx Division #2", host: "127.0.0.1", port: 2, password: "x" });

  assert.equal(await resolveServerId(repo, "Lynx Division #1"), a.id, "exact name");
  assert.equal(await resolveServerId(repo, "lynx division #2"), b.id, "case-insensitive");
  assert.equal(await resolveServerId(repo, "#2"), b.id, "a unique fragment is enough");
  assert.equal(await resolveServerId(repo, a.id), a.id, "the id still works, for scripts");

  // Ambiguity and typos must STOP, never guess — importing a whole history into the wrong
  // server is not recoverable from a coin toss.
  await assert.rejects(() => resolveServerId(repo, "Lynx"), /matches 2 servers/);
  await assert.rejects(() => resolveServerId(repo, "Nope"), /no server named/);
  await assert.rejects(() => resolveServerId(repo, "00000000-0000-0000-0000-000000000000"), /no server with id/);
});
