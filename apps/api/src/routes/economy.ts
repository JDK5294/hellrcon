/**
 * The community economy — staff's window onto it (docs/vip-module.md).
 *
 * Everything here is the STAFF side: settings, the member roster, ledgers, and manual balance
 * adjustments. The player side (claims, purchases, gifts) arrives over Discord interactions and
 * goes through the same repo.economy.apply path — one write path for money, whoever is asking.
 *
 * Community-wide on purpose: a balance is not a per-server fact, so the capability is checked
 * with canAnywhere, like users and templates.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEXT_MAX, boundedText, readJsonBody, readRawBodyBuffer, sendError, sendJson, str } from "../http.js";
import { canAnywhere } from "@app/access";
import { getGame } from "@app/games";
import { extractBotDb, importBotDb } from "../botdb-import.js";
import { syncAllGameRoles } from "../discord-game-roles.js";
import { communityGuild, guildMember, guildRoleIds, guildRoles } from "../discord-guild.js";
import { gateDiagnosis } from "../discord-public.js";
import { gift, purchase, staffRef } from "../shop.js";
import { vipBought, withVipBought } from "../vip-bought.js";
import { requirePrincipal, route, sendForbidden, type Route } from "./kit.js";
import { ECONOMY_ACTIVITY_KINDS } from "@app/db";
import type { EconomyClaim, EconomyConfig, EconomyOffer } from "@app/db";
import type { RoleSyncRun } from "../context.js";

/** Bounds that stop nonsense without second-guessing a real shop: a million points, a century
 *  of days, Discord's own 25-button ceiling for offers. */
const MAX_POINTS = 1_000_000;
const MAX_DAYS = 36_500;
const MAX_OFFERS = 25;
const MAX_ADJUST = 1_000_000;
// A claim gated on more than a handful of roles is a list nobody is maintaining.
const MAX_CLAIM_ROLES = 25;
// Discord renders one button per offered server, five to a row; the picker already slices at 20.
const MAX_REGISTRATION_SERVERS = 50;

const int = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

/** A list of Discord role ids, deduplicated and checked for shape. Absent (an older panel build)
 *  means "no restriction" — the same thing an empty list means, so there is no third state to
 *  reason about. Throws a message naming the field. */
function parseRoleIds(v: unknown, name: string): string[] {
  const raw = v === undefined ? [] : v;
  if (!Array.isArray(raw)) throw new Error(`${name} roleIds must be a list`);
  const roleIds = [...new Set(raw.map((r) => str(r).trim()).filter(Boolean))];
  if (roleIds.length > MAX_CLAIM_ROLES) throw new Error(`${name} can list at most ${MAX_CLAIM_ROLES} roles`);
  for (const id of roleIds) if (!/^\d{5,25}$/.test(id)) throw new Error(`${name} role "${id}" is not a Discord role id`);
  return roleIds;
}

/** Validate a claim band: whole numbers, sane range, min ≤ max, and the roles allowed to claim
 *  it. Throws a message naming the field. */
function parseClaim(v: unknown, name: string): EconomyClaim {
  const o = (v ?? {}) as Record<string, unknown>;
  const min = int(o.min), max = int(o.max);
  if (min === null || max === null || min < 0 || max < min || max > MAX_POINTS) {
    throw new Error(`${name} claim needs whole numbers with 0 ≤ min ≤ max ≤ ${MAX_POINTS}`);
  }
  return { enabled: o.enabled === true, min, max, roleIds: parseRoleIds(o.roleIds, `${name} claim`) };
}

/** game id → Discord role id, the per-game registration roles. Keys must be games this build
 *  actually knows — a typo'd game would sit in the config assigning nothing, forever.
 *  Absent means "keep what is stored" (an older panel build must not wipe it); the caller passes
 *  the stored value through for that case. */
