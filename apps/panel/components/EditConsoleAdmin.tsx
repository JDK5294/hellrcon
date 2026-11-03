"use client";
/**
 * The Console admin popup: give a player the GAME's own admin powers — admin camera, in-game
 * kicks — on one server or all of them, permanently or for a while.
 *
 * This existed as a system (routes, expiry sweep, its own Console admins screen) with no way to
 * reach it for ONE player. The only route in was to build a player group, add them to it, and run
 * a bulk action — three screens to do the thing staff do most often, one person at a time. So this
 * is the same shape as Edit VIP, deliberately: the same duration calculator, the same all-servers
 * tick, the same observe-mode banner, because they are the same decision about a different power.
 *
 * The admin GROUP is the game's vocabulary, not ours, so it is read live from the server (with the
 * game's stock groups as the fallback when the box is down) rather than typed.
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { preferredAdminGroup } from "../lib/adminGroups";
import { useServers } from "../lib/servers";
import { useToast, useConfirm } from "../lib/feedback";
import { fmtRelative } from "../lib/time";
import { isFuture } from "../lib/expiry";
import { ActionResult, Modal, ObserveBanner, Toggle } from "./ui";
import { fmtVipTotal } from "./EditVip";
import type { ActionPlayer } from "./PlayerActions";

interface AdminRow { playerId: string; playerName: string | null; adminGroup: string; comment: string | null; expiration: string | null }
/** What POST /servers/:id/admins answers: which servers took the grant and which refused, by name. */
interface GrantResult { applied?: { serverName: string }[]; skipped?: { serverName: string; reason: string }[] }

/** The same stacking presets Edit VIP offers, minus the community-editable list: an admin grant is
 *  usually "for this event" or "permanent", and the boxes below cover anything else. */
const PRESETS: { label: string; hours: number }[] = [
  { label: "6 hours", hours: 6 },
  { label: "1 day", hours: 24 },
  { label: "1 week", hours: 24 * 7 },
  { label: "1 month", hours: 24 * 30 },
];

