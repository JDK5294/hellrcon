"use client";
/**
 * The public stats site — what a PLAYER sees, with no login and no panel shell.
 *
 * Served at /stats (the API's static handler falls /stats/* back to this entry), and fed entirely
 * by the CRCON-compatible public endpoints the same base URL serves to streamer tools:
 * /stats/<slug>/api/get_public_info, get_live_game_stats, get_scoreboard_maps,
 * get_map_scoreboard — plus one manifest (/api/public/servers) naming the published servers and,
 * crucially, HOW to read each one: side labels/colours and score-bucket columns come from the
 * game descriptor via the manifest, so this file hardcodes no faction and no column set. A
 * Vietnam server renders US/NVA and a WW2 server Allies/Axis from the same code — the page eats
 * the same food the overlay tools do, which keeps the CRCON surface honest by dogfooding.
 *
 * Routing is path-based (/stats/<slug>/games/<id>) with pushState — these are links people paste
 * in Discord, so they must be real URLs, not hash fragments.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { mapImageUrl } from "../../lib/gameAssets";
import { platformLabel } from "../../lib/platform";
import { readPublicTheme, savePublicTheme, type PublicThemeMode } from "../../lib/publicTheme";
import { EVENT_TAG, eventKindLabel, teamSwitchText } from "../../lib/eventKinds";
import { fileStem, type Sheet } from "../../lib/download";
import { levelClass } from "../../lib/colors";
import { Bars, KillRace, Progression, SplitBar, SideSplit, PlayerRoundCharts, StatGrid, StatTile, type Bar, type ProgPoint, type ScoreTuple, type TimelineTuple } from "../viz";
import { Icon } from "../icons";
import { ApisPanel, type PublicApi } from "./ApisPanel";
import { onDemand } from "../../lib/onDemand";

// The download popup brings the panel's dialog and the file writers with it — weight most visitors
// never use, so it loads with the game log rather than with the page.
const DownloadButton = onDemand(() => import("../Download"), "DownloadButton",
  () => <button type="button" className="mini ghost" disabled>Download</button>);
import { isCount, isText, isTextOrNull, useRemembered } from "../../lib/remembered";

// --- Manifest + envelope plumbing -----------------------------------------------------------

interface PublicSide { id: string; label: string; color: string }
interface PublicServer {
  slug: string;
  name: string;
  game: string;
  /** whether this server publishes platform ids — what makes scoreboard names into career links. */
  playerIds: boolean;
  sides: PublicSide[];
  scoreFields: { key: string; label: string; title: string }[];
  squadLabel: string;
}

/**
 * Which base this page is mounted under. On the panel host it lives at /stats/...; on a
 * dedicated public hostname the server folds bare paths under /stats itself, so the browser's
 * URLs (and therefore every link and fetch the page makes) drop the prefix: stats.example.com/nam.
 */
const BASE = typeof window !== "undefined" && (window.location.pathname === "/stats" || window.location.pathname.startsWith("/stats/"))
  ? "/stats"
  : "";

/** A page path under whichever base this page runs at. */
const at = (p: string) => `${BASE}/${p}`;
const HOME = BASE || "/";

/**
 * Run `load` every `ms` while the page can be seen, and once more the moment it can again.
 *
 * The site's live screens re-read the game every 15 to 60 seconds, and nothing told them the tab
 * was hidden: a player who left the stats page open behind the game all evening kept the live
 * scoreboard, the header and the report asking all evening, for a page nobody was looking at —
 * one more steady load on the server per tab left open. The panel's own polls have always
 * stopped in a hidden tab (lib/resource.ts); the public site now does the same.
 */
function pollWhileVisible(load: () => void, ms: number): () => void {
  let missed = false;
  const t = setInterval(() => {
    if (document.hidden) { missed = true; return; }
    load();
  }, ms);
  const onVisible = () => {
    if (!document.hidden && missed) { missed = false; load(); }
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVisible); };
}

