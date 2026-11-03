"use client";
/**
 * LIVE SETTINGS — the running server's game-config values, read and edited card by card. This is
 * the "right now" half of server configuration; Auto settings → Server settings drives the SAME
 * descriptor fields on a schedule, and Administration → Connections owns the servers themselves.
 *
 * (This file once held all of those as tabs of one view. They are separate destinations in the
 * route registry now — the header described a structure that had not existed for some time.)
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { ActionResult, AskNotice, Callout, NoServersNote, SettingCard, Slider, Toggle } from "./ui";
import { PanelGroup, Panel } from "./Panel";
import { useServers } from "../lib/servers";
import { useLatestLoad } from "../lib/resource";
import { useGame, type GameConfigField } from "../lib/game";
import { boolSetting } from "../lib/settingValue";

// The FIELD LIST comes from the game descriptor (useGame().descriptor.configFields) — the panel
// holds no per-game field data. What lives here is pure presentation: optional "skins" that give a
// known field a nicer control (slider ticks, icon, blurb). A descriptor field without a skin still
// renders with a generic control for its kind, so a new game's config works with zero panel edits.
type Ctl =
  | { kind: "toggle" }
  | { kind: "slider"; min: number; max: number; step?: number; ticks: number[]; unit?: string }
  | { kind: "number" }
  | { kind: "text"; placeholder?: string; multiline?: boolean };
interface Skin { section: string; desc: string; icon: string; ctl?: Ctl; helper?: string }

const SKINS: Record<string, Skin> = {
  autoBalanceEnabled: { section: "Balance & fair play", desc: "Keep the teams within the threshold automatically.", icon: "⚖" },
  autoBalanceThreshold: { section: "Balance & fair play", desc: "Max allowed player-count difference between teams.", icon: "⚖", ctl: { kind: "slider", min: 0, max: 10, ticks: [0, 2, 4, 6, 8, 10] } },
  voteKickEnabled: { section: "Balance & fair play", desc: "Allow players to start vote-kicks.", icon: "🗳" },
  highPing: { section: "Kicks & limits", desc: "Kick players whose ping exceeds this.", icon: "📶", ctl: { kind: "slider", min: 0, max: 2000, step: 50, ticks: [0, 500, 1000, 1500, 2000], unit: "ms" }, helper: "0 to disable" },
  idleKick: { section: "Kicks & limits", desc: "Kick players idle for longer than this.", icon: "💤", ctl: { kind: "slider", min: 0, max: 60, ticks: [0, 15, 30, 45, 60], unit: "min" }, helper: "0 to disable" },
  teamSwitchCooldown: { section: "Kicks & limits", desc: "Time players must wait before switching teams.", icon: "🔁", ctl: { kind: "slider", min: 0, max: 30, ticks: [0, 5, 10, 15, 20, 25, 30], unit: "min" }, helper: "0 to disable" },
  maxQueuedPlayers: { section: "Kicks & limits", desc: "Size of the join queue.", icon: "🚪", ctl: { kind: "slider", min: 0, max: 6, ticks: [0, 1, 2, 3, 4, 5, 6] } },
  numVipSlots: { section: "VIP & messaging", desc: "Reserved slots for VIPs.", icon: "★", ctl: { kind: "number" } },
  mapShuffle: { section: "Maps", desc: "On, the game plays the rotation in its own shuffled order instead of the order it is listed in.", icon: "🔀",
    helper: "Off keeps the order set under Maps → Rotation. Auto settings profiles can switch it too." },
  welcomeMessage: { section: "VIP & messaging", desc: "Shown to players as they join.", icon: "✉", ctl: { kind: "text", placeholder: "Welcome to the server…", multiline: true },
    helper: "If Signatures has the second line switched on for the welcome/notice message, it is appended to what you save here." },
};

interface Field { key: string; label: string; desc: string; icon: string; ctl: Ctl; helper?: string; readable: boolean }

/** Generic control for a descriptor field with no skinned control. */
function defaultCtl(f: GameConfigField): Ctl {
  if (f.kind === "bool") return { kind: "toggle" };
  if (f.kind === "num") return { kind: "number" };
  return { kind: "text" };
}