export function EditConsoleAdmin({ player, serverId, onClose, onChanged }: {
  player: ActionPlayer; serverId?: string; onClose: () => void; onChanged?: () => void;
}) {
  const { server } = useServers();
  const toast = useToast();
  const confirm = useConfirm();
  const who = player.name || player.playerId;

  const [groups, setGroups] = useState<string[] | null>(null);
  const [group, setGroup] = useState("");
  const [existing, setExisting] = useState<AdminRow | null>(null);
  const [permanent, setPermanent] = useState(true);
  const [days, setDays] = useState(0);
  const [hours, setHours] = useState(0);
  const [cumulative, setCumulative] = useState(true);
  const [allServers, setAllServers] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // The server's real admin groups AND whether this player already has a grant here — the second
  // is what turns this from "grant" into "change or revoke", and staff need to see it before they
  // act rather than discovering it from the result.
  useEffect(() => {
    if (!serverId) return;
    let alive = true;
    api<{ admins: AdminRow[]; groups: string[] }>(`/servers/${serverId}/admins`)
      .then((r) => {
        if (!alive) return;
        setGroups(r.groups ?? []);
        const mine = (r.admins ?? []).find((a) => a.playerId === player.playerId) ?? null;
        setExisting(mine);
        // An existing grant keeps its group; a fresh one starts on spectator (see lib/adminGroups).
        setGroup(mine?.adminGroup || preferredAdminGroup(r.groups));
        if (mine) setPermanent(!mine.expiration);
      })
      .catch((e) => { if (alive) setErr((e as Error).message); });
    return () => { alive = false; };
  }, [serverId, player.playerId]);

  const totalHours = days * 24 + hours;
  const addPreset = (h: number) => { const t = totalHours + h; setDays(Math.floor(t / 24)); setHours(t % 24); };

  const blockedWhy = !serverId ? "Pick a server first."
    : !group ? "Choose an admin group."
    : !permanent && totalHours <= 0 ? "Add some time — tap the presets (each tap stacks) or type days/hours."
    : "";
  const blocked = blockedWhy !== "";

  async function submit() {
    if (!serverId || blocked) return;
    setBusy(true); setErr("");
    try {
      const r = await api<GrantResult>(`/servers/${serverId}/admins`, { method: "POST", body: {
        playerId: player.playerId,
        playerName: player.name ?? undefined,
        group,
        comment: comment.trim() || undefined,
        mode: permanent ? "permanent" : "duration",
        // days + hours separately, exactly as Edit VIP sends them: the same parser reads both, and
        // two grant screens posting the same shape is one less thing to check when either changes.
        ...(permanent ? {} : { days, hours, cumulative }),
        allServers,
      } });
      // Partial success is the case worth naming: "all servers" that landed on two of three reads
      // as a clean success unless the skips are said out loud. A total failure never reaches here —
      // the route answers 409 and the catch below shows it.
      const skipped = r.skipped ?? [];
      const where = allServers ? ` on ${(r.applied ?? []).length} server${(r.applied ?? []).length === 1 ? "" : "s"}` : "";
      const note = `${who} is a console admin (${group})${permanent ? "" : ` for ${fmtVipTotal(days, hours)}`}${where}`;
      if (skipped.length) toast.error(`${note} — skipped ${skipped.map((s) => `${s.serverName} (${s.reason})`).join(", ")}`);
      else toast.success(note);
      onChanged?.();
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function revoke() {
    if (!serverId) return;
    const ok = await confirm({
      title: `Remove ${who} as a console admin?`,
      body: `They lose in-game admin powers — admin camera included — ${allServers ? "on every server" : "on this server"} immediately.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setBusy(true); setErr("");
    try {
      await api(`/servers/${serverId}/admins/${encodeURIComponent(player.playerId)}${allServers ? "?allServers=1" : ""}`, { method: "DELETE" });
      toast.success(`${who} is no longer a console admin`);
      onChanged?.();
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Modal title={<>Console admin <span className="muted">· {who}</span></>} onClose={() => onClose()} busy={busy}>
      <ObserveBanner server={server} />

      <div className="pa-fields">
        <p className="hint" style={{ marginTop: 0 }}>
          The GAME&apos;s admin list — admin camera and in-game admin powers. Nothing to do with panel logins.
        </p>
        {existing && (
          <p className="hint">
            Already an admin here as <strong>{existing.adminGroup}</strong>
            {existing.expiration
              ? isFuture(existing.expiration) ? ` until ${fmtRelative(existing.expiration)}` : " (expired — the sweep will clear it)"
              : " (permanent)"}. Saving below replaces it.
          </p>
        )}

        <label>Admin group
          {groups === null
            ? <input value="" disabled placeholder="Reading the server's groups…" />
            : (
              <select value={group} onChange={(e) => setGroup(e.target.value)}>
                {!groups.length && <option value="">(the server listed none)</option>}
                {groups.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            )}
        </label>

        <Toggle checked={permanent} onChange={setPermanent} label="Permanent (no expiry)" />

        {!permanent && (
          <>
            <div>
              <span className="hint">For how long — each tap adds on:</span>
              <div className="row" role="group" aria-label="Time buttons" style={{ flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                {PRESETS.map((p) => (
                  <button key={p.label} type="button" className="mini ghost" onClick={() => addPreset(p.hours)}>+ {p.label}</button>
                ))}
                <button type="button" className="mini ghost" onClick={() => { setDays(0); setHours(0); }} disabled={totalHours <= 0}>Reset</button>
              </div>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <label style={{ maxWidth: 110 }}>Days<input type="number" min="0" value={String(days)} onChange={(e) => setDays(Math.max(0, Math.floor(Number(e.target.value) || 0)))} /></label>
              <label style={{ maxWidth: 110 }}>Hours<input type="number" min="0" value={String(hours)} onChange={(e) => setHours(Math.max(0, Math.floor(Number(e.target.value) || 0)))} /></label>
            </div>
            <p className="muted" style={{ margin: 0 }}>Total: <strong>{fmtVipTotal(days, hours)}</strong></p>
            <Toggle checked={cumulative} onChange={setCumulative} label="Stack onto existing time" />
          </>
        )}

        <label>Note <span className="muted">(staff-only; never shown in game)</span>
          <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="why they have it" />
        </label>
        <Toggle checked={allServers} onChange={setAllServers} label="Apply to all servers" />
      </div>

      <ActionResult error={err} />
      {blocked && <p className="hint">{blockedWhy}</p>}
      <div className="pa-actions">
        {existing && <button className="danger" onClick={revoke} disabled={busy}>Remove admin</button>}
        <button className="ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button onClick={submit} disabled={busy || blocked}>{busy ? "Working…" : existing ? "Save" : "Make admin"}</button>
      </div>
    </Modal>
  );
}
