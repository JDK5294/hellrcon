/**
 * The shared map-set library: map sets (WHAT can be voted on) and vote schedules (WHEN a set
 * applies), each a named, editable, deletable record belonging to the community rather than to one
 * server.
 *
 * Why these are not per-server, and not presets: curating a pool is real work, and both of the old
 * shapes made that work repeat. Per-server inline sets meant building the same thing again on every
 * server and then keeping the copies in step by hand. Hardcoded presets meant the five starting
 * points could be copied but never corrected — a community that disagreed with "friday" was stuck
 * with it in the list forever. One library fixes both: a set is authored once, used by any number of
 * servers, and belongs to the people using it.
 *
 * Schedules are a separate library from sets on purpose. A timing is reusable in its own right —
 * "Friday teatime" is a fact about the community's week, not about one pool of maps — and welding
 * it to a set meant re-entering the same window every time another set wanted it.
 *
 * Every save of a set or a schedule is kept in its version history (see ../versions.ts), so an
 * accidental change — or delete — can be put back: a shared record changes the vote on every
 * server that uses it, which is exactly when an undo matters.
 *
 * Everything here is community-wide, so the capability is checked with canAnywhere rather than
 * against a server: there is no server for a library record to belong to.
 */
import { TEXT_MAX, boundedText, readJsonBody, sendError, sendJson } from "../http.js";
import { canAnywhere } from "@app/access";
import { getGame, listGames } from "@app/games";
import type { ConfigVersionKind, MapSetRow, VoteScheduleRow } from "@app/db";
import { parsePoolOverrides, parseScheduleSpec, requirePrincipal, route, sendForbidden, type Route } from "./kit.js";
import { mapSetSnapshot, recordVersion, snapshotChanged, voteScheduleSnapshot, whenSaved } from "../versions.js";
import type { AppContext } from "../context.js";

/** Postgres surfaces the unique-name index as a 23505; the memory store throws a message shaped to
 *  match. Either way the person needs "that name is taken", not a 500. */
function isDuplicateName(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "23505" || /duplicate key|already exists/i.test(e?.message ?? "");
}

/**
 * A server as the "used by" lists name it. A retired server's pairing still counts, since it
 * resolves again the day the server comes back, so it is named and said to be retired rather
 * than shown as a bare id.
 */
function usageLabel(s: { name: string; retiredAt: string | null }): string {
  return s.retiredAt ? `${s.name} (retired)` : s.name;
}

/**
 * Which servers point at this library record, by name.
 *
 * Deleting a set out from under a server would not fail loudly — the pairing would simply stop
 * resolving and that server's vote would quietly fall back to the engine's whole-catalogue
 * defaults, which is the kind of change nobody notices until a vote offers the wrong maps. So the
 * usage is looked up first and the delete is refused with the names in the message.
 */
async function serversUsing(ctx: AppContext, kind: "set" | "schedule", name: string): Promise<string[]> {
  const [configs, servers] = await Promise.all([ctx.repo.mapVote.listConfigs(), ctx.repo.servers.list({ includeRetired: true })]);
  const nameById = new Map(servers.map((s) => [s.id, usageLabel(s)]));
  const lower = name.toLowerCase();
  const out: string[] = [];
  for (const cfg of configs) {
    const used = cfg.profileLinks.some((l) =>
      kind === "set" ? l.mapSet.toLowerCase() === lower : (l.schedule ?? "").toLowerCase() === lower);
    if (used) out.push(nameById.get(cfg.serverId) ?? cfg.serverId);
  }
  return out;
}

/**
 * Both libraries, each record carrying the servers that point at it.
 *
 * "Shared: editing this changes the vote on Warfare, Offensive" is the one thing you need before
 * touching a record that is not only yours, so it is computed alongside the records rather than
 * left for the editor to guess. Served with the vote config (the only page that edits these), so
 * the two dropdowns paint from the first response instead of flashing empty.
 */
