/**
 * Three of the worker's global sweeps that write to a game server, kept apart from index.ts so they
 * can run in a test against a store and a fake game:
 *   - console admins whose time is up come off the game,
 *   - VIP pauses that have run out go back on it,
 *   - an event that opens with a rotation set replaces the server's rotation.
 *
 * None of them touches a RETIRED server. Retiring promises the server disappears from every
 * picker, worker, Discord surface and public page with nothing deleted, and it can be undone; these
 * three looked servers up by id, which still finds a retired one, so they kept dialing it. Each now
 * leaves a retired server's rows exactly as they are, and the first sweep after it is brought back
 * does whatever fell due meanwhile — the same arrangement as the VIP expiry sweep (vip-expiry.ts).
 */
import { automationEnabled, type Repository, type ServerRow } from "@app/db";
import { stateReaderFor } from "@app/games";
import { explicitRotationOf, planRotationApply } from "@app/maps";
import type { Logger } from "@app/shared";

/** One server's game, as these sweeps use it. Not connected until `connect` is called. */
export interface SweepGameClient {
  connect(): Promise<void>;
  execute(command: string, params?: Record<string, unknown>): Promise<unknown>;
  readState(kind: "maprotation"): Promise<unknown>;
  disconnect(): Promise<void>;
}

export interface ServerSweepDeps {
  repo: Repository;
  log: Logger;
  clientFor(server: ServerRow): SweepGameClient;
}

/**
 * Sweep expired console admins — the same arrangement as VIP: the game only supports permanent
 * admins, so the panel owns the expiration, and any grant past its stored expiry is removed from
 * the game (native RemoveAdmin) and from our table. Same observe-mode rules as the VIP sweep.
 */
export async function sweepExpiredConsoleAdmins(deps: ServerSweepDeps): Promise<void> {
  const { repo, log } = deps;
  const expired = await repo.consoleAdmins.expired(new Date().toISOString());
  if (!expired.length) return;
  const byServer = new Map<string, typeof expired>();
  for (const a of expired) (byServer.get(a.serverId) ?? byServer.set(a.serverId, []).get(a.serverId)!).push(a);

  for (const [serverId, rows] of byServer) {
    const server = await repo.servers.findById(serverId);
    if (!server) { // server gone — drop the orphaned grants
      for (const a of rows) await repo.consoleAdmins.remove(serverId, a.playerId);
      continue;
    }
    if (server.retiredAt) continue; // retired: rows and game as they are (see the top of this file)
    if (server.engagementMode === "observe") continue; // same quiet-skip as the VIP sweep
    if (!automationEnabled(server.automation, "consoleAdminSweep")) continue;
    const slog = log.child({ serverId, server: server.name });
    const client = deps.clientFor(server);
    try {
      await client.connect();
      for (const a of rows) {
        try {
          await client.execute("removeAdmin", { playerId: a.playerId });
          await repo.consoleAdmins.remove(serverId, a.playerId);
          await repo.audit.create({
            actorUserId: null, actorName: "system", action: "server.admin_expire",
            targetType: "player", targetId: a.playerId, targetName: a.playerName ?? undefined, serverId,
            summary: `console admin expired for ${a.playerName || a.playerId} on ${server.name}`, data: { playerId: a.playerId, group: a.adminGroup, expiration: a.expiration },
          });
          slog.info("removed expired console admin", { playerId: a.playerId });
        } catch (err) {
          slog.warn("could not remove expired console admin", { playerId: a.playerId, err: (err as Error).message });
        }
      }
    } catch (err) {
      slog.warn("console-admin sweep: could not connect", { err: (err as Error).message });
    } finally {
      await client.disconnect().catch(() => {});
    }
  }
}

/**
 * End lapsed VIP pauses: a pause is a timed punishment, so when paused_until passes the sweep puts
 * the VIP back on the game (grant still valid, server active) and clears the pause. A failed game
 * write leaves the pause in place so the next sweep retries; observe servers just clear (nothing
 * was on the game to restore). Runs AFTER the expiry sweep, so an expired grant is already gone.
 */
