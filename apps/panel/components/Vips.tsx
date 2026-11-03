"use client";
import { useMemo, useState } from "react";
import { api, fmt, wasFiled } from "../lib/api";
import { wallToIso, zoneLabel } from "../lib/time";
import { useResource } from "../lib/resource";
import { useAlert, useConfirm } from "../lib/feedback";
import { useServers } from "../lib/servers";
import { useAppNav } from "../lib/nav";
import { ActionResult, AskNotice, EmptyState, NoServersNote, ObserveBanner, Pager, SearchInput, SkeletonRows, Toggle, Explanation } from "./ui";
import { PanelGroup, Panel } from "./Panel";
import { PlayerPicker } from "./PlayerPicker";
import { PlayerLink } from "./PlayerLink";
import { recordRecent } from "../lib/recent";
import { expiryStatus, isFuture } from "../lib/expiry";
import { useSortable, SortTh } from "../lib/sort";
import { useClientPages } from "../lib/paged";
import { isText, useRemembered } from "../lib/remembered";
import { describeSpanMs } from "../lib/vipSpan";
import { fileStem, type Sheet } from "../lib/download";
import { DownloadButton } from "./Download";
import { UploadButton, type UploadResult } from "./Upload";
import { planVips, type PlanRow, type VipLine } from "../lib/uploadPlans";
import { canOnServer } from "../lib/access";
import { useGrants } from "../lib/grants";

interface Vip {
  id: string;
  serverId: string;
  playerId: string;
  playerName: string | null;
  comment: string | null;
  expiration: string | null; // null = permanent
  /** VIP timeout: set while the grant is paused as a punishment (expiry keeps running). */
  pausedUntil: string | null;
  pauseReason: string | null;
  pausedBy: string | null;
  pauseMode: "running" | "banked" | null;
  /** When the timeout began — a banked one froze the time left at this instant. */
  pausedAt: string | null;
  /** Permanent because a group perk holds it: the groups, and the timed VIP frozen beneath it
   *  (returned, plus the severance, when they leave). Null for every other grant. */
  groupHold?: { since: string; bankedMs: number; groups: { id: string; name: string; severanceMinutes: number }[] } | null;
  /** The VIP-perk groups covering this server that list the player — set for every member; what
   *  the page uses it for is a permanent of their own, which a perk never takes over. */
  perkGroups?: { id: string; name: string }[];
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}
type Mode = "permanent" | "until" | "duration";

/** One damaged paid grant, as /api/vips/integrity reports it — see vip-integrity.ts. */
interface IntegrityFinding {
  serverId: string;
  serverName: string | null;
  playerId: string;
  playerName: string | null;
  verdict: "lost" | "downgraded" | "shortened";
  permanentSince: string;
  grantedBy: string;
  currentExpiration: string | null;
  /** for "shortened": dated milliseconds automation took — what the add-back stacks on. */
  lostMs?: number;
  evidence: string[];
}

/** Milliseconds → "3d 4h", hours rounded UP so an add-back can never short the player. */
function lostLabel(ms: number): string {
  const totalH = Math.ceil(ms / 3_600_000);
  const d = Math.floor(totalH / 24), h = totalH % 24;
  return [d ? `${d}d` : "", h ? `${h}h` : ""].filter(Boolean).join(" ") || "0h";
}