/** Merge descriptor fields with presentation skins into ordered sections. */
function buildSections(configFields: GameConfigField[]): { title: string; fields: Field[] }[] {
  const sections = new Map<string, Field[]>();
  for (const cf of configFields) {
    const skin = SKINS[cf.field];
    const field: Field = {
      key: cf.field,
      label: cf.label,
      desc: skin?.desc ?? "",
      icon: skin?.icon ?? "⚙",
      ctl: skin?.ctl ?? (cf.kind === "bool" ? { kind: "toggle" } : defaultCtl(cf)),
      helper: skin?.helper,
      readable: Boolean(cf.read),
    };
    const title = skin?.section ?? "Other settings";
    const list = sections.get(title) ?? [];
    list.push(field);
    sections.set(title, list);
  }
  return [...sections.entries()].map(([title, fields]) => ({ title, fields }));
}

/** The live game-server settings editor — one savable card per setting. Rendered as the
 *  Administration hub's "Live settings" tab (the old standalone Config hub was folded in there:
 *  both were settings screens, so they live under one destination now). */
export function LiveSettings({ canManage = true }: { canManage?: boolean }) {
  const { serverId, server, servers } = useServers();
  const game = useGame();
  const sections = useMemo(() => buildSections(game.descriptor?.configFields ?? []), [game.descriptor]);
  const allFields = useMemo(() => sections.flatMap((s) => s.fields), [sections]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, string>>({}); // last-loaded/saved baseline
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [showNotice, setShowNotice] = useState(true);
  /** Fields the live Auto settings profile is holding — a hand edit to one is rewritten by the
   *  drift pass, so the page says so instead of letting staff discover the fight. */
  const [managed, setManaged] = useState<{ profile: string; fields: string[] } | null>(null);
  /** Switches the server did not report: shown off (a switch has to show something) but labelled as
   *  unknown — "Disabled" there read as a fact, and for map shuffle that fact could be false. */
  const [unreported, setUnreported] = useState<Set<string>>(new Set());

  const claim = useLatestLoad();
  const load = useCallback(async () => {
    if (!serverId || !allFields.length) return;
    // These values are what Save writes back. A slow read for the server you just left landing on
    // top of the one you switched to would not just show the wrong settings — the next Save would
    // push them onto the server now selected.
    const fresh = claim();
    setLoading(true); setError(""); setNote("");
    try {
      const r = await api<{ config: Record<string, unknown>; managed?: { profile: string; fields: string[] } | null }>(`/servers/${serverId}/config`);
      if (!fresh()) return;
      setManaged(r.managed ?? null);
      const next: Record<string, string> = {};
      const unknown = new Set<string>();
      for (const f of allFields) {
        const v = r.config[f.key];
        if (f.ctl.kind === "toggle") {
          const on = boolSetting(v);
          if (on === null && f.readable) unknown.add(f.key);
          next[f.key] = String(on === true);
        } else {
          next[f.key] = v === undefined || v === null ? "" : String(v);
        }
      }
      setValues(next); setSaved(next); setUnreported(unknown);
    } catch (e) {
      if (fresh()) setError((e as Error).message);
    } finally {
      if (fresh()) setLoading(false);
    }
  }, [serverId, allFields, claim]);
  useEffect(() => { load(); }, [load]);

  function set(key: string, val: string) { setValues((v) => ({ ...v, [key]: val })); }

  async function save(f: Field) {
    setBusy(f.key); setError(""); setNote("");
    const raw = values[f.key] ?? "";
    const value = f.ctl.kind === "slider" || f.ctl.kind === "number" ? Number(raw || 0) : f.ctl.kind === "toggle" ? raw === "true" : raw;
    try {
      await api(`/servers/${serverId}/config`, { method: "POST", body: { [f.key]: value } });
      setSaved((s) => ({ ...s, [f.key]: raw }));
      setUnreported((u) => { const n = new Set(u); n.delete(f.key); return n; }); // set by us: known now
      setNote(`Saved ${f.label}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  return (
      <>
      <div className="card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <span className="muted">{server ? <>Editing <strong>{server.name}</strong></> : "Pick a server (top of the page)."}</span>
        <button className="ghost mini" onClick={load} disabled={loading || !serverId}>{loading ? "…" : "Reload"}</button>
      </div>
      {!servers.length && <NoServersNote>There is nothing to configure yet.</NoServersNote>}
      {servers.length > 0 && !allFields.length && <Callout variant="info">This game doesn&apos;t expose editable settings (no config schema in its game module).</Callout>}
      {showNotice && servers.length > 0 && allFields.length > 0 && (
        <Callout variant="info" onClose={() => setShowNotice(false)}>
          Some values may not reflect the live server — not every setting is reported back. You can still change them; each card saves on its own.
        </Callout>
      )}
      {server?.engagementMode === "observe" && (
        <Callout variant="warn">This server is in <strong>observe</strong> mode (read-only). Saving is refused until you switch it to <strong>active</strong>.</Callout>
      )}
      {managed && (
        <Callout variant="warn">
          Auto settings profile <strong>{managed.profile}</strong> is live and holding {managed.fields.length} of these
          setting(s) — the marked cards are re-applied from the profile when they drift, so a manual save there is
          rewritten within a pass. Edit the profile (Auto settings → Server settings), or disable it, if a change
          should stick.
        </Callout>
      )}
      {canManage && <AskNotice capability="server.config" serverId={serverId} />}
      <ActionResult error={error} />
      {note && <p className="muted">{note}</p>}
      </div>

      <PanelGroup viewId="server-config">
      {sections.map((sec) => (
        <Panel key={sec.title} id={sec.title} caps="open" title={sec.title}>
          {sec.fields.map((f) => {
            const dirty = (values[f.key] ?? "") !== (saved[f.key] ?? "");
            const val = values[f.key] ?? "";
            return (
              <SettingCard
                key={f.key}
                icon={f.icon}
                title={f.label}
                description={f.desc}
                dirty={dirty}
                helper={f.helper}
                action={<button className="mini" onClick={() => save(f)} disabled={!canManage || !dirty || busy === f.key}>{busy === f.key ? "…" : "Save"}</button>}
              >
                {f.ctl.kind === "toggle" && (
                  <Toggle checked={val === "true"} onChange={(v) => set(f.key, String(v))}
                    label={unreported.has(f.key) && !dirty ? "Not reported by the server" : val === "true" ? "Enabled" : "Disabled"} />
                )}
                {f.ctl.kind === "slider" && (
                  <Slider value={Number(val || 0)} min={f.ctl.min} max={f.ctl.max} step={f.ctl.step} ticks={f.ctl.ticks} unit={f.ctl.unit} onChange={(v) => set(f.key, String(v))} />
                )}
                {f.ctl.kind === "number" && (
                  <input type="number" value={val} onChange={(e) => set(f.key, e.target.value)} style={{ maxWidth: 160 }} />
                )}
                {f.ctl.kind === "text" && (
                  f.ctl.multiline
                    ? <textarea rows={2} value={val} placeholder={f.ctl.placeholder} onChange={(e) => set(f.key, e.target.value)} />
                    : <input value={val} placeholder={f.ctl.placeholder} onChange={(e) => set(f.key, e.target.value)} />
                )}
                {!f.readable && f.ctl.kind !== "toggle" && !val && <span className="muted fs-xs"> not read from server</span>}
                {managed?.fields.includes(f.key) && (
                  <span className="muted fs-xs" title={`Auto settings profile “${managed.profile}” re-applies this value when it drifts`}>
                    ⚙ held by profile “{managed.profile}”
                  </span>
                )}
              </SettingCard>
            );
          })}
        </Panel>
      ))}
      </PanelGroup>
      </>
  );
}