/** A count in words: "1 round", "12 rounds" — never "1 rounds". */
const counted = (n: number, noun: string): string => `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;

/** CRCON's response wrapper: a 200 does not mean success — `failed` does. And an answer that is no
 *  wrapper at all (the API's own error, from a fault before the command ran) is a failure too: it
 *  carries no result, and the past games waited on one at "Loading…" for as long as it lasted. */
async function crcon<T>(slug: string, command: string, query = ""): Promise<T> {
  const res = await fetch(`${BASE}/${encodeURIComponent(slug)}/api/${command}${query}`);
  const body = (await res.json().catch(() => null)) as { result?: T; failed?: boolean; error?: unknown } | null;
  if (!body || body.failed || body.result === undefined) throw new Error(String(body?.error ?? `could not load ${command}`));
  return body.result as T;
}

interface PublicInfo {
  current_map: { map: { id?: string; pretty_name?: string } | null; start: number | null };
  player_count: number;
  max_player_count: number;
  player_count_by_team: { allied: number; axis: number };
  score: { allied: number; axis: number };
  time_remaining: number;
  name: { name: string; short_name: string };
}

interface PlayerRow {
  /** CRCON's row id. The live boards drop it for everyone the round's cache holds and send 0 for
   *  the rest, so it tells no two rows apart there; the page keys rows with rowKeys instead. */
  id?: number;
  player_id: string | null;
  player: string | null;
  platform: string | null;
  /** The player's game level, from the round's player cache; 0 where the round never saw it. */
  level?: number;
  kills: number;
  deaths: number;
  teamkills: number;
  kill_death_ratio: number | null;
  combat: number;
  offense: number;
  defense: number;
  support: number;
  time_seconds: number | null;
  kills_streak: number | null;
  /** A filed row carries detect_team's verdict ({ side, … }); a live row carries the side itself. */
  team: { side: string } | string | null;
  weapons: Record<string, number> | null;
  most_killed: Record<string, number> | null;
  death_by: Record<string, number> | null;
  status?: string;
}

interface LiveStats { snapshot_timestamp: string; refresh_interval_sec: number; stats: PlayerRow[] }

/**
 * The round-report layer over a scoreboard — OUR /api/public/<slug>/report/<id> endpoint, not a
 * CRCON one: awards, the flow timeline, the class split, duels, and each player's personal kill
 * timeline. Everything in it is name-keyed; no id of any kind rides in it.
 */
interface PublicPlayerReport {
  side: "allies" | "axis" | null;
  timeline: TimelineTuple[];
  killsStreak: number; deathsWithoutKillStreak: number;
  longestLifeSecs: number | null; shortestLifeSecs: number | null; deathsByTk: number;
  /** Their score buckets through the round; absent for rounds played before they were recorded. */
  scores?: ScoreTuple[];
}
interface PublicReport {
  complete: boolean;
  bucketMinutes: number;
  classSplit: { classId: string; label: string; allies: number; axis: number }[];
  weaponSplit: { weapon: string; allies: number; axis: number }[];
  timeline: { minute: number; allies: number; axis: number }[];
  duels: { aName: string; bName: string; aKills: number; bKills: number }[];
  awards: { id: string; label: string; emoji: string; playerName: string; value: string }[];
  players: Record<string, PublicPlayerReport>;
  /** names two or more players wore this round — held out of `players`, since a name-keyed map
   *  cannot tell them apart (see docs/public-stats.md). Older wires don't carry the field. */
  sharedNames?: string[];
}

/**
 * The name a round's screens keep their state under for the visit — the board's sort and search,
 * the row opened, the kill race, the log's filter — so a player's career page opened from it comes
 * back to the round as it was left, not to the top of a re-sorted board. The live round is one
 * place; each past round is its own.
 */
const roundMemory = (slug: string, id: number | "current") => `public.${slug}.${id === "current" ? "now" : `games.${id}`}`;

/** What a round's screens say when there is no round to show: between rounds, or before the
 *  first, the round in play is not there — it is not loading. */
const NO_ROUND = "No round is being played right now.";
/** CRCON's own answer — and ours, its twin — for a round with no filed scoreboard. */
const NO_SCOREBOARD = "No map for this ID";

/** Load (and for the live round, keep loading) a round's report. The live clock is deliberately
 *  slower than the scoreboard's 15s: the report is the heavier read, and a chart that moves once
 *  a minute says exactly as much as one that moves four times. Beside it, what to say while there
 *  is none: a report that was not there read as one on its way, and the tab said "Loading…" for as
 *  long as the page stayed open. */
function useReport(slug: string, id: number | "current"): [PublicReport | null, string] {
  const [report, setReport] = useState<PublicReport | null>(null);
  const [missing, setMissing] = useState("");
  useEffect(() => {
    let stop = false;
    setReport(null); setMissing("");
    const load = () => fetch(`/api/public/${encodeURIComponent(slug)}/report/${id}`)
      .then(async (r) => {
        const d = r.ok ? ((await r.json().catch(() => null)) as { report?: PublicReport } | null) : null;
        if (stop) return;
        if (d?.report) { setReport(d.report); setMissing(""); return; }
        setMissing(r.status === 404 ? (id === "current" ? NO_ROUND : "This round has no report.") : "The round report is unavailable right now.");
      })
      .catch(() => { if (!stop) setMissing("The round report is unavailable right now."); });
    void load();
    if (id !== "current") return () => { stop = true; };
    const unpoll = pollWhileVisible(() => void load(), 60_000);
    return () => { stop = true; unpoll(); };
  }, [slug, id]);
  return [report, missing];
}

/** Which viz palette slot a row's side wears: sides[0] blue, sides[1] red — the same slots the
 *  staff match page assigns, so a round looks identical from both doors. Unknown side = slot 2. */
const sideIndexOf = (server: PublicServer | null, side: string | null | undefined): number => {
  const i = server?.sides.findIndex((s) => s.id === side) ?? -1;
  return i >= 0 ? i : 2;
};

/** A round's three screens, in the order the sidebar and the tab bar both list them. */
const ROUND_TABS: { id: RoundTab; label: string }[] = [
  { id: "players", label: "Players" },
  { id: "report", label: "Round report" },
  { id: "log", label: "Game log" },
];

/** Where each of a round's screens lives: the round in play under the server, a past one under
 *  its own id. Real paths, so any of them can be pasted somewhere. */
const roundHref = (slug: string, id: number | "current", tab: RoundTab): string => {
  const base = id === "current" ? slug : `${slug}/games/${id}`;
  return at(tab === "players" ? base : `${base}/${tab}`);
};

/** A round's screens as the page's own tab bar, the panel's in-page tabs. The sidebar lists the
 *  same three under the open screen; this is what a phone, with the sidebar tucked away, uses. */
function RoundTabs({ slug, id, tab, go }: { slug: string; id: number | "current"; tab: RoundTab; go: (p: string) => void }) {
  return (
    <nav className="pub-tabs" aria-label="This round">
      <div className="tabbar-wrap">
        <div className="tabbar">
          {ROUND_TABS.map((t) => (
            <L key={t.id} href={roundHref(slug, id, t.id)} go={go} current={tab === t.id}
              className={`tabbar-tab${tab === t.id ? " active" : ""}`}>{t.label}</L>
          ))}
        </div>
      </div>
    </nav>
  );
}

/** One line of a round's game log — OUR /api/public/<slug>/log/<id>; names only, no chat. */
interface PublicLogLine {
  t: number; kind: string; who?: string; whom?: string; weapon?: string;
  from?: string; to?: string; swapFrom?: string; swapCount?: number;
  /** An admin camera line: went in (true) or came out (false). */
  entered?: boolean;
}
interface PublicLog { start: string; end: string | null; truncated: boolean; lines: PublicLogLine[] }

/** The log's filters, each a set of kinds. The round's start and end show under every one. */
const LOG_FILTERS: { id: string; label: string; kinds: string[] }[] = [
  { id: "all", label: "All", kinds: [] },
  { id: "kills", label: "Kills", kinds: ["evt.kill"] },
  { id: "tks", label: "Team kills", kinds: ["evt.teamkill"] },
  { id: "conn", label: "Connections", kinds: ["evt.player.connected", "evt.player.disconnected"] },
  { id: "switch", label: "Team switches", kinds: ["evt.player.teamSwitched"] },
  { id: "cam", label: "Admin camera", kinds: ["evt.admin.camera"] },
];
/** Lines drawn at a time: a full round is thousands, and a phone draws them all at once otherwise. */
const LOG_PAGE = 300;
const isBoundary = (l: PublicLogLine) => l.kind === "evt.match.started" || l.kind === "evt.match.ended";
/** "0:30", "12:05", "1:02:03" — the round's own clock. */
const roundClock = (t: number): string => {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};

function LogText({ l, log }: { l: PublicLogLine; log: PublicLog }) {
  switch (l.kind) {
    case "evt.match.started": return <><strong>Match started</strong> <span className="muted">· {fmtDate(log.start)}</span></>;
    case "evt.match.ended": return <><strong>Match ended</strong> <span className="muted">· {fmtDate(log.end)}</span></>;
    case "evt.kill": return <><strong>{l.who}</strong> <span className="muted">✖</span> {l.whom}{l.weapon && <span className="log-weapon"> · {l.weapon}</span>}</>;
    case "evt.teamkill": return <><strong>{l.who}</strong> <span className="log-tk-mark">team-killed</span> {l.whom}{l.weapon && <span className="log-weapon"> · {l.weapon}</span>}</>;
    case "evt.player.connected": return <>{l.who} <span className="muted">connected</span></>;
    case "evt.player.disconnected": return <>{l.who} <span className="muted">disconnected</span></>;
    case "evt.player.teamSwitched": return <>{l.who} <span>{teamSwitchText(l) ?? "switched team"}</span></>;
    case "evt.admin.camera": return <>{l.who} <span className="muted">{l.entered ? "entered" : "left"} the admin camera</span></>;
    default: return <>{l.who}</>;
  }
}

/** A line's words beyond who and whom, for a file: the team switch, or which way the camera went. */
function logDetail(l: PublicLogLine): string {
  if (l.kind === "evt.player.teamSwitched") return teamSwitchText(l) ?? "switched team";
  if (l.kind === "evt.admin.camera") return l.entered ? "entered the admin camera" : "left the admin camera";
  return "";
}

/** The log as a file (components/Download): the lines it shows — its filter and its search — all of
 *  them, not only the page drawn. Names only, like the log. */
function logSheet(lines: PublicLogLine[], log: PublicLog): Sheet {
  const startMs = Date.parse(log.start);
  return {
    name: "Game log",
    columns: [
      { key: "time", label: "Time", time: true },
      { key: "roundClock", label: "Round clock" },
      { key: "what", label: "What" },
      { key: "player", label: "Player" },
      { key: "target", label: "Target" },
      { key: "weapon", label: "Weapon" },
      { key: "detail", label: "Detail" },
    ],
    rows: lines.map((l) => [
      new Date(startMs + l.t * 1000).toISOString(), roundClock(l.t), eventKindLabel(l.kind),
      l.who ?? "", l.whom ?? "", l.weapon ?? "", logDetail(l),
    ]),
  };
}

const isLogFilter = (v: unknown): v is string => typeof v === "string" && LOG_FILTERS.some((f) => f.id === v);
const isShownCount = (v: unknown): v is number => isCount(v) && v >= LOG_PAGE;

/**
 * A round's game log: its start and end, every kill and team kill with the weapon, every connect,
 * disconnect and team switch, and every time an admin went into the admin camera or came out, in
 * order, on the round's own clock (the wall-clock time is on hover).
 * Filtered by kind and by a name, and drawn a page at a time. The live round's refreshes itself.
 * Downloads as Excel, CSV or JSON: the lines it shows, made in the browser from the log it holds.
 */
function GameLog({ slug, id }: { slug: string; id: number | "current" }) {
  const [log, setLog] = useState<PublicLog | null>(null);
  const [err, setErr] = useState("");
  const mem = `${roundMemory(slug, id)}.log`;
  const [filter, setFilterState] = useRemembered(`${mem}.filter`, "all", isLogFilter, "session");
  const [find, setFindState] = useRemembered(`${mem}.find`, "", isText, "session");
  const [shown, setShown] = useRemembered(`${mem}.shown`, LOG_PAGE, isShownCount, "session");
  // A new filter or search starts the list from its top again — on the change itself, not in an
  // effect, which would also run as the log mounts and throw away how far it had been read.
  const setFilter = (f: string) => { setFilterState(f); setShown(LOG_PAGE); };
  const setFind = (q: string) => { setFindState(q); setShown(LOG_PAGE); };
  useEffect(() => {
    let stop = false;
    setLog(null); setErr("");
    const load = () => fetch(`/api/public/${encodeURIComponent(slug)}/log/${id}`)
      .then(async (r) => {
        const d = (await r.json().catch(() => null)) as { log?: PublicLog; error?: string } | null;
        // Not there is said as such: the round in play between rounds, or a round with no log.
        if (r.status === 404) throw new Error(id === "current" ? NO_ROUND : "This round has no game log.");
        // Anything else failed, said plainly: the server's own error text is a command name or a
        // code, and from the API's error handler an object, which read "[object Object]".
        if (!r.ok || !d?.log) throw new Error("The game log is unavailable right now.");
        return d.log;
      })
      .then((l) => { if (!stop) { setLog(l); setErr(""); } })
      .catch((e) => { if (!stop) setErr((e as Error).message); });
    void load();
    if (id !== "current") return () => { stop = true; };
    const unpoll = pollWhileVisible(() => void load(), 30_000);
    return () => { stop = true; unpoll(); };
  }, [slug, id]);
  const matching = useMemo(() => {
    if (!log) return [];
    const kinds = LOG_FILTERS.find((f) => f.id === filter)?.kinds ?? [];
    const q = find.trim().toLowerCase();
    return log.lines.filter((l) => isBoundary(l) || ((kinds.length === 0 || kinds.includes(l.kind))
      && (!q || (l.who ?? "").toLowerCase().includes(q) || (l.whom ?? "").toLowerCase().includes(q))));
  }, [log, filter, find]);
  const startMs = log ? Date.parse(log.start) : 0;
  return (
    <div className="card">
      <div className="row" style={{ gap: 8, alignItems: "baseline", marginBottom: 8, flexWrap: "wrap" }}>
        <div className="seg">
          {LOG_FILTERS.map((f) => (
            <button key={f.id} className={`seg-btn ${filter === f.id ? "active" : ""}`} onClick={() => setFilter(f.id)}>{f.label}</button>
          ))}
        </div>
        <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a player…"
          aria-label="Find a player in the log" style={{ flex: "1 1 200px", maxWidth: 260 }} />
        {id === "current" && log && <span className="muted fs-sm">updates every 30s</span>}
        {log && (
          <DownloadButton file={fileStem(slug, id === "current" ? "live round" : `round ${id}`, "game log")}
            title="Download the game log" count={matching.length} noun="line" noIds
            scope={id === "current" ? "as the log shows them now, with its filter and search" : "as the log shows them, with its filter and search"}
            sheet={() => logSheet(matching, log)} />
        )}
      </div>
      {err && <p className="muted">{err}</p>}
      {!log && !err && <p className="muted">Loading…</p>}
      {log?.truncated && <p className="hint notice">This round has more lines than the log holds, so its earliest are not here.</p>}
      {log && (
        <div className="log-list">
          {matching.slice(0, shown).map((l, i) => {
            const tag = EVENT_TAG[l.kind];
            return (
              <div key={i} className="log-row">
                <span className="log-time" title={new Date(startMs + l.t * 1000).toLocaleString()}>{roundClock(l.t)}</span>
                <span className={`log-tag ${tag?.cls ?? ""}`}>{tag?.label ?? "•"}</span>
                <span className="log-body"><LogText l={l} log={log} /></span>
              </div>
            );
          })}
        </div>
      )}
      {log && matching.length > shown && (
        <button className="ghost" style={{ marginTop: 8 }} onClick={() => setShown((n) => n + LOG_PAGE)}>
          Show more ({(matching.length - shown).toLocaleString()} left)
        </button>
      )}
    </div>
  );
}

/**
 * The report cards, in the staff page's order: highlights, flow, classes, duels. The per-player
 * timeline lives in the scoreboard's expanded rows instead (that is where the player is). The
 * caller gates on a loaded, complete report — the empty states differ between live and finished
 * rounds and belong to the views that know which one they are.
 */
function RoundReport({ report, server, roundSecs = null, remember }: { report: PublicReport; server: PublicServer; roundSecs?: number | null; remember?: string }) {
  const flowPoints: ProgPoint[] = useMemo(
    () => report.timeline.map((t) => ({ x: `${t.minute}m`, values: { allies: t.allies, axis: t.axis } })),
    [report],
  );
  // The wire is keyed by display name and the API drops any name two players shared, so a name
  // IS an identity here — see publicMatchReport.
  const racePlayers = useMemo(
    () => Object.entries(report.players).map(([name, d]) => ({ id: name, name, side: d.side, timeline: d.timeline, scores: d.scores })),
    [report],
  );
  const raceScores = racePlayers.some((p) => p.scores?.length) && server.scoreFields.length > 0;
  const left = server.sides[0], right = server.sides[1];
  return (
    <>
      {report.awards.length > 0 && (
        <div className="card">
          <strong>Highlights</strong>
          <div className="award-grid" style={{ marginTop: 8 }}>
            {report.awards.map((a) => (
              <div key={a.id} className="award-chip" title={a.label}>
                <span className="award-emoji" aria-hidden>{a.emoji}</span>
                <span className="award-body">
                  <span className="award-label">{a.label}</span>
                  <span className="award-who">{a.playerName} · <strong>{a.value}</strong></span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap" }}>
          <strong>How the round flowed</strong>
          <span className="muted fs-sm">kills per {report.bucketMinutes > 1 ? `${report.bucketMinutes} min` : "minute"}</span>
        </div>
        <Progression
          points={flowPoints}
          series={[
            { key: "allies", label: left?.label ?? "Allies", colorIndex: 0 },
            { key: "axis", label: right?.label ?? "Axis", colorIndex: 1 },
          ]}
          windows={[]}
        />
      </div>
      {racePlayers.length >= 2 && (
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap" }}>
            <strong>The kill race</strong>
            <span className="muted fs-sm">every player&apos;s {raceScores ? "kills and scores" : "kills"} over the round</span>
          </div>
          <p className="hint">One line per player, coloured by side, with the leaders named where they finish. Hover or tap a line for who it is and their count at that moment, click to keep it lit, or type a name to find yourself in the crowd.{raceScores ? " The switch races each score the same way." : ""}</p>
          <KillRace
            players={racePlayers}
            roundSecs={roundSecs}
            sides={[
              { id: "allies", label: left?.label ?? "Allies", colorIndex: 0 },
              { id: "axis", label: right?.label ?? "Axis", colorIndex: 1 },
            ]}
            scoreFields={server.scoreFields}
            remember={remember ? `${remember}.race` : undefined}
          />
        </div>
      )}

      {report.classSplit.length > 0 && (
        <div className="card">
          <strong>Kills by class</strong>
          <div style={{ marginTop: 8 }}>
            <SideSplit
              rows={report.classSplit.map((c) => ({ label: c.label, left: c.allies, right: c.axis }))}
              left={{ label: left?.label ?? "Allies", colorIndex: 0 }}
              right={{ label: right?.label ?? "Axis", colorIndex: 1 }}
            />
          </div>
        </div>
      )}
      {report.weaponSplit.length > 0 && (
        <div className="card">
          <strong>Top weapons</strong>
          <p className="hint">The round&apos;s most-used weapons by kills, per side. Each player&apos;s own list is behind their row on the Players screen.</p>
          <SideSplit
            rows={report.weaponSplit.map((w) => ({ label: w.weapon, left: w.allies, right: w.axis }))}
            left={{ label: left?.label ?? "Allies", colorIndex: 0 }}
            right={{ label: right?.label ?? "Axis", colorIndex: 1 }}
          />
        </div>
      )}
      {report.duels.length > 0 && (
        <div className="card">
          <strong>Duels</strong>
          <p className="hint">The pairs who ran into each other most, both directions counted — the first name got the better of it.</p>
          <div style={{ overflowX: "auto" }}>
            <table className="mini-table duels"><tbody>
              {report.duels.map((d) => (
                <tr key={`${d.aName}|${d.bName}`}>
                  <td>{d.aName}</td>
                  <td className="num duel-score"><strong>{d.aKills}</strong> – {d.bKills}</td>
                  <td>{d.bName}</td>
                </tr>
              ))}
            </tbody></table>
          </div>
        </div>
      )}
    </>
  );
}
interface RoundRow {
  id: number;
  start: string;
  end: string | null;
  map_name: string;
  map: { pretty_name?: string; game_mode?: string; environment?: string } | null;
  result: { allied: number; axis: number } | null;
  player_stats: PlayerRow[];
}
interface RoundPage { page: number; page_size: number; total: number; maps: RoundRow[] }

// --- Tiny path router ------------------------------------------------------------------------

/** The two screens a round has: its player list (the main screen) and its report (the charts).
 *  Real paths, not local state — a report someone wants the squad to see gets pasted as a link. */
type RoundTab = "players" | "report" | "log";

type Route =
  | { view: "index" }
  | { view: "now"; slug: string; tab: RoundTab }
  | { view: "games"; slug: string; page: number }
  | { view: "round"; slug: string; id: number; tab: RoundTab }
  | { view: "server"; slug: string }
  | { view: "player"; slug: string; pid: string };

function parsePath(pathname: string, search: string): Route {
  // ["stats"?, slug?, "report"? | "log"? | "games"?, id?, "report"? | "log"?] — the "stats" head exists on the
  // panel host and is folded away by the server on a dedicated public hostname, so it is
  // optional here.
  const raw = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  const seg = raw[0] === "stats" ? raw.slice(1) : raw;
  if (seg.length < 1) return { view: "index" };
  const slug = decodeURIComponent(seg[0]);
  if (seg[1] === "report") return { view: "now", slug, tab: "report" };
  if (seg[1] === "log") return { view: "now", slug, tab: "log" };
  if (seg[1] === "server") return { view: "server", slug };
  if (seg[1] === "player" && seg[2]) return { view: "player", slug, pid: decodeURIComponent(seg[2]) };
  if (seg[1] !== "games") return { view: "now", slug, tab: "players" };
  if (seg[2]) return { view: "round", slug, id: Math.trunc(Number(seg[2])) || 0, tab: seg[3] === "report" ? "report" : seg[3] === "log" ? "log" : "players" };
  const page = Math.max(1, Math.trunc(Number(new URLSearchParams(search).get("page"))) || 1);
  return { view: "games", slug, page };
}

function useRoute(): [Route, (path: string) => void] {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === "undefined" ? { view: "index" } : parsePath(window.location.pathname, window.location.search));
  useEffect(() => {
    const onPop = () => setRoute(parsePath(window.location.pathname, window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = useCallback((path: string) => {
    window.history.pushState(null, "", path);
    setRoute(parsePath(window.location.pathname, window.location.search));
    window.scrollTo(0, 0);
  }, []);
  return [route, go];
}

/**
 * The public APIs a screen is built from, for its APIs panel: every endpoint the screen reads, and
 * on the live screen the live scoreboard too (CRCON's overlays read it beside the game stats).
 * Root-relative paths, the CRCON ones under /stats, which answers on the panel's host and the
 * public one alike. A browser test records each screen's requests and finds every one listed here.
 */
function apisFor(route: Route, server: PublicServer | null, servers: PublicServer[] | null): PublicApi[] {
  const crconPath = (slug: string, command: string, query = "") => `/stats/${encodeURIComponent(slug)}/api/${command}${query}`;
  const ownPath = (slug: string, rest: string) => `/api/public/${encodeURIComponent(slug)}/${rest}`;
  const info = (s: PublicServer, named = false): PublicApi => ({
    name: "get_public_info", crcon: true, path: crconPath(s.slug, "get_public_info"),
    about: "The server's name, player counts, map, score and time left.", ...(named ? { server: s.name } : {}),
  });
  const report = (slug: string, id: number | "current"): PublicApi => ({
    name: "Round report", path: ownPath(slug, `report/${id}`),
    about: `${id === "current" ? "The round so far" : "This round"}: highlights, how it flowed, the kill race, and each player's timeline and scores.`,
  });
  const log = (slug: string, id: number | "current"): PublicApi => ({
    name: "Game log", path: ownPath(slug, `log/${id}`), about: `${id === "current" ? "The round's" : "This round's"} game log, in order.`,
  });
  if (route.view === "index") {
    return [
      { name: "Servers", path: "/api/public/servers", about: "The published servers, and how to read each one: its side names and score columns." },
      ...(servers ?? []).map((s) => info(s, true)),
    ];
  }
  if (!server) return [];
  switch (route.view) {
    case "now":
      return [
        info(server),
        { name: "get_live_game_stats", crcon: true, path: crconPath(server.slug, "get_live_game_stats"),
          about: "Everyone who has played in the round in progress, with their kills, deaths and scores: the scoreboard here." },
        { name: "get_live_scoreboard", crcon: true, path: crconPath(server.slug, "get_live_scoreboard"),
          about: "The same stats for the players connected right now." },
        report(server.slug, "current"),
        ...(route.tab === "log" ? [log(server.slug, "current")] : []),
      ];
    case "games":
      return [
        info(server),
        { name: "get_scoreboard_maps", crcon: true, path: crconPath(server.slug, "get_scoreboard_maps", `?page=${route.page}&limit=25`),
          about: "Past rounds, a page at a time (page, and limit for how many on one)." },
      ];
    case "round":
      return [
        { name: "get_map_scoreboard", crcon: true, path: crconPath(server.slug, "get_map_scoreboard", `?map_id=${route.id}`),
          about: "This round's scoreboard: every player's kills, deaths, scores and time played." },
        report(server.slug, route.id),
        ...(route.tab === "log" ? [log(server.slug, route.id)] : []),
      ];
    case "server":
      return [info(server), { name: "Server stats", path: ownPath(server.slug, "stats"), about: "This server's records and trends." }];
    case "player":
      return [{ name: "Player career", path: ownPath(server.slug, `player/${encodeURIComponent(route.pid)}`), about: "This player's career on this server." }];
  }
}

