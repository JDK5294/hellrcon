"use client";
/**
 * SAVED SETUPS toolbar for a feature editor (Broadcast, Map vote, Seeding, Rules): save this
 * feature's whole configuration under a name, apply a named one to this server, delete one. The
 * editor below holds every field; this line makes the whole thing one named unit that Auto
 * settings profiles (and other servers) can apply in one step.
 *
 * Called a "saved setup" rather than a preset because the app already has two other things by
 * that name — the wording templates and the VIP duration buttons — and staff asking "where are
 * the presets?" got three different answers. This one is a snapshot of a whole feature.
 *
 * A saved setup captures behaviour only, never the feature's enabled/dry-run switches: applying
 * one cannot arm a feature that was off.
 */
import { useMemo, useState } from "react";
import { api } from "../lib/api";
import { useResource } from "../lib/resource";
import { useServers } from "../lib/servers";
import { useConfirm } from "../lib/feedback";
import { ActionResult, Explanation } from "./ui";

interface PresetInfo { id: string; name: string; game?: string | null; createdByName: string; updatedAt: string }

export function PresetBar({ feature, featureLabel, serverId, canManage, dirty = false, onApplied }: {
  feature: string;
  featureLabel: string;
  serverId: string;
  canManage: boolean;
  /** when the surrounding editor has unsaved edits, warn that they won't be in the snapshot. */
  dirty?: boolean;
  /** reload the surrounding editor after a preset lands on this server. */
  onApplied?: () => void;
}) {
  const confirm = useConfirm();
  const { server } = useServers();
  // Presets are community-wide, but a game-scoped one speaks one game's vocabulary — the API
  // refuses a cross-game apply, so the picker says where each foreign preset came from up front.
  const thisGame = server?.id === serverId ? server?.game : null;
  const loader = useMemo(() => () => api<{ presets: Record<string, PresetInfo[]> }>(`/presets`).catch(() => ({ presets: {} as Record<string, PresetInfo[]> })), []);
  const { data, reload } = useResource(loader);
  const presets = useMemo(() => data?.presets?.[feature] ?? [], [data, feature]);
  const [name, setName] = useState("");
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  async function save() {
    setBusy(true); setErr(""); setOk("");
    try {
      await api(`/presets/${feature}`, { method: "POST", body: { name: name.trim(), serverId } });
      setOk(`Saved preset "${name.trim()}".`); setName(""); reload();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function apply() {
    const p = presets.find((x) => x.id === pick);
    if (!p) return;
    if (!(await confirm({ title: `Apply ${featureLabel} preset "${p.name}" to this server?\n\nIts saved behaviour replaces the current config. The on/off and dry-run switches are not touched.`, confirmLabel: "Apply", danger: false }))) return;
    setBusy(true); setErr(""); setOk("");
    try {
      await api(`/servers/${serverId}/presets/${feature}/apply`, { method: "POST", body: { name: p.name } });
      setOk(`Applied "${p.name}".`); onApplied?.();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function remove(p: PresetInfo) {
    if (!(await confirm({ title: `Delete the ${featureLabel} setup "${p.name}"?\n\nProfiles that apply it by name will log a warning and skip it.`, confirmLabel: "Delete", danger: true }))) return;
    setBusy(true); setErr(""); setOk("");
    try {
      await api(`/presets/${feature}/${p.id}`, { method: "DELETE" });
      setOk(`Deleted "${p.name}".`); if (pick === p.id) setPick(""); reload();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  // Every control here is a write (save/apply/delete), so without the write grant the bar would
  // be a picker that does nothing — hide it rather than render a dead end.
  if (!canManage) return null;

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <ActionResult ok={ok} error={err} />
      <div className="control-row" role="group" aria-label="Saved setups">
        <span className="field-label" style={{ margin: 0 }}>Saved setups</span>
        {canManage && (
          <>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name this setup" maxLength={80} style={{ maxWidth: 180 }} />
            <button className="mini" onClick={save} disabled={!name.trim() || busy}>Save current setup</button>
          </>
        )}
        {presets.length > 0 && (
          <>
            <select value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Pick a saved setup…</option>
              {presets.map((p) => <option key={p.id} value={p.id}>{p.name}{p.game && thisGame && p.game !== thisGame ? ` (from a ${p.game} server)` : ""}</option>)}
            </select>
            {canManage && <button className="mini" onClick={apply} disabled={!pick || busy}>Apply</button>}
            {/* Deleting used to be a bare ✕ that appeared only once something was picked, which is
                how staff concluded saved setups could not be deleted at all. It is a labelled
                button now, always present, and it says what it will remove. */}
            {canManage && (
              <button className="ghost mini danger" disabled={!pick || busy}
                title={pick ? "Delete the selected setup" : "Pick a saved setup to delete it"}
                onClick={() => { const p = presets.find((x) => x.id === pick); if (p) remove(p); }}>
                Delete
              </button>
            )}
          </>
        )}
        {dirty && <span className="hint" style={{ margin: 0 }}>Unsaved edits are not included — save first.</span>}
      </div>
      <Explanation>A saved setup is this feature&apos;s whole configuration under one name — apply it to another server, or let an Auto settings profile apply it with a single &ldquo;Then&rdquo; line.</Explanation>
    </div>
  );
}