export async function libraryWithUsage(ctx: AppContext, game?: string) {
  // Sets are narrowed to the asking server's game: a pool of map ids means nothing to a game that
  // has none of them, and an editor that offers WW2 sets to a Vietnam server is inviting the one
  // mistake that only shows up in Discord at vote time. Schedules are times, not maps, so they stay
  // shared across every game.
  const [sets, schedules, configs, servers] = await Promise.all([
    ctx.repo.mapSets.list(game), ctx.repo.voteSchedules.list(), ctx.repo.mapVote.listConfigs(), ctx.repo.servers.list({ includeRetired: true }),
  ]);
  const serverName = new Map(servers.map((s) => [s.id, usageLabel(s)]));
  const setUsage = new Map<string, string[]>();
  const schedUsage = new Map<string, string[]>();
  const note = (into: Map<string, string[]>, key: string, where: string) => {
    const list = into.get(key) ?? [];
    if (!list.includes(where)) list.push(where);
    into.set(key, list);
  };
  for (const cfg of configs) {
    const where = serverName.get(cfg.serverId) ?? cfg.serverId;
    for (const link of cfg.profileLinks) {
      note(setUsage, link.mapSet.toLowerCase(), where);
      if (link.schedule) note(schedUsage, link.schedule.toLowerCase(), where);
    }
  }
  return {
    sets: sets.map((s) => ({ ...s, usedBy: setUsage.get(s.name.toLowerCase()) ?? [] })),
    schedules: schedules.map((s) => ({ ...s, usedBy: schedUsage.get(s.name.toLowerCase()) ?? [] })),
  };
}

type Outcome<T> = { ok: true; row: T; renamedFrom?: string } | { ok: false; status: number; message: string };

/**
 * One edit to a map set: the name checked, the game change refused while a server uses the set,
 * the pool validated, and a rename carried through every server's pairings. The editor's Save and
 * a restore from the history both come through here, so putting back an old name moves the
 * pairings back with it.
 */
async function applyMapSetEdit(ctx: AppContext, existing: MapSetRow, body: Record<string, unknown>): Promise<Outcome<MapSetRow>> {
  // Read the old name BEFORE the update: the in-memory store hands back the live row, so
  // comparing against `existing.name` afterwards compares the new name with itself and the
  // rename silently never propagates to the servers using it.
  const wasNamed = existing.name;
  const patch: { name?: string; game?: string; pool?: Record<string, unknown> } = {};
  if (body.name !== undefined) {
    const name = boundedText(body.name, TEXT_MAX.name, "map set name");
    if (!name) return { ok: false, status: 400, message: "a map set needs a name" };
    patch.name = name;
  }
  if (body.game !== undefined) {
    // Relabelling exists because sets built before a second game arrived were all stamped with the
    // only game there was, and some of them are really the new game's. It is refused while a
    // server still points at the set, since that pairing would become the cross-game one this
    // whole rule exists to prevent.
    const game = String(body.game).trim().toLowerCase();
    if (!getGame(game)) {
      return { ok: false, status: 400, message: `unknown game "${game}" — known games are ${listGames().map((g) => g.id).join(", ")}` };
    }
    if (game !== existing.game) {
      const inUse = await serversUsing(ctx, "set", wasNamed);
      if (inUse.length) {
        return { ok: false, status: 409, message: `"${wasNamed}" is in use on ${inUse.join(", ")} — remove it there before changing which game it is for` };
      }
      patch.game = game;
    }
  }
  if (body.pool !== undefined) {
    const pool = parsePoolOverrides(body.pool, `map set "${patch.name ?? wasNamed}"`);
    if ("error" in pool) return { ok: false, status: 400, message: pool.error };
    patch.pool = pool.value as Record<string, unknown>;
  }
  try {
    const set = await ctx.repo.mapSets.update(existing.id, patch);
    if (!set) return { ok: false, status: 404, message: "map set not found" };
    // A rename has to carry every pairing with it, or a server silently loses the set it picked.
    if (patch.name && patch.name.toLowerCase() !== wasNamed.toLowerCase()) {
      await renameInLinks(ctx, "set", wasNamed, patch.name);
    }
    return { ok: true, row: set, renamedFrom: patch.name && patch.name !== wasNamed ? wasNamed : undefined };
  } catch (err) {
    if (isDuplicateName(err)) return { ok: false, status: 409, message: `a map set called "${patch.name}" already exists` };
    throw err;
  }
}

