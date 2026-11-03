/**
 * The demo's community at scale (lib/demo/server): a few hundred made-up players, the game log of
 * their evenings on the first server, its rounds, its VIPs and bans, and the standings — made the
 * same way on every visit (one seeded generator), so a profile opened twice is the same person.
 *
 * No id here can be a real player's: a Steam id is below the first account Steam ever gave out
 * (76561197960265728), and an Epic id is not hexadecimal.
 */
import type { DemoAnswer, DemoRequest } from "./server.ts";

/** Puts a read on the demo's routes; a handler with nothing to say (undefined) leaves it to the stage. */
type Route = (method: string, path: string, handle: (req: DemoRequest, params: Record<string, string>) => DemoAnswer | undefined) => void;

/** Same numbers, same order, every visit. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ADJECTIVES = ["Iron", "Red", "Grey", "Night", "Storm", "Copper", "Silent", "Lucky", "Rusty", "Brave", "Frost", "Swift", "Dusty", "Old", "Mad", "Sly", "Bold", "Wild", "Cold", "Pale"];
const ANIMALS = ["Badger", "Falcon", "Otter", "Fox", "Heron", "Wolf", "Moose", "Raven", "Pike", "Bear", "Hare", "Lynx", "Crow", "Mole", "Ram", "Stoat", "Wren", "Bison", "Gull", "Newt"];
const TAGS = ["", "", "", "", "[OWL] ", "[FOG] ", "[TIN] ", "[KEG] "];
const WEAPONS = ["M1 GARAND", "KARABINER 98K", "THOMPSON", "MP40", "BROWNING M1919", "MG42", "M1 CARBINE", "GEWEHR 43", "STG44", "BAR", "COLT M1911", "WALTHER P38"];
const CHAT = [
  "need ammo at the garrison", "tank on the left flank", "push the middle point", "gg", "smoke on the point please",
  "anyone have a medic?", "garrison going up behind the church", "arty incoming", "nice shot", "OP is up on the hill",
  "commander, supply drop on the ridge please", "they're flanking through the woods",
];
const MAPS = ["Foy", "Carentan", "Sainte-Mère-Église", "Utah Beach", "Omaha Beach", "Hürtgen Forest", "Kursk", "Stalingrad", "Hill 400", "Purple Heart Lane", "Remagen", "Kharkov", "El Alamein", "Driel", "Mortain", "Elsenborn Ridge", "Tobruk"];
const STAFF = ["Sam", "Alex", "Jordan", "Riley"];
const BAN_REASONS: [string, string][] = [
  ["Teamkilling at spawn", "teamkilling"], ["Abusive chat", "toxicity"], ["Cheating", "cheating"], ["Griefing the garrisons", "griefing"],
  ["Ignoring the squad lead rules", "rules"], ["Racist name", "toxicity"],
];
const VIP_NOTES = ["Paid: one month", "Paid: three months", "Seeder of the week", "Event winner", "Clan member", "Supporter"];
const WATCH_REASONS = ["Teamkilling at spawn", "Abusive in chat", "Reported for cheating", "Ignores the squad leader", "Griefing the garrisons", "Spamming the chat"];

/** How long the round on Live (lib/demo/match) has been going when the demo opens. */
export const ROUND_STARTED_AGO = 25 * 60_000;

export interface DemoPlayer {
  id: string; name: string; platform: "steam" | "epic"; platformId: string; firstSeen: string; lastSeen: string; game: "hll";
  level: number; kills: number; deaths: number; teamkills: number; visits: number; playtimeSec: number; watchlist: boolean; vip: boolean;
  combat: number; offense: number; defense: number; support: number; slSeconds: number;
}

/** A Steam id that cannot be a real account's: under the first Steam ever gave out. */
export const steamId = (n: number) => `7656119${String(n).padStart(10, "0")}`;
/** An Epic id that cannot be a real one's: Epic's are hexadecimal, and "demo" is not. */
const epicId = (n: number) => `demo${n.toString(16).padStart(28, "0")}`;

