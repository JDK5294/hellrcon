"use client";
/**
 * Slow CRCON backup pull: kick off a resumable, throttled full-data extract from an existing CRCON
 * instance into our durable archive, watch its progress, and export/re-upload the archive so the
 * data never has to be pulled twice. The pull itself runs in the worker; this view drives + observes
 * it. Needs Manage servers.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fmtExact } from "../lib/time";
import { api, authHeaders, refusal } from "../lib/api";
import { useServers } from "../lib/servers";
import { useConfirm } from "../lib/feedback";
import { Panel } from "./Panel";
import { ActionResult, Explanation } from "./ui";

interface Job {
  id: string;
  status: "running" | "paused" | "done" | "error";
  counts: Record<string, number>;
  errors: string[];
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}
interface JobStatus { job: Job | null; archive: { dataType: string; count: number }[]; fileBytes: number; archiveServerNumber?: number | null }

function humanBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"]; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

// Friendly labels for the archive/data-type rows.
const LABELS: Record<string, string> = {
  vip: "VIPs", ban: "Bans", blacklist: "Blacklists", blacklist_record: "Blacklist records",
  standard_message: "Messages", map_history: "Map history", map_scoreboard: "Round scoreboards",
  watchlist: "Watchlist", player: "Players", player_detail: "Player profiles",
};

export function CrconBackup({ canRun = true }: { canRun?: boolean }) {
  const { serverId, server } = useServers();
  const confirm = useConfirm();
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [unrecognized, setUnrecognized] = useState<string[]>([]);
  const [applying, setApplying] = useState<{ processed: number; phase?: string } | null>(null);

  // The server this view is showing RIGHT NOW, readable from inside a long-running async loop.
  // A poll loop belongs to the server it was started for; without this it keeps writing progress
  // after the operator has switched away, and that progress paints onto whoever is on screen.
  const shownServer = useRef(serverId);
  useEffect(() => { shownServer.current = serverId; }, [serverId]);

  // The same rule for a single read: one for the server you just left lands after the switch, and
  // would put its row counts under the new server's name.
  const refresh = useCallback(async () => {
    if (!serverId) return;
    try {
      const st = await api<JobStatus>(`/servers/${serverId}/import/crcon/job`);
      if (shownServer.current === serverId) setStatus(st);
    } catch (e) { if (shownServer.current === serverId) setErr((e as Error).message); }
  }, [serverId]);

  // Poll while a pull is active so progress ticks up live.
  useEffect(() => { void refresh(); }, [refresh]);

  // This state describes ONE server, and React keeps it across a server switch — so it has to be
  // cleared explicitly. Starting an Apply on server 2 and then selecting server 1 left `applying`
  // set AND left the abandoned poll loop refreshing it every 2.5s, so server 1 showed a running
  // import with a rising row count that nobody had started. Declared ABOVE the attach effect so the
  // reset lands first and the attach re-establishes only what is actually true for this server.
  useEffect(() => {
    // `status` carries the archive's per-type ROW COUNTS and its size — the numbers an operator
    // reads to answer "how big is this server's import". refresh() refetches it, but not before the
    // new server has already rendered, so leaving the old value here showed the PREVIOUS server's
    // counts under the new server's name for as long as the request took. Blank until the real
    // answer arrives beats a confident wrong one.
    setStatus(null);
    setApplying(null); setBusy(false); setErr(""); setMsg(""); setUnrecognized([]);
  }, [serverId]);

  // Attach to an Apply run that is ALREADY going (started in another tab, or before a reload):
  // without this the run kept working server-side while the page showed nothing but a
  // duplicate-run error on the next click.
  useEffect(() => {
    if (!serverId) return;
    let cancelled = false;
    const attachTo = serverId;
    void (async () => {
      try {
        const st = await api<{ status: string; processed?: number; phase?: string }>(`/servers/${attachTo}/import/crcon/transform/status`);
        // Nothing running for THIS server — the reset above already cleared the previous server's
        // progress, so there is nothing to re-establish and returning here is now safe.
        if (cancelled || st.status !== "running") return;
        setApplying({ processed: st.processed ?? 0, phase: st.phase });
        setBusy(true);
        const r = await pollApply(attachTo);
        if (!cancelled && r) {
          setApplying(null);
          if (r.errors?.length) setErr(r.errors.join(" "));
          else setMsg(`Apply finished — ${(r.kills + r.teamkills).toLocaleString()} kill(s), ${r.events.toLocaleString()} other event(s) landed. Open the recap by re-running Apply if you need the full breakdown.`);
          setUnrecognized(r.unrecognizedSamples ?? []);
        }
      } catch (e) { if (!cancelled) { setApplying(null); setErr((e as Error).message); } }
      finally { if (!cancelled) setBusy(false); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- attach once per server; pollApply is stable in practice
  }, [serverId]);
  useEffect(() => {
    if (status?.job?.status !== "running") return;
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [status?.job?.status, refresh]);

  async function start(opts: { restart?: boolean } = {}) {
    if (!serverId) return;
    setBusy(true); setErr(""); setMsg("");
    try {
      const r = await api<{ note: string }>(`/servers/${serverId}/import/crcon/job`, {
        method: "POST",
        body: { baseUrl: baseUrl.trim() || undefined, apiKey: apiKey.trim() || undefined, restart: opts.restart || undefined },
      });
      setApiKey("");
      setMsg(r.note === "started" ? "Backup pull started — it runs gradually in the background." : `Pull ${r.note}.`);
      await refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function pause() {
    if (!serverId) return;
    setBusy(true); setErr(""); setMsg("");
    try { await api(`/servers/${serverId}/import/crcon/job/pause`, { method: "POST" }); await refresh(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  // Surgical re-run: only failed items (and any data types added since the pull) are fetched —
  // everything already archived is kept and skipped, so this never costs a full re-pull.
  async function retryFailures() {
    if (!serverId) return;
    setBusy(true); setErr(""); setMsg("");
    try {
      const r = await api<{ retriedProfiles: number }>(`/servers/${serverId}/import/crcon/job/retry`, { method: "POST" });
      setMsg(`Retry started — re-fetching ${r.retriedProfiles} failed player profile(s) plus any failed or newly added data types.`);
      await refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  // The trim for the stored archive. The archive is the full-fidelity copy of the CRCON history —
  // including the fields the import deliberately reads past — so this is the one control that can
  // lose data the panel's database does not hold, and the confirmation says so plainly.
  async function deleteArchive() {
    if (!serverId) return;
    if (!(await confirm({
      title: "Delete this server's stored archive?",
      body: `The archive (${humanBytes(fileBytes)}) is the complete copy of the CRCON history, including fields the import keeps only here (per-round weapon splits, streaks, lifespans, squad membership). Everything already imported stays imported — but a future re-Apply, and any future feature wanting those extra fields, would need a fresh export from the backup or an upload. If you no longer have the original backup, export a download first.`,
      confirmLabel: "Delete archive",
    }))) return;
    setBusy(true); setErr(""); setMsg("");
    try {
      const r = await api<{ bytes: number }>(`/servers/${serverId}/import/crcon/archive`, { method: "DELETE" });
      setMsg(`Archive deleted — ${humanBytes(r.bytes)} freed. Imported history is untouched.`);
      await refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  // Export streams NDJSON — fetch with the bearer token and trigger a download.
  async function exportBackup() {
    if (!serverId) return;
    setBusy(true); setErr(""); setMsg("");
    try {
      const res = await fetch(`/api/servers/${serverId}/import/crcon/export`, { headers: authHeaders() });
      if (!res.ok) throw await refusal(res);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `crcon-backup-${serverId}.ndjson`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  interface Summary { players: number; vips: number; vipsKept?: number; bans: number; watchlist: number; notes: number; messages: number; sessions: number; matches: number; kills: number; teamkills: number; tags: number; events: number; visits: number; matchStats: number; scoreboards?: number; playtimeSec?: number; playtimeSettled?: number; lastSeenRepaired?: number; cutoff: string | null; skipped: { afterCutoff: number; noTimestamp: number; unrecognized: number; otherServer?: number }; unrecognizedSamples: string[]; errors: string[] }

  // Apply runs in the API as a background job — a multi-million-row archive outlives any
  // proxy/browser timeout, so the old inline request was killed mid-flight every time. The run
  // belongs to the SERVER: this poller attaches to whatever run exists, whether this tab started
  // it or not (mount-attach below), so a reload or second click never loses sight of it.
  // `forServer` is an ARGUMENT, not read from the closure, so the loop cannot drift onto whatever
  // server is selected later — and every write is gated on that server still being on screen.
  // Returns null once the operator navigates away: the run continues server-side (it belongs to the
  // SERVER, and the attach effect re-finds it on the next visit) but this loop stops touching the
  // UI. Without the gate its 2.5s tick kept painting progress onto another server's screen, which
  // read as an import that server had never been asked to do.
  async function pollApply(forServer: string): Promise<Summary | null> {
    for (;;) {
      if (shownServer.current !== forServer) return null;
      const st = await api<{ status: string; processed?: number; phase?: string; summary?: Summary; error?: string }>(`/servers/${forServer}/import/crcon/transform/status`);
      if (shownServer.current !== forServer) return null;
      if (st.status === "done" && st.summary) return st.summary;
      if (st.status === "error") throw new Error(st.error || "Apply failed");
      if (st.status === "idle") throw new Error("Apply run was lost (API restarted) — run it again, it is safe to re-run");
      setApplying({ processed: st.processed ?? 0, phase: st.phase });
      await new Promise((done) => setTimeout(done, 2500));
    }
  }

  async function transform(dry = false) {
    if (!serverId) return;
    setBusy(true); setErr(""); setMsg("");
    try {
      // Attach to an existing run instead of starting one — a second click or a reloaded tab
      // should watch the run in progress, not bounce off the duplicate-run guard.
      const startedFor = serverId;
      const st = await api<{ status: string }>(`/servers/${startedFor}/import/crcon/transform/status`);
      if (st.status !== "running") await api(`/servers/${startedFor}/import/crcon/transform${dry ? "?dry=1" : ""}`, { method: "POST" });
      setApplying({ processed: 0, phase: "scan" });
      const r = await pollApply(startedFor);
      // Navigated away mid-run: the Apply carries on server-side and re-attaches on the next visit,
      // but this loop must not write its recap onto whatever server is now on screen.
      if (!r) return;
      setApplying(null);
      // A refusal comes back as a NORMAL, successful run whose counts are all zero and whose
      // reason is in `errors` — the Apply decided not to write, it did not crash. Rendering the
      // usual "Transformed archive → 0 player(s), 0 kill(s)…" recap over that says nothing about
      // why, which is how an Apply that never applied anything reads as an Apply that worked.
      if (r.errors?.length) { setErr(r.errors.join(" ")); return; }
      // The skip report is the backfill's diagnostic: it says WHY archived rows didn't apply —
      // the overlap cutoff (by design: the panel's own live record owns that era) vs rows the
      // parser didn't recognize (field-name drift in a different CRCON version → report samples).
      const skips: string[] = [];
      if (r.skipped?.afterCutoff) skips.push(`${r.skipped.afterCutoff.toLocaleString()} after the ${r.cutoff ? fmtExact(r.cutoff) : ""} cutoff (that era is already tracked live — not lost, just not double-counted)`);
      if (r.skipped?.noTimestamp) skips.push(`${r.skipped.noTimestamp.toLocaleString()} without a readable timestamp`);
      if (r.skipped?.unrecognized) skips.push(`${r.skipped.unrecognized.toLocaleString()} unrecognized (unknown field layout)`);
      if (r.skipped?.otherServer) skips.push(`${r.skipped.otherServer.toLocaleString()} belonging to ANOTHER server of the CRCON install (dropped — applying them here would mix the two servers' histories)`);
      setMsg(`${dry ? "DRY RUN — full parse, nothing written. A real Apply would land: " : "Transformed archive → "}${r.players} player(s), ${(r.kills + r.teamkills).toLocaleString()} kill(s), ${r.events.toLocaleString()} other event(s), ${r.matches} match(es), ${r.matchStats.toLocaleString()} match line(s)${r.scoreboards ? ` (${r.scoreboards.toLocaleString()} round scoreboard(s) with scores and buckets)` : ""}, ${r.visits.toLocaleString()} visit(s), ${r.vips} VIP(s)${r.vipsKept ? ` (${r.vipsKept} existing grant(s) left as they stand — top-up mode)` : ""}, ${r.bans} ban(s), ${r.watchlist} watched, ${r.tags} tag(s), ${r.sessions} session(s)${r.playtimeSec ? ` (${Math.round(r.playtimeSec / 3600).toLocaleString()} h of pre-cutoff playtime folded into careers)` : ""}${r.playtimeSettled ? ` (${r.playtimeSettled.toLocaleString()} career playtime(s) reconciled from earlier imports)` : ""}${r.lastSeenRepaired ? ` (${r.lastSeenRepaired.toLocaleString()} last-seen date(s) repaired)` : ""}, ${r.notes} note(s), ${r.messages} message(s).${skips.length ? ` Skipped: ${skips.join("; ")}.` : ""}`);
      setUnrecognized(r.unrecognizedSamples ?? []);
    } catch (e) { setErr((e as Error).message); setApplying(null); } finally { setBusy(false); }
  }

  interface Integrity { cutoff: string | null; importedEvents: number; crossServerEvents: number; preCutoffMatches: number; preCutoffSessions: number }
  const [integrity, setIntegrity] = useState<Integrity | null>(null);

  async function checkIntegrity() {
    if (!serverId) return;
    setBusy(true); setErr(""); setMsg("");
    try {
      setIntegrity(await api<Integrity>(`/servers/${serverId}/import/crcon/integrity`));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  // VIP drift: expiries an apply from before `vips.importOne` overwrote with the archive's value.
  // The audit trail is what makes them recoverable — every real grant recorded its expiration — so
  // this is a read of the two against each other, and the restore puts the granted value back.
  interface VipDrift { playerId: string; playerName: string | null; currentExpiration: string | null; grantedExpiration: string | null; grantedAt: string; grantedBy: string; movedAt: string; direction: string }
  const [drift, setDrift] = useState<VipDrift[] | null>(null);

  // Both reports describe ONE server too, and both are read-only panels that stay on screen until
  // replaced — so switching servers must clear them or server 2's integrity counts and VIP list are
  // read as server 1's. Separate from the reset above only because these are declared down here.
  useEffect(() => { setIntegrity(null); setDrift(null); }, [serverId]);

  async function checkVipDrift() {
    if (!serverId) return;
    setBusy(true); setErr(""); setMsg("");
    try {
      const r = await api<{ moved: VipDrift[] }>(`/servers/${serverId}/import/crcon/vip-drift`);
      setDrift(r.moved);
      if (r.moved.length === 0) setMsg("No VIP expiry disagrees with the grant that set it.");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  // Only what gives time BACK is restorable: a row cut short, or permanent VIP given an expiry. A
  // row LONGER than its last setting is never cut in bulk — VIP is paid for, and an extension that
  // keeps its own record (a resumed VIP timeout, a rule's crash VIP) looks the same here as one an
  // import made. Those stay listed for staff to judge one at a time.
  const restorable = (drift ?? []).filter((d) => d.direction === "shortened" || d.direction === "given-an-expiry");

  async function restoreVipDrift() {
    if (!serverId || !restorable.length) return;
    const longer = (drift?.length ?? 0) - restorable.length;
    if (!(await confirm({
      title: `Give ${restorable.length} VIP${restorable.length === 1 ? "" : "s"} back the time an import cut?`,
      body: `Each gets the expiry its newest grant, cut or reward recorded — later than it is now, or permanent again. Nothing is shortened${longer ? `: the ${longer} longer one${longer === 1 ? "" : "s"} in the list stay${longer === 1 ? "s" : ""} as ${longer === 1 ? "it is" : "they are"}` : ""}. Each restore is recorded as a staff action.`,
      confirmLabel: "Give the time back",
    }))) return;
    setBusy(true); setErr(""); setMsg("");
    try {
      const r = await api<{ restored: Array<{ playerId: string; restoredTo: string | null }> }>(
        `/servers/${serverId}/import/crcon/vip-drift/restore`, { method: "POST", body: JSON.stringify({ playerIds: restorable.map((d) => d.playerId) }) });
      setMsg(`Gave ${r.restored.length} VIP${r.restored.length === 1 ? "" : "s"} back their recorded expiry.${longer ? ` ${longer} longer one${longer === 1 ? "" : "s"} left as ${longer === 1 ? "it is" : "they are"}.` : ""}`);
      await checkVipDrift();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function resetImported() {
    if (!serverId) return;
    if (!(await confirm({
      title: "Remove everything the import wrote?",
      body: "This deletes every imported event, pre-cutoff match with its player lines, imported session and camera visit for THIS server, then recounts careers from what the panel itself recorded. The live era is untouched. Do this to clear a contaminated or distrusted import, then re-run the pull and Apply — the archive rebuilds it all cleanly.",
      confirmLabel: "Reset imported history",
    }))) return;
    setBusy(true); setErr(""); setMsg("");
    try {
      const r = await api<{ events: number; matches: number; matchStats: number; sessions: number; cameraSessions: number; playersRecounted: number }>(
        `/servers/${serverId}/import/crcon/reset`, { method: "POST" });
      setMsg(`Imported history removed — ${r.events.toLocaleString()} event(s), ${r.matches.toLocaleString()} match(es) with ${r.matchStats.toLocaleString()} player line(s), ${r.sessions.toLocaleString()} session(s), ${r.cameraSessions} camera visit(s); ${r.playersRecounted.toLocaleString()} career(s) recounted from live evidence. Run the pull (fresh job) and Apply to rebuild cleanly.`);
      setIntegrity(null);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  // The bigger hammer. "Reset imported history" removes what an import CLAIMS it wrote, which
  // leaves behind anything an older import wrote without a way to recognise it later — bans, VIP
  // grants, notes, tags, IPs, aliases. This takes the whole server by id instead, so nothing
  // survives by being unlabelled. One tap to confirm — the same as every other destructive button
  // on this screen. It asked for a typed string twice and both times refused an operator who was
  // doing exactly the right thing, so the dialog now only has to be read, not transcribed.
  async function purgeServer() {
    if (!serverId || !server) return;
    if (!(await confirm({
      title: `Wipe all of ${server.name}'s data?`,
      body: "Deletes every event, match, session, camera visit, career stat, imported ban and VIP grant on THIS server — live and imported alike — plus notes, tags, aliases and IPs for players left with no presence on any other server. Your other servers, your settings, your staff accounts and the players' Discord links are all untouched. There is no undo: the history comes back only by importing it again.",
      confirmLabel: "Wipe this server's data",
      danger: true,
    }))) return;
    setBusy(true); setErr(""); setMsg("");
    try {
      const r = await api<{ events: number; matches: number; matchStats: number; sessions: number; cameraSessions: number; careers: number; bans: number; vips: number; notes: number; tags: number; ips: number; aliases: number; watchlist: number }>(
        `/servers/${serverId}/purge`, { method: "POST" });
      setMsg(`${server.name} wiped — ${r.events.toLocaleString()} event(s), ${r.matches.toLocaleString()} match(es) with ${r.matchStats.toLocaleString()} player line(s), ${r.sessions.toLocaleString()} session(s), ${r.cameraSessions.toLocaleString()} camera visit(s), ${r.careers.toLocaleString()} career(s), ${r.bans.toLocaleString()} ban(s), ${r.vips.toLocaleString()} VIP(s), ${r.notes.toLocaleString()} note(s), ${r.tags.toLocaleString()} tag(s), ${r.aliases.toLocaleString()} alias(es), ${r.ips.toLocaleString()} IP(s). Import when ready — nothing is left to collide with.`);
      setIntegrity(null); setDrift(null);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function upload(file: File) {
    if (!serverId) return;
    setBusy(true); setErr(""); setMsg("");
    try {
      const res = await fetch(`/api/servers/${serverId}/import/crcon/upload`, { method: "POST", headers: { ...authHeaders(), "content-type": "application/x-ndjson" }, body: await file.text() });
      if (!res.ok) throw await refusal(res);
      const data = await res.json().catch(() => ({}));
      setMsg(`Uploaded ${data.imported} record(s)${data.skipped ? `, ${data.skipped} skipped` : ""}.`);
      await refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }

  if (!serverId) return null;
  const job = status?.job ?? null;
  const archive = status?.archive ?? [];
  const total = archive.reduce((n, r) => n + r.count, 0);
  const fileBytes = status?.fileBytes ?? 0;
  const hasArchive = fileBytes > 0;
  const archiveServerNumber = status?.archiveServerNumber ?? null;
  const running = job?.status === "running";
  // Read on crcon.import is "watch the pull"; every control on this panel writes — starting,
  // pausing, uploading, applying — so a read-only holder sees the progress and none of the levers.
  const locked = busy || !canRun;

  return (
    <Panel id="backup" caps="crcon.pull" title="CRCON backup (full data pull)">
      {!canRun && <p className="hint">You can follow this pull&apos;s progress. Running one needs the &ldquo;CRCON import &amp; backup&rdquo; permission at write.</p>}

      <Explanation>
        Gradually pull <em>all</em> of an existing CRCON instance&apos;s stored data into <strong>{server?.name}</strong>&apos;s durable archive —
        VIPs, bans, blacklists, messages, map history, every player&apos;s profile (flags, comments, sessions), and the COMPLETE
        game-log history — kills, team kills, chat, connections, team switches, admin actions, votes. Applying it rebuilds
        career stats, the leaderboard, weapon breakdowns, nemeses, matches and per-player win/loss history retroactively, and
        it only imports the era before the panel started watching this server itself, so nothing is ever double-counted.
        The pull is throttled and resumable, so it never
        overwhelms CRCON and picks up where it left off. Once pulled, export it as a backup you can re-upload later — the data never has to come from CRCON twice.
      </Explanation>

      {/* The credential fields stay reachable in EVERY state except mid-pull. A stopped pull is
          usually a rotated or expired CRCON key, so hiding the key box behind a "Resume" button
          is exactly when it's needed most — leaving it blank keeps whatever is already saved. */}
      {!running && (
        <div className="grid">
          <label>CRCON URL
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={job ? "leave blank to keep the saved URL" : "https://crcon.example.com (or leave blank to use the server's)"} />
          </label>
          <label>CRCON API key
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={job ? "leave blank to keep the saved key" : "paste the CRCON API key"} />
            {job && job.status !== "done" && <span className="hint">Key expired or changed? Paste the new one here, then Resume.</span>}
          </label>
        </div>
      )}

      {!job || job.status === "done" ? (
        <div className="actions" style={{ alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {job?.status === "done" && (
            <button disabled={locked} title="Re-fetch only what failed (plus any data types added since) — nothing that succeeded is re-pulled" onClick={() => void retryFailures()}>
              {job.errors?.length ? `Retry ${job.errors.length} failure(s) / top up` : "Top up (new data types only)"}
            </button>
          )}
          <button className={job?.status === "done" ? "ghost" : ""} disabled={locked} onClick={async () => {
            if (job?.status === "done" && !(await confirm({
              title: "Run a completely new pull?",
              body: "This re-downloads EVERYTHING from CRCON and rewrites the archive — days of fetching on a big server. To re-fetch only the failures or pick up newly supported data types, use Retry / top up instead.",
              confirmLabel: "Re-pull everything",
            }))) return;
            void start();
          }}>{busy ? "Starting…" : job?.status === "done" ? "Run another full pull" : "Start backup pull"}</button>
        </div>
      ) : (
        <div className="actions" style={{ alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className={`badge ${running ? "ok" : ""}`}>{running ? "Pulling…" : job.status === "error" ? "Stopped" : "Paused"}</span>
          {running
            ? <button disabled={locked} onClick={pause}>Pause</button>
            : <button disabled={locked} onClick={() => start()}>{apiKey.trim() || baseUrl.trim() ? "Resume with new details" : "Resume"}</button>}
          {!running && (
            <button className="ghost" disabled={locked} onClick={async () => {
              const ok = await confirm({
                title: "Start a completely fresh pull?",
                body: "The current pull's progress markers are discarded and it begins from the top. Anything already archived is kept and skipped, so this does not re-download what you already have.",
                confirmLabel: "Start fresh pull",
              });
              if (ok) void start({ restart: true });
            }}>Start over</button>
          )}
          {job.status === "error" && (
            <button className="ghost" disabled={locked} title="Re-fetch only what failed — nothing that succeeded is re-pulled" onClick={() => void retryFailures()}>Retry failures</button>
          )}
          {job.status === "error" && <span className="hint">Stopped on an error — fix the cause (often the API key), then Resume or Retry failures. Progress is kept.</span>}
        </div>
      )}

      {job && (
        <p className="hint" style={{ marginTop: 6 }}>
          Status <strong>{job.status}</strong> · started by {job.createdByName} · updated {fmtExact(job.updatedAt)}
          {job.errors?.length ? ` · ${job.errors.length} warning(s)` : ""}
        </p>
      )}

      {archive.length > 0 && (
        <div className="scroll-x" style={{ marginTop: 8 }}>
          <table className="table">
            <thead><tr><th>Data</th><th className="num">Archived</th></tr></thead>
            <tbody>
              {archive.map((r) => <tr key={r.dataType}><td>{LABELS[r.dataType] ?? r.dataType}</td><td className="num">{r.count.toLocaleString()}</td></tr>)}
              <tr><td><strong>Total</strong></td><td className="num"><strong>{total.toLocaleString()}</strong></td></tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="actions" style={{ marginTop: 8, gap: 8, alignItems: "center" }}>
        {/* NOT onClick={transform}: the click event would ride in as `dry` and truthy-flip every
            real Apply into a dry run. Explicit arrows keep the two buttons honest. */}
        <button disabled={locked || !hasArchive} onClick={() => void transform(true)}>Dry run (no writes)</button>
        <button className="primary" disabled={locked || !hasArchive} onClick={() => void transform()}>{applying ? (applying.phase === "scan" ? `Scanning archive… ${applying.processed.toLocaleString()} lines` : `Applying… ${applying.processed.toLocaleString()} rows`) : "Apply to panel"}</button>
        <button disabled={locked || !hasArchive} onClick={exportBackup}>Export backup (.ndjson)</button>
        <button disabled={locked} onClick={() => fileRef.current?.click()}>Upload backup…</button>
        <input ref={fileRef} type="file" accept=".ndjson,.json,application/x-ndjson" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
        {hasArchive && <span className="hint">archive {humanBytes(fileBytes)}</span>}
        {/* Which era this file is from, stated up front. A database export names its server; the
            older network-API pull named nothing, and on a multi-server install Apply refuses it —
            far better to read that here than after hours of a run that was never going to land. */}
        {hasArchive && (archiveServerNumber === null
          ? <span className="hint" style={{ color: "var(--warn, #b45309)" }}>legacy archive — does not say which CRCON server it holds</span>
          : <span className="hint">database export · CRCON server {archiveServerNumber}</span>)}
        {canRun && hasArchive && <button className="danger" disabled={locked} onClick={() => void deleteArchive()}>Delete archive…</button>}
      </div>
      <Explanation>&ldquo;Dry run&rdquo; parses the ENTIRE archive through the real import — every parser, every guard — into a throwaway copy and reports what a from-scratch Apply would land, including every error and skip, without writing anything. Run it first; Apply only after it comes back clean. &ldquo;Apply to panel&rdquo; then writes for real. Both read only the archive — never CRCON — and are safe to re-run.</Explanation>

      {/* Integrity: what past imports left behind, and whether any of it is cross-server
          contaminated (an unfiltered pull on a multi-server CRCON install fed BOTH servers'
          logs to this one). The reset is the repair: clear the imported era, re-pull, re-apply. */}
      <div className="actions" style={{ marginTop: 10, gap: 8, alignItems: "center" }}>
        <button disabled={busy} onClick={() => void checkIntegrity()}>Check import integrity</button>
        {canRun && integrity && (integrity.importedEvents > 0 || integrity.preCutoffMatches > 0) && (
          <button className="danger" disabled={locked} onClick={() => void resetImported()}>Reset imported history…</button>
        )}
        {/* Not gated on the integrity check finding something: the whole reason this exists is the
            records an old import left that nothing can recognise as imported — so "no imported
            events found" is exactly the state in which it still has work to do. */}
        {canRun && <button className="danger" disabled={locked} onClick={() => void purgeServer()}>Wipe this server&rsquo;s data…</button>}
      </div>
      {integrity && (
        <div className="setting-card" style={{ marginTop: 6 }}>
          <strong>Import integrity</strong>
          {integrity.crossServerEvents > 0 ? (
            <p style={{ margin: "4px 0" }}>
              ⚠ <strong>{integrity.crossServerEvents.toLocaleString()}</strong> imported event(s) on this server also exist on another server —
              the fingerprint of a pull made before multi-server filtering. Kills, sessions and rounds from BOTH servers are mixed here.
              Reset the imported history on <em>each</em> server, run a fresh pull per server (it now filters), then Apply.
            </p>
          ) : (
            <p className="hint" style={{ margin: "4px 0" }}>No cross-server duplicates detected.</p>
          )}
          <p className="hint" style={{ margin: 0 }}>
            Imported era on this server: {integrity.importedEvents.toLocaleString()} event(s), {integrity.preCutoffMatches.toLocaleString()} match(es),
            {" "}{integrity.preCutoffSessions.toLocaleString()} session(s){integrity.cutoff ? ` — everything before ${fmtExact(integrity.cutoff)}, when the panel started recording for itself` : ""}.
          </p>
        </div>
      )}
      {/* VIP drift. Separate from the integrity block above because it is a different kind of
          damage: not contaminated history, but LIVE grants an old apply moved off the value staff
          set. Only VIPs with a grant on record can be judged, so a clean result means "nothing
          disagrees", not "nothing was imported". */}
      <div className="actions" style={{ marginTop: 10, gap: 8, alignItems: "center" }}>
        <button disabled={busy} onClick={() => void checkVipDrift()}>Check VIP expiries against their grants</button>
        {canRun && restorable.length > 0 && (
          <button className="primary" disabled={locked} onClick={() => void restoreVipDrift()}>Give back {restorable.length} cut expir{restorable.length === 1 ? "y" : "ies"}…</button>
        )}
      </div>
      {drift && drift.length > 0 && (
        <div className="setting-card" style={{ marginTop: 6 }}>
          <strong>VIP expiries that don&apos;t match their last setting ({drift.length})</strong>
          <Explanation>
            <p>
              &ldquo;Granted&rdquo; is the newest thing that set each expiry on purpose and recorded it — a staff grant or cut,
              a group perk ending, a seed or game reward. An Apply from before the import stopped overwriting live grants
              wrote the archive&apos;s expiration over some of these.
            </p>
            <p>
              <strong>Cut short</strong> and <strong>given an expiry</strong> lost time, and Give back restores it.{" "}
              <strong>Extended</strong> and <strong>made permanent</strong> are listed for you to judge and are never cut in
              bulk: players pay for VIP, and time added by something that keeps its own record — a resumed VIP timeout,
              a rule&apos;s crash VIP — looks the same here as time an Apply added. Change one by hand on the VIPs page if
              the Apply gave it.
            </p>
            <p>
              Both columns come from this panel&apos;s own records — the VIP table and the staff audit trail. The game is
              never consulted and could not answer anyway: RCON&apos;s VIP list is permanent-only and holds no expiry, which
              is why the panel owns expirations in the first place.
            </p>
          </Explanation>
          <div style={{ overflowX: "auto" }}>
            <table className="data">
              <thead><tr><th>Player</th><th>Moved</th><th>Now</th><th>Granted</th><th>By</th></tr></thead>
              <tbody>
                {drift.map((d) => (
                  <tr key={d.playerId}>
                    <td>{d.playerName || d.playerId}</td>
                    <td>{d.direction === "extended" ? "extended" : d.direction === "shortened" ? "cut short" : d.direction === "made-permanent" ? "made permanent" : "given an expiry"}</td>
                    <td>{d.currentExpiration ? fmtExact(d.currentExpiration) : "permanent"}</td>
                    <td>{d.grantedExpiration ? fmtExact(d.grantedExpiration) : "permanent"}</td>
                    <td className="muted">{d.grantedBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {unrecognized.length > 0 && (
        <div className="setting-card" style={{ marginTop: 8 }}>
          <strong>Unrecognized archive rows (first {unrecognized.length})</strong>
          <Explanation>These rows didn&apos;t match any known CRCON field layout, so they were skipped. Share them to get the parser tuned to this CRCON version.</Explanation>
          {unrecognized.map((u, i) => <pre key={i} style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: "0.72rem", margin: "4px 0" }}>{u}</pre>)}
        </div>
      )}

      <ActionResult ok={msg} error={err} />
      {job?.errors?.length ? <ul className="hint" style={{ margin: "4px 0 0 18px" }}>{job.errors.slice(0, 8).map((e, i) => <li key={i}>{e}</li>)}</ul> : null}
    </Panel>
  );
}