/** One edit to a vote schedule — the same single path as applyMapSetEdit. */
async function applyScheduleEdit(ctx: AppContext, existing: VoteScheduleRow, body: Record<string, unknown>): Promise<Outcome<VoteScheduleRow>> {
  // Same reason as the map-set path above: capture the old name before it is overwritten.
  const wasNamed = existing.name;
  const patch: { name?: string; spec?: Record<string, unknown> } = {};
  if (body.name !== undefined) {
    const name = boundedText(body.name, TEXT_MAX.name, "schedule name");
    if (!name) return { ok: false, status: 400, message: "a schedule needs a name" };
    patch.name = name;
  }
  if (body.spec !== undefined) {
    const spec = parseScheduleSpec(body.spec, `schedule "${patch.name ?? wasNamed}"`);
    if ("error" in spec) return { ok: false, status: 400, message: spec.error };
    patch.spec = spec.value as Record<string, unknown>;
  }
  try {
    const schedule = await ctx.repo.voteSchedules.update(existing.id, patch);
    if (!schedule) return { ok: false, status: 404, message: "schedule not found" };
    if (patch.name && patch.name.toLowerCase() !== wasNamed.toLowerCase()) {
      await renameInLinks(ctx, "schedule", wasNamed, patch.name);
    }
    return { ok: true, row: schedule, renamedFrom: patch.name && patch.name !== wasNamed ? wasNamed : undefined };
  } catch (err) {
    if (isDuplicateName(err)) return { ok: false, status: 409, message: `a schedule called "${patch.name}" already exists` };
    throw err;
  }
}

const KIND_OF: Record<string, ConfigVersionKind> = { sets: "mapSet", schedules: "voteSchedule" };

