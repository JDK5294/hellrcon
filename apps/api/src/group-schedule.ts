/**
 * One occurrence of a scheduled rule — "on the 1st of every month, give everyone in WW2 CVC 30
 * days of VIP" — acted on every member of its group.
 *
 * The enforcer decides WHEN (the rule's calendar, the claim that makes each occurrence run once);
 * this decides WHAT, per member and server, and says why for everyone it leaves alone:
 *
 *   - a member is acted on only at servers of their own game (groups mix both games' accounts);
 *     a console id the panel has never seen could be either game, so it waits;
 *   - only TIMED VIP is ever touched. Permanent VIP is a person's decision and a schedule never
 *     shortens, dates or removes it; VIP a group perk holds is left alone until they leave the
 *     group; VIP the game lists that the panel never granted (CRCON's, say) is not ours to extend,
 *     because a dated row over it would hand it to the expiry sweep;
 *   - a grant never shortens what someone already has; "cut back to" and "cut back by" move only
 *     dated grants, and a cut that uses a grant up removes it the way a person's reduction would;
 *   - only servers that are armed, run rules ("Auto settings & rules") and leave VIP expiry to
 *     the panel are written to — elsewhere the whole server is skipped, with the reason.
 *
 * A trial-run rule records what it would have done and writes nothing.
 */
import { automationEnabled, memberGameVerdict, type Repository, type RuleRow, type ServerRow, type VipRow } from "@app/db";
import { resolveTriggerParams, SCHEDULE_KIND } from "@app/rules";
import { computeGrantExpiration, neverShorter } from "./routes/kit.js";
import { SCHEDULE_ACTIONS, ruleGroupId } from "./schedule-spec.js";

export interface ScheduleRunDeps {
  repo: Repository;
  /** A game write on one server — paced by the caller, since a whole group is a crowd. */
  exec: (server: ServerRow, action: string, params: Record<string, unknown>) => Promise<void>;
  /** The game's own VIP list (player ids), or null when it cannot be read. */
  gameVipIds: (server: ServerRow) => Promise<Set<string> | null>;
}

export interface ScheduleMemberResult {
  serverId: string; serverName: string;
  playerId: string; playerName: string | null;
  applied: boolean;
  /** What was done ("until 2026-12-01…", "VIP removed") or why not. */
  note: string;
}

export interface ScheduleRun {
  /** The group's name, or null when the group no longer exists (nothing was done). */
  groupName: string | null;
  members: number;
  results: ScheduleMemberResult[];
  /** Servers left out whole, with the reason (observe mode, rules off, VIP expiry not ours…). */
  serverSkips: { serverId: string; serverName: string; reason: string }[];
  dryRun: boolean;
}

