"use client";
/**
 * The Edit VIP popup: one place for everything VIP on a player, in three tabs —
 *   Add VIP    (vip.grant)  — grant or extend: permanent, a duration, or until an exact date
 *   Remove     (vip.revoke) — subtract a duration (the refund case, the Add calculator in
 *                             reverse), or revoke the VIP entirely — the only exit a permanent
 *                             grant has, so the popup must offer it, not point elsewhere
 *   Pause VIP  (vip.pause)  — a VIP timeout, time-runs or hours-banked, with early resume
 * All three are open to EVERYONE: lacking the tab's permission turns the confirm into "Send for
 * approval" — the same form files the change as an approval request instead of applying it,
 * because lacking the permission IS the ask.
 *
 * The duration preset buttons are a CALCULATOR: every click ADDS the preset's time to the running
 * total (1 day ×2 + 1 week ×2 = 2 weeks 2 days), applied on confirm. The button set is community-
 * editable under Administration → VIP presets; the days/hours boxes stay editable for anything the
 * buttons don't cover. Remove shares the Add presets on purpose — a refund undoes a grant, so it
 * speaks in the same units the grant was made in.
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useServers } from "../lib/servers";
import { useRequestMode } from "../lib/requestMode";
import { useToast, useConfirm } from "../lib/feedback";
import { TemplatePicker } from "./TemplatePicker";
import { fmtRelative, wallToIso, zoneLabel } from "../lib/time";
import { isFuture } from "../lib/expiry";
import { ActionResult, Modal, ObserveBanner, Toggle } from "./ui";
import type { ActionPlayer } from "./PlayerActions";

interface VipPreset { id: string; kind: "add" | "pause"; label: string; days: number; hours: number; sortOrder: number }

/** "2 weeks, 2 days, 3 hours" — the running total, in the units staff think in. */
export function fmtVipTotal(days: number, hours: number): string {
  const totalH = days * 24 + hours;
  if (totalH <= 0) return "nothing yet";
  const weeks = Math.floor(totalH / (7 * 24));
  const d = Math.floor((totalH - weeks * 7 * 24) / 24);
  const h = totalH % 24;
  const parts: string[] = [];
  if (weeks) parts.push(`${weeks} week${weeks === 1 ? "" : "s"}`);
  if (d) parts.push(`${d} day${d === 1 ? "" : "s"}`);
  if (h) parts.push(`${h} hour${h === 1 ? "" : "s"}`);
  return parts.join(", ");
}

type Tab = "add" | "remove" | "pause";

