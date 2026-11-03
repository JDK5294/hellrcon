/**
 * Server analytics in the demo (lib/demo/server): the walkthrough stage's own answer, which Help's
 * pictures are taken from, with what the stage leaves out — the crossplay split that By platform
 * draws, and the VIPs held each day. The window's days are shared between the community's two
 * platforms (lib/demo/community) so that they add up to the page's own totals; Steam's players
 * score a little more, Epic's lead squads a little more. The table's figures are the days added up
 * the way the panel adds them, people on the first day the window met them, so each line of the
 * chart ends at its platform's number in the table.
 */

interface Day { date: string; rounds: number; players: number; combat: number; offense: number; defense: number; support: number; slSeconds: number; vehicleKills: number }
export interface StageServerAnalytics {
  scores: { daily: Day[] };
  activity: { daily: { date: string; sessions: number; seconds: number }[]; shortSessions: number };
}

const PLATFORMS = ["steam", "epic"] as const;
/** Epic's share of a day's play. */
const EPIC = 0.21;
/** Players in a round, for the rounds each player played. */
const PER_ROUND = 70;
// Each day, Steam's then Epic's: the people the window met for the first time that day (players,
// the new players among them, VIPs), the VIPs who played, and the bans made.
const FIRST_PLAYERS = [[47, 36, 31, 29, 26], [13, 10, 8, 8, 6]];
const FIRST_NEW = [[14, 13, 12, 12, 11], [4, 4, 4, 3, 3]];
const FIRST_VIPS = [[14, 4, 2, 1, 1], [3, 1, 1, 0, 0]];
const VIPS = [[14, 15, 15, 16, 16], [3, 4, 4, 4, 4]];
const TEMP_BANS = [[0, 1, 0, 2, 0], [1, 0, 0, 0, 0]];
const PERMA_BANS = [[0, 0, 1, 0, 0], [0, 0, 0, 0, 0]];

/** A day's figure shared out, Epic's part `epic` of it: Steam's and Epic's, adding up to it. */
const split = (n: number, epic = EPIC): [number, number] => {
  const e = Math.round(n * epic);
  return [n - e, e];
};
const at = (table: number[][], p: number, i: number) => table[p]?.[i] ?? 0;

/** The stage's answer with the crossplay split and the VIPs each day. */
export function withPlatforms<T extends StageServerAnalytics>(s: T) {
  const days = s.scores.daily;
  const trend = days.flatMap((d, i) => {
    const a = s.activity.daily[i];
    // The window's short sessions, a share of them each day.
    const short = Math.floor(s.activity.shortSessions / days.length) + (i < s.activity.shortSessions % days.length ? 1 : 0);
    const players = split(d.players), sessions = split(a?.sessions ?? 0), playtime = split(a?.seconds ?? 0), shorts = split(short);
    const rounds = split(d.rounds * PER_ROUND), vehicleKills = split(d.vehicleKills);
    const combat = split(d.combat, 0.19), offense = split(d.offense, 0.2), defense = split(d.defense, 0.23), support = split(d.support, 0.22), sl = split(d.slSeconds, 0.27);
    return PLATFORMS.map((platform, p) => {
      const kills = Math.round(rounds[p] * (p ? 2.3 : 2.6));
      return {
        date: d.date, platform,
        players: players[p], newPlayers: at(FIRST_NEW, p, i), sessions: sessions[p], shortSessions: shorts[p], playtimeSec: playtime[p],
        rounds: rounds[p], scoredRounds: rounds[p], kills, deaths: Math.round(kills / (p ? 0.94 : 1.06)), teamkills: Math.round(kills * (p ? 0.02 : 0.015)),
        vehicleKills: vehicleKills[p], combat: combat[p], offense: offense[p], defense: defense[p], support: support[p], slSeconds: sl[p],
        tempBans: at(TEMP_BANS, p, i), permaBans: at(PERMA_BANS, p, i), vips: at(VIPS, p, i),
        firstPlayers: at(FIRST_PLAYERS, p, i), firstNewPlayers: at(FIRST_NEW, p, i), firstVips: at(FIRST_VIPS, p, i),
      };
    });
  });
  const rows = PLATFORMS.map((platform) => {
    const mine = trend.filter((t) => t.platform === platform);
    const total = (k: Exclude<keyof (typeof trend)[number], "date" | "platform">) => mine.reduce((n, t) => n + t[k], 0);
    return {
      platform,
      players: total("firstPlayers"), newPlayers: total("firstNewPlayers"), vips: total("firstVips"),
      sessions: total("sessions"), shortSessions: total("shortSessions"), playtimeSec: total("playtimeSec"),
      rounds: total("rounds"), scoredRounds: total("scoredRounds"), kills: total("kills"), deaths: total("deaths"), teamkills: total("teamkills"),
      vehicleKills: total("vehicleKills"), combat: total("combat"), offense: total("offense"), defense: total("defense"), support: total("support"),
      slSeconds: total("slSeconds"), tempBans: total("tempBans"), permaBans: total("permaBans"),
    };
  });
  const vipDaily = days.map((d, i) => ({ date: d.date, vips: at(VIPS, 0, i) + at(VIPS, 1, i) }));
  return { ...s, platform: { rows }, platformTrend: { rows: trend }, vipDaily };
}
