"use client";
/**
 * Live event feed — subscribes to a server's SSE event stream and shows the newest events at top.
 * Reused by the Live view (and anywhere else a tail is wanted). Rows are structured (time · kind ·
 * actor → victim · weapon) with clickable player names, and a checkbox toggles streaming.
 *
 * Filters mirror the Game log so the two surfaces speak the same language: the same category chips
 * (shared EVENT_CATEGORIES) and the same single-player picker. Filtering is applied to the incoming
 * stream, not the subscription, so flipping a chip never drops the connection — and rows are kept
 * RAW in state with filters applied at render, so widening a filter brings suppressed rows back.
 */
import { useEffect, useState } from "react";
import { api, fmt, openStream } from "../lib/api";
import { PlayerLink } from "./PlayerLink";
import { PlayerPicker, type PickedPlayer } from "./PlayerPicker";
import { EVENT_CATEGORIES, kindLabel, involvesPlayer, teamSwitchText } from "../lib/eventKinds";
import { toneClass } from "../lib/colors";
import { Time } from "./Time";
import { Nothing, Toggle } from "./ui";
import { isPickedPlayer, isText, useRemembered } from "../lib/remembered";

interface FeedEvt {
  ts: string; kind: string;
  actorName?: string | null; victimName?: string | null; weapon?: string | null;
  actorPlayerId?: string | null; victimPlayerId?: string | null;
  /** event payload extras (kill events carry actorSide/victimSide for tone coloring). */
  data?: Record<string, unknown> | null;
  /** stable identity of the source log line — the stored row and the streamed frame carry the
   *  same one, which is how a backfilled row and its live echo are recognised as one event. */
  dedupeKey?: string | null;
}
interface Row extends FeedEvt { key: string }

/** The identity two copies of one event share. `dedupeKey` when the pipeline supplied one;
 *  otherwise the fields that make an event what it is — never a random key, which would let a
 *  backfilled row and its streamed echo both survive. */
function identity(e: FeedEvt): string {
  // The team a switch went to as well: a swap's two lines ("Allies > None", "None > Axis") share
  // the second, the kind and the name, and would otherwise collapse into one row.
  return e.dedupeKey || [e.ts, e.kind, e.actorName ?? "", e.victimName ?? "", e.weapon ?? "", typeof e.data?.to === "string" ? e.data.to : ""].join("\u0000");
}

/** Merge new events into the buffer, newest first, dropping ones already held. */
function mergeRows(prev: Row[], incoming: FeedEvt[], cap: number): Row[] {
  const seen = new Set(prev.map((r) => r.key));
  const fresh = incoming.filter((e) => !seen.has(identity(e))).map((e) => ({ ...e, key: identity(e) }));
  if (!fresh.length) return prev;
  return [...fresh, ...prev].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, cap);
}

const isCategory = (v: unknown): v is string => typeof v === "string" && EVENT_CATEGORIES.some((c) => c.id === v);