/** An internal link that is still a real <a> — open-in-new-tab and copy-link must work. */
function L({ href, go, children, className, title, current }: {
  href: string; go: (p: string) => void; children: React.ReactNode; className?: string; title?: string;
  /** the page this link names is the one showing */
  current?: boolean;
}) {
  return (
    <a href={href} className={className} title={title} aria-current={current ? "page" : undefined}
      onClick={(e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) { e.preventDefault(); go(href); } }}>
      {children}
    </a>
  );
}

// --- Shared bits -----------------------------------------------------------------------------

const fmtDuration = (sec: number | null): string => {
  if (sec === null || !Number.isFinite(sec) || sec < 0) return "—";
  const m = Math.floor(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
};
// The DEVICE zone on purpose, unlike the panel: this page is read by the public, each visitor
// in their own country, and no display-zone preference exists out here. Their own clock IS the
// right one — do not "fix" this to the community zone in a timezone sweep.
const fmtDate = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : "—");
const kd = (r: PlayerRow): string => (r.kill_death_ratio === null ? "—" : r.kill_death_ratio.toFixed(2));

/** A row's side, from either shape of `team`. */
const sideOfRow = (r: PlayerRow): string | undefined => (typeof r.team === "string" ? r.team : r.team?.side) ?? undefined;

/**
 * A key per row, unique on its board and steady across the live board's refreshes: the player's
 * id where the server publishes ids, else their name, numbered where a key repeats. Never CRCON's
 * row `id`, which the live boards leave out or send as 0, so that every row answered to one key and
 * a tap opened them all.
 */
function rowKeys(rows: PlayerRow[]): Map<PlayerRow, string> {
  const seen = new Map<string, number>();
  return new Map(rows.map((r) => {
    const base = r.player_id ? `id:${r.player_id}` : r.player !== null ? `name:${r.player}` : "row";
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return [r, `${base}#${n}`];
  }));
}

type Sort = { key: string; dir: 1 | -1 };

/** A sortable column header (hoisted: defining it inside the table re-mints it every render).
 *  Numbers sit right-aligned under a right-aligned label, so a column of them reads down. */
function TH({ k, sort, setSort, children, title, num = true }: {
  k: string; sort: Sort; setSort: (fn: (s: Sort) => Sort) => void; children: React.ReactNode; title?: string; num?: boolean;
}) {
  return (
    <th title={title} className={`${num ? "num" : ""}${sort.key === k ? " sorted" : ""}`}
      onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : -1 }))}
      style={{ cursor: "pointer", whiteSpace: "nowrap" }}>
      {children}{sort.key === k ? (sort.dir === -1 ? " ↓" : " ↑") : ""}
    </th>
  );
}

/** A side's colour, as the descriptor names it ("blue", "red"), for a mark or for text. */
const sideColor = (server: PublicServer | null, side: string | null | undefined): string | null => {
  const s = server?.sides.find((x) => x.id === side);
  return s ? s.color : null;
};

/**
 * The scoreboard's column header, pinned to the top of the screen once the table's own header has
 * scrolled past it — a round is seventy-odd rows, and halfway down nobody remembers which number is
 * deaths and which is defence. Not CSS `position: sticky`: the table scrolls sideways inside its own
 * box on a phone, and a sticky header inside that box sticks to the box, never to the page. So this
 * is a copy, fixed to the top, with the real header's column widths, following the table sideways.
 * It renders nothing while the real header is on screen, and a page scroll only re-renders this.
 */
function FloatingHead({ wrapRef, headRef, children }: {
  wrapRef: RefObject<HTMLDivElement | null>; headRef: RefObject<HTMLTableSectionElement | null>; children: React.ReactNode;
}) {
  const [box, setBox] = useState<{ left: number; width: number; tableWidth: number; cols: number[] } | null>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frame = 0;
    let last = "";
    const measure = () => {
      frame = 0;
      const wrap = wrapRef.current, head = headRef.current;
      const w = wrap?.getBoundingClientRect(), h = head?.getBoundingClientRect();
      // Pinned while the real header is above the top and there are still rows on screen under it.
      const next = wrap && head && w && h && h.top < 0 && w.bottom > h.height * 2
        ? { left: w.left, width: wrap.clientWidth, tableWidth: head.parentElement?.getBoundingClientRect().width ?? w.width,
            cols: [...head.querySelectorAll("th")].map((th) => th.getBoundingClientRect().width) }
        : null;
      const key = JSON.stringify(next);
      if (key !== last) { last = key; setBox(next); }
    };
    const soon = () => { if (!frame) frame = requestAnimationFrame(measure); };
    window.addEventListener("scroll", soon, { passive: true });
    window.addEventListener("resize", soon);
    // The table changes under a still page too: a sort, an expanded row, the live refresh.
    const ro = new ResizeObserver(soon);
    if (headRef.current?.parentElement) ro.observe(headRef.current.parentElement);
    soon();
    return () => { window.removeEventListener("scroll", soon); window.removeEventListener("resize", soon); ro.disconnect(); cancelAnimationFrame(frame); };
  }, [wrapRef, headRef]);
  // Sideways, the copy follows the table: on its own scroll, and wherever it was when the copy appears.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const follow = () => { if (floatRef.current) floatRef.current.scrollLeft = wrap.scrollLeft; };
    wrap.addEventListener("scroll", follow, { passive: true });
    return () => wrap.removeEventListener("scroll", follow);
  }, [wrapRef]);
  useLayoutEffect(() => {
    if (box && floatRef.current && wrapRef.current) floatRef.current.scrollLeft = wrapRef.current.scrollLeft;
  }, [box, wrapRef]);
  if (!box) return null;
  return (
    <div ref={floatRef} className="sb-float" style={{ left: box.left, width: box.width }}>
      <table className="scoreboard pub-sb" style={{ width: box.tableWidth, tableLayout: "fixed" }}>
        <colgroup>{box.cols.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
        <thead>{children}</thead>
      </table>
    </div>
  );
}

const isSort = (v: unknown): v is Sort =>
  typeof v === "object" && v !== null && typeof (v as Sort).key === "string" && ((v as Sort).dir === 1 || (v as Sort).dir === -1);

/** Column-sortable scoreboard — the one table both the live view and a finished round render.
 *  With a report in hand it also wears the award emojis inline and hands each expanded row that
 *  player's personal timeline. */
