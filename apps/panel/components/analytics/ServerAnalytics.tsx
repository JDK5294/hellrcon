"use client";
/**
 * Server analytics — "is this community healthy, and when".
 *
 * The three questions this page exists to answer, in the order an owner asks them:
 *   1. WHEN are we busy? (so you know when to schedule an event, or when cover is needed)
 *   2. Are people COMING BACK? (a server with churn and a server with regulars can post the same
 *      headline player count and be in completely different health)
 *   3. Are the matches WORTH PLAYING? (balance belongs here — it's the reason people stay)
 *
 * Reads GET /analytics/server?serverId&days.
 */
import { useCallback } from "react";
import { zoneLabel } from "../../lib/time";
import { platformLabel } from "../../lib/platform";
import { api } from "../../lib/api";
import { useServers } from "../../lib/servers";
import { useGame } from "../../lib/game";
import { oneOf, useRemembered } from "../../lib/remembered";
import { useResource } from "../../lib/resource";
import { PanelGroup, Panel } from "../Panel";
import { ActionResult, NoServersPage, SkeletonLines, Explanation } from "../ui";
import { StatTile, StatGrid, Bars, DateHeatmap, SplitBar, Progression, RESIDUAL_INDEX, type ProgPoint } from "../viz";
import { Time } from "../Time";
import { AnalyticsBar, useAnalyticsRange, rangeQuery, rangeTimeoutMs, counted, dec, dur, hourLabel, hours, num, pct, ReadPending } from "./shared";

interface Daily { date: string; sessions: number; players: number; seconds: number }
interface ScoreDay {
  date: string; rounds: number; players: number;
  combat: number; offense: number; defense: number; support: number;
  slSeconds: number; vehicleKills: number;
}