export async function resumeLapsedVipPauses(deps: ServerSweepDeps): Promise<void> {
  const { repo, log } = deps;
  const lapsed = await repo.vips.pauseLapsed(new Date().toISOString());
  if (!lapsed.length) return;
  const now = Date.now();
  for (const v of lapsed) {
    const server = await repo.servers.findById(v.serverId);
    // Retired: the pause stays, and runs out properly once the server is back. Clearing it here
    // would end the pause with the VIP still off the game.
    if (server?.retiredAt) continue;
    const slog = log.child({ serverId: v.serverId, server: server?.name });
    // Banked pauses froze the meter: push the expiration out by the pause's real duration before
    // judging validity. Running pauses give nothing back — that loss was the punishment.
    const bankMs = v.pauseMode === "banked" && v.expiration && v.pausedAt ? Math.max(0, now - Date.parse(v.pausedAt)) : 0;
    const expiration = bankMs > 0 ? new Date(Date.parse(v.expiration!) + bankMs).toISOString() : v.expiration;
    const stillValid = !expiration || Date.parse(expiration) > now;
    if (server && server.engagementMode === "active" && automationEnabled(server.automation, "vipSweep") && stillValid) {
      const client = deps.clientFor(server);
      try {
        await client.connect();
        await client.execute("addVip", { playerId: v.playerId, description: v.playerName || "VIP" });
      } catch (err) {
        slog.warn("could not restore VIP after pause — will retry next sweep", { playerId: v.playerId, err: (err as Error).message });
        await client.disconnect().catch(() => {});
        continue; // pause stays set → retried next sweep
      }
      await client.disconnect().catch(() => {});
    }
    // thawsPause: this date is already measured from now (see NewVip.thawsPause).
    if (bankMs > 0) await repo.vips.upsert({ serverId: v.serverId, playerId: v.playerId, playerName: v.playerName, comment: v.comment, expiration, createdByUserId: v.createdByUserId, createdByName: v.createdByName, thawsPause: true });
    await repo.vips.setPause(v.serverId, v.playerId, null);
    await repo.audit.create({
      actorUserId: null, actorName: "system", action: "player.vipresume",
      targetType: "player", targetId: v.playerId, targetName: v.playerName ?? undefined, serverId: v.serverId,
      summary: `VIP pause lapsed for ${v.playerName || v.playerId}${server ? ` on ${server.name}` : ""}${bankMs > 0 ? ` — ${Math.round(bankMs / 3_600_000)}h banked time returned` : ""}${stillValid ? " — VIP restored" : " (grant already expired)"}`,
      data: { playerId: v.playerId, pausedUntil: v.pausedUntil, pauseReason: v.pauseReason, pausedBy: v.pausedBy, mode: v.pauseMode, bankedMs: bankMs, ...(bankMs > 0 && expiration ? { expiration } : {}) },
    }).catch(() => {});
    slog.info("VIP pause lapsed", { playerId: v.playerId, mode: v.pauseMode, restored: Boolean(server && server.engagementMode === "active" && stillValid) });
  }
}

/**
 * The rotation half of an event opening: an OPEN event carrying a rotation set gets the server's
 * rotation replaced with the set's explicit lineup, once. The latch is `rotationAppliedAt` on the
 * row — durable, so it survives restarts, holds however many sweeps race, and stays unset when
 * the server was unreachable so the next sweep retries instead of the event losing its lineup.
 * The API sweeps events lazily too, but only THIS pass applies rotations: a staff member listing
 * payouts must never be the thing holding an RCON rebuild.
 *
 * Terminal skips (set deleted, wrong game, a recipe rather than a lineup) latch WITH an audit
 * note — retrying can't fix them, and silence would leave the event night on yesterday's maps
 * with nothing anywhere saying why. The create/edit routes refuse those pairings up front, so a
 * skip here means the set changed after the event was written.
 */

export async function applyEventRotations(deps: ServerSweepDeps): Promise<void> {
  const { repo, log } = deps;
  const due = (await repo.payoutEvents.list({ limit: 200 }))
    .filter((e) => e.status === "open" && e.rotationSetId && !e.rotationAppliedAt);
  for (const ev of due) {
    const server = await repo.servers.findById(ev.serverId);
    if (!server) { await repo.payoutEvents.markRotationApplied(ev.id, new Date().toISOString()); continue; }
    // Retired: no rotation, and no latch either, so one brought back while the event is still open
    // gets its lineup then — the same wait as an observe server's below.
    if (server.retiredAt) continue;
    const skip = async (reason: string) => {
      await repo.payoutEvents.markRotationApplied(ev.id, new Date().toISOString());
      await repo.audit.create({
        actorUserId: null, actorName: "events", action: "map.rotation.apply_set",
        targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
        summary: `event "${ev.name}" opened but its rotation was NOT applied — ${reason}`,
        data: { eventId: ev.id, setId: ev.rotationSetId, skipped: reason },
      });
    };
    const set = await repo.mapSets.get(ev.rotationSetId!);
    if (!set) { await skip("the map set no longer exists"); continue; }
    if (set.game !== server.game) { await skip(`"${set.name}" is a ${set.game} set and ${server.name} runs ${server.game}`); continue; }
    const target = explicitRotationOf(set.pool);
    if (!target || !target.length) { await skip(`"${set.name}" is a vote recipe now, not a concrete lineup`); continue; }
    if (server.engagementMode !== "active") continue; // observe is read-only; retry in case it flips before close
    const client = deps.clientFor(server);
    try {
      await client.connect();
      const before = stateReaderFor(server.game).rotation(await client.readState("maprotation")).maps;
      for (const s of planRotationApply(before, target)) {
        if (s.op === "add") await client.execute("addMapToRotation", { mapName: s.mapId, index: s.index });
        else await client.execute("removeMapFromRotation", { mapName: s.mapId, index: s.index });
      }
      await repo.payoutEvents.markRotationApplied(ev.id, new Date().toISOString());
      await repo.audit.create({
        actorUserId: null, actorName: "events", action: "map.rotation.apply_set",
        targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
        summary: `event "${ev.name}" opened — replaced the rotation on ${server.name} with the set "${set.name}" (${target.length} maps)`,
        data: { eventId: ev.id, setId: set.id, setName: set.name, maps: target, before },
      });
    } catch (err) {
      // Unreachable server: no latch, no audit — the next sweep retries while the event is open.
      log.warn("could not apply an event's rotation set — will retry next sweep", { event: ev.name, server: server.name, err: (err as Error).message });
    } finally {
      await client.disconnect().catch(() => {});
    }
  }
}
