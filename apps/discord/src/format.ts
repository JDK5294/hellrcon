/**
 * Pure formatting: turn a canonical `evt.*` event (as it travels on the bus) into a one-line
 * Discord message and a routing category. No Discord/network here — this is unit-tested on its
 * own, and the relay decides which category goes to which channel.
 */
import { discordLiteral } from "@app/shared";

/** The event shape as published on the bus (the DB `NewEvt`; specifics live in `data`). */
export interface RelayEvent {
  kind: string;
  ts?: string;
  serverId?: string;
  /** our internal player id (present on the bus payload) — used to resolve watchlist status. */
  actorPlayerId?: string | null;
  actorName?: string | null;
  victimName?: string | null;
  weapon?: string | null;
  data?: Record<string, unknown> | null;
}

export type Category = "kills" | "chat" | "admin" | "connections" | "match";

export const ALL_CATEGORIES: readonly Category[] = ["kills", "chat", "admin", "connections", "match"];

const CATEGORY_OF: Record<string, Category> = {
  "evt.kill": "kills",
  "evt.teamkill": "kills",
  "evt.chat.team": "chat",
  "evt.chat.squad": "chat",
  "evt.player.kicked": "admin",
  "evt.player.banned": "admin",
  "evt.player.punished": "admin",
  "evt.admin.message": "admin",
  "evt.admin.camera": "admin",
  "evt.vote.started": "admin",
  "evt.vote.completed": "admin",
  // Individual ballots are one line per player per vote, so the relay drops them unless the
  // category opts in (`includeVoteBallots`). Mapped rather than omitted so the choice is visible.
  "evt.vote.cast": "admin",
  "evt.player.connected": "connections",
  "evt.player.disconnected": "connections",
  "evt.player.teamSwitched": "connections",
  "evt.match.started": "match",
  "evt.match.ended": "match",
};

/** Which channel-category an event belongs to, or null if we don't relay this kind. */
export function categoryOf(kind: string): Category | null {
  return CATEGORY_OF[kind] ?? null;
}

/** Every kind this relay knows how to route. Exported so a test can compare it against the store's
 *  vocabulary in both directions — a kind missing here is silently never relayed, and a kind here
 *  that the store cannot produce is a typo that would never match anything. */
export const RELAYED_KINDS: readonly string[] = Object.keys(CATEGORY_OF);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A field of the event in a player's (or an admin's) own words. */
const said = (v: unknown): string => discordLiteral(str(v));

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st. */
function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/**
 * A team switch in words: "joined Allies", "left Allies (unassigned)", "switched sides Allies →
 * Axis", and "… (2nd this round)" from the second swap on. The game puts Unassigned ("None")
 * between the sides, so a swap is the join that lands on the other side, which ingest marks
 * (swapFrom, swapCount). The panel words it the same way (apps/panel/lib/eventKinds.ts) — this
 * relay depends on no other package, so it keeps its own copy, pinned to the same strings by test.
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

// One formatter per zone, reused: a busy kill feed formats hundreds of lines a minute, and
// building an Intl.DateTimeFormat is the expensive half of using one.
const clockFormats = new Map<string, Intl.DateTimeFormat>();

/** HH:MM:SS on the given clock (IANA zone; default UTC), or "" if no/invalid timestamp. These
 *  lines are read by staff against their community's clock — a relay that says `17:31:05` for a
 *  fight everyone watched at 1:31 PM is answering a question nobody asked. */
function clock(ts?: string, tz?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const zone = tz || "UTC";
  try {
    let fmt = clockFormats.get(zone);
    if (!fmt) {
      // en-GB pins the 24h HH:MM:SS shape the relay has always used; only the zone moves.
      fmt = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
      clockFormats.set(zone, fmt);
    }
    return fmt.format(d);
  } catch {
    return d.toISOString().slice(11, 19); // junk zone → the old UTC reading, never a dropped line
  }
}

const name = (n?: string | null): string => (n && n.trim() ? discordLiteral(n.trim()) : "?");

/** Render the message body for an event (without the time prefix), or null to drop it. */
function body(evt: RelayEvent): string | null {
  const a = name(evt.actorName);
  const v = name(evt.victimName);
  const w = evt.weapon ? ` *(${evt.weapon})*` : "";
  const d = evt.data ?? {};
  switch (evt.kind) {
    case "evt.kill":
      return `☠️ **${a}** → ${v}${w}`;
    case "evt.teamkill":
      return `🔴 **TEAMKILL** ${a} → ${v}${w}`;
    case "evt.player.connected":
      return `➡️ ${a} connected`;
    case "evt.player.disconnected":
      return `⬅️ ${a} disconnected`;
    case "evt.player.teamSwitched":
      return `🔀 ${a} ${teamSwitchText(evt.data) ?? "switched team"}`;
    case "evt.chat.team":
      return `💬 [team] ${a}${str(d.message) ? `: ${said(d.message)}` : ""}`;
    case "evt.chat.squad":
      return `💬 [unit] ${a}${str(d.message) ? `: ${said(d.message)}` : ""}`;
    case "evt.admin.message":
      return `📢 to ${a}: ${said(d.message)}`;
    case "evt.admin.camera":
      return `🎥 ${a} used admin camera${str(d.message) ? ` — ${said(d.message)}` : ""}`;
    case "evt.player.kicked":
      return `👢 ${a} kicked${str(d.reason) ? ` — ${said(d.reason)}` : ""}`;
    case "evt.player.banned":
      return `🔨 ${a} banned${str(d.reason) ? ` — ${said(d.reason)}` : ""}`;
    case "evt.player.punished":
      return `☠️ ${a} punished${str(d.reason) ? ` — ${said(d.reason)}` : ""}`;
    case "evt.vote.started":
      return `🗳️ vote started${str(d.voteType) ? ` (${said(d.voteType)})` : ""}${str(d.target) ? ` vs ${said(d.target)}` : ""} by ${a}`;
    case "evt.vote.completed":
      return `🗳️ vote completed${str(d.result) ? `: ${said(d.result)}` : ""}`;
    case "evt.vote.cast":
      return `🗳️ ${a} voted${str(d.content) ? ` — ${said(d.content)}` : ""}`;
    case "evt.match.started":
      return `🗺️ Match started`;
    case "evt.match.ended":
      return `🏁 Match ended`;
    default:
      return null;
  }
}

/** Format an event into `{ category, line }`, or null if it isn't relayed. `tz` is the community
 *  timezone the line's clock is read in (absent = UTC, the pre-timezone behavior). */
export function formatEvent(evt: RelayEvent, tz?: string): { category: Category; line: string } | null {
  const category = categoryOf(evt.kind);
  if (!category) return null;
  const text = body(evt);
  if (!text) return null;
  const t = clock(evt.ts, tz);
  return { category, line: t ? `\`${t}\` ${text}` : text };
}
