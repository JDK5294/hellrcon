/**
 * The live match board, as a Discord embed — the panel's match card, rendered for a channel.
 *
 * ONE message per server, edited in place forever. That is the whole point: a channel of stale
 * round summaries is worse than no channel, because the top of it is always a lie. Nothing here
 * posts a second message; the worker only ever creates one and then edits it.
 *
 * Pure: state in, embed out. Every judgement about what a number MEANS lives here where it can be
 * tested, not in the timer that ships it.
 */
import { vipQueueDepth, type SessionInfo } from "@app/rcon-core";

/** The faction pair, as the game descriptor describes them. */
export interface BoardSide { id: string; label: string; color?: string }

export interface BoardInput {
  serverName: string;
  session: SessionInfo;
  sides: BoardSide[];
  /** aggregate per side, keyed by side id — already summed from the roster. */
  totals: Record<string, { players: number; kills: number; deaths: number }>;
  /** players in game holding a live VIP grant. */
  vips: number;
  /** the next map, when the rotation says. */
  nextMap?: string | null;
  /** filename of the round's artwork, attached alongside the message (see map-art.ts). */
  mapArt?: string | null;
  /** when this drawing was made. */
  at: Date;
}

/** Discord's embed shape, only the parts used here. */
export interface DiscordEmbed {
  /** the ROUND — map and mode. The server's name is the author line; community names run to
   *  three lines of shouting caps and a title has to be readable at a glance. */
  title: string;
  author: { name: string };
  color: number;
  description?: string;
  fields: { name: string; value: string; inline?: boolean }[];
  image?: { url: string };
  footer: { text: string };
  timestamp: string;
}

/** Seconds → "H:MM:SS" (or "MM:SS" under an hour), matching the panel's clock. */
export function clock(sec?: number): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "—";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
  return h >= 1 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/**
 * The sector bar as text: one block per cap, coloured by holder. Same rule as the panel — only a
 * scoreline that partitions a fixed set of caps can be read this way, so anything else draws
 * nothing rather than a lie.
 */
export function sectorBar(allied?: number, axis?: number): string {
  const a = Number(allied ?? 0), x = Number(axis ?? 0);
  const total = a + x;
  if (!Number.isFinite(total) || total < 2 || total > 10) return "";
  // Blocks only. The scoreline sits directly above it, so repeating "3 – 2" beside the bar was
  // saying the same thing twice on a line already crowded by full-size emoji.
  return `${"🟦".repeat(a)}${"🟥".repeat(x)}`;
}

/** A number the server did not report is "—", never 0: they are different answers. */
const n = (v?: number): string => (v == null || !Number.isFinite(v) ? "—" : String(v));

/**
 * The board.
 *
 * Laid out as SIX inline fields — two rows of three — because Discord only puts inline fields
 * side by side when their values are short enough to fit, and a client that gives up stacks the
 * whole thing into one long column. Every value here is a few characters wide for that reason;
 * the first attempt put "97/100 online · 30 VIP in game" in a field and got a column on a phone.
 */
export function buildStatusEmbed(input: BoardInput): DiscordEmbed {
  const { serverName, session: s, sides, totals, vips, nextMap, mapArt, at } = input;
  const [left, right] = sides;
  const leftT = totals[left?.id ?? ""] ?? { players: 0, kills: 0, deaths: 0 };
  const rightT = totals[right?.id ?? ""] ?? { players: 0, kills: 0, deaths: 0 };
  const leftLabel = left?.label ?? "Allies";
  const rightLabel = right?.label ?? "Axis";

  // The VIP counter is only believed when it could be a queue at all: a live build reports 742
  // there against a declared maximum of 2 (it is carrying the VIP list size).
  const vipWaiting = vipQueueDepth(s);
  const queue = s.queueCount == null ? "—" : `${s.queueCount}${s.maxQueueCount ? `/${s.maxQueueCount}` : ""}`;

  // Two rows of three. Short values keep them in a grid instead of a column.
  const fields: DiscordEmbed["fields"] = [
    { name: "Players", value: `${n(s.playerCount)}/${n(s.maxPlayerCount)}\n${vips} VIP`, inline: true },
    { name: "Queue", value: `${queue}${vipWaiting ? `\n${vipWaiting} VIP waiting` : s.maxVipQueueCount ? `\n${s.maxVipQueueCount} VIP slots` : ""}`, inline: true },
    { name: "Time left", value: clock(s.remainingMatchTime), inline: true },
    // The side label IS the field name — the first version used a zero-width space there and
    // repeated the label in the value, which cost a blank bold line per column.
    { name: `🟦 ${leftLabel}`, value: sideCol(leftT), inline: true },
    { name: `🟥 ${rightLabel}`, value: sideCol(rightT), inline: true },
    // Same reason, the field limit rather than the title one: this value carries a map's custom
    // display name, which staff type.
    { name: "Next map", value: (nextMap || "—").slice(0, 1024), inline: true },
  ];

  const bar = sectorBar(s.alliedScore, s.axisScore);
  return {
    // The round is the headline; the community's name is the small line above it.
    /**
     * Sliced, like the author line beside it. Discord caps an embed title at 256 and rejects the
     * ENTIRE message when it is over — so a long map name would not truncate the title, it would
     * stop the board updating at all, with nothing on screen saying why. The name comes off the
     * live session, which is the game's to decide, and staff can rename maps besides.
     */
    title: [s.mapName, s.gameMode].filter(Boolean).join(" · ").slice(0, 256) || "Live",
    author: { name: serverName.slice(0, 256) },
    // Allied lead blue, axis lead red, level pegging neutral — readable before any text is.
    color: (s.alliedScore ?? 0) > (s.axisScore ?? 0) ? 0x3b82f6 : (s.axisScore ?? 0) > (s.alliedScore ?? 0) ? 0xef4444 : 0x6b7280,
    // Score and the ground it describes, two short lines above everything else.
    // Conquest appends its own scoreline: morale is what the round actually ends on, and the
    // caps line alone would read as a warfare round that never moves.
    description: `**${leftLabel} ${n(s.alliedScore)} – ${n(s.axisScore)} ${rightLabel}**${bar ? `\n${bar}` : ""}${(s.initialMorale ?? 0) > 0 ? `\nMorale **${n(s.alliedMorale)} – ${n(s.axisMorale)}** of ${s.initialMorale}` : ""}`,
    fields,
    // The map's own artwork, uploaded with the message (see map-art.ts). Discord resolves
    // `attachment://` against the files on THIS message, so no public URL is needed.
    ...(mapArt ? { image: { url: `attachment://${mapArt}` } } : {}),
    // Says when it was last true, so a board frozen by an outage is visibly stale rather than
    // quietly wrong.
    footer: { text: "updated" },
    timestamp: at.toISOString(),
  };
}

/** One side's totals: players on one line, the kill/death pair on the next. Two lines, not four. */
function sideCol(t: { players: number; kills: number; deaths: number }): string {
  return `${t.players} players\n${t.kills.toLocaleString()} k · ${t.deaths.toLocaleString()} d`;
}
