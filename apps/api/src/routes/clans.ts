/**
 * Clan tags (Players → Clans): every tag the roster has shown, grouped so each clan is one row
 * however its members spell it, and the players behind any group — or several groups together.
 *
 * The grouping is clan-tags.ts's: an automatic fold of each spelling, plus whatever staff combined,
 * split or named. Reading is anyone who can see the player directory (the tags are on every
 * profile already). Changing the grouping is the player-tags write: it is curating the same
 * labels, and it decides what a clan tag rule acts on.
 */
import { canAnywhere } from "@app/access";
import {
  CLAN_LABEL_MAX, CLAN_MERGES_MAX, clanCombineTarget, clanFoldKey, clanGroupCustomised, clanGroupName, clanGroupOf, clanLabel, clanResolveKey,
  combineClanGroups, groupClanSpellings, renameClanGroup, resetClanGroup, splitClanSpelling,
  type ClanSpellingRow, type ClanTagSettings, type Repository,
} from "@app/db";
import { readJsonBody, sendError, sendJson, str } from "../http.js";
import { pageLimit, pageOffset, requirePrincipal, route, sendForbidden, serverScope, type Route } from "./kit.js";

/** One clan as the tab lists it. */
export interface ClanGroupView {
  key: string;
  label: string;
  /** staff combined, split or named it — what Reset undoes. */
  customised: boolean;
  now: number;
  ever: number;
  lastSeen: string | null;
  spellings: ClanSpellingRow[];
}

/** Every spelling of each of these main keys — read as today's grouping, so a key saved before a
 *  combine still finds its players. */
export async function spellingsForKeys(repo: Repository, settings: ClanTagSettings, keys: string[]): Promise<string[]> {
  const groups = groupClanSpellings(settings, await repo.clanTags.tags());
  const out = new Set<string>();
  for (const key of keys) for (const t of groups.get(clanResolveKey(settings, key)) ?? []) out.add(t);
  return [...out];
}

/**
 * The spellings a typed clan filter means: whatever group the text would fall into as a tag
 * ("abc", "[ABC]" and "ᴀʙᴄ" all find ABC), a main key as a link carries it, or a group's name.
 */
export async function spellingsForText(repo: Repository, settings: ClanTagSettings, text: string): Promise<string[]> {
  const t = text.trim();
  if (!t) return [];
  const groups = groupClanSpellings(settings, await repo.clanTags.tags());
  const keys = new Set([clanGroupOf(settings, t), clanResolveKey(settings, t)]);
  const lower = t.toLowerCase();
  for (const [key, name] of Object.entries(settings.labels)) if (name.toLowerCase() === lower) keys.add(key);
  const out = new Set<string>();
  for (const key of keys) for (const s of groups.get(key) ?? []) out.add(s);
  return [...out];
}

/** Does this group match a search? By name, by any spelling as typed, or by its letters — so
 *  "ab" finds `ᴀʙᴄ` as well as `[ABC]`. */
function matches(g: ClanGroupView, q: string): boolean {
  const lower = q.toLowerCase();
  const fold = clanFoldKey(q);
  const letters = fold.startsWith("~") ? "" : fold;
  return g.label.toLowerCase().includes(lower)
    || g.spellings.some((s) => s.tag.toLowerCase().includes(lower) || (letters !== "" && clanFoldKey(s.tag).includes(letters)));
}

/** What a clan write answers: the group it left in place, or why it refused. */
type ClanWrite = { error: string } | { key: string };

/** Clan writes run one at a time: each reads the grouping, changes it and writes it back. */
let writes: Promise<unknown> = Promise.resolve();
function oneAtATime(fn: () => Promise<ClanWrite>): Promise<ClanWrite> {
  const run = writes.then(fn, fn);
  writes = run.catch(() => {});
  return run;
}

/** A group named for the audit trail: its name, else a few of its spellings. */
function describe(settings: ClanTagSettings, groups: Map<string, string[]>, key: string): string {
  const named = clanGroupName(settings, key);
  if (named) return named;
  const tags = groups.get(key) ?? [];
  if (!tags.length) return key.startsWith("s:") ? key.slice(2) : key;
  return tags.length > 3 ? `${tags.slice(0, 3).join(", ")} (+${tags.length - 3})` : tags.join(", ");
}

const readKeys = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => str(x).trim()).filter(Boolean) : []);

