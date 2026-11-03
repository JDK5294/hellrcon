"use client";
/**
 * Server connections — the "Connections" tab of the Config view: add/remove game servers, their
 * credentials and protocol, the observe/active engagement switch, plus the CRCON import/backup
 * tools. It's server *settings* (connection-level), so it lives with the rest of the server config
 * rather than as its own nav destination. Also exports the shared live Scoreboard used by LiveView.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { mayStillBeRunning, STILL_RUNNING_NOTE } from "../lib/unanswered";
import { useToast, useConfirm } from "../lib/feedback";
import { PlayerLink } from "./PlayerLink";
import { DOTS, PlayerActions } from "./PlayerActions";
import { TeamSplit, TK_FLAG_AT, isTkFlagged, killCount, missingLeader, noLeaderTip } from "./TeamSplit";
import { useAnchoredMenu } from "../lib/anchoredMenu";
import { PlayerPicker } from "./PlayerPicker";
import { CrconBackup } from "./CrconBackup";
import { useServers } from "../lib/servers";
import { isText, isTextOrNull, useRemembered } from "../lib/remembered";
import { PanelGroup, Panel } from "./Panel";
import { useGame } from "../lib/game";
import { levelClass } from "../lib/colors";
import { roleIconUrl } from "../lib/gameAssets";
import { platformLabel } from "../lib/platform";
import { ActionResult, AskNotice, Callout, EmptyState, Modal, Nothing, SkeletonLines, Toggle, Explanation } from "./ui";
import { fmtExact, fmtClock } from "../lib/time";
import { Time } from "./Time";
import { PlaceholderHint } from "./Placeholders";

interface Server {
  id: string;
  name: string;
  gameName?: string;
  nickname?: string | null;
  game?: string;
  host: string;
  port: number;
  protocol: string;
  /** the existing CRCON instance this server is bridged to; only meaningful on crcon-bridge. */
  crconBaseUrl?: string | null;
  /** when the panel last reached this server, and the most recent failure (cleared on success). */
  lastContactAt?: string | null;
  lastError?: string | null;
  lastErrorAt?: string | null;
  engagementMode: "observe" | "active";
  /** set = parked on the back burner: hidden everywhere but this tab, every record kept. */
  retiredAt?: string | null;
  /** set = stage 2: only the setup account still sees it (the API filters for everyone else). */
  decommissionedAt?: string | null;
  streamerMode?: boolean;
  /** the server's address on the public stats site (/stats/<slug>); null until staff name it. */
  publicSlug?: string | null;
  /** what the public site calls the server; falls back to `name`. */
  publicName?: string | null;
  /** whether the public site publishes platform ids beside names (off by default). */
  publicPlayerIds?: boolean;
  automation?: Partial<Record<string, boolean>>;
}

