"use client";
/**
 * Live view — a dedicated, auto-refreshing look at the active server, mirroring CRCON's Live tab:
 * a match header (map, timer, score, counts), the full sortable scoreboard, and the live event feed
 * underneath. The scoreboard is shared with the Connections tab (Servers.tsx exports it).
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { fmtClock } from "../lib/time";
import { api } from "../lib/api";
import { ActionResult, NoServersPage, PageHeader } from "./ui";
import { useServers } from "../lib/servers";
import { oneOf, useRemembered } from "../lib/remembered";
import { useResource } from "../lib/resource";
import { Scoreboard, type LivePlayer } from "./Servers";
import { useGame, type GameCtx } from "../lib/game";
import { LiveFeed } from "./LiveFeed";
import { PanelGroup, Panel } from "./Panel";
import { mapImageUrl, mapIconUrl, factionIconUrls } from "../lib/gameAssets";

interface Session {
  serverName?: string; mapName?: string; mapId?: string; gameMode?: string;
  remainingMatchTime?: number; alliedScore?: number; axisScore?: number;
  playerCount?: number; maxPlayerCount?: number; alliedPlayerCount?: number; axisPlayerCount?: number;
  queueCount?: number; maxQueueCount?: number; vipQueueCount?: number; maxVipQueueCount?: number;
  /** Conquest's scoreline — a positive initialMorale is what says the round is scored in morale. */
  initialMorale?: number; alliedMorale?: number; axisMorale?: number;
}

/**
 * People waiting in the VIP queue — or nothing, when the server's counter cannot mean that.
 *
 * A live 100-slot server reports `vipQueueCount: 742` beside `maxVipQueueCount: 2`: the field is
 * carrying the size of the VIP list, not a queue. This card used to print it as "742 VIP queue".
 * (Mirrors `vipQueueDepth` in @app/rcon-core; the panel can't import from a server package.)
 */
function vipQueueDepth(s: Session): number | undefined {
  const n = s.vipQueueCount;
  if (n == null || !Number.isFinite(n) || n < 0) return undefined;
  const cap = s.maxVipQueueCount ?? s.maxPlayerCount;
  if (cap != null && Number.isFinite(cap) && n > cap) return undefined;
  return n;
}

const REFRESH_MS = 15_000;

