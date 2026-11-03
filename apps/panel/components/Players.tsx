"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmt, wasFiled } from "../lib/api";
import { useToast, usePrompt, useConfirm } from "../lib/feedback";
import { PanelGroup, Panel } from "./Panel";
import { PlayerScoreStats, hasScoreData } from "./PlayerScorePanel";
import { PlayerLink } from "./PlayerLink";
import { GameId } from "./GameId";
import { PlayerActions } from "./PlayerActions";
import { StatLinksMenu } from "./StatLinksMenu";
import { StatGrid, StatTile, BreakdownBars, Progression, type ProgPoint } from "./viz";
import { PlayerCombatPanels, type CombatAnalytics } from "./PlayerCombat";
import { PlayerMapVotes } from "./PlayerMapVotes";
import { VipHistory } from "./VipHistory";
import { recordRecent } from "../lib/recent";
import { useAppNav } from "../lib/nav";
import { useServerSort, useSortable, SortTh } from "../lib/sort";
import { useClientPages, usePagedList } from "../lib/paged";
import { isFlag, isText, oneOf, useRemembered } from "../lib/remembered";
import { useScope } from "../lib/scope";
import { useLatestLoad } from "../lib/resource";
import { ActionResult, AskNotice, CopyLink, Divider, EmptyState, Nothing, Pager, ScopePicker, SearchInput, SkeletonLines, SkeletonRows, Explanation } from "./ui";
import { useServers, type ServerLite } from "../lib/servers";
import { Time } from "./Time";
import { EventLine } from "./EventLine";
import { EVENT_CATEGORIES, eventKindLabel } from "../lib/eventKinds";
import { humanizeIsoInText, fmtRelative, fmtExact, isoToWall, wallToIso, zoneLabel } from "../lib/time";
import { isFuture } from "../lib/expiry";
import { describeSpanMs } from "../lib/vipSpan";
import { isWatchAudit } from "../lib/watchAudit";
import { useGame } from "../lib/game";
import { platformLabel } from "../lib/platform";
import { useGrants } from "../lib/grants";
import { hasCap } from "../lib/access";
import { focusClan } from "../lib/clanFocus";

interface Player {
  id: string; name: string; platform: string; platformId: string; firstSeen: string; lastSeen: string;
  /** The game whose server saw this account ("hll", "hllv"): the other game's servers do not know its id. */
  game?: string;
  /** Their in-game level the last time a roster read named it; null until one has. */
  level?: number | null;
  kills?: number; deaths?: number; teamkills?: number; visits?: number; playtimeSec?: number;
  /** Manual watchlist marker set on a profile. */
  watchlist?: boolean;
  /** Holds a live VIP GRANT on the scoped servers — the grants table, not the manual marker. */
  vip?: boolean;
}
/** Directory filter state — mirrors the API's records-style query params. */
interface DirFilters {
  platform: string; seenFrom: string; seenTill: string;
  /** quick last-seen window in days ("" = any time) — the phone-sized alternative to typing dates. */
  seenWithin: "" | "1" | "7" | "30";
  watched: boolean; vip: boolean; permaBanned: boolean;
  /** anyone who has worn this clan tag, in any spelling of it ("" = no filter). */
  clan: string;
}
const DIR_DEFAULTS: DirFilters = { platform: "", seenFrom: "", seenTill: "", seenWithin: "", watched: false, vip: false, permaBanned: false, clan: "" };
const isDirFilters = (v: unknown): v is DirFilters => {
  const f = v as Record<string, unknown> | null;
  return !!f && typeof f === "object"
    && (["platform", "seenFrom", "seenTill", "clan"] as const).every((k) => typeof f[k] === "string")
    && ["", "1", "7", "30"].includes(f.seenWithin as string)
    && (["watched", "vip", "permaBanned"] as const).every((k) => typeof f[k] === "boolean");
};
/** How many filters are narrowing the list — the number on the Filters button. */
const activeFilters = (f: DirFilters): number =>
  [f.platform, f.seenFrom, f.seenTill, f.seenWithin, f.watched, f.vip, f.permaBanned, f.clan.trim()].filter(Boolean).length;
/** The columns the database can order by — the directory pages, so it cannot sort in the browser. */
const DIR_SORTS = ["name", "platform", "kills", "teamkills", "visits", "playtime", "firstSeen", "lastSeen"] as const;
const hours = (sec?: number) => (sec ? `${(sec / 3600).toFixed(1)} h` : "");
interface FlagRow {
  playerId: string; name: string | null; watchlist: boolean; vip: boolean;
  updatedByName: string | null; updatedAt: string | null;
  /** why/who/when for the watch itself (imports carry the original CRCON story). */
  watchReason: string | null; watchBy: string | null; watchAt: string | null;
  online?: boolean; onlineServers?: string[];
}

