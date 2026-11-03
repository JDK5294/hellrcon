"use client";
/**
 * Console admins — the GAME SERVER's own admin list: in-game powers only (admin camera, console
 * kicks, in-game admin chat), nothing to do with panel logins (those live under
 * Administration → Users & roles).
 *
 * Works exactly like VIP: the panel's stored grant is the book of record, with an expiration the
 * game itself doesn't have (the game only knows permanent admins). Granting writes the game AND
 * our row; expired grants are removed from the game automatically by the always-on worker.
 * The group choices come from the server itself (GetAdminGroups), with the game's stock groups
 * as a fallback when the box can't be asked.
 */
import { useEffect, useMemo, useState } from "react";
import { api, fmt } from "../lib/api";
import { wallToIso, zoneLabel } from "../lib/time";
import { useResource } from "../lib/resource";
import { useServers } from "../lib/servers";
import { useToast, useConfirm } from "../lib/feedback";
import { PanelGroup, Panel } from "./Panel";
import { ActionResult, AskNotice, EmptyState, ObserveBanner, SkeletonRows, Toggle } from "./ui";
import { PlayerPicker } from "./PlayerPicker";
import { PlayerLink } from "./PlayerLink";
import { expiryStatus } from "../lib/expiry";
import { useSortable, SortTh } from "../lib/sort";

interface ConsoleAdmin {
  id: string;
  serverId: string;
  playerId: string;
  playerName: string | null;
  adminGroup: string;
  comment: string | null;
  expiration: string | null; // null = permanent
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}
type Mode = "permanent" | "until" | "duration";