/** Seconds → "H:MM:SS" (or "MM:SS" under an hour) for the remaining match time. */
function clock(sec?: number): string {
  if (sec == null || sec < 0) return "";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
  return h >= 1 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** Derive the context strip from the roster: VIP/watched counts, and squads that have players but
 *  no leader (the descriptor's squadLeaderRoles) — "No SL". Lobby/no-squad players ignored; games
 *  without leader roles simply never warn. */
/** A player's faction id: the server-resolved `side` when present (corrected against session
 *  headcounts), else the static descriptor guess. A null side is the server saying "on neither
 *  team" — joining, team select — and is kept, never re-guessed onto one. */
const sideIdOf = (p: LivePlayer, game: GameCtx) => (p.side !== undefined ? p.side : game.sideOf(p.team)?.id ?? null);

function serverContext(players: LivePlayer[], game: GameCtx) {
  const vips = players.filter((p) => p.vip).length;
  const squads = new Map<string, { players: number; hasLeader: boolean }>();
  if (game.squadLeaderRoles.length) {
    for (const p of players) {
      const side = sideIdOf(p, game);
      if (!p.platoon || !side) continue;
      const key = `${side}/${p.platoon}`;
      const s = squads.get(key) ?? { players: 0, hasLeader: false };
      s.players += 1;
      if (p.role != null && game.squadLeaderRoles.includes(p.role)) s.hasLeader = true;
      squads.set(key, s);
    }
  }
  // No-SL squads grouped by side (CRCON-style: "Allies No SL: BAKER, GEORGE · Axis No SL: EASY"),
  // so a commander can see at a glance WHICH team's squads are leaderless.
  const noSlBySide = new Map<string, string[]>();
  for (const [k, s] of squads) {
    if (s.players === 0 || s.hasLeader) continue;
    const [side, squad] = [k.slice(0, k.indexOf("/")), k.slice(k.indexOf("/") + 1)];
    noSlBySide.set(side, [...(noSlBySide.get(side) ?? []), squad]);
  }
  for (const list of noSlBySide.values()) list.sort();
  return { vips, noSlBySide };
}

interface MapEntry { name?: string; gameMode?: string; timeOfDay?: string }
interface MapRotation { currentIndex?: number; mAPS?: MapEntry[] }

/** Next map = the entry after currentIndex, wrapping around. */
function nextMap(rot: MapRotation | null): MapEntry | null {
  const maps = rot?.mAPS;
  if (!Array.isArray(maps) || !maps.length) return null;
  const idx = ((rot?.currentIndex ?? 0) + 1) % maps.length;
  return maps[idx] ?? null;
}

/** What /live returns: the roster (shape varies by protocol), plus the round and rotation. */
interface LivePayload { players: unknown; session?: Session; mapRotation?: MapRotation }

export default function LiveView({ canFlags = false, canActions = false, canGroups = false, canVip = false, canVipPause = false }: { canFlags?: boolean; canActions?: boolean; canGroups?: boolean; canVip?: boolean; canVipPause?: boolean } = {}) {
  const { server, serverId, servers } = useServers();
  const game = useGame();
  // The roster keeps itself current (CRCON's live view does the same). The poll and its
  // stale-response guard come from useResource — switching server while a fetch is in flight used
  // to be able to paint the previous server's roster over the new one.
  const loader = useMemo(() => {
    if (!serverId) return null;
    return () => api<LivePayload>(`/servers/${serverId}/live`);
  }, [serverId]);
  const { data: live, error, reload: load } = useResource<LivePayload>(loader, { refreshMs: REFRESH_MS });

  // The roster arrives either as an array or wrapped in { players: [] } depending on the protocol.
  const players = useMemo(() => {
    if (!live) return null;
    if (Array.isArray(live.players)) return live.players as LivePlayer[];
    const wrapped = (live.players as { players?: LivePlayer[] })?.players;
    return Array.isArray(wrapped) ? wrapped : [];
  }, [live]);
  const session = live?.session ?? null;
  const rotation = live?.mapRotation ?? null;

  // Stamped when a payload lands, not during render — a clock read while rendering is impure.
  const [refreshedAt, setRefreshedAt] = useState<string>("");
  useEffect(() => { if (live) setRefreshedAt(fmtClock()); }, [live]);

  // Which half of the roster panel is showing. Remembered per user: whoever reads the feed all day
  // shouldn't land on the scoreboard every time they open the view. Read as the view mounts, like
  // every screen's remembered state, rather than one frame of scoreboard first.
  const [pane, setPane] = useRemembered<"scoreboard" | "feed">("live.pane", "scoreboard", oneOf(["scoreboard", "feed"] as const));

  if (!servers.length) return <NoServersPage routeId="live">Once a server is connected this page shows who is playing, on which team, in which squad — live.</NoServersPage>;

  const s = session ?? {};
  const online = s.playerCount ?? players?.length ?? 0;
  const cap = s.maxPlayerCount ?? 100;
  // The game reports two independent counters and the panel used to ADD them, so a server with a
  // reserved VIP queue read as having people waiting when it was empty. They are shown apart now,
  // each labelled with the field it comes from — a number you can trace is one you can trust.
  const queue = s.queueCount ?? 0;
  const vipQueue = vipQueueDepth(s);
  const ctx = players ? serverContext(players, game) : null;
  const nm = nextMap(rotation);
  // The raw id when the server sends one ("stmereeglise_offensive_us") — exact, where the printable
  // name has to be matched by squashing accents out of it.
  const mapKey = s.mapId || s.mapName;
  const art = mapImageUrl(mapKey, game.descriptor?.id);
  // Resolved once each: both used to be called twice per render (the condition, then the src).
  const mapIcon = mapIconUrl(mapKey, game.descriptor?.id);
  const nextIcon = mapIconUrl(nm?.name, game.descriptor?.id);

  return (
    <div>
      <div className="card page-head">
        <PageHeader routeId="live" actions={<button className="ghost" onClick={load} title="Refresh now">↻ Refresh</button>} />
      </div>

      {/* The match status is CONTENT, not page chrome, so it scrolls away with everything else.
          It used to live inside the sticky page head, which on a phone meant the header — title,
          blurb, breadcrumb, score line, No-SL warnings and all — pinned itself over most of the
          screen and never moved, leaving a sliver to read the scoreboard through. */}
      {/* The map you are playing is the biggest fact about the round, so it is the card itself —
          the artwork runs behind the whole summary, header and team stats alike, fading into the
          surface before the numbers so nothing has to be read through a photograph. */}
      <div className={`card live-summary${art ? " has-art" : ""}`} style={art ? ({ "--match-art": `url(${art})` } as CSSProperties) : undefined}>
        {server?.name && <div className="lm-server" title={server.name}>{server.name}</div>}
        {/* Match header: counts, map/mode, remaining time, and the faction score line. */}
        <div className="live-match">
          <div className="lm-counts">
            <span className={`badge ${server?.engagementMode === "observe" ? "observe" : "active"}`}>{server?.engagementMode ?? ""}</span>
            <span><strong>{online}/{cap}</strong> online</span>
            {queue > 0 && <span className="muted" title="queueCount — players waiting in the general queue"> · {queue}{s.maxQueueCount ? `/${s.maxQueueCount}` : ""} queued</span>}
            {/* Shown only when the server's VIP counter can actually BE a queue: one live build
                reports 742 there against a declared maximum of 2 (it is the VIP list size). */}
            {vipQueue != null && vipQueue > 0 && <span className="muted" title="vipQueueCount — the game's separate VIP queue counter"> · {vipQueue} VIP queue</span>}
            {s.maxVipQueueCount != null && s.maxVipQueueCount > 0 && <span className="muted" title="maxVipQueueCount — slots the server holds back for VIPs"> · {s.maxVipQueueCount} VIP slot{s.maxVipQueueCount === 1 ? "" : "s"}</span>}
            {ctx && <span className="muted" title="Players in game holding a live VIP grant on this server"> · {ctx.vips} VIP</span>}
          </div>
          {/* The current map gets the same thumbnail the next one does — it was the only map on
              the row identified by an emoji instead of its own picture. */}
          {s.mapName && (
            <div className="lm-map">
              {mapIcon ? <img className="map-thumb" src={mapIcon} alt="" /> : <span aria-hidden>🗺 </span>}
              {s.mapName}{s.gameMode ? <span className="muted"> · {s.gameMode}</span> : null}
            </div>
          )}
          {nm && (
            <div className="muted lm-next">
              {nextIcon && <img className="map-thumb" src={nextIcon} alt="" />}
              Next: {nm.name}{nm.gameMode ? ` · ${nm.gameMode}` : ""}
            </div>
          )}
          {(s.alliedScore != null || s.axisScore != null || s.remainingMatchTime != null) && (() => {
            const emblems = factionIconUrls(mapKey, game.descriptor?.id);
            return (
              <>
              <div className="lm-score">
                <span className={`team-tag side-${game.sides[0]?.color ?? "neutral"}`}>
                  {emblems.allies && <img className="faction-emblem" src={emblems.allies} alt="" />}
                  {game.sides[0]?.label ?? "Team A"} {s.alliedScore ?? 0}{s.alliedPlayerCount != null ? ` · ${s.alliedPlayerCount}` : ""}
                </span>
                {s.remainingMatchTime != null && <span className="lm-clock">{clock(s.remainingMatchTime)}</span>}
                <span className={`team-tag side-${game.sides[1]?.color ?? "neutral"}`}>
                  {emblems.axis && <img className="faction-emblem" src={emblems.axis} alt="" />}
                  {game.sides[1]?.label ?? "Team B"} {s.axisScore ?? 0}{s.axisPlayerCount != null ? ` · ${s.axisPlayerCount}` : ""}
                </span>
              </div>
              {/* Conquest: the caps scoreline above still partitions the points held, and the
                  morale drain — the number the round actually ENDS on — reads beside it. */}
              {(s.initialMorale ?? 0) > 0 && (
                <div className="muted lm-morale">
                  Morale {s.alliedMorale ?? 0} – {s.axisMorale ?? 0} <span className="fs-xs">(each side started with {s.initialMorale})</span>
                </div>
              )}
              <SectorBar allied={s.alliedScore} axis={s.axisScore} game={game} />
              </>
            );
          })()}
        </div>
        {/* Team stats live inside the match card now: score, sectors and the per-side totals are
            one picture of the round, and splitting them across two panels meant scrolling between
            halves of the same thought. */}
        {players && <TeamStats players={players} />}
        {refreshedAt && <p className="muted" style={{ margin: "6px 0 0", fontSize: "0.75rem" }}>Updated {refreshedAt} · auto-refreshes every {REFRESH_MS / 1000}s</p>}
      </div>

      {error && <div className="card"><ActionResult error={error} /></div>}
      {!players && !error && <div className="card"><p className="muted">Loading live state…</p></div>}

      <PanelGroup viewId="live">
        {/* Who is playing and what they are doing are two views of one thing, and stacking them
            meant the feed sat a full scoreboard below the fold — on a phone, several screens down.
            One panel, one at a time, switched by a tab: both are a glance away and neither costs
            the other any room. The roster stays mounted while the feed shows so a sort, a
            selection or a half-finished bulk action survives the trip. */}
        <Panel id="roster" caps="open" title="Roster" subtitle={players ? `${players.length} playing` : undefined}>
          <div className="seg" style={{ marginBottom: 10 }}>
            {([["scoreboard", "Scoreboard"], ["feed", "Live feed"]] as const).map(([id, label]) => (
              <button key={id} type="button" className={`seg-btn ${pane === id ? "active" : ""}`} onClick={() => setPane(id)}>{label}</button>
            ))}
          </div>
          <div hidden={pane !== "scoreboard"}>
            {/* Leaderless squads belong with the squads: it is a fact about the roster, and it
                used to sit up in the match summary where you could not act on it. */}
            {ctx && ctx.noSlBySide.size > 0 && (
              <div className="live-context" style={{ marginBottom: 8 }}>
                {[...ctx.noSlBySide.entries()].map(([sideId, noSl]) => {
                  const side = game.sides.find((sd) => sd.id === sideId);
                  return (
                    <span className="lc-warn" key={sideId} title={`${side?.label ?? sideId} squads with nobody in a leader role (${game.squadLeaderRoles.map((r) => game.roleName(r)).join(", ")}). Hover a squad's "no SL" for the roles it is fielding.`}>
                      ⚠ <span className={`team-tag side-${side?.color ?? "neutral"}`}>{side?.label ?? sideId}</span> No SL: {noSl.join(", ")}
                    </span>
                  );
                })}
              </div>
            )}
            {players && <Scoreboard players={players} session={session as Record<string, unknown> | null} serverId={serverId} canFlags={canFlags} canActions={canActions} canGroups={canGroups} canVip={canVip} canVipPause={canVipPause} onChanged={load} remember="live" />}
          </div>
          <div hidden={pane !== "feed"}>
            {/* Mounted from the start, whichever tab is showing: the feed is a tail, and one that
                only begins when you look at it has already missed what you came to see. */}
            <LiveFeed serverId={serverId} alwaysLive round />
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}

/**
 * Who holds the ground, as ground. In warfare the two scores ARE the sector count — five caps,
 * one point each — so the score line already carries the answer, just as two numbers you have to
 * subtract. Drawn as the map's strongpoints left to right, each block coloured by its holder,
 * the front line is where the colour changes and a push shows up as a block flipping.
 */
function SectorBar({ allied, axis, game }: { allied?: number; axis?: number; game: GameCtx }) {
  const a = Number(allied ?? 0), x = Number(axis ?? 0);
  const total = a + x;
  // Only a scoreline that partitions a fixed set of caps can be read this way. Offensive and
  // skirmish score differently, so rather than draw a lie we draw nothing.
  if (!Number.isFinite(total) || total < 2 || total > 10) return null;
  const [left, right] = game.sides;
  return (
    <div className="sector-bar" title={`${left?.label ?? "Team A"} hold ${a} of ${total} · ${right?.label ?? "Team B"} hold ${x}`}>
      {Array.from({ length: total }, (_, i) => {
        // Allies take the left-hand blocks, axis the right — the same way the map reads.
        const holder = i < a ? left : right;
        return <span key={i} className={`sector side-${holder?.color ?? "neutral"}`} aria-label={`sector ${i + 1}: ${holder?.label ?? "?"}`} />;
      })}
      <span className="sector-count muted">{a} – {x} sectors</span>
    </div>
  );
}

/** Per-faction aggregate totals, summed from the live roster's score + stats. The two columns are
 *  the descriptor's first two sides; games without side data (or rich fields) show nothing. */
function TeamStats({ players }: { players: LivePlayer[] }) {
  const game = useGame();
  const [left, right] = game.sides;
  const anyData = players.some((p) => p.scoreData || p.stats);
  if (!left || !right || !anyData) return null;

  const agg = (sideId: string) => {
    const rows = players.filter((p) => sideIdOf(p, game) === sideId);
    const sum = (f: (p: LivePlayer) => number) => rows.reduce((a, p) => a + f(p), 0);
    const out: Record<string, number> = {
      players: rows.length,
      kills: sum((p) => (p.stats?.infantryKills ?? 0) + (p.stats?.vehicleKills ?? 0)),
      deaths: sum((p) => p.stats?.deaths ?? 0),
      teamKills: sum((p) => p.stats?.teamKills ?? 0),
    };
    for (const sf of game.scoreFields) out[`score:${sf.key}`] = sum((p) => p.scoreData?.[sf.key] ?? 0);
    return out;
  };
  const lv = agg(left.id), rv = agg(right.id);

  const rows: { key: string; label: string }[] = [
    { key: "players", label: "Players" },
    { key: "kills", label: "Kills" },
    { key: "deaths", label: "Deaths" },
    ...game.scoreFields.map((sf) => ({ key: `score:${sf.key}`, label: sf.title ?? sf.label })),
    { key: "teamKills", label: "Team kills" },
  ];
  const fmtN = (n: number) => n.toLocaleString();
  const sideCls = (side: typeof left) => `side-${side.color ?? "neutral"}`;

  return (
    <div className="team-stats">
      {rows.map((r) => {
        const a = lv[r.key] ?? 0, x = rv[r.key] ?? 0;
        const lead = a === x ? "" : a > x ? "a" : "x"; // highlight the leading side
        // Each row is a share of its own total, so the bars meet where the sides are even and the
        // split IS the answer — the empty space between two numbers used to carry nothing.
        const total = a + x;
        const share = (v: number) => (total > 0 ? (v / total) * 100 : 50);
        return (
          <div className="ts-row" key={r.key}>
            <span className={`ts-val a ${sideCls(left)} ${lead === "a" ? "lead" : ""}`}>{fmtN(a)}</span>
            <span className="ts-bar a"><i className={`ts-fill ${sideCls(left)}`} style={{ width: `${share(a)}%` }} /></span>
            <span className="ts-label">{r.label}</span>
            <span className="ts-bar x"><i className={`ts-fill ${sideCls(right)}`} style={{ width: `${share(x)}%` }} /></span>
            <span className={`ts-val x ${sideCls(right)} ${lead === "x" ? "lead" : ""}`}>{fmtN(x)}</span>
          </div>
        );
      })}
    </div>
  );
}
