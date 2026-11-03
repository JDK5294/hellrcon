"use client";
/**
 * Relay & alerts panel — one tab of the Discord control center (DiscordHub). Chooses which event
 * categories (kills, chat, admin, connections, match) post to which Discord channel for the active
 * server, plus immediate ping alerts. The bot token stays in the environment; this only manages the
 * per-server routing. A per-category "Test" posts a one-off message so staff can confirm the wiring.
 * Headerless by design — the hub supplies the page header + tab bar. Gated by Server config.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, authHeaders, refusal, wasFiled } from "../lib/api";
import { useResource } from "../lib/resource";
import { useServers } from "../lib/servers";
import { useGrants } from "../lib/grants";
import { holdsOutright } from "../lib/access";
import { ActionResult, AskNotice, Callout, Divider, SettingCard, SkeletonLines, Toggle, Explanation } from "./ui";
import { PanelGroup, Panel } from "./Panel";
import { AnnouncementNudgePanel } from "./AnnouncementNudge";

interface AlertRule { enabled: boolean; channelId: string | null; mentionRoleId: string | null }
interface AdminPingRule extends AlertRule { trigger: string }
interface Alerts { adminPing: AdminPingRule; watchlist: AlertRule; automation: AlertRule; serverDark?: AlertRule }
interface CategoryOptions { mentionRoleId?: string | null; teamkillsOnly?: boolean; includeVoteBallots?: boolean }
interface StatusBoard { enabled: boolean; channelId: string | null; messageId: string | null; intervalSec: number; title: string | null }
interface Config {
  serverId: string; enabled: boolean; categories: string[]; channels: Record<string, string | null>;
  categoryOptions: Record<string, CategoryOptions>; alerts: Alerts; statusBoard?: StatusBoard; updatedAt: string;
}
interface Resp { config: Config; categories: string[]; botConfigured: boolean }

const HELP: Record<string, string> = {
  kills: "Kills and team kills.",
  chat: "In-game chat (team & unit). Higher volume — pick a dedicated channel.",
  admin: "Kicks, bans, admin messages.",
  connections: "Player connects, disconnects, and team switches.",
  match: "Match start and end.",
};

export function RelayAlertsPanel({ canManage, canCommunity = false }: {
  /** discord.config — the per-server relay and its alert pings. */
  canManage: boolean;
  /** community.edit — the instance-wide unread-notice nudge that sits beside them. */
  canCommunity?: boolean;
}) {
  const { serverId, server } = useServers();
  const [cfg, setCfg] = useState<Config | null>(null);
  const [cats, setCats] = useState<string[]>([]);
  const [botConfigured, setBotConfigured] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [testing, setTesting] = useState("");

  // An edit form keeps its own mutable copy, so the fetch and the form are two steps: useResource
  // decides WHICH response is allowed to land (a stale one here would be edited and then saved
  // back to the wrong server), and this effect copies the winner into the form.
  const loader = useMemo(() => (serverId ? () => api<Resp>(`/servers/${serverId}/discord`) : null), [serverId]);
  const { data: resp, error: loadErr, reload: load } = useResource(loader);
  useEffect(() => {
    // Another server picked: its settings are on their way, and the last server's go now rather than
    // when these land. Kept on screen meanwhile, they could be edited and saved to this server.
    if (!resp) { setCfg(null); setDirty(false); return; }
    // Defensive reads: a response missing a field should degrade to an empty list, not throw out of
    // render and take the whole panel — and with it the tab — down to "Application error".
    setCfg(resp.config ?? null); setCats(Array.isArray(resp.categories) ? resp.categories : []);
    setBotConfigured(resp.botConfigured !== false);
    setOk(""); setDirty(false);
  }, [resp]);

  const set = <K extends keyof Config>(k: K, v: Config[K]) => { setCfg((c) => (c ? { ...c, [k]: v } : c)); setDirty(true); setOk(""); };
  const toggleCat = (cat: string, on: boolean) => set("categories", on ? [...(cfg?.categories ?? []), cat] : (cfg?.categories ?? []).filter((c) => c !== cat));
  const setChannel = (cat: string, id: string) => set("channels", { ...(cfg?.channels ?? {}), [cat]: id });
  const setCatOpt = (cat: string, patch: CategoryOptions) =>
    set("categoryOptions", { ...(cfg?.categoryOptions ?? {}), [cat]: { ...(cfg?.categoryOptions?.[cat] ?? {}), ...patch } });

  async function save() {
    if (!cfg) return;
    setBusy(true); setErr(""); setOk("");
    try {
      const r = await api<{ config: Config }>(`/servers/${serverId}/discord`, { method: "PUT", body: { enabled: cfg.enabled, categories: cfg.categories, channels: cfg.channels, categoryOptions: cfg.categoryOptions, alerts: cfg.alerts } });
      setCfg(r.config); setDirty(false); setOk("Saved.");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const setAdminPing = (patch: Partial<AdminPingRule>) => { setCfg((c) => (c ? { ...c, alerts: { ...c.alerts, adminPing: { ...c.alerts.adminPing, ...patch } } } : c)); setDirty(true); setOk(""); };
  const setWatch = (patch: Partial<AlertRule>) => { setCfg((c) => (c ? { ...c, alerts: { ...c.alerts, watchlist: { ...c.alerts.watchlist, ...patch } } } : c)); setDirty(true); setOk(""); };
  const setAutomation = (patch: Partial<AlertRule>) => { setCfg((c) => (c ? { ...c, alerts: { ...c.alerts, automation: { ...c.alerts.automation, ...patch } } } : c)); setDirty(true); setOk(""); };
  const setServerDark = (patch: Partial<AlertRule>) => { setCfg((c) => (c ? { ...c, alerts: { ...c.alerts, serverDark: { enabled: false, channelId: null, mentionRoleId: null, ...c.alerts.serverDark, ...patch } } } : c)); setDirty(true); setOk(""); };

  async function test(cat: string) {
    setTesting(cat); setErr(""); setOk("");
    try { await api(`/servers/${serverId}/discord/test`, { method: "POST", body: { category: cat } }); setOk(`Test message sent to the ${cat} channel.`); }
    catch (e) { setErr((e as Error).message); } finally { setTesting(""); }
  }

  if (!serverId) return <div className="card"><p className="muted">Select a server to configure the Discord relay.</p></div>;

  return (
    <PanelGroup viewId="discord-relay">
      <Panel
        id="relay"
        caps="discord.relay"
        title="Relay &amp; alerts"
        subtitle={server?.name}
        actions={<>
          {dirty && <button className="ghost" onClick={load}>Discard</button>}
          <button className="primary" onClick={save} disabled={!dirty || busy || !canManage}>{busy ? "Saving…" : "Save"}</button>
        </>}
      >
      <p className="muted mt-0">Post this server&apos;s game events to Discord channels.</p>

      {!botConfigured && <Callout variant="warn">No Discord bot token is set (Discord → Setup &amp; status), so nothing will actually post until an admin sets one. You can still prepare the routing here.</Callout>}
      {canManage && <AskNotice capability="discord.relay" serverId={serverId} />}
      <ActionResult ok={ok} error={err || loadErr} />
      {!cfg && !err && !loadErr && <SkeletonLines lines={3} />}

      {cfg && (
        <>
          <SettingCard title="Enable relay" description="Master switch for posting this server's events to Discord.">
            <Toggle checked={cfg.enabled} onChange={(v) => set("enabled", v)} label={cfg.enabled ? "On" : "Off"} disabled={!canManage} />
          </SettingCard>

          <Explanation>For each category, turn it on and paste the Discord channel id it should post to (right-click a channel → Copy Channel ID). A category posts only when it&apos;s on <em>and</em> has a channel.</Explanation>

          <div style={{ display: "grid", gap: 10, marginTop: 8 }}>
            {cats.map((cat) => {
              const on = (cfg.categories ?? []).includes(cat);
              const channel = cfg.channels?.[cat] ?? "";
              const opts = cfg.categoryOptions?.[cat] ?? {};
              return (
                <div key={cat} className="setting-card">
                  <div className="control-row" style={{ justifyContent: "space-between" }}>
                    <div>
                      <Toggle checked={on} onChange={(v) => toggleCat(cat, v)} label={cat[0].toUpperCase() + cat.slice(1)} disabled={!canManage} />
                      <div className="hint" style={{ marginTop: 2 }}>{HELP[cat] ?? ""}</div>
                    </div>
                    {/* The box takes what the row leaves its Test button, up to 200px. Held at a
                        fixed 200px, the two widened every category's card past the edge of the
                        smallest phones' screens. */}
                    <div className="control-row" style={{ flexWrap: "nowrap" }}>
                      <input value={channel} onChange={(e) => setChannel(cat, e.target.value)} disabled={!canManage} placeholder="Channel id" style={{ width: "100%", maxWidth: 200 }} />
                      <button className="ghost mini" disabled={!channel || testing === cat || !canManage} onClick={() => test(cat)} title="Send a test message to this channel">{testing === cat ? "…" : "Test"}</button>
                    </div>
                  </div>
                  {on && (
                    <div className="control-row" style={{ marginTop: 8, gap: 10, flexWrap: "wrap" }}>
                      <label className="inline" title="Role pinged once per posted batch (right-click a role → Copy Role ID)">
                        Ping role<input value={opts.mentionRoleId ?? ""} onChange={(e) => setCatOpt(cat, { mentionRoleId: e.target.value })} disabled={!canManage} placeholder="Role id (optional)" style={{ width: 160, marginLeft: 6 }} />
                      </label>
                      {cat === "kills" && (
                        <Toggle checked={opts.teamkillsOnly === true} disabled={!canManage}
                          onChange={(v) => setCatOpt(cat, { teamkillsOnly: v })}
                          label="Team kills only" title="Drop regular kills — relay only team kills" />
                      )}
                      {cat === "admin" && (
                        <Toggle checked={opts.includeVoteBallots === true} disabled={!canManage}
                          onChange={(v) => setCatOpt(cat, { includeVoteBallots: v })}
                          label="Include every vote cast" title="Relay each ballot as well as the vote's start and result — one line per player, so leave this off unless you need it" />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <Divider label="Ping alerts" />
          <Explanation>Immediate messages (with an optional role @mention) — separate from the batched relay above. Paste a role id to ping (right-click a role → Copy Role ID); leave blank for no ping.</Explanation>

          <div className="setting-card">
            <div className="control-row" style={{ justifyContent: "space-between" }}>
              <div>
                <Toggle checked={cfg.alerts.adminPing.enabled} onChange={(v) => setAdminPing({ enabled: v })} label="Admin requests" disabled={!canManage} />
                <div className="hint" style={{ marginTop: 2 }}>Pings staff when a player types the trigger in chat.</div>
              </div>
            </div>
            <div className="grid" style={{ marginTop: 8 }}>
              <label>Chat trigger<input value={cfg.alerts.adminPing.trigger} onChange={(e) => setAdminPing({ trigger: e.target.value })} disabled={!canManage} placeholder="!admin" /></label>
              <label>Channel id<input value={cfg.alerts.adminPing.channelId ?? ""} onChange={(e) => setAdminPing({ channelId: e.target.value })} disabled={!canManage} placeholder="Channel id" /></label>
              <label>Ping role id (optional)<input value={cfg.alerts.adminPing.mentionRoleId ?? ""} onChange={(e) => setAdminPing({ mentionRoleId: e.target.value })} disabled={!canManage} placeholder="Role id" /></label>
            </div>
          </div>

          <div className="setting-card" style={{ marginTop: 10 }}>
            <div className="control-row" style={{ justifyContent: "space-between" }}>
              <div>
                <Toggle checked={cfg.alerts.watchlist.enabled} onChange={(v) => setWatch({ enabled: v })} label="Watchlist joins" disabled={!canManage} />
                <div className="hint" style={{ marginTop: 2 }}>Pings staff when a watchlisted player connects.</div>
              </div>
            </div>
            <div className="grid" style={{ marginTop: 8 }}>
              <label>Channel id<input value={cfg.alerts.watchlist.channelId ?? ""} onChange={(e) => setWatch({ channelId: e.target.value })} disabled={!canManage} placeholder="Channel id" /></label>
              <label>Ping role id (optional)<input value={cfg.alerts.watchlist.mentionRoleId ?? ""} onChange={(e) => setWatch({ mentionRoleId: e.target.value })} disabled={!canManage} placeholder="Role id" /></label>
            </div>
          </div>

          <div className="setting-card" style={{ marginTop: 10 }}>
            <div className="control-row" style={{ justifyContent: "space-between" }}>
              <div>
                <Toggle checked={cfg.alerts.automation?.enabled ?? false} onChange={(v) => setAutomation({ enabled: v })} label="Player rules firing" disabled={!canManage} />
                <Explanation>
                  Reports a rule from <strong>Auto settings → Rules</strong> acting on a player — e.g. “8 team kills in 30s → temp ban”
                  posts the rule name, player, action and reason here. Dry-runs (observe mode) and failures are labeled.
                  {" "}This is the Rules tab only: server-settings profiles and seeding never post here.
                  {" "}Each rule also has its own <em>Ping Discord when this rule fires</em> switch, so a noisy one can be
                  silenced without turning this off for the rest.
                  {" "}With Discord sign-in set up, a firing on one player links to their profile in this panel.
                </Explanation>
              </div>
            </div>
            <div className="grid" style={{ marginTop: 8 }}>
              <label>Channel id<input value={cfg.alerts.automation?.channelId ?? ""} onChange={(e) => setAutomation({ channelId: e.target.value })} disabled={!canManage} placeholder="Channel id" /></label>
              <label>Ping role id (optional)<input value={cfg.alerts.automation?.mentionRoleId ?? ""} onChange={(e) => setAutomation({ mentionRoleId: e.target.value })} disabled={!canManage} placeholder="Role id" /></label>
            </div>
          </div>

          <div className="setting-card" style={{ marginTop: 10 }}>
            <div className="control-row" style={{ justifyContent: "space-between" }}>
              <div>
                <Toggle checked={cfg.alerts.serverDark?.enabled ?? false} onChange={(v) => setServerDark({ enabled: v })} label="Server went dark" disabled={!canManage} />
                <Explanation>
                  Pings staff when this server stops answering RCON for a few minutes — a crash, a restart, a lost
                  connection — and once more when it comes back. One alert each way, not one per retry.
                </Explanation>
              </div>
            </div>
            <div className="grid" style={{ marginTop: 8 }}>
              <label>Channel id<input value={cfg.alerts.serverDark?.channelId ?? ""} onChange={(e) => setServerDark({ channelId: e.target.value })} disabled={!canManage} placeholder="Channel id" /></label>
              <label>Ping role id (optional)<input value={cfg.alerts.serverDark?.mentionRoleId ?? ""} onChange={(e) => setServerDark({ mentionRoleId: e.target.value })} disabled={!canManage} placeholder="Role id" /></label>
            </div>
          </div>

          {!canManage && <p className="hint">You need the Server config permission to change the Discord relay.</p>}
        </>
      )}
      </Panel>
      {/* The board is the opposite of the relay above — one message that is never added to, rather
          than a stream of them — so it gets its own panel and its own save rather than hiding as a
          row in a list of event categories. */}
      <MatchBoardPanel canManage={canManage} />
      <BoardBadgePanel />
      {/* Same tab, separate panel: it is the same KIND of setting — pick a channel, decide what
          makes the bot post in it — but it is configured once for the instance rather than per
          server, and folding it into the card above would say otherwise. */}
      {canCommunity && <AnnouncementNudgePanel canManage={canCommunity} />}
    </PanelGroup>
  );
}

const BOARD_DEFAULT: StatusBoard = { enabled: false, channelId: null, messageId: null, intervalSec: 60, title: null };
/**
 * What the board would print if no title is set — the same reduction the renderer does, so the
 * placeholder in the box is the real fallback rather than a description of it.
 *
 * A hand-kept mirror of `headline()` in apps/workers/src/board-image.ts — the two apps share no
 * package. A change there must be made here too, or this placeholder lies about the fallback.
 */
function headlineFrom(serverName: string | undefined): string {
  if (!serverName) return "Server name";
  const first = serverName.split(/\s*[|\u00b7]\s*/)[0]?.trim() || serverName.trim();
  return (first.length >= 3 ? first : serverName.trim()).toUpperCase();
}
/** The board shrinks a long headline to fit, so this is about legibility rather than storage. */
const BOARD_TITLE_MAX = 48;
/** Discord edits are rate-limited and a round moves slowly; anything under 30s buys nothing. */
const BOARD_MIN_SEC = 30;

/**
 * The live match board: ONE Discord message per server, edited in place forever.
 *
 * Deliberately not a "post the scoreboard" button. A channel that fills up with round summaries is
 * worse than no channel — the top of it is always out of date and people read it anyway — so the
 * worker creates one message and then only ever edits it.
 */
/**
 * The match board's corner badge: the community's own image, one for every server's board. None is
 * built in. The program carried one community's badge once, so every install's board wore it.
 * The badge travels as the file's own bytes, not JSON, so it is read and sent with fetch.
 */
function BoardBadgePanel() {
  // Its own check: the tab's flag is the read one, and this badge is on every server's board, so
  // changing it takes the match board's permission for every server. An upload refused at the server
  // is never filed for approval, so offering it to anyone else would only lead to a refusal.
  const canManage = holdsOutright(useGrants(), "discord.relay", "write");
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  const read = useCallback(async () => {
    try {
      const r = await fetch("/api/discord/board-badge", { headers: authHeaders("/discord/board-badge") });
      if (r.status === 404) { setUrl(null); setState("ready"); return; }
      if (!r.ok) throw await refusal(r);
      setUrl(URL.createObjectURL(await r.blob()));
      setState("ready");
    } catch (e) {
      // A failed read offers nothing to change: an upload over it would replace a badge nobody saw.
      setErr(`Couldn't read the badge: ${(e as Error).message}`);
      setState("failed");
    }
  }, []);
  useEffect(() => { void read(); }, [read]);
  // Each preview is a blob address; the one replaced is let go, and the last one with the panel.
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  async function upload(file: File) {
    setBusy(true); setErr(""); setOk("");
    try {
      const r = await fetch("/api/discord/board-badge", {
        method: "PUT",
        headers: { ...authHeaders("/discord/board-badge"), "content-type": "application/octet-stream" },
        body: await file.arrayBuffer(),
      });
      if (!r.ok) throw await refusal(r);
      await read();
      setOk("Badge saved. The board wears it from its next update.");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true); setErr(""); setOk("");
    try {
      await api("/discord/board-badge", { method: "DELETE" });
      setUrl(null);
      setOk("Badge removed. The board shows only the server's name.");
    } catch (e) {
      if (wasFiled(e)) setOk((e as Error).message); else setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <Panel id="board-badge" caps="discord.relay" title="Match board badge" subtitle="All servers">
      <Explanation>
        Your community&apos;s badge, drawn in the corner of every server&apos;s match board. Nothing is built in:
        without one, the board shows only the server&apos;s name. A square PNG with a transparent background looks
        best; PNG, JPG and WebP up to 2 MB are taken.
      </Explanation>
      <ActionResult ok={ok} error={err} />
      {state === "loading" ? <SkeletonLines lines={2} /> : state === "ready" && (
        <div className="control-row" style={{ flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          {url
            ? <img src={url} alt="Match board badge" width={96} height={96} style={{ objectFit: "contain" }} />
            : <span className="muted">No badge yet.</span>}
          {canManage && (
            <input type="file" aria-label={url ? "Replace the badge" : "Upload a badge"} accept="image/png,image/jpeg,image/webp" disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
          )}
          {canManage && url && <button type="button" onClick={() => void remove()} disabled={busy}>Remove</button>}
        </div>
      )}
      {!canManage && state === "ready" && <p className="hint">Changing the badge needs the Discord relay permission on every server.</p>}
    </Panel>
  );
}

function MatchBoardPanel({ canManage }: { canManage: boolean }) {
  const { serverId, server } = useServers();
  const [board, setBoard] = useState<StatusBoard>(BOARD_DEFAULT);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  const loader = useMemo(() => (serverId ? () => api<Resp>(`/servers/${serverId}/discord`) : null), [serverId]);
  const { data: resp, error: loadErr, reload: load } = useResource(loader);
  useEffect(() => {
    if (!resp) return;
    setBoard({ ...BOARD_DEFAULT, ...(resp.config?.statusBoard ?? {}) });
    setOk(""); setDirty(false);
  }, [resp]);

  const set = (patch: Partial<StatusBoard>) => { setBoard((b) => ({ ...b, ...patch })); setDirty(true); setOk(""); };

  async function save() {
    setBusy(true); setErr(""); setOk("");
    try {
      // messageId is the worker's, not ours: it names the message being kept current, so the form
      // never sends it and the API carries the stored one through.
      const r = await api<{ config: Config }>(`/servers/${serverId}/discord`, {
        method: "PUT",
        body: { statusBoard: { enabled: board.enabled, channelId: board.channelId ?? "", intervalSec: board.intervalSec, title: board.title ?? "" } },
      });
      setBoard({ ...BOARD_DEFAULT, ...(r.config?.statusBoard ?? {}) }); setDirty(false); setOk("Saved.");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  if (!serverId) return null;
  // No form until the saved board is read: a save sends all four settings, so one edit made over
  // the blank defaults wrote them over the real ones — the board off, its channel and title gone.
  if (!resp) {
    return (
      <Panel id="match-board" caps="discord.relay" title="Live match board" subtitle={server?.name}>
        {loadErr ? <ActionResult error={`Couldn't read the match board: ${loadErr}`} /> : <SkeletonLines lines={4} />}
      </Panel>
    );
  }

  return (
    <Panel
      id="match-board"
      caps="discord.relay"
      title="Live match board"
      subtitle={server?.name}
      actions={<>
        {dirty && <button className="ghost" onClick={load}>Discard</button>}
        <button className="primary" onClick={save} disabled={!dirty || busy || !canManage}>{busy ? "Saving…" : "Save"}</button>
      </>}
    >
      <Explanation>
        Keeps <strong>one</strong> message in a Discord channel always showing the current round — score, sectors,
        players, both queues, VIPs and per-side totals. It is edited in place, never re-posted, so the channel
        never fills with stale rounds.
      </Explanation>
      {canManage && <AskNotice capability="discord.relay" serverId={serverId} />}
      <ActionResult ok={ok} error={err || loadErr} />

      <SettingCard title="Enable board" description="Draw and keep updating the match board for this server.">
        <Toggle checked={board.enabled} onChange={(v) => set({ enabled: v })} label={board.enabled ? "On" : "Off"} disabled={!canManage} />
      </SettingCard>

      <div className="grid" style={{ marginTop: 10 }}>
        <label>Channel id
          <input value={board.channelId ?? ""} onChange={(e) => set({ channelId: e.target.value })} disabled={!canManage} placeholder="Channel id" />
        </label>
        <label>Board title
          <input value={board.title ?? ""} maxLength={BOARD_TITLE_MAX} onChange={(e) => set({ title: e.target.value })}
            disabled={!canManage} placeholder={headlineFrom(server?.name)} />
        </label>
        <label>Update every (seconds)
          <input type="number" min={BOARD_MIN_SEC} max={3600} step={10} value={board.intervalSec}
            onChange={(e) => set({ intervalSec: Number(e.target.value) })} disabled={!canManage} />
        </label>
      </div>
      <Explanation>
        <p>
          The title is printed across the top of the board, exactly as you type it. Left empty it falls back to the
          part of the server name before the first <code>|</code> — shown greyed in the box — because a full server
          name carries its whole rulebook and shrinks the headline to nothing.
        </p>
        <p>
          Minimum {BOARD_MIN_SEC} seconds — Discord rate-limits edits and a round does not move faster than that.
          Changing the channel abandons the old message and draws a fresh one in the new channel.
        </p>
      </Explanation>
      <p className="hint">
        {board.messageId
          ? `Currently keeping message ${board.messageId} up to date.`
          : "No message posted yet — the worker will create one on its next pass once this is on and a channel is set."}
      </p>
      {!canManage && <p className="hint">You need the Server config permission to change the match board.</p>}
    </Panel>
  );
}
