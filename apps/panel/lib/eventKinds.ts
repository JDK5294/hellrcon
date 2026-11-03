/**
 * Event-kind vocabulary shared by every surface that filters the event stream (the Game log, the
 * Live feed). One list, so a category means the same thing everywhere it appears.
 */
export interface EventCategory { id: string; label: string; kinds: string[] }

export const EVENT_CATEGORIES: EventCategory[] = [
  { id: "all", label: "All", kinds: [] },
  { id: "chat", label: "Chat", kinds: ["evt.chat.team", "evt.chat.squad"] },
  // Kills means kills. Team kills used to be in here too, on the reasoning that a TK is still a
  // kill — but a filter exists to narrow, and one that still shows the thing you filtered away is
  // not narrowing. It also made every TK appear under two filters at once, so counting from the
  // Kills view double-counted them. Team kills have their own category directly below; anyone who
  // wants both together has All.
  { id: "kills", label: "Kills", kinds: ["evt.kill"] },
  { id: "teamkills", label: "Team kills", kinds: ["evt.teamkill"] },
  { id: "moderation", label: "Moderation", kinds: ["evt.player.kicked", "evt.player.banned", "evt.player.punished", "evt.admin.message", "evt.admin.camera"] },
  { id: "connections", label: "Connections", kinds: ["evt.player.connected", "evt.player.disconnected"] },
  // Their own filter, for the same reason as team kills: a player swapping sides to find the other
  // team's garrisons is a moderation question, and under Connections the swaps were lost among
  // every join and leave on the server.
  { id: "teamswitches", label: "Team switches", kinds: ["evt.player.teamSwitched"] },
  { id: "votes", label: "Votes", kinds: ["evt.vote.started", "evt.vote.completed", "evt.vote.cast"] },
  { id: "match", label: "Match", kinds: ["evt.match.started", "evt.match.ended"] },
];

/** Every kind any category can show. Used to assert the vocabulary stays complete: a kind that can
 *  be stored but appears in no category is only reachable under "All", which is how events go
 *  quietly missing. */
export const CATEGORISED_KINDS = [...new Set(EVENT_CATEGORIES.flatMap((c) => c.kinds))];

/** Short labels where the key's own words do not read ("teamSwitched"). */
const SHORT_KIND_LABEL: Record<string, string> = { "evt.player.teamSwitched": "team switch" };