/** The community: everything below drawn from the one generator, as of `now`. */
export function createCommunity(now: number) {
  const rnd = seeded(20261030);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const iso = (ms: number) => new Date(ms).toISOString();
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;

  const players: DemoPlayer[] = [];
  const names = new Set<string>();
  for (let i = 1; players.length < 400; i++) {
    let name = `${pick(TAGS)}${pick(ADJECTIVES)}${pick(ANIMALS)}`;
    if (names.has(name)) name = `${name}${int(2, 99)}`;
    if (names.has(name)) continue;
    names.add(name);
    const epic = rnd() < 0.18;
    const hours = int(1, 400);
    const kills = Math.round(hours * (5 + rnd() * 25));
    const deaths = Math.round(kills * (0.5 + rnd() * 1.2));
    const firstSeen = now - int(2, 300) * DAY;
    players.push({
      id: `dp${i}`, name, platform: epic ? "epic" : "steam", platformId: epic ? epicId(i) : steamId(i),
      firstSeen: iso(firstSeen), lastSeen: iso(Math.max(firstSeen, now - Math.floor(rnd() * rnd() * 40 * DAY))), game: "hll",
      level: int(1, 350), kills, deaths, teamkills: Math.round(kills * rnd() * 0.03), visits: Math.max(1, Math.round(hours / (1 + rnd() * 3))),
      playtimeSec: hours * 3600, watchlist: rnd() < 0.04, vip: rnd() < 0.12,
      combat: kills * int(40, 80), offense: Math.round(hours * int(20, 120)), defense: Math.round(hours * int(20, 120)),
      support: Math.round(hours * int(10, 150)), slSeconds: rnd() < 0.3 ? Math.round(hours * 3600 * rnd() * 0.4) : 0,
    });
  }
  const byId = new Map(players.map((p) => [p.id, p]));
  const regulars = [...players].sort((a, b) => b.playtimeSec - a.playtimeSec).slice(0, 120);

  // The first server's rounds, newest first: an hour and a half each, back to back, up to the one
  // being played now.
  const matches = Array.from({ length: 60 }, (_, i) => {
    const endedAt = now - ROUND_STARTED_AGO - i * 95 * 60_000;
    const durationSec = int(80, 95) * 60;
    const allies = int(0, 5);
    const axis = allies === 5 ? int(0, 4) : 5 - allies;
    const winner = allies > axis ? "allies" : "axis";
    return {
      id: `dm${i + 1}`, map: `${pick(MAPS)} Warfare`, startedAt: iso(endedAt - durationSec * 1000), endedAt: iso(endedAt), durationSec,
      result: `${winner === "allies" ? "ALLIED" : "AXIS"} (${allies} - ${axis})`, score: `${allies} - ${axis}`, winner, alliedScore: allies, axisScore: axis,
    };
  });

  // The first server's game log: the last six hours, newest first.
  type Evt = { ts: string; kind: string; serverId: string; actorName: string; actorPlayerId: string; victimName?: string; victimPlayerId?: string; weapon?: string; data?: Record<string, unknown> };
  const events: Evt[] = [];
  for (let t = now - 20_000; t > now - 6 * HOUR; t -= int(3, 30) * 1000) {
    const a = pick(regulars);
    const side = rnd() < 0.5 ? "allies" : "axis";
    const roll = rnd();
    const base = { ts: iso(t), serverId: "s1", actorName: a.name, actorPlayerId: a.id };
    if (roll < 0.62) {
      const v = pick(regulars);
      events.push({ ...base, kind: "evt.kill", victimName: v.name, victimPlayerId: v.id, weapon: pick(WEAPONS), data: { actorSide: side } });
    } else if (roll < 0.66) {
      const v = pick(regulars);
      events.push({ ...base, kind: "evt.teamkill", victimName: v.name, victimPlayerId: v.id, weapon: pick(WEAPONS), data: { actorSide: side } });
    } else if (roll < 0.82) {
      events.push({ ...base, kind: rnd() < 0.7 ? "evt.chat.team" : "evt.chat.squad", data: { message: pick(CHAT), actorSide: side } });
    } else if (roll < 0.91) {
      events.push({ ...base, kind: "evt.player.connected" });
    } else if (roll < 0.99) {
      events.push({ ...base, kind: "evt.player.disconnected" });
    } else {
      events.push({ ...base, actorName: pick(STAFF), actorPlayerId: "", kind: "evt.admin.message", data: { message: "Play the objective, please" } });
    }
  }

  const vips = players.filter((p) => p.vip).map((p, i) => ({
    id: `dv${i + 1}`, serverId: "s1", playerId: p.platformId, playerName: p.name, comment: pick(VIP_NOTES),
    expiration: rnd() < 0.25 ? null : iso(now + int(1, 90) * DAY), pausedUntil: null, pauseReason: null, pausedBy: null, pauseMode: null, pausedAt: null,
    groupHold: null, perkGroups: [], createdByName: pick(STAFF), createdAt: iso(now - int(1, 120) * DAY), updatedAt: iso(now - int(0, 30) * DAY),
  }));

  const bans = Array.from({ length: 40 }, (_, i) => {
    const p = pick(players);
    const [reason, category] = pick(BAN_REASONS);
    const perma = category === "cheating" || rnd() < 0.2;
    const ts = now - int(1, 200) * HOUR;
    const expiresAt = perma ? null : ts + int(1, 7) * DAY;
    const lifted = !perma && rnd() < 0.15;
    return {
      id: `db${i + 1}`, ts: iso(ts), by: pick(STAFF), playerName: p.name, playerId: p.platformId, platform: p.platform, type: perma ? "perma" : "temp",
      reason, category, scope: { mode: "all" }, game: "hll", expiresAt: expiresAt ? iso(expiresAt) : null, liftedAt: lifted ? iso(ts + HOUR) : null,
      liftedBy: lifted ? pick(STAFF) : null, active: !lifted && (expiresAt === null || expiresAt > now), auto: false, serverIds: ["s1"],
    };
  }).sort((a, b) => b.ts.localeCompare(a.ts));

  return { players, byId, matches, events, vips, bans };
}

