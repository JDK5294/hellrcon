/**
 * The demo's match (lib/demo/server): the first server full and mid-round, its kills, team kills
 * and chat arriving every few seconds — on Live's scoreboard and feed, in the Game log, and on the
 * dashboard's live kills and rotation. Played in the visitor's browser by the community's own
 * regulars; when a round's time runs out the next map starts, and the round just played joins the
 * history.
 */
import { ROUND_STARTED_AGO, type Community } from "./community.ts";

const SQUADS = ["ABLE", "BAKER", "CHARLIE", "DOG", "EASY", "FOX", "GEORGE", "HOW", "ITEM"];
/** A squad's leader, and the roles of those who lead nothing (rifleman to engineer, no spotter). */
const OFFICER = 9;
const GRUNTS = [0, 1, 2, 3, 5, 6, 7, 8];
const WEAPONS = ["M1 GARAND", "KARABINER 98K", "THOMPSON", "MP40", "BROWNING M1919", "MG42", "M1 CARBINE", "GEWEHR 43", "STG44", "BAR"];
const CHAT = ["garrison up on the left", "need a medic at the barn", "tank coming down the road", "nice one", "push with me", "arty on the point", "smoke please", "gg so far"];
/** The rotation the match plays through: the game's map ids, names as the game prints them. */
const ROTATION = [
  { mapId: "foy_warfare", mapName: "FOY" },
  { mapId: "carentan_warfare", mapName: "CARENTAN" },
  { mapId: "hurtgenforest_warfare_V2", mapName: "HÜRTGEN FOREST" },
  { mapId: "stmereeglise_warfare", mapName: "SAINTE-MÈRE-ÉGLISE" },
];
const ROUND_SEC = 90 * 60;
/** Time between two things happening in the round, in seconds. */
const GAP = [2, 6] as const;
/** Back after longer than this away (a tab left in the background), the round skips ahead rather than replaying every kill. */
const CATCH_UP_MS = 2 * 60_000;

export interface GameEvent {
  ts: string; kind: string; serverId: string; actorName: string; actorPlayerId: string;
  victimName?: string; victimPlayerId?: string; weapon?: string; data?: Record<string, unknown>;
}

