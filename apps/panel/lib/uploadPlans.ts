/**
 * What each line of an uploaded list would do, decided before anything changes — the preview the
 * upload popup shows, and the only lines it then sends. One plan per list:
 *
 *   - VIPs only ever ADD or LENGTHEN. Players pay real money for VIP, so a line never shortens a
 *     grant, never dates a permanent one, and leaves alone what a group perk or a VIP timeout holds.
 *     (The server applies the same floor again, so a plan read a minute ago cannot cut anyone's time.)
 *   - Bans place what is still in force: a lifted or finished ban, and anyone already banned, are
 *     left alone.
 *   - Group members are added once.
 *
 * Lines are matched to columns by name (findColumn), so a list from another tool works as long as
 * it has a "Player ID" column.
 */
import { cellText, cellTime, findColumn, type Table } from "./upload.ts";
import { fmtDay } from "./time.ts";

export type PlanAction = "add" | "extend" | "keep" | "skip";
export interface PlanRow<T> {
  /** The line of the file, counting the heading as line 1 — what a person looks for in it. */
  line: number;
  who: string;
  action: PlanAction;
  detail: string;
  payload?: T;
}
export interface Plan<T> { rows: PlanRow<T>[]; missing?: string }

const PLAYER_ID = ["playerId", "Player ID"] as const;

/** Lines in file order, one per player — a second line for the same player is skipped. */
function eachLine<T>(table: Table, decide: (cells: Table["rows"][number], id: string, line: number) => Omit<PlanRow<T>, "line">): Plan<T> {
  const idCol = findColumn(table, ...PLAYER_ID);
  if (!idCol) return { rows: [], missing: "Player ID" };
  const seen = new Set<string>();
  const rows = table.rows.map((cells, i) => {
    const line = i + 2;
    const id = cellText(cells[idCol.index]);
    if (!id) return { line, who: "—", action: "skip" as const, detail: "no player ID on this line" };
    if (seen.has(id)) return { line, who: id, action: "skip" as const, detail: "listed twice — the first line counts" };
    seen.add(id);
    return { line, ...decide(cells, id, line) };
  });
  return { rows };
}

// ---- VIPs ----

export interface CurrentVip { playerId: string; expiration: string | null; pausedUntil?: string | null; groupHold?: unknown }
export interface VipLine { playerId: string; playerName: string | null; until: string | null; comment?: string }

export function planVips(table: Table, current: CurrentVip[], now = Date.now()): Plan<VipLine> {
  const col = (key: string, label: string) => findColumn(table, key, label);
  const name = col("player", "Player"), status = col("status", "Status"), expires = col("expires", "Expires");
  const paused = col("pausedUntil", "Paused until"), comment = col("comment", "Comment");
  const byId = new Map(current.map((v) => [v.playerId, v]));
  return eachLine<VipLine>(table, (cells, playerId) => {
    const who = (name && cellText(cells[name.index])) || playerId;
    const said = status ? cellText(cells[status.index]).toLowerCase() : "";
    if (said === "group perk") return { who, action: "skip", detail: "VIP from a group perk — it comes with the group, not from a list" };
    const until = expires ? cellTime(cells[expires.index], expires.zone) : null;
    if (until === undefined) return { who, action: "skip", detail: "the end date could not be read" };
    const pausedTill = paused ? cellTime(cells[paused.index], paused.zone) : null;
    if (pausedTill && Date.parse(pausedTill) > now) return { who, action: "skip", detail: "paused in the list (a VIP timeout) — set it from their profile" };
    if (until && Date.parse(until) <= now) return { who, action: "skip", detail: `ended ${fmtDay(until)}` };
    if (!until && said === "expired") return { who, action: "skip", detail: "ended" };
    const cur = byId.get(playerId);
    if (cur?.groupHold) return { who, action: "keep", detail: "holds VIP from a group perk — left as it is" };
    if (cur?.pausedUntil && Date.parse(cur.pausedUntil) > now) return { who, action: "keep", detail: "paused here (a VIP timeout) — left as it is" };
    if (cur && cur.expiration === null) return { who, action: "keep", detail: "already permanent" };
    const payload: VipLine = { playerId, playerName: name ? cellText(cells[name.index]) || null : null, until, ...(comment && cellText(cells[comment.index]) ? { comment: cellText(cells[comment.index]) } : {}) };
    if (until === null) return { who, action: cur ? "extend" : "add", detail: cur ? "made permanent" : "permanent", payload };
    if (cur && Date.parse(cur.expiration!) >= Date.parse(until)) return { who, action: "keep", detail: `already VIP until ${fmtDay(cur.expiration)}` };
    return { who, action: cur ? "extend" : "add", detail: `until ${fmtDay(until)}`, payload };
  });
}

