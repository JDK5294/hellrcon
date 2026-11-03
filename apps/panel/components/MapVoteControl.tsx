"use client";
/**
 * The map vote control surface — what staff actually touch, and nothing else.
 *
 * This is modelled directly on an earlier bot's Discord panel, because that panel is good and the
 * screen it replaces here was not. That panel shows six lines of status and a row of buttons: you can see
 * the whole state of the vote and every action available to you without scrolling or reading. The
 * old version buried those same actions inside a nine-step configuration wizard, so the thing you
 * do daily was hidden behind the thing you do once.
 *
 * Two rules carried over from it and worth keeping:
 *
 *  - Buttons are always PRESENT and conditionally DISABLED, never hidden. "Resume" greyed out tells
 *    you the vote isn't paused; "Resume" absent makes you wonder whether resuming is possible at
 *    all. The disabled reasons are spelled out in `title` so hovering explains the grey.
 *  - Every action reports back into one "last action" line, in the panel, in plain words. That panel puts
 *    the result of what you just pressed at the bottom of the same embed; you never have to go
 *    looking for confirmation.
 *
 * Configuration deliberately does NOT live here — it is a separate screen. In the old bot it was JSON files
 * you edit rarely, and mixing the two is exactly what made this unusable.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useServers } from "../lib/servers";
import { useLatestLoad } from "../lib/resource";
import { useConfirm } from "../lib/feedback";
import { Panel } from "./Panel";
import { ActionResult, AskNotice, Callout, GoTo, ObserveBanner, SkeletonLines } from "./ui";
import { MapPicker, type CatalogueMap } from "./MapPicker";
import { Time } from "./Time";

type Layout = "map_list" | "vote_counts";

interface PollOptionLive { id: string; name: string; votes: number }
interface VoteState {
  paused: boolean; pauseReason: string | null; overrideMapId: string | null;
  skipNext: boolean; reroll: boolean; startNow: boolean; resyncNow: boolean;
  lastOpenError: string | null;
  sendMessageLayout: string | null; savedOptions: { id: string; name: string }[];
  liveAppliedMapId: string | null; liveApplyNote: string | null; reopenAt: string | null;
  lastMatchEndAt?: string | null;
  activePoll: { options: PollOptionLive[]; profile: string | null; openedAt: string | null; totalVotes: number; talliedAt: string | null } | null;
}
interface ControlResp {
  enabled: boolean; surface?: string; channelId: string | null; activeProfile: string | null; state: VoteState | null;
  /** the player count the active set was judged at (null = no recent reading), and whether that
   *  missing count is the only reason nothing matched. */
  activeProfileCount?: number | null; activeProfileNeedsCount?: boolean;
}

/** One "label: value" line of the status block. Mirrors the field list in the old bot's home embed. */
function StatusRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row" style={{ gap: 10, alignItems: "baseline", padding: "3px 0" }}>
      <span className="hint" style={{ flex: "0 0 92px" }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
    </div>
  );
}