export const mapLibraryRoutes: Route[] = [
  route("POST", "/api/mapvote/sets", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "mapvote.config", "write")) return sendForbidden(res, "mapvote.config", "write");
    const body = await readJsonBody(req);
    const name = boundedText(body.name, TEXT_MAX.name, "map set name");
    if (!name) return sendError(res, 400, "a map set needs a name");
    // Named, never defaulted. A set that guessed its game would be the same silent mislabelling
    // that made a Vietnam server read as WW2: wrong in a way nothing on screen admits to.
    const game = String(body.game ?? "").trim().toLowerCase();
    if (!game) return sendError(res, 400, "a map set has to say which game its maps belong to");
    if (!getGame(game)) {
      return sendError(res, 400, `unknown game "${game}" — known games are ${listGames().map((g) => g.id).join(", ")}`);
    }
    const pool = parsePoolOverrides(body.pool, `map set "${name}"`);
    if ("error" in pool) return sendError(res, 400, pool.error);
    try {
      const set = await ctx.repo.mapSets.create({ name, game, pool: pool.value as Record<string, unknown> });
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "mapvote.set.create",
        targetType: "mapset", targetId: set.id, targetName: set.name,
        summary: `created the ${set.game} map set "${set.name}"`,
        data: { game: set.game },
      });
      sendJson(res, 201, { set });
    } catch (err) {
      if (isDuplicateName(err)) return sendError(res, 409, `a map set called "${name}" already exists`);
      throw err;
    }
  }),

  route("PUT", "/api/mapvote/sets/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "mapvote.config", "write")) return sendForbidden(res, "mapvote.config", "write");
    const existing = await ctx.repo.mapSets.get(params.id!);
    if (!existing) return sendError(res, 404, "map set not found");
    const before = mapSetSnapshot(existing);
    const out = await applyMapSetEdit(ctx, existing, await readJsonBody(req));
    if (!out.ok) return sendError(res, out.status, out.message);
    const set = out.row;
    const after = mapSetSnapshot(set);
    if (snapshotChanged(before, after)) await recordVersion(ctx.repo, p, { kind: "mapSet", targetId: set.id, targetName: set.name, change: "edit", before, after });
    const usedBy = await serversUsing(ctx, "set", set.name);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "mapvote.set.update",
      targetType: "mapset", targetId: set.id, targetName: set.name,
      summary: `edited the map set "${set.name}"${usedBy.length ? ` (used by ${usedBy.join(", ")})` : ""}`,
      data: { renamedFrom: out.renamedFrom, usedBy },
    });
    sendJson(res, 200, { set });
  }),

  route("DELETE", "/api/mapvote/sets/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "mapvote.config", "write")) return sendForbidden(res, "mapvote.config", "write");
    const set = await ctx.repo.mapSets.get(params.id!);
    if (!set) return sendError(res, 404, "map set not found");
    const usedBy = await serversUsing(ctx, "set", set.name);
    if (usedBy.length) {
      return sendError(res, 409, `"${set.name}" is still in use on ${usedBy.join(", ")} — remove it there first`);
    }
    const snap = mapSetSnapshot(set);
    await ctx.repo.mapSets.remove(set.id);
    await recordVersion(ctx.repo, p, { kind: "mapSet", targetId: set.id, targetName: set.name, change: "delete", before: snap, after: null });
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "mapvote.set.delete",
      targetType: "mapset", targetId: set.id, targetName: set.name,
      summary: `deleted the map set "${set.name}"`,
    });
    sendJson(res, 200, { deleted: true });
  }),

  route("POST", "/api/mapvote/schedules", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "mapvote.config", "write")) return sendForbidden(res, "mapvote.config", "write");
    const body = await readJsonBody(req);
    const name = boundedText(body.name, TEXT_MAX.name, "schedule name");
    if (!name) return sendError(res, 400, "a schedule needs a name");
    const spec = parseScheduleSpec(body.spec, `schedule "${name}"`);
    if ("error" in spec) return sendError(res, 400, spec.error);
    try {
      const schedule = await ctx.repo.voteSchedules.create({ name, spec: spec.value as Record<string, unknown> });
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "mapvote.schedule.create",
        targetType: "voteschedule", targetId: schedule.id, targetName: schedule.name,
        summary: `created the schedule "${schedule.name}"`,
      });
      sendJson(res, 201, { schedule });
    } catch (err) {
      if (isDuplicateName(err)) return sendError(res, 409, `a schedule called "${name}" already exists`);
      throw err;
    }
  }),

  route("PUT", "/api/mapvote/schedules/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "mapvote.config", "write")) return sendForbidden(res, "mapvote.config", "write");
    const existing = await ctx.repo.voteSchedules.get(params.id!);
    if (!existing) return sendError(res, 404, "schedule not found");
    const before = voteScheduleSnapshot(existing);
    const out = await applyScheduleEdit(ctx, existing, await readJsonBody(req));
    if (!out.ok) return sendError(res, out.status, out.message);
    const schedule = out.row;
    const after = voteScheduleSnapshot(schedule);
    if (snapshotChanged(before, after)) await recordVersion(ctx.repo, p, { kind: "voteSchedule", targetId: schedule.id, targetName: schedule.name, change: "edit", before, after });
    const usedBy = await serversUsing(ctx, "schedule", schedule.name);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "mapvote.schedule.update",
      targetType: "voteschedule", targetId: schedule.id, targetName: schedule.name,
      summary: `edited the schedule "${schedule.name}"${usedBy.length ? ` (used by ${usedBy.join(", ")})` : ""}`,
      data: { renamedFrom: out.renamedFrom, usedBy },
    });
    sendJson(res, 200, { schedule });
  }),

  route("DELETE", "/api/mapvote/schedules/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "mapvote.config", "write")) return sendForbidden(res, "mapvote.config", "write");
    const schedule = await ctx.repo.voteSchedules.get(params.id!);
    if (!schedule) return sendError(res, 404, "schedule not found");
    const usedBy = await serversUsing(ctx, "schedule", schedule.name);
    if (usedBy.length) {
      return sendError(res, 409, `"${schedule.name}" is still in use on ${usedBy.join(", ")} — change it there first`);
    }
    const snap = voteScheduleSnapshot(schedule);
    await ctx.repo.voteSchedules.remove(schedule.id);
    await recordVersion(ctx.repo, p, { kind: "voteSchedule", targetId: schedule.id, targetName: schedule.name, change: "delete", before: snap, after: null });
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "mapvote.schedule.delete",
      targetType: "voteschedule", targetId: schedule.id, targetName: schedule.name,
      summary: `deleted the schedule "${schedule.name}"`,
    });
    sendJson(res, 200, { deleted: true });
  }),

  /** A set's or a schedule's saves, newest first — the panel reads each before/after as what changed. */
  route("GET", "/api/mapvote/:lib/:id/versions", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    // Reading the library's history goes with reading the vote setup.
    if (!canAnywhere(p.grants, "mapvote.config", "read")) return sendForbidden(res, "mapvote.config", "read");
    const kind = Object.hasOwn(KIND_OF, params.lib!) ? KIND_OF[params.lib!] : undefined;
    if (!kind) return sendError(res, 404, "not found");
    sendJson(res, 200, { versions: await ctx.repo.configVersions.list(kind, params.id!) });
  }),

  /** Deleted sets (or schedules) not brought back since, newest first. */
  route("GET", "/api/mapvote/:lib/deleted", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "mapvote.config", "read")) return sendForbidden(res, "mapvote.config", "read");
    const kind = Object.hasOwn(KIND_OF, params.lib!) ? KIND_OF[params.lib!] : undefined;
    if (!kind) return sendError(res, 404, "not found");
    const standing = new Set(kind === "mapSet" ? (await ctx.repo.mapSets.list()).map((s) => s.id) : (await ctx.repo.voteSchedules.list()).map((s) => s.id));
    sendJson(res, 200, { deleted: (await ctx.repo.configVersions.deletions(kind)).filter((v) => !standing.has(v.targetId)) });
  }),

  /*
   * Put a set or a schedule back as it was before a save — its name included, which carries every
   * server's pairings back with it — or bring a deleted one back under its own id, its name
   * permitting. Kept in the history itself, so a restore can be undone the same way.
   */
  route("POST", "/api/mapvote/versions/:id/restore", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "mapvote.config", "write")) return sendForbidden(res, "mapvote.config", "write");
    const v = await ctx.repo.configVersions.get(params.id!);
    if (!v || (v.kind !== "mapSet" && v.kind !== "voteSchedule")) return sendError(res, 404, "that version is no longer kept");
    if (!v.before) return sendError(res, 400, "this entry has no earlier version to put back");
    const isSet = v.kind === "mapSet";
    const noun = isSet ? "map set" : "schedule";
    const was = v.before as { name?: unknown; game?: unknown; pool?: unknown; spec?: unknown };
    const current = isSet ? await ctx.repo.mapSets.get(v.targetId) : await ctx.repo.voteSchedules.get(v.targetId);
    if (v.change === "delete") {
      if (current) return sendError(res, 409, `that ${noun} is back already`);
      const name = boundedText(was.name, TEXT_MAX.name, `${noun} name`);
      if (!name) return sendError(res, 400, `the deleted ${noun} has no name to come back under`);
      const taken = isSet ? await ctx.repo.mapSets.findByName(name) : await ctx.repo.voteSchedules.findByName(name);
      if (taken) return sendError(res, 409, `there is a ${noun} called "${name}" now — rename it first, then bring this one back`);
      try {
        let row: MapSetRow | VoteScheduleRow;
        if (isSet) {
          const game = String(was.game ?? "").trim().toLowerCase();
          if (!getGame(game)) return sendError(res, 400, `the deleted map set is for "${game}", which this install no longer knows`);
          const pool = parsePoolOverrides(was.pool ?? {}, `map set "${name}"`);
          if ("error" in pool) return sendError(res, 400, `the deleted map set doesn't pass today's checks: ${pool.error}`);
          row = await ctx.repo.mapSets.create({ id: v.targetId, name, game, pool: pool.value as Record<string, unknown> });
        } else {
          const spec = parseScheduleSpec(was.spec ?? {}, `schedule "${name}"`);
          if ("error" in spec) return sendError(res, 400, `the deleted schedule doesn't pass today's checks: ${spec.error}`);
          row = await ctx.repo.voteSchedules.create({ id: v.targetId, name, spec: spec.value as Record<string, unknown> });
        }
        const after = isSet ? mapSetSnapshot(row as MapSetRow) : voteScheduleSnapshot(row as VoteScheduleRow);
        await recordVersion(ctx.repo, p, { kind: v.kind, targetId: row.id, targetName: row.name, change: "restore", before: null, after });
        await ctx.repo.audit.create({
          actorUserId: p.user.id, actorName: p.name, action: isSet ? "mapvote.set.restore" : "mapvote.schedule.restore",
          targetType: isSet ? "mapset" : "voteschedule", targetId: row.id, targetName: row.name,
          summary: `brought back the deleted ${noun} "${row.name}" (deleted ${whenSaved(v.createdAt)}${v.actorName ? ` by ${v.actorName}` : ""})`,
          data: { versionId: v.id },
        });
        return sendJson(res, 201, isSet ? { set: row } : { schedule: row });
      } catch (err) {
        if (isDuplicateName(err)) return sendError(res, 409, `there is a ${noun} called "${name}" now — rename it first, then bring this one back`);
        throw err;
      }
    }
    if (!current) return sendError(res, 404, `that ${noun} has been deleted — bring it back from Recently deleted first`);
    const before = isSet ? mapSetSnapshot(current as MapSetRow) : voteScheduleSnapshot(current as VoteScheduleRow);
    const out = isSet
      ? await applyMapSetEdit(ctx, current as MapSetRow, { name: was.name, game: was.game, pool: was.pool })
      : await applyScheduleEdit(ctx, current as VoteScheduleRow, { name: was.name, spec: was.spec });
    if (!out.ok) return sendError(res, out.status, out.message);
    const row = out.row;
    const after = isSet ? mapSetSnapshot(row as MapSetRow) : voteScheduleSnapshot(row as VoteScheduleRow);
    await recordVersion(ctx.repo, p, { kind: v.kind, targetId: row.id, targetName: row.name, change: "restore", before, after });
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: isSet ? "mapvote.set.restore" : "mapvote.schedule.restore",
      targetType: isSet ? "mapset" : "voteschedule", targetId: row.id, targetName: row.name,
      summary: `put the ${noun} "${row.name}" back as it was before ${v.actorName ? `${v.actorName}'s` : "the"} change of ${whenSaved(v.createdAt)}`,
      data: { versionId: v.id, renamedFrom: out.renamedFrom },
    });
    sendJson(res, 200, isSet ? { set: row } : { schedule: row });
  }),
];

/**
 * Carry a rename through every server's pairings.
 *
 * Pairings store the NAME (so the stored config reads as English rather than as a wall of uuids),
 * which buys legibility at the cost of this one chore. Skipping it would break silently: the
 * pairing would stop resolving and the server would fall back to the engine's defaults with nothing
 * on screen to say why.
 */
async function renameInLinks(ctx: AppContext, kind: "set" | "schedule", from: string, to: string): Promise<void> {
  const lower = from.toLowerCase();
  for (const cfg of await ctx.repo.mapVote.listConfigs()) {
    let touched = false;
    const links = cfg.profileLinks.map((l) => {
      if (kind === "set" && l.mapSet.toLowerCase() === lower) { touched = true; return { ...l, mapSet: to }; }
      if (kind === "schedule" && (l.schedule ?? "").toLowerCase() === lower) { touched = true; return { ...l, schedule: to }; }
      return l;
    });
    if (touched) await ctx.repo.mapVote.setConfig(cfg.serverId, { profiles: links });
  }
}