interface Payload {
  window: { from: string; to: string };
  /** Optional: a server whose rounds predate the roster sampler has no score rows at all. */
  scores?: {
    daily: ScoreDay[];
    totals: {
      rounds: number; players: number;
      combat: number; offense: number; defense: number; support: number;
      slSeconds: number; vehicleKills: number; ledShare: number | null;
    };
  };
  activity: {
    byHour: number[];
    byDow: number[];
    weekHour: number[][];
    daily: Daily[];
    sessions: number;
    uniquePlayers: number;
    totalSeconds: number;
    medianSec: number;
    p90Sec: number;
    shortSessions: number;
    shortCutoffSec: number;
    earlyLeaversByMap: { map: string; sessions: number; short: number }[];
  };
  concurrency: {
    peak: number;
    peakAt: string | null;
    average: number;
    weekHour: number[][];
    /** One row per local date across the whole window; null hours were never sampled. */
    dayHour: { date: string; hours: (number | null)[] }[];
    daily: { date: string; peak: number; average: number }[];
    sampleSec: number;
    openAtEnd: number;
  };
  mix: { newPlayers: number; returningPlayers: number; newPlayersWhoCameBack: number };
  platform?: { rows: PlatformRow[] };
  platformTrend?: { rows: PlatformDay[] };
  /** VIPs on this server per local day, every platform together, every day in the window. */
  vipDaily?: { date: string; vips: number }[];
  balance: {
    rounds: number;
    decided: number;
    alliesWins: number;
    axisWins: number;
    alliesWinRate: number | null;
    avgDurationSec: number | null;
    medianDurationSec: number | null;
    avgMargin: number | null;
    blowoutRate: number | null;
  };
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * One platform's sums as the wire carries them: the window's, or one local day's. Ratios are never
 * on the wire — every metric below derives its value from these sums, so a day's K/D is that day's
 * kills over that day's deaths, exactly as the table derives the window's.
 * Fields newer than the card are optional, so an older API reads as zeroes rather than a crash.
 */
interface PlatformSums {
  players: number; newPlayers?: number; sessions: number; shortSessions?: number; playtimeSec: number;
  rounds: number; kills: number; deaths: number; teamkills?: number; vehicleKills?: number;
  scoredRounds?: number; combat?: number; offense?: number; defense?: number; support?: number; slSeconds?: number;
  tempBans?: number; permaBans?: number;
  /** distinct players who held VIP: over the window, or on that day. */
  vips?: number;
}
type PlatformRow = PlatformSums & { platform: string };
/** A day's sums, and the people the window met for the first time that day: players, new players
 *  and VIPs, each counted once, on their first day. */
type PlatformDay = PlatformSums & { date: string; platform: string; firstPlayers?: number; firstNewPlayers?: number; firstVips?: number };
/** The sums that add across platform codes: merging codes that share a name, and folding the rest
 *  into "Other platforms". One player has one code, so counts of people (players, VIPs) from
 *  different codes add without counting anybody twice. */
const SUM_KEYS = [
  "players", "newPlayers", "sessions", "shortSessions", "playtimeSec", "rounds", "kills", "deaths", "teamkills",
  "vehicleKills", "scoredRounds", "combat", "offense", "defense", "support", "slSeconds", "tempBans", "permaBans", "vips",
] as const;
const n0 = (v: number | undefined) => v ?? 0;
const zeroSums = (): PlatformSums => ({ players: 0, sessions: 0, playtimeSec: 0, rounds: 0, kills: 0, deaths: 0 });
const addSums = (into: PlatformSums, r: PlatformSums) => { for (const k of SUM_KEYS) into[k] = n0(into[k]) + n0(r[k]); };
/** Counts of people, which a running total cannot add up day by day: a regular on ten days is one
 *  player, not ten. They are added from the first-day counts instead. */
const PEOPLE_KEYS = new Set<string>(["players", "newPlayers", "vips"]);
/** One day added to a running total: counts as they are, people on the first day the window met them. */
function addDay(into: PlatformSums, d: PlatformDay): void {
  for (const k of SUM_KEYS) if (!PEOPLE_KEYS.has(k)) into[k] = n0(into[k]) + n0(d[k]);
  into.players += n0(d.firstPlayers);
  into.newPlayers = n0(into.newPlayers) + n0(d.firstNewPlayers);
  into.vips = n0(into.vips) + n0(d.firstVips);
}
/** The calendar date after "YYYY-MM-DD" — arithmetic on the date itself, so no time zone moves it. */
const nextDate = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
/** The name a platform shows under. The game reports some platforms under several codes (PS4 and
 *  PS5, Xbox One and Series); to a reader they are one platform, so rows are merged by name. */
const nameOf = (p: string) => platformLabel(p) || "Unknown";
/** Each platform keeps one colour wherever it ranks, so a line is the same platform on every
 *  server, in every window and for every metric: colour follows the platform, never its place in
 *  the table. In the order they have always come out on a console-heavy server. */
const PLATFORM_COLOR = new Map<string, number>([["Xbox", 0], ["PlayStation", 1], ["Steam (PC)", 2], ["Other", 3], ["MS Store (PC)", 4], ["Epic (PC)", 5], ["Unknown", 6]]);

const PLATFORM_GROUPS = ["Population", "Rounds and kills", "Score", "Moderation and VIP"] as const;

/**
 * Everything the By platform card can show, grouped as its picker groups them. The chart plots the
 * picked metric as a running total from the window's first day, per platform, so every line ends
 * at the platform's number in the table; the table beside it shows the picked metric's group.
 * Day-by-day values drew a spike per ban and a sawtooth per quiet day, and nobody could compare
 * two platforms across a month on them.
 *
 * A ratio with nothing to divide yet answers null — a GAP, because "we have nothing to divide" is
 * a different fact from a K/D of zero. Counts start at 0: zero kills recorded really is zero.
 */
interface PlatformMetric {
  key: string;
  group: (typeof PLATFORM_GROUPS)[number];
  label: string;
  /** One line under the picker: what this counts, from what. */
  hint: string;
  value: (r: PlatformSums) => number | null;
  /** A platform with no row that day: 0 for a count, a gap (null) for a ratio. */
  empty: number | null;
  format: (n: number) => string;
}
const whole = (n: number) => Math.round(n).toLocaleString();
const hoursOf = (n: number) => `${Math.round(n).toLocaleString()}h`;
/** Per player per round the game's score was recorded for: a round imported from a kill log has
 *  none, and dividing by it would read as everyone scoring less. No scored round is a gap. */
const perScoredRound = (pick: (r: PlatformSums) => number | undefined) => (r: PlatformSums) => (n0(r.scoredRounds) > 0 ? n0(pick(r)) / n0(r.scoredRounds) : null);
const PLATFORM_METRICS: PlatformMetric[] = [
  { key: "players", group: "Population", label: "Players", hint: "Different players who joined.", value: (r) => r.players, empty: 0, format: whole },
  { key: "newPlayers", group: "Population", label: "New players", hint: "Players seen for the first time in this window.", value: (r) => n0(r.newPlayers), empty: 0, format: whole },
  { key: "sessions", group: "Population", label: "Sessions", hint: "Every join, each counted once.", value: (r) => r.sessions, empty: 0, format: whole },
  { key: "playtime", group: "Population", label: "Time played", hint: "Hours played, every session added up.", value: (r) => r.playtimeSec / 3600, empty: 0, format: hoursOf },
  { key: "avgSession", group: "Population", label: "Average session", hint: "Time played divided by sessions.", value: (r) => (r.sessions > 0 ? r.playtimeSec / r.sessions / 60 : null), empty: null, format: (n) => `${Math.round(n)}m` },
  { key: "earlyLeavers", group: "Population", label: "Early leavers", hint: "Share of sessions that ended inside five minutes.", value: (r) => (r.sessions > 0 ? (n0(r.shortSessions) / r.sessions) * 100 : null), empty: null, format: (n) => `${Math.round(n)}%` },
  { key: "rounds", group: "Rounds and kills", label: "Rounds", hint: "Finished rounds played, one per player per round.", value: (r) => r.rounds, empty: 0, format: whole },
  { key: "kills", group: "Rounds and kills", label: "Kills", hint: "Kills in finished rounds.", value: (r) => r.kills, empty: 0, format: whole },
  { key: "deaths", group: "Rounds and kills", label: "Deaths", hint: "Deaths in finished rounds.", value: (r) => r.deaths, empty: 0, format: whole },
  { key: "kd", group: "Rounds and kills", label: "K/D", hint: "Kills divided by deaths, from the same rounds.", value: (r) => (r.rounds > 0 ? (r.deaths > 0 ? r.kills / r.deaths : r.kills) : null), empty: null, format: (n) => n.toFixed(2) },
  { key: "kpr", group: "Rounds and kills", label: "Kills / round", hint: "Kills per player per finished round.", value: (r) => (r.rounds > 0 ? r.kills / r.rounds : null), empty: null, format: (n) => n.toFixed(1) },
  { key: "teamkills", group: "Rounds and kills", label: "Team kills", hint: "Team kills in finished rounds.", value: (r) => n0(r.teamkills), empty: 0, format: whole },
  { key: "vehicleKills", group: "Rounds and kills", label: "Vehicle kills", hint: "Vehicle kills in finished rounds, as the game counts them.", value: (r) => n0(r.vehicleKills), empty: 0, format: whole },
  { key: "combat", group: "Score", label: "Combat / round", hint: "The game's combat score, per player per round it was recorded for.", value: perScoredRound((r) => r.combat), empty: null, format: whole },
  { key: "offense", group: "Score", label: "Offense / round", hint: "The game's offense score, per player per round it was recorded for.", value: perScoredRound((r) => r.offense), empty: null, format: whole },
  { key: "defense", group: "Score", label: "Defense / round", hint: "The game's defense score, per player per round it was recorded for.", value: perScoredRound((r) => r.defense), empty: null, format: whole },
  { key: "support", group: "Score", label: "Support / round", hint: "The game's support score, per player per round it was recorded for.", value: perScoredRound((r) => r.support), empty: null, format: whole },
  { key: "sl", group: "Score", label: "Squad-leader time", hint: "Hours spent leading a squad.", value: (r) => n0(r.slSeconds) / 3600, empty: 0, format: hoursOf },
  { key: "tempBans", group: "Moderation and VIP", label: "Temp bans", hint: "Temp bans made in this window that cover this server, by the banned player's platform.", value: (r) => n0(r.tempBans), empty: 0, format: whole },
  { key: "permaBans", group: "Moderation and VIP", label: "Perma bans", hint: "Perma bans made in this window that cover this server, by the banned player's platform.", value: (r) => n0(r.permaBans), empty: 0, format: whole },
  { key: "vips", group: "Moderation and VIP", label: "VIPs", hint: "Players who held VIP on this server in this window, from the VIP history. Grants under an hour, like a crash VIP, are left out.", value: (r) => n0(r.vips), empty: 0, format: whole },
];

/** The game's platform tokens, spelled for people. Unlisted tokens show as themselves — a new
 *  platform must appear on the page the day the game adds it, not vanish into "Unknown". */

/**
 * What the When people play grid can show. Players online is the page's own read; every other one
 * comes from /analytics/server/hours when it is picked, so the page costs what it always did until
 * somebody looks. Each says what an empty grid means in its own words: all zeros is a fact about
 * the server ("nobody queued"), no squares at all is a fact about the record.
 */
const HOUR_GROUPS = ["Population", "Teams and squads", "Game log"] as const;
interface HourView {
  key: string;
  group: (typeof HOUR_GROUPS)[number];
  label: string;
  /** The panel's subtitle while it shows. */
  subtitle: string;
  /** One line under the picker. */
  hint: string;
  /** What the grid's legend and hover count in. */
  unit: string;
  format: (n: number) => string;
  /** Every hour the app has a figure for reads zero. */
  none: string;
  /** Nothing in the window could say at all. */
  unrecorded: string;
  explain: string;
}
const oneDp = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
const SAMPLED = "From the roster the app samples once a minute while it watches the server; an hour it has no samples for has no square.";
const LOGGED = "Counted from the game log by the hour each line was written. Where the app was watching, an empty outlined square is a real zero; an hour it has no record of at all (before it watched the server, or while it was down) has no square.";
const NO_SAMPLES = "No roster samples in this window: the app was not watching this server then.";
const HOUR_VIEWS: HourView[] = [
  { key: "online", group: "Population", label: "Players online", subtitle: "players online at once", hint: "Average players on the server at once.",
    unit: "players online", format: (n) => n.toLocaleString(), none: "Nobody played in this window yet.", unrecorded: "Nobody played in this window yet.", explain: "" },
  { key: "peak", group: "Population", label: "Peak players", subtitle: "the most players on at once", hint: "The most players any minute of the hour showed.",
    unit: "at the peak", format: whole, none: "Nobody played in this window yet.", unrecorded: NO_SAMPLES,
    explain: `The highest count the roster showed at any minute of the hour: the moment the server was fullest, where Players online is the hour's average. ${SAMPLED}` },
  { key: "queue", group: "Population", label: "Queue", subtitle: "players waiting to get in", hint: "Average players waiting in the queue, VIP queue included.",
    unit: "waiting", format: oneDp, none: "Nobody queued in this window.", unrecorded: "No queue recorded in this window. The app records the queue from this update on.",
    explain: "Players waiting to get in, averaged over the hour's roster samples: the queue, plus the VIP queue wherever the game's VIP counter can be a queue at all (some servers report the size of their VIP list there, and that is left out). The app records the queue from this update on, so hours before it have no square, and neither do hours it was not watching." },
  { key: "arrivals", group: "Population", label: "Arrivals", subtitle: "players joining", hint: "Visits that began in each hour, each counted once.",
    unit: "arrivals", format: whole, none: "No visits began in this window.", unrecorded: "No sessions recorded in this window.",
    explain: "Visits that began in each hour, each counted once: the date-by-date version of the Arrivals by hour of day chart below. A visit still going is counted once it ends. Where the app was watching, an empty outlined square is a real zero; an hour it has no record of at all has no square." },
  { key: "imbalance", group: "Teams and squads", label: "Team imbalance", subtitle: "the gap between the two sides", hint: "Average gap in players between the two sides.",
    unit: "players apart", format: oneDp, none: "The sides were always even in this window.", unrecorded: NO_SAMPLES,
    explain: `How many players apart the two sides were, averaged over the hour's roster samples; 0 is even sides. ${SAMPLED}` },
  { key: "noLeader", group: "Teams and squads", label: "Leaderless squads", subtitle: "squads with no squad leader", hint: "Average squads with nobody in a squad-leader role, both sides together.",
    unit: "leaderless squads", format: oneDp, none: "No squad went without a leader in this window.", unrecorded: NO_SAMPLES,
    explain: `Squads with nobody in a squad-leader role, both sides together, averaged over the hour's roster samples. A squad holding a role the game does not name counts as led, so no special squad is flagged by mistake. ${SAMPLED}` },
  { key: "unsquadded", group: "Teams and squads", label: "Players outside a squad", subtitle: "players in no squad", hint: "Average players on a side but in no squad.",
    unit: "outside a squad", format: oneDp, none: "Everyone on a side was in a squad in this window.", unrecorded: NO_SAMPLES,
    explain: `Players on a side but in no squad, both sides together, averaged over the hour's roster samples. Players between sides (joining, or mid-switch) are not counted. ${SAMPLED}` },
  { key: "kills", group: "Game log", label: "Kills", subtitle: "kills", hint: "Kills the game logged in each hour.",
    unit: "kills", format: whole, none: "No kills logged in this window.", unrecorded: "Nothing logged in this window.", explain: LOGGED },
  { key: "teamkills", group: "Game log", label: "Team kills", subtitle: "team kills", hint: "Team kills the game logged in each hour.",
    unit: "team kills", format: whole, none: "No team kills logged in this window.", unrecorded: "Nothing logged in this window.", explain: LOGGED },
  { key: "chat", group: "Game log", label: "Chat messages", subtitle: "chat", hint: "Team and squad chat lines.",
    unit: "messages", format: whole, none: "No chat logged in this window.", unrecorded: "Nothing logged in this window.", explain: LOGGED },
  { key: "moderation", group: "Game log", label: "Kicks and bans", subtitle: "kicks and bans", hint: "From any admin tool, plus the game's own idle and team-kill kicks.",
    unit: "kicks and bans", format: whole, none: "No kicks or bans logged in this window.", unrecorded: "Nothing logged in this window.",
    explain: `Kicks and bans the game logged, whichever admin tool made them, plus the game's own kicks for idling or team killing. ${LOGGED}` },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The grid's own numbers as one line through the window: every hour in date order, each point the
 * figure its square shows. An hour with no square is a gap in the line, never a zero, and the
 * window's ragged ends (the hours before it opens and after it closes) are trimmed off.
 */
function hourLine(rows: { date: string; hours: (number | null)[] }[]): ProgPoint[] {
  const points = rows.flatMap((r) => {
    const [, m, d] = r.date.split("-").map(Number);
    return r.hours.map((v, h) => {
      const hh = String(h).padStart(2, "0");
      return { x: `${r.date} ${hh}`, label: `${MONTHS[(m ?? 1) - 1]} ${d} ${hh}:00`, values: { v } };
    });
  });
  let first = 0, end = points.length;
  while (first < end && points[first]!.values.v === null) first++;
  while (end > first && points[end - 1]!.values.v === null) end--;
  return points.slice(first, end);
}

/** When people play's figures, drawn the way its switch says: the date × hour heatmap, or the same
 *  numbers as a line over time. */
function HourChart({ rows, view, label, format, empty }: {
  rows: { date: string; hours: (number | null)[] }[];
  view: "heatmap" | "line";
  label: string;
  format?: (n: number) => string;
  empty: string;
}) {
  if (view === "heatmap") return <DateHeatmap rows={rows} label={label} format={format} empty={empty} />;
  const points = hourLine(rows);
  // The heatmap's own test for "nothing to show", so switching never turns an empty grid into a flat line.
  if (!points.some((pt) => (pt.values.v ?? 0) > 0)) return <p className="nothing">{empty}</p>;
  return <Progression points={points} series={[{ key: "v", label, colorIndex: 0 }]} format={format} windows={[]} />;
}

// The charts picked are kept for the sitting, as long as the page still offers them.
const isPlatformMetric = (v: unknown): v is string => typeof v === "string" && PLATFORM_METRICS.some((m) => m.key === v);
const isHourMetric = (v: unknown): v is string => typeof v === "string" && HOUR_VIEWS.some((h) => h.key === v);

export default function ServerAnalytics() {
  const { serverId, servers } = useServers();
  // The sides in the server's game's words: US and NVA on Vietnam.
  const game = useGame();
  const allies = game.sideName("allies"), axis = game.sideName("axis");
  const [range, setRange] = useAnalyticsRange("server");
  // Which metric the By platform card shows. The picker or a column heading switches it.
  const [platMetric, setPlatMetric] = useRemembered("analytics.server.platformMetric", "players", isPlatformMetric, "session");
  const load = useCallback(
    () => api<Payload>(`/analytics/server?serverId=${encodeURIComponent(serverId)}&${rangeQuery(range)}`, { timeoutMs: rangeTimeoutMs(range) }),
    [serverId, range],
  );
  const { data, error, reload } = useResource(serverId ? load : null);
  // What the When people play grid shows; anything but players online is its own read.
  const [hourMetric, setHourMetric] = useRemembered("analytics.server.hourMetric", "online", isHourMetric, "session");
  // How When people play draws it: the heatmap, or the same numbers as a line graph.
  const [whenView, setWhenView] = useRemembered<"heatmap" | "line">("analytics.server.whenView", "heatmap", oneOf(["heatmap", "line"] as const), "session");
  const hourView = HOUR_VIEWS.find((m) => m.key === hourMetric) ?? HOUR_VIEWS[0]!;
  const loadHours = useCallback(
    () => api<{ metric: string; rows: { date: string; hours: (number | null)[] }[] }>(
      `/analytics/server/hours?serverId=${encodeURIComponent(serverId)}&${rangeQuery(range)}&metric=${encodeURIComponent(hourMetric)}`,
      { timeoutMs: rangeTimeoutMs(range) },
    ),
    [serverId, range, hourMetric],
  );
  const hourGrid = useResource(serverId && hourMetric !== "online" ? loadHours : null);
  // Only ever the picked metric's rows, never the last one's under the new label.
  const hourRows = hourGrid.data && hourGrid.data.metric === hourView.key ? hourGrid.data.rows : null;

  if (!servers.length) return <NoServersPage routeId="analytics.server">Population and balance figures are measured from a connected server as it is played.</NoServersPage>;
  if (!serverId) return <div className="card"><p className="muted">Select a server to see its analytics.</p></div>;

  const a = data?.activity;
  const con = data?.concurrency;
  const sc = data?.scores;
  // What share of the score came from playing the objective rather than fighting over it. The
  // denominator is all four buckets, so this is a proportion and cannot exceed 1.
  const scoreTotal = sc ? sc.totals.combat + sc.totals.offense + sc.totals.defense + sc.totals.support : 0;
  const objectiveShare = scoreTotal > 0 ? (sc!.totals.offense + sc!.totals.defense + sc!.totals.support) / scoreTotal : null;
  const mix = data?.mix;
  const bal = data?.balance;
  // Retention as a share of the newcomers themselves: "of the people who found us this month, how
  // many were still here the next day". A share of ALL players would move whenever the server got
  // busier, which is not what the number is for.
  const stickRate = mix && mix.newPlayers ? mix.newPlayersWhoCameBack / mix.newPlayers : null;
  // "Busiest" now means busiest by PLAYERS ONLINE, not by arrivals — the whole point of the
  // concurrency work. Read straight off the occupancy grid rather than the session-start buckets.
  const busiest = (con?.weekHour ?? []).reduce(
    (best, row, d) => row.reduce((b, v, h) => (v > b.v ? { v, d, h } : b), best),
    { v: -1, d: -1, h: -1 },
  );

  return (
    <PanelGroup viewId="analytics.server">
      <Panel id="overview" caps="open" title="Overview" subtitle="the window at a glance">
        <AnalyticsBar
          range={range}
          onRange={setRange}
          shown={(data as { window?: { from: string; to: string } } | null | undefined)?.window}
          onRefresh={() => { reload(); hourGrid.reload(); }}
          scope={data ? `${counted(a?.sessions, "session")} from ${counted(a?.uniquePlayers, "player")}` : null}
        />
        <ActionResult error={error} />
        {!data ? <ReadPending error={error} said><SkeletonLines lines={3} /></ReadPending> : (
          <StatGrid>
            <StatTile label="Unique players" value={num(a?.uniquePlayers)} sub={`${num(a?.sessions)} sessions`} accent />
            <StatTile label="Time played" value={hours(a?.totalSeconds)} sub="all players combined" />
            <StatTile label="Median session" value={dur(a?.medianSec)} sub={`90th percentile ${dur(a?.p90Sec)}`} />
            <StatTile
              label="Peak concurrent"
              value={num(con?.peak)}
              sub={con?.peakAt ? <>at once, on <Time iso={con.peakAt} /></> : "nobody played in this window"}
              accent
            />
            <StatTile
              label="Average concurrent"
              value={dec(con?.average, 1)}
              sub={busiest.v > 0 ? `busiest ${DOW[busiest.d]} ${hourLabel(busiest.h)}:00 ${zoneLabel()}` : "players online at any moment"}
            />
            <StatTile label="Rounds played" value={num(bal?.rounds)} sub={`${num(bal?.decided)} decided`} />
            <StatTile label="New players" value={num(mix?.newPlayers)} sub={`${num(mix?.returningPlayers)} returning`} />
          </StatGrid>
        )}
      </Panel>

      <Panel id="when" caps="open" title="When people play" subtitle={`${hourView.subtitle}, every date in the window`}>
        {!data ? <ReadPending error={error}><SkeletonLines lines={4} /></ReadPending> : (
          <>
            <div className="row" style={{ gap: 10, alignItems: "baseline", flexWrap: "wrap", marginBottom: 4 }}>
              <label className="muted fs-sm">Show{" "}
                <select value={hourView.key} onChange={(e) => setHourMetric(e.target.value)} aria-label="What the grid shows">
                  {HOUR_GROUPS.map((g) => (
                    <optgroup key={g} label={g}>
                      {HOUR_VIEWS.filter((m) => m.group === g).map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                    </optgroup>
                  ))}
                </select>
              </label>
              <div className="seg" role="group" aria-label="Chart type">
                {([["heatmap", "Heatmap"], ["line", "Line graph"]] as const).map(([id, text]) => (
                  <button key={id} type="button" className={`seg-btn ${whenView === id ? "active" : ""}`} aria-pressed={whenView === id} onClick={() => setWhenView(id)}>{text}</button>
                ))}
              </div>
              <span className="muted fs-sm">{hourView.hint}</span>
            </div>
            {hourView.key === "online" ? (
              <>
                <Explanation>
                  Average players online AT ONCE in each hour ({zoneLabel()}) across the whole selected
                  window: one row per date, newest first, on the heatmap; one point per hour on the line
                  graph. Overlapping sessions, not arrivals — a hundred
                  people who each drop in for ten minutes across an evening is a hundred joins and never
                  more than a handful on the server. Where the app was watching, these are the live
                  roster&apos;s own counts (sampled every {Math.round((con?.sampleSec ?? 300) / 60)} minutes);
                  history from before that is reconstructed from session records and can never claim
                  more than the server holds.
                </Explanation>
                <HourChart rows={con?.dayHour ?? []} view={whenView} label="players online" empty="Nobody played in this window yet." />
              </>
            ) : (
              <>
                <Explanation>{hourView.explain} Hours are {zoneLabel()}: the heatmap has one row per date across the whole selected window, newest first, and the line graph one point per hour.</Explanation>
                {hourGrid.error ? <ActionResult error={hourGrid.error} />
                  : !hourRows ? <SkeletonLines lines={4} />
                  : (
                    <HourChart
                      rows={hourRows} view={whenView} label={hourView.unit} format={hourView.format}
                      empty={hourRows.some((r) => r.hours.some((v) => v !== null)) ? hourView.none : hourView.unrecorded}
                    />
                  )}
              </>
            )}
            <h4 className="an-h">Arrivals by hour of day</h4>
            <Explanation>
              When people SHOW UP, which is a different question — it drives when to schedule an event
              or a seed, where the grid above drives when you need cover.
            </Explanation>
            <Bars
              data={(a?.byHour ?? []).map((v, h) => ({ label: hourLabel(h), value: v, hint: `${hourLabel(h)}:00–${hourLabel((h + 1) % 24)}:00 ${zoneLabel()}` }))}
              colorIndex={0}
              empty="No sessions recorded in this window."
            />
            <h4 className="an-h">By day of week</h4>
            <Bars
              data={(a?.byDow ?? []).map((v, d) => ({ label: DOW[d] ?? String(d), value: v }))}
              colorIndex={1}
              empty="No sessions recorded in this window."
            />
          </>
        )}
      </Panel>

      <Panel id="platforms" caps="open" title="By platform" subtitle="the crossplay split — pick any metric to compare platforms">
        {!data ? <ReadPending error={error}><SkeletonLines lines={3} /></ReadPending> : (() => {
          // One row per platform NAME: PS4 and PS5 are one PlayStation to a reader, and two
          // "PlayStation" rows in one table said nothing.
          const merged = new Map<string, PlatformRow>();
          for (const r of data?.platform?.rows ?? []) {
            const name = nameOf(r.platform);
            const row = merged.get(name) ?? { platform: name, ...zeroSums() };
            addSums(row, r);
            merged.set(name, row);
          }
          const rows = [...merged.values()].sort((a, b) => b.players - a.players || b.kills - a.kills || a.platform.localeCompare(b.platform));
          if (!rows.length) return <p className="muted">No sessions recorded in this window.</p>;
          const metric = PLATFORM_METRICS.find((m) => m.key === platMetric) ?? PLATFORM_METRICS[0]!;
          // One line per platform, in the table's order, each in its own colour. A code the page
          // has no name for folds into one neutral line rather than minting colours past the palette.
          const top = rows.map((r) => r.platform).filter((p) => PLATFORM_COLOR.has(p));
          const fold = rows.length > top.length;
          const series = [
            ...top.map((p) => ({ key: p, label: p, colorIndex: PLATFORM_COLOR.get(p)! })),
            ...(fold ? [{ key: "__rest", label: "Other platforms", colorIndex: RESIDUAL_INDEX }] : []),
          ];
          const lineOf = (code: string) => (top.includes(nameOf(code)) ? nameOf(code) : "__rest");
          // The picked metric first, then the rest of its group: on a phone the table scrolls
          // sideways, and the column you asked for has to be the one in view.
          const columns = [metric, ...PLATFORM_METRICS.filter((m) => m.group === metric.group && m.key !== metric.key)];
          const tr = data?.platformTrend?.rows ?? [];
          const byDate = new Map<string, PlatformDay[]>();
          for (const t of tr) {
            const list = byDate.get(t.date) ?? [];
            list.push(t);
            byDate.set(t.date, list);
          }
          // Every day of the window, so a running total runs flat across a quiet day rather than
          // ramping over it. The VIP count lists every day; without it, the days the trend spans.
          const known = [...(data?.vipDaily ?? []).map((d) => d.date), ...byDate.keys()].sort();
          const dates: string[] = [];
          if (known.length) for (let d = known[0]!; d <= known[known.length - 1]!; d = nextDate(d)) dates.push(d);
          // Running sums per line, read through the metric each day: a count is the total so far,
          // a ratio is everything so far divided (the folded remainder's too, never an average of
          // ratios), and each line's last point is its platform's number in the table.
          const running = new Map<string, PlatformSums>();
          const points = dates.map((date) => {
            for (const t of byDate.get(date) ?? []) {
              const sums = running.get(lineOf(t.platform)) ?? zeroSums();
              addDay(sums, t);
              running.set(lineOf(t.platform), sums);
            }
            const values: Record<string, number | null> = {};
            for (const sr of series) {
              const sums = running.get(sr.key);
              values[sr.key] = sums ? metric.value(sums) : metric.empty;
            }
            return { x: date, values };
          });
          const chart = points.length ? (
            <>
              <p className="muted fs-sm" style={{ margin: "2px 0 6px" }}>
                {metric.empty === null
                  ? `Each day shows the ${metric.label} of everything so far in this window, so every line ends at its number in the table.`
                  : "Each day shows the total so far in this window, so every line ends at its number in the table."}
              </p>
              <Progression points={points} series={series} format={metric.format} />
              {metric.empty === null && (
                <Explanation>
                  A line that starts late means that platform had nothing to divide until then, which is
                  not the same as a {metric.label} of zero.
                </Explanation>
              )}
            </>
          ) : null;
          return (
            <>
              <Explanation>
                The chart adds up as the window goes: each day is the total so far, so every line climbs
                to its platform&apos;s number in the table and two platforms can be compared at any point
                along the way. Players, new players and VIPs are added on the first day each person shows
                up, so a regular counts once, not once a day. A ratio like K/D is worked out from
                everything so far. Every player row carries the platform the game reports; codes that are
                one platform to a reader (PS4 and PS5, Xbox One and Series) are shown together. Players,
                sessions and time come from sessions that started in this window; rounds, kills and the
                game&apos;s score from finished rounds that started in it; a score per round counts only
                the rounds the score was recorded for, since a round imported from a kill log has none.
                Bans are the decisions made in this window whose rule covers this server, counted under
                the banned player&apos;s platform. VIPs are the players who held VIP on this server in
                this window, rebuilt from the VIP history the app has recorded; grants under an hour,
                like a crash VIP, are left out, even several in a row.
              </Explanation>
              <div className="row" style={{ gap: 10, alignItems: "baseline", flexWrap: "wrap", marginBottom: 4 }}>
                <label className="muted fs-sm">Show{" "}
                  <select value={metric.key} onChange={(e) => setPlatMetric(e.target.value)} aria-label="Metric to compare by platform">
                    {PLATFORM_GROUPS.map((g) => (
                      <optgroup key={g} label={g}>
                        {PLATFORM_METRICS.filter((m) => m.group === g).map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <span className="muted fs-sm">{metric.hint}</span>
              </div>
              {chart}
              <div className="scroll-x">
                <table>
                  <thead><tr>
                    <th>Platform</th>
                    {/* A heading is the same choice as the picker: clicking one shows that metric. */}
                    {columns.map((m) => (
                      <th key={m.key} onClick={() => setPlatMetric(m.key)} title={`Chart ${m.label}`}
                          style={{ cursor: "pointer", textDecoration: m.key === metric.key ? "underline" : undefined }}>
                        {m.label}
                      </th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.platform}>
                        <td>{r.platform}</td>
                        {columns.map((m) => {
                          const v = m.value(r);
                          return <td key={m.key}>{v === null ? "—" : m.format(v)}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          );
        })()}
      </Panel>

      <Panel id="trend" caps="open" title="Daily trend" subtitle="players and sessions per day">
        {!data ? <ReadPending error={error}><SkeletonLines lines={4} /></ReadPending> : (
          (a?.daily?.length ?? 0) === 0
            ? <p className="nothing">No days with activity in this window yet.</p>
            : (
              <Progression
                points={(a?.daily ?? []).map((d) => ({
                  // No `label`: the axis then draws the compact MM-DD, and the full date is still
                  // in `x` for the tooltip. A full date per tick is the widest string available
                  // and the first thing to collide.
                  x: d.date,
                  values: {
                    players: d.players,
                    sessions: d.sessions,
                  },
                }))}
                series={[
                  { key: "players", label: "Distinct players", colorIndex: 1 },
                  { key: "sessions", label: "Sessions", colorIndex: 2 },
                ]}
              />
            )
        )}
        {/* Peak online used to share the axis above — and the game caps a server at a hundred
            slots, so beside sessions in the thousands the peak line was pressed flat against the
            baseline: a series that could not move whatever the server did. Different scale,
            different chart — the same rule that keeps hours played below off a second y-axis
            (a dual axis lets whoever drew it decide which line looks higher). Peak keeps its
            colour from the old chart: colour follows the entity. */}
        {data && (con?.daily?.length ?? 0) > 0 && (
          <>
            <h4 className="an-h">Peak online at once, per day</h4>
            <Explanation>
              On its own scale, because the server only holds so many slots — measured against the
              thousands of sessions above, a full house read as a flat line at zero.
            </Explanation>
            <Bars
              data={(con?.daily ?? []).map((d) => ({ label: d.date.slice(5), value: d.peak, hint: `${d.date} — highest sample that day` }))}
              colorIndex={0}
            />
          </>
        )}
        {/* Its own chart: VIPs are a count of people holding something, not of play, and a few dozen
            VIPs beside thousands of sessions would read as a flat line. */}
        {data && (data.vipDaily ?? []).some((d) => d.vips > 0) && (
          <>
            <h4 className="an-h">VIPs per day</h4>
            <Explanation>
              Players who held VIP on this server at some point that day, rebuilt from the VIP history
              the app has recorded. Grants under an hour, like a crash VIP, are left out, even several
              in a row. By platform shows the same count split by platform.
            </Explanation>
            <Bars
              data={(data.vipDaily ?? []).map((d) => ({ label: d.date.slice(5), value: d.vips, hint: d.date }))}
              colorIndex={4}
            />
          </>
        )}
        {data && (a?.daily?.length ?? 0) > 0 && (
          <>
            <h4 className="an-h">Hours played per day</h4>
            <Bars
              data={(a?.daily ?? []).map((d) => ({ label: d.date.slice(5), value: Math.round(d.seconds / 3600), hint: d.date }))}
              colorIndex={2}
              format={(n) => `${n.toLocaleString()}h`}
            />
          </>
        )}
      </Panel>

      <Panel id="retention" caps="open" title="New vs returning" subtitle="who is showing up, and whether they stay">
        {!data ? <ReadPending error={error}><SkeletonLines lines={3} /></ReadPending> : (
          <>
            <SplitBar
              slices={[
                { key: "returning", label: "Returning players", value: mix?.returningPlayers ?? 0, colorIndex: 0 },
                { key: "new", label: "New players", value: mix?.newPlayers ?? 0, colorIndex: 1 },
              ]}
              empty="Nobody played in this window."
            />
            <StatGrid>
              <StatTile label="Came back" value={num(mix?.newPlayersWhoCameBack)} sub="newcomers seen again after day one" />
              <StatTile
                label="Stick rate"
                value={pct(stickRate)}
                sub={mix?.newPlayers ? `of ${num(mix.newPlayers)} newcomers` : "no newcomers yet"}
                accent
              />
            </StatGrid>
            <Explanation>
              A newcomer counts as stuck when we see them more than a day after their first sighting. It
              is the only retention number this data honestly supports — anything finer would be
              guessing at intent from connection logs.
            </Explanation>
          </>
        )}
      </Panel>

      <Panel id="earlyleavers" caps="open" title="People who joined and left" subtitle="the vote nobody casts out loud">
        {!data ? <ReadPending error={error}><SkeletonLines lines={3} /></ReadPending> : (
          <>
            <StatGrid>
              <StatTile
                label="Early leavers"
                value={pct(a && a.sessions ? a.shortSessions / a.sessions : null)}
                sub={`${num(a?.shortSessions)} of ${num(a?.sessions)} sessions ended inside ${Math.round((a?.shortCutoffSec ?? 300) / 60)} minutes`}
                accent
              />
            </StatGrid>
            <Explanation>
              Someone who connects, sees what is running, and quits within a few minutes is telling you
              something no win rate captures — a map can hold a perfectly even record while quietly
              emptying the server. Each session is counted against the map that was running when they
              JOINED.
            </Explanation>
            {(a?.earlyLeaversByMap?.length ?? 0) === 0
              ? <p className="nothing">No sessions could be attributed to a recorded round in this window.</p>
              : (
                <>
                  <h4 className="an-h">Leave rate by map</h4>
                  <Bars
                    data={(a?.earlyLeaversByMap ?? [])
                      .filter((m) => m.sessions >= 20)
                      .map((m) => ({
                        label: m.map,
                        value: Math.round((m.short / m.sessions) * 1000) / 10,
                        hint: `${m.short} of ${m.sessions} joins left early`,
                      }))}
                    colorIndex={3}
                    format={(n) => `${n}%`}
                    empty="No map has 20 joins in this window yet."
                  />
                  <Explanation>
                    Maps with fewer than 20 joins in the window are left out — a 100% leave rate over
                    two joins is two people, not a problem with the map.
                  </Explanation>
                </>
              )}
          </>
        )}
      </Panel>

      {/*
        Population answers "is the server busy". This answers "is it being PLAYED" — the game's own
        score buckets, which the roster sampler has been recording all along and nothing displayed.
        A server can be full every night and still be a deathmatch; that is a thing an owner wants
        to know, and it is the difference between these two panels.
      */}
      <Panel id="play" caps="open" title="How the game is being played" subtitle="the score the game itself keeps, not the kill log">
        {!data ? <ReadPending error={error}><SkeletonLines lines={4} /></ReadPending> : sc && sc.totals.rounds > 0 ? (
          <>
            <StatGrid>
              <StatTile label="Rounds scored" value={num(sc.totals.rounds)} sub={counted(sc.totals.players, "player")} />
              <StatTile label="Squad-leader time" value={hours(sc.totals.slSeconds)} accent
                sub={sc.totals.ledShare === null ? undefined : `${pct(sc.totals.ledShare)} of players led at some point`} />
              <StatTile label="Vehicle kills" value={num(sc.totals.vehicleKills)} />
              <StatTile label="Objective vs combat" value={pct(objectiveShare)}
                sub="offense + defense + support, as a share of all score" />
            </StatGrid>

            {/* One bar cut into four: the whole IS the point here, and comparing lengths beats
                comparing four numbers. Every segment is named with its share in the legend. */}
            <h4 className="an-h">Where the score comes from</h4>
            <SplitBar slices={[
              { key: "combat", label: "Combat", value: sc.totals.combat, colorIndex: 5 },
              { key: "offense", label: "Offense", value: sc.totals.offense, colorIndex: 2 },
              { key: "defense", label: "Defense", value: sc.totals.defense, colorIndex: 0 },
              { key: "support", label: "Support", value: sc.totals.support, colorIndex: 3 },
            ]} />

            {/* Shares, not totals: absolute score just tracks how many people were on, so a busy
                Saturday would dwarf everything and say nothing about how the game changed. Shares
                put all four on one axis, which is the only way four series belong on one chart. */}
            {sc.daily.length > 1 && (
              <>
                <h4 className="an-h">…and how that changed</h4>
                <Progression
                  format={(n) => `${n}%`}
                  points={sc.daily.map((d) => {
                    const total = d.combat + d.offense + d.defense + d.support;
                    const share = (v: number) => (total > 0 ? Math.round((v / total) * 100) : 0);
                    return {
                      x: d.date,
                      values: {
                        combat: share(d.combat), offense: share(d.offense),
                        defense: share(d.defense), support: share(d.support),
                      },
                    };
                  })}
                  series={[
                    { key: "combat", label: "Combat", colorIndex: 5 },
                    { key: "offense", label: "Offense", colorIndex: 2 },
                    { key: "defense", label: "Defense", colorIndex: 0 },
                    { key: "support", label: "Support", colorIndex: 3 },
                  ]}
                />
              </>
            )}

            {/* Hours, not a share — a different unit, so its own chart rather than a second y-axis. */}
            {sc.daily.some((d) => d.slSeconds > 0) && (
              <>
                <h4 className="an-h">Squad-leader time per day</h4>
                <Bars
                  data={sc.daily.map((d) => ({ label: d.date.slice(5), value: Math.round(d.slSeconds / 3600), hint: d.date }))}
                  colorIndex={1}
                  format={(n) => `${n.toLocaleString()}h`}
                />
                <Explanation>
                  Squads without a leader are the thing the no-leader rule in Auto settings exists for. A run of
                  thin days here is the signal to turn it on, or to raise what it does about it.
                </Explanation>
              </>
            )}
          </>
        ) : (
          <p className="nothing">
            No scored rounds in this window yet. These figures come from the roster sampler reading the
            game&apos;s own scoreboard every minute, so they start once the panel has watched a full round —
            rounds imported from a kill log carry kills but no score.
          </p>
        )}
      </Panel>

      <Panel id="balance" caps="open" title="Are matches worth playing" subtitle="balance, from the rounds in this window">
        {!data ? <ReadPending error={error}><SkeletonLines lines={3} /></ReadPending> : (
          bal && bal.rounds === 0
            ? <p className="nothing">No finished rounds in this window.</p>
            : (
              <>
                <StatGrid>
                  <StatTile
                    label={`${allies} win rate`}
                    value={pct(bal?.alliesWinRate)}
                    sub={`${num(bal?.alliesWins)}–${num(bal?.axisWins)} over ${num(bal?.decided)} decided`}
                    accent
                  />
                  <StatTile label="Blowouts" value={pct(bal?.blowoutRate)} sub="rounds that ended at the maximum score gap" />
                  <StatTile label="Average margin" value={bal?.avgMargin == null ? "—" : bal.avgMargin.toFixed(2)} sub="score gap at the end" />
                  <StatTile label="Round length" value={dur(bal?.medianDurationSec)} sub={`mean ${dur(bal?.avgDurationSec)}`} />
                </StatGrid>
                <SplitBar
                  slices={[
                    { key: "allies", label: `${allies} wins`, value: bal?.alliesWins ?? 0, colorIndex: 0 },
                    { key: "axis", label: `${axis} wins`, value: bal?.axisWins ?? 0, colorIndex: 1 },
                  ]}
                  empty="No decided rounds yet."
                />
                <Explanation>
                  50% is balanced. A win rate that sits well away from it, on a healthy number of rounds,
                  usually means a map pool or a rotation problem — the Matches page breaks it down per map.
                </Explanation>
              </>
            )
        )}
      </Panel>
    </PanelGroup>
  );
}