export type Community = ReturnType<typeof createCommunity>;

/** One page of `rows`, as the panel's paged lists ask for it. */
function page<T>(rows: T[], url: URL): T[] {
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  return rows.slice(offset, offset + limit);
}

const kd = (p: { kills: number; deaths: number }) => (p.deaths ? p.kills / p.deaths : p.kills);
/** A clan tag as the directory's clan filter compares it: "[OWL]", "owl" and "Owl" are one clan. */
const clanKey = (tag: string) => tag.toLowerCase().replace(/[^a-z0-9]/g, "");
/** The clan tag a name wears ("[OWL] RedFox" → "OWL"), or "". */
const tagOf = (name: string) => /^\[([^\]]+)\]/.exec(name)?.[1] ?? "";
/**
 * Page one of the game log pins the read to the moment it began, and later pages are read against
 * that moment, as the real API's are (apps/api routes/kit pageAnchor): what happens in the round in
 * between is not part of the read, so a page never repeats the rows of the one before.
 */
function anchorOf(url: URL): string {
  const raw = (url.searchParams.get("anchor") ?? "").trim();
  return raw && !Number.isNaN(Date.parse(raw)) ? new Date(raw).toISOString() : new Date(Date.now() + 1).toISOString();
}
const ok = (body: unknown): DemoAnswer => ({ status: 200, body });

/**
 * The community's reads, put on the demo's routes. `template` is how the walkthrough stage draws a
 * player's profile and a round, which the community's own are drawn after; `onServer` is who is
 * playing on the first server now (lib/demo/match), asked as the watchlist is read.
 */