export default function Vips() {
  const confirm = useConfirm();
  // A row's button says why it failed in a dialog: the page's error line sits at the top, a screen
  // or more above the row on a long list — on a phone the reason was simply missed.
  const alert = useAlert();
  const { serverId, server, servers } = useServers();
  const nav = useAppNav();
  const grants = useGrants();
  const mayGrant = Boolean(serverId && canOnServer(grants, "vip.grant", serverId));
  const [uploadNote, setUploadNote] = useState("");
  // Kept for the sitting, like every list's search: a profile opened from a row comes back to it.
  const [q, setQ] = useRemembered("vips.search", "", isText, "session");
  // The load failure and any grant or sync failure share one line on screen, so they share one slot.
  const [actionError, setActionError] = useState("");
  const [note, setNote] = useState("");

  // add form
  const [playerId, setPlayerId] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [comment, setComment] = useState("");
  const [mode, setMode] = useState<Mode>("permanent");
  const [until, setUntil] = useState("");
  const [days, setDays] = useState("30");
  const [hours, setHours] = useState("0");
  const [cumulative, setCumulative] = useState(true);
  const [allServers, setAllServers] = useState(false);
  const [busy, setBusy] = useState(false);

  // Paid-VIP integrity scan: run on demand, never automatically — it reads the whole VIP audit
  // slice, and its findings are a work list someone sits down with, not a live gauge.
  const [scan, setScan] = useState<{ findings: IntegrityFinding[]; scanned: number } | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState("");
  const [restored, setRestored] = useState<Set<string>>(new Set());
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const runScan = async () => {
    setScanBusy(true); setScanError(""); setRestored(new Set()); setIgnored(new Set());
    try { setScan(await api<{ findings: IntegrityFinding[]; scanned: number }>("/vips/integrity")); }
    catch (err) { setScanError((err as Error).message); }
    finally { setScanBusy(false); }
  };
  const restore = async (f: IntegrityFinding) => {
    const addBack = f.verdict === "shortened";
    // Hours rounded UP: a rounding error must favour the player whose time was taken.
    const totalH = addBack ? Math.ceil((f.lostMs ?? 0) / 3_600_000) : 0;
    const ok = await confirm({
      title: addBack
        ? `Add ${lostLabel(f.lostMs ?? 0)} back for ${f.playerName || f.playerId}?`
        : `Restore permanent VIP for ${f.playerName || f.playerId}?`,
      body: addBack
        ? <p>On <b>{f.serverName || "this server"}</b> — stacks the taken time onto whatever stands today
            (or onto now, if the grant already lapsed), same as any cumulative grant.</p>
        : <p>On <b>{f.serverName || "this server"}</b> — re-grants exactly what <b>{f.grantedBy}</b> gave, and the store now refuses any automated write that would date it again.</p>,
      confirmLabel: addBack ? "Add it back" : "Restore",
    });
    if (!ok) return;
    setScanError("");
    try {
      await api(`/servers/${f.serverId}/vips`, {
        method: "POST",
        body: addBack
          ? { playerId: f.playerId, playerName: f.playerName, mode: "duration", days: Math.floor(totalH / 24), hours: totalH % 24, cumulative: true, comment: "time added back — VIP integrity scan" }
          : { playerId: f.playerId, playerName: f.playerName, mode: "permanent", comment: "restored — VIP integrity scan" },
      });
      setRestored((prev) => new Set(prev).add(`${f.serverId}|${f.playerId}`));
    } catch (err) {
      if (wasFiled(err)) setScanError(err.message);
      else void alert({ title: addBack ? `Couldn't add the time back for ${f.playerName || f.playerId}` : `Couldn't restore ${f.playerName || f.playerId}'s permanent VIP`, body: (err as Error).message });
    }
  };

  const ignore = async (f: IntegrityFinding) => {
    const ok = await confirm({
      title: `Dismiss this finding for ${f.playerName || f.playerId}?`,
      body: <p>Marks the removal as <b>intentional</b> — it stops appearing in scans, recorded under
        your name in the staff activity. If automation takes anything from this player <em>after</em>
        today, that is a new story and will surface again.</p>,
      confirmLabel: "Dismiss — it was intentional",
    });
    if (!ok) return;
    setScanError("");
    try {
      await api("/vips/integrity/ignore", { method: "POST", body: { serverId: f.serverId, playerId: f.playerId, playerName: f.playerName } });
      setIgnored((prev) => new Set(prev).add(`${f.serverId}|${f.playerId}`));
    } catch (err) {
      if (wasFiled(err)) setScanError(err.message);
      else void alert({ title: `Couldn't dismiss the finding for ${f.playerName || f.playerId}`, body: (err as Error).message });
    }
  };

  const loader = useMemo(
    () => (serverId ? () => api<{ vips: Vip[] }>(`/servers/${serverId}/vips`).then((r) => r.vips) : null),
    [serverId],
  );
  const { data: vips, error: loadError, reload: load } = useResource(loader);
  const error = actionError || loadError;

  async function grant() {
    if (!playerId.trim() || !serverId) return;
    setBusy(true); setNote(""); setActionError("");
    const body: Record<string, unknown> = {
      playerId: playerId.trim(),
      playerName: playerName.trim() || undefined,
      comment: comment.trim(),
      mode,
      allServers,
    };
    if (mode === "until") {
      if (!until) { setBusy(false); return setActionError("Pick an expiry date."); }
      body.expiresAt = wallToIso(until);
    } else if (mode === "duration") {
      body.days = Number(days || 0);
      body.hours = Number(hours || 0);
      body.cumulative = cumulative;
    }
    try {
      const r = await api<{ applied: { serverName: string; expiration: string | null; note?: string }[]; skipped: { serverName: string; reason: string }[] }>(`/servers/${serverId}/vips`, { method: "POST", body });
      const parts = [`Granted on ${r.applied.length} server${r.applied.length === 1 ? "" : "s"}`];
      // A member a group perk holds: the time went into what they get back on leaving, not onto
      // the (permanent) grant — say so, or "granted" reads as if nothing happened.
      for (const a of r.applied) if (a.note) parts.push(`${a.serverName}: ${a.note}`);
      if (r.skipped.length) parts.push(`skipped ${r.skipped.map((s) => `${s.serverName} (${s.reason})`).join(", ")}`);
      setNote(parts.join(" · "));
      if (r.applied.length) recordRecent({ kind: "vip", label: playerName.trim() || playerId.trim(), sub: `VIP · ${mode}`, view: "vips", target: { playerId: playerId.trim(), serverId } });
      setPlayerId(""); setPlayerName(""); setComment("");
      load();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const [syncing, setSyncing] = useState(false);
  /**
   * Compare our grants against the game's OWN VIP list, then repair with the plan on screen.
   *
   * Two calls on purpose: the first is a pure read that says what is wrong ("game lists 0 of your
   * 43 grants"), and the confirm shows those numbers before anything is written. The incident this
   * exists for is invisible from this page otherwise — the table looks perfect while the game
   * grants nobody priority.
   */
  async function syncWithGame() {
    if (!serverId) return;
    setSyncing(true); setNote(""); setActionError("");
    try {
      const plan = await api<{ onGame: number; grants: number; apply: { playerId: string }[]; remove: { playerId: string; why: string }[]; foreign: { playerId: string }[] }>(
        `/servers/${serverId}/vips/reconcile`, { method: "POST", body: {} });
      const nothing = !plan.apply.length && !plan.remove.length;
      if (nothing) {
        setNote(`In sync: the game lists ${plan.onGame} VIP(s) matching your grants${plan.foreign.length ? ` (+${plan.foreign.length} added outside the panel, left alone)` : ""}.`);
        return;
      }
      const ok = await confirm({
        title: `Sync the game's VIP list?`,
        body: <p>The game lists <b>{plan.onGame}</b> VIP(s); this panel holds <b>{plan.grants}</b> grant(s).
          This will restore <b>{plan.apply.length}</b> missing VIP(s){plan.remove.length ? <> and remove <b>{plan.remove.length}</b> expired/paused entr{plan.remove.length === 1 ? "y" : "ies"}</> : null}
          {plan.foreign.length ? <>. {plan.foreign.length} entr{plan.foreign.length === 1 ? "y" : "ies"} granted outside the panel will not be touched</> : null}.</p>,
        confirmLabel: "Sync now",
      });
      if (!ok) return;
      const r = await api<{ restored: string[]; removed: string[]; skipped: { playerId: string; reason: string }[]; before: number; after: number | null; warning?: string }>(
        `/servers/${serverId}/vips/reconcile`, { method: "POST", body: { apply: true } });
      const parts = [`Restored ${r.restored.length}, removed ${r.removed.length} — game list ${r.before} → ${r.after ?? "?"}`];
      if (r.skipped.length) parts.push(`skipped ${r.skipped.length}: ${r.skipped.slice(0, 3).map((s) => s.reason).join("; ")}${r.skipped.length > 3 ? "…" : ""}`);
      if (r.warning) parts.push(r.warning);
      setNote(parts.join(" · "));
      load();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  async function revoke(v: Vip) {
    const who = v.playerName || v.playerId;
    const hold = v.groupHold;
    // Under a group perk's hold a revoke takes the VIP of their own frozen beneath it; the group's
    // stays while they are listed. With nothing of their own there, there is nothing to take — the
    // API refuses that too, and saying why here beats a confirm that ends in an error.
    if (hold && hold.bankedMs <= 0) {
      void alert({ title: `Can't revoke ${who}'s VIP`, body: `It comes from group ${heldGroups(hold)} alone — there is no VIP of their own beneath it to revoke. Remove them from the group (Groups page) to end it.` });
      return;
    }
    // A member whose permanent is their own: the revoke ends that permanent, and their group's perk
    // takes over at its next check (about a minute), as it does for any member with no VIP.
    const own = ownUnderGroup(v);
    const ok = await confirm(hold
      ? {
          title: `Revoke ${who}'s own VIP?`,
          body: <p>They keep VIP from group {heldGroups(hold)} while they are on its list. This removes the <b>{describeSpanMs(hold.bankedMs)}</b> of their own VIP frozen beneath it — what they would get back on leaving the group. To end their VIP entirely, also remove them from the group (Groups page).</p>,
          confirmLabel: "Revoke their own VIP", danger: true,
        }
      : own
        ? {
            title: `Revoke ${who}'s own permanent VIP?`,
            body: <p>They are in group {heldGroups({ groups: v.perkGroups ?? [] })}, whose perk gives them VIP while they are on its list — it takes over at its next check, about a minute. This ends the permanent VIP of their own, so leaving the group would then end their VIP too.</p>,
            confirmLabel: "Revoke their own VIP", danger: true,
          }
        : { title: `Revoke VIP from ${who}?`, confirmLabel: "Remove", danger: true });
    if (!ok) return;
    setNote("Revoking…"); setActionError("");
    try {
      await api(`/servers/${v.serverId}/vips/${encodeURIComponent(v.playerId)}`, { method: "DELETE" });
      setNote(hold
        ? `Revoked ${who}'s own VIP (${describeSpanMs(hold.bankedMs)}). They keep VIP from group ${heldGroups(hold)} while they are listed.`
        : own
          ? `Revoked ${who}'s own permanent VIP. Group ${heldGroups({ groups: v.perkGroups ?? [] })} gives them VIP at its next check while they are listed.`
          : `Revoked VIP from ${who}.`);
      load();
    } catch (e) {
      // Clear the progress note as well as raising the reason: "Revoking…" left sitting under
      // "Sent for approval" (or under any failure) says the opposite of what happened. Filed for
      // approval comes through here too (lib/api), and is news rather than a failure: it keeps the
      // page's line.
      setNote("");
      if (wasFiled(e)) setActionError(e.message);
      else void alert({ title: `Couldn't revoke ${who}'s VIP`, body: (e as Error).message });
    }
  }

  const sort = useSortable<Vip>({
    player: (v) => v.playerName ?? v.playerId,
    // Permanent VIPs sort as "never expires" — furthest future, not blank.
    status: (v) => (v.expiration ? Date.parse(v.expiration) : Number.MAX_SAFE_INTEGER),
    expiration: (v) => (v.expiration ? Date.parse(v.expiration) : Number.MAX_SAFE_INTEGER),
    comment: (v) => v.comment ?? "",
    by: (v) => v.createdByName,
  }, "player", "asc", "vips");
  // A player's name or id, and nothing else. It read each grant's comment too, and a name that
  // staff write in comments (who sold it, who it is for) brought up a hundred rows besides the
  // player's own — on a phone, with the Comment column off the screen, none saying why.
  const needle = q.trim().toLowerCase();
  const filtered = useMemo(() => (vips ?? []).filter((v) => {
    if (!needle) return true;
    return (v.playerName || "").toLowerCase().includes(needle) || v.playerId.toLowerCase().includes(needle);
  }), [vips, needle]);
  // A page of the list at a time, in the order chosen: the search and the sort run over every VIP
  // first, so the first page of "expiring soonest" is the soonest on the server, not of a page.
  const ordered = useMemo(() => sort.sorted(filtered), [sort, filtered]);
  const pages = useClientPages(vips ? ordered : null, "vips.list", serverId, `${needle}\n${sort.key}:${sort.dir}`);

  return (
    <PanelGroup viewId="vips">
      <Panel id="grant" caps="vip.grant" title="Grant / extend VIP" subtitle={server ? server.name : undefined}>
      <Explanation>
        VIP expiry is tracked here (the game has none) — permanent, until a date, or a duration.
        Expired VIPs are removed from the game automatically.
      </Explanation>
      <AskNotice capability="vip.grant" serverId={serverId} />
      {!servers.length && <NoServersNote>VIP entries are kept here, but syncing them to a game server needs one connected.</NoServersNote>}
      <ObserveBanner server={server} />
      <ActionResult error={error} />
      {note && <p className="muted">{note}</p>}

      <fieldset className="vip-form">
        <legend>Grant / extend VIP</legend>
        <div className="vip-grid">
          {/* A <div>, not a <label>: a label forwards clicks on everything inside it to the
              control it labels, and that swallowed the click on the picker's own dropdown — so
              choosing a player did nothing at all. */}
          <div className="field"><span>Player</span><PlayerPicker
            value={playerId ? { playerId, name: playerName } : null}
            onChange={(p) => { setPlayerId(p?.playerId ?? ""); setPlayerName(p?.name ?? ""); }}
            game={server?.game}
            placeholder="Search a player, or paste an id…" /></div>
          <label>Player name (optional)<input value={playerName} onChange={(e) => setPlayerName(e.target.value)} placeholder="shown in-game (looked up if blank)" /></label>
          <label className="span2">Comment (required)<input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="who paid, what for, or which event — not sent to the game" /></label>
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
          <button className="primary" onClick={grant} disabled={busy || !playerId.trim() || !serverId || !comment.trim()}>{busy ? "Granting…" : "Grant VIP"}</button>
        </div>
        {playerId.trim() && !comment.trim() && <p className="hint">Type a comment — every VIP added needs one: who paid, what for, or which event.</p>}
      </fieldset>
      </Panel>

      <Panel
        id="current"
        caps="open"
        title="Current VIPs"
        subtitle={vips ? (q.trim() ? `${filtered.length.toLocaleString()} of ${vips.length.toLocaleString()}` : vips.length.toLocaleString()) : undefined}
        actions={<>
          <SearchInput value={q} onChange={setQ} placeholder="Search name or ID…" />
          <button className="mini ghost" onClick={load}>Refresh</button>
          <button className="mini ghost" onClick={syncWithGame} disabled={syncing || !serverId}>{syncing ? "Syncing…" : "Sync with game"}</button>
          <DownloadButton file={fileStem("vips", server?.name)} title="Download the VIP list" count={filtered.length} noun="VIP"
            scope="as the list stands — its search and order" sheet={() => vipSheet(ordered, server?.name ?? "")} />
          {mayGrant && serverId && (
            <UploadButton title="Upload a VIP list" onDone={load}
              intro={`Into ${server?.name ?? "this server"}. VIP is only ever added or made longer — never shortened or taken away.`}
              plan={async (t) => planVips(t, (await api<{ vips: Vip[] }>(`/servers/${serverId}/vips`)).vips)}
              fields={<label>A note for each player&apos;s VIP history<input value={uploadNote} onChange={(e) => setUploadNote(e.target.value)} placeholder="e.g. restored after the wipe" /></label>}
              blocked={() => (uploadNote.trim() ? "" : "Type a note — it goes in each player's VIP history.")}
              apply={(rows, progress) => uploadVips(serverId, rows, uploadNote.trim(), progress)} />
          )}
        </>}
      >
      <Explanation>
        A green badge, in place of Permanent, names the group whose perk gives that player VIP while
        they are on its list. A red line is VIP on hold: what of their own is paused beneath a
        group&apos;s VIP — time, or a permanent of their own — which stays theirs when they leave the
        group; or a VIP timeout. Permanent on its own is VIP of their own, with no group perk
        covering them on this server.
      </Explanation>
      {!vips && <SkeletonRows rows={6} cols={6} />}
      {vips && !filtered.length && (
        <EmptyState icon="★" title={q.trim() ? "No VIPs match your search" : "No VIPs yet"}
          filtered={Boolean(q.trim())} onClear={() => setQ("")}>
          {q.trim() ? "The search covers player names and IDs."
                    : "VIP entries reserve a slot on a full server. Add one above, or from any player's profile."}
        </EmptyState>
      )}
      {filtered.length > 0 && (
        <div className="scroll-x">
          <table>
            {/* Action column sits right after the name so it stays reachable on narrow screens
                (the wide table scrolls; the far-right edge is the part that gets lost). */}
            <thead><tr>
              <SortTh s={sort} k="player">Player</SortTh>
              <th></th>
              <SortTh s={sort} k="status">Status</SortTh>
              <SortTh s={sort} k="expiration">Expiration</SortTh>
              <SortTh s={sort} k="comment">Comment</SortTh>
              <SortTh s={sort} k="by">Added by</SortTh>
            </tr></thead>
            <tbody>
              {(pages.items ?? []).map((v) => {
                const st = expiryStatus(v.expiration);
                return (
                  <tr key={v.id}>
                    <td><PlayerLink playerId={v.playerId} name={v.playerName || <span className="muted">{v.playerId.slice(0, 14)}…</span>} /></td>
                    <td><button className="mini ghost" onClick={() => revoke(v)}>Revoke</button></td>
                    {/* The status is the thing people click when they want the story behind it —
                        "why does this say expired?" — so it opens the profile, where the full
                        grant/revoke history lives. */}
                    <td style={{ whiteSpace: "nowrap" }}>
                      {/* A group perk's members wear the group's name in green IN PLACE of
                          "Permanent": their permanent is the group's while they are listed, not one
                          of their own, and a "Permanent" beside it read the same as everybody
                          else's. The green badge is the link to the profile, as the status is. */}
                      {/* A member whose permanent is their own reads the same way: the group's
                          name, with their own permanent paused beneath it. */}
                      {v.groupHold || ownUnderGroup(v)
                        ? groupBadgeNames(v).map((name, i) => (
                            <button key={name} className="badge ok badge-link" style={i ? { marginLeft: 6 } : undefined}
                              title={`${v.groupHold ? groupBadgeTitle(v.groupHold) : ownUnderGroupTitle(v)} Opens their profile and VIP history.`}
                              onClick={() => nav.go("players", { playerId: v.playerId })}>{name}</button>
                          ))
                        : <button className={`badge ${st.cls} badge-link`} title="Open profile and VIP history"
                            onClick={() => nav.go("players", { playerId: v.playerId })}>{st.label}</button>}
                      {/* What is on hold, in red, on its own line — the time frozen beneath a
                          group's permanent, and a VIP timeout — so paused time can be kept track of. */}
                      {pausedLines(v).map((line) => <div key={line.key} className="vip-paused" title={line.title}>{line.text}</div>)}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>{v.expiration ? fmt(v.expiration) : "—"}</td>
                    {/* Long CRCON import comments used to stretch the table far past the viewport
                        with the cut-off text giving no hint — cap the cell, full text on hover. */}
                    <td className="vip-comment" title={v.comment ?? undefined}>{v.comment || ""}</td>
                    <td>{v.createdByName}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {filtered.length > 0 && <Pager list={pages} noun="VIP" />}
      </Panel>

      {/* The scan behind two field incidents: a PERMANENT grant someone paid for, rewritten to a
          date by automation and then swept out of the game. The store now refuses that write;
          this finds the grants damaged before it did — the ones already gone, and the ones still
          standing with a date that will remove them. */}
      <Panel defaultCollapsed id="vipintegrity" caps={["vip.grant", "vip.revoke"]} title="VIP integrity"
        subtitle="Find VIP that automation dated, removed or shortened">
        <Explanation>
          Checks every grant against what stands today — permanent VIP a person gave, and dated
          time however it was earned (staff grants and seed rewards alike). An automated write
          that removed a permanent or moved an expiry <em>earlier</em> is a finding, with the
          exact writes as the receipt and the hours taken counted; the fix stacks them back on.
          Anything a person decided afterwards — a revoke, a reduction, a deliberate re-grant —
          is their call and is not flagged.
        </Explanation>
        <div className="control-row">
          <button onClick={runScan} disabled={scanBusy}>{scanBusy ? "Scanning…" : scan ? "Scan again" : "Scan all servers"}</button>
          {scan && <span className="muted fs-sm">{scan.scanned.toLocaleString()} audit entries checked — the whole VIP history</span>}
        </div>
        <ActionResult error={scanError} />
        {scan && scan.findings.length === 0 && (
          <EmptyState icon="✔" title="Every grant is intact">
            No permanent VIP has been dated or removed by automation, and no dated grant has had
            time taken from it.
          </EmptyState>
        )}
        {scan && scan.findings.length > 0 && (
          <div className="scroll-x">
            {/* Top-aligned: a row is as tall as its evidence, and a name and buttons centred in
                that read as an empty table with a stray button at the bottom on a phone. */}
            <table className="valign-top">
              <thead><tr><th>Player</th><th></th><th>Verdict</th><th>Granted by</th><th>Server</th><th>Evidence</th></tr></thead>
              <tbody>
                {scan.findings.map((f) => {
                  const key = `${f.serverId}|${f.playerId}`;
                  const done = restored.has(key);
                  const dismissed = ignored.has(key);
                  return (
                    <tr key={key}>
                      <td><PlayerLink playerId={f.playerId} name={f.playerName || <span className="muted">{f.playerId.slice(0, 14)}…</span>} /></td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {done
                          ? <span className="badge active">restored</span>
                          : dismissed
                            ? <span className="badge">dismissed</span>
                            : <>
                                <button className="mini" onClick={() => restore(f)}>{f.verdict === "shortened" ? `Add ${lostLabel(f.lostMs ?? 0)} back` : "Restore permanent"}</button>{" "}
                                <button className="mini ghost" onClick={() => ignore(f)}
                                  title="The removal was intentional — dismiss this finding. Anything automation takes AFTER today surfaces as a new one.">Ignore</button>
                              </>}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <span className={`badge ${f.verdict === "lost" ? "err" : "warn-badge"}`}>{f.verdict}</span>
                        {f.verdict !== "lost" && f.currentExpiration && <div className="muted fs-sm">dies {fmt(f.currentExpiration)}</div>}
                        {f.verdict === "shortened" && !f.currentExpiration && <div className="muted fs-sm">already lapsed — adds from now</div>}
                      </td>
                      <td>{f.grantedBy}<div className="muted fs-sm">{fmt(f.permanentSince)}</div></td>
                      <td>{f.serverName ?? <span className="muted">—</span>}</td>
                      <td className="wrap fs-sm" style={{ minWidth: "16rem" }}><IntegrityEvidence lines={f.evidence} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </PanelGroup>
  );
}

/** An instant inside an evidence line, shown in the display zone like every other date here. */
const EVIDENCE_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
/**
 * How many receipts a finding shows before "Show all". The first ones are the story — what dated
 * the grant, what took it off the game; a lost grant then gathers every seed reward and sweep the
 * player has had since, and printed whole that list made one finding several screens tall.
 */
const EVIDENCE_SHOWN = 2;

function IntegrityEvidence({ lines }: { lines: string[] }) {
  const [all, setAll] = useState(false);
  if (!lines.length) return <span className="muted">no automated write recorded — likely older than the audit trail</span>;
  const readable = (text: string) => text.replace(EVIDENCE_INSTANT, (iso) => fmt(iso));
  return (
    <>
      {(all ? lines : lines.slice(0, EVIDENCE_SHOWN)).map((line, i) => {
        // "<when> — <what>": the when muted, so the eye runs down what happened.
        const at = /^(\S+) — ([\s\S]*)$/.exec(line);
        return (
          <div key={i} className="evidence-line">
            {at ? <><span className="muted">{readable(at[1]!)}</span> — {readable(at[2]!)}</> : readable(line)}
          </div>
        );
      })}
      {lines.length > EVIDENCE_SHOWN && (
        <button type="button" className="mini ghost" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${lines.length}`}
        </button>
      )}
    </>
  );
}

/**
 * A member of a VIP-perk group whose permanent is their own. A perk never takes one over — it may
 * be paid, and leaving the group must not end it — so the grant carries no hold; the page still
 * shows the group, with that permanent paused beneath it, because that is what it amounts to.
 */
function ownUnderGroup(v: Vip): boolean {
  return !v.groupHold && v.expiration === null && (v.perkGroups?.length ?? 0) > 0;
}

/**
 * An uploaded VIP list's new and longer lines, granted through the bulk grant two hundred at a time:
 * each player their own end and the list's own comment (the note where it has none), under the bulk
 * grant's floor — it adds or lengthens, never shortens, whatever changed since the preview.
 */
async function uploadVips(serverId: string, rows: PlanRow<VipLine>[], note: string, progress: (done: number) => void): Promise<UploadResult[]> {
  const out: UploadResult[] = [];
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    try {
      const r = await api<{ applied: { playerId: string; note: string }[]; skipped: { playerId: string; reason: string }[] }>(`/servers/${serverId}/vips/bulk`, {
        method: "POST",
        body: { upload: true, mode: "permanent", comment: note, players: batch.map((b) => b.payload) },
      });
      for (const b of batch) {
        const done = r.applied.find((a) => a.playerId === b.payload!.playerId);
        out.push({ line: b.line, who: b.who, ok: Boolean(done), detail: done?.note || r.skipped.find((x) => x.playerId === b.payload!.playerId)?.reason || "not applied" });
      }
    } catch (e) {
      for (const b of batch) out.push({ line: b.line, who: b.who, ok: false, detail: (e as Error).message });
    }
    progress(Math.min(i + 200, rows.length));
  }
  return out;
}

/** The VIP list as a file, row for row as on screen. A group perk's name, which the screen shows in
 *  place of the status, has a column of its own; a VIP the perk itself holds says "Group perk" for
 *  its status, so the list uploaded again never turns it into a permanent of the player's own. */
function vipSheet(rows: Vip[], serverName: string): Sheet {
  return {
    name: "VIPs",
    columns: [
      { key: "player", label: "Player" },
      { key: "playerId", label: "Player ID" },
      { key: "status", label: "Status" },
      { key: "expires", label: "Expires", time: true },
      { key: "groupPerk", label: "Group perk" },
      { key: "pausedUntil", label: "Paused until", time: true },
      { key: "comment", label: "Comment" },
      { key: "addedBy", label: "Added by" },
      { key: "added", label: "Added", time: true },
      { key: "server", label: "Server" },
    ],
    rows: rows.map((v) => [
      v.playerName, v.playerId, v.groupHold ? "Group perk" : expiryStatus(v.expiration).label, v.expiration,
      v.groupHold || ownUnderGroup(v) ? groupBadgeNames(v).join(", ") : null,
      v.pausedUntil, v.comment, v.createdByName, v.createdAt, serverName,
    ]),
  };
}

/** The green badges' names: the groups holding the grant, or the perk groups listing the player. */
function groupBadgeNames(v: Vip): string[] {
  const names = v.groupHold ? v.groupHold.groups.map((g) => g.name) : (v.perkGroups ?? []).map((g) => g.name);
  return names.length ? names : ["group perk"];
}

function ownUnderGroupTitle(v: Vip): string {
  return `In group ${heldGroups({ groups: v.perkGroups ?? [] })}, whose perk gives VIP while they are listed; their permanent VIP is their own, paused beneath it, and stays theirs when they leave the group.`;
}

/** The green group badge's tooltip: whose permanent it is, and what of their own waits beneath it. */
function groupBadgeTitle(hold: NonNullable<Vip["groupHold"]>): string {
  const beneath = hold.bankedMs > 0
    ? `${describeSpanMs(hold.bankedMs)} of their own timed VIP is paused beneath it and comes back when they leave`
    : "nothing of their own is paused beneath it";
  return `Permanent VIP from group ${heldGroups(hold)} while they are on its list; ${beneath}${hold.groups.some((g) => g.severanceMinutes > 0) ? ", plus the severance." : "."}`;
}

/**
 * The VIP on hold for one grant, as red lines under its status: the timed VIP of their own frozen
 * beneath a group perk's permanent (it comes back when they leave the group), and a VIP timeout —
 * the time left that a banked one froze, or that the clock keeps running through a running one.
 */
function pausedLines(v: Vip): { key: string; text: string; title: string }[] {
  const lines: { key: string; text: string; title: string }[] = [];
  if (ownUnderGroup(v)) lines.push({ key: "own", text: "Permanent paused", title: ownUnderGroupTitle(v) });
  if (v.groupHold && v.groupHold.bankedMs > 0) {
    lines.push({ key: "group", text: `${describeSpanMs(v.groupHold.bankedMs)} paused`, title: groupBadgeTitle(v.groupHold) });
  }
  if (isFuture(v.pausedUntil)) {
    const why = [v.pauseReason, v.pausedBy ? `by ${v.pausedBy}` : ""].filter(Boolean).join(" — ");
    if (v.expiration === null) {
      // A permanent has no clock, so banked or running it is the same: the whole VIP waits out the
      // timeout and comes back when it ends — no time runs. Under a green badge the badge, or the
      // line above, already says what that permanent is (the group's, or their own paused beneath
      // it); "Permanent paused" again would read as their own permanent, or as the same thing twice.
      lines.push({
        key: "timeout",
        text: `${v.groupHold || ownUnderGroup(v) ? "Paused" : "Permanent paused"} until ${fmt(v.pausedUntil!)}`,
        title: `VIP timeout${why ? `: ${why}` : ""} — their VIP is off the game until it ends, then comes back.`,
      });
    } else if (v.pauseMode === "banked") {
      // Banked: the meter stopped when the timeout began, so what is paused is what was left then.
      const left = Date.parse(v.expiration) - Date.parse(v.pausedAt ?? new Date().toISOString());
      lines.push({
        key: "timeout",
        text: `${left > 0 ? `${describeSpanMs(left)} paused` : "Paused"} until ${fmt(v.pausedUntil!)}`,
        title: `VIP timeout${why ? `: ${why}` : ""} — the time left is banked and comes back when it ends.`,
      });
    } else {
      lines.push({
        key: "timeout",
        text: `Paused until ${fmt(v.pausedUntil!)} · time running`,
        title: `VIP timeout${why ? `: ${why}` : ""} — their VIP time keeps running meanwhile.`,
      });
    }
  }
  return lines;
}

/** "“WW2 CVC”", "“WW2 CVC”, “Streamers”" — the groups whose perk holds a grant. */
function heldGroups(hold: { groups: { name: string }[] }): string {
  return hold.groups.map((g) => `“${g.name}”`).join(", ") || "a group perk";
}