export function LiveFeed({ serverId, autostart = false, alwaysLive = false, round = false, max = 80, className }: {
  serverId?: string;
  autostart?: boolean;
  /** Stream unconditionally and drop the on/off control — for a screen that IS the live view,
   *  where an opt-in checkbox to see live data is a question with one sensible answer. */
  alwaysLive?: boolean;
  /** Open with everything that has already happened this round, then tail from there. */
  round?: boolean;
  max?: number;
  className?: string;
}) {
  const [live, setLive] = useState(autostart || alwaysLive);
  const [status, setStatus] = useState("");
  const [feed, setFeed] = useState<Row[]>([]);
  const [cat, setCat] = useRemembered("livefeed.category", "all", isCategory);
  const [who, setWho] = useRemembered<PickedPlayer | null>("livefeed.player", null, isPickedPlayer, "session");
  const [query, setQuery] = useRemembered("livefeed.search", "", isText, "session");
  /** What the backfill covers: the round's start, or null when there is no open round. */
  const [since, setSince] = useState<{ startedAt: string; map: string | null } | null>(null);
  const [backfilled, setBackfilled] = useState(false);

  // The round so far, fetched once per server. It lands in the same buffer the stream feeds, so a
  // kill that happened a second before you arrived and one that happens a second after read alike.
  useEffect(() => {
    if (!round || !serverId) { setSince(null); setBackfilled(false); return; }
    let alive = true;
    setBackfilled(false);
    api<{ events: FeedEvt[]; round: { startedAt: string; map: string | null } | null }>(`/servers/${serverId}/round/events?limit=${max * 5}`)
      .then((r) => {
        if (!alive) return;
        setSince(r.round);
        // Merge rather than replace: the stream may already have delivered events while this was
        // in flight, and those are the newest ones on screen.
        setFeed((prev) => mergeRows(prev, r.events ?? [], max * 5));
        setBackfilled(true);
      })
      .catch(() => { if (alive) setBackfilled(true); }); // a failed backfill still leaves a live tail
    return () => { alive = false; };
  }, [round, serverId, max]);

  // A new server is a new feed. Clearing lives here rather than in the stream effect below,
  // because that one also re-runs when streaming is toggled off and on — which used to throw away
  // the round backfill (the fetch does not re-run) and leave the tail looking empty again.
  useEffect(() => { setFeed([]); }, [serverId]);

  useEffect(() => {
    if (!live || !serverId) { setStatus(""); return; }
    setStatus("connecting…");
    return openStream(serverId, {
      open: () => setStatus("● live"),
      error: () => setStatus("reconnecting…"),
      message: (data) => {
        try {
          const evt = JSON.parse(data) as FeedEvt;
          // Game events only — the same guard the Game log's tail has always had. The bus also
          // carries the app's own plumbing (app.enforcement firings, the app.state.* detections the
          // worker hands the rule engine), and those rendering as raw internal kinds in a staff-
          // facing tail reads as debris, not as the game log.
          if (!evt.kind?.startsWith("evt.")) return;
          // Keep a deeper raw buffer than the display cap so narrowing a filter still has history.
          setFeed((prev) => mergeRows(prev, [evt], max * 5));
        } catch { /* ignore malformed frame */ }
      },
    });
  }, [live, serverId, max]);

  const activeKinds = EVENT_CATEGORIES.find((c) => c.id === cat)?.kinds ?? [];
  /*
   * Free text over the rows on screen, alongside the picker rather than instead of it.
   *
   * The picker resolves a player out of the directory and follows them properly; this matches the
   * text as printed, which is what you want for the things that are not a player at all — a
   * weapon ("SATCHEL"), a word someone said in chat, half a name you cannot spell. The Game log
   * has had a search box since it was built; the tail beside it never did.
   */
  const needle = query.trim().toLowerCase();
  const matchesQuery = (r: Row) =>
    !needle
    || [r.actorName, r.victimName, r.weapon, kindLabel(r.kind), typeof r.data?.message === "string" ? r.data.message : null,
      r.kind === "evt.player.teamSwitched" ? teamSwitchText(r.data) : null]
      .some((s) => typeof s === "string" && s.toLowerCase().includes(needle));
  const shown = feed
    .filter((r) => !activeKinds.length || activeKinds.includes(r.kind))
    .filter((r) => !who || involvesPlayer(r, who))
    .filter(matchesQuery)
    .slice(0, max);

  return (
    <div className={className}>
      {/* The surrounding Panel carries the "Live feed" title, so this row is controls only. */}
      <div className="control-row" style={{ margin: "0 0 10px" }}>
        {/* On the Live view the answer to "do you want live data?" is already yes — the screen is
            the question. Elsewhere the feed is an extra, so it keeps the opt-in. */}
        {!alwaysLive && <Toggle checked={live} onChange={setLive} label="Stream live" />}
        <span className={`muted live-status ${status === "● live" ? "on" : ""}`}>{status}</span>
        {round && (
          <span className="muted fs-xs">
            {since ? <>this round{since.map ? ` · ${since.map}` : ""} · from <Time iso={since.startedAt} /></> : backfilled ? "recent events (no round on record)" : "loading the round…"}
          </span>
        )}
        <div className="seg" role="group" aria-label="Show">
          {EVENT_CATEGORIES.map((c) => (
            <button key={c.id} className={`seg-btn ${cat === c.id ? "active" : ""}`} onClick={() => setCat(c.id)}>{c.label}</button>
          ))}
        </div>
        <input
          className="roster-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search these events…" aria-label="Search the events on screen by name, weapon or message"
        />
        <div style={{ minWidth: 200, flex: "0 1 240px" }}>
          <PlayerPicker value={who} onChange={setWho} placeholder="Filter to one player…" />
        </div>
      </div>
      <div className="live-feed">
        {live && feed.length > 0 && shown.length === 0 && (
          <Nothing>Nothing matching yet — {feed.length} other event{feed.length === 1 ? "" : "s"} suppressed by the filters.</Nothing>
        )}
        {live && feed.length === 0 && (round ? backfilled : true) && (
          <Nothing>{round ? "Nothing has happened this round yet — new events appear here as they land." : "Waiting for the first event…"}</Nothing>
        )}
        {shown.map((r) => (
          <div className={`live-row ${toneClass(r.kind, r.data)}`} key={r.key}>
            <time>{fmt(r.ts)}</time>
            <code>{kindLabel(r.kind)}</code>
            <span>
              <PlayerLink playerId={r.actorPlayerId} name={r.actorName || ""} />
              {r.kind === "evt.player.teamSwitched" ? <span className={typeof r.data?.swapFrom === "string" ? undefined : "muted"}> {teamSwitchText(r.data) ?? "switched team"}</span> : null}
              {r.victimName ? <> → <PlayerLink playerId={r.victimPlayerId} name={r.victimName} /></> : null}
              {r.weapon ? <span className="muted"> ({r.weapon})</span> : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
