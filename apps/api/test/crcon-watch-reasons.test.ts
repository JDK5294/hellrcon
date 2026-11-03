import { test } from "node:test";
import assert from "node:assert/strict";
import { jf, ownerAuth, withIsolatedServer as withServer } from "./harness.ts";

/*
 * A watch brought over from CRCON was written onto the player's flag alone, with no reason record
 * — and the reasons are the record (watch.ts). The worker's expiry sweep lifts a watch whose last
 * reason has lapsed, and one with none at all counted: every imported watch was lifted within
 * minutes, filed as "expired". Before that, the Watched tab said "no reason recorded", and the
 * first reason staff added took the imported one's place on the flag.
 */
async function applyArchive(base: string, id: string, auth: Record<string, string>) {
  const started = await jf(`${base}/api/servers/${id}/import/crcon/transform`, { method: "POST", headers: auth });
  if (started.status !== 202) return started;
  for (let i = 0; i < 200; i++) {
    const st = await jf(`${base}/api/servers/${id}/import/crcon/transform/status`, { headers: auth });
    if (st.body.status === "done") return { status: 200, body: st.body.summary };
    if (st.body.status === "error") throw new Error(`transform failed: ${st.body.error}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("transform did not finish in time");
}

type WatchedRow = { name: string; playerId: string; reasons: { id: string; reason: string; addedBy: string | null; addedAt: string }[] };

test("a watch brought over from CRCON keeps its reason, its author and its time, once", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "WW2 #1", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;
    const ndjson = [
      // The archive's own watchlist row, and a watch found on a player's profile.
      { dataType: "watchlist", entityKey: "222", raw: { player_id: "222", name: "Bravo", is_watched: true, reason: "repeat TK", by: "OldAdmin", modified: "2024-05-01T10:00:00Z" } },
      { dataType: "player_detail", entityKey: "333", raw: { player_id: "333", name: "Charlie", watchlist: { is_watched: true, reason: "spawn camping", by: "Mod2", modified: "2024-06-01T10:00:00" } } },
      // Watched with no words kept: still a reason, so the watch has one.
      { dataType: "watchlist", entityKey: "444", raw: { player_id: "444", name: "Delta", is_watched: true } },
    ].map((r) => JSON.stringify(r)).join("\n");
    await jf(`${base}/api/servers/${id}/import/crcon/upload`, { method: "POST", headers: auth, body: ndjson });
    assert.equal((await applyArchive(base, id, auth)).status, 200);

    const watched = async () => (await jf(`${base}/api/players/flagged`, { headers: auth })).body.flags as WatchedRow[];
    const of = (rows: WatchedRow[], name: string) => rows.find((r) => r.name === name);
    let rows = await watched();
    assert.deepEqual(of(rows, "Bravo")?.reasons.map((r) => [r.reason, r.addedBy, r.addedAt]), [["repeat TK", "OldAdmin", "2024-05-01T10:00:00.000Z"]],
      "CRCON's words, author and time, as the Watched tab lists them");
    assert.deepEqual(of(rows, "Charlie")?.reasons.map((r) => [r.reason, r.addedBy, r.addedAt]), [["spawn camping", "Mod2", "2024-06-01T10:00:00.000Z"]]);
    assert.deepEqual(of(rows, "Delta")?.reasons.map((r) => [r.reason, r.addedBy]), [["on the watchlist", null]]);
    assert.deepEqual(await repo.watchReasons.lapsedWatchers(), [], "nothing for the expiry sweep to lift");

    // Applied again: the same watches, not second reasons.
    await applyArchive(base, id, auth);
    rows = await watched();
    for (const name of ["Bravo", "Charlie", "Delta"]) assert.equal(of(rows, name)?.reasons.length, 1, `${name}: one reason after a second apply`);

    // A reason staff add, and later close, leaves the imported one standing.
    const bravo = of(rows, "Bravo")!;
    const added = await jf(`${base}/api/players/${bravo.playerId}/watch/reasons`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "alt account?" }) });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.deepEqual(of(await watched(), "Bravo")?.reasons.map((r) => r.reason).sort(), ["alt account?", "repeat TK"], "both are on the record");
    const closed = await jf(`${base}/api/players/${bravo.playerId}/watch/reasons/${added.body.reason.id as string}`, { method: "DELETE", headers: auth });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.deepEqual(of(await watched(), "Bravo")?.reasons.map((r) => r.reason), ["repeat TK"], "still watched, for CRCON's reason");
  });
});