/** Short kind label: "evt.kill" → "kill", "evt.player.connected" → "connected". */
export const kindLabel = (k: string) => SHORT_KIND_LABEL[k] ?? k.replace(/^evt\./, "").replace(/^player\./, "").replace(/\./g, " ");

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`;
}

/**
 * A team switch in words, after the player's name: "joined Allies", "left Allies (unassigned)",
 * "switched sides Allies → Axis", and "… (2nd this round)" from the second swap on. The game puts
 * Unassigned ("None") between the sides, so a swap is the join that lands on the other side; ingest
 * marks it (swapFrom, swapCount). Built from the teams rather than the stored sentence, so a row
 * that only has its teams back reads the same. Null when the row carries no teams (an older row).
 *
 * The Discord relay words it the same way, from its own copy (apps/discord/src/format.ts) — the
 * two are pinned to the same strings by their tests.
 */
export function teamSwitchText(data: unknown): string | null {
  const d = (data ?? null) as { from?: unknown; to?: unknown; swapFrom?: unknown; swapCount?: unknown; change?: unknown } | null;
  if (!d) return null;
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const unassigned = (t: string) => !t || /^(none|unassigned)$/i.test(t);
  const from = s(d.from), to = s(d.to);
  if (!from && !to) return s(d.change) || null;
  const came = s(d.swapFrom) || (!unassigned(from) ? from : "");
  if (!unassigned(to)) {
    if (came && came.toLowerCase() !== to.toLowerCase()) {
      const n = typeof d.swapCount === "number" ? d.swapCount : 0;
      return `switched sides ${came} → ${to}${n >= 2 ? ` (${ordinal(n)} this round)` : ""}`;
    }
    return `joined ${to}`;
  }
  if (!unassigned(from)) return `left ${from} (unassigned)`;
  return "unassigned";
}

/**
 * The short chip + colour family per kind, used wherever an event is shown as a row.
 *
 * Lives here rather than in the component that renders it because it is a vocabulary, not a view:
 * the auto-mod rule editor needs the same list to offer triggers, and it kept its own hand-written
 * copy that had drifted four kinds behind this one.
 */
export const EVENT_TAG: Record<string, { label: string; cls: string }> = {
  "evt.chat.team": { label: "TEAM", cls: "chat" },
  "evt.chat.squad": { label: "UNIT", cls: "chat" },
  "evt.kill": { label: "KILL", cls: "kill" },
  "evt.teamkill": { label: "TK", cls: "tk" },
  "evt.player.connected": { label: "JOIN", cls: "conn" },
  "evt.player.disconnected": { label: "LEFT", cls: "conn" },
  "evt.player.teamSwitched": { label: "SWITCH", cls: "conn" },
  "evt.player.kicked": { label: "KICK", cls: "mod" },
  "evt.player.banned": { label: "BAN", cls: "mod" },
  "evt.player.punished": { label: "PUNISH", cls: "mod" },
  "evt.admin.message": { label: "MSG", cls: "mod" },
  // Imported from CRCON archives. It was already selectable under the Moderation filter and had
  // no tag, so it rendered as a bare bullet with no colour.
  "evt.admin.camera": { label: "CAM", cls: "mod" },
  "evt.vote.started": { label: "VOTE", cls: "vote" },
  "evt.vote.completed": { label: "VOTE", cls: "vote" },
  "evt.vote.cast": { label: "VOTE", cls: "vote" },
  "evt.match.started": { label: "MATCH", cls: "match" },
  "evt.match.ended": { label: "MATCH", cls: "match" },
};

/**
 * The name a PERSON would use for a kind — for dropdowns and sentences, where the three-letter
 * chip ("TK") is too terse and the raw key ("evt.teamkill") is a database detail nobody
 * configuring auto-moderation should have to recognise.
 */
export const EVENT_KIND_LABEL: Record<string, string> = {
  "evt.kill": "Kill",
  "evt.teamkill": "Team kill",
  "evt.chat.team": "Team chat message",
  "evt.chat.squad": "Unit chat message",
  "evt.player.connected": "Player connected",
  "evt.player.disconnected": "Player disconnected",
  "evt.player.teamSwitched": "Player switched team",
  "evt.player.kicked": "Player kicked",
  "evt.player.banned": "Player banned",
  "evt.player.punished": "Player punished",
  "evt.admin.message": "Admin message",
  "evt.admin.camera": "Admin camera",
  "evt.vote.started": "Vote started",
  "evt.vote.completed": "Vote completed",
  "evt.vote.cast": "Vote cast",
  "evt.match.started": "Match started",
  "evt.match.ended": "Match ended",
};

/** …falling back to a readable form of the key rather than the key itself. */
export const eventKindLabel = (k: string): string => EVENT_KIND_LABEL[k] ?? kindLabel(k);

/** Every kind the vocabulary knows, in the order the maps declare them. */
export const ALL_EVENT_KINDS = Object.keys(EVENT_KIND_LABEL);

/** Does this event involve the picked player? Stream frames carry internal ids while the picker
 *  holds a platform id, so identity falls back to an exact (case-insensitive) name match. */
export function involvesPlayer(
  e: { actorPlayerId?: string | null; actorName?: string | null; victimPlayerId?: string | null; victimName?: string | null },
  picked: { playerId: string; name: string },
): boolean {
  if (e.actorPlayerId === picked.playerId || e.victimPlayerId === picked.playerId) return true;
  const n = picked.name.toLowerCase();
  if (!n) return false;
  return (e.actorName ?? "").toLowerCase() === n || (e.victimName ?? "").toLowerCase() === n;
}
