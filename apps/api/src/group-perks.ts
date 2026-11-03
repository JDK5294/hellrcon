/**
 * Group VIP perks — the API's half: reading a perk off a request, which servers it lands on, and
 * the keys a person needs to set one up or to change a perk group's membership.
 *
 * A perk turns group membership into VIP: while listed, permanent VIP on the servers it covers
 * (timed VIP frozen beneath it), and on leaving the frozen balance back plus a severance. The
 * worker's reconciler does the granting (apps/workers/src/group-perks.ts); this decides who may
 * point it at whom.
 *
 * Groups have always promised to add convenience, never power: managing them needs player.groups,
 * and each bulk action needs its own key. A perk would break that promise if membership alone
 * moved VIP — anyone allowed to edit a group could hand out permanent VIP on every server. So
 * the VIP keys follow the perk: setting one up takes vip.grant AND vip.revoke on every server it
 * covers (it does both), switching it off takes vip.revoke on them, adding someone to a perk
 * group takes vip.grant there and removing someone takes vip.revoke. No new keys — the ones that
 * already say who may grant and take VIP on a server. A rule watching the group's membership is
 * held to the same promise (membershipKeyMissing).
 */
import { banScopeCovers, ruleSwitchedOn, type GroupVipPerk, type PlayerGroupRow, type Repository, type ServerRow } from "@app/db";
import { can, type Grant } from "@app/access";
import { getGame } from "@app/games";
import { GROUP_JOINED_KIND, GROUP_LEFT_KIND, SCHEDULE_KIND, resolveTriggerParams } from "@app/rules";
import { parseBanScope } from "./ban-scope.js";
import { ruleKeyMissing } from "./routes/kit.js";

/** A severance longer than this is not a parting gift, it is a grant — give that instead. */
export const PERK_SEVERANCE_MAX_MINUTES = 365 * 1440;

/** The servers a perk covers right now (a rule — "every server" also covers ones added later). */
export function perkServers(perk: GroupVipPerk, servers: ServerRow[]): ServerRow[] {
  return servers.filter((s) => s.game === perk.game && banScopeCovers(perk.scope, s.id));
}

/**
 * Read a perk off a request body: `{ game, scope, severanceMinutes, bankRewards }`. A body without
 * `bankRewards` (a page from before the switch, still open) keeps the switch where `previous` has it.
 */
export function parseGroupVipPerk(body: Record<string, unknown>, previous: GroupVipPerk | null = null): { perk: GroupVipPerk } | { error: string } {
  const game = typeof body.game === "string" ? body.game.trim() : "";
  if (!game || !getGame(game)) return { error: "pick the game whose servers the perk covers" };
  const scope = parseBanScope(body);
  if (!scope.ok) return { error: scope.error };
  if (!scope.scope) return { error: "pick the servers the perk covers — every server of the game, all but some, or only some" };
  const raw = Number(body.severanceMinutes ?? 0);
  if (!Number.isFinite(raw) || raw < 0 || raw > PERK_SEVERANCE_MAX_MINUTES) return { error: "the severance must be between 0 (none) and a year" };
  if (body.bankRewards !== undefined && typeof body.bankRewards !== "boolean") return { error: "say whether rewards add to the frozen VIP (true) or not (false)" };
  const bankRewards = typeof body.bankRewards === "boolean" ? body.bankRewards : previous?.bankRewards !== false;
  return { perk: { game, scope: scope.scope, severanceMinutes: Math.round(raw), bankRewards } };
}

/** The first VIP key the person lacks on any of these servers, or null. */
export function vipKeyMissing(grants: Grant[], servers: ServerRow[], keys: ("vip.grant" | "vip.revoke")[]): { capability: string; server: ServerRow } | null {
  for (const s of servers) {
    for (const k of keys) if (!can(grants, k, "write", { serverId: s.id })) return { capability: k, server: s };
  }
  return null;
}

/**
 * The keys a membership change on this group needs beyond player.groups — none for a plain group.
 *
 * Two things can make membership move more than a list: the group's VIP perk (adding is a VIP
 * grant on its servers, removing ends one), and a live rule watching the group (a "player added
 * to / removed from" rule grants its VIP, points or tag to whoever the change names; a schedule
 * grants or cuts VIP for whoever is listed when it comes round). Either way
 * the person making the change is choosing who receives it, so they need the keys it exercises:
 * the perk's VIP key on its servers, and whatever the rule itself needed to be saved
 * (ruleKeyMissing — VIP grant on its server, the payout key for points, the tag key for tags).
 * A rule switched off or on a trial run acts on nobody, so it asks for nothing.
 */