function Scoreboard({ rows, server, onExpand, expanded, report, roundSecs, go, remember }: {
  rows: PlayerRow[];
  server: PublicServer | null;
  onExpand?: (row: string) => void;
  expanded?: string | null;
  report?: PublicReport | null;
  roundSecs?: number | null;
  go?: (p: string) => void;
  /** A name to keep the board's sort, search and side under for the visit; none keeps nothing. */
  remember?: string;
}) {
  const [sort, setSort] = useRemembered<Sort>(remember ? `${remember}.sort` : null, { key: "kills", dir: -1 }, isSort, "session");
  const buckets = server?.scoreFields ?? [];
  const awardsByName = useMemo(() => {
    const m = new Map<string, { emoji: string; label: string; value: string }[]>();
    for (const a of report?.awards ?? []) m.set(a.playerName, [...(m.get(a.playerName) ?? []), a]);
    return m;
  }, [report]);
  // A full round is ~100 rows. Someone opening this page is nearly always looking for one name in
  // it — their own — and scrolling a hundred rows on a phone to find it is the whole friction.
  const [find, setFind] = useRemembered(remember ? `${remember}.find` : null, "", isText, "session");
  // ...or for one side of it: their team's board, the way the game shows it.
  const [side, setSide] = useRemembered<string | null>(remember ? `${remember}.side` : null, null, isTextOrNull, "session");
  const matching = useMemo(() => {
    const q = find.trim().toLowerCase();
    return rows.filter((r) => (!side || sideOfRow(r) === side) && (!q || (r.player ?? "").toLowerCase().includes(q)));
  }, [rows, find, side]);
  const sideCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const s = sideOfRow(r);
      if (s) m.set(s, (m.get(s) ?? 0) + 1);
    }
    return m;
  }, [rows]);
  const keys = useMemo(() => rowKeys(rows), [rows]);
  // A level column once any row has a level, as the panel's live view has one; a board with none
  // (an imported round, say) has no column of blanks.
  const levels = useMemo(() => rows.some((r) => (r.level ?? 0) > 0), [rows]);
  // CRCON keys a row's most_killed and death_by by the other player's id, so on a server that
  // publishes ids each key reads back to the name on that player's row. Everyone the round's log
  // names has a row on the board. A names-only board nulls every id, and its keys are already names.
  const nameOf = useMemo(() => {
    const byId = new Map<string, string>();
    for (const r of rows) if (r.player_id && r.player) byId.set(r.player_id, r.player);
    const keyedById = rows.some((r) => r.player_id !== null);
    return (key: string) => (keyedById ? byId.get(key) ?? "Unknown player" : key);
  }, [rows]);
  const sorted = useMemo(() => {
    const value = (r: PlayerRow, key: string): number | string => {
      switch (key) {
        case "player": return (r.player ?? "").toLowerCase();
        case "kd": return r.kill_death_ratio ?? -1;
        case "time": return r.time_seconds ?? -1;
        default: return (r as unknown as Record<string, number>)[key] ?? 0;
      }
    };
    return [...matching].sort((a, b) => {
      const av = value(a, sort.key), bv = value(b, sort.key);
      const cmp = typeof av === "string" || typeof bv === "string" ? String(av).localeCompare(String(bv)) : (av as number) - (bv as number);
      return cmp * sort.dir;
    });
  }, [matching, sort]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLTableSectionElement>(null);
  // A sort picked from the pinned header (the real one is off screen, so it can only come from
  // there) shows the newly sorted list from its top, header and all, before the browser paints.
  const sortedOnce = useRef(false);
  useLayoutEffect(() => {
    if (!sortedOnce.current) { sortedOnce.current = true; return; }
    const top = headRef.current?.getBoundingClientRect().top;
    // Rounded down: the header's offset can fall on a half pixel, and a scroll rounded the other way
    // left it half a pixel above the edge, where the pinned copy stayed up over the real one.
    if (top !== undefined && top < 0) window.scrollTo({ top: Math.floor(window.scrollY + top) });
  }, [sort]);
  const headerRow = (
    <tr>
      <TH k="player" sort={sort} setSort={setSort} num={false}>Player</TH>
      {levels && <TH k="level" sort={sort} setSort={setSort} title="Level">Lvl</TH>}
      <TH k="kills" sort={sort} setSort={setSort} title="Kills">K</TH>
      <TH k="deaths" sort={sort} setSort={setSort} title="Deaths">D</TH>
      <TH k="kd" sort={sort} setSort={setSort} title="Kill/death ratio">K/D</TH>
      {buckets.map((b, i) => <TH key={b.key} k={BUCKET_KEYS[i] ?? "combat"} sort={sort} setSort={setSort} title={b.title}>{b.label}</TH>)}
      <TH k="teamkills" sort={sort} setSort={setSort} title="Team kills">TK</TH>
      <TH k="time" sort={sort} setSort={setSort} title="Time played this round">Time</TH>
    </tr>
  );
  const filtered = Boolean(find.trim()) || side !== null;
  return (
    <>
      <div className="pub-sb-tools">
        <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a player…"
          aria-label="Find a player" />
        {sideCounts.size > 0 && (
          <div className="seg" role="group" aria-label="Show a side">
            <button className={`seg-btn ${side === null ? "active" : ""}`} onClick={() => setSide(null)}>All {rows.length}</button>
            {(server?.sides ?? []).filter((x) => sideCounts.has(x.id)).map((x) => (
              <button key={x.id} className={`seg-btn ${side === x.id ? "active" : ""}`} onClick={() => setSide((v) => (v === x.id ? null : x.id))}>
                <span className="pub-dot" style={{ background: `var(--side-${x.color})` }} aria-hidden />{x.label} {sideCounts.get(x.id)}
              </button>
            ))}
          </div>
        )}
        {(find.trim() || sideCounts.size === 0) && (
          <span className="muted fs-sm">
            {filtered ? `${sorted.length} of ${rows.length}` : counted(rows.length, "player")}
          </span>
        )}
      </div>
      <FloatingHead wrapRef={wrapRef} headRef={headRef}>{headerRow}</FloatingHead>
      {/* No scroll anchoring inside. When the rows re-sort, the browser chased whichever row it had
          anchored to: the page jumped to wherever that row went, and it moved again after the sort
          had placed the list at the top. */}
      <div ref={wrapRef} style={{ overflowX: "auto", overflowAnchor: "none" }}>
      <table className="scoreboard pub-sb" style={{ width: "100%" }}>
        <thead ref={headRef}>{headerRow}</thead>
        <tbody>
          {sorted.map((r) => (
            <PlayerRows key={keys.get(r)} r={r} server={server} buckets={buckets.length} nameOf={nameOf} levels={levels}
              onExpand={onExpand ? () => onExpand(keys.get(r)!) : undefined} expanded={expanded === keys.get(r)}
              chips={awardsByName.get(r.player ?? "") ?? []}
              detail={report?.players[r.player ?? ""] ?? null} roundSecs={roundSecs ?? null} go={go}
              sharedName={(report?.sharedNames ?? []).includes(r.player ?? "")}
              chartMemory={remember ? `${remember}.rows.${keys.get(r)}.chart` : undefined} />
          ))}
          {sorted.length === 0 && (
            <tr><td colSpan={6 + buckets.length + (levels ? 1 : 0)} className="muted">{find.trim() ? `Nobody here matches “${find.trim()}”.` : filtered ? "Nobody on this side." : "Nobody yet."}</td></tr>
          )}
        </tbody>
      </table>
      </div>
    </>
  );
}

function topEntries(dict: Record<string, number> | null | undefined, n: number): [string, number][] {
  return Object.entries(dict ?? {}).sort((a, b) => b[1] - a[1]).slice(0, n);
}

/** The response keys behind the descriptor's score columns, in CRCON's fixed order. */
const BUCKET_KEYS = ["combat", "offense", "defense", "support"] as const;