/** The round being played on the first server, as of `start`: some way in, its play so far played. */
export function createMatch(c: Community, start: number) {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const roster = c.players.slice(0, 98).map((p, i) => {
    const slot = i % 49;
    return { p, team: i < 49 ? 0 : 1, squad: SQUADS[Math.floor(slot / 6)]!, role: slot % 6 === 0 ? OFFICER : GRUNTS[i % GRUNTS.length]!, kills: 0, deaths: 0, teamKills: 0, score: 0 };
  });
  let map = 0;
  let roundStart = start - ROUND_STARTED_AGO;
  let allied = 2;
  let axis = 2;
  /** The time between two things happening, drawn afresh each time, in whole milliseconds. */
  const gap = () => Math.round((GAP[0] + rnd() * (GAP[1] - GAP[0])) * 1000);
  /** When the last thing happened, and when the next will: drawn once, so a read in between can never put it in the past. */
  let last = roundStart;
  let due = roundStart + gap();
  const listeners = new Set<(e: GameEvent) => void>();

  const emit = (e: GameEvent) => {
    c.events.unshift(e);
    for (const l of listeners) l(e);
  };
  const side = (team: number) => (team === 0 ? "allies" : "axis");

  /** One thing happening at `t`. */
  function happen(t: number) {
    const a = pick(roster);
    const base = { ts: new Date(t).toISOString(), serverId: "s1", actorName: a.p.name, actorPlayerId: a.p.id };
    const roll = rnd();
    if (roll < 0.75) {
      const v = pick(roster.filter((r) => r.team !== a.team));
      a.kills += 1; a.score += 10; v.deaths += 1;
      emit({ ...base, kind: "evt.kill", victimName: v.p.name, victimPlayerId: v.p.id, weapon: pick(WEAPONS), data: { actorSide: side(a.team) } });
    } else if (roll < 0.78) {
      const v = pick(roster.filter((r) => r.team === a.team && r !== a));
      a.teamKills += 1; v.deaths += 1;
      emit({ ...base, kind: "evt.teamkill", victimName: v.p.name, victimPlayerId: v.p.id, weapon: pick(WEAPONS), data: { actorSide: side(a.team) } });
    } else {
      emit({ ...base, kind: rnd() < 0.7 ? "evt.chat.team" : "evt.chat.squad", data: { message: pick(CHAT), actorSide: side(a.team) } });
    }
    // Every quarter of an hour or so a side takes a sector: the middle one while nobody holds it, or
    // else one of the other side's — the harder, the closer that side is pushed back to its own
    // lines. Holding all five wins the round outright (advance); most rounds run the clock.
    if (rnd() < 0.005) {
      const alliesTake = rnd() < 0.5 + (axis - allied) * 0.1;
      if (allied + axis < 5) { if (alliesTake) allied += 1; else axis += 1; } else if (alliesTake) { allied += 1; axis -= 1; } else { axis += 1; allied -= 1; }
    }
  }

  /**
   * The round over at `end` — the capture that won it outright, or its clock running out, even
   * while nobody was looking (a tab left in the background) — and the next one starting at `t`.
   */
  function nextRound(end: number, t: number) {
    const winner = allied > axis ? "allies" : "axis";
    const durationSec = Math.round((end - roundStart) / 1000);
    c.matches.unshift({
      id: `dm${c.matches.length + 1}`, map: mapLabel(), startedAt: new Date(roundStart).toISOString(), endedAt: new Date(end).toISOString(),
      durationSec, result: `${winner === "allies" ? "ALLIED" : "AXIS"} (${allied} - ${axis})`, score: `${allied} - ${axis}`, winner, alliedScore: allied, axisScore: axis,
    });
    emit({ ts: new Date(end).toISOString(), kind: "evt.match.ended", serverId: "s1", actorName: "", actorPlayerId: "", data: { map: ROTATION[map]!.mapName, winner } });
    map = (map + 1) % ROTATION.length;
    roundStart = t;
    allied = 2; axis = 2;
    for (const r of roster) { r.kills = 0; r.deaths = 0; r.teamKills = 0; r.score = 0; }
    emit({ ts: new Date(t).toISOString(), kind: "evt.match.started", serverId: "s1", actorName: "", actorPlayerId: "", data: { map: ROTATION[map]!.mapName } });
  }

  /** Play the round on to `now`: after a long time away, only its last few minutes. */
  function advance(now: number, catchUp = true) {
    if (catchUp && now - due > CATCH_UP_MS) due = now - CATCH_UP_MS;
    while (due <= now) {
      const t = due;
      due = t + gap();
      if (allied === 5 || axis === 5) nextRound(last, t);
      else if (t - roundStart >= ROUND_SEC * 1000) nextRound(roundStart + ROUND_SEC * 1000, t);
      else happen(t);
      last = t;
    }
  }

  /** The rotation as the server reports it, the map being played marked. */
  const rotationNow = () => ({ currentIndex: map, mAPS: ROTATION.map((m) => ({ name: m.mapName, gameMode: "Warfare" })) });
  /** The round's map as the history and the round's own read name it. */
  function mapLabel() { return `${ROTATION[map]!.mapName} Warfare`; }

  // The log's earlier evenings stop where this round starts, and this round is played from its start.
  for (let i = c.events.length - 1; i >= 0; i--) if (c.events[i]!.serverId === "s1" && Date.parse(c.events[i]!.ts) >= roundStart) c.events.splice(i, 1);
  advance(start, false);

  return {
    advance: (now: number) => advance(now),
    /**
     * What the round's own read answers (Live's feed opens on it): the round being played, played on
     * to `now`, and what has happened in it so far, newest first — `kinds` only, when given.
     */
    round(now: number, limit: number, kinds?: string[]) {
      advance(now);
      const startedAt = new Date(roundStart).toISOString();
      const events = c.events.filter((e) => e.serverId === "s1" && e.ts >= startedAt && (!kinds || kinds.includes(e.kind))).slice(0, limit);
      return { events, round: { id: `dm${c.matches.length + 1}`, map: mapLabel(), startedAt }, limit };
    },
    /** Who is playing on the server now, by player id. */
    onServer: () => new Set(roster.map((r) => r.p.id)),
    /** What the rotation read answers (the dashboard's tile): the round played on to `now` first. */
    rotation(now: number) {
      advance(now);
      return rotationNow();
    },
    /** What the live read answers: the server's state, its roster, and what plays next. */
    live(now: number) {
      advance(now);
      return {
        session: {
          playerCount: roster.length, maxPlayerCount: 100, queueCount: 3, maxQueueCount: 6, vipQueueCount: 0, maxVipQueueCount: 2,
          mapId: ROTATION[map]!.mapId, mapName: ROTATION[map]!.mapName, gameMode: "Warfare", alliedScore: allied, axisScore: axis,
          alliedPlayerCount: roster.filter((r) => r.team === 0).length, axisPlayerCount: roster.filter((r) => r.team === 1).length,
          remainingMatchTime: Math.max(0, ROUND_SEC - Math.round((now - roundStart) / 1000)),
        },
        players: roster.map((r) => ({
          id: r.p.id, playerId: r.p.platformId, name: r.p.name, team: r.team, squad: r.squad, role: r.role, level: r.p.level,
          kills: r.kills, deaths: r.deaths, score: r.score, vip: r.p.vip,
          stats: { infantryKills: r.kills, vehicleKills: 0, deaths: r.deaths, teamKills: r.teamKills },
        })),
        mapRotation: rotationNow(),
      };
    },
    /** Hear what happens in the round from now on. Returns how to stop. */
    listen(l: (e: GameEvent) => void): () => void {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
  };
}