// ---- bans ----

export interface CurrentBan { playerId: string | null; active: boolean }
export interface BanLine { playerId: string; playerName: string | null; type: "perma" | "temp"; until: string | null; reason: string; category?: string }

/** What a ban row's game is called in the downloaded record ("WW2", "Vietnam"). */
const GAME_NAME: Record<string, string> = { hll: "WW2", hllv: "Vietnam" };

export function planBans(table: Table, current: CurrentBan[], game: string | undefined, now = Date.now()): Plan<BanLine> {
  const col = (key: string, label: string) => findColumn(table, key, label);
  const name = col("player", "Player"), type = col("type", "Type"), until = col("until", "Until");
  const hours = col("hours", "Hours"), when = col("when", "When"), reason = col("reason", "Reason");
  const category = col("category", "Category"), status = col("status", "Status"), gameCol = col("game", "Game"), ranOut = col("ranOut", "Ran out");
  const banned = new Set(current.filter((b) => b.active && b.playerId).map((b) => b.playerId!));
  const here = game ? GAME_NAME[game] ?? game : "";
  return eachLine<BanLine>(table, (cells, playerId) => {
    const who = (name && cellText(cells[name.index])) || playerId;
    const said = status ? cellText(cells[status.index]).toLowerCase() : "";
    if (said === "lifted") return { who, action: "skip", detail: "lifted" };
    if (said === "expired") return { who, action: "skip", detail: "already ended" };
    if (ranOut && ["yes", "true"].includes(cellText(cells[ranOut.index]).toLowerCase())) return { who, action: "skip", detail: "already ran out" };
    const theirGame = gameCol ? cellText(cells[gameCol.index]) : "";
    if (theirGame && here && theirGame !== here) return { who, action: "skip", detail: `a ${theirGame} ban — upload it on a ${theirGame} server` };
    const kind = type ? cellText(cells[type.index]).toLowerCase() : "perma";
    const isTemp = kind === "temp" || kind === "temporary";
    if (!isTemp && kind !== "perma" && kind !== "permanent" && kind !== "") return { who, action: "skip", detail: `"${cellText(cells[type!.index])}" is not a ban type — perma or temp` };
    let end: string | null = null;
    if (isTemp) {
      const read = until ? cellTime(cells[until.index], until.zone) : null;
      if (read === undefined) return { who, action: "skip", detail: "the end date could not be read" };
      end = read;
      if (!end && hours && when) {
        const from = cellTime(cells[when.index], when.zone);
        const h = Number(cellText(cells[hours.index]));
        if (from && h > 0) end = new Date(Date.parse(from) + h * 3_600_000).toISOString();
      }
      if (!end) return { who, action: "skip", detail: "a temporary ban with no end" };
      if (Date.parse(end) <= now) return { who, action: "skip", detail: "already ran out" };
    }
    if (banned.has(playerId)) return { who, action: "keep", detail: "already banned" };
    const payload: BanLine = {
      playerId, playerName: name ? cellText(cells[name.index]) || null : null, type: isTemp ? "temp" : "perma", until: end,
      reason: reason ? cellText(cells[reason.index]) : "", ...(category && cellText(cells[category.index]) ? { category: cellText(cells[category.index]) } : {}),
    };
    return { who, action: "add", detail: end ? `banned until ${fmtDay(end)}` : "banned permanently", payload };
  });
}

// ---- group members ----

export interface MemberLine { playerId: string; playerName: string | null }

export function planMembers(table: Table, members: { playerId: string }[]): Plan<MemberLine> {
  const name = findColumn(table, "player", "Player");
  const listed = new Set(members.map((m) => m.playerId));
  return eachLine<MemberLine>(table, (cells, playerId) => {
    const who = (name && cellText(cells[name.index])) || playerId;
    if (listed.has(playerId)) return { who, action: "keep", detail: "already in the group" };
    return { who, action: "add", detail: "added", payload: { playerId, playerName: name ? cellText(cells[name.index]) || null : null } };
  });
}
