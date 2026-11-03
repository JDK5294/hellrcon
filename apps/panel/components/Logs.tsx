"use client";
/**
 * Logs — the CRCON-style live log monitor. Surfaces the rich event stream the ingest already
 * captures (chat, kills, team kills, connections, team switches, kicks/bans, votes, match start/end,
 * admin messages), which the plain Events widget never showed. Category chips + search filter the
 * feed; a "Live" toggle tails the SSE stream (prepending new lines) on top of the loaded history.
 * Player names are clickable through to their profile.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmt, openStream } from "../lib/api";
import { useServers } from "../lib/servers";
import { PanelGroup, Panel } from "./Panel";
import { PlayerPicker, type PickedPlayer } from "./PlayerPicker";
import { EVENT_CATEGORIES, eventKindLabel, involvesPlayer, teamSwitchText } from "../lib/eventKinds";
import { DOWNLOAD_MAX, fileStem, readAll, type Sheet } from "../lib/download";
import { DownloadButton, type DownloadRange } from "./Download";
import { EventLine } from "./EventLine";
import { ActionResult, EmptyState, NoServersPage, Pager, SearchInput, SkeletonRows, Toggle } from "./ui";
import { usePagedList } from "../lib/paged";
import { isFlag, isPickedPlayer, isText, useRemembered } from "../lib/remembered";

interface Evt {
  ts: string; kind: string;
  actorName?: string | null; actorPlayerId?: string | null;
  victimName?: string | null; victimPlayerId?: string | null;
  weapon?: string | null; data?: Record<string, unknown> | null;
}

/** One page of the log; the rest is reachable a page at a time. */

/** What a line says beyond who and what: the chat or admin message, the kick or ban reason, the vote. */
function eventText(e: Evt): string {
  const d = e.data ?? {};
  const said = d.message ?? d.reason ?? d.content ?? d.result;
  if (said != null) return String(said);
  return e.kind === "evt.player.teamSwitched" ? teamSwitchText(d) ?? "" : "";
}

/** The game log as a file, newest first as on screen. */
function gameLogSheet(rows: Evt[], capped: boolean): Sheet {
  return {
    name: "Game log",
    columns: [
      { key: "time", label: "Time", time: true },
      { key: "event", label: "Event" },
      { key: "player", label: "Player" },
      { key: "playerId", label: "Player ID" },
      { key: "otherPlayer", label: "Other player" },
      { key: "otherPlayerId", label: "Other player ID" },
      { key: "weapon", label: "Weapon" },
      { key: "message", label: "Message" },
    ],
    rows: rows.map((e) => [e.ts, eventKindLabel(e.kind), e.actorName, e.actorPlayerId, e.victimName, e.victimPlayerId, e.weapon, eventText(e)]),
    ...(capped ? { notice: `Saved the newest ${DOWNLOAD_MAX.toLocaleString()} lines. Pick a shorter time range for the ones before them.` } : {}),
  };
}

const isCategory = (v: unknown): v is string => typeof v === "string" && EVENT_CATEGORIES.some((c) => c.id === v);

