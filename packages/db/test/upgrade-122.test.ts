import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Migration 122 against switches the old ingest stored: no data, the game's line only in the
 * dedupe key. It must read the teams back and name the side swaps exactly as ingest now does
 * (@app/games describeTeamSwitch, folded per player per round) — the strings below are that
 * function's — and leave alone what it cannot read or what already carries its teams.
 */
const DB = process.env.DATABASE_URL;

test("migration 122: old team switches get their teams back, and the side swaps are named per round", { skip: !DB }, async () => {
  const { MIGRATIONS } = await import("../dist/migrations.js");
  const pg = (await import("pg")).default;
  const schema = `up122_${Math.random().toString(36).slice(2, 8)}`;
  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  const q = (sql: string, args: unknown[] = []) => client.query(sql, args);
  try {
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}`);
    await q("CREATE TABLE schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const m of MIGRATIONS.filter((x) => x.id < "122")) {
      await q("BEGIN"); await q(m.sql); await q("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]); await q("COMMIT");
    }

    const S1 = "00000000-0000-4000-8000-000000000001";
    const S2 = "00000000-0000-4000-8000-000000000002";
    const T0 = 1784760000;
    const put = async (server: string, sec: number, kind: string, name: string | null, key: string | null, data: unknown = null) =>
      (await q(
        "INSERT INTO evt (id, server_id, ts, kind, actor_name, data, dedupe_key) VALUES (gen_random_uuid(), $1, to_timestamp($2), $3, $4, $5::jsonb, $6) RETURNING id",
        [server, T0 + sec, kind, name, data === null ? null : JSON.stringify(data), key],
      )).rows[0].id as string;
    const sw = (server: string, sec: number, name: string, teams: string) =>
      put(server, sec, "evt.player.teamSwitched", name, `${T0 + sec}|TEAMSWITCH ${name} (${teams})`);
    const start = (server: string, sec: number) => put(server, sec, "evt.match.started", null, `${T0 + sec}|MATCH START Foy Warfare`, { map: "Foy Warfare" });

    // Last round: Bob on Allies.
    await start(S1, -100);
    const lastRound = await sw(S1, -50, "Bob", "None > Allies");
    // This round.
    await start(S1, 0);
    const joinAxis = await sw(S1, 5, "Bob", "None > Axis");
    // A swap whose two lines share a second, delivered newest first.
    const swapJoin = await sw(S1, 300, "Bob", "None > Allies");
    const swapLeave = await sw(S1, 300, "Bob", "Axis > None");
    // Down to Unassigned and back to the same side: no swap.
    const dropOut = await sw(S1, 400, "Bob", "Allies > None");
    const dropBack = await sw(S1, 401, "Bob", "None > Allies");
    // A direct line across, should the game ever write one: the second swap.
    const direct = await sw(S1, 500, "Bob", "Allies > Axis");
    const nowhere = await sw(S1, 600, "Bob", "None > None");
    // A name carrying its own brackets, stored as the old parser cut it ("Bob") while the real Bob
    // is on Axis: read under the cut name it would be a swap off his side. And a key with no prefix.
    const ttv = await put(S1, 10, "evt.player.teamSwitched", "Bob", `${T0 + 10}|TEAMSWITCH Bob (TTV) (None > Allies)`);
    const bare = await put(S1, 50, "evt.player.teamSwitched", "Carl", "TEAMSWITCH Carl (None > Allies)");
    // A row stored by the new ingest is read for the round but never rewritten.
    const kept = await put(S1, 20, "evt.player.teamSwitched", "Alice", `${T0 + 20}|TEAMSWITCH Alice (None > Allies)`, { from: "None", to: "Allies", change: "joined Allies", marker: "untouched" });
    const aliceLeave = await sw(S1, 30, "Alice", "Allies > None");
    const aliceSwap = await sw(S1, 31, "Alice", "None > Axis");
    // An imported row: no line in its key, nothing to read.
    const imported = await put(S1, 40, "evt.player.teamSwitched", "Dave", "crcon:123");
    // The round ends: what comes after is not this round's.
    await put(S1, 800, "evt.match.ended", null, `${T0 + 800}|MATCH ENDED Foy`, { result: "x" });
    const afterEnd = await sw(S1, 810, "Bob", "None > Allies");
    // Another server is its own count, with no round start on record at all.
    const s2Join = await sw(S2, 700, "Bob", "None > Allies");
    await sw(S2, 701, "Bob", "Allies > None");
    const s2Swap = await sw(S2, 702, "Bob", "None > Axis");
    // No round edge on record at all (or trimmed away): a month apart is not one round.
    const S3 = "00000000-0000-4000-8000-000000000003";
    const DAY = 86_400;
    const eve = [await sw(S3, 0, "Eve", "None > Allies"), await sw(S3, 30 * DAY, "Eve", "None > Axis"), await sw(S3, 60 * DAY, "Eve", "None > Allies")];
    // …while a swap within the hour still is one.
    const eveSwap = [await sw(S3, 60 * DAY + 600, "Eve", "Allies > None"), await sw(S3, 60 * DAY + 601, "Eve", "None > Axis")];

    const m122 = MIGRATIONS.find((x) => x.id.startsWith("122"));
    assert.ok(m122, "migration 122 exists");
    await q("BEGIN"); await q(m122.sql); await q("INSERT INTO schema_migrations (id) VALUES ($1)", [m122.id]); await q("COMMIT");

    const dataOf = async (id: string) => (await q("SELECT data FROM evt WHERE id = $1", [id])).rows[0].data;
    const joined = (to: string) => ({ from: "None", to, change: `joined ${to}` });
    const left = (from: string) => ({ from, to: "None", change: `left ${from}` });

    assert.deepEqual(await dataOf(lastRound), joined("Allies"));
    assert.deepEqual(await dataOf(joinAxis), joined("Axis"), "last round's side is not this round's");
    assert.deepEqual(await dataOf(swapLeave), left("Axis"), "within a second the leave reads first");
    assert.deepEqual(await dataOf(swapJoin), { from: "None", to: "Allies", swapFrom: "Axis", swapCount: 1, change: "switched sides Axis → Allies" });
    assert.deepEqual(await dataOf(dropOut), left("Allies"));
    assert.deepEqual(await dataOf(dropBack), joined("Allies"), "back to the same side is no swap");
    assert.deepEqual(await dataOf(direct), { from: "Allies", to: "Axis", swapFrom: "Allies", swapCount: 2, change: "switched sides Allies → Axis" });
    assert.deepEqual(await dataOf(nowhere), { from: "None", to: "None", change: "unassigned" });
    assert.deepEqual(await dataOf(ttv), joined("Allies"), "Bob (TTV) is his own player, his teams the last bracket");
    assert.equal((await q("SELECT actor_name FROM evt WHERE id = $1", [ttv])).rows[0].actor_name, "Bob (TTV)", "and his name is whole again");
    assert.equal((await q("SELECT actor_name FROM evt WHERE id = $1", [joinAxis])).rows[0].actor_name, "Bob");
    assert.deepEqual(await dataOf(bare), joined("Allies"));
    assert.equal((await dataOf(kept)).marker, "untouched");
    assert.deepEqual(await dataOf(aliceLeave), left("Allies"), "read against the kept row");
    assert.deepEqual(await dataOf(aliceSwap), { from: "None", to: "Axis", swapFrom: "Allies", swapCount: 1, change: "switched sides Allies → Axis" });
    assert.equal(await dataOf(imported), null, "nothing to read, nothing written");
    assert.deepEqual(await dataOf(afterEnd), joined("Allies"), "the round ended — no swap carried over");
    assert.deepEqual(await dataOf(s2Join), joined("Allies"));
    assert.equal((await dataOf(s2Swap)).swapCount, 1, "the other server's own count");
    assert.deepEqual(await Promise.all(eve.map(dataOf)), [joined("Allies"), joined("Axis"), joined("Allies")]);
    assert.deepEqual(await dataOf(eveSwap[1]!), { from: "None", to: "Axis", swapFrom: "Allies", swapCount: 1, change: "switched sides Allies → Axis" });

    // Running it again changes nothing.
    const before = (await q("SELECT id, data, actor_name FROM evt ORDER BY id")).rows;
    await q(m122.sql);
    assert.deepEqual((await q("SELECT id, data, actor_name FROM evt ORDER BY id")).rows, before);
  } finally {
    await q(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