/** "30 days", "12 hours", "90 minutes". */
function span(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** Why a whole server sits this run out, or null when it may be written to. */
function serverRefusal(server: ServerRow): string | null {
  if (server.engagementMode !== "active") return "observe mode (read-only)";
  if (!automationEnabled(server.automation, "autosettings")) return "rules are switched off on this server (Auto settings & rules)";
  if (!automationEnabled(server.automation, "vipSweep")) return "the panel doesn't run VIP expiry on this server, so a schedule doesn't write VIP there";
  return null;
}

export async function runScheduleOccurrence(deps: ScheduleRunDeps, rule: RuleRow, occurrence: string): Promise<ScheduleRun> {
  const { repo } = deps;
  const dryRun = rule.dryRun === true;
  // Only what a schedule may do (the clock refuses anything else before claiming; this is the
  // runner's own floor, so no other action can ever read as a cut).
  if (!SCHEDULE_ACTIONS.has(rule.action)) return { groupName: null, members: 0, results: [], serverSkips: [], dryRun };
  const group = await repo.playerGroups.get(ruleGroupId(rule.params)).catch(() => null);
  if (!group) return { groupName: null, members: 0, results: [], serverSkips: [], dryRun };
  const members = await repo.playerGroups.members(group.id);
  const all = await repo.servers.list();
  const targets = rule.serverId ? all.filter((s) => s.id === rule.serverId) : all;
  const known = await repo.players.findByPlatformIds(members.map((m) => m.playerId)).catch(() => []);
  const gameOf = new Map(known.map((p) => [p.platformId, p.game]));
  const stack = resolveTriggerParams(SCHEDULE_KIND, rule.params).stack !== false;
  const minutes = Math.max(1, Math.round(rule.vipMinutes || 0));
  const results: ScheduleMemberResult[] = [];
  const serverSkips: ScheduleRun["serverSkips"] = [];
  const unplaced = new Set<string>();
  const base = { ruleId: rule.id, ruleName: rule.name, occurrence, groupId: group.id, scheduled: true };
  const via = `via scheduled rule "${rule.name}"`;

  for (const server of targets) {
    const here = members.filter((m) => {
      const verdict = memberGameVerdict(m.playerId, server.game, gameOf);
      if (verdict === "notSeen") unplaced.add(m.playerId);
      return verdict === "ok";
    });
    if (!here.length) continue;
    const refused = serverRefusal(server);
    if (refused) { serverSkips.push({ serverId: server.id, serverName: server.name, reason: refused }); continue; }
    // Only a grant needs the game's own list: it is what tells VIP set outside the panel apart.
    const listed = rule.action === "vip" ? await deps.gameVipIds(server) : new Set<string>();
    if (listed === null) { serverSkips.push({ serverId: server.id, serverName: server.name, reason: "the game's VIP list couldn't be read, so no VIP was granted" }); continue; }

    for (const m of here) {
      const who = m.playerName || m.playerId;
      const out = (applied: boolean, note: string) => results.push({ serverId: server.id, serverName: server.name, playerId: m.playerId, playerName: m.playerName, applied, note });
      // A hold is "left alone until they leave it" — read at the start, or begun mid-run (the
      // store then banks a grant, keeps a cut off frozen time, and refuses a revoke's delete).
      const heldNote = (hold: NonNullable<VipRow["groupHold"]>, banked = false) => {
        const names = hold.groups.map((g) => `"${g.name}"`).join(", ");
        return `holds permanent VIP from group ${names || "perk"} — ${banked ? "added to the VIP they get back on leaving it" : "left alone until they leave it"}`;
      };
      try {
        const existing: VipRow | null = await repo.vips.get(server.id, m.playerId);
        if (existing?.groupHold) { out(false, heldNote(existing.groupHold)); continue; }
        if (existing && existing.expiration === null) { out(false, "permanent VIP — a schedule never touches it"); continue; }
        const nowMs = Date.now();
        const paused = Boolean(existing?.pausedUntil && Date.parse(existing.pausedUntil) > nowMs);
        // A banked VIP timeout freezes the meter: what they have left is what was left when it
        // began, so grants and cuts alike are measured from there — measured from now, the
        // timeout's end would add its whole length on top of a grant.
        const frozen = Boolean(existing && existing.pauseMode === "banked" && existing.pausedUntil && existing.pausedAt);
        const refMs = frozen ? Date.parse(existing!.pausedAt!) : nowMs;

        if (rule.action === "vip") {
          if (!existing && listed.has(m.playerId)) { out(false, "VIP on the game's own list that the panel didn't grant — left alone"); continue; }
          const target = frozen
            ? new Date(stack
              ? Math.max(Date.parse(existing!.expiration!), refMs) + minutes * 60_000
              : Math.max(Date.parse(existing!.expiration!), refMs + minutes * 60_000)).toISOString()
            : neverShorter(existing, computeGrantExpiration({ mode: "duration", hours: minutes / 60, cumulative: stack }, existing));
          if (existing && target === existing.expiration) { out(false, `already has VIP past ${span(minutes)} from now`); continue; }
          if (!dryRun) {
            // A VIP timeout keeps them off the game; the time still lands on the row and the
            // timeout's end puts them back.
            if (!paused) await deps.exec(server, "vip", { playerId: m.playerId, description: who });
            const row = await repo.vips.upsert({ serverId: server.id, playerId: m.playerId, playerName: m.playerName, comment: existing ? null : `VIP from rule "${rule.name}"`, expiration: target, createdByUserId: null, createdByName: "enforcer" });
            if (row.groupHold) {
              await repo.audit.create({
                actorUserId: null, actorName: "enforcer", action: "vip.grant",
                targetType: "player", targetId: m.playerId, targetName: m.playerName ?? undefined, serverId: server.id,
                summary: `granted ${span(minutes)} of VIP to ${who} on ${server.name} ${via} — they hold permanent VIP from a group perk, so it waits for them when they leave it`,
                data: { ...base, playerId: m.playerId, groupHeld: true, bankedMs: row.groupHold.bankedMs },
              });
              out(true, heldNote(row.groupHold, true));
              continue;
            }
            // Permanent VIP granted meanwhile: the store's floor kept it, and nothing was granted.
            if (row.expiration === null) { out(false, "permanent VIP — a schedule never touches it"); continue; }
            await repo.audit.create({
              actorUserId: null, actorName: "enforcer", action: "vip.grant",
              targetType: "player", targetId: m.playerId, targetName: m.playerName ?? undefined, serverId: server.id,
              // What landed: the store keeps the later of the grant's date and this one.
              summary: `granted ${span(minutes)} of VIP to ${who} on ${server.name} ${via} (${stack ? "stacked" : "at least"}; until ${row.expiration})`,
              data: { ...base, playerId: m.playerId, expiration: row.expiration },
            });
            out(true, `until ${row.expiration}`);
            continue;
          }
          out(true, `until ${target}`);
          continue;
        }

        // The taking actions: timed VIP only (permanent and perk-held were let go above).
        if (!existing) { out(false, "no VIP on this server"); continue; }
        const expMs = Date.parse(existing.expiration!);
        if (!frozen && expMs <= nowMs) { out(false, "already expired"); continue; }
        // Taking the VIP off the game, then the row — only a TIMED row: a hold begun (or a person's
        // permanent grant) since the read keeps it, and the game gets back what was just removed.
        // What stands now, when a write found the timed grant it read gone or changed.
        const changedNote = (now: VipRow | null) => now?.groupHold ? heldNote(now.groupHold)
          : now && now.expiration === null ? "permanent VIP — a schedule never touches it"
          : "no VIP here any more — it was removed while the schedule ran";
        const takeAway = async (): Promise<boolean> => {
          if (!paused) await deps.exec(server, "vipremove", { playerId: m.playerId });
          if (await repo.vips.removeTimed(server.id, m.playerId)) return true;
          const now = await repo.vips.get(server.id, m.playerId);
          if (now && !paused && (now.groupHold || now.expiration === null)) await deps.exec(server, "vip", { playerId: m.playerId, description: who }).catch(() => {});
          out(false, changedNote(now));
          return false;
        };

        if (rule.action === "viprevoke") {
          if (!dryRun) {
            if (!(await takeAway())) continue;
            await repo.audit.create({
              actorUserId: null, actorName: "enforcer", action: "vip.revoke",
              targetType: "player", targetId: m.playerId, targetName: m.playerName ?? undefined, serverId: server.id,
              summary: `revoked ${who}'s timed VIP on ${server.name} ${via}`,
              // A decision a person configured, not automation running loose — the integrity scan
              // reads it as one.
              data: { ...base, playerId: m.playerId, before: existing.expiration, decidedByRule: true },
            });
          }
          out(true, "VIP removed");
          continue;
        }

        // viptrim: back to a span; vipreduce: by an amount (the only other action left).
        const newMs = rule.action === "viptrim" ? refMs + minutes * 60_000 : expMs - minutes * 60_000;
        if (rule.action === "viptrim" && expMs <= newMs) { out(false, `already ${span(minutes)} or less`); continue; }
        const usedUp = !frozen && newMs <= nowMs;
        const after = usedUp ? null : new Date(newMs).toISOString();
        if (!dryRun) {
          if (usedUp) {
            if (!(await takeAway())) continue;
          } else {
            // The game's entry stands; only our expiry moves — and only on the timed grant it read:
            // one taken into a hold, made permanent, or removed since is left as it is now.
            const row = await repo.vips.updateTimedExpiration(server.id, m.playerId, after!);
            if (!row) { out(false, changedNote(await repo.vips.get(server.id, m.playerId))); continue; }
          }
          await repo.audit.create({
            actorUserId: null, actorName: "enforcer", action: "vip.reduce",
            targetType: "player", targetId: m.playerId, targetName: m.playerName ?? undefined, serverId: server.id,
            summary: rule.action === "viptrim"
              ? `cut ${who}'s VIP on ${server.name} back to ${span(minutes)} ${via} (now until ${after})`
              : `removed ${span(minutes)} of VIP time from ${who} on ${server.name} ${via} (${usedUp ? "grant used up — VIP removed" : `now until ${after}`})`,
            data: { ...base, playerId: m.playerId, before: existing.expiration, after, removed: usedUp, removedMinutes: rule.action === "vipreduce" ? minutes : undefined, decidedByRule: true },
          });
        }
        out(true, usedUp ? "VIP used up — removed" : `now until ${after}`);
      } catch (err) {
        out(false, (err as Error).message);
      }
    }
  }
  for (const id of unplaced) {
    const m = members.find((x) => x.playerId === id);
    results.push({ serverId: "", serverName: "", playerId: id, playerName: m?.playerName ?? null, applied: false, note: "hasn't been seen on a server yet — a console id could belong to either game" });
  }
  return { groupName: group.name, members: members.length, results, serverSkips, dryRun };
}