function parseGameRoles(v: unknown): Record<string, string> {
  if (v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new Error("registration.gameRoles must be an object of game id → role id");
  const out: Record<string, string> = {};
  for (const [game, role] of Object.entries(v as Record<string, unknown>)) {
    if (!getGame(game)) throw new Error(`registration.gameRoles: "${game}" is not a known game`);
    const id = str(role).trim();
    if (!id) continue; // empty = cleared — the panel sends "" for "(no role)"
    if (!/^\d{5,25}$/.test(id)) throw new Error(`registration.gameRoles: "${id}" is not a Discord role id`);
    out[game] = id;
  }
  return out;
}

/** Validate the offers list. Ids must be unique — they end up inside Discord custom_ids and
 *  purchase idempotency keys, where a duplicate would make two buttons one purchase. */
function parseOffers(v: unknown): EconomyOffer[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error("offers must be a list");
  if (v.length > MAX_OFFERS) throw new Error(`at most ${MAX_OFFERS} offers (Discord renders one button each)`);
  const seen = new Set<string>();
  return v.map((raw, i) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const id = str(o.id).trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,40}$/.test(id)) throw new Error(`offer ${i + 1}: id must be 1-40 chars of a-z, 0-9, _ or -`);
    if (seen.has(id)) throw new Error(`offer ids must be unique ("${id}" appears twice)`);
    seen.add(id);
    const label = boundedText(o.label, TEXT_MAX.name, `offer "${id}" label`);
    if (!label) throw new Error(`offer "${id}" needs a label — it is the button text`);
    const points = int(o.points), days = int(o.days);
    if (points === null || points < 1 || points > MAX_POINTS) throw new Error(`offer "${id}": points must be 1..${MAX_POINTS}`);
    if (days === null || days < 1 || days > MAX_DAYS) throw new Error(`offer "${id}": days must be 1..${MAX_DAYS}`);
    const scope = (o.scope ?? {}) as { mode?: unknown; serverIds?: unknown };
    let parsedScope: EconomyOffer["scope"];
    if (scope.mode === "all") {
      parsedScope = { mode: "all" };
    } else if (scope.mode === "servers") {
      const ids = Array.isArray(scope.serverIds) ? scope.serverIds.map((s) => str(s)).filter(Boolean) : [];
      if (!ids.length) throw new Error(`offer "${id}": pick at least one server (or use "all")`);
      parsedScope = { mode: "servers", serverIds: ids };
    } else {
      throw new Error(`offer "${id}": scope.mode must be "all" or "servers"`);
    }
    return {
      id, label, points, days, scope: parsedScope, enabled: o.enabled !== false,
      roleIds: parseRoleIds(o.roleIds, `offer "${id}"`),
    };
  });
}

/** The servers the public registration picker offers. Empty = every server, so "none selected"
 *  reads as "no restriction" rather than "nobody may register" — the same convention the role
 *  gates use, and the one that keeps a fresh install working without being configured. */
function parseServerIds(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw new Error("registration.serverIds must be a list of server ids");
  const ids = [...new Set(v.map((s) => str(s).trim()).filter(Boolean))];
  if (ids.length > MAX_REGISTRATION_SERVERS) throw new Error(`registration.serverIds can list at most ${MAX_REGISTRATION_SERVERS} servers`);
  return ids;
}

type EconomyPatch = Partial<Omit<EconomyConfig, "updatedAt">>;

/** The economy document a save asks for, validated: throws a message naming the field. Whatever an
 *  older panel build does not send is read off `stored` rather than wiped. */
function parseConfigBody(body: Record<string, unknown>, stored: EconomyConfig): EconomyPatch {
  const cap = body.balanceCap === null || body.balanceCap === undefined ? null : int(body.balanceCap);
  if (body.balanceCap !== null && body.balanceCap !== undefined && (cap === null || cap < 0 || cap > 1_000_000_000)) {
    throw new Error("balanceCap must be null or a whole number up to 1,000,000,000");
  }
  const giftBody = body.gifting as Record<string, unknown> | undefined;
  const minGift = int(giftBody?.minAmount ?? 1);
  if (minGift === null || minGift < 1 || minGift > MAX_POINTS) throw new Error("gifting.minAmount must be at least 1");
  const rawMax = giftBody?.maxAmount;
  const maxGift = rawMax === null || rawMax === undefined || rawMax === "" ? null : int(rawMax);
  if (maxGift !== null && (maxGift < minGift || maxGift > MAX_POINTS)) {
    throw new Error(`gifting.maxAmount must be blank (no maximum) or between the minimum (${minGift}) and ${MAX_POINTS}`);
  }
  const currencyName = boundedText(body.currencyName, TEXT_MAX.name, "currency name");
  if (!currencyName) throw new Error("currency name is what every button and balance shows — it cannot be blank");
  const patch: EconomyPatch = {
    currencyName,
    balanceCap: cap,
    claims: {
      daily: parseClaim((body.claims as Record<string, unknown> | undefined)?.daily, "daily"),
      monthly: parseClaim((body.claims as Record<string, unknown> | undefined)?.monthly, "monthly"),
    },
    gifting: { enabled: giftBody?.enabled === true, minAmount: minGift, maxAmount: maxGift },
    vipGifting: {
      enabled: (body.vipGifting as Record<string, unknown> | undefined)?.enabled === true,
      roleIds: parseRoleIds((body.vipGifting as Record<string, unknown> | undefined)?.roleIds, "vipGifting"),
    },
    offers: parseOffers(body.offers),
  };
  // Optional so an older panel build keeps saving without wiping the stored values.
  const reg = body.registration as Record<string, unknown> | undefined;
  if (reg !== undefined) {
    const bonusDays = int(reg.bonusDays ?? 0);
    const bonusPoints = int(reg.bonusPoints ?? 0);
    if (bonusDays === null || bonusDays < 0 || bonusDays > MAX_DAYS) throw new Error(`registration.bonusDays must be 0..${MAX_DAYS}`);
    if (bonusPoints === null || bonusPoints < 0 || bonusPoints > MAX_POINTS) throw new Error(`registration.bonusPoints must be 0..${MAX_POINTS}`);
    // Absent ≠ cleared, for both: an older panel build that does not know a field must not
    // wipe it, so what it does not send is read back off the stored config.
    const gameRoles = reg.gameRoles === undefined ? stored.registration.gameRoles : parseGameRoles(reg.gameRoles);
    const serverIds = reg.serverIds === undefined ? (stored.registration.serverIds ?? []) : parseServerIds(reg.serverIds);
    patch.registration = {
      bonusDays, bonusPoints,
      bonusAllGames: reg.bonusAllGames === true, bonusPerGame: reg.bonusPerGame === true,
      gameRoles, serverIds,
    };
  }
  return patch;
}