export function ConsoleAdmins({ canManage }: { canManage: boolean }) {
  const { serverId, server } = useServers();
  const toast = useToast();
  const confirm = useConfirm();
  const [groups, setGroups] = useState<string[]>([]);
  const sort = useSortable<ConsoleAdmin>({
    who: (a) => a.playerName ?? a.playerId,
    group: (a) => a.adminGroup,
    status: (a) => expiryStatus(a.expiration).label,
    expiration: (a) => a.expiration ?? "",
    comment: (a) => a.comment ?? "",
    by: (a) => a.createdByName,
  }, "who", "asc", "consoleadmins");
  // Load failures and grant/revoke failures share one line on screen, so they share one slot.
  const [actionErr, setActionErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // the grant form
  const [pick, setPick] = useState<{ playerId: string; name: string } | null>(null);
  const [group, setGroup] = useState("");
  const [comment, setComment] = useState("");
  const [mode, setMode] = useState<Mode>("permanent");
  const [until, setUntil] = useState("");
  const [days, setDays] = useState("30");
  const [hours, setHours] = useState("0");
  const [cumulative, setCumulative] = useState(true);
  const [allServers, setAllServers] = useState(false);

  const loader = useMemo(
    () => (serverId ? () => api<{ admins: ConsoleAdmin[]; groups: string[] }>(`/servers/${serverId}/admins`) : null),
    [serverId],
  );
  const { data: resp, error: loadErr, reload: load } = useResource(loader);
  const admins = resp?.admins ?? null;
  const err = actionErr || loadErr;
  // The group list and the default pick follow whatever the server last told us.
  useEffect(() => {
    if (!resp) return;
    // Same `?? []` on both lines: the game's admin-group list is missing until a server answers.
    const gs = resp.groups ?? [];
    setGroups(gs);
    setGroup((g) => g || gs[0] || "");
  }, [resp]);

  async function grant() {
    if (!pick?.playerId || !group || !serverId) return;
    setBusy(true); setNote(""); setActionErr("");
    const body: Record<string, unknown> = {
      playerId: pick.playerId,
      playerName: pick.name || undefined,
      group,
      comment: comment.trim() || undefined,
      mode,
      allServers,
    };
    if (mode === "until") {
      if (!until) { setBusy(false); return setActionErr("Pick an expiry date."); }
      body.expiresAt = wallToIso(until);
    } else if (mode === "duration") {
      body.days = Number(days || 0);
      body.hours = Number(hours || 0);
      body.cumulative = cumulative;
    }
    try {
      const r = await api<{ applied: { serverName: string }[]; skipped: { serverName: string; reason: string }[] }>(`/servers/${serverId}/admins`, { method: "POST", body });
      const parts = [`Granted on ${r.applied.length} server${r.applied.length === 1 ? "" : "s"}`];
      if (r.skipped.length) parts.push(`skipped ${r.skipped.map((s) => `${s.serverName} (${s.reason})`).join(", ")}`);
      setNote(parts.join(" · "));
      toast.success(`${pick.name || pick.playerId} is now a console admin (${group})`);
      setPick(null); setComment("");
      load();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }

  async function remove(a: ConsoleAdmin) {
    const ok = await confirm({
      title: `Remove ${a.playerName || a.playerId} from the console admins?`,
      body: "They lose in-game admin powers (admin camera, console commands) on this server. Their panel login, if they have one, is not affected.",
      confirmLabel: "Remove admin",
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/servers/${a.serverId}/admins/${encodeURIComponent(a.playerId)}`, { method: "DELETE" });
      toast.success(`${a.playerName || a.playerId} removed from the console admins`);
      load();
    } catch (e) { toast.error((e as Error).message); }
  }

  if (!serverId) return <div className="card"><p className="muted">Select a server to manage its console admins.</p></div>;

  return (
    <PanelGroup viewId="console-admins">
      <Panel id="admins" caps="open" title="Console admins" subtitle="the game server's own admin list — in-game powers, not panel logins"
        actions={<button className="ghost mini" onClick={load}>Refresh</button>}>
        <p className="hint mt-0">
          People on this list can use the game&apos;s built-in admin tools on {server?.name ?? "this server"} —
          admin camera, console kicks, in-game admin chat. The game only knows <em>permanent</em> admins,
          so the expiration is tracked here, exactly like VIP: expired admins are removed from the game
          automatically. Who can log into <em>the panel</em> is a separate thing, managed under
          Administration → Users &amp; roles.
        </p>
        <ObserveBanner server={server}>The stored list stays readable.</ObserveBanner>
        {canManage && <AskNotice capability="server.admins" serverId={serverId} />}
        <ActionResult error={err} />
        {note && <p className="muted">{note}</p>}
        {!admins && !err && <SkeletonRows rows={5} cols={4} />}
        {admins && admins.length === 0 && (
          <EmptyState icon="🎮" title="No console admins yet">
            A console admin holds admin rights on the game server itself — the in-game admin menu,
            not this panel. Add one above; entries can be given an expiry so temporary rights
            expire on their own.
          </EmptyState>
        )}
        {admins && admins.length > 0 && (
          <div className="scroll-x">
            <table className="table">
              {/* Action column right after the name — reachable without scrolling the wide table. */}
              <thead><tr>
                <SortTh s={sort} k="who">Who</SortTh>
                <th />
                <SortTh s={sort} k="group">Group</SortTh>
                <SortTh s={sort} k="status">Status</SortTh>
                <SortTh s={sort} k="expiration">Expiration</SortTh>
                <SortTh s={sort} k="comment">Comment</SortTh>
                <SortTh s={sort} k="by">Added by</SortTh>
              </tr></thead>
              <tbody>
                {sort.sorted(admins).map((a) => {
                  const st = expiryStatus(a.expiration);
                  return (
                    <tr key={a.id}>
                      <td><PlayerLink playerId={a.playerId} name={a.playerName || <span className="muted">{a.playerId.slice(0, 14)}…</span>} /></td>
                      <td>{canManage && <button className="danger mini" onClick={() => remove(a)}>Remove</button>}</td>
                      <td><span className="badge">{a.adminGroup || "—"}</span></td>
                      <td><span className={`badge ${st.cls}`}>{st.label}</span></td>
                      <td>{a.expiration ? fmt(a.expiration) : "—"}</td>
                      <td style={{ whiteSpace: "normal" }}>{a.comment || ""}</td>
                      <td>{a.createdByName}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {canManage && (
          <fieldset className="vip-form" style={{ marginTop: 14 }}>
            <legend>Grant / extend console admin</legend>
            <div className="vip-grid">
              {/* Not a <label> — see Vips.tsx: a label eats the click on the picker's dropdown. */}
              <div className="field"><span>Player</span><PlayerPicker value={pick} onChange={setPick} game={server?.game} placeholder="Search a player by name (or paste their id)…" /></div>
              <label>Group<select value={group} onChange={(e) => setGroup(e.target.value)}>
                {groups.length === 0 && <option value="">no groups reported</option>}
                {groups.map((g) => <option key={g} value={g}>{g}</option>)}
              </select></label>
              <label className="span2">Comment<input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="internal note — not sent to the game" /></label>
            </div>

            <div className="vip-mode">
              <div className="seg">
                {([["permanent", "Permanent"], ["until", "Until date"], ["duration", "Add duration"]] as [Mode, string][]).map(([m, label]) => (
                  <button key={m} type="button" className={`seg-btn ${mode === m ? "active" : ""}`} onClick={() => setMode(m)}>{label}</button>
                ))}
              </div>
              {mode === "until" && (
                <label className="vip-mode-input">Expires at ({zoneLabel()})<input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} /></label>
              )}
              {mode === "duration" && (
                <>
                  <label className="vip-mode-input narrow">Days<input type="number" min="0" value={days} onChange={(e) => setDays(e.target.value)} /></label>
                  <label className="vip-mode-input narrow">Hours<input type="number" min="0" value={hours} onChange={(e) => setHours(e.target.value)} /></label>
                  <Toggle checked={cumulative} onChange={setCumulative} label="Stack onto existing time" />
                </>
              )}
            </div>

            <div className="vip-footer">
              <Toggle checked={allServers} onChange={setAllServers} label="Apply to all servers" />
              <button className="primary" onClick={grant} disabled={busy || !pick?.playerId || !group}>{busy ? "Granting…" : "Make them an admin"}</button>
            </div>
            <p className="hint" style={{ marginTop: 4 }}>
              The groups come from the game server itself — what each one may do is defined by the game, not by the panel.
            </p>
          </fieldset>
        )}
      </Panel>
    </PanelGroup>
  );
}