export function addCommunity(on: Route, now: number, template: { profile: Record<string, unknown>; match: Record<string, unknown>; onServer: () => Set<string> }) {
  const c = createCommunity(now);
  const server = (id: string) => (id === "s1" ? "Server #1" : "Server #2");

  on("GET", "/api/players", (req) => {
    const u = req.url.searchParams;
    const q = (u.get("q") ?? "").trim().toLowerCase();
    const clan = clanKey(u.get("clan") ?? "");
    // Banned for good: an active permanent ban.
    const perma = u.get("permaBanned") === "1" ? new Set(c.bans.filter((b) => b.type === "perma" && b.active).map((b) => b.playerId)) : null;
    let rows = c.players.filter((p) => (!q || p.name.toLowerCase().includes(q) || p.platformId.includes(q))
      // Everyone here plays on the first server; the second has seen nobody.
      && (!u.get("serverId") || u.get("serverId") === "s1") && (!u.get("game") || p.game === u.get("game"))
      && (!clan || clanKey(tagOf(p.name)) === clan) && (!perma || perma.has(p.platformId))
      && (!u.get("platform") || p.platform === u.get("platform"))
      && (!u.get("watched") || p.watchlist) && (!u.get("vip") || p.vip)
      && (!u.get("seenFrom") || p.lastSeen >= u.get("seenFrom")!) && (!u.get("seenTill") || p.lastSeen <= u.get("seenTill")!));
    const key = u.get("sort") ?? "lastSeen";
    const value = (p: DemoPlayer): string | number => (key === "playtime" ? p.playtimeSec : key === "name" || key === "platform" || key === "firstSeen" || key === "lastSeen" ? p[key].toLowerCase() : (p as unknown as Record<string, number>)[key] ?? 0);
    const dir = u.get("sortDir") === "asc" ? 1 : -1;
    rows = [...rows].sort((a, b) => (value(a) < value(b) ? -dir : value(a) > value(b) ? dir : 0));
    return ok({ players: page(rows, req.url), total: rows.length });
  });

  on("GET", "/api/players/:id", (_req, { id }) => {
    const p = c.byId.get(id!);
    if (!p) return undefined;
    const recent = c.events.filter((e) => e.actorPlayerId === p.id || e.victimPlayerId === p.id).slice(0, 10);
    return ok({
      ...template.profile,
      player: { id: p.id, name: p.name, platform: p.platform, platformId: p.platformId, firstSeen: p.firstSeen, lastSeen: p.lastSeen },
      stats: { kills: p.kills, deaths: p.deaths, teamkills: p.teamkills },
      flags: { watchlist: p.watchlist, vip: p.vip, updatedByName: null },
      notes: [], links: [], tags: [], sessions: [],
      statsByServer: [{ serverId: "s1", serverName: server("s1"), kills: p.kills, deaths: p.deaths, playtimeSec: p.playtimeSec, matchesPlayed: Math.round(p.playtimeSec / 5000), matchesWon: Math.round(p.playtimeSec / 10000), slSeconds: p.slSeconds, visits: p.visits }],
      recentEvents: recent,
      vipStatus: p.vip ? [{ serverId: "s1", serverName: server("s1"), expiration: c.vips.find((v) => v.playerId === p.platformId)?.expiration ?? null, pausedUntil: null, pauseReason: null, pausedBy: null, pauseMode: null }] : [],
    });
  });

  on("GET", "/api/players/:id/events", (req, { id }) => {
    if (!c.byId.has(id!)) return undefined;
    const kinds = (req.url.searchParams.get("kinds") ?? "").split(",").filter(Boolean);
    const where = req.url.searchParams.get("serverId");
    const rows = c.events.filter((e) => (e.actorPlayerId === id || e.victimPlayerId === id)
      && (!kinds.length || kinds.includes(e.kind)) && (!where || e.serverId === where));
    return ok({ events: page(rows, req.url), total: rows.length });
  });

  on("GET", "/api/servers/:id/events", (req, { id }) => {
    if (id !== "s1") return undefined;
    const u = req.url.searchParams;
    const kinds = (u.get("kinds") ?? "").split(",").filter(Boolean);
    const q = (u.get("q") ?? "").trim().toLowerCase();
    const who = u.get("player");
    const anchor = anchorOf(req.url);
    const rows = c.events.filter((e) => e.ts < anchor && (!kinds.length || kinds.includes(e.kind))
      && (!who || e.actorPlayerId === who || e.victimPlayerId === who)
      && (!u.get("from") || e.ts >= u.get("from")!) && (!u.get("to") || e.ts <= u.get("to")!)
      && (!q || `${e.actorName} ${e.victimName ?? ""} ${String(e.data?.message ?? "")} ${e.weapon ?? ""}`.toLowerCase().includes(q)));
    return ok({ events: page(rows, req.url), total: rows.length, anchor });
  });

  on("GET", "/api/leaderboard", (req) => {
    if (req.url.searchParams.get("serverId") && req.url.searchParams.get("serverId") !== "s1") return ok({ leaderboard: [], total: 0 });
    const key = req.url.searchParams.get("sort") ?? "kills";
    const rows = c.players
      .map((p) => ({ playerId: p.id, name: p.name, kills: p.kills, deaths: p.deaths, teamkills: p.teamkills, kd: Math.round(kd(p) * 100) / 100, combat: p.combat, offense: p.offense, defense: p.defense, support: p.support, slSeconds: p.slSeconds, playtime: p.playtimeSec }))
      .sort((a, b) => (Number((b as Record<string, unknown>)[key]) || 0) - (Number((a as Record<string, unknown>)[key]) || 0));
    return ok({ leaderboard: page(rows, req.url), total: rows.length });
  });

  on("GET", "/api/servers/:id/matches", (req, { id }) => {
    if (id !== "s1") return undefined;
    return ok({ matches: page(c.matches.map(({ winner: _w, alliedScore: _a, axisScore: _x, ...m }) => m), req.url), total: c.matches.length });
  });

  on("GET", "/api/matches/:id", (_req, { id }) => {
    const m = c.matches.find((x) => x.id === id);
    if (!m) return undefined;
    const sides = c.players.slice(0, 40);
    const tmpl = template.match.match as Record<string, unknown>;
    return ok({
      match: { ...tmpl, id: m.id, serverId: "s1", serverName: server("s1"), map: m.map, startedAt: m.startedAt, endedAt: m.endedAt, winner: m.winner, alliedScore: m.alliedScore, axisScore: m.axisScore, result: m.result },
      stats: sides.map((p, i) => {
        const kills = Math.round(p.kills / Math.max(1, p.playtimeSec / 5000));
        return { matchId: m.id, playerId: p.id, playerName: p.name, side: i % 2 ? "axis" : "allies", kills, deaths: Math.round(kills * 0.9), teamkills: i % 7 === 0 ? 1 : 0, combat: kills * 45, offense: 60 + (i % 9) * 40, defense: 80 + (i % 5) * 60, support: 40 + (i % 8) * 50 };
      }),
    });
  });

  on("GET", "/api/servers/:id/vips", (_req, { id }) => (id === "s1" ? ok({ vips: c.vips }) : undefined));
  on("GET", "/api/bans", (req) => {
    const q = (req.url.searchParams.get("q") ?? "").trim().toLowerCase();
    const history = req.url.searchParams.get("history") === "1";
    // A ban covers both servers, so either's name finds it, as the real search does.
    return ok({ bans: c.bans.filter((b) => (history || b.active)
      && (!q || [b.playerName, b.playerId, b.reason, b.category, b.by, server("s1"), server("s2")].some((f) => f.toLowerCase().includes(q)))) });
  });
  // The watchlist: the community's watched players, those playing now first, then the newest.
  on("GET", "/api/players/flagged", () => {
    const playing = template.onServer();
    const flags = c.players.flatMap((p, i) => {
      if (!p.watchlist) return [];
      const at = new Date(now - (1 + ((i * 7) % 60)) * 86_400_000).toISOString(), by = STAFF[i % STAFF.length]!, reason = WATCH_REASONS[i % WATCH_REASONS.length]!;
      const online = playing.has(p.id);
      return [{
        playerId: p.id, name: p.name, watchlist: true, vip: p.vip, online, onlineServers: online ? [server("s1")] : [],
        updatedByName: by, updatedAt: at, watchReason: reason, watchBy: by, watchAt: at,
        reasons: [{ id: `dw${i}`, reason, addedBy: by, addedAt: at, expiresAt: null }],
      }];
    });
    return ok({ flags: flags.sort((a, b) => Number(b.online) - Number(a.online) || b.updatedAt.localeCompare(a.updatedAt)) });
  });
  return c;
}
