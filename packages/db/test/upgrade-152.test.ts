import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Migration 152. A play session is at most a day from its connect. Sessions stored before the cap
 * — a 1,584-hour one CRCON kept open until a disconnect line months on, one closed only by the
 * roster check's first sweep, one closed by a connect weeks later — are capped at a day, and the
 * extra time comes back off playtime only where the session put it there: closed by the panel's
 * own line, or folded in by the import. The roster check's sessions and an import's from after
 * the panel's own record began never added any, and a server's playtime that no longer holds a
 * session's whole length is left as it is.
 */
const DB = process.env.DATABASE_URL;

test("migration 152: sessions over a day are capped, and only the time they added comes off playtime", { skip: !DB }, async () => {
  const { MIGRATIONS } = await import("../dist/migrations.js");
  const pg = (await import("pg")).default;
  const schema = `up152_${Math.random().toString(36).slice(2, 8)}`;
  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  const q = (sql: string, args: unknown[] = []) => client.query(sql, args);
  try {
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}`);
    await q("CREATE TABLE schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const m of MIGRATIONS.filter((x) => x.id < "152")) {
      await q("BEGIN"); await q(m.sql); await q("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]); await q("COMMIT");
    }
    // WW2 carries an imported CRCON archive; Vietnam's import brought profiles only, no log lines.
    const ww2 = "00000000-0000-4000-8000-000000000152", viet = "00000000-0000-4000-8000-000000000153";
    await q("INSERT INTO servers (id, name, host, port, password) VALUES ($1, 'WW2', '127.0.0.1', 1, 'x'), ($2, 'Vietnam', '127.0.0.1', 2, 'x')", [ww2, viet]);
    const ids = ["imp", "live", "reap", "trim", "late", "reset", "vimp", "vreap", "other"];
    const pid = Object.fromEntries(ids.map((k, i) => [k, `00000000-0000-4000-8000-0000000015${String(i).padStart(2, "0")}`])) as Record<string, string>;
    for (const k of ids) await q("INSERT INTO players (id, platform, platform_id, name) VALUES ($1, 'steam', $2, $3)", [pid[k], `7656119800000${String(ids.indexOf(k)).padStart(4, "0")}`, k]);

    const H = 3_600_000;
    const session = (player: string, server: string, fromIso: string, toMs: number) => {
      const from = Date.parse(fromIso);
      return q("INSERT INTO player_sessions (id, player_id, server_id, connected_at, disconnected_at, duration_sec) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)",
        [player, server, new Date(from).toISOString(), new Date(from + toMs).toISOString(), Math.round(toMs / 1000)]);
    };
    const line = (server: string, player: string | null, kind: string, iso: string, dedupe: string | null) =>
      q("INSERT INTO evt (id, server_id, ts, kind, actor_player_id, dedupe_key) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)", [server, iso, kind, player, dedupe]);
    const playtime = (player: string, server: string, sec: number) =>
      q("INSERT INTO player_stats (player_id, server_id, playtime_sec) VALUES ($1, $2, $3)", [player, server, sec]);

    // The profile in the report: CRCON closed a 27 March connect at a 1 June disconnect line —
    // 1,584h 57m — beside five short sessions (4h 18m). The import added all of it.
    const big = 5_705_820_000, end = Date.parse("2026-06-01T06:27:53.000Z");
    await session(pid.imp!, ww2, new Date(end - big).toISOString(), big);
    for (const [i, min] of [69, 29, 53, 95, 12].entries()) await session(pid.imp!, ww2, `2026-03-0${i + 1}T10:00:00.000Z`, min * 60_000);
    await playtime(pid.imp!, ww2, 5_705_820 + 15_480);
    // The archive's log lines run to 20 July; the panel's own record begins in August.
    await line(ww2, pid.other!, "evt.player.disconnected", "2026-07-20T21:00:00.000Z", "crcon:9001");
    await line(ww2, pid.other!, "evt.player.connected", "2026-08-01T09:00:00.000Z", null);

    // Closed by the panel's own disconnect line 50 hours on, beside two hours of other play.
    await session(pid.live!, ww2, "2026-09-01T10:00:00.000Z", 50 * H);
    await line(ww2, pid.live!, "evt.player.disconnected", "2026-09-03T12:00:00.000Z", "v2:1788436800:DISCONNECTED live");
    await session(pid.live!, ww2, "2026-09-10T10:00:00.000Z", 2 * H);
    await playtime(pid.live!, ww2, 52 * 3600);
    // Swept up by the roster check three weeks on — never added to playtime.
    await session(pid.reap!, ww2, "2026-08-01T10:00:00.000Z", 21 * 24 * H);
    await playtime(pid.reap!, ww2, 5 * 3600);
    // A roster sweep that ended after the archive's lines but before the panel's earliest line still
    // stored — its own first lines trimmed away. A regular, so their playtime would cover it: the
    // import's boundary is the archive's last line, never the panel's first, wherever lines came in.
    await session(pid.trim!, ww2, "2026-07-21T10:00:00.000Z", 4 * 24 * H);
    await playtime(pid.trim!, ww2, 600 * 3600);
    // An imported session that ended after the panel's own record began — never added either.
    await session(pid.late!, ww2, "2026-08-10T00:00:00.000Z", 31 * 24 * H);
    await playtime(pid.late!, ww2, 10 * 3600);
    // Closed by the panel's own line, but the playtime has been reset since: it holds less than the session.
    await session(pid.reset!, ww2, "2026-09-05T00:00:00.000Z", 48 * H);
    await line(ww2, pid.reset!, "evt.player.disconnected", "2026-09-07T00:00:00.000Z", "v2:1788739200:DISCONNECTED reset");
    await playtime(pid.reset!, ww2, 2 * 3600);

    // Vietnam: a profile session from before the panel's first line there, and a roster sweep after it.
    await session(pid.vimp!, viet, "2026-05-01T00:00:00.000Z", 48 * H);
    await session(pid.vimp!, viet, "2026-05-10T00:00:00.000Z", 1 * H);
    await playtime(pid.vimp!, viet, 49 * 3600);
    await line(viet, pid.other!, "evt.player.connected", "2026-08-01T09:00:00.000Z", null);
    await session(pid.vreap!, viet, "2026-08-20T00:00:00.000Z", 5 * 24 * H);
    await playtime(pid.vreap!, viet, 3 * 3600);

    const m152 = MIGRATIONS.find((x) => x.id.startsWith("152"));
    assert.ok(m152, "migration 152 exists");
    const run = async () => { await q("BEGIN"); await q(m152.sql); await q("COMMIT"); };
    await run();

    const long = (await q("SELECT count(*)::int AS n FROM player_sessions WHERE duration_sec > 86400 OR disconnected_at > connected_at + interval '1 day'")).rows[0].n;
    assert.equal(long, 0, "no session is longer than a day");
    const capped = (await q(`SELECT p.name, s.connected_at, s.disconnected_at, s.duration_sec FROM player_sessions s JOIN players p ON p.id = s.player_id
                              WHERE s.duration_sec = 86400 ORDER BY p.name`)).rows as { name: string; connected_at: Date; disconnected_at: Date; duration_sec: number }[];
    assert.deepEqual(capped.map((r) => r.name), ["imp", "late", "live", "reap", "reset", "trim", "vimp", "vreap"]);
    for (const r of capped) assert.equal(r.disconnected_at.getTime() - r.connected_at.getTime(), 86_400_000, `${r.name} ends a day from its connect`);
    assert.equal((await q("SELECT count(*)::int AS n FROM player_sessions WHERE duration_sec < 86400")).rows[0].n, 7, "the short sessions are left as they were");

    const secs = async (name: string, server: string) =>
      Number((await q("SELECT playtime_sec FROM player_stats WHERE player_id = $1 AND server_id = $2", [pid[name], server])).rows[0].playtime_sec);
    assert.equal(await secs("imp", ww2), 86_400 + 15_480, "the report's profile: 1,589 hours down to 28h 18m");
    assert.equal(await secs("live", ww2), 86_400 + 7_200, "closed by the panel's own line: the extra 26 hours come off");
    assert.equal(await secs("reap", ww2), 5 * 3600, "the roster check's session never added any — nothing comes off");
    assert.equal(await secs("trim", ww2), 600 * 3600, "nor one after the archive's last line, whatever was trimmed since");
    assert.equal(await secs("late", ww2), 10 * 3600, "an import's session from after the panel's record began added none either");
    assert.equal(await secs("reset", ww2), 2 * 3600, "playtime that no longer holds the session is left alone");
    assert.equal(await secs("vimp", viet), 86_400 + 3_600, "no lines imported: a session ending before the panel's first line there was the import's");
    assert.equal(await secs("vreap", viet), 3 * 3600);

    const audit = (await q("SELECT actor_name, action, server_id, target_name, summary, data, automated FROM audit ORDER BY target_name DESC")).rows;
    assert.equal(audit.length, 2, "one audit row per server");
    assert.deepEqual(audit.map((a) => [a.action, a.server_id, a.automated]), [["app.long_sessions", ww2, true], ["app.long_sessions", viet, true]]);
    assert.deepEqual(audit[0].data, { sessions: 6, players: 2, hours: 1587 });
    assert.equal(audit[0].summary, "capped 6 play sessions longer than 24 hours at 24 hours from the connect, and took the 1587 extra hours they had added back off the playtime of 2 players");
    assert.deepEqual(audit[1].data, { sessions: 2, players: 1, hours: 24 });
    assert.match(audit[1].summary, /^capped 2 play sessions .* off the playtime of 1 player$/);

    // Run again, nothing is left to do: no session moves, no playtime changes, no second report.
    await run();
    assert.equal(await secs("imp", ww2), 86_400 + 15_480);
    assert.equal((await q("SELECT count(*)::int AS n FROM audit")).rows[0].n, 2);
  } finally {
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
