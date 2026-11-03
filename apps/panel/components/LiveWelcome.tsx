"use client";
/**
 * The live welcome message — the welcome text the GAME shows everyone who joins, with server
 * placeholders the app fills in. The game holds one text for everybody, so only server-wide
 * placeholders work here (no {player_name}); the worker rewrites the game's text on a timer, and
 * only when the filled text changed. Off by default.
 */
import { useCallback, useEffect, useState } from "react";
import { api, fmt } from "../lib/api";
import { useLatestLoad } from "../lib/resource";
import { useServers } from "../lib/servers";
import { ActionResult, AskNotice, SkeletonLines, Toggle, Explanation } from "./ui";
import { Panel } from "./Panel";
import { PlaceholderHint } from "./Placeholders";

interface WelcomeConfig {
  serverId: string;
  enabled: boolean;
  template: string;
  intervalSec: number;
  lastText: string | null;
  lastWrittenAt: string | null;
  updatedAt: string;
}

const INTERVALS = [1, 2, 5, 10, 15, 30, 60];

export function LiveWelcome() {
  const { serverId, server } = useServers();
  const [cfg, setCfg] = useState<WelcomeConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  // Only the newest read may paint: a slow one from the server you left would land under the new
  // server's name, and Save would write that server's welcome onto this one.
  const claim = useLatestLoad();
  const load = useCallback(() => {
    const fresh = claim();
    if (!serverId) return;
    setDirty(false); setErr(""); setOk(""); setCfg(null);
    api<{ config: WelcomeConfig }>(`/servers/${serverId}/welcome`)
      .then((r) => { if (fresh()) setCfg(r.config); })
      .catch((e) => { if (fresh()) setErr(e.message); });
  }, [serverId, claim]);
  useEffect(() => { load(); }, [load]);

  const set = <K extends keyof WelcomeConfig>(k: K, v: WelcomeConfig[K]) => { setCfg((c) => (c ? { ...c, [k]: v } : c)); setDirty(true); setOk(""); };

  async function save() {
    if (!cfg) return;
    setBusy(true); setErr(""); setOk("");
    try {
      const r = await api<{ config: WelcomeConfig }>(`/servers/${serverId}/welcome`, {
        method: "PUT", body: { enabled: cfg.enabled, template: cfg.template, intervalSec: cfg.intervalSec },
      });
      setCfg(r.config); setDirty(false);
      setOk(r.config.enabled ? "Saved — the game gets the new text within a few seconds." : "Saved.");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const active = server?.engagementMode === "active";
  return (
    <Panel id="livewelcome" caps="broadcast.config" title="Live welcome message"
      subtitle={active ? "The game's welcome text, with server placeholders kept up to date" : "observe mode — nothing is written"}
      actions={<>
        {dirty && <button className="ghost" onClick={load}>Discard</button>}
        <button className="primary" onClick={save} disabled={!dirty || busy || !cfg}>{busy ? "Saving…" : "Save"}</button>
      </>}>
      <Explanation>
        The welcome message is stored on the game server and shown to everyone who joins — one text
        for all of them, so only server-wide placeholders work here (the next map, the player count),
        not a player&apos;s own name or VIP. The app fills them in and rewrites the game&apos;s text
        on a timer, and only when the result actually changed. Players joining never cause a write.
      </Explanation>
      <AskNotice capability="broadcast.config" serverId={serverId} />
      <ActionResult ok={ok} error={err} />
      {!cfg && !err && <SkeletonLines lines={3} />}
      {cfg && (
        <>
          <Toggle checked={cfg.enabled} onChange={(v) => set("enabled", v)}
            label={cfg.enabled ? "On — the app keeps the game's welcome text filled in" : "Off — the game keeps whatever welcome text it has"} />
          <label className="field">Welcome message
            <textarea rows={3} maxLength={1000} value={cfg.template} onChange={(e) => set("template", e.target.value)}
              placeholder="e.g. Welcome to {server_name}! Next map: {next_map}. Join our Discord for events." />
          </label>
          <PlaceholderHint scope="server" />
          <label className="field">Update at most every
            <select value={cfg.intervalSec} onChange={(e) => set("intervalSec", Number(e.target.value))}>
              {INTERVALS.map((m) => <option key={m} value={m * 60}>{m} minute{m === 1 ? "" : "s"}</option>)}
            </select>
          </label>
          <Explanation>
            A longer wait means fewer writes to the game. With {"{player_count}"} in the text it can
            change often, so the wait is the most it will ever write; with only {"{next_map}"} and
            {" {server_name}"} it writes about once a map. While this is on, the Server settings
            welcome box and auto-settings profiles leave the welcome text to it.
          </Explanation>
          {cfg.lastText && (
            <>
              <div className="field-label">What the game shows now{cfg.lastWrittenAt ? ` (written ${fmt(cfg.lastWrittenAt)})` : ""}</div>
              <pre className="announce-preview">{cfg.lastText}</pre>
            </>
          )}
        </>
      )}
    </Panel>
  );
}