/** A first-guess URL name from the staff-facing label: lowercase, accent-stripped, hyphenated. */
function suggestSlug(name: string): string {
  return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
/** A registered game and the protocols it speaks, from GET /api/games. */
interface GameOption {
  id: string;
  label: string;
  protocols: { id: string; label: string }[];
}
/** Badges drawn on a roster row before the rest become a "+N" — the row is a slot, not a shelf. */
const ROW_BADGES = 3;

export interface LivePlayer {
  iD?: string; id?: string; name?: string; clanTag?: string; level?: number; platform?: string;
  team?: number; role?: number; platoon?: string; platoonIndex?: number; loadout?: string;
  stats?: { infantryKills?: number; vehicleKills?: number; deaths?: number; teamKills?: number; vehiclesDestroyed?: number };
  /** per-game score buckets; which keys exist (and their labels) comes from the game descriptor. */
  scoreData?: Record<string, number>;
  /** attached server-side: our internal player id (stable profile link) + watch/VIP flags. */
  playerDbId?: string | null; watch?: boolean; watchReason?: string | null; watchBy?: string | null; vip?: boolean;
  /** attached server-side: the identity rule found no usable player id — on the server, but
   *  invisible to stats/sessions/VIP until the id spelling is taught. */
  untracked?: boolean;
  consoleAdmin?: boolean; badges?: { emoji: string; label: string }[];
  /** attached server-side: the RESOLVED faction ("allies"/"axis") for this player's raw team
   *  number — corrected against the session's headcounts, so prefer it over mapping p.team
   *  locally (the static guess has mislabeled whole lobbies). */
  side?: string | null;
  /** attached server-side: when this session opened (our connect log) and how many recorded
   *  visits they have on this server. Null when we have no record — the columns show a dash. */
  sessionStartedAt?: string | null;
  visits?: number | null;
}
/** "1h 23m" / "23m" for the TIME column — minutes are the resolution staff think in. */
function fmtSession(sec: number): string {
  const m = Math.floor(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

const kills = (p: LivePlayer) => (p.stats?.infantryKills ?? 0) + (p.stats?.vehicleKills ?? 0);
const deaths = (p: LivePlayer) => p.stats?.deaths ?? 0;
const kd = (p: LivePlayer) => (deaths(p) ? kills(p) / deaths(p) : kills(p));

// Domain vocabulary (roles, factions, score buckets) comes from the game descriptor via useGame()
// — no per-game constants live in the panel.
const teamKills = (p: LivePlayer) => p.stats?.teamKills ?? 0;

const ACTIONS = [
  { value: "message", label: "Message" },
  { value: "kick", label: "Kick" },
  { value: "punish", label: "Punish" },
  { value: "tempban", label: "Temp ban" },
  { value: "permaban", label: "Perma ban" },
  { value: "unban_temp", label: "Remove temp ban" },
  { value: "unban_perma", label: "Remove perma ban" },
];

/**
 * Five grants meet on this screen and it used to honour none of them: whoever could see the tab got
 * the Add-server form, the credential editor, the observe/active switch, the automation switches and
 * the CRCON pull, and found out which ones were theirs by clicking and reading a 403. Each control
 * now asks for the permission its endpoint enforces — Add server too, which is server.add's.
 */
export default function Servers({ canAdd = true, canEdit = true, canManage = canEdit, canEngage = true, canImport = true, canImportRun = true, canProbe = true }: {
  /** server.add write — add a server. It carries the RCON password, which a request would keep in
   *  the queue, so it never asks and needs the permission itself. */
  canAdd?: boolean;
  /** server.manage write — edit a server's connection: the RCON password again, so likewise. */
  canEdit?: boolean;
  /** server.manage read — retire or bring back a server, its nickname and game, re-read its name
   *  from the game: without write, each change is sent for approval. */
  canManage?: boolean;
  /** server.config read — the Command check probe (what does this build's RCON accept). */
  canProbe?: boolean;
  /** server.engagement read — the observe/active switch and the per-automation switches (asked
   *  for, without write). */
  canEngage?: boolean;
  /** crcon.import read/write — see the archive panel at the bottom / actually run a pull. */
  canImport?: boolean;
  canImportRun?: boolean;
}) {
  const { refresh: refreshGlobal } = useServers();
  const [servers, setServers] = useState<Server[] | null>(null);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  // The registered games, fetched ONCE for the screen: the add form offers them, and every server
  // row needs them to name its own game and to offer the correction if it is labelled wrong.
  // null while loading or if the fetch failed — AddServer says so and offers a retry.
  const [games, setGames] = useState<GameOption[] | null>(null);
  const [gamesError, setGamesError] = useState("");
  const loadGames = useCallback(() => {
    setGamesError("");
    api<{ games: GameOption[] }>("/games")
      .then((r) => setGames(r.games ?? []))
      .catch((err) => { setGames(null); setGamesError((err as Error).message); });
  }, []);
  useEffect(loadGames, [loadGames]);

  // The base for shareable stats links: the dedicated public hostname when one is configured,
  // else this origin's /stats path. Comes from the API so the card never shows the admin
  // hostname on an install that deliberately hides it behind a separate stats domain.
  const [publicOrigin, setPublicOrigin] = useState<string | null>(null);
  // Whether this login is the SETUP account — the install's first created user. Stages 2 and 3
  // of retire → decommission → delete belong to that account alone, so the buttons only exist
  // for it (and the API refuses everyone else regardless).
  const [isSetupUser, setIsSetupUser] = useState(false);
  const load = useCallback(async () => {
    try {
      // includeRetired: this tab is the ONE place a retired server still exists. Everywhere
      // else — pickers, live view, workers, Discord, the public site — the default list hides it.
      const r = await api<{ servers: Server[]; isSetupUser?: boolean; publicStatsOrigin?: string | null }>("/servers?includeRetired=1");
      setServers(r.servers);
      setIsSetupUser(r.isSetupUser === true);
      setPublicOrigin(r.publicStatsOrigin ?? null);
      refreshGlobal(); // keep the sidebar switcher (name/engagement) in sync
    } catch (e) {
      setError((e as Error).message);
    }
  }, [refreshGlobal]);
  useEffect(() => { load(); }, [load]);
  const live = servers?.filter((s) => !s.retiredAt) ?? null;
  const retired = servers?.filter((s) => s.retiredAt && !s.decommissionedAt) ?? [];
  // Only ever non-empty for the setup account — the API strips these rows for everyone else.
  const decommissioned = servers?.filter((s) => s.decommissionedAt) ?? [];

  return (
    <PanelGroup viewId="servers">
      <Panel
        id="connections"
        caps="open"
        title="Connections"
        subtitle={live ? String(live.length) : undefined}
        actions={canAdd ? <button onClick={() => setShowAdd((v) => !v)}>{showAdd ? "Close" : "Add server"}</button> : undefined}
      >
        <p className="muted mt-0">Game servers this panel talks to — credentials, protocol, and the observe/active switch.</p>
        {(canManage || canEngage) && <AskNotice capability={[...(canManage ? ["server.manage"] : []), ...(canEngage ? ["server.engagement"] : [])]} />}
        {showAdd && <AddServer games={games} gamesError={gamesError} onRetryGames={loadGames} onAdded={() => { setShowAdd(false); load(); }} />}
        <ActionResult error={error} />
        {!servers && !error && <SkeletonLines lines={3} />}
        {live && !live.length && !retired.length && !decommissioned.length && (
          <EmptyState icon="🔌" title="No game servers connected yet"
            action={canAdd ? <button className="mini" onClick={() => setShowAdd(true)}>Add a server</button> : undefined}>
            This is the first thing to set up: give the panel a server&apos;s address and RCON password and it
            starts reading the roster and the game log. Everything else — the live view, player records,
            moderation — follows from a connected server.
          </EmptyState>
        )}
        <div className="recent-list">
          {live?.map((s) => (
            <div key={s.id}>
              <ServerCard server={s} games={games ?? []} onChanged={load} canEdit={canEdit} canManage={canManage} canEngage={canEngage} canProbe={canProbe} publicOrigin={publicOrigin} />
              {canManage && <RetireButton server={s} onChanged={load} />}
            </div>
          ))}
        </div>
      </Panel>
      {retired.length > 0 && (
        <Panel id="retiredservers" caps="open" title="Retired servers" subtitle={String(retired.length)}>
          <Explanation>
            Parked on the back burner: nothing polls them, and they exist nowhere but this tab — no
            pickers, no live view, no Discord, no public page. <strong>Every record they ever
            produced is kept</strong>: careers, match history, events, VIP history. Bring one back
            and it picks up exactly where it left off.
          </Explanation>
          <div className="recent-list">
            {retired.map((s) => <RetiredCard key={s.id} server={s} canEdit={canManage} isSetupUser={isSetupUser} onChanged={load} />)}
          </div>
        </Panel>
      )}
      {decommissioned.length > 0 && (
        <Panel id="decommissionedservers" caps="open" title="Decommissioned servers" subtitle={String(decommissioned.length)}>
          <Explanation>
            Visible to <strong>your account only</strong> — the login that set this panel up. Everyone
            else&apos;s Connections tab no longer lists them, but <strong>every record is still kept and
            retrievable</strong>: careers, match history, moderation history, events, VIP status. Restore
            one to put it back under Retired servers for everyone, or take the final, irreversible step.
          </Explanation>
          <div className="recent-list">
            {decommissioned.map((s) => <DecommissionedCard key={s.id} server={s} onChanged={load} />)}
          </div>
        </Panel>
      )}
      {servers && servers.length > 0 && canImport && <CrconBackup canRun={canImportRun} />}
    </PanelGroup>
  );
}

/** Stage 1 of retire → decommission → delete: the freely reversible parking spot. */
function RetireButton({ server, onChanged }: { server: Server; onChanged: () => void }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const retire = async () => {
    const ok = await confirm({
      title: `Retire ${server.name}?`,
      body: (
        <div>
          <p>The server moves to the back burner. It disappears from <strong>everything</strong> except
            this tab: server pickers, live view, rules, workers, Discord, and its public stats page.</p>
          <p><strong>Nothing is deleted.</strong> Careers, match history, events, bans and VIP history
            all stay, and old records keep showing this server&apos;s name. Bring it back any time.</p>
        </div>
      ),
      confirmLabel: "Retire it",
    });
    if (!ok) return;
    setBusy(true);
    try { await api(`/servers/${server.id}/retire`, { method: "POST" }); toast.success(`${server.name} retired — find it under Retired servers below`); onChanged(); }
    catch (err) { toast.error((err as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ textAlign: "right", marginTop: 4 }}>
      <button className="mini ghost" disabled={busy} onClick={retire}>Retire this server…</button>
    </div>
  );
}

function RetiredCard({ server, canEdit, isSetupUser, onChanged }: { server: Server; canEdit?: boolean; isSetupUser?: boolean; onChanged: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const bringBack = async () => {
    setBusy(true);
    try { await api(`/servers/${server.id}/unretire`, { method: "POST" }); toast.success(`${server.name} is back — polling resumes within a minute`); onChanged(); }
    catch (err) { toast.error((err as Error).message); }
    finally { setBusy(false); }
  };
  // Stage 2 — setup account only. Still nothing is deleted; the server just stops existing on
  // anyone else's Connections tab. The API refuses everyone else, so the button only renders
  // for the one login that can press it.
  const decommission = async () => {
    const ok = await confirm({
      title: `Decommission ${server.name}?`,
      body: (
        <div>
          <p>The server disappears from <strong>everyone else&apos;s Connections tab</strong> — from now on
            only your account (the login that set this panel up) can see it, under a Decommissioned
            servers section here.</p>
          <p><strong>Nothing is deleted.</strong> Careers, match history, moderation history, events and
            VIP status all stay kept and retrievable. You can restore it to plain retired at any time —
            and permanently deleting it only becomes possible from here.</p>
        </div>
      ),
      confirmLabel: "Decommission it",
    });
    if (!ok) return;
    setBusy(true);
    try { await api(`/servers/${server.id}/decommission`, { method: "POST" }); toast.success(`${server.name} decommissioned — now visible only to you, under Decommissioned servers`); onChanged(); }
    catch (err) { toast.error((err as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="card" style={{ opacity: 0.75 }}>
      <div className="row" style={{ alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <b>{server.name}</b>
        <span className="badge observe">retired</span>
        <span className="muted fs-sm">{server.host}:{server.port}{server.retiredAt ? ` · since ${fmtExact(server.retiredAt)}` : ""}</span>
        {canEdit && (
          <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button className="mini" disabled={busy} onClick={bringBack}>Bring back</button>
            {isSetupUser && <button className="mini ghost" disabled={busy} onClick={decommission}>Decommission…</button>}
          </span>
        )}
      </div>
    </div>
  );
}

/** Stage 2 rows — rendered only for the setup account (the API filters them for everyone else). */
function DecommissionedCard({ server, onChanged }: { server: Server; onChanged: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const restore = async () => {
    setBusy(true);
    try { await api(`/servers/${server.id}/recommission`, { method: "POST" }); toast.success(`${server.name} restored to retired — everyone's Connections tab lists it again`); onChanged(); }
    catch (err) { toast.error((err as Error).message); }
    finally { setBusy(false); }
  };
  const deleteForever = async () => {
    const ok = await confirm({
      title: `Permanently delete ${server.name}?`,
      body: (
        <div>
          <p><strong>This cannot be undone.</strong> What belonged to the server is erased:</p>
          <ul>
            <li>match history and reports, play sessions, kill/chat/connection events</li>
            <li>VIPs on this server <strong>including permanent ones</strong>, its bans, configs, rules, scoped triggers, and the stored CRCON archive</li>
          </ul>
          <p><strong>User history is never deleted.</strong> Careers players earned here keep counting,
            and the moderation record — kicks, bans, punishes, admin messages, camera watches — stays
            on every profile. Player identities, notes, watchlists, the economy, other servers and the
            audit trail survive too, including a receipt of this deletion.</p>
          <p>If in doubt, leave it decommissioned: it costs nothing and only you can see it.</p>
        </div>
      ),
      confirmLabel: "Delete it forever",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try { await api(`/servers/${server.id}`, { method: "DELETE" }); toast.success(`${server.name} permanently deleted — careers and moderation history kept`); onChanged(); }
    catch (err) { toast.error((err as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="card" style={{ opacity: 0.75 }}>
      <div className="row" style={{ alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <b>{server.name}</b>
        <span className="badge observe">decommissioned</span>
        <span className="muted fs-sm">{server.host}:{server.port}{server.decommissionedAt ? ` · since ${fmtExact(server.decommissionedAt)}` : ""}</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="mini" disabled={busy} onClick={restore}>Restore to retired</button>
          <button className="mini ghost" disabled={busy} onClick={deleteForever}>Delete forever…</button>
        </span>
      </div>
    </div>
  );
}

/**
 * `games` is null while loading OR when the fetch failed (gamesError says which). It used to be
 * swallowed into an empty list, which rendered as a Game dropdown with no options and no way to
 * recover short of reloading the page — exactly the dead form a one-off network blip leaves behind
 * on a phone. A failure is said out loud, with a retry that refetches in place.
 */
function AddServer({ games, gamesError, onRetryGames, onAdded }: {
  games: GameOption[] | null;
  gamesError: string;
  onRetryGames: () => void;
  onAdded: () => void;
}) {
  const [f, setF] = useState({ name: "", game: "hll", host: "", port: "", password: "", protocol: "binary-v2", crconBaseUrl: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Protocol options come from the selected game's module; switching game resets to its first protocol.
  const protocols = games?.find((g) => g.id === f.game)?.protocols ?? [{ id: "binary-v2", label: "binary-v2" }];
  useEffect(() => {
    if (!protocols.some((pr) => pr.id === f.protocol)) setF((prev) => ({ ...prev, protocol: protocols[0]?.id ?? "binary-v2" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.game, games?.length]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const bridge = f.protocol === "crcon-bridge";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api("/servers", {
        method: "POST",
        body: { name: f.name, game: f.game, host: f.host, port: Number(f.port), password: f.password, protocol: f.protocol, crconBaseUrl: f.crconBaseUrl },
      });
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="grid">
        <label>Name (optional)<input value={f.name} onChange={set("name")} placeholder="Auto from RCON if blank" /></label>
        <label>Game
          <select value={f.game} onChange={set("game")} disabled={!games}>
            {games
              ? games.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)
              : <option>{gamesError ? "Could not load the game list" : "Loading games…"}</option>}
          </select>
        </label>
        {gamesError && (
          <p className="error" role="alert">
            Could not load the game list — {gamesError}{" "}
            <button type="button" onClick={onRetryGames}>Retry</button>
          </p>
        )}
        <label>Protocol
          <select value={f.protocol} onChange={set("protocol")}>
            {protocols.map((pr) => <option key={pr.id} value={pr.id}>{pr.label}</option>)}
          </select>
        </label>
        <label>Host<input value={f.host} onChange={set("host")} required /></label>
        <label>Port<input value={f.port} onChange={set("port")} inputMode="numeric" required /></label>
        <label>{bridge ? "CRCON API key" : "RCON password"}<input type="password" value={f.password} onChange={set("password")} required /></label>
        {bridge && <label>CRCON base URL<input value={f.crconBaseUrl} onChange={set("crconBaseUrl")} placeholder="https://crcon.example.com" required /></label>}
      </div>
      <Explanation>
        New servers start in <strong>observe</strong> mode (read-only) — safe alongside an existing CRCON.
        {bridge && " crcon-bridge is read-only and issues no RCON of its own."}
      </Explanation>
      <div className="actions"><button type="submit" disabled={busy || !games}>Add</button></div>
      <ActionResult error={error} />
    </form>
  );
}

/**
 * Whether the panel can actually reach this server.
 *
 * This is here because its absence cost a week. A host rotated one server's RCON password; every
 * read and every write to that server failed authentication from that moment on, and this card
 * went on showing it beside two healthy servers with nothing to distinguish it. The only record of
 * the failure was a warning in a container log. It surfaced when a ban dialog happened to throw the
 * error at somebody, days later.
 *
 * So a server that is not answering says so, in the place staff already look, with the reason the
 * server itself gave — "(401) Unable to perform request. Missing authentication credentials" names
 * its own fix — and with when it was last reachable, which separates "broken just now" from
 * "broken since the day it was added". A healthy server stays quiet: a green tick on everything
 * teaches people to stop reading, and the point is that the unhealthy one stands out.
 */
function ConnectionHealth({ server }: { server: Server }) {
  if (!server.lastError) {
    // Only worth saying once we have actually reached it — before the first successful dial there
    // is nothing to report, and "never contacted" on a server added ten seconds ago is noise.
    if (!server.lastContactAt) return null;
    return <p className="muted fs-sm" style={{ margin: "4px 0 0" }}>Last reached <Time iso={server.lastContactAt} /></p>;
  }
  return (
    <div className="error" role="status" style={{ margin: "6px 0 0" }}>
      <strong>Not answering.</strong>{" "}
      <span title={server.lastErrorAt ? fmtExact(server.lastErrorAt) : undefined}>{server.lastError}</span>
      {server.lastContactAt
        ? <> — last reached <Time iso={server.lastContactAt} />.</>
        : <> It has never answered since it was added.</>}
      {" "}Check the address, port and password under <strong>Connection</strong>.
    </div>
  );
}

/**
 * The live command catalogue: what THIS server's build accepts, against what the panel knows.
 *
 * The game's v2 command list lives on the running server, not in any file we hold — the official
 * client discovers it at login the same way. So after a game update, this is the screen that
 * answers "what did they add": anything the server offers that our recorded baseline has never
 * heard of is listed first. Mounted only while open, so every look is a fresh ask of the server.
 */
function CommandSurface({ s }: { s: Server }) {
  interface Probe {
    commands: { id: string; friendly: string | null; clientSupported: boolean; status: "new" | "known" | "wired" }[];
    counts: { new: number; known: number; wired: number };
    baseline: string;
  }
  const [data, setData] = useState<Probe | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let gone = false;
    setData(null); setError("");
    api<Probe>(`/servers/${s.id}/rcon-commands`)
      .then((d) => { if (!gone) setData(d); })
      .catch((e: Error) => { if (!gone) setError(e.message); });
    return () => { gone = true; };
  }, [s.id]);

  if (error) return <div className="admin-panel"><p className="muted mt-0">{error}</p></div>;
  if (!data) return <div className="admin-panel"><SkeletonLines lines={2} /></div>;
  const group = (status: Probe["commands"][number]["status"]) => data.commands.filter((c) => c.status === status);
  const names = (rows: Probe["commands"]) => rows.map((c) => (
    <code key={c.id} title={c.friendly ?? undefined} style={{ marginRight: 6 }}>{c.id}</code>
  ));
  return (
    <div className="admin-panel">
      <p className="muted mt-0">
        The server's own answer to "which commands does this build accept" — {data.commands.length} in all,
        compared against the {data.baseline}.
      </p>
      {group("new").length ? (
        <p><strong>New to this panel ({data.counts.new})</strong> — not in our baseline; if the game just
          updated, this is what it added: <br />{names(group("new"))}</p>
      ) : (
        <p><strong>Nothing new</strong> — every command this server offers is already in our baseline.</p>
      )}
      {group("known").length > 0 && (
        <p className="muted fs-sm"><strong>Known, not yet driven by a panel feature ({data.counts.known}):</strong>{" "}
          {names(group("known"))}</p>
      )}
      <p className="muted fs-sm"><strong>Wired ({data.counts.wired}):</strong> already behind panel features.</p>
    </div>
  );
}

/**
 * Change how the panel reaches a server that already exists — address, port, credential, protocol.
 *
 * There was no way to do this, and no way around it either: a password could be set once, at add
 * time, so a host rotating the RCON credential left the panel dialling with the old one. Every
 * write to that server failed authentication — bans stopped applying, unbans stopped lifting — and
 * putting the new password in the environment did not help, because discovery treats the env as a
 * seed and will not overwrite a server it already knows. The only fix left was editing the database.
 *
 * Mounted only while open, which is deliberate: the drafts seed from the server on mount, and
 * closing the editor drops the typed password rather than parking it in the card's state. The
 * stored password is never sent to the browser and the field starts blank — blank means "keep the
 * current one", so an unrelated port change cannot silently wipe the credential.
 */
function ConnectionEditor({ s, games, onSaved, onClose }: {
  s: Server;
  games: GameOption[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [f, setF] = useState({
    host: s.host,
    port: String(s.port),
    password: "",
    protocol: s.protocol,
    crconBaseUrl: s.crconBaseUrl ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((prev) => ({ ...prev, [k]: e.target.value }));
  const protocols = games.find((g) => g.id === (s.game ?? "hll"))?.protocols ?? [{ id: s.protocol, label: s.protocol }];
  const bridge = f.protocol === "crcon-bridge";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      // Only what actually differs, and the password only when one was typed. Sending the whole
      // form would list every field as changed in the audit trail whatever was touched.
      const body: Record<string, unknown> = {};
      if (f.host.trim() !== s.host) body.host = f.host.trim();
      if (Number(f.port) !== s.port) body.port = Number(f.port);
      if (f.password) body.password = f.password;
      if (f.protocol !== s.protocol) body.protocol = f.protocol;
      if ((f.crconBaseUrl.trim() || null) !== (s.crconBaseUrl ?? null)) body.crconBaseUrl = f.crconBaseUrl.trim();
      if (!Object.keys(body).length) { setError("Nothing changed."); return; }
      await api(`/servers/${s.id}/connection`, { method: "PUT", body });
      // The save is done, so the form goes away NOW. The reachability check that follows is a real
      // round trip to the game and a wrong address spends the whole connect timeout failing — half
      // a minute of a disabled "Saving…" button, on the one screen someone reaches while something
      // is already broken. It runs on its own and speaks up when it has an answer.
      toast.success("Saved. Testing the connection…");
      onSaved();
      onClose();
      // The name re-read only succeeds if the credential works, which makes it the test: it says
      // whether the new details actually reach the server, rather than leaving staff to find out
      // from a ban that fails an hour later.
      void api<{ resolved: boolean }>(`/servers/${s.id}/refresh-name`, { method: "POST" })
        .then((probe) => {
          if (probe.resolved) toast.success(`${s.name} answered — the connection works.`);
          else toast.error(`Saved, but ${s.name} did not answer. Check the address, port and password.`);
          onSaved();
        })
        .catch(() => toast.error(`Saved, but ${s.name} could not be reached to test it.`));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="admin-panel" onSubmit={submit}>
      <Explanation>
        How the panel reaches <strong>{s.name}</strong>. Change these when the host moves the server or
        rotates its RCON password — nothing else about the server (its records, bans or settings) is affected.
      </Explanation>
      <div className="grid">
        <label>Host<input value={f.host} onChange={set("host")} required /></label>
        <label>Port<input value={f.port} onChange={set("port")} inputMode="numeric" required /></label>
        <label>Protocol
          <select value={f.protocol} onChange={set("protocol")}>
            {protocols.map((pr) => <option key={pr.id} value={pr.id}>{pr.label}</option>)}
          </select>
        </label>
        <label>{bridge ? "CRCON API key" : "RCON password"}
          <input type="password" value={f.password} onChange={set("password")} autoComplete="new-password"
            placeholder="Leave blank to keep the current one" />
        </label>
        {bridge && <label>CRCON base URL<input value={f.crconBaseUrl} onChange={set("crconBaseUrl")} placeholder="https://crcon.example.com" required /></label>}
      </div>
      <p className="hint">
        The stored password is never shown here. Leaving the field blank keeps it; typing a new one replaces it.
      </p>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>{busy ? "Saving…" : "Save & test"}</button>
        <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
      <ActionResult error={error} />
    </form>
  );
}

/**
 * The automations that can act on a server, one switch each.
 *
 * This is the staged path off CRCON: observe mode is all-or-nothing, but a community migrating one
 * system at a time needs "active, and ONLY the map vote runs here" while CRCON still owns VIP and
 * enforcement. Order matches how likely each is to be the first system handed over.
 *
 * Every switch is on until turned off, except the reconcilers' "Fix what it finds" (`parent` names
 * the reconciler it belongs to): those are off until staff turn them on, and the store keeps only
 * what differs from each one's default — the API's SERVER_AUTOMATION_DEFAULT_OFF is the same list.
 */
type AutomationSwitch = {
  key: string; label: string; blurb: string;
  /** a sub-switch of this one: shown under it, and only meaningful while it is on. */
  parent?: string;
  defaultOff?: boolean;
  /** asked before switching ON — these let the app act on the game with nobody pressing. */
  arm?: { title: string; body: string; confirmLabel: string };
};
const AUTOMATION_SWITCHES: AutomationSwitch[] = [
  { key: "mapvote", label: "Map vote", blurb: "Match-end polls, winner applied as next map, reminders." },
  { key: "broadcast", label: "Broadcast", blurb: "The rotating in-game message cycle." },
  { key: "seeding", label: "Seeding", blurb: "Seeder thresholds, announcements and rewards." },
  { key: "autosettings", label: "Auto settings & rules", blurb: "Scheduled config profiles and player-rule enforcement (kicks, punishes)." },
  { key: "vipSweep", label: "VIP expiry sweep", blurb: "Removes lapsed VIP grants from the game and restores paused ones. Leave off while another system still owns VIP." },
  { key: "consoleAdminSweep", label: "Console admin expiry sweep", blurb: "Removes lapsed console-admin grants from the game." },
  { key: "banSync", label: "Ban reconciliation", blurb: "Every few minutes, compares this server's ban list with the ban record: bans it is missing (including ones decided before it existed), bans that were unbanned or expired, and bans placed outside the panel. It reports what it finds in Activity, and changes the ban list only with Fix what it finds on." },
  {
    key: "banSyncApply", parent: "banSync", defaultOff: true, label: "Fix what it finds",
    blurb: "Applies the missing bans and lifts the stale ones on its own. Bans placed outside the panel are only ever reported. Leave it off while another tool still bans players on this server. Off: it only reports, and staff apply its plan from the Bans page (Sync with game).",
    arm: {
      title: "Let ban reconciliation fix this server's ban list?",
      body: "Every few minutes it will push the standing bans this server is missing — including ones decided before it existed — and lift bans whose decision was unbanned or expired, with nobody pressing anything. Bans placed outside the panel are never touched, but a ban another tool places on a player the panel has unbanned reads as stale and is lifted: leave this off while another tool still bans players here. Read a few of its reports in Activity first: they show whether this server agrees with the ban record.",
      confirmLabel: "Fix automatically",
    },
  },
  { key: "vipSync", label: "VIP reconciliation", blurb: "Every few minutes, checks this server's live VIP list against the panel's grants: grants the game is not honouring (a wiped or never-landed VIP list), entries that should be gone (expired or paused), and VIPs added outside the panel. It reports what it finds in Activity, and changes the VIP list only with Fix what it finds on." },
  {
    key: "vipSyncApply", parent: "vipSync", defaultOff: true, label: "Fix what it finds",
    blurb: "Restores the grants the game is missing and removes entries whose grant has expired or is paused, on its own. VIPs added outside the panel are only ever reported. Leave it off while another tool still manages VIP on this server. Off: it only reports, and staff sync from the VIPs page (Sync with game).",
    arm: {
      title: "Let VIP reconciliation fix this server's VIP list?",
      body: "Every few minutes it will give VIP back to players whose grant the game is not honouring, and take it off the game where the grant has expired or is paused (a VIP timeout stays off the game), with nobody pressing anything. It copies the panel's grants to the game and never changes a grant. VIPs added outside the panel are never touched, but it puts back any panel grant another tool takes off: leave this off while another tool still manages VIP here. Read a few of its reports in Activity first: they show whether this server agrees with the panel.",
      confirmLabel: "Fix automatically",
    },
  },
];

/** A switch's state on this server: what is stored, else its default. */
function switchOn(automation: Partial<Record<string, boolean>> | null | undefined, sw: AutomationSwitch): boolean {
  const v = automation?.[sw.key];
  return typeof v === "boolean" ? v : !sw.defaultOff;
}

function ServerCard({ server: s, games, onChanged, canEdit, canManage, canEngage, canProbe, publicOrigin }: { server: Server; games: GameOption[]; onChanged: () => void | Promise<void>; canEdit: boolean; canManage: boolean; canEngage: boolean; canProbe: boolean; publicOrigin: string | null }) {
  const toast = useToast();
  const confirm = useConfirm();
  const observe = s.engagementMode === "observe";
  const [showAdmin, setShowAdmin] = useState(false);
  const [showConn, setShowConn] = useState(false);
  const [showCmds, setShowCmds] = useState(false);
  const [showAutomation, setShowAutomation] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [players, setPlayers] = useState<LivePlayer[] | null>(null);
  const [session, setSession] = useState<Record<string, unknown> | null>(null);
  const [liveErr, setLiveErr] = useState("");
  /** Roster entries the app could not key to a player id — on the server, invisible to stats. */
  const [untracked, setUntracked] = useState<{ count: number; keys: string[] } | null>(null);
  const [nameBusy, setNameBusy] = useState(false);
  const [gameBusy, setGameBusy] = useState(false);
  const [pubBusy, setPubBusy] = useState(false);
  // The mode and publish switches, in flight: a second press sent the same change again — two
  // lines in the activity log for one change, and a phone alert that it was changed "again".
  const [engageBusy, setEngageBusy] = useState(false);
  const [streamBusy, setStreamBusy] = useState(false);
  const [slugDraft, setSlugDraft] = useState(s.publicSlug ?? "");
  const [nickDraft, setNickDraft] = useState(s.nickname ?? "");
  const [nickBusy, setNickBusy] = useState(false);
  // Saving a nickname must reach the GLOBAL server context too — that context is what every
  // picker in the panel reads, and it caches its own copy of the list.
  const { refresh: refreshGlobalServers } = useServers();
  const [pubNameDraft, setPubNameDraft] = useState(s.publicName ?? "");
  const [idsDraft, setIdsDraft] = useState(Boolean(s.publicPlayerIds));
  // The card never remounts across reloads (it is keyed by id), so a saved profile has to be
  // pulled back into the drafts — otherwise the fields show the pre-save text forever.
  useEffect(() => {
    setSlugDraft(s.publicSlug ?? ""); setPubNameDraft(s.publicName ?? ""); setIdsDraft(Boolean(s.publicPlayerIds));
    setNickDraft(s.nickname ?? "");
  }, [s.publicSlug, s.publicName, s.publicPlayerIds, s.nickname]);
  // The registered game's own name, falling back to the stored id for a game this build no longer
  // has a module for — showing a blank there would hide exactly the server that needs attention.
  const gameLabel = games.find((g) => g.id === s.game)?.label ?? s.game;

  // admin action form
  const [action, setAction] = useState("message");
  const [playerId, setPlayerId] = useState("");
  const [message, setMessage] = useState("");
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState("");
  const [result, setResult] = useState<{ text: string; cls: string }>({ text: "", cls: "muted" });
  // In flight: a second press would send the action twice — a message read twice, a punish twice.
  const [acting, setActing] = useState(false);

  async function toggleEngagement() {
    const mode = observe ? "active" : "observe";
    if (mode === "active" && !(await confirm({
      title: "Switch to Active mode?",
      body: "Active mode lets the panel send commands to the game server — kicks, bans, map changes and automation all take effect for real. Observe mode only reads.",
      confirmLabel: "Go active",
    }))) return;
    setEngageBusy(true);
    try {
      await api(`/servers/${s.id}/engagement`, { method: "POST", body: { mode } });
      // Held until the list has the new mode: released sooner, the button stood for a moment with
      // its old label, and a press then sent the same change again.
      await onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setEngageBusy(false);
    }
  }

  /**
   * Publishing makes this server's read-only state reachable by ANYONE, two ways off one switch:
   * the public stats page at /stats/<slug>, and CRCON's public API names beneath the same base
   * URL (so streamers' existing overlay tools work unchanged). Turning it ON is confirmed — it is
   * the only thing here that opens data to the internet, and it includes player names and ids,
   * exactly as CRCON's own public scoreboard does.
   */
  async function toggleStreamer() {
    const enabled = !s.streamerMode;
    if (enabled && !(await confirm({
      title: "Publish this server's stats?",
      body: "Anyone with the link can see the live scoreboard, past rounds, per-player stats and match history, with no login. Player names AND platform ids (Steam64 / EOS) are shown, matching CRCON — untick \"Publish player ids\" below if you want names only. Streamers' CRCON overlay tools work against the same address. It is read-only and never includes IPs, notes, bans or Discord identities. Turn it off again at any time.",
      confirmLabel: "Publish",
    }))) return;
    setStreamBusy(true);
    try {
      await api(`/servers/${s.id}/streamer-mode`, { method: "POST", body: { enabled } });
      // First publish with no address yet: seed the URL name from the server's label so the page
      // is reachable immediately — staff can rename it below.
      if (enabled && !s.publicSlug) {
        const slug = suggestSlug(s.publicName || s.gameName || s.name);
        if (slug) await api(`/servers/${s.id}/public-profile`, { method: "POST", body: { publicSlug: slug, publicName: s.publicName ?? "" } }).catch(() => {});
      }
      await onChanged(); // held until the list has it, as the mode switch is
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setStreamBusy(false);
    }
  }

  async function savePublicProfile() {
    setPubBusy(true);
    try {
      await api(`/servers/${s.id}/public-profile`, { method: "POST", body: { publicSlug: slugDraft.trim(), publicName: pubNameDraft.trim(), publicPlayerIds: idsDraft } });
      toast.success("Public address saved.");
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPubBusy(false);
    }
  }

  async function setSwitch(sw: AutomationSwitch, enabled: boolean) {
    if (enabled && sw.arm && !(await confirm(sw.arm))) return;
    setAutoBusy(true);
    try {
      // Send the full picture, not a delta: the API stores exceptions-only, and building the map
      // from the row means two people toggling different switches converge instead of fighting.
      const automation: Record<string, boolean> = {};
      for (const each of AUTOMATION_SWITCHES) automation[each.key] = switchOn(s.automation, each);
      automation[sw.key] = enabled;
      await api(`/servers/${s.id}/automation`, { method: "PUT", body: { automation } });
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAutoBusy(false);
    }
  }

  async function saveNickname() {
    setNickBusy(true);
    try {
      await api(`/servers/${s.id}/nickname`, { method: "POST", body: { nickname: nickDraft.trim() } });
      toast.success(nickDraft.trim() ? "Nickname saved — pickers across the panel now use it." : "Nickname cleared — the real name shows again.");
      onChanged();
      refreshGlobalServers();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setNickBusy(false);
    }
  }

  async function refreshName() {
    setNameBusy(true);
    try {
      const r = await api<{ resolved: boolean }>(`/servers/${s.id}/refresh-name`, { method: "POST" });
      if (r.resolved) onChanged();
    } catch {
      /* best-effort */
    } finally {
      setNameBusy(false);
    }
  }

  /**
   * Correct a mislabelled game. Confirmed, because the game decides how every read of this server
   * is interpreted — and because rows already written under the old game id (ban records, map name
   * overrides) keep that id, which makes this a repair for a server labelled wrong from the start
   * rather than a way to repoint a server that has been running.
   */
  async function changeGame(game: string) {
    const to = games.find((g) => g.id === game);
    if (!to || game === s.game) return;
    if (!(await confirm({
      title: `Set ${s.name} to ${to.label}?`,
      body: "The game decides how this server is read — roles, factions, weapons, map names, and how players are identified. Correct it only if the server really runs this game; bans and map names already recorded under the old game stay attached to it.",
      confirmLabel: `Set to ${to.label}`,
    }))) return;
    setGameBusy(true);
    try {
      await api(`/servers/${s.id}/game`, { method: "POST", body: { game } });
      toast.success(`${s.name} is now ${to.label}.`);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setGameBusy(false);
    }
  }

  async function viewLive() {
    setPlayers(null);
    setLiveErr("");
    try {
      const live = await api<{ players: unknown; session?: Record<string, unknown>; untrackedCount?: number; untrackedSampleKeys?: string[] }>(`/servers/${s.id}/live`);
      const arr = Array.isArray(live.players)
        ? (live.players as LivePlayer[])
        : Array.isArray((live.players as { players?: LivePlayer[] })?.players)
          ? (live.players as { players: LivePlayer[] }).players
          : [];
      setSession(live.session ?? null);
      setPlayers(arr);
      setUntracked(live.untrackedCount ? { count: live.untrackedCount, keys: live.untrackedSampleKeys ?? [] } : null);
    } catch (e) {
      setLiveErr((e as Error).message);
    }
  }

  async function runAction() {
    if (!playerId.trim()) return setResult({ text: "Enter a player ID.", cls: "muted" });
    // Same rule the action modals enforce: a punish reaches the player as ONLY the reason text,
    // so a blank one shows them a penalty with no explanation (and the API refuses it).
    if (action === "punish" && !reason.trim()) return setResult({ text: "Type a reason — the player sees it, and it goes in the log.", cls: "muted" });
    setResult({ text: "Applying…", cls: "muted" });
    setActing(true);
    try {
      await api(`/servers/${s.id}/actions`, { method: "POST", body: { action, playerId: playerId.trim(), message, reason, hours: Number(hours || 0) } });
      setResult({ text: `✓ ${action} sent.`, cls: "ok" });
    } catch (e) {
      setResult({ text: (e as Error).message, cls: "error" });
    } finally {
      setActing(false);
    }
  }

  function actOn(p: LivePlayer) {
    setShowAdmin(true);
    setPlayerId(p.iD || p.id || "");
    setResult({ text: `Target: ${p.name || p.iD || p.id}`, cls: "muted" });
  }

  return (
    <div className="subcard">
      <div className="row">
        <div>
          <strong>{s.name}</strong><br />
          {/* With a nickname set, `name` above IS the nickname — the game's own name still has to
              be readable HERE, because this card is where the real thing gets managed. */}
          {s.nickname && s.gameName && <><span className="muted fs-sm">{s.gameName}</span><br /></>}
          {/* The game's real label, not its id: "hll" told nobody whether this is the right game,
              which is exactly the check someone needs to make on a server seeded from the env. */}
          <span className="muted">{s.host}:{s.port} · {s.protocol}{s.game ? ` · ${gameLabel}` : ""}</span>
        </div>
        <span className={`badge ${observe ? "observe" : "active"}`}>{s.engagementMode}</span>
      </div>
      <ConnectionHealth server={s} />
      {/* The public addresses, shown only while the server is published so they never read as
          links that work when they do not. One base serves both audiences: the page for a player
          with a browser, and — because a CRCON tool appends `/api/<command>` to its base URL
          itself — the same address for a streamer's overlay tool. */}
      {s.streamerMode && (
        <div className="subcard" style={{ marginTop: 8 }}>
          <p className="muted fs-sm" style={{ marginTop: 0 }}>
            <strong>Public stats are live.</strong>{" "}
            {s.publicSlug
              ? (() => {
                  // On a dedicated stats hostname the link is bare (stats.example.com/nam) and
                  // never carries the admin origin; without one it is this origin's /stats path.
                  const share = publicOrigin ? `${publicOrigin}/${s.publicSlug}` : `${typeof window === "undefined" ? "" : window.location.origin}/stats/${s.publicSlug}`;
                  return <>Page &amp; CRCON tool base:{" "}
                    <a href={share} target="_blank" rel="noreferrer"><code>{share}</code></a>
                    {publicOrigin ? <> <span title="This address serves only the public stats site — sharing it reveals nothing about the panel's own URL.">(dedicated stats domain)</span></> : null}
                  </>;
                })()
              : <>Set a URL name below to give it an address (the old <code>/s/&lt;id&gt;</code> base keeps working meanwhile).</>}
          </p>
          {canEngage && (
            <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <label className="muted fs-sm">URL name{" "}
                <input value={slugDraft} onChange={(e) => setSlugDraft(e.target.value)} placeholder={suggestSlug(s.publicName || s.gameName || s.name) || "nam"}
                  style={{ maxWidth: 140 }} title="The address players share: /stats/<this>. Lowercase letters, digits and hyphens." />
              </label>
              <label className="muted fs-sm">Public name{" "}
                <input value={pubNameDraft} onChange={(e) => setPubNameDraft(e.target.value)} placeholder={s.gameName ?? s.name}
                  style={{ maxWidth: 220 }} title="What the public page calls this server. Blank = the staff-facing name." />
              </label>
              <button className="mini" disabled={pubBusy || (slugDraft === (s.publicSlug ?? "") && pubNameDraft === (s.publicName ?? "") && idsDraft === Boolean(s.publicPlayerIds))}
                onClick={() => void savePublicProfile()}>{pubBusy ? "Saving…" : "Save"}</button>
            </div>
          )}
          {/* On by default (CRCON parity — the ids are what a consuming tool joins on), but kept as
              its own switch so ids can be pulled for one server without unpublishing its page. */}
          {canEngage && (
            <div className="muted fs-sm" style={{ marginTop: 6 }}>
              <Toggle checked={idsDraft} onChange={setIdsDraft}
                title="Steam64 / EOS ids beside each name, exactly as CRCON's public scoreboard shows them. Switch off for names only — statistics are unaffected either way."
                label={<>Publish player ids{idsDraft !== Boolean(s.publicPlayerIds) ? " — remember to Save" : ""}{!s.publicPlayerIds ? <strong> (names only right now)</strong> : null}</>} />
            </div>
          )}
        </div>
      )}
      {/* The staff alias, next to the game picker because both answer "what is this box":
          once set, the whole app calls the server this — the public stats page alone keeps the
          real identity, with the alias quoted beside it. */}
      {canManage && (
        <label className="muted fs-sm">
          Panel nickname{" "}
          <input value={nickDraft} onChange={(e) => setNickDraft(e.target.value)} placeholder="e.g. WW2 Main"
            style={{ maxWidth: 180 }}
            title="A short alias the whole app calls this server — panel, Discord and in-game messages alike. Only the public stats page keeps the game's real name, showing this alias quoted beside it. Blank shows the real name everywhere again." />
          {nickDraft.trim() !== (s.nickname ?? "") && (
            <button className="mini" disabled={nickBusy} onClick={() => void saveNickname()}>{nickBusy ? "Saving…" : "Save"}</button>
          )}
        </label>
      )}
      {/* Correcting the game is only offered when there is another one to pick — a single-game
          build has nothing to choose, and the control would just be noise. */}
      {canManage && games.length > 1 && (
        <label className="muted fs-sm">
          Game{" "}
          <select value={s.game ?? "hll"} disabled={gameBusy} onChange={(e) => void changeGame(e.target.value)}
            title="Which game this server runs — decides how its roster, roles, factions and maps are read">
            {games.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
          </select>
        </label>
      )}
      <div className="actions">
        <button onClick={viewLive}>View live</button>
        <button onClick={() => setShowAdmin((v) => !v)}>Admin action</button>
        {canEdit && <button onClick={() => setShowConn((v) => !v)} title="Change the address, port, protocol or RCON password this panel uses to reach the server">Connection</button>}
        {canManage && <button onClick={refreshName} disabled={nameBusy} title="Pull the current name from the server over RCON">↻ Name</button>}
        {canProbe && <button onClick={() => setShowCmds((v) => !v)} title="Ask the server which RCON commands its current build accepts, and compare that against what this panel drives — the way to see what a game update added">Command check</button>}
        {canEngage && <button onClick={toggleEngagement} disabled={engageBusy}>{observe ? "Switch to active" : "Switch to observe"}</button>}
        {canEngage && <button onClick={toggleStreamer} disabled={streamBusy}>{s.streamerMode ? "Unpublish stats" : "Publish stats"}</button>}
        {canEngage && (
          <button onClick={() => setShowAutomation((v) => !v)}>
            Automation{(() => {
              const off = AUTOMATION_SWITCHES.filter((sw) => !sw.defaultOff && !switchOn(s.automation, sw)).length;
              const fixing = AUTOMATION_SWITCHES.filter((sw) => sw.defaultOff && switchOn(s.automation, sw) && (!sw.parent || switchOn(s.automation, AUTOMATION_SWITCHES.find((p) => p.key === sw.parent)!))).length;
              const parts = [off ? `${off} off` : "", fixing ? `${fixing} fixing` : ""].filter(Boolean);
              return parts.length ? ` (${parts.join(" · ")})` : "";
            })()}
          </button>
        )}
      </div>

      {showConn && <ConnectionEditor s={s} games={games} onSaved={onChanged} onClose={() => setShowConn(false)} />}

      {showCmds && <CommandSurface s={s} />}

      {showAutomation && (
        <div className="admin-panel">
          <p className="muted mt-0">
            Which of this app's automations may act on <strong>this server</strong>. Adopting the app one
            system at a time? Turn everything off except what it should own — the rest stays with whatever
            runs it today — then switch the server to active.
            {observe && <> Right now <strong>observe</strong> mode overrides all of it: nothing writes to the game either way.</>}
          </p>
          {AUTOMATION_SWITCHES.map((sw) => {
            const on = switchOn(s.automation, sw);
            // A fix switch does nothing while its reconciler is off, so it waits greyed out under it
            // (keeping its setting for when the reconciler comes back on).
            const parentOff = sw.parent ? !switchOn(s.automation, AUTOMATION_SWITCHES.find((p) => p.key === sw.parent)!) : false;
            return (
              <div key={sw.key} style={{ margin: "8px 0", ...(sw.parent ? { marginLeft: 28 } : {}) }}>
                <Toggle checked={on} disabled={autoBusy || parentOff} onChange={(v) => void setSwitch(sw, v)}
                  label={<span><strong>{sw.label}</strong><br /><span className="muted">{sw.blurb}{parentOff ? " (Its reconciler is off on this server.)" : ""}</span></span>} />
              </div>
            );
          })}
          <Explanation>Changes take effect within a minute — the worker restarts this server's loops when one of theirs flips. The reconcilers pick theirs up at their next check, every few minutes.</Explanation>
        </div>
      )}

      {showAdmin && (
        <div className="admin-panel">
          {observe && <p className="muted">This server is in <strong>observe</strong> mode (read-only). Switch it to <strong>active</strong> to issue actions.</p>}
          <div className="admin-grid">
            <PlayerPicker
              value={playerId ? { playerId, name: "" } : null}
              onChange={(p) => setPlayerId(p?.playerId ?? "")}
              game={s.game}
              placeholder="Search a player, or paste an id…" />
            <select aria-label="Action" value={action} onChange={(e) => setAction(e.target.value)}>
              {ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
            {action === "message" && <input placeholder="Message" value={message} onChange={(e) => setMessage(e.target.value)} />}
            <input placeholder={action === "punish" ? "Reason (required — the player sees it)" : "Reason (optional)"} value={reason} onChange={(e) => setReason(e.target.value)} />
            {action === "tempban" && <input type="number" min="1" placeholder="Hours" value={hours} onChange={(e) => setHours(e.target.value)} />}
            <button onClick={runAction} disabled={acting}>Apply</button>
          </div>
          <p className={`admin-result ${result.cls}`}>{result.text}</p>
        </div>
      )}

      <ActionResult error={liveErr} />
      {players && untracked && untracked.count > 0 && (
        <Callout variant="warn">
          <strong>{untracked.count}</strong> player{untracked.count === 1 ? "" : "s"} on the server can&apos;t be
          identified by the app — the game&apos;s roster data carries no usable player id for them. They show in
          the list below, but <strong>no stats, sessions, VIP or analytics can attach to them</strong>, which is
          how a whole platform ends up looking near-zero on the stats pages while you watch them play.
          {untracked.keys.length > 0 && (
            <> The fields the game DOES send for them: <code>{untracked.keys.join(", ")}</code> — report these
            and the id spelling can be taught in one change.</>
          )}
        </Callout>
      )}
      {players && <Scoreboard players={players} session={session} onAct={actOn} />}
    </div>
  );
}

/** A sortable scoreboard column. `sort` yields the comparable value (numeric columns sort high→low
 *  first); `cell` renders the display. Columns with no `sort` (e.g. the action button) aren't clickable. */
interface Col {
  key: string;
  label: string;
  title?: string;
  numeric?: boolean;
  sort?: (p: LivePlayer) => number | string;
  cell: (p: LivePlayer, i: number) => React.ReactNode;
  /** A control in the header instead of a label — the select-all box and the bulk ⋯ menu. */
  head?: React.ReactNode;
}

/**
 * Bulk actions for the current selection, as the header's ⋯.
 *
 * These were a row of eight buttons that appeared above the table once you selected somebody, which
 * pushed the roster down the moment you started working and put the verbs a long way from the rows
 * they applied to. In the header they sit directly above the checkboxes that feed them, take one
 * line of chrome instead of a wrapping row of them, and read the same way as the per-player ⋯
 * immediately below — same glyph, same menu, one player or ninety.
 */
function BulkMenu({ count, canActions, canGroups, canVip, onPick, onGroups }: {
  count: number;
  canActions: boolean;
  canGroups: boolean;
  canVip: boolean;
  onPick: (kind: BulkKind) => void;
  onGroups: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Same clipping problem as the row menus: the header lives inside the scrolling roster.
  const { ref: menuRef, menuRef: dropRef, style: menuStyle } = useAnchoredMenu(open, () => setOpen(false));
  const none = count === 0;
  const item = (kind: BulkKind, label: string, cls = "") =>
    <button className={`pa-mi ${cls}`} onClick={() => { setOpen(false); onPick(kind); }}>{label}</button>;
  return (
    <span className="pa-menu" onClick={(e) => e.stopPropagation()}>
      <button
        ref={menuRef}
        type="button"
        className="ico-btn"
        // Disabled with a reason, rather than a menu of things that would all do nothing.
        disabled={none}
        title={none ? "Tick some players first — these act on the selection" : `Actions for the ${count} selected player${count === 1 ? "" : "s"}`}
        aria-label={none ? "Bulk actions (nothing selected)" : `Bulk actions for ${count} selected`}
        onClick={() => setOpen((v) => !v)}
      >
        {DOTS}
      </button>
      {open && !none && (
        <div ref={dropRef} className="pa-dropdown" style={menuStyle} onMouseLeave={() => setOpen(false)}>
          <div className="pa-mi-head">{count} selected</div>
          {canActions && <>
            {item("message", "💬 Send message")}
            {item("punish", "⚠️ Punish")}
            {item("kick", "🥾 Kick")}
            {item("tempban", "⏱ Temp ban")}
            {item("permaban", "⛔ Perma ban", "err")}
            {item("switch", "🔄 Switch team")}
            {item("switch_death", "🔄 Switch on death")}
          </>}
          {canVip && item("vip", "⭐ Grant VIP")}
          {canGroups && <button className="pa-mi" onClick={() => { setOpen(false); onGroups(); }}>👥 Add to group…</button>}
        </div>
      )}
    </span>
  );
}

/** Live scoreboard aggregated from the confirmed players read (rich on binary-v2; on legacy the
 *  stat fields are absent, so it gracefully shows names/counts only). Every column is sortable and
 *  the roster can be filtered to a single team. */
/** Bulk actions the Live multi-select can fire — mirror of the single-player set, minus unbans
 *  (a live selection is by definition not banned). `fields: []` = confirm instead of a form. */
type BulkKind = "message" | "punish" | "kick" | "tempban" | "permaban" | "switch" | "switch_death" | "vip";
const BULK_META: Record<BulkKind, { title: string; fields: ("reason" | "hours" | "message")[]; danger?: boolean; confirm?: string }> = {
  message: { title: "Message selected", fields: ["message"] },
  punish: { title: "Punish selected", fields: ["reason"], danger: true },
  kick: { title: "Kick selected", fields: ["reason"], danger: true },
  tempban: { title: "Temp ban selected", fields: ["reason", "hours"], danger: true },
  permaban: { title: "Perma ban selected", fields: ["reason"], danger: true },
  switch: { title: "Switch selected now", fields: [], confirm: "Everyone selected is moved to the other team straight away, mid-match. Tip: filter to one team first and this becomes 'move them all to the other side'." },
  switch_death: { title: "Switch selected on death", fields: [], confirm: "Everyone selected moves to the other team on their next death." },
  // VIP has its own form (length, stacking, an optional message) — see the modal.
  vip: { title: "Grant VIP to selected", fields: ["message"] },
};
/** The message offered with a bulk VIP grant — each player's own new expiry, filled per player. */
const BULK_VIP_MESSAGE = "You've been given VIP on {server_name}! Yours now runs until {vip_until} ({vip_remaining} left).";

/** Per-user scoreboard preferences (sort, team filter, layout), restored across visits —
 *  staff on cam duty shouldn't re-apply the same three clicks every time. */
const SCOREBOARD_PREFS_KEY = "panel.scoreboard";
/**
 * How the roster is laid out. One ranked table, the same table with squad headers, or the two
 * teams side by side — three answers to three different questions, so it is a choice rather than
 * a toggle. `grouped` is the pre-existing boolean, still read so nobody's saved preference is
 * silently reset by the upgrade.
 */
/** One ranked table, or the two teams side by side. There used to be a third option — the same
 *  table with squad headers — but locking a side in the split shows exactly that grouping, so two
 *  layouts answer everything three did. A saved "squads" preference opens as the split. */
export type ScoreboardLayout = "table" | "split";
/** One column in the sort chain. The ARRAY's order is the priority: first key decides, later keys
 *  break its ties. Staff build it by clicking headers in the order they want them to nest. */
export interface SortKey { key: string; dir: 1 | -1 }
interface ScoreboardPrefs { sort?: SortKey | SortKey[]; teamFilter?: number | "all"; grouped?: boolean; layout?: ScoreboardLayout | "squads" }
/** Saved preferences predate multi-column sorting and hold a single {key,dir}; read either shape
 *  so nobody's stored sort is silently dropped by the upgrade. */
function toSortChain(saved: ScoreboardPrefs["sort"]): SortKey[] {
  if (!saved) return [{ key: "kills", dir: -1 }];
  return Array.isArray(saved) ? saved.filter((s) => s && typeof s.key === "string") : [saved];
}
function loadScoreboardPrefs(): ScoreboardPrefs {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(SCOREBOARD_PREFS_KEY) ?? "{}") as ScoreboardPrefs; } catch { return {}; }
}

export function Scoreboard({ players, session, onAct, serverId, canFlags, canActions, canGroups, canVip, canVipPause, onChanged, remember }: {
  players: LivePlayer[]; session: Record<string, unknown> | null; onAct?: (p: LivePlayer) => void;
  serverId?: string; canFlags?: boolean; canActions?: boolean; canGroups?: boolean; canVip?: boolean; canVipPause?: boolean; onChanged?: () => void;
  /**
   * A name to keep the board's search and locked side under for the sitting — the Live view's
   * board. None keeps nothing: a server card's roster on the Servers page is one board among
   * several, and must neither open on the Live view's search nor hand its own to the next card.
   */
  remember?: string;
}) {
  const game = useGame();
  const toast = useToast();
  const confirm = useConfirm();
  const [sort, setSort] = useState<SortKey[]>(() => toSortChain(loadScoreboardPrefs().sort));
  const [teamFilter, setTeamFilter] = useState<number | "all">(() => loadScoreboardPrefs().teamFilter ?? "all");
  const [squadFilter, setSquadFilter] = useState<string>("all");
  const [roleFilter, setRoleFilter] = useState<number | "all">("all");
  /*
   * Free text over the roster — the most-used control on the tool this replaced.
   *
   * "Is this player on right now" is a question staff answer constantly, usually with a name
   * someone just typed into Discord, and until now the only way to answer it was to read a
   * hundred-row table. On the Live view's board it is kept for the sitting only (`remember`) — a
   * profile opened from the board comes back to the same search — and never into the next one: a
   * search is where you are looking this minute, not how you like the page, and a remembered one
   * is the trap the team filter fell into.
   */
  const [q, setQ] = useRemembered(remember ? `${remember}.search` : null, "", isText, "session");
  const [layout, setLayout] = useState<ScoreboardLayout>(() => {
    const p = loadScoreboardPrefs();
    const stored = p.layout ?? (p.grouped ? "squads" : "table");
    return stored === "squads" ? "split" : stored;
  });
  /*
   * Which side the split is locked to, or null for the two-pane comparison.
   *
   * Kept for the sitting only where the board is given a name (`remember`), unlike sort/layout/
   * teamFilter: a lock is where you are looking right now, not how you like the page — and one
   * remembered past the sitting is exactly the trap the team filter fell into. A side that has
   * gone since is no lock (see lockOn).
   */
  const [lockedSide, setLockedSide] = useRemembered<string | null>(remember ? `${remember}.lockedSide` : null, null, isTextOrNull, "session");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    try { localStorage.setItem(SCOREBOARD_PREFS_KEY, JSON.stringify({ sort, teamFilter, layout } satisfies ScoreboardPrefs)); } catch { /* ignore */ }
  }, [sort, teamFilter, layout]);
  // Multi-select: game player id → display name. Selection survives the 15s auto-refresh
  // (players who left simply come back as "skipped" if acted on).
  const [selected, setSelected] = useState<Map<string, string | null>>(new Map());
  // One clock read per payload, not one per rendered cell: every TIME cell measures against the
  // same instant, and the value only moves when the roster refreshes (15s) instead of on rerender.
  // `players` is the trigger, not an input — the whole point is re-stamping the clock when a new
  // roster arrives, which is exactly the dependency shape exhaustive-deps cannot express.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rosterAt = useMemo(() => Date.now(), [players]);
  const sessionSec = (p: LivePlayer): number =>
    p.sessionStartedAt ? Math.max(0, Math.floor((rosterAt - Date.parse(p.sessionStartedAt)) / 1000)) : -1;
  const [bulk, setBulk] = useState<BulkKind | "group" | null>(null);
  const [bulkF, setBulkF] = useState({ reason: "", hours: "24", message: "", vipDays: "1", vipHours: "0", vipStack: true, vipComment: "" });
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkErr, setBulkErr] = useState("");
  // The last bulk action's outcome, kept visible (dismissible) across the auto-refresh so staff
  // can verify what happened even after the roster redraws.
  const [lastResult, setLastResult] = useState<{ title: string; applied: number; skipped: { playerId: string; playerName: string | null; reason: string }[]; at: string } | null>(null);
  const [groupsList, setGroupsList] = useState<{ id: string; name: string; memberCount: number }[] | null>(null);
  const [groupPick, setGroupPick] = useState("");

  const pid = (p: LivePlayer) => (p.iD || p.id || "").trim();
  const selectable = Boolean(canActions || canGroups || canVip);

  // Faction lookup for a raw team number: prefer the server-resolved `side` carried on the rows
  // (corrected against session headcounts), fall back to the static descriptor mapping.
  // A null resolved side is "on neither team" (joining, team select) and is kept as such.
  const sideIdByTeam = new Map<number, string | null>();
  for (const p of players) {
    if (typeof p.team !== "number" || sideIdByTeam.has(p.team)) continue;
    const sid = p.side !== undefined ? p.side : game.sideOf(p.team)?.id;
    if (sid !== undefined) sideIdByTeam.set(p.team, sid);
  }
  const sideOfTeam = (t?: number) => {
    if (t == null) return null;
    if (!sideIdByTeam.has(t)) return game.sideOf(t);
    return game.sides.find((s) => s.id === sideIdByTeam.get(t)) ?? null;
  };
  // Prefer the server-resolved side on the row over anything derived from the raw team number.
  const sideIdOf = (p: LivePlayer) => (p.side !== undefined ? p.side : sideOfTeam(p.team)?.id ?? null);
  const teamLabelOf = (t?: number) => sideOfTeam(t)?.label ?? (t == null ? "" : sideIdByTeam.get(t) === null ? "No team" : `Team ${t}`);
  const teamClassOf = (t?: number) => `side-${sideOfTeam(t)?.color ?? "neutral"}`;

  if (!players.length) return (
    <div className="live-state">
      <EmptyState icon="🎮" title="Nobody is playing right now">
        The server answered, it just has an empty roster. This fills the moment someone joins —
        the page refreshes itself, so you can leave it open.
      </EmptyState>
    </div>
  );

  const hasStats = players.some((p) => p.stats || p.scoreData);
  const hasScore = players.some((p) => p.scoreData);
  const teamCounts = new Map<number, number>();
  for (const p of players) if (typeof p.team === "number") teamCounts.set(p.team, (teamCounts.get(p.team) ?? 0) + 1);
  const teamsPresent = [...teamCounts.keys()].sort((a, b) => a - b);
  // Elapsed match minutes drive KPM (kills per minute this match). matchTime is seconds since the
  // match started; absent on legacy, so KPM just reads 0 there.
  const matchMin = session ? Number((session as Record<string, number>).matchTime ?? 0) / 60 : 0;
  const kpm = (p: LivePlayer) => (matchMin > 0 ? kills(p) / matchMin : 0);

  /*
   * The team filter cannot apply to the split view, and this is a correctness rule rather than a
   * preference.
   *
   * The filter is remembered across sessions (it is in ScoreboardPrefs), which is right for the
   * ranked table: "show me Axis" is a view you set and keep. In the split it is fatal — that layout
   * exists to put the two sides next to each other, so a remembered filter renders one populated
   * pane and one reading "Nobody on this side" about a team that is on the server. Staff who had
   * ever tapped a team chip got a permanently empty Allies column and no visible cause: the chips
   * are the only clue, and they were scrolled off the top of a phone.
   *
   * So the split ignores it, and the chips are hidden while it is on screen — a control that
   * governs nothing should not be sitting there looking like it does. Squad and role still apply:
   * those cut across both teams, so they narrow the comparison rather than destroying it.
   */
  const teamFilterApplies = layout !== "split";
  /*
   * Name, clan tag and squad, case-folded. Someone chasing a report has the name as it was typed at
   * them — wrong case, sometimes only the middle of it — so this is a contains match rather than a
   * prefix one. The clan tag is in because "who from ABC is on" is the other half of the question,
   * and the squad because "who is in BAKER" is how the same lookup gets phrased mid-round.
   */
  const needle = q.trim().toLowerCase();
  const matchesQuery = (p: LivePlayer) =>
    !needle
    || (p.name ?? "").toLowerCase().includes(needle)
    || (p.clanTag ?? "").toLowerCase().includes(needle)
    || (p.platoon ?? "").toLowerCase().includes(needle);
  const crossTeam = players
    .filter((p) => !teamFilterApplies || teamFilter === "all" || p.team === teamFilter)
    .filter((p) => squadFilter === "all" || (p.platoon || "No squad") === squadFilter)
    .filter((p) => roleFilter === "all" || p.role === roleFilter)
    .filter(matchesQuery);

  /*
   * A lock is honoured only while the side it names still has somebody on it.
   *
   * The roster refreshes every 15 seconds and the squad/role filters can empty a side outright. A
   * stale lock would render an empty screen whose only way back is a header that is no longer
   * there; falling back to the comparison view is the recoverable failure.
   */
  const lockOn = layout === "split" && lockedSide && crossTeam.some((p) => sideIdOf(p) === lockedSide)
    ? lockedSide : null;
  const filtered = lockOn ? crossTeam.filter((p) => sideIdOf(p) === lockOn) : crossTeam;
  /*
   * A locked side is the squad view for one team — literally, not by resemblance: the same columns,
   * the same sortable headers, the same tick boxes and bulk menu, grouped under the same squad
   * rows. Two columns go: Team and the squad's own, which would say on every row what the bar above
   * and the squad's heading already say — and on a phone they pushed the names off the screen. The two-pane comparison had to invent its own compressed row to fit beside another pane,
   * and once a pane has the screen to itself there is no reason to keep inventing. The first
   * attempt did keep inventing — it bolted extra fields onto that compressed row until the flex
   * line overflowed and squeezed the player's NAME to nothing, which is the one column that cannot
   * go.
   */
  const grouped = lockOn != null;
  const visibleIds = filtered.map(pid).filter(Boolean);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  // Column set — trimmed to what the protocol actually returned (stats/score only on binary-v2).
  const columns: Col[] = [
    /*
     * Actions lead, before the checkbox and right after the row number.
     *
     * They used to be the last column of a table that is wider than any phone, so acting on a
     * player meant scrolling right until their name was off screen — which is the one thing you
     * need to still see when you are about to kick somebody. First column, always in view, and the
     * header's ⋯ sits directly above them doing the same job for the whole selection.
     */
    ...((canFlags || canActions || canVip || canVipPause)
      ? [{
          key: "act", label: "",
          head: <BulkMenu count={selected.size} canActions={Boolean(canActions)} canGroups={Boolean(canGroups)} canVip={Boolean(canVip)} onPick={openBulk} onGroups={openGroupModal} />,
          cell: (p: LivePlayer) => (
            <PlayerActions
              player={{ playerId: p.iD || p.id || "", dbId: p.playerDbId, name: p.name, watch: p.watch, watchReason: p.watchReason, watchBy: p.watchBy, vip: p.vip }}
              serverId={serverId} canActions={canActions} canVip={canVip} canVipPause={canVipPause} onChanged={onChanged}
            />
          ),
        }]
      : onAct ? [{ key: "act", label: "", cell: (p: LivePlayer) => <button className="mini" onClick={() => onAct(p)}>Act</button> }] : []),
    ...(selectable ? [{
      key: "sel", label: "", title: "Select for bulk actions",
      // Tick-all for exactly what the filters have left on screen — the same rule the row of
      // filters above already follows, so "all" never means more than you can see.
      head: (
        <input
          type="checkbox"
          checked={allVisibleSelected}
          ref={(el) => { if (el) el.indeterminate = !allVisibleSelected && visibleIds.some((id) => selected.has(id)); }}
          onChange={() => selectMany(filtered, !allVisibleSelected)}
          onClick={(e) => e.stopPropagation()}
          title={`${allVisibleSelected ? "Unselect" : "Select"} the ${visibleIds.length} shown — the team / ${game.squadLabel.toLowerCase()} / role filters decide what that is`}
          aria-label={`${allVisibleSelected ? "Unselect" : "Select"} all ${visibleIds.length} shown`}
        />
      ),
      sort: (p: LivePlayer) => (selected.has(pid(p)) ? 0 : 1),
      cell: (p: LivePlayer) => {
        const id = pid(p);
        if (!id) return "";
        return <input type="checkbox" checked={selected.has(id)} onChange={() => toggleSel(p)} onClick={(e) => e.stopPropagation()} aria-label={`Select ${p.name || id}`} />;
      },
    }] : []),
    {
      key: "marks", label: "", title: "VIP / admin cam / watched / community badges",
      // Sort weight: watched first (it is the one staff scan for), then admin cam, then VIP, then
      // any community badge — so "sort by marks" clusters the marked players instead of shuffling.
      sort: (p) => (p.watch ? 8 : 0) + (p.consoleAdmin ? 4 : 0) + (p.vip ? 2 : 0) + (p.badges?.length ? 1 : 0),
      cell: (p) => (
        <span className="row-marks">
          {p.vip && <span className="mark vip" title="VIP" aria-label="VIP">★</span>}
          {p.consoleAdmin && <span className="mark admin" title="Console admin — holds the admin camera on this server" aria-label="Console admin">🎥</span>}
          {p.watch && <span className="mark watch" title={`Watched${p.watchReason ? ` — ${p.watchReason}` : ""}${p.watchBy ? ` (by ${p.watchBy})` : ""}`} aria-label="Watched">👁</span>}
          {/* Community role badges — derived from the Discord roles their linked account holds
              (Discord → Community badges), the way the star is derived from a live VIP grant.
              Capped: a roster row is a fixed-width slot next to a name, and somebody wearing every
              badge a community defines took over half a phone screen with them. The rest are
              counted, and the tooltip still names them all. */}
          {(p.badges ?? []).slice(0, ROW_BADGES).map((b, i) => <span key={i} className="mark badge" title={b.label} aria-label={b.label}>{b.emoji}</span>)}
          {(p.badges?.length ?? 0) > ROW_BADGES && (
            <span className="mark badge-more" title={p.badges!.slice(ROW_BADGES).map((b) => b.label).join(", ")}>
              +{p.badges!.length - ROW_BADGES}
            </span>
          )}
        </span>
      ),
    },
    ...(grouped ? [] : [{ key: "team", label: "Team", sort: (p: LivePlayer) => p.team ?? 99, cell: (p: LivePlayer) => (typeof p.team === "number" ? <span className={`team-tag ${teamClassOf(p.team)}`}>{teamLabelOf(p.team)}</span> : "") }]),
    { key: "name", label: "Player", sort: (p) => (p.name || "").toLowerCase(), cell: (p) => <PlayerLink playerId={p.playerDbId || p.iD || p.id} name={p.name || ""} /> },
    { key: "clan", label: "Clan", sort: (p) => (p.clanTag || "~").toLowerCase(), cell: (p) => (p.clanTag ? <span className="clan-tag">{p.clanTag}</span> : "") },
    { key: "level", label: "Lvl", numeric: true, sort: (p) => p.level ?? 0, cell: (p) => (p.level != null ? <span className={levelClass(p.level)}>{p.level}</span> : "") },
    // TIME/VISITS (CRCON parity): how long this session has run and how often they have been
    // here before. Both come from OUR records — a dash means we have none (fresh install, or a
    // connect that predates ingest) rather than zero.
    { key: "time", label: "Time", title: "This session, from the connect log", numeric: true, sort: (p) => sessionSec(p), cell: (p) => (sessionSec(p) >= 0 ? fmtSession(sessionSec(p)) : "–") },
    { key: "visits", label: "Visits", title: "Recorded visits to this server", numeric: true, sort: (p) => p.visits ?? -1, cell: (p) => (p.visits != null ? p.visits.toLocaleString() : "–") },
    { key: "role", label: "Role", sort: (p) => p.role ?? 99, cell: (p) => {
      const name = game.roleName(p.role);
      const icon = roleIconUrl(name, game.descriptor?.id);
      return icon ? <span className="role-cell" title={name}><img className="role-icon" src={icon} alt={name} /> <span className="role-name">{name}</span></span> : name;
    } },
    ...(grouped ? [] : [{ key: "squad", label: game.squadLabel, sort: (p: LivePlayer) => (p.platoon || "~").toLowerCase(), cell: (p: LivePlayer) => p.platoon || "" }]),
    { key: "loadout", label: "Loadout", sort: (p) => (p.loadout || "").toLowerCase(), cell: (p) => p.loadout || "" },
    ...(hasStats ? [
      { key: "kills", label: "K", title: "Kills", numeric: true, sort: (p: LivePlayer) => kills(p), cell: (p: LivePlayer) => kills(p) },
      { key: "deaths", label: "D", title: "Deaths", numeric: true, sort: (p: LivePlayer) => deaths(p), cell: (p: LivePlayer) => deaths(p) },
      { key: "kd", label: "K/D", numeric: true, sort: (p: LivePlayer) => kd(p), cell: (p: LivePlayer) => kd(p).toFixed(2) },
      ...(matchMin > 0 ? [{ key: "kpm", label: "KPM", title: "Kills per minute (this match)", numeric: true, sort: (p: LivePlayer) => kpm(p), cell: (p: LivePlayer) => kpm(p).toFixed(2) }] : []),
      // The number that caused the row highlight, called out so the eye lands on it rather than
      // hunting across the row for the reason the row is yellow.
      { key: "tk", label: "TK", title: `Team kills (${TK_FLAG_AT}+ is flagged)`, numeric: true, sort: (p: LivePlayer) => teamKills(p),
        cell: (p: LivePlayer) => (teamKills(p) ? <span className={isTkFlagged(p) ? "tk-hot" : ""}>{teamKills(p)}</span> : "") },
    ] : []),
    ...(hasScore
      ? game.scoreFields.map((sf) => ({
          key: `score:${sf.key}`, label: sf.label, title: sf.title, numeric: true,
          sort: (p: LivePlayer) => p.scoreData?.[sf.key] ?? 0,
          cell: (p: LivePlayer) => p.scoreData?.[sf.key] ?? 0,
        }))
      : []),
    { key: "platform", label: "Platform", sort: (p) => (p.platform || "").toLowerCase(),
      cell: (p) => p.untracked
        ? <span title="No usable player id in the roster data — invisible to stats, sessions and VIP">⚠ {platformLabel(p.platform) || "untracked"}</span>
        : platformLabel(p.platform) },
  ];

  /*
   * Sort by several columns at once, in the order they were clicked.
   *
   * Staff asked for "team and clan at the same time" — two teams divided, clans gathered at the top
   * of each, ranks within that. One sort key cannot express that; a CHAIN can, and the click order
   * is the nesting order, which is the mental model people already have from spreadsheets.
   *
   * Ties are broken by the next key, so the last key decides only among rows every earlier key
   * agreed on. An empty chain falls back to the default rather than leaving the roster in whatever
   * order the game handed it over in.
   */
  /*
   * The chain, filtered to columns this roster actually HAS.
   *
   * Which columns exist depends on the server and the round — the stats block only appears once
   * the game reports score data, KPM only once a match clock is running — so a stored key can name
   * a column that is not on screen. Those are filtered out for display and comparison but LEFT in
   * the stored chain: a key dropped because its column is briefly missing would be silently
   * forgotten, and the preference would decay every time someone opened Live between rounds.
   * (Without this the default "kills" key survived on a server reporting no stats at all, sitting
   * invisibly at position 1 and pushing every real column down a place.)
   */
  const chain = sort.filter((s) => columns.some((c) => c.key === s.key && c.sort));
  const effective = chain.length ? chain : [{ key: columns.find((c) => c.sort)?.key ?? "name", dir: -1 as const }];
  const roster = filtered.slice().sort((a, b) => {
    for (const s of effective) {
      const get = columns.find((c) => c.key === s.key)?.sort;
      if (!get) continue;
      const av = get(a), bv = get(b);
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      if (cmp !== 0) return cmp * s.dir;
    }
    return 0;
  });
  /** Where a column sits in the VISIBLE chain, 1-based; 0 when it is not sorted on. */
  const sortRank = (key: string) => chain.findIndex((s) => s.key === key) + 1;

  /*
   * A click cycles one column through three states: sort by it, reverse it, drop it.
   *
   * Three states rather than two because a chain needs a way to REMOVE a key, and an extra control
   * per header for that would cost more room than the caret it sits beside. A column joins at the
   * end of the chain, so clicking Team then Clan nests clans inside teams — which is the order it
   * was asked for, and the order the numbered carets then show back.
   */
  function clickHeader(c: Col) {
    if (!c.sort) return;
    setSort((prev) => {
      const at = prev.findIndex((s) => s.key === c.key);
      if (at === -1) return [...prev, { key: c.key, dir: c.numeric ? -1 : 1 }];
      const cur = prev[at]!;
      const flipped = (cur.dir * -1) as 1 | -1;
      // Back to the direction it started in means the cycle is complete — drop it.
      const started = c.numeric ? -1 : 1;
      if (flipped === started) return prev.filter((s) => s.key !== c.key);
      return prev.map((s) => (s.key === c.key ? { key: s.key, dir: flipped } : s));
    });
  }

  // --- multi-select + bulk actions ---
  function toggleSel(p: LivePlayer) {
    const id = pid(p);
    if (!id) return;
    setSelected((prev) => {
      const n = new Map(prev);
      if (n.has(id)) n.delete(id); else n.set(id, p.name ?? null);
      return n;
    });
  }
  function selectMany(list: LivePlayer[], on: boolean) {
    setSelected((prev) => {
      const n = new Map(prev);
      for (const p of list) { const id = pid(p); if (!id) continue; if (on) n.set(id, p.name ?? null); else n.delete(id); }
      return n;
    });
  }

  function openBulk(kind: BulkKind) {
    const meta = BULK_META[kind]!;
    setBulkErr("");
    if (!meta.fields.length) {
      void confirm({ title: `${meta.title} — ${selected.size} player${selected.size === 1 ? "" : "s"}?`, body: meta.confirm, confirmLabel: meta.title, danger: meta.danger })
        .then((ok) => { if (ok) void runBulk(kind); });
      return;
    }
    setBulkF({ reason: "", hours: "24", message: kind === "vip" ? BULK_VIP_MESSAGE : "", vipDays: "1", vipHours: "0", vipStack: true, vipComment: "" });
    setBulk(kind);
  }

  async function runBulk(kind: BulkKind) {
    if (!serverId) return;
    setBulkBusy(true); setBulkErr("");
    if (kind === "vip") {
      try {
        const r = await api<{ applied: { playerId: string; playerName: string | null; messaged: boolean | null }[]; skipped: { playerId: string; playerName: string | null; reason: string }[]; messageFailed: number }>(`/servers/${serverId}/vips/bulk`, {
          method: "POST",
          body: {
            players: [...selected.entries()].map(([playerId, playerName]) => ({ playerId, playerName })),
            mode: "duration", days: Number(bulkF.vipDays) || 0, hours: Number(bulkF.vipHours) || 0, cumulative: bulkF.vipStack,
            comment: bulkF.vipComment.trim(),
            message: bulkF.message.trim() || undefined,
          },
          // A full server's grants and messages can outrun the default wait; the button stays
          // busy until the server answers, and a cut-off answer says not to press it again.
          timeoutMs: 0,
        });
        // A message that did not arrive is listed with the skips — the VIP landed, the player
        // just was not told, and staff can see exactly who to message again.
        const unmessaged = r.applied.filter((a) => a.messaged === false)
          .map((a) => ({ playerId: a.playerId, playerName: a.playerName, reason: "VIP granted, but the message did not reach them" }));
        toast.success(`VIP: ${r.applied.length} granted${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}${r.messageFailed ? `, ${r.messageFailed} not messaged` : ""}`);
        setLastResult({ title: BULK_META.vip.title, applied: r.applied.length, skipped: [...r.skipped, ...unmessaged], at: fmtClock() });
        setBulk(null);
        onChanged?.();
      } catch (e) { setBulkErr(mayStillBeRunning(e) ? `${(e as Error).message} ${STILL_RUNNING_NOTE}` : (e as Error).message); }
      finally { setBulkBusy(false); }
      return;
    }
    try {
      const r = await api<{ applied: unknown[]; skipped: { playerId: string; playerName: string | null; reason: string }[] }>(`/servers/${serverId}/actions/bulk`, {
        method: "POST",
        body: {
          action: kind,
          players: [...selected.entries()].map(([playerId, playerName]) => ({ playerId, playerName })),
          reason: bulkF.reason.trim(), message: bulkF.message.trim(),
          // Only when this action's form offers the field — the shared "24" default otherwise
          // rides along on a bulk message/kick and gets recorded as a duration it never had.
          ...(BULK_META[kind]!.fields.includes("hours") ? { hours: Number(bulkF.hours) || 0 } : {}),
        },
      });
      toast.success(`${BULK_META[kind]!.title}: ${r.applied.length} done${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}`);
      setLastResult({ title: BULK_META[kind]!.title, applied: r.applied.length, skipped: r.skipped, at: fmtClock() });
      setBulk(null);
      onChanged?.();
    } catch (e) { setBulkErr((e as Error).message); if (bulk === null) toast.error((e as Error).message); }
    finally { setBulkBusy(false); }
  }

  function openGroupModal() {
    setBulkErr(""); setGroupsList(null); setBulk("group");
    api<{ groups: { id: string; name: string; memberCount: number }[] }>("/player-groups")
      .then((r) => { setGroupsList(r.groups); setGroupPick((g) => g || r.groups[0]?.id || ""); })
      .catch((e) => setBulkErr((e as Error).message));
  }

  async function addSelectedToGroup() {
    const group = groupsList?.find((g) => g.id === groupPick);
    if (!group) return;
    setBulkBusy(true); setBulkErr("");
    try {
      for (const [playerId, playerName] of selected) {
        await api(`/player-groups/${group.id}/members`, { method: "POST", body: { playerId, playerName: playerName || undefined } });
      }
      toast.success(`Added ${selected.size} player${selected.size === 1 ? "" : "s"} to “${group.name}”`);
      setBulk(null);
    } catch (e) { setBulkErr((e as Error).message); }
    finally { setBulkBusy(false); }
  }

  const bulkMeta = bulk && bulk !== "group" ? BULK_META[bulk] : null;
  const bulkBlockedWhy = !bulkMeta ? ""
    : bulkMeta.fields.includes("reason") && !bulkF.reason.trim() ? "Type a reason — the players see it, and it goes in the log."
    : bulk === "message" && !bulkF.message.trim() ? "Type a message to send."
    : bulk === "tempban" && !(Number(bulkF.hours) > 0) ? "Give the ban a length in hours."
    : bulk === "vip" && !((Number(bulkF.vipDays) || 0) * 24 + (Number(bulkF.vipHours) || 0) > 0) ? "Give the VIP a length."
    : bulk === "vip" && !bulkF.vipComment.trim() ? "Type a comment — every VIP added needs one: who paid, what for, or which event."
    : "";

  const top = players.slice().sort((a, b) => kills(b) - kills(a)).filter((p) => kills(p) > 0).slice(0, 3);
  const mapName = session ? String((session as Record<string, string>).mapName ?? (session as Record<string, string>).map ?? (session as Record<string, string>).Name ?? "") : "";

  // Squad grouping: keep the active sort's order within each squad, but nest squads under their
  // side (descriptor display order; unknown sides last).
  const sideOrder = (id: string | undefined) => {
    const i = game.sides.findIndex((sd) => sd.id === id);
    return i === -1 ? game.sides.length : i;
  };
  const squadGroups = (() => {
    const map = new Map<string, { side?: string; team?: number; squad: string; players: LivePlayer[] }>();
    for (const p of roster) {
      const side = p.side !== undefined ? p.side ?? undefined : sideOfTeam(p.team)?.id;
      const squad = p.platoon || "No squad";
      const key = `${side ?? "other"}/${squad}`;
      const g = map.get(key) ?? { side, team: p.team, squad, players: [] };
      g.players.push(p);
      map.set(key, g);
    }
    return [...map.values()].sort((a, b) =>
      (sideOrder(a.side) - sideOrder(b.side)) || (a.squad === "No squad" ? 1 : b.squad === "No squad" ? -1 : a.squad.localeCompare(b.squad)));
  })();
  const toggleSquad = (key: string) => setCollapsed((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const colCount = columns.length + 1;

  return (
    <div className="live-state">
      <div className="scoreboard-summary">
        <span className="badge observe">{players.length} online</span>
        {mapName && <span className="muted">🗺 {mapName}</span>}
        {teamFilterApplies && teamsPresent.length > 0 && (
          <span className="team-filter">
            <button className={teamFilter === "all" ? "active" : ""} onClick={() => setTeamFilter("all")}>All {players.length}</button>
            {teamsPresent.map((t) => (
              <button key={t} className={`${teamClassOf(t)} ${teamFilter === t ? "active" : ""}`} onClick={() => setTeamFilter(t)}>{teamLabelOf(t)} {teamCounts.get(t)}</button>
            ))}
          </span>
        )}
        {top.length > 0 && <span className="muted">Top: {top.map((p) => `${p.name} (${kills(p)})`).join(" · ")}</span>}
        {/* Three layouts, not a checkbox: "compare the two teams" is a different question from
            "who is top of the board", and a boolean cannot hold three answers. */}
        <span className="seg" style={{ marginLeft: "auto" }}>
          {([["table", "Table", "One ranked list"], ["split", "Teams", `Both sides side by side — lock one to see its ${game.squadLabel.toLowerCase()}s grouped`]] as const).map(([id, label, hint]) => (
            <button key={id} type="button" className={`seg-btn ${layout === id ? "active" : ""}`} title={hint} onClick={() => setLayout(id)}>{label}</button>
          ))}
        </span>
      </div>
      {/*
        * Filters, for everyone.
        *
        * This row used to render only for staff who could act on a player, which quietly made
        * "narrow the roster down" a permission. It is a reading aid — finding a name in a hundred
        * rows is the same problem whether or not you are allowed to kick them — so only the
        * selection counter below is still gated.
        */}
      <div className="scoreboard-summary roster-filters" style={{ marginTop: 6 }}>
        <input
          className="roster-search" type="search" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, clan or squad…"
          aria-label="Search the roster by player name, clan tag or squad"
        />
        <select value={squadFilter} onChange={(e) => setSquadFilter(e.target.value)} title={`Filter by ${game.squadLabel.toLowerCase()}`}>
          <option value="all">{game.squadLabel}: all</option>
          {[...new Set(players.map((p) => p.platoon || "No squad"))].sort().map((s2) => <option key={s2} value={s2}>{s2}</option>)}
        </select>
        <select value={roleFilter === "all" ? "all" : String(roleFilter)} onChange={(e) => setRoleFilter(e.target.value === "all" ? "all" : Number(e.target.value))} title="Filter by role / loadout type">
          <option value="all">Role: all</option>
          {[...new Set(players.map((p) => p.role).filter((r): r is number => r != null))].sort((a, b) => a - b).map((r) => <option key={r} value={r}>{game.roleName(r)}</option>)}
        </select>
        {/* Say how much of the roster is left, and offer the way back. Without it a filter that
            matches nothing looks the same as a server that emptied. */}
        {filtered.length !== players.length && (
          <>
            <span className="muted fs-sm">{filtered.length} of {players.length}</span>
            <button className="mini ghost" onClick={() => { setQ(""); setSquadFilter("all"); setRoleFilter("all"); setTeamFilter("all"); }}>Clear filters</button>
          </>
        )}
        {/* The sort chain, spelled out, once there is more than one column in it.
            A numbered caret on each header tells you a column's position but not the shape of the
            whole order; "Team → Clan → K" does, in the words the columns already use. It is also
            the only way back to one column without clicking three headers twice each. */}
        {chain.length > 1 && (
          <>
            <span className="muted fs-sm" title="Each column breaks the ties of the one before it. Click a header to add it, again to reverse it, once more to drop it.">
              Sorted: {chain.map((s2) => columns.find((c) => c.key === s2.key)?.label).filter(Boolean).join(" → ")}
            </span>
            <button className="mini ghost" onClick={() => setSort(chain.slice(0, 1))}>Just {columns.find((c) => c.key === chain[0]!.key)?.label}</button>
          </>
        )}
        {/* Tick-all and the bulk actions both live in the table header now, directly above the
            column they act on. What stays here is the count and the way out of a selection —
            the one thing the header cannot show, and the thing you want when you mis-tapped. */}
        {selectable && selected.size > 0 && <>
          <strong style={{ marginLeft: "auto" }}>{selected.size} selected</strong>
          <button className="mini ghost" onClick={() => setSelected(new Map())}>Clear</button>
        </>}
      </div>
      {lastResult && (
        <div style={{ marginTop: 6 }}>
          <div className="scoreboard-summary">
            <span className="muted">Last action ({lastResult.at}):</span>
            <span className="badge active">{lastResult.title} — {lastResult.applied} applied</span>
            {lastResult.skipped.length > 0 && <span className="badge observe">{lastResult.skipped.length} skipped</span>}
            <button className="mini ghost" onClick={() => setLastResult(null)} aria-label="Dismiss last action result">✕</button>
          </div>
          {lastResult.skipped.length > 0 && (
            <div className="hint" style={{ marginTop: 2 }}>
              Skipped: {lastResult.skipped.map((s) => `${s.playerName || s.playerId} (${s.reason})`).join(" · ")}
            </div>
          )}
        </div>
      )}
      {/* The comparison view answers a different question and so has its own shape entirely: it is
          not a table with the rows rearranged, and forcing it through the column machinery above
          would give two panes each too narrow to hold them. It reads the same roster and honours
          the squad and role filters; the team filter is deliberately not applied (see above).
          Lock a side and it hands over to that machinery instead — see `grouped`. */}
      {layout === "split" && !lockOn ? (
        <TeamSplit
          players={roster} serverId={serverId} onLock={setLockedSide}
          canFlags={canFlags} canActions={canActions} canGroups={canGroups} canVip={canVip} canVipPause={canVipPause}
          onChanged={onChanged}
        />
      ) : (
      <>
      {lockOn && (() => {
        // The same bar the pane wore, minus the pane: it names the side, totals it, and is the
        // way back. The counts are of what is on screen, so a squad or role filter is reflected
        // rather than contradicted.
        const sd = game.sides.find((s) => s.id === lockOn);
        const k = filtered.reduce((a, p) => a + kills(p), 0);
        const tks = filtered.reduce((a, p) => a + teamKills(p), 0);
        return (
          <button
            type="button"
            className={`team-side-head locked-head side-${sd?.color ?? "neutral"}`}
            onClick={() => setLockedSide(null)}
            title="Back to both teams"
          >
            <span aria-hidden>←</span>
            <span>{sd?.label ?? "Team"}</span>
            <span className="muted">{filtered.length}</span>
            <span className="team-side-stats">
              {killCount(k)}{tks > 0 && <> · <span className="tk-hot">{tks} TK</span></>}
            </span>
          </button>
        );
      })()}
      <div className="scroll-x roster">
        <table className="scoreboard">
          <thead>
            <tr>
              <th>#</th>
              {columns.map((c) => (
                <th
                  key={c.key}
                  title={c.head ? undefined : c.title}
                  className={`${c.sort && !c.head ? "sortable" : ""} ${c.numeric ? "num" : ""} ${sortRank(c.key) ? "sorted" : ""}`}
                  onClick={c.head ? undefined : () => clickHeader(c)}
                  aria-sort={sortRank(c.key) ? (chain[sortRank(c.key) - 1]!.dir === -1 ? "descending" : "ascending") : undefined}
                >
                  {c.head ?? <>{c.label}{sortRank(c.key) > 0 && (
                    <span className="sort-caret" aria-hidden>
                      {" "}{chain[sortRank(c.key) - 1]!.dir === -1 ? "▾" : "▴"}
                      {/* The position is only worth showing once more than one column is in play —
                          a lone "1" beside the only sorted column is noise. */}
                      {chain.length > 1 && <sup>{sortRank(c.key)}</sup>}
                    </span>
                  )}</>}
                </th>
              ))}
            </tr>
          </thead>
          {grouped ? (
            <tbody>
              {squadGroups.map((g) => {
                const key = `${g.side ?? "other"}/${g.squad}`;
                const isCollapsed = collapsed.has(key);
                const sk = g.players.reduce((a, p) => a + kills(p), 0);
                const avgLvl = Math.round(g.players.reduce((a, p) => a + (p.level ?? 0), 0) / g.players.length);
                return (
                  <Fragment key={key}>
                    <tr className={`squad-head ${teamClassOf(g.team)}`} onClick={() => toggleSquad(key)}>
                      <td colSpan={colCount}>
                        <span className="squad-caret" aria-hidden>{isCollapsed ? "▸" : "▾"}</span>
                        <strong>{g.squad}</strong> <span className="muted">({g.players.length})</span>
                        {/* The one squad fact staff act on. The comparison panes have always said
                            it; the table said it only in the page header, as a list of squad names
                            you then had to go and find. */}
                        {missingLeader(g.squad, g.players, game.squadLeaderRoles, game.knowsRole) && (
                          <span className="nosl" title={noLeaderTip(g.players, game.squadLeaderRoles, game.roleName, game.squadLabel)}> no SL</span>
                        )}
                        <span className="muted squad-sub"> · {killCount(sk)}{avgLvl > 0 ? <> · ⌀ lvl <span className={levelClass(avgLvl)}>{avgLvl}</span></> : null}</span>
                        {selectable && <button className="mini ghost" style={{ marginLeft: 8 }} onClick={(e) => { e.stopPropagation(); selectMany(g.players, !g.players.every((pl) => selected.has(pid(pl)))); }}>
                          {g.players.every((pl) => selected.has(pid(pl))) ? "unselect" : "select"}
                        </button>}
                      </td>
                    </tr>
                    {!isCollapsed && g.players.map((p, i) => (
                      <tr key={(p.iD || p.id || i) as React.Key} className={isTkFlagged(p) ? "tk-flag" : ""}>
                        <td className="num">{i + 1}</td>
                        {columns.map((c) => <td key={c.key} className={c.numeric ? "num" : ""}>{c.cell(p, i)}</td>)}
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          ) : (
            <tbody>
              {roster.map((p, i) => (
                <tr key={(p.iD || p.id || i) as React.Key} className={isTkFlagged(p) ? "tk-flag" : ""}>
                  <td className="num">{i + 1}</td>
                  {columns.map((c) => <td key={c.key} className={c.numeric ? "num" : ""}>{c.cell(p, i)}</td>)}
                </tr>
              ))}
            </tbody>
          )}
        </table>
      </div>
      </>
      )}
      {roster.length === 0 && (
        <EmptyState icon="🔎" title={needle ? `Nobody on this server matches “${q.trim()}”` : "No players match these filters"} filtered
          onClear={() => { setQ(""); setTeamFilter("all"); setSquadFilter("all"); setRoleFilter("all"); }}>
          {/* When the search is what emptied it, say so as an answer rather than as a failure —
              "not on right now" is the thing staff came here to find out. */}
          {needle
            ? <>Searched the names, clan tags and {game.squadLabel.toLowerCase()}s of all {players.length} player{players.length === 1 ? "" : "s"} online.</>
            : <>{players.length} player{players.length === 1 ? " is" : "s are"} on the server, but the team,
              {" "}{game.squadLabel.toLowerCase()} or role filter above is hiding {players.length === 1 ? "them" : "them all"}.</>}
        </EmptyState>
      )}

      {bulk && bulkMeta && (
        <Modal title={<>{bulkMeta.title} <span className="muted">· {selected.size} player{selected.size === 1 ? "" : "s"}</span></>} onClose={() => setBulk(null)} busy={bulkBusy}>
          <div className="pa-fields">
            {bulk === "vip" && (
              <>
                <div className="control-row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <label className="inline">Days<input type="number" min="0" value={bulkF.vipDays} onChange={(e) => setBulkF((s2) => ({ ...s2, vipDays: e.target.value }))} style={{ width: 80, marginLeft: 6 }} /></label>
                  <label className="inline">Hours<input type="number" min="0" max="23" value={bulkF.vipHours} onChange={(e) => setBulkF((s2) => ({ ...s2, vipHours: e.target.value }))} style={{ width: 80, marginLeft: 6 }} /></label>
                </div>
                <Toggle checked={bulkF.vipStack} onChange={(v) => setBulkF((s2) => ({ ...s2, vipStack: v }))}
                  label={bulkF.vipStack ? "Add on top of any VIP they already have" : "At least this long from now (anyone with more keeps theirs)"} />
                <p className="hint">Nobody&apos;s time is ever cut: a player who already has more keeps it, and a permanent VIP is kept and listed as kept.</p>
                <label>Comment (required)
                  <input value={bulkF.vipComment} onChange={(e) => setBulkF((s2) => ({ ...s2, vipComment: e.target.value }))} placeholder="who paid, what for, or which event — not sent to the game" />
                  <span className="hint">The note on each new VIP. Players who already have VIP keep their own note; the comment goes in their VIP history.</span>
                </label>
              </>
            )}
            {bulkMeta.fields.includes("message") && (
              <label>{bulk === "vip" ? "Then message each of them (optional — blank sends nothing)" : "Message"}
                <textarea value={bulkF.message} onChange={(e) => setBulkF((s2) => ({ ...s2, message: e.target.value }))} rows={3} autoFocus={bulk !== "vip"} />
                <PlaceholderHint>{bulk === "vip" ? "— each player reads their own, after their VIP is added." : "— filled for each player."}</PlaceholderHint>
              </label>
            )}
            {bulkMeta.fields.includes("reason") && <label>Reason<input value={bulkF.reason} onChange={(e) => setBulkF((s2) => ({ ...s2, reason: e.target.value }))} autoFocus /></label>}
            {bulkMeta.fields.includes("hours") && <label>Hours<input type="number" min="1" value={bulkF.hours} onChange={(e) => setBulkF((s2) => ({ ...s2, hours: e.target.value }))} /></label>}
          </div>
          <ActionResult error={bulkErr} />
          {bulkBlockedWhy && <p className="hint">{bulkBlockedWhy}</p>}
          <div className="pa-actions">
            <button className="ghost" onClick={() => setBulk(null)} disabled={bulkBusy}>Cancel</button>
            <button className={bulkMeta.danger ? "danger" : ""} onClick={() => bulk !== "group" && runBulk(bulk)} disabled={bulkBusy || bulkBlockedWhy !== ""}>
              {bulkBusy ? "Working…" : `${bulkMeta.title} (${selected.size})`}
            </button>
          </div>
        </Modal>
      )}
      {bulk === "group" && (
        <Modal title={<>Add to group <span className="muted">· {selected.size} player{selected.size === 1 ? "" : "s"}</span></>} onClose={() => setBulk(null)} busy={bulkBusy}>
          <div className="pa-fields">
            {!groupsList && !bulkErr && <SkeletonLines lines={2} />}
            {groupsList && groupsList.length === 0 && <Nothing>No player groups yet — create one under Players → Groups.</Nothing>}
            {groupsList && groupsList.length > 0 && (
              <label>Group<select value={groupPick} onChange={(e) => setGroupPick(e.target.value)}>
                {groupsList.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.memberCount})</option>)}
              </select></label>
            )}
            <Explanation>Membership is saved by game player id — the group then works from Players → Groups on any server (bulk VIP, console admin, temp ban, team move).</Explanation>
          </div>
          <ActionResult error={bulkErr} />
          <div className="pa-actions">
            <button className="ghost" onClick={() => setBulk(null)} disabled={bulkBusy}>Cancel</button>
            <button onClick={addSelectedToGroup} disabled={bulkBusy || !groupPick}>{bulkBusy ? "Adding…" : `Add ${selected.size} to group`}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
