/**
 * The zone-set library: named 10×10 sector paints, per game, one paint per map family — what the
 * "player outside the allowed area" enforcer rules read, drawn with the same picker as the seeding
 * areas. A library rather than per-rule storage for the map-set reason: painting a game's maps is
 * real work, done once and referenced from any number of rules.
 *
 * Gated on its own capability (moderation.zones), carved off the rules engine's (admin.moderation):
 * drawing a game's maps is real work a mapper can be trusted with without also writing the rules
 * that kick people for crossing a line. The rules permission still READS the library — its editor
 * picks a set for each zone rule. Community-wide, so the checks are canAnywhere — a library record
 * belongs to no server.
 */
import { TEXT_MAX, boundedText, readJsonBody, sendError, sendJson } from "../http.js";
import { canAnywhere } from "@app/access";
import { getGame, listGames } from "@app/games";
import { containMapCatalog } from "@app/maps";
import { OUT_OF_ZONE_KIND } from "@app/rules";
import { parseZonePaint, requirePrincipal, route, sendForbidden, type Route } from "./kit.js";
import type { AppContext } from "../context.js";

function isDuplicateName(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "23505" || /duplicate key|already exists/i.test(e?.message ?? "");
}

/** The rules that reference this set, by name — deleting a set out from under a rule would not
 *  fail loudly, the rule would just stop enforcing with nothing on screen to say why. An armed
 *  player trigger on leaving the allowed area names its set the same way, and goes just as quiet. */
async function rulesUsing(ctx: AppContext, setId: string): Promise<string[]> {
  const [rules, triggers] = await Promise.all([ctx.repo.enforcerRules.list(), ctx.repo.playerTriggers.listArmed()]);
  return [
    ...rules
      .filter((r) => r.eventKind === OUT_OF_ZONE_KIND && String((r.params ?? {}).zoneSet ?? "") === setId)
      .map((r) => r.name),
    ...triggers
      .filter((t) => t.event === "outofzone" && String((t.params ?? {}).zoneSet ?? "") === setId)
      .map((t) => `player trigger on ${t.playerName || "a player"}`),
  ];
}

export const zoneRoutes: Route[] = [
  // The library, one game at a time (the editor's view) or whole (the rule pickers'). `maps` is
  // the paintable catalogue for the asked game — the same list the seeding painter offers.
  route("GET", "/api/zones", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "moderation.zones", "read") && !canAnywhere(p.grants, "admin.moderation", "read")) return sendForbidden(res, "moderation.zones", "read");
    const game = String(new URL(req.url ?? "", "http://x").searchParams.get("game") ?? "").trim().toLowerCase();
    const sets = await ctx.repo.mapZones.list(game || undefined);
    const withUsage = await Promise.all(sets.map(async (s) => ({ ...s, usedBy: await rulesUsing(ctx, s.id) })));
    sendJson(res, 200, { sets: withUsage, maps: game ? containMapCatalog(game) : [] });
  }),

  route("POST", "/api/zones", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "moderation.zones", "write")) return sendForbidden(res, "moderation.zones", "write");
    const body = await readJsonBody(req);
    const name = boundedText(body.name, TEXT_MAX.name, "zone set name");
    if (!name) return sendError(res, 400, "a zone set needs a name");
    // Named, never defaulted — a paint is drawn over one game's maps, and guessing which would be
    // the same silent mislabelling the map-set library refuses.
    const game = String(body.game ?? "").trim().toLowerCase();
    if (!game) return sendError(res, 400, "a zone set has to say which game its maps belong to");
    if (!getGame(game)) {
      return sendError(res, 400, `unknown game "${game}" — known games are ${listGames().map((g) => g.id).join(", ")}`);
    }
    const zones = body.zones === undefined ? { value: {} } : parseZonePaint(body.zones, "zones");
    if ("error" in zones) return sendError(res, 400, zones.error);
    try {
      const set = await ctx.repo.mapZones.create({ name, game, zones: zones.value });
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "zones.set.create",
        targetType: "zoneset", targetId: set.id, targetName: set.name,
        summary: `created the ${set.game} zone set "${set.name}"`,
        data: { game: set.game },
      });
      sendJson(res, 201, { set });
    } catch (err) {
      if (isDuplicateName(err)) return sendError(res, 409, `a zone set called "${name}" already exists`);
      throw err;
    }
  }),

  route("PUT", "/api/zones/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "moderation.zones", "write")) return sendForbidden(res, "moderation.zones", "write");
    const existing = await ctx.repo.mapZones.get(params.id!);
    if (!existing) return sendError(res, 404, "zone set not found");
    const body = await readJsonBody(req);
    const patch: { name?: string; zones?: typeof existing.zones } = {};
    if (body.name !== undefined) {
      const name = boundedText(body.name, TEXT_MAX.name, "zone set name");
      if (!name) return sendError(res, 400, "a zone set needs a name");
      patch.name = name;
    }
    if (body.zones !== undefined) {
      const zones = parseZonePaint(body.zones, "zones");
      if ("error" in zones) return sendError(res, 400, zones.error);
      patch.zones = zones.value;
    }
    try {
      const set = await ctx.repo.mapZones.update(params.id!, patch);
      if (!set) return sendError(res, 404, "zone set not found");
      const usedBy = await rulesUsing(ctx, set.id);
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "zones.set.update",
        targetType: "zoneset", targetId: set.id, targetName: set.name,
        summary: `edited the zone set "${set.name}"${usedBy.length ? ` (enforced by ${usedBy.join(", ")})` : ""}`,
        data: { usedBy },
      });
      sendJson(res, 200, { set });
    } catch (err) {
      if (isDuplicateName(err)) return sendError(res, 409, `a zone set called "${patch.name}" already exists`);
      throw err;
    }
  }),

  route("DELETE", "/api/zones/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "moderation.zones", "write")) return sendForbidden(res, "moderation.zones", "write");
    const set = await ctx.repo.mapZones.get(params.id!);
    if (!set) return sendError(res, 404, "zone set not found");
    const usedBy = await rulesUsing(ctx, set.id);
    if (usedBy.length) {
      return sendError(res, 409, `"${set.name}" is still enforced by the rule(s) ${usedBy.join(", ")} — change or delete them first`);
    }
    await ctx.repo.mapZones.remove(set.id);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "zones.set.delete",
      targetType: "zoneset", targetId: set.id, targetName: set.name,
      summary: `deleted the zone set "${set.name}"`,
    });
    sendJson(res, 200, { deleted: true });
  }),
];