export default function Logs() {
  const { serverId, servers } = useServers();
  // Remembered, so coming back from a player's profile (either back button, or the sidebar) finds
  // the log as it was left: the category and Live per user, the search and the player for this
  // sitting. Plain state went with the screen, and opening a profile unmounts it.
  const [cat, setCat] = useRemembered("logs.category", "all", isCategory);
  const [q, setQ] = useRemembered("logs.search", "", isText, "session");
  const [who, setWho] = useRemembered<PickedPlayer | null>("logs.player", null, isPickedPlayer, "session");
  const [live, setLive] = useRemembered("logs.live", false, isFlag);
  // Tailed events are kept SEPARATE from the fetched pages rather than merged into them: loading
  // an older page must not disturb what the live tail has put on top, and the tail must not be
  // re-seeded away when a page lands.
  const [tailed, setTailed] = useState<Evt[]>([]);

  const activeKinds = useMemo(() => EVENT_CATEGORIES.find((c) => c.id === cat)?.kinds ?? [], [cat]);

  // One read of the log as filtered — the screen's pages, and a download's over a time range.
  const readEvents = useCallback((offset: number, limit: number, cursor?: string, range: DownloadRange = {}) => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (activeKinds.length) params.set("kinds", activeKinds.join(","));
    if (q.trim()) params.set("q", q.trim());
    if (who) params.set("player", who.playerId);
    if (range.from) params.set("from", range.from);
    if (range.to) params.set("to", range.to);
    // Later pages are read against the snapshot page one was taken from. The game log is the
    // fastest-moving list in the panel: without this, every event that arrives while you read
    // page one pushes page two down, so it opens on rows you have already seen.
    if (cursor) params.set("anchor", cursor);
    return api<{ events: Evt[]; total?: number; anchor?: string }>(`/servers/${serverId}/events?${params}`)
      .then((r) => ({ items: r.events, total: r.total ?? null, cursor: r.anchor }));
  }, [serverId, activeKinds, q, who]);
  const fetchPage = useCallback((offset: number, limit: number, cursor?: string) => {
    if (!serverId) return Promise.resolve({ items: [] as Evt[], total: 0 });
    return readEvents(offset, limit, cursor);
  }, [serverId, readEvents]);
  const logFile = async (range: DownloadRange): Promise<Sheet> => {
    const { items, capped } = await readAll<Evt>((offset, limit, anchor) =>
      readEvents(offset, limit, anchor, range).then((r) => ({ items: r.items, total: r.total, anchor: r.cursor })));
    return gameLogSheet(items, capped);
  };
  const log = usePagedList<Evt>(serverId ? fetchPage : null, "logs", serverId);
  const { error: err, reload: load } = log;
  // A new query means the tail's contents belong to the old one.
  useEffect(() => { setTailed([]); }, [fetchPage]);
  const events = useMemo(
    () => (log.items === null ? null : [...tailed, ...log.items]),
    [tailed, log.items],
  );

  // Live tail: prepend matching events from the SSE stream on top of the loaded history.
  useEffect(() => {
    if (!live || !serverId) return;
    const needle = q.trim().toLowerCase();
    return openStream(serverId, { message: (data) => {
      let e: Evt;
      try { e = JSON.parse(data) as Evt; } catch { return; }
      if (!e.kind?.startsWith("evt.")) return;
      if (activeKinds.length && !activeKinds.includes(e.kind)) return;
      if (needle) {
        const hay = `${e.actorName ?? ""} ${e.victimName ?? ""} ${String((e.data ?? {}).message ?? "")}`.toLowerCase();
        if (!hay.includes(needle)) return;
      }
      if (who && !involvesPlayer(e, who)) return;
      setTailed((prev) => [e, ...prev].slice(0, 300));
    } });
  }, [live, serverId, activeKinds, q, who]);

  if (!servers.length) return <NoServersPage>The game log is read straight off a connected server, so there is nothing to show until one is added.</NoServersPage>;
  if (!serverId) return <div className="card"><p className="muted">Select a server to view its logs.</p></div>;

  return (
    <PanelGroup viewId="logs">
      <Panel
        id="log"
        caps="open"
        title="Game log"
        subtitle="chat, kills, connections, team switches, moderation, votes, match events"
        actions={<>
          <Toggle checked={live} onChange={setLive} label="Live" />
          <button className="ghost mini" onClick={load}>Refresh</button>
          <DownloadButton file={fileStem("game-log", servers.find((s) => s.id === serverId)?.name, cat === "all" ? "" : cat)} title="Download the game log"
            noun="line" ranged scope="matching the log's category, search and player, in the time range picked" sheet={logFile} />
        </>}
      >
      <div className="control-row" style={{ marginBottom: 10 }}>
        <div className="seg" role="group" aria-label="Show">
          {EVENT_CATEGORIES.map((c) => (
            <button key={c.id} className={`seg-btn ${cat === c.id ? "active" : ""}`} onClick={() => setCat(c.id)}>{c.label}</button>
          ))}
        </div>
        <SearchInput value={q} onChange={setQ} placeholder="Search names or chat text…" />
        <div style={{ minWidth: 220, flex: "0 1 260px" }}>
          <PlayerPicker value={who} onChange={setWho} placeholder="Filter to one player…" />
        </div>
      </div>

      <ActionResult error={err} />
      {!events && !err && <SkeletonRows rows={10} cols={3} />}
      {events && events.length === 0 && (
        <EmptyState
          icon="▤"
          title={live ? "Nothing yet on the live feed" : "No matching log lines"}
          filtered={!!(q.trim() || who)}
          onClear={() => { setQ(""); setWho(null); }}
        >
          {live
            ? <>Waiting for activity on the server. Lines appear as they happen.</>
            : <>Nothing in the stored log matches these filters. Try <strong>All</strong>, or clear the search and the player.</>}
        </EmptyState>
      )}

      {events && events.length > 0 && (
        <div className="log-list">
          {/* The log wants an absolute clock time — these lines get correlated against what
              happened in-game, so "6 min ago" is the wrong unit here. */}
          {events.map((e, i) => <EventLine key={`${e.ts}-${i}`} e={e} time={fmt(e.ts)} />)}
        </div>
      )}
      {/* Counts the fetched page, not the live tail — the total is what the query matches. */}
      <Pager list={log} noun="line" />
      </Panel>
    </PanelGroup>
  );
}