export async function membershipKeyMissing(repo: Repository, grants: Grant[], group: PlayerGroupRow, change: "add" | "remove"): Promise<{ capability: string; server?: ServerRow } | null> {
  if (group.vipPerk) {
    const covered = perkServers(group.vipPerk, await repo.servers.list());
    const missing = vipKeyMissing(grants, covered, [change === "add" ? "vip.grant" : "vip.revoke"]);
    if (missing) return missing;
  }
  const kind = change === "add" ? GROUP_JOINED_KIND : GROUP_LEFT_KIND;
  // A schedule acting on the group is the same delegation one step removed: whoever is listed on
  // the day gets its grant, or its cut. Adding someone chooses that; removing someone only spares
  // them, which is no power a key guards.
  const watching = (await repo.enforcerRules.list()).filter((r) =>
    ruleSwitchedOn(r) && !r.dryRun && (r.eventKind === kind || (change === "add" && r.eventKind === SCHEDULE_KIND))
    && String(resolveTriggerParams(r.eventKind, r.params).groupId ?? "") === group.id);
  for (const rule of watching) {
    const capability = ruleKeyMissing(grants, rule);
    if (capability) return { capability };
  }
  return null;
}

/**
 * A grant aimed at a player whose VIP a group perk holds. The grant is permanent while they stay,
 * so time has nowhere to go but the frozen balance they get back on leaving: a stacked duration
 * adds to it, a fixed date or a "set to" duration tops it up to at least that much. A PERMANENT
 * grant is different — a person granting it outright takes the grant over, and the group no
 * longer ends it. Takes the request body the VIP routes already read (mode, expiresAt, days,
 * hours, cumulative); validate it with computeGrantExpiration first.
 */
export function grantForHeld(body: Record<string, unknown>, nowMs = Date.now()): { kind: "permanent" } | { kind: "bank"; change: { addMs?: number; atLeastMs?: number } } {
  const mode = typeof body.mode === "string" && body.mode ? body.mode : body.expiresAt ? "until" : body.days || body.hours ? "duration" : "permanent";
  if (mode === "permanent") return { kind: "permanent" };
  if (mode === "until") return { kind: "bank", change: { atLeastMs: Math.max(0, Date.parse(String(body.expiresAt)) - nowMs) } };
  const ms = (Number(body.days ?? 0) * 24 + Number(body.hours ?? 0)) * 3_600_000;
  return { kind: "bank", change: body.cumulative ? { addMs: ms } : { atLeastMs: ms } };
}

/** "permanent VIP from group "WW2 CVC"" — whose perk holds a grant. */
export function heldBy(hold: { groups: { name: string }[] }): string {
  const names = hold.groups.map((g) => `"${g.name}"`).join(", ");
  return `permanent VIP from group ${names || "perk"}`;
}

/** A held grant's frozen balance as staff say it — "13 days", "1.5 days", "5 hours", "20 minutes",
 *  "none" — worded as the panel's describeSpanMs words it, so a card and a profile read the same. */
export function describeSpanMs(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min <= 0) return "none";
  if (min >= 1440) return min % 1440 === 0 ? `${min / 1440} day${min === 1440 ? "" : "s"}` : `${(min / 1440).toFixed(1)} days`;
  if (min >= 60) { const h = Math.round(min / 60); return `${h} hour${h === 1 ? "" : "s"}`; }
  return `${min} minute${min === 1 ? "" : "s"}`;
}

/** "every WW2 server", "WW2 #1 and WW2 #3", "every WW2 server except WW2 #2" — for summaries. */
export function describePerkScope(perk: GroupVipPerk, servers: ServerRow[]): string {
  const label = getGame(perk.game)?.label ?? perk.game;
  const name = (id: string) => servers.find((s) => s.id === id)?.name ?? "a removed server";
  if (perk.scope.mode === "all") return `every ${label} server`;
  if (perk.scope.mode === "except") return perk.scope.serverIds.length ? `every ${label} server except ${perk.scope.serverIds.map(name).join(", ")}` : `every ${label} server`;
  return perk.scope.serverIds.map(name).join(", ");
}

/** "2 days", "12 hours", "none". */
export function describeMinutes(min: number): string {
  if (!min) return "none";
  if (min % 1440 === 0) return `${min / 1440} day${min === 1440 ? "" : "s"}`;
  if (min % 60 === 0) return `${min / 60} hour${min === 60 ? "" : "s"}`;
  return `${min} minute${min === 1 ? "" : "s"}`;
}