export function EditVip({ player, serverId, canAdd, canRemove, canPause, onClose, onChanged }: {
  player: ActionPlayer; serverId?: string; canAdd: boolean; canRemove: boolean; canPause: boolean;
  onClose: () => void; onChanged?: () => void;
}) {
  const { server } = useServers();
  const requestMode = useRequestMode();
  const toast = useToast();
  const confirm = useConfirm();
  const who = player.name || player.playerId;
  // Land on the tab the opener most likely came for: Add when they hold it (or hold nothing —
  // the ask path), otherwise the strongest tab they DO hold.
  const [tab, setTab] = useState<Tab>(canAdd || (!canRemove && !canPause) ? "add" : canRemove ? "remove" : "pause");
  const [presets, setPresets] = useState<VipPreset[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // The calculator. Preset clicks accumulate here; the boxes stay directly editable.
  const [days, setDays] = useState(0);
  const [hours, setHours] = useState(0);

  // Add tab
  const [permanent, setPermanent] = useState(false);
  const [cumulative, setCumulative] = useState(true);
  const [allServersAdd, setAllServersAdd] = useState(false);
  // The internal note the VIPs tab has always offered ("group: ABC CVC", "donor"), required on
  // every VIP added — the API refuses one without it: who paid, what for, or which event.
  const [comment, setComment] = useState("");
  // "…or until an exact date" — a wall-clock datetime in the display zone. When set it wins
  // over the calculator: the grant ends at that moment, whatever the boxes say.
  const [until, setUntil] = useState("");
  // Remove tab. `wipe` flips the tab from "subtract a duration" to "revoke the whole grant" —
  // the route is different (DELETE, the same one the VIP list's Revoke button calls), and it is
  // what a permanent grant needs, since permanence leaves no time for the calculator to subtract.
  const [allServersRemove, setAllServersRemove] = useState(false);
  const [wipe, setWipe] = useState(false);
  // Pause tab (all-servers default: a timeout is a punishment, and punishments don't stop at one server)
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<"running" | "banked">("running");
  const [allServersPause, setAllServersPause] = useState(true);

  useEffect(() => {
    api<{ presets: VipPreset[] }>("/vip-presets").then((r) => setPresets(r.presets)).catch((e) => setErr((e as Error).message));
  }, []);

  function addPreset(p: VipPreset) {
    const h = hours + p.hours;
    setDays(days + p.days + Math.floor(h / 24));
    setHours(h % 24);
  }
  function switchTab(t: Tab) {
    if (t === tab) return;
    setTab(t); setErr(""); setDays(0); setHours(0); setUntil(""); setWipe(false); setComment("");
  }

  const totalHours = days * 24 + hours;
  const vipPausedNow = isFuture(player.vipPausedUntil);
  const untilPast = until !== "" && !isFuture(wallToIso(until));

  const blockedWhy =
    tab === "add"
      ? !serverId ? "Pick a server first (top of the page)."
        : !permanent && untilPast ? "That date is already in the past — pick a future one."
        : !permanent && until === "" && totalHours <= 0 ? "Add some time — tap the presets (each tap stacks) or type days/hours — or pick an end date."
        : !comment.trim() ? "Type a comment — every VIP added needs one: who paid, what for, or which event."
        : ""
      : tab === "remove"
        ? !serverId ? "Pick a server first (top of the page)."
          : !wipe && totalHours <= 0 ? "Add the time to take back — tap the presets (each tap stacks) or type days/hours."
          : ""
        : !player.dbId ? "No profile for this player yet — they appear after their first session."
          : !reason.trim() ? "Type a reason — it lands in their moderation history like a ban."
          : totalHours <= 0 ? "Add some time — tap the presets (each tap stacks) or type days/hours."
          : totalHours > 24 * 365 ? "A pause runs at most a year — revoke the VIP instead."
          : "";
  const blocked = blockedWhy !== "";

  async function submit() {
    setBusy(true); setErr("");
    try {
      if (tab === "add") {
        const useUntil = !permanent && until !== "";
        const capturing = requestMode.building;
        const r = await api<{ captured?: boolean; lines?: number; requested?: boolean; applied?: { serverName: string }[]; skipped?: { serverName: string; reason: string }[] }>(`/servers/${serverId}/vips`, { method: "POST", raw202: true, body: {
          playerId: player.playerId, playerName: player.name,
          comment: comment.trim(),
          mode: permanent ? "permanent" : useUntil ? "until" : "duration",
          ...(permanent ? {} : useUntil ? { expiresAt: wallToIso(until) } : { days, hours, cumulative }),
          allServers: capturing ? false : allServersAdd,
          ...(capturing ? { draft: true } : {}),
        } });
        if (r.captured) {
          requestMode.captured(r.lines ?? requestMode.count + 1);
          toast.success(`Added to request — VIP for ${who} (${r.lines ?? "?"} captured)`);
        } else if (r.requested) {
          toast.success(`Sent for approval — VIP for ${who} waits for a signature (Moderation → Requests)`);
        } else {
          // The route answers 200 with the servers it LANDED on and the ones it skipped (the game
          // did not answer, observe mode, an id the other game cannot use). A grant that landed
          // nowhere used to toast as a success — no VIP, no history entry, and staff believing
          // they had given it. Nothing landed is an error; a partial landing names the misses.
          const skipped = r.skipped ?? [];
          const why = skipped.map((k) => `${k.serverName}: ${k.reason}`).join("; ");
          if (r.applied && r.applied.length === 0) throw new Error(`VIP was NOT granted — ${why || "no server took it"}`);
          const what = `VIP ${permanent ? "granted permanently" : useUntil ? `until ${until.replace("T", " ")}` : `+${fmtVipTotal(days, hours)}`} — ${who}`;
          if (skipped.length) toast.error(`${what}, but not on ${why}`);
          else toast.success(what);
        }
      } else if (tab === "remove" && wipe) {
        // The full revoke — the same DELETE the VIP list's Revoke button calls, so it carries the
        // same ask/capture behaviour: without the write here it files an approval request.
        const capturing = requestMode.building;
        const q = new URLSearchParams();
        if (!capturing && allServersRemove) q.set("allServers", "1");
        if (capturing) q.set("draft", "1");
        const qs = q.toString();
        const r = await api<{ captured?: boolean; lines?: number; requested?: boolean; applied?: string[]; skipped?: { serverName: string }[]; held?: { serverName: string; heldBy: string }[] }>(
          `/servers/${serverId}/vips/${encodeURIComponent(player.playerId)}${qs ? `?${qs}` : ""}`, { method: "DELETE", raw202: true });
        if (r.captured) {
          requestMode.captured(r.lines ?? requestMode.count + 1);
          toast.success(`Added to request — revoke VIP from ${who} (${r.lines ?? "?"} captured)`);
        } else if (r.requested) {
          toast.success(`Sent for approval — revoking ${who}'s VIP waits for a signature (Moderation → Requests)`);
        } else {
          const skips = r.skipped?.length ? ` (${r.skipped.length} server(s) skipped)` : "";
          // Where a group perk holds the grant, only the VIP of their own beneath it went.
          const held = r.held ?? [];
          const outright = (r.applied?.length ?? 0) - held.length;
          toast.success(held.length
            ? `Revoked ${who}'s own VIP on ${held.map((h) => h.serverName).join(", ")} — ${held[0]!.heldBy} stays while they are listed${outright > 0 ? `; revoked outright on ${outright} other server(s)` : ""}${skips}`
            : `VIP revoked — ${who}${skips}`);
        }
      } else if (tab === "remove") {
        const r = await api<{ applied: { removed: boolean; held?: { bankedMs: number } }[] }>(`/servers/${serverId}/vips/reduce`, { method: "POST", body: {
          playerId: player.playerId, days, hours, allServers: allServersRemove,
        } });
        const ended = r.applied.some((a) => a.removed);
        const underHold = r.applied.some((a) => a.held);
        toast.success(`VIP −${fmtVipTotal(days, hours)} — ${who}${ended ? " (grant used up — VIP removed)" : ""}${underHold ? " (taken from the VIP they get back on leaving their group — the group's VIP stays)" : ""}`);
      } else {
        await api(`/players/${player.dbId}/vip/pause`, { method: "POST", body: {
          hours: totalHours, reason: reason.trim(), mode,
          // An asker's timeout is asked for on this server — the all-servers tick is the holder's.
          ...(allServersPause && canPause ? {} : { serverId }),
        } });
        toast.success(`VIP paused ${fmtVipTotal(days, hours)} (${mode === "banked" ? "hours banked" : "time keeps running"}) — ${who}`);
      }
      onChanged?.();
      onClose();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function resume() {
    const ok = await confirm({
      title: `Resume VIP — ${who}?`,
      body: "Their VIP goes back on the game immediately (if the grant is still valid); banked time is added back onto the expiry.",
      confirmLabel: "Resume VIP",
    });
    if (!ok) return;
    setBusy(true); setErr("");
    try {
      await api(`/players/${player.dbId}/vip/resume`, { method: "POST" });
      toast.success(`VIP resumed for ${who}`);
      onChanged?.();
      onClose();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  // Remove shares the Add presets: a refund is a grant undone, so it uses the grant's own units.
  const tabPresets = (presets ?? []).filter((p) => p.kind === (tab === "remove" ? "add" : tab));

  return (
    <Modal title={<>Edit VIP <span className="muted">· {who}</span></>} onClose={() => onClose()} busy={busy}>
      <ObserveBanner server={server} />
      {/* Every tab is on offer: without its permission the confirm files a request instead. */}
      <div className="seg" role="group" aria-label="What to change" style={{ marginBottom: 10 }}>
        <button type="button" className={`seg-btn ${tab === "add" ? "active" : ""}`} onClick={() => switchTab("add")}>Add VIP</button>
        <button type="button" className={`seg-btn ${tab === "remove" ? "active" : ""}`} onClick={() => switchTab("remove")}>Remove time</button>
        <button type="button" className={`seg-btn ${tab === "pause" ? "active" : ""}`} onClick={() => switchTab("pause")}>Pause VIP</button>
      </div>

      <div className="pa-fields">
        {tab === "pause" && vipPausedNow && (
          <p className="hint">
            Already paused {fmtRelative(player.vipPausedUntil!)}
            {player.vipPauseMode === "banked" ? " · hours banked" : " · time keeps running"}
            {player.vipPauseReason ? ` — ${player.vipPauseReason}` : ""}.
            A new pause below replaces it.
          </p>
        )}
        {tab === "pause" && vipPausedNow && (
          <button type="button" className="ghost" onClick={resume} disabled={busy || !player.dbId}>▶ Resume VIP now</button>
        )}

        {tab === "pause" && (
          <label>Reason<input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
            <TemplatePicker kind="reason" onPick={(r) => setReason(r)} />
          </label>
        )}

        {tab === "add" && (
          <Toggle checked={permanent} onChange={setPermanent} label="Permanent VIP (no expiry)" />
        )}
        {tab === "add" && (
          <label>Comment (required)<input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="who paid, what for, or which event — not sent to the game" /></label>
        )}

        {tab === "remove" && (
          <div className="seg" role="group" aria-label="How much to take back">
            <button type="button" className={`seg-btn ${wipe ? "" : "active"}`} onClick={() => setWipe(false)} title="Subtract a duration from their expiry — the refund case.">Remove some time</button>
            <button type="button" className={`seg-btn ${wipe ? "active" : ""}`} onClick={() => setWipe(true)} title="Take their VIP away completely — the whole grant, permanent ones included.">Revoke entirely</button>
          </div>
        )}

        {(tab === "pause" || (tab === "add" && !permanent) || (tab === "remove" && !wipe)) && (
          <>
            <div>
              <span className="hint">{tab === "remove" ? "Time to take back — each tap adds on (tap “1 day” twice for 2 days):" : "Duration — each tap adds on (tap “1 day” twice for 2 days):"}</span>
              <div className="row" role="group" aria-label="Time buttons" style={{ flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                {presets && tabPresets.map((p) => (
                  <button key={p.id} type="button" className="mini ghost" onClick={() => addPreset(p)}>+ {p.label}</button>
                ))}
                {presets && !tabPresets.length && <span className="muted">No presets yet — add some under Administration → VIP presets.</span>}
                <button type="button" className="mini ghost" onClick={() => { setDays(0); setHours(0); }} disabled={totalHours <= 0}>Reset</button>
              </div>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <label style={{ maxWidth: 110 }}>Days<input type="number" min="0" value={String(days)} onChange={(e) => setDays(Math.max(0, Math.floor(Number(e.target.value) || 0)))} /></label>
              <label style={{ maxWidth: 110 }}>Hours<input type="number" min="0" value={String(hours)} onChange={(e) => setHours(Math.max(0, Math.floor(Number(e.target.value) || 0)))} /></label>
            </div>
            <p className="muted" style={{ margin: 0 }}>{tab === "remove" ? "Removing" : "Total"}: <strong>{fmtVipTotal(days, hours)}</strong></p>
          </>
        )}

        {tab === "add" && !permanent && (
          <label>…or until an exact date ({zoneLabel()})
            <input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
            {until !== "" && <span className="hint">Their VIP ends at this date — the calculator above is ignored.</span>}
          </label>
        )}
        {tab === "remove" && !wipe && (
          <p className="hint notice" style={{ margin: 0 }}>Counts down from their current expiry — no date math needed. If this takes back more time than remains, their VIP ends now. Permanent VIP has no time to subtract — switch to “Revoke entirely”. Where a group perk holds their VIP, the time comes off what they get back on leaving the group.</p>
        )}
        {tab === "remove" && wipe && (
          <p className="hint notice" style={{ margin: 0 }}>Their VIP comes off the game now and the grant is deleted — permanent or not. This is the end of the grant, not a timeout; for a temporary punishment use Pause VIP. Where a group perk holds their VIP, only the VIP of their own beneath it goes — the group&apos;s stays while they are listed.</p>
        )}

        {tab === "add" && !permanent && until === "" && (
          <Toggle checked={cumulative} onChange={setCumulative} label="Stack onto existing time" />
        )}
        {/* All-servers only for holders of the write: an approval request covers ONE server, so an
            asker's change is asked for on this one. */}
        {tab === "add" && canAdd && (
          <Toggle checked={allServersAdd} onChange={setAllServersAdd} label="Apply to all servers" />
        )}
        {tab === "add" && !canAdd && !requestMode.building && (
          <p className="hint notice" style={{ margin: 0 }}>You don't hold the VIP permission here — confirming sends this grant for approval, and it lands only once someone signs it.</p>
        )}
        {tab === "remove" && canRemove && (
          <Toggle checked={allServersRemove} onChange={setAllServersRemove} label="Remove on all servers" />
        )}
        {tab === "remove" && !canRemove && !requestMode.building && (
          <p className="hint notice" style={{ margin: 0 }}>You don't hold the VIP revoke permission here — confirming sends this for approval, and nothing changes until someone signs it.</p>
        )}
        {tab === "pause" && (
          <>
            <div className="seg" role="group" aria-label="While paused">
              <button type="button" className={`seg-btn ${mode === "running" ? "active" : ""}`} onClick={() => setMode("running")} title="The expiration keeps ticking — the lost time is the punishment.">Time runs</button>
              <button type="button" className={`seg-btn ${mode === "banked" ? "active" : ""}`} onClick={() => setMode("banked")} title="The meter freezes; the paused time is added back when the pause ends.">Bank the hours</button>
            </div>
            {canPause && <Toggle checked={allServersPause} onChange={setAllServersPause} label="Pause on all servers" />}
            {!canPause && !requestMode.building && (
              <p className="hint notice" style={{ margin: 0 }}>You don't hold the VIP timeout permission here — confirming sends this for approval, and nothing changes until someone signs it.</p>
            )}
          </>
        )}
      </div>

      <ActionResult error={err} />
      {blocked && <p className="hint">{blockedWhy}</p>}
      <div className="pa-actions">
        <button className="ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button className={tab === "add" ? "" : "danger"} onClick={submit} disabled={busy || blocked}>
          {busy ? "Working…"
            : requestMode.building ? "Add to request"
            : tab === "add" ? (canAdd ? "Grant VIP" : "Send for approval")
            : tab === "remove" ? (!canRemove ? "Send for approval" : wipe ? "Revoke VIP" : "Remove time")
            : canPause ? "Pause VIP" : "Send for approval"}
        </button>
      </div>
    </Modal>
  );
}