export const economyRoutes: Route[] = [
  route("GET", "/api/economy/config", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    // The settings and the offers are one document, and either half's holders read it.
    if (!canAnywhere(p.grants, "economy.config", "read") && !canAnywhere(p.grants, "economy.shop", "read")) return sendForbidden(res, "economy.config", "read");
    const config = await ctx.repo.economy.config();
    // Balances ABOVE the cap are a fact staff need to see, not discover on a Discord leaderboard.
    // A credit written without the cap (the cutover import did exactly that) overshoots permanently,
    // because `apply` clamps at write time and nothing revisits a balance afterwards.
    sendJson(res, 200, { config, overCap: await ctx.repo.economy.overCap(config.balanceCap) });
  }),

  /**
   * WHAT WOULD DISCORD DRAW FOR THIS MEMBER, AND WHY.
   *
   * A role gate has no failure message by design: a claim the presser cannot make is not greyed
   * out, it is absent. That is right for members and useless for staff, because a gate pointed at
   * the wrong role, a gate on a switched-off claim, and a gate working exactly as intended all
   * produce the same empty space. The only way anyone had to tell them apart was to hand somebody
   * the role and watch — a guessing loop with a Discord round trip per guess.
   *
   * So this answers it outright: take a Discord user id, ask Discord what roles they hold in the
   * PUBLIC server right now, and run the real gate against the real stored config. Same predicate
   * the panel renders with, so it cannot drift from what a press would do.
   *
   * Read-only, and it changes nothing — economy.manage read is enough.
   */
  route("GET", "/api/economy/gate-check", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "economy.config", "read")) return sendForbidden(res, "economy.config", "read");
    const discordId = str(new URL(req.url ?? "", "http://x").searchParams.get("discordId") ?? "").trim();
    if (!/^\d{5,25}$/.test(discordId)) return sendError(res, 400, "give a Discord user id (18-ish digits — Developer Mode on, right-click the member, Copy User ID)");

    const community = await communityGuild(ctx.repo);
    const [cfg, roles, member] = await Promise.all([
      ctx.repo.economy.config(),
      guildRoles(community.guildId),
      guildMember(community.guildId, discordId),
    ]);
    const nameOf = (id: string) => roles?.find((r) => r.id === id)?.name ?? null;
    const held = member.kind === "member" ? member.roleIds : undefined;

    const gates: { key: string; label: string; enabled: boolean; roleIds: string[] }[] = [
      { key: "daily", label: "Daily claim", enabled: cfg.claims.daily.enabled, roleIds: cfg.claims.daily.roleIds ?? [] },
      { key: "monthly", label: "Monthly claim", enabled: cfg.claims.monthly.enabled, roleIds: cfg.claims.monthly.roleIds ?? [] },
      { key: "vipGifting", label: "Gift VIP", enabled: cfg.vipGifting.enabled, roleIds: cfg.vipGifting.roleIds ?? [] },
      // Every offer, gated or not: "which of my shop buttons does this member see" is the same
      // question staff open this for, and an ungated offer answering "everyone" is part of it.
      ...cfg.offers.map((o) => ({ key: `offer:${o.id}`, label: `Offer — ${o.label}`, enabled: o.enabled, roleIds: o.roleIds ?? [] })),
    ];
    const checks = gates.map((g) => {
      const verdict = gateDiagnosis({ roleIds: g.roleIds }, held);
      return {
        ...g,
        // Named where Discord knows the name, and flagged where it does not: a gate role that is
        // not one of the public server's roles is the misdirected-gate case, and it can never open.
        required: g.roleIds.map((id) => ({ id, name: nameOf(id), inGuild: roles ? roles.some((r) => r.id === id) : null })),
        verdict,
        wouldShow: g.enabled && (verdict === "ungated" || verdict === "allowed"),
      };
    });
    sendJson(res, 200, {
      guildId: community.guildId, fellBack: community.fellBack,
      member: member.kind === "member"
        ? { found: true, name: member.name, roles: member.roleIds.map((id) => ({ id, name: nameOf(id) })) }
        : { found: false, reason: member.kind === "notInGuild" ? "They are not in that Discord server." : member.reason },
      checks,
    });
  }),

  /**
   * Reconcile the per-game registration role for EVERY linked member.
   *
   * Each link-writing path reconciles the role after its write, and the cutover import did not —
   * so its members carry the link and the balance but never got the role that link earns. Nothing
   * revisits a role on its own, which made hand-relinking the only fix. Safe to re-run.
   */
  route("POST", "/api/economy/resync-game-roles", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "economy.config", "write")) return sendForbidden(res, "economy.config", "write");
    const { gameRoles } = (await ctx.repo.economy.config()).registration;
    if (!Object.values(gameRoles ?? {}).some(Boolean)) {
      return sendError(res, 400, "no registration roles are configured — set one per game first");
    }
    if (ctx.roleSync.current?.status === "running") return sendError(res, 409, "a reconcile is already running");
    const now = new Date().toISOString();
    const run: RoleSyncRun = { status: "running", startedAt: now, updatedAt: now, done: 0, total: 0 };
    ctx.roleSync.current = run;
    // Deliberately NOT awaited. Discord's role bucket paces this to a few writes per window, so a
    // few hundred members is minutes — the first version held the request open for all of it and
    // the browser gave up with "Load failed" while the run carried on unseen.
    void (async () => {
      try {
        const r = await syncAllGameRoles(ctx.repo, (done, total) => {
          run.done = done; run.total = total; run.updatedAt = new Date().toISOString();
        });
        run.result = r; run.status = "done"; run.updatedAt = new Date().toISOString();
        await ctx.repo.audit.create({
          actorUserId: p.user.id, actorName: p.name, action: "economy.roles.resync",
          targetType: "system", targetId: "game-roles",
          summary: `reconciled registration roles across ${r.members} linked member(s): ${r.applied} applied, ${r.removed} removed, ${r.absent} not in the guild, ${r.refused} refused`,
          data: { ...r },
        });
      } catch (err) {
        run.status = "error"; run.error = (err as Error).message; run.updatedAt = new Date().toISOString();
      }
    })();
    sendJson(res, 202, { started: true });
  }),

  /** Progress of the reconcile above — what the panel polls while it runs. */
  route("GET", "/api/economy/resync-game-roles/status", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    // Whoever may start the reconcile reads how it goes. This asked for the shop's permission, so
    // one started with Economy settings alone was refused its own progress while it ran.
    if (!canAnywhere(p.grants, "economy.config", "read")) return sendForbidden(res, "economy.config", "read");
    sendJson(res, 200, ctx.roleSync.current ?? { status: "idle" });
  }),

  /** Bring every over-cap balance down to the cap, as visible ledger corrections — the cap's own
   *  correction, so Economy settings', like the cap. */
  route("POST", "/api/economy/trim-balances", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "economy.config", "write")) return sendForbidden(res, "economy.config", "write");
    const { balanceCap, currencyName } = await ctx.repo.economy.config();
    if (balanceCap === null) return sendError(res, 400, "there is no balance cap to trim to — set one first");
    const r = await ctx.repo.economy.trimToCap(balanceCap, p.name);
    if (r.members > 0) {
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "economy.trim",
        targetType: "system", targetId: "balances",
        summary: `trimmed ${r.members} balance(s) to the ${balanceCap.toLocaleString()} ${currencyName} cap, removing ${r.removed.toLocaleString()} in total`,
        data: { cap: balanceCap, ...r },
      });
    }
    sendJson(res, 200, r);
  }),

  route("PUT", "/api/economy/config", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "economy.config", "read") && !canAnywhere(p.grants, "economy.shop", "read")) return sendForbidden(res, "economy.config", "write");
    const body = (await readJsonBody(req)) as Record<string, unknown>;

    const current = await ctx.repo.economy.config();
    let patch: EconomyPatch;
    try {
      patch = parseConfigBody(body, current);
    } catch (err) {
      return sendError(res, 400, (err as Error).message);
    }

    /*
     * The half a save changes decides what it needs: the settings (currency, cap, claims, gifting,
     * registration) are Economy settings', the offers are VIP shop offers'. The panel sends the
     * whole document from either Save, so the halves are told apart against what is stored, read
     * the same way the save is. A stored document today's rules refuse cannot be read that way, and
     * then a save needs both. One permission used to stand for both, and it was the shop's: Economy
     * settings alone could change nothing on its own screen, and VIP shop offers could change the
     * rates and the cap.
     */
    const asStored = (() => { try { return parseConfigBody(current as unknown as Record<string, unknown>, current); } catch { return null; } })();
    const differs = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
    const offersChanged = !asStored || differs(patch.offers, asStored.offers);
    const settingsChanged = !asStored || (Object.keys(patch) as (keyof EconomyPatch)[]).some((k) => k !== "offers" && differs(patch[k], asStored[k]));
    const maySettings = canAnywhere(p.grants, "economy.config", "write");
    const mayOffers = canAnywhere(p.grants, "economy.shop", "write");
    if (settingsChanged && !maySettings) return sendForbidden(res, "economy.config", "write");
    if (offersChanged && !mayOffers) return sendForbidden(res, "economy.shop", "write");
    if (!settingsChanged && !offersChanged && !maySettings && !mayOffers) return sendForbidden(res, "economy.config", "write");

    // A role id is only meaningful in the server it came from, and everything gated here is read in
    // the PUBLIC server — so a gate naming a role that does not exist there can never open. Nothing
    // downstream can notice: hiding a claim the presser cannot make is the designed behaviour, so a
    // gate pointed at the wrong server looks exactly like a gate working. The one moment it can be
    // caught is now, against the roles that server actually has.
    //
    // Refused only when Discord positively says the role is not there. No bot token, an outage, the
    // bot not in that server — all leave the check unable to disprove anything, and an unprovable
    // suspicion must never stand between staff and saving their settings.
    const gates = [
      ...patch.claims!.daily.roleIds.map((id) => ({ id, where: "the daily claim" })),
      ...patch.claims!.monthly.roleIds.map((id) => ({ id, where: "the monthly claim" })),
      ...patch.vipGifting!.roleIds.map((id) => ({ id, where: "VIP gifting" })),
      ...(patch.offers ?? []).flatMap((o) => (o.roleIds ?? []).map((id) => ({ id, where: `the "${o.label}" offer` }))),
      ...Object.entries(patch.registration?.gameRoles ?? {}).filter(([, id]) => id).map(([game, id]) => ({ id, where: `the ${game} registration role` })),
    ];
    if (gates.length) {
      const community = await communityGuild(ctx.repo);
      const known = await guildRoleIds(community.guildId);
      const strays = known ? gates.filter((g) => !known.has(g.id)) : [];
      if (strays.length) {
        const which = strays.map((g) => `${g.id} (${g.where})`).join(", ");
        return sendError(res, 400, community.fellBack
          ? `${which} — no such role in your staff Discord server, and that is the only server configured. ` +
            "If your VIP panel runs in a separate public server, set its id under Administration → Discord first: " +
            "role ids from one server never match another, so a gate set from the wrong list is invisible to everyone."
          : `${which} — no such role in your public Discord server (${community.guildId}). ` +
            "A gate can only name a role from the server the panel runs in.");
      }
    }

    const config = await ctx.repo.economy.setConfig(patch);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "economy.manage",
      targetType: "system", targetId: "economy", summary: `updated the economy settings (${config.offers.length} offer(s))`,
    });
    sendJson(res, 200, { config });
  }),

  route("GET", "/api/economy/members", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "economy.balances", "read")) return sendForbidden(res, "economy.balances", "read");
    const u = new URL(req.url ?? "", "http://x").searchParams;
    const q = u.get("q")?.trim() || undefined;
    const limit = Math.min(Math.max(Number(u.get("limit")) || 50, 1), 200);
    const offset = Math.max(Number(u.get("offset")) || 0, 0);
    const [members, total] = await Promise.all([
      ctx.repo.economy.members({ q, limit, offset }),
      ctx.repo.economy.membersCount(q),
    ]);
    sendJson(res, 200, { members, total });
  }),

  /**
   * The cross-member activity feed — Economy → Activity. Every ledger movement in one list,
   * newest first, classified by the ref its writer stamped (see ECONOMY_ACTIVITY_KINDS). Gated on
   * the same read that shows balances and per-member ledgers: this is those ledgers, interleaved,
   * so it must not be visible to anyone the member screens are hidden from.
   */
  route("GET", "/api/economy/activity", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "economy.balances", "read")) return sendForbidden(res, "economy.balances", "read");
    const u = new URL(req.url ?? "", "http://x").searchParams;
    const kindRaw = (u.get("kind") ?? "").trim();
    // Validated HERE as well as in the store: the store answers an unknown kind with an empty
    // feed, but the panel deserves "no such kind" rather than a list that looks emptied.
    if (kindRaw && !Object.hasOwn(ECONOMY_ACTIVITY_KINDS, kindRaw)) {
      return sendError(res, 400, `unknown kind "${kindRaw}" — one of: ${Object.keys(ECONOMY_ACTIVITY_KINDS).join(", ")}`);
    }
    const limit = Math.min(Math.max(Number(u.get("limit")) || 50, 1), 200);
    const offset = Math.max(Number(u.get("offset")) || 0, 0);
    const { entries, total } = await ctx.repo.economy.activity({ ...(kindRaw ? { kind: kindRaw } : {}), limit, offset });
    const bought = await vipBought(ctx.repo, entries);
    sendJson(res, 200, {
      entries: withVipBought(entries, bought), total,
      // The vocabulary rides along so the panel's filter chips can never drift from the store's.
      kinds: Object.entries(ECONOMY_ACTIVITY_KINDS).map(([id, k]) => ({ id, label: k.label })),
    });
  }),

  route("GET", "/api/economy/members/:discordId", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "economy.balances", "read")) return sendForbidden(res, "economy.balances", "read");
    const member = await ctx.repo.economy.member(params.discordId!);
    if (!member) return sendError(res, 404, "no such member");
    const u = new URL(req.url ?? "", "http://x").searchParams;
    const limit = Math.min(Math.max(Number(u.get("limit")) || 50, 1), 200);
    const offset = Math.max(Number(u.get("offset")) || 0, 0);
    // `players` is the member's linked game accounts (plural — one per game once a second game
    // exists). It is what "linked" means everywhere in the economy: claims, purchases and gifts
    // all refuse an unlinked member, and this is where staff see which side of that line
    // somebody is on.
    const [ledger, total, players] = await Promise.all([
      ctx.repo.economy.ledger(member.discordId, { limit, offset }),
      ctx.repo.economy.ledgerCount(member.discordId),
      ctx.repo.externalLinks.findPlayers("discord", member.discordId),
    ]);
    const bought = await vipBought(ctx.repo, ledger);
    sendJson(res, 200, {
      member, ledger: withVipBought(ledger, bought), total,
      // `game` rides along because with two games a member holds two accounts, and which game an
      // account belongs to is the thing staff are actually reading this list to find out — the
      // platform ("steam", "epic") answers a different question and can be the same for both.
      players: players.map((pl) => ({ id: pl.id, name: pl.name, game: pl.game, platform: pl.platform, platformId: pl.platformId, lastSeen: pl.lastSeen })),
    });
  }),

  /**
   * A manual correction, with the reason on the row forever. Creates the member when they are
   * new — "give the tournament winner 500" must not require them to have pressed a button first.
   */
  route("POST", "/api/economy/members/:discordId/adjust", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "economy.balances", "write")) return sendForbidden(res, "economy.balances", "write");
    const body = (await readJsonBody(req)) as { delta?: unknown; reason?: unknown; discordName?: unknown };
    const delta = int(body.delta);
    if (delta === null || delta === 0 || Math.abs(delta) > MAX_ADJUST) {
      return sendError(res, 400, `delta must be a whole non-zero number within ±${MAX_ADJUST}`);
    }
    const reason = boundedText(body.reason, TEXT_MAX.reason, "reason");
    if (!reason) return sendError(res, 400, "a reason is required — it is the ledger row other staff read");
    const discordId = params.discordId!;
    if (!/^\d{5,25}$/.test(discordId)) return sendError(res, 400, "discordId must be a numeric Discord user id");

    const cfg = await ctx.repo.economy.config();
    let applied;
    try {
      applied = await ctx.repo.economy.apply(
        { discordId, delta, reason, actorName: p.name, discordName: str(body.discordName) || null },
        { maxBalance: cfg.balanceCap },
      );
    } catch (err) {
      return sendError(res, 400, (err as Error).message);
    }
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "economy.adjust",
      targetType: "member", targetId: discordId, targetName: applied.member.discordName,
      summary: `adjusted a member's ${cfg.currencyName} by ${applied.entry.delta >= 0 ? "+" : ""}${applied.entry.delta}: ${reason}`,
      data: { requested: delta, applied: applied.entry.delta, balance: applied.member.balance },
    });
    sendJson(res, 200, { member: applied.member, entry: applied.entry });
  }),

  /*
   * Grant (or dock) a whole PLAYER GROUP's balances in one action — "pay the event winners",
   * "credit the staff group". Group members are GAME accounts while balances live on Discord
   * accounts, so each member resolves through their link: no link means that member is skipped
   * with the reason on the receipt, never silently. Two game accounts on one Discord are one
   * PERSON — paid once, not once per account. Each credit goes through the same
   * repo.economy.apply as every other money write (cap, ledger row, name refresh).
   */
  route("POST", "/api/economy/groups/:groupId/adjust", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "economy.balances", "write")) return sendForbidden(res, "economy.balances", "write");
    const body = (await readJsonBody(req)) as { delta?: unknown; reason?: unknown };
    const delta = int(body.delta);
    if (delta === null || delta === 0 || Math.abs(delta) > MAX_ADJUST) {
      return sendError(res, 400, `delta must be a whole non-zero number within ±${MAX_ADJUST}`);
    }
    const reason = boundedText(body.reason, TEXT_MAX.reason, "reason");
    if (!reason) return sendError(res, 400, "a reason is required — it is the ledger row other staff read");
    const group = await ctx.repo.playerGroups.get(params.groupId!);
    if (!group) return sendError(res, 404, "group not found");
    const members = await ctx.repo.playerGroups.members(group.id);
    if (!members.length) return sendError(res, 400, `"${group.name}" has no members`);
    if (members.length > 500) return sendError(res, 400, "the group is too large for one grant (max 500 members)");

    const cfg = await ctx.repo.economy.config();
    const rows = await ctx.repo.players.findByPlatformIds(members.map((m) => m.playerId)).catch(() => []);
    const rowByPlatform = new Map(rows.map((r) => [r.platformId, r]));
    const paidDiscord = new Set<string>();
    const applied: { playerId: string; playerName: string | null; discordId: string; applied: number; balance: number }[] = [];
    const skipped: { playerId: string; playerName: string | null; reason: string }[] = [];
    for (const m of members) {
      const row = rowByPlatform.get(m.playerId);
      let link: string | null = null;
      let linkFailed = false;
      if (row) {
        try { link = (await ctx.repo.externalLinks.list(row.id)).find((l) => l.provider === "discord")?.externalId ?? null; }
        catch { linkFailed = true; }
      }
      if (!link) {
        skipped.push({ playerId: m.playerId, playerName: m.playerName, reason: linkFailed ? "their Discord link could not be read" : row ? "no Discord link — balances live on Discord accounts" : "not a known player here" });
        continue;
      }
      if (paidDiscord.has(link)) {
        skipped.push({ playerId: m.playerId, playerName: m.playerName, reason: "same Discord account as another member — one person, one grant" });
        continue;
      }
      paidDiscord.add(link);
      try {
        const a = await ctx.repo.economy.apply(
          { discordId: link, delta, reason: `${reason} (group: ${group.name})`, actorName: p.name, discordName: null },
          { maxBalance: cfg.balanceCap },
        );
        applied.push({ playerId: m.playerId, playerName: m.playerName, discordId: link, applied: a.entry.delta, balance: a.member.balance });
      } catch (err) {
        skipped.push({ playerId: m.playerId, playerName: m.playerName, reason: (err as Error).message });
      }
    }
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "economy.groupAdjust",
      targetType: "config", targetId: group.id, targetName: group.name,
      summary: `adjusted ${applied.length} member(s) of "${group.name}" by ${delta >= 0 ? "+" : ""}${delta} ${cfg.currencyName}: ${reason}`
        + (skipped.length ? ` — ${skipped.length} skipped` : ""),
      data: { groupId: group.id, requested: delta, appliedCount: applied.length, skipped: skipped.map((x) => ({ playerId: x.playerId, reason: x.reason })) },
    });
    sendJson(res, 200, { group: { id: group.id, name: group.name }, currency: cfg.currencyName, applied, skipped });
  }),

  /**
   * Run a purchase on a member's behalf — the same service the Discord buttons will call, with a
   * staff actor instead. It exists so the whole pipeline (linking → debit → grant → refund) is
   * exercisable from the panel before any bot is deployed, and stays as the repair path after
   * ("their click failed, run it for them").
   *
   * An offer's role gate applies here too, checked by the service against the RECIPIENT's real
   * Discord roles: repairing a member's failed press has to run the same gate that press would
   * have, or the repair path quietly becomes the way around it. Staff who mean to put VIP on
   * somebody outside the shop's rules have the direct VIP grant for exactly that.
   */
  route("POST", "/api/economy/members/:discordId/purchase", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "economy.balances", "write")) return sendForbidden(res, "economy.balances", "write");
    const body = await readJsonBody(req);
    const buyerDiscordId = params.discordId!;
    if (!/^\d{5,25}$/.test(buyerDiscordId)) return sendError(res, 400, "discordId must be a numeric Discord user id");
    const forDiscordId = str(body.forDiscordId).trim() || null;
    if (forDiscordId && !/^\d{5,25}$/.test(forDiscordId)) return sendError(res, 400, "forDiscordId must be a numeric Discord user id");
    let outcome;
    try {
      // No roles passed: a staff run knows the recipient's Discord id and nothing about their
      // roles, so purchase() asks Discord itself. The repair path therefore runs exactly the gate
      // the member's own press would have, instead of quietly becoming the way around it.
      outcome = await purchase(ctx.repo, {
        buyerDiscordId, offerId: str(body.offerId).trim(), forDiscordId,
        ref: staffRef("buy"), actorName: p.name,
      });
    } catch (err) {
      return sendError(res, 400, (err as Error).message);
    }
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "economy.purchase",
      targetType: "member", targetId: buyerDiscordId,
      summary: `ran a VIP shop purchase (${outcome.offer.label}) for a member${forDiscordId ? " as a gift" : ""} — ${outcome.status}`,
      data: { offerId: outcome.offer.id, points: outcome.offer.points, days: outcome.offer.days, forDiscordId, status: outcome.status, applied: outcome.applied.length, skipped: outcome.skipped.length },
    });
    sendJson(res, 200, outcome);
  }),

  /** A points gift between two members, run by staff — same service, same rules as the button. */
  route("POST", "/api/economy/members/:discordId/gift", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "economy.balances", "write")) return sendForbidden(res, "economy.balances", "write");
    const body = await readJsonBody(req);
    const fromDiscordId = params.discordId!;
    const toDiscordId = str(body.toDiscordId).trim();
    if (!/^\d{5,25}$/.test(fromDiscordId) || !/^\d{5,25}$/.test(toDiscordId)) {
      return sendError(res, 400, "both discord ids must be numeric Discord user ids");
    }
    let outcome;
    try {
      outcome = await gift(ctx.repo, {
        fromDiscordId, toDiscordId, amount: Number(body.amount),
        ref: staffRef("gift"), actorName: p.name,
      });
    } catch (err) {
      return sendError(res, 400, (err as Error).message);
    }
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "economy.gift",
      targetType: "member", targetId: fromDiscordId,
      summary: `moved a gift of ${Number(body.amount)} between members — ${outcome.status}`,
      data: { toDiscordId, amount: Number(body.amount), status: outcome.status },
    });
    sendJson(res, 200, outcome);
  }),

  /**
   * The cutover terminal (docs/vip-module.md's last section, decision 4): upload the old bot's SQLite file,
   * import the links / opening balances / registration markers. Converging — a re-run reports
   * "already" instead of paying twice — so a nervous cutover can run it as many times as it takes.
   */
  route("POST", "/api/economy/import-botdb", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "economy.config", "write")) return sendForbidden(res, "economy.config", "write");
    let bytes;
    try {
      bytes = await readRawBodyBuffer(req, 200 * 1024 * 1024);
    } catch (err) {
      return sendError(res, 400, (err as Error).message);
    }
    // A SQLite file declares itself in its first 16 bytes — refuse anything else before a child
    // process ever sees it.
    if (!bytes.subarray(0, 15).equals(Buffer.from("SQLite format 3"))) {
      return sendError(res, 400, "that is not a SQLite database file (expected the v4 bot.db)");
    }
    const dir = await mkdtemp(join(tmpdir(), "botdb-"));
    try {
      const file = join(dir, "bot.db");
      await writeFile(file, bytes);
      const users = await extractBotDb(file);
      const report = await importBotDb(ctx.repo, users, p.name);
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "economy.import",
        targetType: "system", targetId: "botdb",
        summary: `imported the v4 bot.db: ${report.links.imported} link(s), ${report.balances.imported} opening balance(s), ${report.links.conflicts.length} conflict(s)`,
        data: { ...report, links: { ...report.links, conflicts: report.links.conflicts.slice(0, 50) } },
      });
      sendJson(res, 200, report);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      return sendError(res, status === 400 ? 400 : 500, (err as Error).message);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }),
];