export function MapVoteControl({ canManage, catalogue }: { canManage: boolean; catalogue: CatalogueMap[] }) {
  const { serverId, server } = useServers();
  const confirm = useConfirm();
  const [data, setData] = useState<ControlResp | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [err, setErr] = useState("");
  // The old bot's "Last action" line: the result of the button you just pressed, shown where you pressed it.
  const [last, setLast] = useState("");
  const [busy, setBusy] = useState("");
  const [picking, setPicking] = useState(false);

  const claim = useLatestLoad();
  const load = useCallback(() => {
    if (!serverId) return;
    // Every read claims its turn: these buttons act on the SELECTED server while showing what
    // this response carried, so an overtaken read — a server switch, or a poll slower than the
    // 15s tick below — must not land on top of the newer one.
    const fresh = claim();
    api<ControlResp>(`/servers/${serverId}/mapvote/config`)
      .then((r) => { if (!fresh()) return; setData(r); setLoadErr(""); })
      .catch((e: unknown) => { if (fresh()) setLoadErr(e instanceof Error ? e.message : String(e)); });
  }, [serverId, claim]);
  useEffect(() => { load(); }, [load]);

  const state = data?.state ?? null;
  const active = Boolean(state?.activePoll);
  const paused = Boolean(state?.paused);
  const hasOverride = Boolean(state?.overrideMapId);

  // Counts move on their own while a vote is open, so keep the tally honest — but stop entirely
  // when the vote is off or paused, because then nothing changes without someone pressing a button.
  useEffect(() => {
    if (!data?.enabled || paused) return;
    // Same hidden-tab rule as the sidebar badge: no polls nobody can see.
    const t = setInterval(() => { if (!(typeof document !== "undefined" && document.hidden)) load(); }, 15000);
    return () => clearInterval(t);
  }, [data?.enabled, paused, load]);

  const nameOf = useMemo(() => new Map(catalogue.map((m) => [m.id, m.prettyName])), [catalogue]);
  const mapName = (id: string | null | undefined) => (id ? nameOf.get(id) ?? id : null);

  /** Run a control action, then report its outcome the way the old bot did — one line, in this panel. */
  async function act(key: string, path: string, body: unknown, said: string) {
    if (!canManage) return;
    setBusy(key); setErr("");
    try {
      await api(`/servers/${serverId}/mapvote/${path}`, { method: "POST", body });
      setLast(said);
      load();
    } catch (e) { setErr((e as Error).message); setLast(""); } finally { setBusy(""); }
  }

  const startVote = async () => {
    const ok = await confirm({
      title: "Start a new vote now?",
      // Spelled out because the old bot's Start Vote did all four of these at once and it surprises people.
      body: "Voting is switched back on, any forced map is cleared, whatever poll is open is closed, and a brand-new vote goes up straight away.",
      confirmLabel: "Start a new vote",
    });
    if (ok) await act("start", "start", undefined, "Started a fresh vote — it goes up within a few seconds.");
  };
  const resync = async () => {
    const ok = await confirm({
      title: "Re-read the map list and restart?",
      body: "The server's full map list is read again, the current poll is discarded, any forced map is cleared, and a new vote opens. Use it after the game adds or renames maps.",
      confirmLabel: "Re-read and restart",
    });
    if (ok) await act("resync", "resync", undefined, "Re-reading the map list, then opening a fresh vote.");
  };
  const reroll = async () => {
    const ok = await confirm({
      title: "Offer a different set of maps?",
      body: "The current poll is closed and replaced with a freshly drawn set. Votes cast so far are lost.",
      confirmLabel: "Draw new options",
    });
    if (ok) await act("reroll", "reroll", undefined, "New options requested — the poll reopens shortly.");
  };
  const skip = async () => {
    const ok = await confirm({
      title: "Skip the vote that's running?",
      body: "The poll closes now and no map is applied from it — the rotation carries on as normal.",
      confirmLabel: "Skip this vote",
    });
    if (ok) await act("skip", "skip", { skip: true }, "Vote skipped — the poll is closing.");
  };
  const announce = (layout: Layout) =>
    act(`say-${layout}`, "announce", { layout },
      layout === "map_list" ? "Sent the map list to everyone in game." : "Sent the standings to everyone in game.");
  const setOverride = (mapId: string | null) => {
    setPicking(false);
    return act("override", "override", { mapId },
      mapId ? `Next map forced to ${mapName(mapId)} — the vote result is ignored once.` : "Forced map cleared.");
  };

  if (!serverId) return null;

  const pollStatus = paused ? "Paused" : active ? "Active" : "Inactive";
  const leader = state?.activePoll?.options?.length
    ? [...state.activePoll.options].sort((a, b) => b.votes - a.votes)[0]
    : null;
  // A pending request the worker hasn't picked up yet. Worth showing: it explains why pressing a
  // button appears to have done nothing for a few seconds.
  const pending = [
    state?.startNow && "starting a new vote",
    state?.resyncNow && "re-reading the map list",
    state?.reroll && "drawing new options",
    state?.skipNext && "skipping this vote",
    state?.sendMessageLayout && "sending the in-game message",
  ].filter(Boolean).join(", ");

  return (
    <Panel
      id="mapvote-control"
      caps="open"
      title="Map vote"
      subtitle={server?.name}
      actions={<button className="ghost" onClick={load} disabled={Boolean(busy)}>Refresh</button>}
    >
      <ActionResult ok={last} error={err || loadErr} />
      {!data && !loadErr && <SkeletonLines lines={3} />}

      {data && !data.enabled && (
        <Callout variant="warn">
          The map vote is switched off, so nothing is posted and no map is changed. Turn it on under{" "}
          <GoTo view="maps" tab="votesetup">Vote setup</GoTo>.
        </Callout>
      )}
      {/* Only the Discord surface needs a channel — an in-game vote lives in chat, and this
          warning against a deliberately empty channel box read as a broken setup. */}
      {data && data.enabled && !data.channelId && data.surface !== "ingame" && (
        <Callout variant="warn">
          No Discord channel is set, so the poll has nowhere to go. Set one under{" "}
          <GoTo view="maps" tab="votesetup">Vote setup</GoTo>.
        </Callout>
      )}
      <ObserveBanner server={server}>Vote controls are the writes that get refused.</ObserveBanner>

      {data && (
        <>
          {/* The status block: the same fields the old bot's home embed showed, in the same order. */}
          <div className="setting-card">
            <StatusRow label="Profile">
              {data.activeProfile
                ? <>{data.activeProfile}{data.activeProfileCount != null && <span className="hint"> · at {data.activeProfileCount} players</span>}</>
                : data.activeProfileNeedsCount
                  ? <span className="muted">depends on the player count, which isn&apos;t known right now</span>
                  : <span className="muted">none matched — the built-in default pool is in use</span>}
              {/* The set the OPEN vote was built from, when it differs from the one in charge now
                  (the count or the clock moved since it opened). */}
              {state?.activePoll?.profile && state.activePoll.profile !== data.activeProfile && (
                <span className="hint"> · this vote was built from {state.activePoll.profile}</span>
              )}
            </StatusRow>
            <StatusRow label="Poll">
              <strong>{pollStatus}</strong>
              {paused && state?.pauseReason && <span className="hint"> · {state.pauseReason}</span>}
              {active && state?.activePoll?.totalVotes !== undefined && (
                <span className="hint"> · {state.activePoll.totalVotes} vote{state.activePoll.totalVotes === 1 ? "" : "s"} cast</span>
              )}
            </StatusRow>
            {/* When the vote last saw a match end — a vote stuck on one match is visible here, not
                only as a timed-out card in Discord. */}
            {active && state?.activePoll?.openedAt && (
              <StatusRow label="Opened"><Time iso={state.activePoll.openedAt} /></StatusRow>
            )}
            <StatusRow label="Last match end">
              {state?.lastMatchEndAt ? <Time iso={state.lastMatchEndAt} /> : <span className="muted">none seen yet</span>}
            </StatusRow>
            {active && (
              <StatusRow label="Leader">
                {leader && leader.votes > 0
                  ? <>{nameOf.get(leader.id) ?? leader.name} <span className="hint">· {leader.votes} vote{leader.votes === 1 ? "" : "s"}</span></>
                  : <span className="muted">nobody has voted yet</span>}
              </StatusRow>
            )}
            <StatusRow label="Next map">
              {hasOverride
                ? <><strong>{mapName(state?.overrideMapId)}</strong> <span className="hint">· forced by staff</span></>
                : state?.liveAppliedMapId
                  ? <>{mapName(state.liveAppliedMapId)} <span className="hint">· from the vote so far</span></>
                  : <>
                      <span className="muted">whatever the rotation says</span>
                      {/* The worker knows exactly why it is not queueing the leader — say it here
                          rather than leaving staff to guess whether the vote is even working. */}
                      {state?.liveApplyNote && <span className="hint"> · {state.liveApplyNote}</span>}
                    </>}
            </StatusRow>
            {pending && <StatusRow label="Working on"><span className="hint">{pending}…</span></StatusRow>}
          </div>

          {canManage && <AskNotice capability="mapvote.config" serverId={serverId} />}
          {/* Every action, always visible, disabled with a reason rather than hidden — the old bot's rule. */}
          <div className="actions" style={{ marginTop: 10, flexWrap: "wrap", gap: 6 }}>
            <button onClick={startVote} disabled={!canManage || busy === "start"}>
              {busy === "start" ? "Starting…" : "Start vote"}
            </button>
            <button className="ghost" onClick={() => act("pause", "pause", { paused: true }, "Map voting is paused.")}
              disabled={!canManage || paused || Boolean(busy)}
              title={paused ? "Already paused" : "Close the poll and post a paused notice"}>Pause</button>
            <button className="ghost" onClick={() => act("resume", "pause", { paused: false }, "Map voting resumed.")}
              disabled={!canManage || !paused || Boolean(busy)}
              title={paused ? "Repost the saved poll options" : "Not paused"}>Resume</button>
            <button className="ghost" onClick={reroll}
              disabled={!canManage || !active || paused || Boolean(busy)}
              title={active ? "Close this poll and draw a different set of maps" : "No poll is open"}>New options</button>
            <button className="ghost" onClick={skip}
              disabled={!canManage || !active || Boolean(busy)}
              title={active ? "Close the poll without applying a winner" : "No poll is open"}>Skip vote</button>
            <button className="ghost" onClick={resync}
              disabled={!canManage || Boolean(busy)}
              title="Re-read the server's map list, then open a fresh vote">Re-read maps</button>
          </div>

          <div className="actions" style={{ marginTop: 6, flexWrap: "wrap", gap: 6 }}>
            <button className="ghost" onClick={() => announce("map_list")}
              disabled={!canManage || !active || paused || Boolean(busy)}
              title={active ? "Broadcast the map names to everyone in game" : "No poll is open"}>Tell players: maps</button>
            <button className="ghost" onClick={() => announce("vote_counts")}
              disabled={!canManage || !active || paused || Boolean(busy)}
              title={active ? "Broadcast the current standings to everyone in game" : "No poll is open"}>Tell players: standings</button>
            <button className="ghost" onClick={() => setPicking((v) => !v)}
              disabled={!canManage || Boolean(busy)}
              title="Force the next map, ignoring the vote once">{picking ? "Cancel" : "Force next map"}</button>
            <button className="ghost" onClick={() => setOverride(null)}
              disabled={!canManage || !hasOverride || Boolean(busy)}
              title={hasOverride ? "Let the vote decide again" : "No map is forced"}>Clear forced map</button>
          </div>

          {picking && (
            <div style={{ marginTop: 8 }}>
              {/* The old bot offered the current poll options first and the full list second, because picking
                  one of the maps players are already looking at is the common case. */}
              {active && state?.activePoll?.options?.length ? (
                <>
                  <p className="hint" style={{ marginBottom: 4 }}>From the poll players are voting on:</p>
                  <div className="actions" style={{ marginTop: 0, flexWrap: "wrap", gap: 6 }}>
                    {state.activePoll.options.map((o) => (
                      <button key={o.id} className="ghost" onClick={() => setOverride(o.id)} disabled={state.overrideMapId === o.id}>
                        {nameOf.get(o.id) ?? o.name}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
              <p className="hint" style={{ marginTop: 8, marginBottom: 4 }}>Or any map on the server:</p>
              <MapPicker
                catalogue={catalogue}
                multiple={false}
                value={state?.overrideMapId ? [state.overrideMapId] : []}
                onChange={(v) => setOverride(v[0] ?? null)}
                disabled={!canManage}
                placeholder="Search a map to force next…"
              />
            </div>
          )}

          {/* The tally, in the order players see it change: most votes first. */}
          {active && state?.activePoll && state.activePoll.options.length > 0 && (() => {
            const opts = [...state.activePoll.options].sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));
            const top = Math.max(1, ...opts.map((o) => o.votes));
            return (
              <div style={{ marginTop: 12 }}>
                {opts.map((o) => (
                  <div key={o.id} className="row" style={{ alignItems: "center", gap: 10, marginBottom: 4 }}>
                    <span style={{ flex: "0 0 42%", fontSize: "0.88rem" }}>{nameOf.get(o.id) ?? o.name}</span>
                    <span className="breakdown-track grow"><span className="breakdown-fill" style={{ width: `${Math.round((o.votes / top) * 100)}%` }} /></span>
                    <span className="hint" style={{ flex: "0 0 62px", textAlign: "right" }}>{o.votes} vote{o.votes === 1 ? "" : "s"}</span>
                  </div>
                ))}
              </div>
            );
          })()}

          {!active && !paused && data.enabled && (
            <p className="hint" style={{ marginTop: 10 }}>
              No poll is open. One opens on its own when the next match ends, or press <strong>Start vote</strong>.
            </p>
          )}
          {!active && state?.lastOpenError && (
            <p className="error">
              The worker tried and couldn't open one: {state.lastOpenError}
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

export default MapVoteControl;
