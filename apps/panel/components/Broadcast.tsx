"use client";
/**
 * Broadcast — the line that SCROLLS ACROSS THE TOP LEFT of every player's screen, and the rotation
 * behind it. Two tools on one page for the active server:
 *   1. "Broadcast now": type (or pick a preset) and put one line up immediately.
 *   2. "Rotating broadcasts": a list the worker cycles through on an interval, with a master switch
 *      and a dry-run (audit-only) mode.
 *
 * A broadcast is NOT the same thing as a message, and calling it one here is what made the
 * difference invisible. A broadcast scrolls past in a few seconds and is gone, so it is right for
 * ambient reminders — rules, the Discord invite, an event plug — and wrong for anything a player
 * actually has to read. The message that sits in the top right until it is acknowledged lives on
 * Moderation → Messages.
 *
 * Presets exist so non-technical staff never have to think one up from scratch — click to insert,
 * then edit. Broadcasting needs the "Message players" permission; editing the rotation needs
 * "Broadcast config". The page adapts to whichever the user has.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useLatestLoad } from "../lib/resource";
import { useResetOnServerChange, useServers } from "../lib/servers";
import { ActionResult, AskNotice, Divider, EmptyState, ObserveBanner, SettingCard, SkeletonLines, Toggle, Explanation } from "./ui";
import { PanelGroup, Panel } from "./Panel";
import { PresetBar } from "./PresetBar";
import { TemplatePicker } from "./TemplatePicker";
import { PlaceholderHint } from "./Placeholders";
import { LiveWelcome } from "./LiveWelcome";

interface BroadcastConfig {
  serverId: string;
  enabled: boolean;
  dryRun: boolean;
  intervalSec: number;
  randomize: boolean;
  messages: string[];
  updatedAt: string;
}

const INTERVALS: { label: string; sec: number }[] = [
  { label: "2 min", sec: 120 }, { label: "5 min", sec: 300 }, { label: "10 min", sec: 600 },
  { label: "15 min", sec: 900 }, { label: "30 min", sec: 1800 },
];

export default function Broadcast({ canConfig, canSend }: { canConfig: boolean; canSend: boolean }) {
  const { serverId, server } = useServers();
  const [cfg, setCfg] = useState<BroadcastConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  // Send-now state.
  const [sendText, setSendText] = useState("");
  const [sending, setSending] = useState(false);
  // Two fields, not one: the outcome of a send is success-or-failure, and deciding which by
  // comparing the message text to "Broadcast sent." meant rewording the success copy would have
  // silently started rendering it as an error.
  const [sendOk, setSendOk] = useState("");
  const [sendErr, setSendErr] = useState("");
  // Rotation add-message input.
  const [draft, setDraft] = useState("");

  // Only the newest read may paint: one still on its way from the server you left would otherwise
  // land under the new server's name, and Save would write that server's rotation onto this one.
  const claim = useLatestLoad();
  const load = useCallback(() => {
    const fresh = claim();
    if (!serverId || !canConfig) return;
    setDirty(false); setErr(""); setOk("");
    api<{ config: BroadcastConfig }>(`/servers/${serverId}/broadcast`)
      .then((r) => { if (fresh()) setCfg(r.config); })
      .catch((e) => { if (fresh()) setErr(e.message); });
  }, [serverId, canConfig, claim]);
  useEffect(() => { load(); }, [load]);

  const set = <K extends keyof BroadcastConfig>(k: K, v: BroadcastConfig[K]) => {
    setCfg((c) => (c ? { ...c, [k]: v } : c)); setDirty(true); setOk("");
  };
  const setMessages = (messages: string[]) => set("messages", messages);

  async function save() {
    if (!cfg) return;
    setBusy(true); setErr(""); setOk("");
    try {
      const r = await api<{ config: BroadcastConfig }>(`/servers/${serverId}/broadcast`, {
        method: "PUT",
        body: { enabled: cfg.enabled, dryRun: cfg.dryRun, intervalSec: cfg.intervalSec, randomize: cfg.randomize, messages: cfg.messages },
      });
      setCfg(r.config); setDirty(false); setOk("Saved.");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function sendNow() {
    const message = sendText.trim();
    if (!message) return;
    setSending(true); setSendOk(""); setSendErr("");
    try {
      await api(`/servers/${serverId}/broadcast/send`, { method: "POST", body: { message } });
      setSendOk("Broadcast sent.");
      setSendText("");
    } catch (e) { setSendErr((e as Error).message); } finally { setSending(false); }
  }

  // What belonged to the last server goes with it: the send-now outcome ("Broadcast sent." followed
  // you to the next server), and the rotation, which stayed on screen under the new server's name,
  // and saveable, until the new one's arrived.
  useResetOnServerChange(() => { setSendOk(""); setSendErr(""); setCfg(null); });

  if (!serverId) return <div className="card"><p className="muted">Select a server to broadcast on.</p></div>;

  const active = server?.engagementMode === "active";
  const addMessage = (text: string) => { const t = text.trim(); if (t) setMessages([...(cfg?.messages ?? []), t]); };
  const removeMessage = (i: number) => setMessages((cfg?.messages ?? []).filter((_, x) => x !== i));
  const editMessage = (i: number, text: string) => setMessages((cfg?.messages ?? []).map((m, x) => (x === i ? text : m)));
  const move = (i: number, dir: -1 | 1) => {
    const list = [...(cfg?.messages ?? [])]; const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!]; setMessages(list);
  };

  // No PageHeader here: this is a Hub tab now, and the Hub draws the header from the route. A
  // second one underneath it was the visible cost of the move.
  return (
    <div>
      <ObserveBanner server={server}>The rotating list still saves; only sending is blocked.</ObserveBanner>

      {serverId && <PresetBar feature="broadcast" featureLabel="Broadcast" serverId={serverId} canManage={canConfig} dirty={dirty} onApplied={load} />}

      <PanelGroup viewId="broadcast">
      {canSend && (
        <Panel id="sendnow" caps="action.message" title="Broadcast now"
          subtitle="Scrolls across the top left once, then it's gone.">
          <AskNotice capability="action.message" serverId={serverId} />
          <label className="field">Broadcast text
            <textarea rows={2} value={sendText} maxLength={1000} placeholder="Type a line, or pick a preset below…" onChange={(e) => { setSendText(e.target.value); setSendOk(""); setSendErr(""); }} />
          </label>
          <TemplatePicker kind="broadcast" onPick={(p) => { setSendText(p); setSendOk(""); setSendErr(""); }} />
          <PlaceholderHint scope="server" />
          <div className="actions">
            <button className="primary" disabled={!active || sending || !sendText.trim()} onClick={sendNow}>{sending ? "Sending…" : "Broadcast now"}</button>
            <ActionResult ok={sendOk} error={sendErr} />
          </div>
          <Explanation>
            Players see this scroll past for a few seconds. If it matters that everyone actually
            reads it, send it from Moderation &rarr; Messages instead — that one waits to be acknowledged.
          </Explanation>
          {!canConfig && <p className="hint">You can send one-off broadcasts. Editing the rotating list needs the Broadcast config permission.</p>}
        </Panel>
      )}

      {canConfig && (
        <Panel
          id="rotation"
          caps="broadcast.config"
          title="Rotating broadcasts"
          subtitle={active ? undefined : "observe mode — nothing is sent"}
          actions={<>
            {dirty && <button className="ghost" onClick={load}>Discard</button>}
            <button className="primary" onClick={save} disabled={!dirty || busy || !cfg}>{busy ? "Saving…" : "Save"}</button>
          </>}
        >
          <Explanation>The worker scrolls these across the top left in turn, on a timer. Great for rules reminders and Discord promos — the things worth repeating and not worth interrupting anyone for.</Explanation>
          <AskNotice capability="broadcast.config" serverId={serverId} />

          <ActionResult ok={ok} error={err} />
          {!cfg && !err && <SkeletonLines lines={3} />}

          {cfg && (
            <>
              <SettingCard title="Enable rotation" description="Master switch for the scrolling auto-broadcast on this server.">
                <Toggle checked={cfg.enabled} onChange={(v) => set("enabled", v)} label={cfg.enabled ? "On" : "Off"} />
              </SettingCard>
              <SettingCard title="Dry-run" description="Log what would be sent to Activity, but don't put anything on screen. Leave on until you've reviewed the list.">
                <Toggle checked={cfg.dryRun} onChange={(v) => set("dryRun", v)} label={cfg.dryRun ? "Dry-run" : "Live"} />
              </SettingCard>

              <Divider label="Timing" />
              <div className="control-row">
                <span className="field-label m-0">Every</span>
                {INTERVALS.map((iv) => (
                  <button key={iv.sec} type="button" className={cfg.intervalSec === iv.sec ? "badge active chip-btn" : "badge chip-btn"} onClick={() => set("intervalSec", iv.sec)}>{iv.label}</button>
                ))}
                <label className="inline">Custom (sec)
                  <input type="number" min={30} max={86400} value={cfg.intervalSec} onChange={(e) => set("intervalSec", Math.max(30, Number(e.target.value) || 30))} style={{ width: 90 }} />
                </label>
              </div>
              <SettingCard title="Shuffle order" description="Pick the next message at random instead of going in order.">
                <Toggle checked={cfg.randomize} onChange={(v) => set("randomize", v)} label={cfg.randomize ? "Random" : "In order"} />
              </SettingCard>

              <Divider label={`Broadcasts (${cfg.messages.length})`} />
              {cfg.messages.length === 0 && (
                <EmptyState icon="📢" title="No rotating broadcasts yet">
                  These scroll across the top left in turn while people play — rules, your Discord
                  invite, event notices. Add one below, or start from a preset.
                </EmptyState>
              )}
              <div style={{ display: "grid", gap: 6 }}>
                {cfg.messages.map((m, i) => (
                  <div key={i} className="control-row" style={{ flexWrap: "nowrap" }}>
                    <span className="muted" style={{ width: 20, textAlign: "right" }}>{i + 1}.</span>
                    <input value={m} maxLength={1000} onChange={(e) => editMessage(i, e.target.value)} className="grow-min" aria-label={`Broadcast ${i + 1}`} />
                    <button className="ghost mini" disabled={i === 0} title="Move up" onClick={() => move(i, -1)}>↑</button>
                    <button className="ghost mini" disabled={i === cfg.messages.length - 1} title="Move down" onClick={() => move(i, 1)}>↓</button>
                    <button className="ghost mini" title="Remove" onClick={() => removeMessage(i)}>✕</button>
                  </div>
                ))}
              </div>

              <div className="control-row" style={{ marginTop: 10, flexWrap: "nowrap" }}>
                <input value={draft} maxLength={1000} placeholder="Add a broadcast…" onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { addMessage(draft); setDraft(""); } }} className="grow-min" />
                <button className="ghost" disabled={!draft.trim()} onClick={() => { addMessage(draft); setDraft(""); }}>Add</button>
              </div>
              <TemplatePicker kind="broadcast" label="Presets — click to append, then edit:" onPick={(p) => addMessage(p)} />
              <PlaceholderHint scope="server">— filled each time the line goes out.</PlaceholderHint>

            </>
          )}
        </Panel>
      )}
      {canConfig && <LiveWelcome />}
      </PanelGroup>
    </div>
  );
}