export const clanRoutes: Route[] = [
  route("GET", "/api/clans", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "server.view", "read")) return sendForbidden(res, "server.view", "read");
    // A viewer limited to some servers counts and lists those servers' players only — the same
    // boundary the directory keeps (undefined = sees every server, no filter).
    const scope = await serverScope(req, res, ctx, p, "server.view");
    if (!scope) return;
    const u = new URL(req.url ?? "", "http://x").searchParams;
    const game = u.get("game")?.trim() || undefined;
    const serverIds = scope.serverIds;
    const q = u.get("q")?.trim() ?? "";
    const focus = u.get("focus")?.trim() ?? "";
    const limit = pageLimit(u, 100, 500);
    const offset = pageOffset(u);
    const settings = (await ctx.repo.appConfig.get()).clanTags;
    const spellings = await ctx.repo.clanTags.spellings({ game, serverIds });
    const byTag = new Map(spellings.map((s) => [s.tag, s]));
    const groups = groupClanSpellings(settings, spellings.map((s) => s.tag));
    const stats = new Map((await ctx.repo.clanTags.groupStats([...groups].map(([key, tags]) => ({ key, tags })), { game, serverIds })).map((s) => [s.key, s]));
    let list: ClanGroupView[] = [...groups].map(([key, tags]) => {
      const rows = tags.map((t) => byTag.get(t)!).sort((a, b) => b.ever - a.ever || b.lastSeen.localeCompare(a.lastSeen));
      const st = stats.get(key);
      return {
        key, label: clanLabel(settings, key, rows), customised: clanGroupCustomised(settings, key),
        now: st?.now ?? 0, ever: st?.ever ?? 0, lastSeen: st?.lastSeen ?? null, spellings: rows,
      };
    });
    if (q) list = list.filter((g) => matches(g, q));
    list.sort((a, b) => b.now - a.now || b.ever - a.ever || a.label.localeCompare(b.label));
    // A profile's tag chip opens the tab on its group: that group leads the first page, wherever
    // the counts would have put it.
    const focusKey = focus ? clanGroupOf(settings, focus) : null;
    if (focusKey && offset === 0) {
      const i = list.findIndex((g) => g.key === focusKey);
      if (i > 0) list.unshift(...list.splice(i, 1));
    }
    sendJson(res, 200, {
      clans: list.slice(offset, offset + limit), total: list.length, offset, limit,
      focus: focusKey && list.some((g) => g.key === focusKey) ? focusKey : null,
      canEdit: canAnywhere(p.grants, "player.tags", "write"),
    });
  }),

  // The players behind one or more groups. `key` repeats (?key=a&key=b): a split spelling's key
  // carries the spelling itself, commas and all.
  route("GET", "/api/clans/members", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "server.view", "read")) return sendForbidden(res, "server.view", "read");
    const scope = await serverScope(req, res, ctx, p, "server.view");
    if (!scope) return;
    const u = new URL(req.url ?? "", "http://x").searchParams;
    const keys = u.getAll("key").map((k) => k.trim()).filter(Boolean);
    if (!keys.length) return sendError(res, 400, "pick at least one clan tag");
    if (keys.length > 50) return sendError(res, 400, "at most 50 clan tags at once");
    const statusParam = u.get("status") ?? "any";
    const status = statusParam === "now" || statusParam === "former" ? statusParam : "any";
    const days = Number(u.get("seenDays") ?? 0);
    const seenFrom = Number.isFinite(days) && days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : undefined;
    const settings = (await ctx.repo.appConfig.get()).clanTags;
    const tags = await spellingsForKeys(ctx.repo, settings, keys);
    const { rows, total } = await ctx.repo.clanTags.members({
      tags, status, seenFrom, game: u.get("game")?.trim() || undefined, serverIds: scope.serverIds,
      limit: pageLimit(u, 100, 500), offset: pageOffset(u),
    });
    sendJson(res, 200, {
      total,
      members: rows.map((r) => ({
        playerId: r.player.id, name: r.player.name, game: r.player.game, platform: r.player.platform,
        platformId: r.player.platformId, lastSeen: r.player.lastSeen,
        tag: r.tag, firstSeen: r.firstSeen, tagLastSeen: r.lastSeen, wearingNow: r.wearingNow, currentTag: r.currentTag,
      })),
    });
  }),

  // Make several groups one. An automatic group among them stays (see clanCombineTarget); `label`
  // (optional) names the result.
  route("POST", "/api/clans/combine", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "player.tags", "write")) return sendForbidden(res, "player.tags", "write");
    const body = await readJsonBody(req);
    const asked = readKeys(body.keys);
    const label = str(body.label).trim();
    if (asked.length > 50) return sendError(res, 400, "at most 50 clan tags at once");
    if (label.length > CLAN_LABEL_MAX) return sendError(res, 400, `a clan name is at most ${CLAN_LABEL_MAX} characters`);
    const out = await oneAtATime(async () => {
      const settings = (await ctx.repo.appConfig.get()).clanTags;
      // Read as today's grouping: a key somebody else combined a moment ago is its group now.
      const keys = [...new Set(asked.map((k) => clanResolveKey(settings, k)))];
      if (keys.length < 2) return { error: "pick at least two different clan tags to combine" };
      // Only clans somebody has worn: a made-up key would sit in the settings forever, unseen.
      const groups = groupClanSpellings(settings, await ctx.repo.clanTags.tags());
      if (keys.some((k) => !groups.has(k))) return { error: "one of those clan tags has not been seen on any player" };
      const next = combineClanGroups(settings, keys, label);
      if (Object.keys(next.merges).length > CLAN_MERGES_MAX) return { error: "too many combined clan tags — reset some groups first" };
      const named = keys.map((k) => describe(settings, groups, k));
      await ctx.repo.appConfig.set({ clanTags: next });
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "clans.combine", targetType: "system", targetId: "clans",
        summary: `combined clan tags ${named.join(" + ")}${label ? ` as “${label}”` : ""}`,
        data: { keys, label: label || null },
      });
      return { key: clanCombineTarget(keys)! };
    });
    if ("error" in out) return sendError(res, 400, out.error);
    sendJson(res, 200, out);
  }),

  // Take one spelling out of its group: it becomes a clan of its own.
  route("POST", "/api/clans/split", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "player.tags", "write")) return sendForbidden(res, "player.tags", "write");
    const body = await readJsonBody(req);
    const tag = str(body.tag).trim();
    if (!tag) return sendError(res, 400, "name the spelling to split out");
    const out = await oneAtATime(async () => {
      const settings = (await ctx.repo.appConfig.get()).clanTags;
      const groups = groupClanSpellings(settings, await ctx.repo.clanTags.tags());
      const from = clanGroupOf(settings, tag);
      if (!(groups.get(from) ?? []).includes(tag)) return { error: "that spelling has not been seen on any player" };
      if ((groups.get(from) ?? []).length < 2) return { error: "that spelling is already a clan of its own" };
      const next = splitClanSpelling(settings, tag);
      if (Object.keys(next.merges).length > CLAN_MERGES_MAX) return { error: "too many combined clan tags — reset some groups first" };
      await ctx.repo.appConfig.set({ clanTags: next });
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "clans.split", targetType: "system", targetId: "clans",
        summary: `split the clan tag spelling ${tag} out of ${describe(settings, groups, from)}`,
        data: { tag, from },
      });
      return { key: clanGroupOf(next, tag) };
    });
    if ("error" in out) return sendError(res, 400, out.error);
    sendJson(res, 200, out);
  }),

  // Undo the choices that made a group: what was combined into it goes back to its own group, a
  // split spelling rejoins its automatic one, and the name is dropped.
  route("POST", "/api/clans/reset", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "player.tags", "write")) return sendForbidden(res, "player.tags", "write");
    const body = await readJsonBody(req);
    const asked = str(body.key).trim();
    if (!asked) return sendError(res, 400, "name the clan to reset");
    const out = await oneAtATime(async () => {
      const settings = (await ctx.repo.appConfig.get()).clanTags;
      const key = clanResolveKey(settings, asked);
      if (!clanGroupCustomised(settings, key)) return { error: "that clan has nothing to reset — it is grouped automatically" };
      const groups = groupClanSpellings(settings, await ctx.repo.clanTags.tags());
      await ctx.repo.appConfig.set({ clanTags: resetClanGroup(settings, key) });
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "clans.reset", targetType: "system", targetId: "clans",
        summary: `reset the clan tag grouping of ${describe(settings, groups, key)}`,
        data: { key },
      });
      return { key };
    });
    if ("error" in out) return sendError(res, 400, out.error);
    sendJson(res, 200, out);
  }),

  // Name a group (an empty name shows its most-worn spelling again).
  route("POST", "/api/clans/rename", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "player.tags", "write")) return sendForbidden(res, "player.tags", "write");
    const body = await readJsonBody(req);
    const asked = str(body.key).trim();
    const label = str(body.label).trim();
    if (!asked) return sendError(res, 400, "name the clan to rename");
    if (label.length > CLAN_LABEL_MAX) return sendError(res, 400, `a clan name is at most ${CLAN_LABEL_MAX} characters`);
    const out = await oneAtATime(async () => {
      const settings = (await ctx.repo.appConfig.get()).clanTags;
      const key = clanResolveKey(settings, asked);
      const groups = groupClanSpellings(settings, await ctx.repo.clanTags.tags());
      if (!groups.has(key)) return { error: "that clan has not been seen on any player" };
      const before = describe(settings, groups, key);
      await ctx.repo.appConfig.set({ clanTags: renameClanGroup(settings, key, label) });
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "clans.rename", targetType: "system", targetId: "clans",
        summary: label ? `named the clan ${before} “${label}”` : `cleared the name of the clan ${before}`,
        data: { key, label: label || null },
      });
      return { key };
    });
    if ("error" in out) return sendError(res, 400, out.error);
    sendJson(res, 200, out);
  }),
];