function PlayerRows({ r, server, buckets, onExpand, expanded, chips = [], detail = null, roundSecs = null, go, sharedName = false, nameOf = (key) => key, levels = false, chartMemory }: {
  r: PlayerRow; server: PublicServer | null; buckets: number;
  /** Whether the board has a level column: any row on it has a level. */
  levels?: boolean;
  /** The name behind a most_killed / death_by key (the Scoreboard's nameOf). */
  nameOf?: (key: string) => string;
  onExpand?: () => void; expanded: boolean;
  /** someone else in this round wears this name too, so the round's per-player detail can't be
   *  attributed to either of them — say that, rather than showing a gap with no reason. */
  sharedName?: boolean;
  chips?: { emoji: string; label: string; value: string }[];
  detail?: PublicPlayerReport | null;
  roundSecs?: number | null;
  go?: (p: string) => void;
  /** Where the opened row's chart is kept for the visit. */
  chartMemory?: string;
}) {
  const cols = 6 + buckets + (levels ? 1 : 0);
  // A name is a link to that player's career page when the server publishes platform ids (and
  // this row carries one). The stopPropagation keeps the link a link — the ROW click is the
  // drill-in, same split as the staff scoreboard.
  const careerHref = server?.playerIds && r.player_id && go ? at(`${server.slug}/player/${encodeURIComponent(r.player_id)}`) : null;
  // The side is the row's colour — a bar down its edge and the name in that side's ink — rather
  // than a column of its own, which a phone could not spare. The bar says it to anyone who cannot
  // tell the two inks apart, and the board's side filter names them.
  const side = sideOfRow(r);
  const color = sideColor(server, side);
  const sideLabel = server?.sides.find((x) => x.id === side)?.label;
  const ink = color ? { color: `var(--side-${color}-text, var(--side-${color}))` } : undefined;
  return (
    <>
      <tr onClick={onExpand} style={onExpand ? { cursor: "pointer" } : undefined}>
        <td className="pub-sb-name" style={color ? { boxShadow: `inset 3px 0 0 var(--side-${color})` } : undefined} title={sideLabel}>
          {careerHref && go
            ? <span onClick={(e) => e.stopPropagation()}><L href={careerHref} go={go}><strong style={ink}>{r.player ?? r.player_id ?? "Unknown"}</strong></L></span>
            : <strong style={ink}>{r.player ?? r.player_id?.slice(0, 10) ?? "Unknown"}</strong>}
          {chips.map((c) => <span key={c.label} className="award-inline" title={`${c.label}: ${c.value}`} aria-label={c.label}>{c.emoji}</span>)}
          {r.status === "online" && <span className="pub-online" title="In the game now" aria-label="in the game now" />}
        </td>
        {/* The level after the name, in its own column and the panel's level colours, as the live
            view shows it. 0 means the round never saw it: the cell stays empty. */}
        {levels && <td className="num">{(r.level ?? 0) > 0 ? <span className={levelClass(r.level)}>{r.level}</span> : ""}</td>}
        <td className="num"><strong>{r.kills}</strong></td>
        <td className="num">{r.deaths}</td>
        <td className="num">{kd(r)}</td>
        {BUCKET_KEYS.slice(0, buckets).map((k) => <td key={k} className="num">{r[k]}</td>)}
        <td className="num">{r.teamkills}</td>
        <td className="num muted">{fmtDuration(r.time_seconds)}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={cols} style={{ background: "var(--bg-subtle, transparent)" }}>
            {detail && (detail.timeline.length > 0 || (detail.scores?.length ?? 0) > 0) && (
              <div style={{ padding: "4px 0" }}>
                <PlayerRoundCharts timeline={detail.timeline} scores={detail.scores} roundSecs={roundSecs}
                  colorIndex={sideIndexOf(server, side)} scoreFields={server?.scoreFields ?? []} remember={chartMemory} />
              </div>
            )}
            {sharedName && (
              <p className="muted fs-sm" style={{ margin: "4px 0" }}>
                Someone else in this round goes by this name too, so the kill log can&apos;t say which of you is which —
                no personal timeline here, and no line on the kill race. The scores on this row are still yours.
              </p>
            )}
            <div className="row" style={{ gap: 24, flexWrap: "wrap", padding: "4px 0" }}>
              <div>
                <div className="hint">Weapons</div>
                {topEntries(r.weapons, 5).map(([w, n]) => <div key={w} className="fs-sm">{w} <span className="muted">×{n}</span></div>)}
                {topEntries(r.weapons, 1).length === 0 && <span className="muted fs-sm">—</span>}
              </div>
              <div>
                <div className="hint">Most killed</div>
                {topEntries(r.most_killed, 3).map(([k, n]) => <div key={k} className="fs-sm">{nameOf(k)} <span className="muted">×{n}</span></div>)}
                {topEntries(r.most_killed, 1).length === 0 && <span className="muted fs-sm">—</span>}
              </div>
              <div>
                <div className="hint">Died to</div>
                {topEntries(r.death_by, 3).map(([k, n]) => <div key={k} className="fs-sm">{nameOf(k)} <span className="muted">×{n}</span></div>)}
                {topEntries(r.death_by, 1).length === 0 && <span className="muted fs-sm">—</span>}
              </div>
              {r.kills_streak !== null && (
                <div>
                  <div className="hint">Best streak</div>
                  <div className="fs-sm">{counted(r.kills_streak, "kill")}</div>
                </div>
              )}
              {detail && (
                <div>
                  <div className="hint">Lives</div>
                  <div className="fs-sm">longest {fmtDuration(detail.longestLifeSecs)}</div>
                  <div className="fs-sm">shortest {fmtDuration(detail.shortestLifeSecs)}</div>
                  {detail.deathsByTk > 0 && <div className="fs-sm">{detail.deathsByTk} death{detail.deathsByTk === 1 ? "" : "s"} to own team</div>}
                </div>
              )}
              {/* Null whenever the server publishes names only — see docs/public-stats.md. */}
              {r.player_id !== null && (
                <div>
                  <div className="hint">Player id</div>
                  <code className="fs-sm">{r.player_id}</code>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** One side of a HUD's score: its label and colour from the descriptor, the wire's number. */
interface HudSide { label: string; color: string; score: number | null; count?: number | null }

/** A side's colour as text: the lighter ink the theme keeps for words, else the side colour. */
const sideInk = (color: string) => ({ color: `var(--side-${color}-text, var(--side-${color}))` });

/**
 * The HUD that heads a server's screens, laid out like the game's own top bar: the map (with its
 * art behind the card), both sides' scores with their head counts, then the numbers that move.
 * Labels and colours come from the descriptor, so a Vietnam server reads US/NVA from this code.
 */
function HudCard({ title, sub, art, sides, meta, live = false }: {
  title: React.ReactNode; sub?: React.ReactNode; art?: string | null;
  sides: [HudSide, HudSide] | null;
  meta: { label: string; value: string; title?: string }[];
  live?: boolean;
}) {
  return (
    <div className="pub-hud">
      {art && <div className="pub-hud-art" style={{ backgroundImage: `url(${art})` }} aria-hidden />}
      <div className="pub-hud-body">
        <div className="pub-hud-map">
          <div className="pub-hud-title">{title}{live && <span className="pub-live">Live</span>}</div>
          {sub && <div className="pub-hud-sub">{sub}</div>}
        </div>
        {sides && (
          <div className="pub-hud-score">
            <div className="pub-side">
              <span className="pub-side-label" style={sideInk(sides[0].color)}>{sides[0].label}</span>
              <span className="pub-side-score" style={sideInk(sides[0].color)}>{sides[0].score ?? "—"}</span>
              {sides[0].count != null && <span className="pub-side-count">{sides[0].count} players</span>}
            </div>
            <span className="pub-hud-colon" aria-hidden>:</span>
            <div className="pub-side">
              <span className="pub-side-label" style={sideInk(sides[1].color)}>{sides[1].label}</span>
              <span className="pub-side-score" style={sideInk(sides[1].color)}>{sides[1].score ?? "—"}</span>
              {sides[1].count != null && <span className="pub-side-count">{sides[1].count} players</span>}
            </div>
          </div>
        )}
        {meta.length > 0 && (
          <div className="pub-hud-meta">
            {meta.map((m) => (
              <div key={m.label} className="pub-meta-item" title={m.title}>
                <span className="pub-meta-value">{m.value}</span>
                <span className="pub-meta-label">{m.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** What get_public_info says is on now, as a HUD: the score both games share (allied/axis on the
 *  wire, whatever the sides are called), the head counts, the players in and the clock. */
function liveHud(server: PublicServer, info: PublicInfo | null) {
  const [l, r] = server.sides;
  return {
    art: mapImageUrl(info?.current_map.map?.id, server.game),
    sides: info
      ? [
          { label: l?.label ?? "Allies", color: l?.color ?? "blue", score: info.score.allied, count: info.player_count_by_team.allied },
          { label: r?.label ?? "Axis", color: r?.color ?? "red", score: info.score.axis, count: info.player_count_by_team.axis },
        ] as [HudSide, HudSide]
      : null,
    meta: info
      ? [
          { label: "Players", value: `${info.player_count}/${info.max_player_count}` },
          { label: "Time left", value: fmtDuration(info.time_remaining), title: "Time remaining in the round" },
        ]
      : [],
    live: Boolean(info),
  };
}

/** Where the map's name goes while the game server cannot be reached. "…" stood there for as
 *  long as the server was down, as if its game were still on its way. */
const UNREACHABLE = "Not reachable right now";

/** The live game, re-read with the page. Away from the live screen it is the way back to it. */
function LiveHud({ server, go, here = false }: { server: PublicServer; go: (p: string) => void; here?: boolean }) {
  const [info, setInfo] = useState<PublicInfo | null>(null);
  const [down, setDown] = useState(false);
  useEffect(() => {
    let stop = false;
    setInfo(null); setDown(false); // a server switch keeps this header mounted; the last server's map must not show under this one's name
    const load = () => crcon<PublicInfo>(server.slug, "get_public_info")
      .then((i) => { if (!stop) { setInfo(i); setDown(false); } })
      .catch(() => { if (!stop) setDown(true); });
    void load();
    const unpoll = pollWhileVisible(() => void load(), 20_000);
    return () => { stop = true; unpoll(); };
  }, [server.slug]);
  const card = <HudCard {...liveHud(server, info)} title={info?.current_map.map?.pretty_name ?? (down ? UNREACHABLE : "…")} sub={server.name} />;
  return here ? card : <L href={at(server.slug)} go={go} className="pub-hud-link" title="Now playing">{card}</L>;
}

/** A screen's own heading, under the HUD. */
function PageTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="pub-title">
      <h1>{title}</h1>
      {sub && <span className="muted fs-sm">{sub}</span>}
    </div>
  );
}

/** "Oct 12, 4:00 PM" in the visitor's own clock — the HUD's short form of fmtDate. */
const fmtWhen = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

// --- Views -----------------------------------------------------------------------------------

function IndexView({ servers, go }: { servers: PublicServer[]; go: (p: string) => void }) {
  return (
    <>
      <PageTitle title="Servers" sub="Live scoreboards and match history" />
      {servers.length === 0 && <div className="card"><p className="muted">No servers are published right now.</p></div>}
      <div className="pub-index">
        {servers.map((s) => <IndexCard key={s.slug} server={s} go={go} />)}
      </div>
    </>
  );
}

function IndexCard({ server, go }: { server: PublicServer; go: (p: string) => void }) {
  const [info, setInfo] = useState<PublicInfo | null>(null);
  const [down, setDown] = useState(false);
  useEffect(() => {
    let stop = false;
    crcon<PublicInfo>(server.slug, "get_public_info").then((i) => { if (!stop) setInfo(i); }).catch(() => { if (!stop) setDown(true); });
    return () => { stop = true; };
  }, [server.slug]);
  // Here the server is the subject and the map the detail, the other way round from its own page.
  return (
    <L href={at(server.slug)} go={go} className="pub-hud-link">
      <HudCard {...liveHud(server, info)} title={server.name} sub={info?.current_map.map?.pretty_name ?? (down ? UNREACHABLE : "…")} />
    </L>
  );
}

function NowView({ server, tab, go }: { server: PublicServer; tab: RoundTab; go: (p: string) => void }) {
  const [stats, setStats] = useState<LiveStats | null>(null);
  const [err, setErr] = useState("");
  const mem = roundMemory(server.slug, "current");
  const [expanded, setExpanded] = useRemembered<string | null>(`${mem}.open`, null, isTextOrNull, "session");
  const [report, reportMissing] = useReport(server.slug, "current");
  useEffect(() => {
    let stop = false;
    // Picking another server in the sidebar keeps this view mounted: the last server's players must
    // not stand on screen under the new server's name while its own are on their way.
    setStats(null); setErr("");
    const load = () => crcon<LiveStats | null>(server.slug, "get_live_game_stats")
      // A null board is a pass that failed with no good one before it: unavailable, not on its way
      // — left as "Loading…", the page waited on it for as long as the figures couldn't be had.
      .then((s) => { if (!s) throw new Error("the round's figures couldn't be worked out"); if (!stop) { setStats(s); setErr(""); } })
      .catch((e) => { if (!stop) setErr((e as Error).message); });
    void load();
    const unpoll = pollWhileVisible(() => void load(), 15_000);
    return () => { stop = true; unpoll(); };
  }, [server.slug]);
  return (
    <>
      <RoundTabs slug={server.slug} id="current" tab={tab} go={go} />
      {tab === "log" && <GameLog slug={server.slug} id="current" />}
      {tab === "report" && !report && <div className="card"><p className="muted">{reportMissing || "Loading…"}</p></div>}
      {tab === "report" && report && !report.complete && (
        <div className="card"><p className="muted">No kills yet this round — the report draws itself as the round goes.</p></div>
      )}
      {tab === "report" && report?.complete && <RoundReport report={report} server={server} remember={mem} />}
      {tab === "players" && (
        <div className="card">
          {stats && <p className="hint" style={{ marginTop: 0 }}>Updates every 15s · tap a player for their round</p>}
          {err && <p className="muted">Live stats are unavailable right now: {err}</p>}
          {!stats && !err && <p className="muted">Loading…</p>}
          {stats && <Scoreboard rows={stats.stats} server={server} onExpand={(row) => setExpanded((v) => (v === row ? null : row))} expanded={expanded} report={report} go={go} remember={`${mem}.board`} />}
        </div>
      )}
    </>
  );
}

/**
 * The Past games page each server's list was last on, so a round's "← Past games" goes back to
 * that page rather than the first: from page 250 into a round and back used to land on page 1. In
 * memory, for this visit only; a round opened from a pasted link goes back to the first page.
 */
const listPageOf = new Map<string, number>();

function GamesView({ server, page, narrow, go }: { server: PublicServer; page: number; narrow: boolean; go: (p: string) => void }) {
  const [data, setData] = useState<RoundPage | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { listPageOf.set(server.slug, page); }, [server.slug, page]);
  useEffect(() => {
    let stop = false;
    crcon<RoundPage>(server.slug, "get_scoreboard_maps", `?page=${page}&limit=25`)
      .then((d) => { if (!stop) { setData(d); setErr(""); } })
      .catch((e) => { if (!stop) setErr((e as Error).message); });
    return () => { stop = true; };
  }, [server.slug, page]);
  const left = server.sides[0], right = server.sides[1];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  // The rows on screen until the asked-for page arrives are the last page's: dimmed, so a click
  // on page 300 that takes a moment reads as working rather than as nothing happening. A reply
  // without a result leaves `data` undefined, not null, and the screen at Loading… as before.
  const stale = !!data && data.page !== page;
  return (
    <div className="card">
      {err && <p className="muted">Past games are unavailable right now.</p>}
      {!data && !err && <p className="muted">Loading…</p>}
      {data && (
        <>
          <div style={{ overflowX: "auto" }} className={stale ? "pub-stale" : undefined} aria-busy={stale || undefined}>
            <table className="pub-games" style={{ width: "100%" }}>
              <thead><tr><th>Map</th><th>Result</th><th>Started</th><th className="num">Length</th></tr></thead>
              <tbody>
                {data.maps.map((m) => {
                  const dur = m.end ? (Date.parse(m.end) - Date.parse(m.start)) / 1000 : null;
                  return (
                    <tr key={m.id}>
                      <td><L href={at(`${server.slug}/games/${m.id}`)} go={go}><strong>{m.map?.pretty_name ?? m.map_name ?? "—"}</strong></L></td>
                      {/* The open round now carries a score too (it is sampled live), so the score
                          alone no longer says "finished" — an unfinished one has to say so, or a
                          reader quotes a running scoreline as the result. */}
                      <td className="pub-result">
                        {m.result
                          ? <><span style={sideInk(left?.color ?? "blue")}>{m.result.allied}</span>
                              <span className="muted"> : </span>
                              <span style={sideInk(right?.color ?? "red")}>{m.result.axis}</span>
                              {!m.end && <span className="muted fs-sm"> · live</span>}</>
                          : <span className="muted" title={m.end ? "This round finished before the score was being recorded." : undefined}>
                              {m.end ? "—" : "in progress"}
                            </span>}
                      </td>
                      <td className="muted">{fmtDate(m.start)}</td>
                      <td className="num muted">{fmtDuration(dur)}</td>
                    </tr>
                  );
                })}
                {data.maps.length === 0 && (
                  <tr><td colSpan={4} className="muted">
                    {!(data.total > 0) ? "No rounds on record yet."
                      : page > pages ? <>There is no page {page}: the rounds end on page {pages}. <L href={at(`${server.slug}/games?page=${pages}`)} go={go}>Go to page {pages}.</L></>
                      // A round removed between the count and the read (a trim, a restore).
                      : "No rounds on this page."}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          {pages > 1 && <GamesPager slug={server.slug} page={page} pages={pages} total={data.total} pageSize={data.page_size} narrow={narrow} go={go} />}
        </>
      )}
    </div>
  );
}

/**
 * The page numbers a pager shows: the first and the last always, and a run of `around` either side
 * of the one showing, kept the same length at either end of the list. A skipped stretch is a gap
 * (null) — unless it is a single page, which is shown instead: "1 … 3" hides one number behind a
 * mark as wide as the number would have been.
 */
function pageWindow(page: number, pages: number, around: number): (number | null)[] {
  const lo = Math.max(1, Math.min(page - around, pages - 2 * around));
  const hi = Math.min(pages, lo + 2 * around);
  const out: (number | null)[] = [];
  if (lo > 1) out.push(1);
  if (lo > 3) out.push(null);
  else if (lo === 3) out.push(2);
  for (let n = lo; n <= hi; n++) out.push(n);
  if (hi < pages - 2) out.push(null);
  else if (hi === pages - 2) out.push(pages - 1);
  if (hi < pages) out.push(pages);
  return out;
}

/**
 * The way through hundreds of pages of rounds: a step either way, the first and last pages, the
 * pages around this one, and a box for any page by its number. Every page is a real link, so one
 * can be opened in a new tab or copied like any other address on the site. A phone shows the first,
 * this and the last page between bare arrows: with neighbours too, three-digit page numbers ran the
 * row past a phone's width and onto a second line.
 */
function GamesPager({ slug, page, pages, total, pageSize, narrow, go }: {
  slug: string; page: number; pages: number; total: number; pageSize: number; narrow: boolean; go: (p: string) => void;
}) {
  const [want, setWant] = useState("");
  const href = (n: number) => at(`${slug}/games?page=${n}`);
  // A page past the end (an old link, a typed address) steps back onto the list, not further off it.
  const newer = page > pages ? pages : page - 1;
  const first = (page - 1) * pageSize + 1;
  const jump = (e: React.FormEvent) => {
    e.preventDefault();
    const n = Math.trunc(Number(want.trim()));
    if (!Number.isFinite(n) || n < 1) return;
    const to = Math.min(n, pages);
    setWant("");
    // Off the box, or a phone keeps its keyboard up over the page it just opened.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (to !== page) go(href(to));
  };
  return (
    <nav className="pub-pager" aria-label="Pages">
      <div className="pub-pages">
        {newer >= 1 && (
          <L href={href(newer)} go={go} className="pub-pg" title="Newer rounds"><span aria-hidden>←</span>{!narrow && "Newer"}</L>
        )}
        {pageWindow(Math.min(page, pages), pages, narrow ? 0 : 2).map((n, i) => n === null
          ? <span key={`gap${i}`} className="pub-pg-gap" aria-hidden>…</span>
          : <L key={n} href={href(n)} go={go} className="pub-pg" current={n === page} title={`Page ${n}`}>{n}</L>)}
        {page < pages && (
          <L href={href(page + 1)} go={go} className="pub-pg" title="Older rounds">{!narrow && "Older"}<span aria-hidden>→</span></L>
        )}
      </div>
      <form className="pub-pg-jump" onSubmit={jump} noValidate>
        {first <= total && (
          <span className="muted fs-sm">{first.toLocaleString()}–{Math.min(page * pageSize, total).toLocaleString()} of {counted(total, "round")}</span>
        )}
        <label className="inline">
          Go to page
          <input value={want} onChange={(e) => setWant(e.target.value)} inputMode="numeric" enterKeyHint="go"
            placeholder={`1–${pages}`} aria-label={`Page number, 1 to ${pages}`} />
        </label>
        <button type="submit" className="pub-pg" disabled={want.trim() === ""}>Go</button>
      </form>
    </nav>
  );
}

function RoundView({ server, id, tab, go }: { server: PublicServer; id: number; tab: RoundTab; go: (p: string) => void }) {
  const [round, setRound] = useState<RoundRow | null>(null);
  const [err, setErr] = useState("");
  const mem = roundMemory(server.slug, id);
  const [expanded, setExpanded] = useRemembered<string | null>(`${mem}.open`, null, isTextOrNull, "session");
  const [report, reportMissing] = useReport(server.slug, id);
  useEffect(() => {
    let stop = false;
    crcon<RoundRow>(server.slug, "get_map_scoreboard", `?map_id=${id}`)
      .then((r) => { if (!stop) { setRound(r); setErr(""); } })
      .catch((e) => { if (!stop) setErr((e as Error).message); });
    return () => { stop = true; };
  }, [server.slug, id]);
  const left = server.sides[0], right = server.sides[1];
  const dur = round?.end ? (Date.parse(round.end) - Date.parse(round.start)) / 1000 : null;
  const onSide = (side: string | undefined) => (side && round ? round.player_stats.filter((p) => sideOfRow(p) === side).length : null);
  const mapName = round ? round.map?.pretty_name ?? round.map_name : null;
  const listPage = listPageOf.get(server.slug) ?? 1;
  return (
    <>
      <div className="pub-crumbs">
        <L href={at(`${server.slug}/games${listPage > 1 ? `?page=${listPage}` : ""}`)} go={go}>← Past games</L>
        {mapName && <><span className="crumb-sep" aria-hidden>/</span><span>{mapName}</span></>}
      </div>
      {/* The round's own HUD — its final score, never the live one: printing the running score over
          a finished scoreboard is how a reader ends up quoting the wrong one. */}
      {round && (
        <HudCard
          title={mapName}
          sub={server.name}
          art={mapImageUrl(round.map_name, server.game)}
          sides={[
            { label: left?.label ?? "Allies", color: left?.color ?? "blue", score: round.result?.allied ?? null, count: onSide(left?.id) },
            { label: right?.label ?? "Axis", color: right?.color ?? "red", score: round.result?.axis ?? null, count: onSide(right?.id) },
          ]}
          meta={[
            { label: "Played", value: fmtWhen(round.start), title: fmtDate(round.start) },
            { label: "Length", value: fmtDuration(dur) },
          ]}
        />
      )}
      {err && <div className="card"><p className="muted">{err === NO_SCOREBOARD ? "This round isn't on record." : "This round is unavailable right now."}</p></div>}
      {!round && !err && <div className="card"><p className="muted">Loading…</p></div>}
      <RoundTabs slug={server.slug} id={id} tab={tab} go={go} />
      {tab === "log" && <GameLog slug={server.slug} id={id} />}
      {tab === "report" && !report && !err && <div className="card"><p className="muted">{reportMissing || "Loading…"}</p></div>}
      {/* A round that is still running gets no "missing kill log" note — it is not missing, it is
          being written. Only a FINISHED round without one earns the honest empty state. */}
      {tab === "report" && report && !report.complete && (
        <div className="card"><p className="muted">
          {round?.end ? "No kill log was captured for this round, so only the scoreboard exists for it." : "No kills yet this round — the report draws itself as the round goes."}
        </p></div>
      )}
      {tab === "report" && report?.complete && <RoundReport report={report} server={server} roundSecs={dur === null ? null : Math.round(dur)} remember={mem} />}
      {tab === "players" && round && (
        <div className="card">
          {report?.complete && <p className="hint" style={{ marginTop: 0 }}>Tap a player for their round — weapons, nemesis, and their own kill timeline.</p>}
          <Scoreboard rows={round.player_stats} server={server} onExpand={(row) => setExpanded((v) => (v === row ? null : row))} expanded={expanded}
            report={report} roundSecs={dur === null ? null : Math.round(dur)} go={go} remember={`${mem}.board`} />
        </div>
      )}
    </>
  );
}

// --- Server stats ----------------------------------------------------------------------------

/** The wire of /api/public/<slug>/stats — aggregates only, names only. */
interface ServerStatsWire {
  scannedMatches: number;
  truncated: boolean;
  overview: { matches: number; avgMinutes: number | null; alliesWins: number; axisWins: number; attackersWinPct: number | null };
  maps: { id: string; name: string; mode: string; played: number; avgMinutes: number; alliesWins: number; axisWins: number }[];
  quality: { contested: number; decisive: number; stomp: number; crash: number; other: number; scored: number };
  activity: { day: string; matches: number }[];
  /** null when no round in the window carries participant data — the card hides, never guesses. */
  seeding: {
    measuredRounds: number; seededShare: number; avgPlayers: number;
    hoursUtc: number[];
    heroes: { name: string; rounds: number }[];
    killers: { map: string; drops: number; after: number }[];
  } | null;
  records: Record<"kills" | "combat" | "support", { name: string; side: string | null; value: number; map: string; seq: number; at: string }[]>;
  regulars: { playtime: { name: string; hours: number }[]; kills: { name: string; kills: number }[] };
  classRecords: {
    classId: string; label: string;
    best: { name: string; side: string | null; value: number; map: string; seq: number; at: string; weapon?: string }[];
    career: { name: string; kills: number }[];
    deaths: { name: string; deaths: number }[];
  }[];
  weaponRecords: {
    weapon: string; classId: string; label: string; totalKills: number;
    best: { name: string; side: string | null; value: number; map: string; seq: number; at: string }[];
    career: { name: string; kills: number }[];
    deaths: { name: string; deaths: number }[];
  }[];
}

function RecordsBlock({ title, rows, server, go, fmt = (n: number) => n.toLocaleString() }: {
  title: string; rows: { name: string; value: number; map: string; seq: number; at: string }[];
  server: PublicServer; go: (p: string) => void; fmt?: (n: number) => string;
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <div className="hint">{title}</div>
      <table className="mini-table"><tbody>
        {rows.map((r, i) => (
          <tr key={`${r.seq}-${i}`}>
            <td>
              <strong>{r.name}</strong>
              <div className="muted fs-sm">
                <L href={at(`${server.slug}/games/${r.seq}`)} go={go}>{r.map}</L> · {new Date(r.at).toLocaleDateString()}
              </div>
            </td>
            <td className="num"><strong>{fmt(r.value)}</strong></td>
          </tr>
        ))}
      </tbody></table>
    </div>
  );
}

/**
 * What this server is like to play on, from its own recorded rounds: the maps and who wins them,
 * how rounds tend to end, how busy the month was, the records worth arguing about, and the
 * regulars. All aggregates arrive precomputed — the page only draws.
 */
function ServerStatsView({ server, go }: { server: PublicServer; go: (p: string) => void }) {
  const [stats, setStats] = useState<ServerStatsWire | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let stop = false;
    setStats(null); setErr(""); // as the career view: a history jump between two servers keeps this mounted
    fetch(`/api/public/${encodeURIComponent(server.slug)}/stats`)
      .then((r) => (r.ok ? (r.json() as Promise<{ stats?: ServerStatsWire }>) : Promise.reject(new Error(`${r.status}`))))
      // A reply without the figures is unavailable, not on its way: it left the page at Loading….
      .then((d) => { if (!d.stats) throw new Error("no figures in the reply"); if (!stop) setStats(d.stats); })
      .catch((e) => { if (!stop) setErr((e as Error).message); });
    return () => { stop = true; };
  }, [server.slug]);
  const left = server.sides[0], right = server.sides[1];

  const activityPoints: ProgPoint[] = useMemo(
    () => (stats?.activity ?? []).map((a) => ({ x: a.day, label: a.day.slice(5), values: { matches: a.matches } })),
    [stats],
  );

  // Seeded-start hours, shifted from the wire's UTC buckets into THIS VISITOR's clock — the same
  // device-zone rule as every other timestamp on the public site.
  const busyHours: Bar[] = useMemo(() => {
    const hoursUtc = stats?.seeding?.hoursUtc;
    if (!hoursUtc || !hoursUtc.some((n) => n > 0)) return [];
    const off = Math.round(-new Date().getTimezoneOffset() / 60);
    return hoursUtc.map((_, local) => {
      const utc = (((local - off) % 24) + 24) % 24;
      return { label: `${String(local).padStart(2, "0")}`, value: hoursUtc[utc] ?? 0, hint: `${String(local).padStart(2, "0")}:00 your time` };
    });
  }, [stats]);

  if (err) return <div className="card"><p className="muted">Server stats are unavailable right now.</p></div>;
  if (!stats) return <div className="card"><p className="muted">Loading…</p></div>;
  if (stats.overview.matches === 0) return <div className="card"><p className="muted">No rounds on record yet — stats appear once the first round finishes.</p></div>;

  const o = stats.overview;
  const decidedPct = (a: number, x: number) => {
    const total = a + x;
    if (total < 5) return null; // too few decided rounds to call a lean honestly
    const alliesLead = a >= x;
    return `${Math.round(((alliesLead ? a : x) / total) * 100)}% ${alliesLead ? left?.label ?? "Allies" : right?.label ?? "Axis"}`;
  };
  const q = stats.quality;

  return (
    <>
      <div className="card">
        <StatGrid>
          <StatTile label="Rounds recorded" value={o.matches.toLocaleString()} sub={stats.truncated ? `last ${stats.scannedMatches.toLocaleString()}` : undefined} />
          <StatTile label="Average round" value={o.avgMinutes !== null ? `${o.avgMinutes}m` : "—"} />
          <StatTile label={`${left?.label ?? "Allies"} wins`} value={String(o.alliesWins)} />
          <StatTile label={`${right?.label ?? "Axis"} wins`} value={String(o.axisWins)} />
          {o.attackersWinPct !== null && <StatTile label="Attackers win" value={`${o.attackersWinPct}%`} sub="offensive rounds" />}
        </StatGrid>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
          <strong>Activity</strong>
          <span className="muted fs-sm">rounds per day, last 4 weeks</span>
        </div>
        <Progression points={activityPoints} series={[{ key: "matches", label: "Rounds", colorIndex: 2 }]} windows={[]} />
      </div>

      {stats.maps.length > 0 && (
        <div className="card">
          <strong>Maps</strong>
          <p className="hint">The rotation as it actually ran — a win lean is only shown once a map has five decided rounds.</p>
          <div style={{ overflowX: "auto" }}>
            <table className="mini-table">
              <thead><tr><th>Map</th><th className="num">Played</th><th className="num">Avg</th><th className="num">Lean</th></tr></thead>
              <tbody>
                {stats.maps.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name}</td>
                    <td className="num">{m.played}</td>
                    <td className="num">{m.avgMinutes}m</td>
                    <td className="num">{decidedPct(m.alliesWins, m.axisWins) ?? <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {stats.seeding && (
        <div className="card">
          <strong>Seeding</strong>
          <p className="hint">From the {counted(stats.seeding.measuredRounds, "round")} with recorded players. Seeded means the round had 60+ in it.</p>
          <StatGrid>
            <StatTile label="Seeded rounds" value={`${stats.seeding.seededShare}%`} />
            <StatTile label="Average players" value={String(stats.seeding.avgPlayers)} sub="per round" />
          </StatGrid>
          {busyHours.length > 0 && (
            <>
              <div className="hint" style={{ marginTop: 8 }}>When seeded rounds start — hours in your time zone</div>
              <Bars data={busyHours} colorIndex={2} />
            </>
          )}
          {(stats.seeding.heroes.length > 0 || stats.seeding.killers.length > 0) && (
            <div className="pd-grid" style={{ marginTop: 8 }}>
              {stats.seeding.heroes.length > 0 && (
                <div>
                  <div className="hint">Seeding heroes — most low-pop rounds played</div>
                  <table className="mini-table"><tbody>
                    {stats.seeding.heroes.map((h) => (
                      <tr key={h.name}><td>{h.name}</td><td className="num">{counted(h.rounds, "round")}</td></tr>
                    ))}
                  </tbody></table>
                </div>
              )}
              {stats.seeding.killers.length > 0 && (
                <div>
                  <div className="hint">Server-killer maps — loaded after a seeded round and emptied it</div>
                  <table className="mini-table"><tbody>
                    {stats.seeding.killers.map((k) => (
                      <tr key={k.map}><td>{k.map}</td><td className="num">{k.drops} of {k.after}</td></tr>
                    ))}
                  </tbody></table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {q.scored > 0 && (
        <div className="card">
          <strong>How rounds end</strong>
          <p className="hint">By the final score&apos;s gap: 3–2 contested, 4–1 decisive, 5–0 a stomp. A 2–2 is almost always a server crash, and is counted as one.</p>
          <SplitBar
            slices={[
              { key: "contested", label: "Contested", value: q.contested, colorIndex: 2 },
              { key: "decisive", label: "Decisive", value: q.decisive, colorIndex: 3 },
              { key: "stomp", label: "Stomp", value: q.stomp, colorIndex: 4 },
              // Slot 6 (violet), not 5's green — slot 2's green already means "contested", and a
              // bar whose first and last slices share a hue reads as the same thing twice.
              ...(q.crash > 0 ? [{ key: "crash", label: "Crash (2–2)", value: q.crash, colorIndex: 6 }] : []),
            ]}
          />
          {o.alliesWins + o.axisWins > 0 && (
            <p className="muted fs-sm" style={{ marginTop: 8 }}>
              {left?.label ?? "Allies"} win {Math.round((o.alliesWins / (o.alliesWins + o.axisWins)) * 100)}% of decided rounds
              {o.attackersWinPct !== null && <> · attackers win {o.attackersWinPct}% of offensives</>}
            </p>
          )}
        </div>
      )}

      {stats.classRecords.length > 0 && (
        <div className="card">
          <strong>Weapon records</strong>
          <p className="hint">Per weapon class: the best single round ever recorded here, and the all-time leader. Tap a map for that round.</p>
          <div style={{ overflowX: "auto" }}>
            <table className="mini-table">
              <thead><tr><th>Class</th><th>Best round</th><th className="num">Kills</th><th>All-time</th><th className="num">Kills</th><th>Dies to it most</th><th className="num">Deaths</th></tr></thead>
              <tbody>
                {stats.classRecords.map((c) => (
                  <tr key={c.classId}>
                    <td>{c.label}</td>
                    <td>
                      {c.best[0] ? (
                        <>
                          <strong>{c.best[0].name}</strong>
                          <div className="muted fs-sm">
                            {c.best[0].weapon && <>{c.best[0].weapon} · </>}
                            <L href={at(`${server.slug}/games/${c.best[0].seq}`)} go={go}>{c.best[0].map}</L>
                          </div>
                        </>
                      ) : <span className="muted">—</span>}
                    </td>
                    <td className="num"><strong>{c.best[0]?.value ?? ""}</strong></td>
                    <td>{c.career[0]?.name ?? <span className="muted">—</span>}</td>
                    <td className="num">{c.career[0]?.kills.toLocaleString() ?? ""}</td>
                    <td>{c.deaths[0]?.name ?? <span className="muted">—</span>}</td>
                    <td className="num">{c.deaths[0]?.deaths.toLocaleString() ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {stats.weaponRecords.length > 0 && (
        <div className="card">
          <strong>Individual weapons</strong>
          <p className="hint">The server&apos;s most-used weapons — the best single round and the all-time leader for each. Tap a map for that round.</p>
          <div style={{ overflowX: "auto" }}>
            <table className="mini-table">
              <thead><tr><th>Weapon</th><th>Best round</th><th className="num">Kills</th><th>All-time</th><th className="num">Kills</th><th>Dies to it most</th><th className="num">Deaths</th><th className="num">Total</th></tr></thead>
              <tbody>
                {stats.weaponRecords.map((w) => (
                  <tr key={w.weapon}>
                    <td>
                      {w.weapon}
                      <div className="muted fs-sm">{w.label}</div>
                    </td>
                    <td>
                      {w.best[0] ? (
                        <>
                          <strong>{w.best[0].name}</strong>
                          <div className="muted fs-sm"><L href={at(`${server.slug}/games/${w.best[0].seq}`)} go={go}>{w.best[0].map}</L></div>
                        </>
                      ) : <span className="muted">—</span>}
                    </td>
                    <td className="num"><strong>{w.best[0]?.value ?? ""}</strong></td>
                    <td>{w.career[0]?.name ?? <span className="muted">—</span>}</td>
                    <td className="num">{w.career[0]?.kills.toLocaleString() ?? ""}</td>
                    <td>{w.deaths[0]?.name ?? <span className="muted">—</span>}</td>
                    <td className="num">{w.deaths[0]?.deaths.toLocaleString() ?? ""}</td>
                    <td className="num muted">{w.totalKills.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(stats.records.kills.length > 0 || stats.regulars.playtime.length > 0) && (
        <div className="card">
          <strong>Records &amp; regulars</strong>
          <p className="hint">Best single rounds ever recorded here, and the people who practically live on this server. Tap a record&apos;s map for that round.</p>
          <div className="pd-grid" style={{ marginTop: 8 }}>
            <RecordsBlock title="Most kills in a round" rows={stats.records.kills} server={server} go={go} />
            <RecordsBlock title="Top combat score" rows={stats.records.combat} server={server} go={go} />
            <RecordsBlock title="Top support score" rows={stats.records.support} server={server} go={go} />
            {stats.regulars.playtime.length > 0 && (
              <div>
                <div className="hint">Most playtime</div>
                <table className="mini-table"><tbody>
                  {stats.regulars.playtime.map((r) => (
                    <tr key={r.name}><td>{r.name}</td><td className="num">{r.hours}h</td></tr>
                  ))}
                </tbody></table>
              </div>
            )}
            {stats.regulars.kills.length > 0 && (
              <div>
                <div className="hint">Most career kills</div>
                <table className="mini-table"><tbody>
                  {stats.regulars.kills.map((r) => (
                    <tr key={r.name}><td>{r.name}</td><td className="num">{r.kills.toLocaleString()}</td></tr>
                  ))}
                </tbody></table>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// --- Player career ---------------------------------------------------------------------------

/** The wire of /api/public/<slug>/player/<platform_id> — one player's life on one server. */
interface PublicCareer {
  player: { name: string | null; platform: string | null; platformId: string };
  career: {
    kills: number; deaths: number; teamkills: number; playtimeSec: number; visits: number;
    combat: number; offense: number; defense: number; support: number;
    slSeconds: number; matchesPlayed: number; matchesWon: number; highestLevel: number;
  } | null;
  roles: { role: string; seconds: number }[];
  weapons: { weapon: string; kills: number }[];
  deathsTo: { weapon: string; deaths: number }[];
  rounds: { seq: number; map: string; startedAt: string; endedAt: string | null; side: string | null; kills: number; deaths: number; won: boolean | null }[];
}

/**
 * One player's career on this server — where a scoreboard name lands. Career totals when the
 * rollup has them, recent rounds always (each linking to its round page), role time named by the
 * game. Only reachable on servers publishing platform ids; the API refuses everywhere else.
 */
function PlayerCareerView({ server, pid, go }: { server: PublicServer; pid: string; go: (p: string) => void }) {
  const [data, setData] = useState<PublicCareer | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let stop = false;
    // Both halves: this view stays mounted when only the player changes (a history jump between
    // two career pages), and an error left over from one player would blank the next one's page.
    setData(null); setErr("");
    fetch(`/api/public/${encodeURIComponent(server.slug)}/player/${encodeURIComponent(pid)}`)
      .then((r) => (r.ok ? (r.json() as Promise<PublicCareer>) : Promise.reject(new Error(String(r.status)))))
      // A reply without the player is no career to draw: drawn as it came, it took the whole site
      // down. Said as unavailable, as any read that failed is.
      .then((d) => { if (!d?.player) throw new Error("no player in the reply"); if (!stop) setData(d); })
      .catch((e) => { if (!stop) setErr((e as Error).message); });
    return () => { stop = true; };
  }, [server.slug, pid]);
  const sideLabel = (side: string | null) => server.sides.find((s) => s.id === side)?.label ?? side ?? "—";

  // Only the server's not-found answer means there is no career. Anything else — the address over
  // its limit for the minute, the database not answering — is a read that failed, said as such.
  if (err) {
    return (
      <div className="card"><p className="muted">
        {err === "404" ? "No career here for this player." : "This player's career is unavailable right now."}{" "}
        <L href={at(server.slug)} go={go}>Back to the server.</L>
      </p></div>
    );
  }
  if (!data) return <div className="card"><p className="muted">Loading…</p></div>;

  const c = data.career;
  const kd = c ? (c.deaths > 0 ? (c.kills / c.deaths).toFixed(2) : String(c.kills)) : null;
  return (
    <>
      <div className="card">
        <div className="row" style={{ gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
          <strong className="profile-name" style={{ fontSize: "1.15rem" }}>{data.player.name ?? "[No Name]"}</strong>
          {data.player.platform && <span className="badge" title={data.player.platform}>{platformLabel(data.player.platform)}</span>}
          <code className="fs-sm muted">{data.player.platformId}</code>
        </div>
        {c ? (
          <StatGrid>
            <StatTile label="Kills" value={c.kills.toLocaleString()} />
            <StatTile label="Deaths" value={c.deaths.toLocaleString()} />
            <StatTile label="K/D" value={kd ?? "—"} />
            <StatTile label="Time played" value={`${Math.round(c.playtimeSec / 3600)}h`} sub={counted(c.visits, "visit")} />
            <StatTile label="Rounds" value={String(c.matchesPlayed)} sub={c.matchesPlayed > 0 ? `${Math.round((c.matchesWon / c.matchesPlayed) * 100)}% won` : undefined} />
            {c.slSeconds > 0 && <StatTile label="Squad-lead time" value={`${Math.round(c.slSeconds / 3600)}h`} />}
            {c.highestLevel > 0 && <StatTile label="Highest level" value={String(c.highestLevel)} />}
          </StatGrid>
        ) : (
          <p className="muted">No career totals recorded yet — the rounds below are what this server has seen.</p>
        )}
        {(data.roles.length > 0 || data.weapons.length > 0 || data.deathsTo.length > 0) && (
          <div className="pd-grid" style={{ marginTop: 8 }}>
            {data.roles.length > 0 && (
              <div>
                <div className="hint">Plays as</div>
                <table className="mini-table"><tbody>
                  {data.roles.map((r) => (
                    <tr key={r.role}><td>{r.role}</td><td className="num">{fmtDuration(r.seconds)}</td></tr>
                  ))}
                </tbody></table>
              </div>
            )}
            {data.weapons.length > 0 && (
              <div>
                <div className="hint">Top weapons — career kills here</div>
                <table className="mini-table"><tbody>
                  {data.weapons.map((w) => (
                    <tr key={w.weapon}><td>{w.weapon}</td><td className="num">{w.kills.toLocaleString()}</td></tr>
                  ))}
                </tbody></table>
              </div>
            )}
            {data.deathsTo.length > 0 && (
              <div>
                <div className="hint">Dies to — career deaths here</div>
                <table className="mini-table"><tbody>
                  {data.deathsTo.map((w) => (
                    <tr key={w.weapon}><td>{w.weapon}</td><td className="num">{w.deaths.toLocaleString()}</td></tr>
                  ))}
                </tbody></table>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="card">
        <strong>Recent rounds here</strong>
        {data.rounds.length === 0 && <p className="muted">No recorded rounds.</p>}
        {data.rounds.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="mini-table">
              <thead><tr><th>Map</th><th>Side</th><th className="num">K</th><th className="num">D</th><th>Result</th><th>When</th></tr></thead>
              <tbody>
                {data.rounds.map((r) => (
                  <tr key={r.seq}>
                    <td><L href={at(`${server.slug}/games/${r.seq}`)} go={go}>{r.map}</L></td>
                    <td>{sideLabel(r.side)}</td>
                    <td className="num">{r.kills}</td>
                    <td className="num">{r.deaths}</td>
                    <td>{r.won === null ? <span className="muted">—</span> : r.won ? "Won" : "Lost"}</td>
                    <td className="muted">{fmtDate(r.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// --- The shell ---------------------------------------------------------------------------------

/** The brand mark: the community's initial in the panel's gradient square. Never the admin
 *  software's mark, and never an image — the public hostname serves no /brand files at all. */
function BrandMark({ name }: { name: string | null }) {
  const initial = (name ?? "").replace(/[^\p{L}\p{N}]/gu, "").charAt(0).toUpperCase();
  return <span className="brand-mark" aria-hidden>{initial || "S"}</span>;
}

/** The brand's words: the community's name with "Stats" under it, or just "Stats" for an install
 *  that named none — two short lines where "Name · Stats" on one would not fit the sidebar. */
function BrandName({ siteName }: { siteName: string | null }) {
  return (
    <span className="pub-brand-text">
      <span className="brand-name">{siteName ?? "Stats"}</span>
      {siteName && <span className="pub-brand-sub">Stats</span>}
    </span>
  );
}

/** Where the sidebar's rail-or-full choice is kept, per browser, apart from the panel's own. */
const SIDEBAR_KEY = "public.sidebar";

interface NavSub { href: string; label: string; active: boolean }

/**
 * The sidebar, the panel's own: the open server's screens, each one's sub-screens listed under it
 * while it is open (a round's Players, Round report and Game log), then the other servers, and
 * the theme switch at the foot. On a phone it is the panel's drawer.
 */
function PublicSidebar({ route, server, servers, siteTitle, siteName, go, theme, onFlipTheme, collapsed, onToggleCollapsed }: {
  route: Route; server: PublicServer | null; servers: PublicServer[] | null;
  siteTitle: string; siteName: string | null; go: (p: string) => void;
  theme: PublicThemeMode; onFlipTheme: () => void;
  collapsed: boolean; onToggleCollapsed: () => void;
}) {
  const entry = (href: string, icon: string, label: string, active: boolean, sub: NavSub[] = [], extraClass = "") => (
    <div key={href} className="nav-entry">
      <L href={href} go={go} className={`nav-item${active ? " active" : ""}${extraClass}`} current={active && !sub.some((x) => x.active)} title={label}>
        <span className="ico"><Icon name={icon} /></span>
        <span className="nav-label">{label}</span>
      </L>
      {sub.length > 0 && (
        <div className="nav-subnav">
          {sub.map((x) => (
            <L key={x.href} href={x.href} go={go} className={`nav-subitem${x.active ? " active" : ""}`} current={x.active}>{x.label}</L>
          ))}
        </div>
      )}
    </div>
  );
  const roundSub = (slug: string, id: number | "current", tab: RoundTab): NavSub[] =>
    ROUND_TABS.map((t) => ({ href: roundHref(slug, id, t.id), label: t.label, active: tab === t.id }));
  const view = route.view;
  const others = servers ?? [];
  return (
    <aside className="sidebar">
      <div className="brand">
        <L href={HOME} go={go} className="pub-brand" title={siteTitle}>
          <BrandMark name={siteName} />
          <BrandName siteName={siteName} />
        </L>
        <button className="collapse-btn" title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={onToggleCollapsed}>{collapsed ? "»" : "«"}</button>
      </div>
      <nav className="nav" aria-label="Stats">
        {server && (
          <div className="nav-group">
            {/* With one server there is nothing to tell apart; with several, this says whose screens these are. */}
            {others.length > 1 && <div className="nav-group-label" title={server.name}>{server.name}</div>}
            {entry(at(server.slug), "live", "Now playing", view === "now", view === "now" ? roundSub(server.slug, "current", route.tab) : [])}
            {entry(at(`${server.slug}/games`), "matches", "Past games", view === "games" || view === "round",
              view === "round" ? roundSub(server.slug, route.id, route.tab) : [])}
            {entry(at(`${server.slug}/server`), "leaderboard", "Server stats", view === "server")}
            {view === "player" && entry(at(`${server.slug}/player/${encodeURIComponent(route.pid)}`), "players", "Player career", true)}
          </div>
        )}
        {(others.length > 1 || (!server && others.length > 0)) && (
          <div className="nav-group">
            <div className="nav-group-label">Servers</div>
            {others.length > 1 && entry(HOME, "dashboard", "All servers", view === "index")}
            {others.map((s) => entry(at(s.slug), "servers", s.name, false, [], s.slug === server?.slug ? " pub-here" : ""))}
          </div>
        )}
      </nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-footer">
        {/* The button names the mode it switches TO, so it reads as an action, not a status. */}
        <button className="nav-item" onClick={onFlipTheme} aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
          <span className="ico" aria-hidden>{theme === "dark" ? "☀️" : "🌙"}</span>
          <span className="nav-label">{theme === "dark" ? "Light mode" : "Dark mode"}</span>
        </button>
      </div>
    </aside>
  );
}

export default function PublicStatsApp() {
  const [route, go] = useRoute();
  const [servers, setServers] = useState<PublicServer[] | null>(null);
  /*
   * The community's name, when the operator set PUBLIC_STATS_NAME — and NOTHING otherwise.
   *
   * This used to fall back to the app's own name, so an unconfigured install published a page
   * headed "hellrcon · Stats" to every player who opened it. Players have no idea what the
   * software is called and no reason to care; the admin tool's name on a public page is a leak,
   * not a default. Unset now means the page is simply called "Stats", which is true of every
   * install and gives nothing away.
   */
  const [siteName, setSiteName] = useState<string | null>(null);
  // The site's public address, when it has one: what the APIs panel's links carry.
  const [siteOrigin, setSiteOrigin] = useState<string | null>(null);
  const [err, setErr] = useState("");
  /*
   * The public site's own theme — dark by default, flipped by the sidebar's switch, remembered per
   * browser. State starts at the default rather than the stored value because the exported HTML
   * was rendered without this visitor's storage, and hydrating against a different value would
   * mismatch; the PAGE never flashes either way (the inline script in app/stats/page.tsx stamped
   * <html> before first paint), so the effect only corrects which label the button wears.
   */
  const [theme, setTheme] = useState<PublicThemeMode>("dark");
  useEffect(() => { setTheme(readPublicTheme()); }, []);
  const flipTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    savePublicTheme(next);
  };
  // The panel's shell, its behaviour included: a sidebar beside the page that can fold to a rail,
  // and on a phone a drawer over it that any navigation closes (it covers what was just opened).
  const [narrow, setNarrow] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const nav = useCallback((p: string) => { setDrawerOpen(false); go(p); }, [go]);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 860px)");
    const sync = () => { setNarrow(mq.matches); if (!mq.matches) setDrawerOpen(false); };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  // While the drawer is open it owns the screen: Escape closes it and the page behind can't scroll.
  useEffect(() => {
    if (!drawerOpen) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawerOpen(false); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onEsc);
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onEsc); };
  }, [drawerOpen]);
  useEffect(() => {
    try { setCollapsed(localStorage.getItem(SIDEBAR_KEY) === "collapsed"); } catch { /* storage blocked: open it is */ }
  }, []);
  const toggleCollapsed = () => setCollapsed((c) => {
    const next = !c;
    try { localStorage.setItem(SIDEBAR_KEY, next ? "collapsed" : "open"); } catch { /* still folds for this visit */ }
    return next;
  });
  // A drawer is hidden already, so on a phone it always opens at full width, labels and all.
  const railed = collapsed && !narrow;

  useEffect(() => {
    fetch("/api/public/servers")
      .then(async (r) => {
        // A refusal is not an empty list. Read as one — no `servers` in an error's body — it told a
        // visitor holding a good link "No published server at this address", and the front page
        // "No servers are published right now".
        const d = (await r.json().catch(() => null)) as { servers?: PublicServer[]; site?: { name?: string | null; origin?: string | null } } | null;
        if (!r.ok || !d || !Array.isArray(d.servers)) throw new Error(String(r.status));
        return { servers: d.servers, site: d.site };
      })
      .then((d) => {
        setServers(d.servers);
        if (d.site?.name) setSiteName(d.site.name);
        if (d.site?.origin) setSiteOrigin(d.site.origin);
      })
      .catch(() => setErr("The stats couldn't be loaded right now. Try again in a minute."));
  }, []);
  const server = "slug" in route ? servers?.find((s) => s.slug === route.slug) ?? null : null;
  const siteTitle = siteName ? `${siteName} · Stats` : "Stats";
  // The APIs this screen is built from, behind the button at its top right.
  const apis = useMemo(() => (servers ? apisFor(route, server, servers) : []), [route, server, servers]);
  const [apisOpen, setApisOpen] = useState(false);
  const closeApis = useCallback(() => setApisOpen(false), []);
  const apisButton = apis.length > 0 && (
    <button type="button" className="pub-apis-btn" aria-haspopup="dialog" aria-expanded={apisOpen}
      title="The public APIs this screen is built from, and what they answer now" onClick={() => setApisOpen(true)}>APIs</button>
  );
  /*
   * The browser tab: a server's own pages after that server, the rest after the site.
   *
   * The static export serves this page from the same root layout as the panel, whose metadata
   * title is the app's name — so the public tab read "hellrcon" whatever the page itself said.
   */
  useEffect(() => {
    document.title = server ? `${server.name} — stats` : siteTitle;
  }, [server, siteTitle]);

  return (
    <div className={`app-shell pub-shell${railed ? " collapsed" : ""}${drawerOpen ? " drawer-open" : ""}`}>
      {/* Phone-only chrome: the drawer handle and the brand stay on screen; the sidebar slides in. */}
      <header className="topbar">
        <button className="burger" onClick={() => setDrawerOpen(true)} aria-label="Open navigation" aria-expanded={drawerOpen}>☰</button>
        <L href={HOME} go={nav} className="brand pub-brand" title={siteTitle}>
          <BrandMark name={siteName} />
          <BrandName siteName={siteName} />
        </L>
        <span className="topbar-spacer" />
        {apisButton}
      </header>
      <div className="scrim" onClick={() => setDrawerOpen(false)} aria-hidden />
      <PublicSidebar route={route} server={server} servers={servers} siteTitle={siteTitle} siteName={siteName} go={nav}
        theme={theme} onFlipTheme={flipTheme} collapsed={railed} onToggleCollapsed={toggleCollapsed} />
      <main className="content">
        {/* minmax(0, 1fr), not an implicit auto column: an auto column grew to the scoreboard's full
            width, so on a phone the whole page laid out ~650px wide and panned sideways, and the
            table's own sideways scroller never engaged. */}
        <div className="pub-main">
          {/* On a phone the top bar carries the button. */}
          {apisButton && <div className="pub-toolbar">{apisButton}</div>}
          {err && <div className="card"><p className="muted">{err}</p></div>}
          {!servers && !err && <div className="card"><p className="muted">Loading…</p></div>}
          {servers && route.view === "index" && <IndexView servers={servers} go={nav} />}
          {servers && "slug" in route && !server && (
            <div className="card"><p className="muted">No published server at this address. <L href={HOME} go={nav}>See what is.</L></p></div>
          )}
          {server && route.view === "now" && (
            <><LiveHud server={server} go={nav} here /><NowView server={server} tab={route.tab} go={nav} /></>
          )}
          {server && route.view === "games" && (
            <><LiveHud server={server} go={nav} /><PageTitle title="Past games" /><GamesView server={server} page={route.page} narrow={narrow} go={nav} /></>
          )}
          {server && route.view === "round" && <RoundView server={server} id={route.id} tab={route.tab} go={nav} />}
          {server && route.view === "server" && (
            <><LiveHud server={server} go={nav} /><PageTitle title="Server stats" sub="From this server's recorded rounds" /><ServerStatsView server={server} go={nav} /></>
          )}
          {server && route.view === "player" && <PlayerCareerView server={server} pid={route.pid} go={nav} />}
        </div>
      </main>
      {apisOpen && <ApisPanel apis={apis} origin={siteOrigin} onClose={closeApis} />}
    </div>
  );
}
