/**
 * Our stored game-log events as the lines CRCON's stats read: what rcon/rcon.py's parse_log_line
 * makes of each game line at v12.3.0, after rcon/logs/loop.py's record_line has filled in the ids
 * of lines that name a player without one.
 *
 *   - Only what CRCON's parser accepts becomes a line. Its kill and team-kill pattern takes the
 *     Allies and Axis tokens only, so a kill tagged with anything else never reaches its stats;
 *     its camera branch reads the older "Player [...] Entered Admin Camera" form, so the camera
 *     lines the game writes now are dropped as an unknown type.
 *   - A team switch, a kick or ban, a vote and a started vote name players without ids. While the
 *     round they fall in is CRCON's current map, record_line looks each name up among the players
 *     its cache has seen this round (an online player taking a shared name over an offline one) and
 *     among the ids lines have already carried for it, and files the line under that id.
 *
 * Lines come out in the order they happened. Only what CRCON's stats use is carried: the action,
 * the time, both players, the weapon, and the text of a vote (PV_Favour / PV_Against).
 *
 * ---------------------------------------------------------------------------------------------
 * Derived from Hell Let Loose Community RCON (CRCON) — https://github.com/MarechJ/hll_rcon_tool
 *   Copyright (c) 2020 Julien Marechal. MIT License; full text in third_party/crcon/LICENSE.
 */
import type { CrconPlayerCache, EvtRow } from "@app/db";
import type { CrconLogLine } from "./crcon-stats.js";

/** The stored event kinds that become CRCON lines. */
export const CRCON_LOG_KINDS = [
  "evt.kill", "evt.teamkill", "evt.player.connected", "evt.player.disconnected",
  "evt.chat.team", "evt.chat.squad", "evt.player.teamSwitched", "evt.player.kicked", "evt.player.banned",
  "evt.vote.started", "evt.vote.cast", "evt.vote.completed", "evt.admin.message",
  "evt.match.started", "evt.match.ended",
] as const;

/** A round as record_line sees it: its window and the players its cache had seen. */
export interface CrconLogRound {
  startMs: number;
  endMs: number | null;
  players: CrconPlayerCache;
}

/** CRCON's kill pattern: `\((?:Allies|Axis)\/`, nothing else. */
const KILL_SIDES = new Set(["Allies", "Axis"]);

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const sideOk = (token: unknown): boolean => token === undefined || KILL_SIDES.has(str(token) ?? "");

/** _get_name_to_id: each name the cache holds, an online player taking it over an offline one. */
function nameToIdOf(players: CrconPlayerCache): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, line] of players) {
    for (const name of line.names) {
      const existing = out.get(name);
      if (!existing) out.set(name, id);
      else if (existing !== id && line.status === "online") out.set(name, id);
    }
  }
  return out;
}

/**
 * The events' lines, oldest first. `platformOf` turns our internal player ids into the game's
 * (null where we cannot); `rounds` are the rounds the events can fall in, any order.
 */
export function crconLogLines(
  events: EvtRow[],
  platformOf: (internalId: string) => string | null,
  rounds: CrconLogRound[],
): CrconLogLine[] {
  // Oldest first. The game's own order inside one second is not stored, so lines sharing a second
  // go in the stores' tiebreak order (the line's identity, then the row's).
  const ordered = [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)
    || (a.dedupeKey ?? "").localeCompare(b.dedupeKey ?? "") || a.id.localeCompare(b.id));
  const windows = [...rounds].sort((a, b) => a.startMs - b.startMs);
  const lookups = new Map<CrconLogRound, Map<string, string>>();
  const roundAt = (ms: number): CrconLogRound | null => {
    let found: CrconLogRound | null = null;
    for (const r of windows) if (r.startMs <= ms) found = r;
    if (!found || (found.endMs !== null && ms > found.endMs)) return null;
    return found;
  };
  const id = (internal: string | null): string | null => (internal ? platformOf(internal) : null);

  const out: CrconLogLine[] = [];
  for (const e of ordered) {
    const t = Date.parse(e.ts);
    const data = e.data ?? {};
    let line: CrconLogLine;
    const base = { timestampMs: t, player_name_2: null, player_id_2: null, weapon: null, raw: "" };
    switch (e.kind) {
      case "evt.kill":
      case "evt.teamkill":
        // A kill recorded before the parser kept the side tokens has none to judge by, and stays.
        if (!sideOk(data.playerTeam) || !sideOk(data.victimTeam)) continue;
        line = {
          ...base, action: e.kind === "evt.kill" ? "KILL" : "TEAM KILL",
          player_name_1: e.actorName, player_id_1: id(e.actorPlayerId),
          player_name_2: e.victimName, player_id_2: id(e.victimPlayerId),
          weapon: e.weapon ?? "",
        };
        break;
      case "evt.player.connected":
      case "evt.player.disconnected":
        line = { ...base, action: e.kind === "evt.player.connected" ? "CONNECTED" : "DISCONNECTED", player_name_1: e.actorName, player_id_1: id(e.actorPlayerId) };
        break;
      case "evt.chat.team":
      case "evt.chat.squad":
        line = { ...base, action: "CHAT", player_name_1: e.actorName, player_id_1: id(e.actorPlayerId) };
        break;
      case "evt.admin.message":
        line = { ...base, action: "MESSAGE", player_name_1: e.actorName, player_id_1: id(e.actorPlayerId) };
        break;
      // The lines that name players without their ids: record_line fills those in below.
      case "evt.player.teamSwitched":
        line = { ...base, action: "TEAMSWITCH", player_name_1: e.actorName, player_id_1: null };
        break;
      case "evt.player.kicked":
      case "evt.player.banned":
        line = { ...base, action: "ADMIN", player_name_1: e.actorName, player_id_1: null };
        break;
      case "evt.vote.started":
        line = { ...base, action: "VOTE STARTED", player_name_1: e.actorName, player_id_1: null, player_name_2: str(data.target) };
        break;
      case "evt.vote.cast":
        line = { ...base, action: "VOTE", player_name_1: e.actorName, player_id_1: null, raw: str(data.content) ?? "" };
        break;
      case "evt.vote.completed":
        line = { ...base, action: "VOTE COMPLETED", player_name_1: null, player_id_1: null };
        break;
      case "evt.match.started":
      case "evt.match.ended":
        line = { ...base, action: e.kind === "evt.match.started" ? "MATCH START" : "MATCH ENDED", player_name_1: null, player_id_1: null };
        break;
      default:
        continue;
    }
    const round = roundAt(t);
    if (round) {
      let names = lookups.get(round);
      if (!names) lookups.set(round, (names = nameToIdOf(round.players)));
      for (const slot of [1, 2] as const) {
        const name = slot === 1 ? line.player_name_1 : line.player_name_2;
        let pid = slot === 1 ? line.player_id_1 : line.player_id_2;
        if (!pid && !name) continue;
        if (!pid && name) pid = names.get(name) ?? null;
        if (!pid) continue;
        if (name && !names.has(name)) names.set(name, pid);
        if (slot === 1) line.player_id_1 = pid;
        else line.player_id_2 = pid;
      }
    }
    out.push(line);
  }
  return out;
}