export default function Players({ canNotes = false, canFlags = false, canActions = false, canGroups = false, canVip = false, canVipPause = false, openPlayerId }: { canNotes?: boolean; canFlags?: boolean; canActions?: boolean; canGroups?: boolean; canVip?: boolean; canVipPause?: boolean; openPlayerId?: string }) {
  const { servers } = useServers();
  // The perma-banned filter lists who is banned for good: the Bans page's answer, behind its own
  // permission there and on the profile, and on no row of this list. Offered to anyone who could
  // open the directory, it let a viewer list every banned player. (Each row marks a VIP ★ already,
  // so the VIP filter shows nothing new.)
  const grants = useGrants();
  const filtersBans = hasCap(grants, "moderation.bans");
  const seesWhy = hasCap(grants, "player.watchlist");
  // The directory as it was left — the search, the filters, the page — for this sitting: a tab
  // switched away from, or a profile opened from somewhere else, takes the screen with it.
  const [tab, setTab] = useRemembered<"all" | "watchlist">("players.directory.tab", "all", oneOf(["all", "watchlist"] as const), "session");
  const [q, setQ] = useRemembered("players.directory.search", "", isText, "session");
  const [f, setF] = useRemembered<DirFilters>("players.directory.filters", DIR_DEFAULTS, isDirFilters, "session");
  const [showFilters, setShowFilters] = useRemembered("players.directory.filtersOpen", false, isFlag, "session");
  // Which servers the directory covers. Defaults to the pinned server, because that is what the
  // sidebar says the panel is showing; the stat columns and the ★ then mean "here", not "summed
  // across every server we run and labelled as here", which is what they used to mean.
  const [scopeId, setScope] = useScope("players.directory.scope");
  const scopedName = scopeId ? servers.find((sv) => sv.id === scopeId)?.name : undefined;
  const [flagged, setFlagged] = useState<FlagRow[] | null>(null);
  const [watchOnline, setWatchOnline] = useRemembered("players.directory.watchOnline", false, isFlag, "session");
  const [error, setError] = useState("");
  const nav = useAppNav();
  // Server-side, because the directory pages: sorting the fetched rows would order one page and
  // call it "the top players".
  const sort = useServerSort<Player>(DIR_SORTS, "lastSeen", "desc", "directory");

  // Which profile is open is the URL's business, not this component's. It used to be local state,
  // which meant opening someone from the directory changed nothing in the address bar: the profile
  // couldn't be linked to, the back button left the panel entirely, and a refresh lost your place.
  const selected = openPlayerId ?? null;

  // Open a profile and record it as recent activity (with a quick-jump target).
  const open = (id: string, name: string | null) => {
    recordRecent({ kind: "player", label: name || id, sub: "profile", view: "players", target: { playerId: id } });
    nav.go("players", { playerId: id });
  };

  // One query builder for every page, so a page can never be fetched with different filters
  // than the page before it.
  const query = useCallback((offset: number, limit: number) => {
    const p = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (q.trim()) p.set("q", q.trim());
    if (f.platform) p.set("platform", f.platform);
    // A quick window beats typed dates when both exist — picking one clears the other in the UI,
    // so this is belt and braces, not a policy.
    if (f.seenWithin) p.set("seenFrom", new Date(Date.now() - Number(f.seenWithin) * 86_400_000).toISOString());
    // Date inputs are local days; send the day's bounds as instants so "till" includes that day.
    else if (f.seenFrom) p.set("seenFrom", new Date(`${f.seenFrom}T00:00:00`).toISOString());
    if (f.seenTill) p.set("seenTill", new Date(`${f.seenTill}T23:59:59.999`).toISOString());
    if (f.watched) p.set("watched", "1");
    if (f.vip) p.set("vip", "1");
    if (f.permaBanned && filtersBans) p.set("permaBanned", "1");
    if (f.clan.trim()) p.set("clan", f.clan.trim());
    if (scopeId) p.set("serverId", scopeId);
    p.set("sort", sort.key);
    p.set("sortDir", sort.dir);
    return `/players?${p.toString()}`;
  }, [q, f, scopeId, sort.key, sort.dir, filtersBans]);

  // Typing shouldn't fire a request per keystroke; the debounced query is what the list keys on,
  // so a new one resets to page one. It carries the scope it was built for, which is the server
  // the list is read on: handed to the pager on its own, the scope moved a beat before the query
  // did, and the query catching up read as a new filter that sent the scope's kept page to one.
  // Replaced only when the query is a new one — the same query re-wrapped is a new filter too.
  const [debounced, setDebounced] = useState(() => ({ query, scope: scopeId }));
  useEffect(() => {
    const t = setTimeout(() => setDebounced((cur) => (cur.query === query ? cur : { query, scope: scopeId })), 200);
    return () => clearTimeout(t);
  }, [query, scopeId]);

  const fetchPage = useCallback(
    // Plain offsets, no keyset cursor: a pager jumps to arbitrary pages, which a keyset cursor
    // cannot serve — it only ever knows where the LAST page ended. The rows mutate under the
    // reader (last_seen moves on every connect), so a page boundary can shift a row or two
    // between clicks; the trade is deliberate, page jumps are worth more than frozen edges.
    (offset: number, limit: number) => api<{ players: Player[]; total?: number }>(debounced.query(offset, limit))
      .then((r) => ({ items: r.players, total: r.total ?? null })),
    [debounced],
  );
  const dir = usePagedList<Player>(tab === "all" ? fetchPage : null, "players.directory", debounced.scope);
  const players = dir.items;

  useEffect(() => {
    if (tab !== "watchlist") return;
    // Leaving and re-entering the tab starts a second load; the first must not land after it.
    let live = true;
    setFlagged(null); setError("");
    api<{ flags: FlagRow[] }>("/players/flagged")
      .then((r) => { if (live) setFlagged(r.flags.filter((f) => f.watchlist)); })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [tab]);

  // The watchlist a page at a time: everyone watched, or those on a server now. Nothing until it is
  // read, so the page it was left on is not cut to an empty list meanwhile.
  const watchRows = useMemo(() => (flagged ? (watchOnline ? flagged.filter((f) => f.online) : flagged) : null), [flagged, watchOnline]);
  const watchPages = useClientPages(tab === "watchlist" ? watchRows : null, "players.watchlist", "", watchOnline ? "online" : "all");

  // Back goes back — the profile is a real URL now, so the browser's own history is the right
  // thing to unwind, and it returns you to whichever list you came from rather than always here.
  if (selected) return <PlayerProfile id={selected} canNotes={canNotes} canFlags={canFlags} canActions={canActions} canGroups={canGroups} canVip={canVip} canVipPause={canVipPause} onBack={() => window.history.back()} />;

  return (
    <PanelGroup viewId="players">
      <Panel
        id="directory"
        caps="open"
        title="Directory"
        actions={
          <>
            <div className="seg" role="group" aria-label="Show">
              <button className={`seg-btn ${tab === "all" ? "active" : ""}`} onClick={() => setTab("all")}>All</button>
              <button className={`seg-btn ${tab === "watchlist" ? "active" : ""}`} onClick={() => setTab("watchlist")}>Watchlist</button>
            </div>
            {tab === "all" && <SearchInput value={q} onChange={setQ} placeholder="Search name or ID…" />}
          </>
        }
      >
      <ActionResult error={error} />

      {tab === "all" && <>
        <ScopePicker servers={servers} value={scopeId} onChange={setScope} noun="Players and figures" />
        {/* Records-style filters: everything runs server-side so the page IS the result set.
            Folded behind one button with an active count — on a phone the open filter set was
            most of the screen — and the common narrowings are single-tap chips, not checkboxes
            and date fields. */}
        <div className="control-row" style={{ marginBottom: 8 }}>
          <button className={`ghost mini${activeFilters(f) ? " pressed" : ""}`} onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}>
            Filters{activeFilters(f) ? ` · ${activeFilters(f)}` : ""} {showFilters ? "▴" : "▾"}
          </button>
          {activeFilters(f) > 0 && <button className="mini ghost" onClick={() => setF(DIR_DEFAULTS)}>Reset</button>}
        </div>
        {showFilters && (
          <div className="dir-filters" style={{ marginBottom: 8 }}>
            <div className="control-row" style={{ marginBottom: 6 }}>
              <span className="muted fs-sm">Seen within</span>
              <div className="seg">
                {([["", "Any time"], ["1", "24 h"], ["7", "7 days"], ["30", "30 days"]] as const).map(([v, label]) => (
                  <button key={v || "any"} className={`seg-btn ${f.seenWithin === v ? "active" : ""}`}
                    onClick={() => setF((s) => ({ ...s, seenWithin: v, seenFrom: "", seenTill: "" }))}>{label}</button>
                ))}
              </div>
            </div>
            <div className="control-row" style={{ marginBottom: 6 }}>
              <div className="seg">
                <button className={`seg-btn ${f.watched ? "active" : ""}`} title="Only players on the watchlist"
                  onClick={() => setF((s) => ({ ...s, watched: !s.watched }))}>👁 Watched</button>
                <button className={`seg-btn ${f.vip ? "active" : ""}`} title="Players holding a live VIP grant on the servers above — the grants themselves, not the manual VIP marker on a profile"
                  onClick={() => setF((s) => ({ ...s, vip: !s.vip }))}>★ VIP</button>
                {filtersBans && <button className={`seg-btn ${f.permaBanned ? "active" : ""}`} title="Players carrying an active permanent ban decision"
                  onClick={() => setF((s) => ({ ...s, permaBanned: !s.permaBanned }))}>🔨 Perma banned</button>}
              </div>
            </div>
            <div className="control-row">
              <select value={f.platform} onChange={(e) => setF((s) => ({ ...s, platform: e.target.value }))} title="Platform">
                <option value="">Platform: any</option>
                {/* FAMILY ids, not raw tokens: the wire has spelled each platform several ways
                    (steam vs EPlatformFamily::Steam, winstore vs WinGDK), and the store expands a
                    family to every spelling — so one option finds the players however their rows
                    were stamped. */}
                {[["steam", "Steam (PC)"], ["epic", "Epic (PC)"], ["msstore", "MS Store (PC)"],
                  ["xbox", "Xbox"], ["playstation", "PlayStation"], ["other", "Other"], ["unknown", "Unknown"]]
                  .map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
              <label className="inline muted" title="Only players last seen on/after this day">
                Seen from <input type="date" value={f.seenFrom} onChange={(e) => setF((s) => ({ ...s, seenFrom: e.target.value, seenWithin: "" }))} style={{ width: "auto" }} />
              </label>
              <label className="inline muted" title="Only players last seen on/before this day">
                till <input type="date" value={f.seenTill} onChange={(e) => setF((s) => ({ ...s, seenTill: e.target.value, seenWithin: "" }))} style={{ width: "auto" }} />
              </label>
              <label className="inline muted" title="Anyone who has worn this clan tag — however they spelled it (Players → Clans combines the spellings)">
                Clan tag <input value={f.clan} onChange={(e) => setF((s) => ({ ...s, clan: e.target.value }))} placeholder="e.g. ABC" style={{ width: 110 }} />
              </label>
            </div>
          </div>
        )}
        {/* The list's own read: a failure says so here, where the rows would be, rather than
            leaving the loading bars up for good. */}
        <ActionResult error={dir.error} />
        {!players && !error && !dir.error && <SkeletonRows rows={8} cols={7} />}
        {players && !players.length && (q || activeFilters(f) || !scopedName) && (
          <EmptyState
            icon="🔎"
            title={q || activeFilters(f) ? "No players match your search" : "No players tracked yet"}
            filtered={Boolean(q || activeFilters(f))}
            onClear={() => { setQ(""); setF(DIR_DEFAULTS); }}
          >
            {q || activeFilters(f)
              ? "Try a shorter name, or widen the filters above — the search covers names and platform IDs."
              : "Players are recorded the first time they join a connected server. To bring in players from before the panel was watching, run the CRCON import under Administration → Connections."}
          </EmptyState>
        )}
        {/* One server with nobody on it is not a community with nobody in it: it said "No players
            tracked yet", and to run the import, over everyone the other servers hold. */}
        {players && !players.length && !q && !activeFilters(f) && scopedName && (
          <EmptyState icon="🔎" title={`No players on ${scopedName} yet`}
            action={<button className="mini ghost" onClick={() => setScope("")}>Show every server</button>}>
            A player is listed under a server once they have played on it.
          </EmptyState>
        )}
        {players && players.length > 0 && (
          <>
            <p className="muted fs-sm mt-0" style={{ marginBottom: 6 }}>Click a row for the full profile.</p>
            <div className="scroll-x roster">
              <table className="scoreboard">
                <thead><tr>
                  <th></th>
                  <SortTh s={sort} k="name">Name</SortTh>
                  <SortTh s={sort} k="platform">Platform</SortTh>
                  <SortTh s={sort} k="kills" numeric>Kills</SortTh>
                  <SortTh s={sort} k="teamkills" numeric>TK</SortTh>
                  <SortTh s={sort} k="visits" numeric>Visits</SortTh>
                  <SortTh s={sort} k="playtime" numeric>Playtime</SortTh>
                  <SortTh s={sort} k="firstSeen">First seen</SortTh>
                  <SortTh s={sort} k="lastSeen">Last seen</SortTh>
                </tr></thead>
                <tbody>
                  {players.map((p) => (
                    <tr key={p.id} style={{ cursor: "pointer" }} onClick={() => open(p.id, p.name)}>
                      <td><span className="row-marks">{p.vip && <span className="mark vip" title="Holds a VIP grant">★</span>}{p.watchlist && <span className="mark watch" title="Watched">👁</span>}</span></td>
                      <td>{p.name || "[No Name]"}</td>
                      <td title={p.platform}>{platformLabel(p.platform)}</td>
                      <td className="num">{p.kills ? p.kills.toLocaleString() : ""}</td>
                      <td className="num">{p.teamkills || ""}</td>
                      <td className="num">{p.visits || ""}</td>
                      <td className="num">{hours(p.playtimeSec)}</td>
                      <td><Time iso={p.firstSeen} /></td>
                      <td><Time iso={p.lastSeen} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager list={dir} noun="player" />
          </>
        )}
      </>}

      {tab === "watchlist" && <>
        <p className="muted">Players flagged for watching. Click to open the profile.</p>
        {!flagged && !error && <SkeletonRows rows={5} cols={5} />}
        {flagged && !flagged.length && (
          <EmptyState icon="👁" title="Nobody is being watched">
            Marking a player as watched flags them on the live roster and can ping staff in Discord when they
            join. Open any player&apos;s profile, press ⋯ and choose <strong>Add to watchlist</strong> to add the first one.
          </EmptyState>
        )}
        {flagged && flagged.length > 0 && (() => {
          const onlineCount = flagged.filter((f) => f.online).length;
          const rows = watchRows ?? [];
          return (
          <>
            <div className="seg" role="group" aria-label="Watched" style={{ marginBottom: 8 }}>
              <button className={`seg-btn ${!watchOnline ? "active" : ""}`} onClick={() => setWatchOnline(false)}>All watched ({flagged.length})</button>
              <button className={`seg-btn ${watchOnline ? "active" : ""}`} onClick={() => setWatchOnline(true)}>On a server now ({onlineCount})</button>
            </div>
            {rows.length === 0 && <Nothing>Nobody on the watchlist is playing right now.</Nothing>}
            {rows.length > 0 && (
            <div className="scroll-x">
            <table>
              {/* Why, by whom and since when are the watchlist permission's: the API sends nobody
                  else them, so without it the columns would only ever hold dashes. */}
              <thead><tr><th>Name</th><th>Right now</th><th>Flags</th>{seesWhy && <><th>Reason</th><th>Watchlisted by</th><th>When</th></>}</tr></thead>
              <tbody>
                {(watchPages.items ?? []).map((f) => (
                  <tr key={f.playerId} style={{ cursor: "pointer" }} onClick={() => open(f.playerId, f.name)}>
                    <td>{f.name || <span className="muted">{f.playerId.slice(0, 14)}…</span>}</td>
                    <td>
                      {f.online
                        ? <span className="badge active" title={(f.onlineServers ?? []).join(", ")}>online — {(f.onlineServers ?? []).join(", ") || "in game"}</span>
                        : <span className="muted">offline</span>}
                    </td>
                    <td>
                      <span className="badge observe">Watchlist</span>
                      {f.vip && <span className="badge active" style={{ marginLeft: 6 }}>VIP</span>}
                    </td>
                    {seesWhy && <>
                      <td>{f.watchReason || <span className="muted">—</span>}</td>
                      {/* Watch provenance; rows flagged before it existed fall back to the generic
                          last-change fields so imported/old entries still say something. */}
                      <td>{f.watchBy || f.updatedByName || "—"}</td>
                      <td>{(f.watchAt || f.updatedAt) ? <Time iso={(f.watchAt || f.updatedAt)!} /> : "—"}</td>
                    </>}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            )}
            {rows.length > 0 && <Pager list={watchPages} noun="player" />}
          </>
          );
        })()}
      </>}
      </Panel>
    </PanelGroup>
  );
}

/** Human-friendly playtime from seconds: "158h", "42m", or "—" when none recorded yet. */
/** The categories worth having on a profile — the Game log's vocabulary, minus the ones that are
 *  never about one player (match start/end). "All" first, as everywhere else. */
const ACTIVITY_FILTERS = [
  { id: "all", label: "All", kinds: [] as string[] },
  ...EVENT_CATEGORIES.filter((c) => ["kills", "teamkills", "chat", "moderation", "connections", "teamswitches"].includes(c.id))
    .map((c) => ({ id: c.id, label: c.label, kinds: c.kinds })),
];
const isActivityFilter = (v: unknown): v is string => typeof v === "string" && ACTIVITY_FILTERS.some((fl) => fl.id === v);

function fmtPlaytime(sec?: number): string {
  if (!sec || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  if (h >= 1) return `${h}h`;
  const m = Math.floor(sec / 60);
  return m >= 1 ? `${m}m` : "<1m";
}

/** Compact session duration: "1h 30m", "45m", or "<1m". */
function fmtDuration(sec: number): string {
  if (sec < 60) return "<1m";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h >= 1 ? `${h}h ${m}m` : `${m}m`;
}

const VERB_LABELS: Record<string, string> = {
  message: "Message", kick: "Kick", punish: "Punish", tempban: "Temp ban", permaban: "Perma ban",
  unban_temp: "Remove temp ban", unban_perma: "Remove perma ban", switch: "Team switch",
  vippause: "VIP pause", vipresume: "VIP resume",
  tag: "Tag", points: "Points", vip: "VIP", note: "Note",
  // The enforcer's stored name from the era when this action filed a record — today it places a
  // real ban, and the timeline should say so instead of leaking the legacy key.
  blacklist: "Ban",
};
/** Prettify an audit action like "player.tempban" → "Temp ban", "enforcer.kick" → "Auto kick". */
/**
 * One timeline of everything done TO this player, and by whom.
 *
 * Two fixes live here. The row used to print the literal word "player" whenever `targetName` was
 * empty — which for the action routes is most of the time, because the client never sent one — so
 * a page of kicks and bans read "player · by admin" over and over and identified nobody. Both ends
 * are now resolved server-side (see `readableAudit`) and the fallbacks say what they mean.
 *
 * And the row opens. Every entry carries a summary and, usually, structured detail — the reason
 * the player was shown, how many hours, which list — none of which fitted on one line, so it was
 * squeezed into a `title` attribute that a phone cannot show at all.
 */
function ModerationHistory({ data }: { data: Profile }) {
  const [open, setOpen] = useState<string | null>(null);

  // Watch spells live in the SAME timeline as bans/kicks — one moderation history, not two
  // panels. The permanent watch_history rows replace the raw watchlist audit entries
  // (which would double-show panel-made watches and are missing imported ones entirely):
  // each spell becomes a "Watchlisted" event, plus an "Unwatched" event once closed.
  type TimelineRow = { key: string; ts: string; cls: string; tag: string; label: string; body: React.ReactNode; detail?: React.ReactNode };
  const rows: TimelineRow[] = (data.moderation ?? [])
    .filter((m) => !isWatchAudit(m.action))
    .map((m) => ({
      key: m.id, ts: m.ts, cls: m.action.startsWith("enforcer.") ? "auto" : "",
      tag: m.action.split(".")[1] ?? "", label: fmtAction(m.action),
      body: (
        <>
          {m.targetDisplayName || m.targetName
            ? <PlayerLink playerId={m.targetId} name={m.targetDisplayName || m.targetName!} />
            : <span className="muted">unknown player</span>}
          <span className="muted"> · by {m.actorDisplayName || m.actorName}</span>
        </>
      ),
      detail: <ModerationDetail entry={m} />,
    }));
  for (const w of data.watchHistory ?? []) {
    rows.push({
      key: `${w.id}:on`, ts: w.watchedAt, cls: "", tag: "watch", label: "Watchlisted",
      body: <>{w.reason || <span className="muted">no reason recorded</span>}<span className="muted"> · by {w.watchedBy || "unknown"}{!w.removedAt && " · still watched"}</span></>,
    });
    if (w.removedAt) rows.push({
      key: `${w.id}:off`, ts: w.removedAt, cls: "", tag: "unwatch", label: "Unwatched",
      body: <span className="muted">off the watchlist · by {w.removedBy || "unknown"}</span>,
    });
  }
  rows.sort((a, b) => b.ts.localeCompare(a.ts));

  return (
    <Panel id="moderation" caps="moderation.bans" title="Moderation history">
      {rows.length === 0 && <Nothing>No moderation actions on record.</Nothing>}
      {rows.length > 0 && (
        <div className="mod-list">
          {rows.map((r) => {
            const expanded = open === r.key;
            return (
              <div key={r.key} className={`mod-row ${r.cls}${expanded ? " open" : ""}`}>
                <button
                  type="button" className="mod-head"
                  aria-expanded={r.detail ? expanded : undefined}
                  onClick={() => r.detail && setOpen(expanded ? null : r.key)}
                  // A watch spell says everything it has in its row, so there is nothing to open
                  // and it should not pretend otherwise.
                  disabled={!r.detail}
                >
                  <span className={`mod-tag ${r.tag}`}>{r.label}</span>
                  <span className="mod-main">{r.body}</span>
                  <span className="recent-time"><Time iso={r.ts} /></span>
                </button>
                {expanded && r.detail && <div className="mod-detail">{r.detail}</div>}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

/** The full record behind one row: what was said, for how long, on which server, and who by. */
function ModerationDetail({ entry: m }: { entry: NonNullable<Profile["moderation"]>[number] }) {
  const { servers } = useServers();
  const d = (m.data ?? {}) as Record<string, unknown>;
  const facts: [string, React.ReactNode][] = [];
  /**
   * The text already spelled out below, so the summary above does not repeat it.
   *
   * A panel-made action's summary is a sentence ABOUT the action ("ran kick on X — spawn camping")
   * and the reason beside it is the quoted half, so both earn their place. An imported action has
   * no such sentence: its summary IS the message, so the row printed the same paragraph twice, once
   * unlabelled and once under "Message sent".
   */
  const spelledOut: string[] = [];
  const server = m.serverId ? servers.find((s) => s.id === m.serverId) : undefined;
  if (server) facts.push(["Server", server.name]);
  // Who did it. The row's line names them too, but the record is the whole of it.
  const by = m.actorDisplayName || m.actorName;
  if (by) facts.push(["By", by]);
  /*
   * WHY this happened, for the rows nobody chose one at a time.
   *
   * An automated action used to show its reason and its server and never which rule produced it,
   * so the timeline could say a player had been kicked by the automod and not what they had done
   * to earn it — the first thing anyone opens the row to find out, and the thing an appeal turns
   * on. The rule NAME is read from the row rather than looked up live: a rule renamed or deleted
   * since must not erase the explanation for something that already happened.
   */
  if (typeof d.ruleName === "string" && d.ruleName) facts.push(["Rule", d.ruleName]);
  if (typeof d.eventKind === "string" && d.eventKind) facts.push(["Triggered by", eventKindLabel(d.eventKind)]);
  if (typeof d.escalationStep === "number") {
    facts.push(["Repeat offence", typeof d.escalationOf === "number" ? `${d.escalationStep} of ${d.escalationOf}` : String(d.escalationStep)]);
  }
  // A trial-run row describes something that did NOT happen. Saying so in the detail keeps it from
  // being read back later as a real punishment the player never received.
  if (d.dryRun === true) facts.push(["Trial run", "recorded only — the player was not touched"]);
  if (typeof d.error === "string" && d.error) facts.push(["Failed", d.error]);
  if (typeof d.reason === "string" && d.reason) { facts.push(["Reason shown", d.reason]); spelledOut.push(d.reason); }
  if (typeof d.message === "string" && d.message) { facts.push(["Message sent", d.message]); spelledOut.push(d.message); }
  // Only actions that HAVE a duration show one. Older rows recorded a stray `hours` on messages
  // and kicks (the action modals share one form state, and its 24-hour default rode along on
  // every request), so the row's data alone cannot be trusted — the action must agree.
  const verb = m.action.split(".")[1] ?? "";
  if (d.hours && (verb === "tempban" || verb === "vippause")) facts.push(["Duration", `${String(d.hours)} hours`]);
  if (typeof d.listName === "string") facts.push(["List", d.listName]);
  if (typeof d.expiresAt === "string") facts.push(["Expires", d.expiresAt]);
  if (m.targetPlatformId) facts.push(["Game id", <GameId key="id" id={m.targetPlatformId} />]);
  // The name at the time, when it is not the name now — a rename between the action and now is
  // exactly the thing an appeal argues about.
  if (m.targetName && m.targetDisplayName && m.targetName !== m.targetDisplayName) {
    facts.push(["Known then as", m.targetName]);
  }
  if (m.actorName && m.actorDisplayName && m.actorName !== m.actorDisplayName) {
    facts.push(["Acted as", m.actorName]);
  }

  return (
    <>
      {m.summary && !spelledOut.some((t) => t.trim() === m.summary.trim()) && <p className="mod-summary">{humanizeIsoInText(m.summary)}</p>}
      {facts.length > 0 && (
        <dl className="mod-facts">
          {facts.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}
        </dl>
      )}
      {!m.summary && facts.length === 0 && <p className="muted mt-0">Nothing else was recorded for this action.</p>}
    </>
  );
}

function fmtAction(action: string): string {
  const [scope, verb = ""] = action.split(".");
  const label = VERB_LABELS[verb] ?? verb.replace(/^./, (c) => c.toUpperCase());
  return scope === "enforcer" ? `Auto ${label.toLowerCase()}` : label;
}

interface IpRow { ip: string; firstSeen: string; lastSeen: string; seenCount: number; sharedWith: { playerId: string; name: string }[] }
interface Alias { playerId: string; kind: "name" | "clan"; value: string; firstSeen: string; lastSeen: string; seenCount: number }
interface Profile {
  player: Player;
  stats: {
    kills: number; deaths: number; teamkills: number; visits?: number; playtimeSec?: number;
    // Collected from the roster sampler since the panel first watched this player. Optional
    // because a store that predates the expanded stat set simply doesn't send them.
    combat?: number; offense?: number; defense?: number; support?: number;
    vehicleKills?: number; vehiclesDestroyed?: number;
    roleSeconds?: Record<string, number>; slSeconds?: number;
    highestLevel?: number; matchesPlayed?: number; matchesWon?: number;
  } | null;
  flags: { watchlist: boolean; vip: boolean; updatedByName: string | null; updatedAt: string | null; watchReason: string | null; watchBy: string | null; watchAt: string | null };
  /** Every watch this player has ever had, newest first — kept forever to catch repeat offenders.
   *  Withheld, along with the reason/by/at on `flags`, without `player.flags` read. */
  watchHistory?: { id: string; reason: string | null; watchedBy: string | null; watchedAt: string; removedBy: string | null; removedAt: string | null }[];
  /*
   * The profile gathers data that each has its own gated page, so each block arrives with the
   * server's answer to "may this person see it". These are not hints the panel may override: the
   * block is ABSENT when the flag is false, so rendering it anyway would render nothing. They exist
   * so the page can tell "you may not see this" from "there is nothing to see", which look
   * identical otherwise and mean very different things to a moderator.
   */
  canViewWatch?: boolean;
  canViewVip?: boolean;
  canViewBans?: boolean;
  // `data` carries the killer's side, which is what colours a kill blue or red; `serverId` is
  // what the per-server filter reads. Both were always in the payload and neither was declared,
  // so the panel could not use what it was already being sent.
  recentEvents: { ts: string; kind: string; serverId?: string | null; actorName?: string | null; victimName?: string | null; weapon?: string | null; actorPlayerId?: string | null; victimPlayerId?: string | null; data?: Record<string, unknown> | null }[];
  notes?: { id: string; authorName: string; body: string; createdAt: string }[];
  canViewNotes: boolean;
  pastNames?: Alias[];
  clanTags?: Alias[];
  currentClan?: string | null;
  vipStatus?: { serverId: string; serverName: string; expiration: string | null; pausedUntil?: string | null; pauseReason?: string | null; pausedBy?: string | null; pauseMode?: "running" | "banked" | null;
    /** Permanent because a group perk holds it: the groups' names and the timed VIP frozen beneath. */
    groupHold?: { groups: string[]; bankedMs: number } | null }[];
  consoleAdminStatus?: { serverId: string; serverName: string; adminGroup: string; expiration: string | null }[];
  roleBadges?: { emoji: string; label: string }[];
  /** `stats` above is the career — every server added together. This breaks it back down, so a
   *  headline figure can be read as where it was actually earned. */
  statsByServer?: { serverId: string | null; serverName: string; kills: number; deaths: number;
    playtimeSec: number; matchesPlayed: number; matchesWon: number; slSeconds: number; visits: number }[];
  sessions?: { id: string; serverId?: string; serverName: string; connectedAt: string; disconnectedAt: string; durationSec: number }[];
  moderation?: {
    id: string; ts: string; action: string; summary: string; serverId: string | null;
    actorName: string; actorDisplayName?: string | null;
    targetId: string | null;
    targetName: string | null;         // historical: the name at the time
    targetDisplayName?: string | null; // current in-game name, resolved live
    targetPlatformId?: string | null;
    data?: Record<string, unknown> | null;
  }[];
  canViewModeration?: boolean;
  tags?: { id: string; label: string; note: string | null; createdByName: string; createdAt: string }[];
  links?: { provider: string; externalId: string }[];
  /** The same platform account's other directory rows (their WW2 row from their Vietnam one and
   *  vice versa) — joined server-side on the permanent account id. */
  sameAccount?: { playerId: string; name: string; game: string; platformId: string }[];
  onlineNow?: boolean;
  onlineServers?: { serverId: string; serverName: string }[];
  banStatus?: {
    tempBan: { ts: string; expiresAt: string | null; reason: string | null } | null;
    permaBan: { ts: string; reason: string | null } | null;
  };
  /** Active ban decisions — the Bans page's record about this person (shares its permission gate). */
  banDecisions?: { id: string; kind: "temp" | "perma"; reason: string; category: string | null; expiresAt: string | null; scope: { mode: "servers" | "all" | "except"; serverIds?: string[] } }[];
  matchAnalytics?: MatchAnalytics;
  combat?: CombatAnalytics;
}

interface MatchAnalytics {
  aggregate: { matches: number; wins: number; losses: number; kills: number; deaths: number; teamkills: number };
  winRate: number | null;
  recent: { matchId: string; map: string | null; startedAt: string; endedAt: string | null; kills: number; deaths: number; teamkills: number; side: "allies" | "axis" | null; winner: "allies" | "axis" | null; won: boolean | null }[];
  progression: { x: string; label: string; kills: number; deaths: number; kd: number }[];
  weapons: { weapon: string; kills: number }[];
}

const GAME_WORD: Record<string, string> = { hll: "WW2", hllv: "Vietnam" };

/**
 * The server a profile belongs on, when the one selected is not it. A profile is one game's account
 * — WW2 and Vietnam know a player by different ids — and its actions go to the selected server, so
 * a WW2 player opened with the Vietnam server selected (from Search, a link, the Directory across
 * every server) had every message, kick, ban and VIP sent where nobody has that id. Of the servers
 * running the player's game: one they are on now, else the one they played on last, else the first.
 * Undefined when the selected server already runs their game, or no server of it is listed.
 */
function serverFor(profile: Profile, servers: ServerLite[], selected: string): ServerLite | undefined {
  const game = profile.player.game;
  const current = servers.find((s) => s.id === selected);
  if (!game || !current?.game || current.game === game) return undefined;
  const ofGame = servers.filter((s) => s.game === game);
  const online = new Set((profile.onlineServers ?? []).map((s) => s.serverId));
  const lastPlayed = [...(profile.sessions ?? [])].sort((a, b) => b.connectedAt.localeCompare(a.connectedAt));
  return ofGame.find((s) => online.has(s.id))
    ?? lastPlayed.map((sn) => ofGame.find((s) => s.id === sn.serverId)).find((s) => s !== undefined)
    ?? ofGame[0];
}

function PlayerProfile({ id, canNotes, canFlags, canActions, canGroups, canVip = false, canVipPause = false, onBack }: { id: string; canNotes: boolean; canFlags: boolean; canActions: boolean; canGroups: boolean; canVip?: boolean; canVipPause?: boolean; onBack: () => void }) {
  const toast = useToast();
  const prompt = usePrompt();
  const mayTag = hasCap(useGrants(), "player.tags", "write");
  const [data, setData] = useState<Profile | null>(null);
  const [error, setError] = useState("");
  const [noteText, setNoteText] = useState("");
  const [busy, setBusy] = useState(false);

  // A name inside a profile (a killer, a victim, a clan mate) opens that player in this same view,
  // so a slow answer for the last player must not land after the new one's. What else is on screen
  // is cleared further down, once every piece of it is declared.
  const claim = useLatestLoad();
  const load = useCallback(() => {
    const fresh = claim();
    return api<Profile>(`/players/${id}`)
      .then((d) => { if (fresh()) setData(d); })
      .catch((e) => { if (fresh()) setError(e.message); });
  }, [id, claim]);
  useEffect(() => { load(); }, [load]);
  // The address may name the player by their GAME id — the VIP list, the integrity scan and the
  // scoreboards link that way. The profile read resolves either, but the boxes below are keyed by
  // the profile's own id: handed the game id, the VIP history found the grants and lost the rule
  // VIP rows (filed under the profile id), and the IP, note, flag and Discord boxes found nobody.
  // So once the profile is in, everything on it uses the id it resolved to.
  const profileId = data?.player.id ?? id;
  // Every profile opened is recent activity, however it was reached — a name tapped on the
  // scoreboard or in a ban, a shared link, Search — not only the directory's rows.
  const openedId = data?.player.id;
  const openedName = data ? data.player.name || data.player.platformId || data.player.id : "";
  useEffect(() => {
    if (openedId) recordRecent({ kind: "player", label: openedName, sub: "profile", view: "players", target: { playerId: openedId } });
  }, [openedId, openedName]);

  // --- Recent activity: which server, and which kinds ---
  // "" is every server, matching ScopePicker's contract everywhere else in the app. Kept per
  // player for the sitting, like the feed's page: a match opened from the feed comes back to it.
  const [eventScope, setEventScope] = useRemembered(`players.profile.${id}.activityServer`, "", isText, "session");
  const [activityKind, setActivityKind] = useRemembered(`players.profile.${id}.activityKind`, "all", isActivityFilter, "session");
  const { servers: allServers, numberOf, serverId, setServerId } = useServers();
  // Opened with the other game's server selected, the panel moves to a server of the player's own
  // game (serverFor) and says so. Once per profile opened, and not before the server list is in:
  // the other game's server picked by hand afterwards is a choice, not a mistake to undo.
  const placed = useRef("");
  useEffect(() => {
    if (!data || !allServers.length || placed.current === data.player.id) return;
    placed.current = data.player.id;
    const to = serverFor(data, allServers, serverId);
    if (!to) return;
    setServerId(to.id);
    toast.info(`Switched to server ${numberOf(to.id) ?? to.name} — this is a ${GAME_WORD[data.player.game ?? ""] ?? data.player.game} profile.`);
  }, [data, allServers, serverId, setServerId, numberOf, toast]);
  // Only the servers this player actually has events on. Offering the full list would mean
  // most choices silently empty the panel.
  const eventServers = useMemo(() => {
    const seen = new Set((data?.recentEvents ?? []).map((e) => e.serverId).filter((s): s is string => !!s));
    return allServers.filter((s) => seen.has(s.id));
  }, [data?.recentEvents, allServers]);
  // The feed pages over the player's WHOLE history server-side — the profile body's recent slice
  // capped every filter at the last 50 rows and offered no way to go further back.
  const activityFetch = useCallback((offset: number, limit: number) => {
    const kinds = ACTIVITY_FILTERS.find((fl) => fl.id === activityKind)?.kinds ?? [];
    const qs = [`offset=${offset}`, `limit=${limit}`];
    if (kinds.length) qs.push(`kinds=${encodeURIComponent(kinds.join(","))}`);
    if (eventScope) qs.push(`serverId=${encodeURIComponent(eventScope)}`);
    return api<{ events: Profile["recentEvents"]; total: number }>(`/players/${id}/events?${qs.join("&")}`)
      .then((r) => ({ items: r.events, total: r.total }));
  }, [id, activityKind, eventScope]);
  const activity = usePagedList<Profile["recentEvents"][number]>(activityFetch, `players.profile.${id}.activity`);
  // Notes a page at a time, newest first as written; nothing until the profile is in.
  const notePages = useClientPages(data ? data.notes ?? [] : null, `players.profile.${id}.notes`);

  const sessionSort = useSortable<NonNullable<Profile["sessions"]>[number]>({
    connected: (s) => s.connectedAt,
    disconnected: (s) => s.disconnectedAt,
    duration: (s) => s.durationSec,
    server: (s) => s.serverName,
  }, "connected", "desc", "player-sessions");

  // Which player groups this player belongs to — shown as chips in the header, for readers with
  // Player groups. A read that failed says so: no chips would read as "in no groups", and a group
  // can be what holds a player's VIP.
  const [inGroups, setInGroups] = useState<{ id: string; name: string }[]>([]);
  const [groupsErr, setGroupsErr] = useState("");
  // The next player opened in this view starts clean: the last one's profile, the error it failed
  // with, its group chips, and a note typed for it that must not be filed on somebody else. (The
  // panels inside the profile go with it: they unmount while the next player loads.)
  useEffect(() => { setData(null); setError(""); setNoteText(""); setInGroups([]); setGroupsErr(""); }, [id]);
  const platformId = data?.player?.platformId;
  useEffect(() => {
    // The chips are the groups' read, Player groups; asked without it, it could only be refused.
    if (!platformId || !canGroups) return;
    let live = true;
    api<{ groups: { id: string; name: string }[] }>(`/player-groups/for/${encodeURIComponent(platformId)}`)
      .then((r) => { if (live) { setInGroups(r.groups ?? []); setGroupsErr(""); } })
      .catch((e) => { if (live) { setInGroups([]); setGroupsErr((e as Error).message); } });
    return () => { live = false; };
  }, [platformId, data, canGroups]); // re-check on every profile reload so ⋯ → Groups changes show up

  async function addNote(e: React.FormEvent) {
    e.preventDefault();
    if (!noteText.trim()) return;
    setBusy(true);
    try {
      await api(`/players/${profileId}/notes`, { method: "POST", body: { body: noteText.trim() } });
      setNoteText("");
      load();
    } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  }
  async function addTag() {
    const label = await prompt({
      title: "Add a flag",
      label: "Flag",
      placeholder: "🚩 or toxic",
      hint: "A short label shown on this player everywhere — an emoji or a word or two.",
      confirmLabel: "Add flag",
    });
    if (!label) return;
    const note = await prompt({
      title: `Note for “${label}”`,
      label: "Note (optional)",
      hint: "Context for other staff. Leave blank to skip.",
      required: false,
      confirmLabel: mayTag ? "Add flag" : "Send for approval",
    });
    if (note === null) return; // cancelled at the second step
    try {
      await api(`/players/${profileId}/tags`, { method: "POST", body: { label, note: note || undefined } });
      toast.success(`Flagged as “${label}”`);
      load();
    } catch (err) { toast.error((err as Error).message); }
  }
  async function removeTag(tagId: string) {
    try { await api(`/players/${profileId}/tags/${tagId}`, { method: "DELETE" }); load(); }
    catch (err) { toast.error((err as Error).message); }
  }

  if (error) return <div className="card"><button className="ghost" onClick={onBack}>← Back</button><ActionResult error={error} /></div>;
  if (!data) return <div className="card"><SkeletonLines lines={4} /></div>;
  const { player, stats, flags } = data;
  const kd = stats ? (stats.deaths ? stats.kills / stats.deaths : stats.kills) : 0;

  return (
    <div>
      <div className="card">
        <button className="ghost" onClick={onBack} style={{ marginBottom: 12 }}>← Back to players</button>
        <div className="row">
          <div>
            <h1 className="m-0 profile-name">
              {data.currentClan && <span className="clan-tag" style={{ fontSize: "0.7em" }}>[{data.currentClan}]</span>} {player.name || "[No Name]"}
              {/* WHERE they are online, in the badge itself: a tooltip needs a hover nobody on a
                  phone has, and "Online" beside an active ban reads as a contradiction until the
                  badge shows the presence and the ban are about different servers. Numbers, not
                  names — the same reason every other chip uses them (names run to eighty chars). */}
              {data.onlineNow && <span className="online-badge" title={`Online on ${data.onlineServers?.map((s) => s.serverName).join(", ")}`}><span className="online-dot" />Online{data.onlineServers?.length ? ` — server ${data.onlineServers.map((s) => numberOf(s.serverId) ?? "?").join(", ")}` : ""}</span>}
            </h1>
            <p className="muted" style={{ margin: "4px 0 0" }}>{player.platform} · <GameId id={player.platformId} /></p>
            {/* The watch is a moderation record, not a boolean — say why, who and since when. To
                whoever the watchlist permission doesn't cover the API sends none of that, so for
                them it is the mark alone: "no reason recorded" would be news it doesn't have. */}
            {flags.watchlist && (
              <p style={{ margin: "4px 0 0", fontSize: "0.85rem" }}>
                👁 <strong>Watchlisted</strong>
                {(flags.watchBy || flags.updatedByName) && <> by {flags.watchBy || flags.updatedByName}</>}
                {(flags.watchAt || flags.updatedAt) && <> · <Time iso={(flags.watchAt || flags.updatedAt)!} /></>}
                {data.canViewWatch !== false && <>{" — "}{flags.watchReason || <span className="muted">no reason recorded</span>}</>}
              </p>
            )}
            {/* Flags are seen by everyone who sees the player, so everyone may change them: without
                the tags permission the change is sent for approval. They were gated on the
                watchlist read, which hid them from roles that could see every flag. */}
            {((data.tags?.length ?? 0) > 0 || canActions) && (
              <div className="tag-row">
                {data.tags?.map((t) => (
                  <span key={t.id} className="ptag" title={t.note ? `${t.note} — ${t.createdByName}` : `by ${t.createdByName}`}>
                    {t.label}{canActions && <button className="ptag-x" onClick={() => removeTag(t.id)} aria-label={mayTag ? "Remove flag" : "Ask to remove flag"} title={mayTag ? undefined : "Sent for approval"}>×</button>}
                  </span>
                ))}
                {canActions && <button className="ptag-add" onClick={addTag}>+ Flag</button>}
              </div>
            )}
            {inGroups.length > 0 && (
              <div className="tag-row">
                {inGroups.map((g) => (
                  <span key={g.id} className="ptag" title="Player group — bulk actions live under Players → Groups; manage membership from ⋯ → Groups">👥 {g.name}</span>
                ))}
              </div>
            )}
            {groupsErr && <div className="tag-row"><span className="hint">Couldn&apos;t read the player&apos;s groups: {groupsErr}</span></div>}
          </div>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            {/* Their in-game level, from the roster reads. Highest-ever wins over the last
                sighting because the game's level only climbs — a stale roster read must not
                show a veteran as level 12. Hidden until a roster read has named one. */}
            {(() => {
              const lvl = Math.max(stats?.highestLevel ?? 0, player.level ?? 0);
              return lvl > 0 ? <span className="badge" title="In-game level (highest seen)">Level {lvl}</span> : null;
            })()}
            {/* The URL already names this exact profile — this is "share this player" as one click,
                instead of telling another admin a name to go search for. */}
            <CopyLink label="Copy profile link" />
            <StatLinksMenu platform={player.platform} platformId={player.platformId} />
            {(canFlags || canActions || canVip || canVipPause) && (
              <PlayerActions
                variant="profile"
                player={(() => {
                  // The pause that matters for the chip/menu: the furthest-out active one.
                  const pausedRow = (data.vipStatus ?? [])
                    .filter((v) => isFuture(v.pausedUntil))
                    .sort((a, b) => String(b.pausedUntil).localeCompare(String(a.pausedUntil)))[0];
                  return {
                    playerId: player.platformId, dbId: player.id, name: player.name,
                    watch: flags.watchlist, watchReason: flags.watchReason, watchBy: flags.watchBy,
                    // A real grant and nothing else — the star used to also light for a manual
                    // marker, so a profile could claim VIP the game had never heard of.
                    vip: (data.vipStatus?.length ?? 0) > 0,
                    vipPausedUntil: pausedRow?.pausedUntil ?? null,
                    vipPauseReason: pausedRow?.pauseReason ?? null,
                    vipPauseMode: pausedRow?.pauseMode ?? null,
                    discordId: data.links?.find((l) => l.provider === "discord")?.externalId ?? null,
                    consoleAdmin: data.consoleAdminStatus ?? null,
                    badges: data.roleBadges ?? null,
                    tempBan: data.banStatus?.tempBan ?? null,
                    permaBan: data.banStatus?.permaBan ?? null,
                  };
                })()}
                canActions={canActions}
                canGroups={canGroups}
                canVip={canVip}
                canVipPause={canVipPause}
                onChanged={load}
              />
            )}
          </div>
        </div>
      </div>

      <PanelGroup viewId="player-profile">
      <Panel id="overview" caps="open" title="Overview">
        <StatGrid>
          <StatTile label="Kills" value={(stats?.kills ?? 0).toLocaleString()} />
          <StatTile label="Deaths" value={(stats?.deaths ?? 0).toLocaleString()} />
          <StatTile label="K/D" value={kd.toFixed(2)} accent />
          <StatTile label="Team kills" value={(stats?.teamkills ?? 0).toLocaleString()} />
          <StatTile label="Visits" value={(stats?.visits ?? 0).toLocaleString()} />
          <StatTile label="Playtime" value={fmtPlaytime(stats?.playtimeSec)} />
          <StatTile label="First seen" value={fmtRelative(player.firstSeen)} sub={fmtExact(player.firstSeen)} />
          <StatTile label="Last seen" value={fmtRelative(player.lastSeen)} sub={fmtExact(player.lastSeen)} />
        </StatGrid>
        {((stats?.kills ?? 0) + (stats?.deaths ?? 0) + (stats?.teamkills ?? 0)) > 0 && (
          <div style={{ marginTop: 14 }}>
            <BreakdownBars data={[
              { key: "kills", label: "Kills", value: stats?.kills ?? 0, colorIndex: 5 },
              { key: "deaths", label: "Deaths", value: stats?.deaths ?? 0, colorIndex: 1 },
              { key: "teamkills", label: "Team kills", value: stats?.teamkills ?? 0, colorIndex: 4 },
            ]} />
          </div>
        )}
      </Panel>

      {/* The other half of the record: the game's own score buckets, vehicle work, squad-leader
          time and time by role — collected by the roster sampler, and until now not shown anywhere,
          so a profile judged everyone purely on kills. Hidden entirely when the sampler has never
          seen this player, rather than drawing a panel of zeroes. */}
      {hasScoreData(stats) && (
        <Panel id="score" caps="open" title="Round performance">
          <PlayerScoreStats stats={stats!} />
        </Panel>
      )}

      {data.matchAnalytics && data.matchAnalytics.aggregate.matches > 0 && (
        <MatchPerformance a={data.matchAnalytics} />
      )}

      {data.combat && <PlayerCombatPanels c={data.combat} />}

      <PlayerMapVotes playerId={data.player.id} />

      {/* The career above is every server summed, which is right for a profile — one person, one
          record. It is also the number that used to be the ONLY one available, presented under a
          sidebar pinned to a single server. This says where it came from. */}
      {(data.statsByServer?.length ?? 0) > 1 && (
        <Panel id="per-server" caps="open" title="By server" subtitle="Where the career above was earned">
          {/* scroll-x, like every other wide table in the app. Without it this one pushed the last
              columns off the right edge on a phone with no way to reach them — HLL server names run
              to a hundred characters of advertising, so the first column alone can outrun the
              viewport. The name is clamped to two lines and keeps its full text in a title. */}
          <div className="scroll-x">
            <table className="data">
              <thead><tr><th>Server</th><th className="num">Kills</th><th className="num">Deaths</th><th className="num">K/D</th><th className="num">Matches</th><th className="num">Playtime</th></tr></thead>
              <tbody>
                {data.statsByServer!.map((r) => (
                  <tr key={r.serverId ?? "unattributed"}>
                    <td className="server-cell" title={r.serverName}>{r.serverName}</td>
                    <td className="num">{r.kills.toLocaleString()}</td>
                    <td className="num">{r.deaths.toLocaleString()}</td>
                    <td className="num">{(r.deaths ? r.kills / r.deaths : r.kills).toFixed(2)}</td>
                    <td className="num">{r.matchesPlayed.toLocaleString()}</td>
                    <td className="num">{r.playtimeSec ? fmtPlaytime(r.playtimeSec) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Per-server figures start from the day the split landed, so a long-standing player shows
              a big "Before per-server tracking" row and a small live one. Saying so beats leaving
              someone to conclude their stats were lost. */}
          {data.statsByServer!.some((r) => r.serverId === null) && (
            <Explanation>
              Everything recorded before this panel tracked stats per server sits in one row — it is
              part of the career total above, it just predates knowing which server earned it.
            </Explanation>
          )}
        </Panel>
      )}

      {/* The grant is the same one the VIPs tab needs. Without it the API sends no vipStatus at
          all, so the explicit flag is what keeps the panel from appearing empty and looking like
          "this player has no VIP" — which is a different and wrong statement. */}
      {data.canViewVip && (data.vipStatus?.length ?? 0) > 0 && (
        <Panel id="vip" caps="vip.grant" title="VIP status">
          <div className="vip-status-list">
            {data.vipStatus!.map((v) => (
              <div key={v.serverId} className="vip-status-row">
                <span>{v.serverName}</span>
                {isFuture(v.pausedUntil)
                  ? <span className="badge err" title={`${v.pauseReason ?? ""}${v.pausedBy ? ` — by ${v.pausedBy}` : ""}`}>paused {fmtRelative(v.pausedUntil)}{v.pauseMode === "banked" ? " · banked" : ""}</span>
                  : <span className="badge active">VIP</span>}
                <span className="muted">{v.expiration ? `until ${fmtRelative(v.expiration)}`
                  : v.groupHold ? `permanent — group ${v.groupHold.groups.map((g) => `“${g}”`).join(", ")}${v.groupHold.bankedMs > 0 ? `, ${describeSpanMs(v.groupHold.bankedMs)} frozen for when they leave` : ""}`
                  : "permanent"}</span>
                {isFuture(v.pausedUntil) && v.pauseReason && <span className="muted">— {v.pauseReason}</span>}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {data.canViewModeration && <ModerationHistory data={data} />}

      {/* Always present, even with nothing in it. Hiding the panel when the list was empty is why
          this reads as "sessions aren't being tracked": there is no way to tell a player with no
          completed sessions from a feature that isn't running. */}
      <Panel defaultCollapsed id="sessions" caps="open" title="Recent sessions"
        subtitle={data.sessions?.length ? String(data.sessions.length) : undefined}>
        {!data.sessions?.length && (
          <EmptyState icon="🕑" title="No completed sessions yet">
            A session is recorded when a player disconnects — it needs the join and the leave to
            measure. Someone still online has an open session that appears here once they leave, and
            anything from before this server was connected to the panel was never seen at all.
          </EmptyState>
        )}
        {(data.sessions?.length ?? 0) > 0 && (
          <div className="scroll-x">
            <table>
              <thead><tr>
                <SortTh s={sessionSort} k="connected">Connected</SortTh>
                <SortTh s={sessionSort} k="disconnected">Disconnected</SortTh>
                <SortTh s={sessionSort} k="duration">Duration</SortTh>
                <SortTh s={sessionSort} k="server">Server</SortTh>
              </tr></thead>
              <tbody>
                {sessionSort.sorted(data.sessions!).map((s) => (
                  <tr key={s.id}>
                    <td><Time iso={s.connectedAt} /></td>
                    <td><Time iso={s.disconnectedAt} /></td>
                    <td>{fmtDuration(s.durationSec)}</td>
                    <td className="server-cell" title={s.serverName}>{s.serverName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <IdentityHistory pastNames={data.pastNames ?? []} clanTags={data.clanTags ?? []} currentClan={data.currentClan ?? null} />

      {/* Reloads with the profile, so a VIP action taken here shows in the timeline at once. */}
      <VipHistory playerId={profileId} reloadKey={data} />

      <IpHistory playerId={profileId} />

      {data.canViewNotes && (
        <Panel id="notes" caps="player.notes" title="Notes">
          {canNotes && (
            <form onSubmit={addNote} className="row" style={{ alignItems: "flex-start" }}>
              <input placeholder="Add a note…" value={noteText} onChange={(e) => setNoteText(e.target.value)} />
              <button className="primary" type="submit" disabled={busy}>Add</button>
            </form>
          )}
          {!data.notes?.length && <Nothing>No notes yet.</Nothing>}
          {(notePages.items ?? []).map((n) => (
            <div key={n.id} className="note">
              <div className="muted fs-xs">{n.authorName} · <Time iso={n.createdAt} /></div>
              <div>{n.body}</div>
            </div>
          ))}
          {Boolean(data.notes?.length) && <Pager list={notePages} noun="note" />}
        </Panel>
      )}

      {/* The watch record as a MANAGED list: every reason with its author, clock, expiry and
          previous versions. The header line above carries only the newest reason; this is where
          the rest live — and where ONE reason comes off without lifting the others. */}
      <Panel id="watch" caps="player.watchlist" title="Watchlist" subtitle={flags.watchlist ? "watched" : undefined}>
        <WatchReasonsPanel playerId={player.id} canFlags={canFlags} onChanged={load} />
      </Panel>

      {/* The same rows the Game log shows, rendered the same way — this used to be a bare table
          printing the raw `evt.kill` key, with the columns that carry the meaning (victim, weapon)
          pushed off a phone screen. */}
      <Panel id="activity" caps="open" title="Activity"
        subtitle={activity.total != null ? String(activity.total) : undefined}>
        <div className="row activity-controls">
          {/* Which server's activity. Events always carried the server; nothing ever offered to
              filter on it, so a player who plays on two of them got one interleaved list. */}
          {eventServers.length > 1 && (
            <ScopePicker servers={eventServers} value={eventScope} onChange={setEventScope} noun="Activity" />
          )}
          <div className="seg" role="group" aria-label="Show">
            {ACTIVITY_FILTERS.map((f) => (
              <button key={f.id} className={`seg-btn ${activityKind === f.id ? "active" : ""}`}
                aria-pressed={activityKind === f.id} onClick={() => setActivityKind(f.id)}>{f.label}</button>
            ))}
          </div>
        </div>
        <ActionResult error={activity.error} />
        {!activity.items && !activity.error && <SkeletonRows rows={6} cols={3} />}
        {activity.items && activity.total === 0 && activityKind === "all" && !eventScope && (
          <EmptyState icon="📡" title="No recorded events">
            Kills, chat, connections, team switches and moderation involving this player appear here as the panel
            ingests them from the server.
          </EmptyState>
        )}
        {activity.items && activity.total === 0 && (activityKind !== "all" || !!eventScope) && (
          <EmptyState icon="📡" title="Nothing matches this filter" filtered
            onClear={() => { setActivityKind("all"); setEventScope(""); }}>
            This player has recorded activity, just none of this kind on this server.
          </EmptyState>
        )}
        {activity.items && activity.items.length > 0 && (
          <>
            <div className="log-list">
              {activity.items.map((e, i) => (
                <EventLine key={`${e.ts}-${i}`} e={e} time={<Time iso={e.ts} />} />
              ))}
            </div>
            <Pager list={activity} noun="event" />
          </>
        )}
      </Panel>

      {/* Linked external identities (discord, eos, …), and the MANUAL REGISTRATION — the staff way
          to attach a Discord account when the self-service code flow can't be used. Named for the
          job and left open: titled "Linked IDs" and collapsed, nobody could find it. */}
      <Panel id="links" caps="player.links" title="Discord registration">
        <ManualLink playerId={profileId} playerName={data.player.name} links={data.links ?? []} sameAccount={data.sameAccount ?? []} onChanged={load} />
      </Panel>
      </PanelGroup>
    </div>
  );
}

/** Match performance — per-round history built from the match-tracking subsystem: win rate, a
 *  kills-vs-deaths progression over recent matches, a weapon breakdown, and the recent-matches list
 *  with each round's outcome. Only shown when the player has played at least one tracked match. */
function MatchPerformance({ a }: { a: MatchAnalytics }) {
  const game = useGame();
  const { aggregate: agg } = a;
  const mkd = agg.deaths ? agg.kills / agg.deaths : agg.kills;
  const progPoints: ProgPoint[] = a.progression.map((p) => ({ x: p.x, label: p.label, values: { kills: p.kills, deaths: p.deaths } }));
  // The active game names the sides — "Allies"/"Axis" is HLL's wording, not every game's.
  const sideLabel = (s: "allies" | "axis" | null) => (s ? game.sideName(s) : "—");

  return (
    <Panel id="matches" caps="open" title="Match performance">
      <StatGrid>
        <StatTile label="Matches" value={agg.matches.toLocaleString()} />
        <StatTile label="Win rate" value={a.winRate == null ? "—" : `${Math.round(a.winRate * 100)}%`} sub={a.winRate == null ? "no decided matches" : `${agg.wins}W · ${agg.losses}L`} accent />
        <StatTile label="Match K/D" value={mkd.toFixed(2)} sub={`${agg.kills.toLocaleString()} / ${agg.deaths.toLocaleString()}`} />
        <StatTile label="Team kills" value={agg.teamkills.toLocaleString()} />
      </StatGrid>

      {progPoints.length >= 2 && (
        <div style={{ marginTop: 16 }}>
          <div className="muted" style={{ fontSize: "0.82rem", marginBottom: 4 }}>Kills vs deaths per match</div>
          <Progression
            points={progPoints}
            series={[{ key: "kills", label: "Kills", colorIndex: 5 }, { key: "deaths", label: "Deaths", colorIndex: 1 }]}
          />
        </div>
      )}

      {a.weapons.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="muted" style={{ fontSize: "0.82rem", marginBottom: 8 }}>Top weapons (recent)</div>
          <BreakdownBars data={a.weapons.map((w) => ({ key: w.weapon, label: w.weapon, value: w.kills }))} />
        </div>
      )}

      {a.recent.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="muted" style={{ fontSize: "0.82rem", marginBottom: 8 }}>Recent matches</div>
          <div className="scroll-x">
            <table>
              <thead><tr><th>Map</th><th>When</th><th>Side</th><th>K / D / TK</th><th>Result</th></tr></thead>
              <tbody>
                {a.recent.map((m) => (
                  <tr key={m.matchId}>
                    <td><strong>{m.map ?? "—"}</strong></td>
                    <td><Time iso={m.startedAt} /></td>
                    <td>{sideLabel(m.side)}</td>
                    <td>{m.kills} / {m.deaths} / {m.teamkills}</td>
                    <td>{m.won == null ? (m.endedAt ? <span className="muted">draw</span> : <span className="badge active">in progress</span>) : m.won ? <span className="badge active">Win</span> : <span className="badge observe">Loss</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Panel>
  );
}

/** "Also known as" — past names + clan-tag history, each with the window it was seen. Only renders
 *  sections that have entries, so a player with no recorded history shows a single muted line. */
/** IP history — self-gating: it asks the API and renders NOTHING without the player.ips
 *  permission (403), so the sensitive panel simply doesn't exist for staff who can't see it.
 *  Data comes from the CRCON import, only from records carrying the player's own id. */
function IpHistory({ playerId }: { playerId: string }) {
  // Asked only with the permission: every other profile was a refused read. And a read that fails
  // for another reason says so — hiding the panel then read as "no permission".
  const allowed = hasCap(useGrants(), "player.ips");
  const [rows, setRows] = useState<IpRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setRows(null); setError("");
    if (!allowed) return;
    // Sensitive data keyed on a person: a stale response here would show one player's addresses
    // under another player's name.
    let live = true;
    api<{ ips: IpRow[] }>(`/players/${playerId}/ips`)
      .then((r) => { if (live) setRows(r.ips); })
      .catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [playerId, allowed]);
  const pages = useClientPages(rows, `players.profile.${playerId}.ips`);
  if (!allowed) return null;
  return (
    <Panel defaultCollapsed id="ips" caps="player.ips" title="IP history" subtitle="sensitive — visible only with the Player IP history permission">
      <ActionResult error={error ? `Couldn't read the IP history: ${error}` : ""} />
      {!rows && !error && <SkeletonRows rows={3} cols={5} />}
      {rows && rows.length === 0 && <Nothing>No IP addresses recorded. They arrive via the CRCON import — only from records that carry the player's own id, never matched by name.</Nothing>}
      {rows && rows.length > 0 && (
        <div className="scroll-x">
          <table>
            <thead><tr><th>IP</th><th>First seen</th><th>Last seen</th><th>Sightings</th><th>Also seen on this IP</th></tr></thead>
            <tbody>
              {(pages.items ?? []).map((r) => (
                <tr key={r.ip}>
                  <td><code>{r.ip}</code></td>
                  <td><Time iso={r.firstSeen} /></td>
                  <td><Time iso={r.lastSeen} /></td>
                  <td>{r.seenCount}</td>
                  <td>{r.sharedWith.length === 0 ? <span className="muted">nobody else</span> :
                    r.sharedWith.map((sp, i) => <span key={sp.playerId}>{i > 0 && ", "}<PlayerLink playerId={sp.playerId} name={sp.name} /></span>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows && rows.length > 0 && <Pager list={pages} noun="IP" />}
    </Panel>
  );
}

function IdentityHistory({ pastNames, clanTags, currentClan }: { pastNames: Alias[]; clanTags: Alias[]; currentClan: string | null }) {
  const nav = useAppNav();
  const range = (a: Alias) => (a.firstSeen.slice(0, 10) === a.lastSeen.slice(0, 10) ? fmt(a.lastSeen) : `${fmtRelative(a.firstSeen)} – ${fmtRelative(a.lastSeen)}`);
  // A tag opens its clan under Players → Clans: everyone who wears it, however they spell it.
  const openClan = (tag: string) => { focusClan(tag); nav.go("players", undefined, "clans"); };
  if (!pastNames.length && !clanTags.length) {
    return (
      <Panel defaultCollapsed id="aka" caps="open" title="Also known as">
        <Nothing>No alias history recorded yet. Names and clan tags are captured as this player is seen in games.</Nothing>
      </Panel>
    );
  }
  return (
    <Panel defaultCollapsed id="aka" caps="open" title="Also known as">
      {pastNames.length > 0 && (
        <div className="alias-block">
          <div className="alias-head">Previous names</div>
          <div className="alias-chips">
            {pastNames.map((a) => (
              <span key={a.value} className="alias-chip" title={`Seen ${a.seenCount}×`}>
                <span className="alias-value">{a.value}</span>
                <span className="alias-when">{range(a)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {clanTags.length > 0 && (
        <div className="alias-block">
          <div className="alias-head">Clan tags</div>
          <div className="alias-chips">
            {clanTags.map((a) => (
              <button key={a.value} type="button" className={`alias-chip ${a.value === currentClan ? "current" : ""}`}
                title={`Seen ${a.seenCount}× — open this clan under Players → Clans`} onClick={() => openClan(a.value)}>
                <span className="alias-value">[{a.value}]{a.value === currentClan ? " · current" : ""}</span>
                <span className="alias-when">{range(a)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

/**
 * MANUAL LINK — attaching a Discord account to a player by hand.
 *
 * The self-service route is the code flow: the member picks themselves off the live roster and
 * types back a code the bot sent them in game, which proves they own the account. That is the
 * right default and staff should not do it for people.
 *
 * But it cannot cover everything. Somebody left the game and cannot get back on to receive a code;
 * somebody's old link came in from the cutover import against the wrong account; a console player has no
 * chat to read the code in. Without this, the answer to all of those was "edit the database".
 *
 * The API refuses to move an id that another player already holds (409) rather than silently
 * stealing it, so the failure mode here is a clear message, not a quiet double-link that pays the
 * wrong person's claims forever.
 *
 * It answers to Player identity links, as the API does: read shows the links, and a change made
 * without write is sent for approval to someone who holds it.
 */
function ManualLink({ playerId, playerName, links, sameAccount = [], onChanged }: {
  playerId: string;
  playerName: string;
  links: { provider: string; externalId: string }[];
  sameAccount?: { playerId: string; name: string; game: string; platformId: string }[];
  onChanged: () => void;
}) {
  const canEdit = hasCap(useGrants(), "player.links");
  const toast = useToast();
  const confirm = useConfirm();
  const discord = links.find((l) => l.provider === "discord")?.externalId ?? "";
  const others = links.filter((l) => l.provider !== "discord");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(discord); }, [discord]);

  const save = async (value: string) => {
    setBusy(true);
    try {
      const r = await api<{ welcome?: string[] }>(`/players/${playerId}/links`, { method: "PATCH", body: { provider: "discord", externalId: value || null } });
      // A first link pays the registration welcome; say what landed rather than leave it to the ledger.
      const paid = r.welcome?.length ? ` — welcome bonus paid: ${r.welcome.join(" and ")}` : "";
      toast.success(value ? `Linked ${playerName} to Discord ${value}${paid}` : `Cleared the Discord link for ${playerName}`);
      onChanged();
    } catch (e) {
      // Sent for approval is news, not a failure.
      if (wasFiled(e)) toast.success(e.message);
      else toast.error((e as Error).message);
    } finally { setBusy(false); }
  };

  const clear = async () => {
    if (!(await confirm({
      title: `Unlink ${playerName} from Discord?`,
      body: "Their points stay on the Discord account, but VIP and purchases will stop reaching this game account until it is linked again.",
      confirmLabel: "Unlink",
    }))) return;
    await save("");
  };

  return (
    <div>
      <AskNotice capability="player.links" />
      <label className="field">Discord user id
        <input value={draft} inputMode="numeric" placeholder="not linked" disabled={!canEdit || busy}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))} />
      </label>
      <Explanation>
        Discord → Developer Mode on → right-click the member → Copy User ID. Members normally link themselves from the VIP panel; this is for when they cannot.
      </Explanation>
      {canEdit && (
        <div className="actions">
          <button className="primary" disabled={busy || draft === discord || !/^\d{5,25}$/.test(draft)} onClick={() => save(draft)}>
            {busy ? "Saving…" : discord ? "Change link" : "Link"}
          </button>
          {discord && <button className="danger" disabled={busy} onClick={clear}>Unlink</button>}
        </div>
      )}
      {others.length > 0 && (
        <>
          <Divider label="Other identities" />
          {others.map((l) => (
            <div key={l.provider} style={{ marginBottom: 6 }}>
              <span className="muted" style={{ display: "inline-block", minWidth: "5.5rem", textTransform: "uppercase", fontSize: "0.7rem", fontWeight: 700 }}>{l.provider}</span>
              <code>{l.externalId}</code>
            </div>
          ))}
        </>
      )}
      {/* The same platform account's OTHER rows — one human, two games, joined on the permanent
          account id above. This is the lookup those ids exist for: tap through instead of copying
          the number into search. */}
      {sameAccount.length > 0 && (
        <>
          <Divider label="Same account on" />
          {sameAccount.map((o) => (
            <div key={o.playerId} style={{ marginBottom: 6 }}>
              <span className="muted" style={{ display: "inline-block", minWidth: "5.5rem", textTransform: "uppercase", fontSize: "0.7rem", fontWeight: 700 }}>{o.game === "hllv" ? "Vietnam" : o.game === "hll" ? "WW2" : o.game}</span>
              <PlayerLink playerId={o.playerId} name={o.name || o.platformId} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

interface WatchReasonV {
  id: string; reason: string; addedBy: string | null; addedAt: string; expiresAt: string | null;
  removedBy: string | null; removedAt: string | null;
  /** Decided by the API against the caller's account — the rows its edit route will accept. */
  own?: boolean;
  edits: { reason: string; expiresAt: string | null; editedBy: string | null; editedAt: string }[];
}
const watchReasonActive = (r: WatchReasonV) => !r.removedAt && (!r.expiresAt || Date.parse(r.expiresAt) > Date.now());

/**
 * The profile's watch record, managed per REASON: each row edits and removes on its own, the
 * closed and lapsed ones stay visible (struck, never deleted), and a row that has been edited
 * opens its previous versions — the record of what it used to say is part of the record.
 * Adding a reason lives in the ⋯ actions menu, same place watching always started.
 */
function WatchReasonsPanel({ playerId, canFlags, onChanged }: { playerId: string; canFlags: boolean; onChanged?: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  // Curation is its own permission: editing OTHER staff's reasons, removing any reason (your own
  // included) and lifting the watch. Base watchlist write only adds, and edits its own — the
  // previous versions those edits leave behind are what make own-edits safe to allow.
  const grants = useGrants();
  const canCurate = hasCap(grants, "player.watchlist.curate", "write");
  // An edit needs the watchlist write, and curation too unless the row is yours. Lacking either,
  // Save files the edit for approval and says so.
  const mayEdit = (r: WatchReasonV) => hasCap(grants, "player.watchlist", "write") && (r.own || canCurate);
  const [reasons, setReasons] = useState<WatchReasonV[] | null>(null);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editUntil, setEditUntil] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ reasons: WatchReasonV[] }>(`/players/${playerId}/watch`)
      .then((r) => setReasons(r.reasons))
      .catch((e) => setErr((e as Error).message));
  }, [playerId]);
  useEffect(() => { load(); }, [load]);

  const done = () => { setEditing(null); load(); onChanged?.(); };

  async function saveEdit(id: string) {
    setBusy(true);
    try {
      await api(`/players/${playerId}/watch/reasons/${id}`, {
        method: "PATCH",
        body: { reason: editText.trim(), expiresAt: editUntil ? wallToIso(editUntil) : null },
      });
      toast.success("Watch reason updated — the previous version stays on the record");
      done();
    } catch (e) {
      if (wasFiled(e)) setEditing(null);
      toast.error((e as Error).message);
    } finally { setBusy(false); }
  }
  async function removeOne(r: WatchReasonV) {
    if (!(await confirm({
      title: "Remove this watch reason?",
      body: `"${r.reason}" closes (it stays on the record). Other reasons keep the watch standing; if this is the last one, the watch lifts.${canCurate ? "" : " You don't hold this permission, so it is sent for approval instead of happening now."}`,
      confirmLabel: canCurate ? "Remove" : "Send for approval",
      danger: true,
    }))) return;
    try { await api(`/players/${playerId}/watch/reasons/${r.id}`, { method: "DELETE" }); toast.success("Watch reason removed"); done(); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function removeAll() {
    if (!(await confirm({
      title: "Remove every watch reason?",
      body: `The watch lifts and all reasons close. Everything stays on the record for repeat-offender checks.${canCurate ? "" : " You don't hold this permission, so it is sent for approval instead of happening now."}`,
      confirmLabel: canCurate ? "Remove all" : "Send for approval",
      danger: true,
    }))) return;
    try {
      // Taking someone off is the curate permission, so it can be asked for like any other action
      // somebody lacks — the answer comes back as a request rather than a refusal.
      const r = await api<{ requested?: boolean }>(`/players/${playerId}/flags`, { method: "PATCH", raw202: true, body: { watchlist: false } });
      toast.success(r.requested ? "Sent for approval — taking them off the watchlist waits for a signature" : "Removed from the watchlist");
      done();
    }
    catch (e) { toast.error((e as Error).message); }
  }

  if (err) return <ActionResult error={err} />;
  if (!reasons) return <SkeletonLines lines={2} />;
  const active = reasons.filter(watchReasonActive);
  const past = reasons.filter((r) => !watchReasonActive(r));
  return (
    <div>
      {reasons.length === 0 && <Nothing>Never watched. Watching starts from the ⋯ menu — the reason typed there is the record other staff read.</Nothing>}
      {active.map((r) => (
        <div key={r.id} className="note">
          {editing === r.id ? (
            <div>
              <input value={editText} onChange={(e) => setEditText(e.target.value)} aria-label="Reason" />
              <label className="fs-xs">Expires <span className="muted">(blank = until removed, {zoneLabel()})</span>
                <input type="datetime-local" value={editUntil} onChange={(e) => setEditUntil(e.target.value)} />
              </label>
              <div className="actions mt-0">
                <button className="primary mini" disabled={busy || !editText.trim()} onClick={() => saveEdit(r.id)}>{mayEdit(r) ? "Save" : "Send for approval"}</button>
                <button className="ghost mini" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <div>👁 {r.reason}</div>
              <div className="muted fs-xs">
                by {r.addedBy || "unknown"} · <Time iso={r.addedAt} />
                {r.expiresAt ? <> · expires <Time iso={r.expiresAt} /></> : " · until removed"}
              </div>
            </>
          )}
          {r.edits.length > 0 && (
            <details>
              <summary className="muted fs-xs">{r.edits.length} previous version{r.edits.length === 1 ? "" : "s"}</summary>
              {r.edits.map((e, i) => (
                <div key={i} className="muted fs-xs" style={{ paddingLeft: 12 }}>
                  &ldquo;{e.reason}&rdquo;{e.expiresAt ? <> (expired <Time iso={e.expiresAt} />)</> : null} — replaced by {e.editedBy || "unknown"} · <Time iso={e.editedAt} />
                </div>
              ))}
            </details>
          )}
          {/* Offered on every row to everyone who sees the record, like "Remove from watchlist"
              below. Removal is curation even for your own row, and so is editing someone else's;
              your own wording you may sharpen with the watchlist write (the previous versions
              above are why that is safe). Whatever the account lacks is sent for approval. */}
          {editing !== r.id && (canCurate || canFlags) && (
            <div className="actions mt-0">
              <button className="ghost mini" onClick={() => { setEditing(r.id); setEditText(r.reason); setEditUntil(r.expiresAt ? isoToWall(r.expiresAt) : ""); }}>Edit</button>
              <button className="ghost mini" onClick={() => removeOne(r)}>Remove</button>
            </div>
          )}
        </div>
      ))}
      {/* Lifting the watch is curation — and curation is exactly the thing somebody without it can
          ASK for, which is what the ⋯ menu's "Remove from watchlist" already does. Hiding the same
          action here, on the panel where the reasons actually live, sent a moderator back to the
          menu to do what the page in front of them was refusing to offer. */}
      {(canCurate || canFlags) && active.length > 0 && (
        <div className="actions">
          <button className="danger mini" onClick={removeAll}>
            {canCurate ? "Remove from watchlist" : "Ask to remove from watchlist"} (all {active.length === 1 ? "1 reason" : `${active.length} reasons`})
          </button>
        </div>
      )}
      {past.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary className="muted fs-xs">{past.length} past reason{past.length === 1 ? "" : "s"}</summary>
          {past.map((r) => (
            <div key={r.id} className="note">
              <div style={{ textDecoration: "line-through" }} className="muted">{r.reason}</div>
              <div className="muted fs-xs">
                by {r.addedBy || "unknown"} · <Time iso={r.addedAt} />
                {r.removedAt
                  ? <> · removed by {r.removedBy || "unknown"} · <Time iso={r.removedAt} /></>
                  : r.expiresAt ? <> · expired <Time iso={r.expiresAt} /></> : null}
              </div>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
