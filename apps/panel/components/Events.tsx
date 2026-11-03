"use client";
/**
 * Scheduled events — named windows whose boundaries resolve themselves (docs/bulk-payout.md
 * step 6, grown into its own surface). Each side is either a hard time or "the next match
 * boundary at/after" an anchor, so an 8pm event can start with the first fresh round after 8
 * and end when the round running at 11 finishes. Past times are legal: presence was recorded
 * regardless, so a window over last night resolves on the spot.
 *
 * An event can also PIN one of its server's map-vote profiles for its duration — event maps
 * while the event runs, whatever the schedule would have chosen.
 */
import { useCallback, useEffect, useState } from "react";
import { api, fmt } from "../lib/api";
import { canOnServer, type ClientGrant } from "../lib/access";
import { useServers } from "../lib/servers";
import { effectiveZone, isoToWall, wallToIso, zoneLabel } from "../lib/time";
import { ActionResult, AskNotice, Callout, Divider, EmptyState, Pager, SkeletonRows, Toggle } from "./ui";
import { usePagedList } from "../lib/paged";
import { Panel, PanelGroup } from "./Panel";

export interface PayoutEvent {
  id: string; name: string; serverId: string; status: "scheduled" | "open" | "closed" | "cancelled";
  openMode: "at" | "match_start_after"; openAnchor: string; openedAt: string | null;
  closeMode: "at" | "match_end_after"; closeAnchor: string; closedAt: string | null;
  minMinutes: number; mapVoteProfile: string | null; rotationSetId: string | null;
  roster: { playerId: string; name: string | null; minutes: number }[] | null;
  createdBy: string; createdAt: string;
  /** The events list adds these two (single-event answers do not). serverName is the staff
   *  nickname when one is set, and null once the server has been deleted — or, for anyone but
   *  the setup account, decommissioned. */
  serverName?: string | null;
  payment?: EventPayment | null;
  /** Set when staff marked this finished event as needing no payout, with who did; both null once
   *  the mark is undone. Clears "Awaiting payment" without unmaking the event, which stays closed. */
  noPayoutAt?: string | null;
  noPayoutBy?: string | null;
}

/**
 * Whether an event has been paid, from the payouts made for it (@app/payout's `eventPayments`):
 * a state and a count, never amounts — reading events does not take the payout permission. Null
 * when nobody has paid it yet. `part` = a payout left people unpaid, which its retry on the
 * Payouts tab pays; `at` = when the running run started, or when the latest one finished.
 */
export interface EventPayment { state: "paying" | "paid" | "part"; unpaid: number; at: string }

// Typed times are read in the DISPLAY zone (wallToIso): "7:30 PM" means 7:30 the community's
// time — or the zone this admin chose in Settings — never whatever the device happens to be on.

export default function Events({ canRun, grants, onPay }: {
  /** events.manage write — schedule and cancel. Reading the list only needs read. */
  canRun: boolean;
  /** Raw grants, because pinning a map-vote profile is scoped to ONE server — see below. */
  grants: ClientGrant[];
  /** Hand an event to the Payouts tab ("Pay this event"). Absent = the button is not offered. */
  onPay?: (ev: PayoutEvent) => void;
}) {
  const { servers } = useServers();
  const [name, setName] = useState("");
  const [serverId, setServerId] = useState("");
  const [openMode, setOpenMode] = useState<"at" | "match_start_after">("match_start_after");
  const [openAnchor, setOpenAnchor] = useState("");
  const [closeMode, setCloseMode] = useState<"at" | "match_end_after">("match_end_after");
  const [closeAnchor, setCloseAnchor] = useState("");
  const [minMinutes, setMinMinutes] = useState("0");
  const [mapVoteProfile, setMapVoteProfile] = useState("");
  /** Profile names for the chosen server; null = could not read them (no mapvote.config grant),
   *  in which case the pin field falls back to free text and the server validates the name. */
  const [profiles, setProfiles] = useState<string[] | null>(null);
  const [rotationSetId, setRotationSetId] = useState("");
  /** This game's library sets, with the lineup size when one is applicable to a rotation; null =
   *  no rotation grant on this server, so the field is not offered at all. */
  const [rotationSets, setRotationSets] = useState<{ id: string; name: string; lineup: number | null }[] | null>(null);
  const [rotationSetsErr, setRotationSetsErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  /** The event being edited, or null while the form is creating a new one. */
  const [editing, setEditing] = useState<PayoutEvent | null>(null);

  // The events a page at a time, newest first as the API keeps them. It read the newest fifty and
  // no more, so an event older than that could not be found here at all.
  const fetchPage = useCallback((offset: number, limit: number) =>
    api<{ items?: PayoutEvent[]; total?: number }>(`/payout-events?offset=${offset}&limit=${limit}`)
      .then((r) => ({ items: r.items ?? [], total: r.total ?? null })), []);
  const list = usePagedList<PayoutEvent>(fetchPage, "events.list");
  const events = list.items;
  // A list that could not be read says so where the form says what went wrong, as it did.
  useEffect(() => { if (list.error) setErr(list.error); }, [list.error]);

  useEffect(() => {
    // Editing loads the event's own pin, so clearing here would wipe it the moment the server
    // resolves. Only a fresh form starts blank.
    if (!editing) setMapVoteProfile("");
    // No sight of this server's vote means no pin field, so there is nothing to populate — and
    // asking anyway would be a 403 per server change in everyone's log for a control they never see.
    if (!serverId || !canOnServer(grants, "mapvote.config", serverId, "read")) { setProfiles(null); return; }
    // Guarded: the pin names a profile ON THIS SERVER, and two server switches in quick succession
    // can land the first server's answer second — leaving the picker offering profiles the chosen
    // server has never heard of. Pinning one of those is a silent failure much later, at the vote:
    // the worker finds no such profile and quietly falls back to the schedule.
    let live = true;
    api<{ profiles?: { name?: string }[] }>(`/servers/${serverId}/mapvote/config`)
      .then((r) => { if (live) setProfiles((r.profiles ?? []).map((p) => p.name ?? "").filter(Boolean)); })
      .catch(() => { if (live) setProfiles(null); });
    return () => { live = false; };
    // `editing` deliberately absent: it changes with the same click that sets serverId, and
    // re-running this on it would race the load below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, grants]);

  useEffect(() => {
    // Same shape as the vote pin above: the rotation set applies to ONE server's rotation, so the
    // field exists only with sight of maps.rotation there, and a stale answer must not outlive a switch.
    if (!editing) setRotationSetId("");
    if (!serverId || !canOnServer(grants, "maps.rotation", serverId, "read")) { setRotationSets(null); setRotationSetsErr(""); return; }
    let live = true;
    api<{ sets?: { id: string; name: string; lineup: number | null }[] }>(`/servers/${serverId}/maprotation/sets`)
      .then((r) => { if (live) { setRotationSets(r.sets ?? []); setRotationSetsErr(""); } })
      .catch((e) => { if (live) { setRotationSets(null); setRotationSetsErr((e as Error).message); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, grants]);

  const blank = () => {
    setEditing(null); setName(""); setOpenAnchor(""); setCloseAnchor(""); setMapVoteProfile(""); setRotationSetId("");
    setMinMinutes("0"); setOpenMode("match_start_after"); setCloseMode("match_end_after");
  };

  /** Load an event into the form. The window fields are wall times in the DISPLAY zone, the same
   *  clock they were typed on, so an edit shows what was scheduled rather than a UTC translation. */
  const edit = (ev: PayoutEvent) => {
    setEditing(ev);
    setErr(""); setOk("");
    setName(ev.name);
    setServerId(ev.serverId);
    setOpenMode(ev.openMode); setOpenAnchor(isoToWall(ev.openAnchor));
    setCloseMode(ev.closeMode); setCloseAnchor(isoToWall(ev.closeAnchor));
    setMinMinutes(String(ev.minMinutes ?? 0));
    setMapVoteProfile(ev.mapVoteProfile ?? "");
    setRotationSetId(ev.rotationSetId ?? "");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const save = () => {
    setBusy(true); setErr(""); setOk("");
    const running = editing?.status === "open";
    const body: Record<string, unknown> = {
      name,
      closeMode, closeAnchor: wallToIso(closeAnchor),
      minMinutes: Number(minMinutes) || 0,
      mapVoteProfile: mapVoteProfile || null,
      rotationSetId: rotationSetId || null,
      // An open event's start and server are settled — the API refuses them outright, so the
      // form does not send what it is already hiding.
      ...(running ? {} : { serverId, openMode, openAnchor: wallToIso(openAnchor) }),
    };
    const req = editing
      ? api<{ event: PayoutEvent }>(`/payout-events/${editing.id}`, { method: "PATCH", body })
      : api<{ event: PayoutEvent }>("/payout-events", { method: "POST", body: { ...body, serverId, openMode, openAnchor: wallToIso(openAnchor) } });
    req
      .then((r) => {
        setOk(editing
          ? `"${r.event.name}" updated — it is ${r.event.status}.`
          : r.event.status === "closed"
            ? `"${r.event.name}" covered a finished window and resolved immediately — ready to pay.`
            : `"${r.event.name}" is ${r.event.status}.`);
        blank();
        // A new event is the newest, at the top of page one; an edited one is where it was.
        if (editing) list.refresh(); else list.reload();
      })
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  };

  const cancel = (ev: PayoutEvent) => {
    api(`/payout-events/${ev.id}/cancel`, { method: "POST" }).then(list.refresh).catch((e) => setErr(e.message));
  };

  /** A finished event is never cancelled — it is a record, with a report — so an event nobody
   *  means to pay is marked instead, and the mark can be taken back. */
  const setNoPayout = (ev: PayoutEvent, noPayout: boolean) => {
    api(`/payout-events/${ev.id}/no-payout`, { method: "POST", body: { noPayout } }).then(list.refresh).catch((e) => setErr(e.message));
  };

  const running = editing?.status === "open";
  const canCreate = canRun && name.trim() && serverId
    && (running || (wallToIso(openAnchor) && wallToIso(closeAnchor)))
    && (!running || wallToIso(closeAnchor));

  /**
   * Pinning a profile is a MAP-VOTE power: without `mapvote.config` write ON THIS SERVER the API
   * sends the event for approval to someone holding it there. The field shows to whoever can see
   * that server's vote profiles at all — scheduling rights alone, with no sight of them, get none.
   */
  const canPinMaps = !!serverId && canOnServer(grants, "mapvote.config", serverId, "read");

  return (
    <PanelGroup viewId="events">
      <Panel id="events-schedule" title="Scheduled events"
        subtitle="Windows that open and close themselves — on the clock, or on match boundaries." caps="events.manage">
        {canRun && (<>
          <AskNotice capability="events.manage" />
          {editing && (
            <Callout variant="info">
              Editing <strong>{editing.name}</strong>{running ? " — it is running now, so its start and its server are settled; the close time, name, minutes and map pin can still change." : "."}
            </Callout>
          )}
          <div className="form-row">
            <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Friday night event" maxLength={120} /></label>
            <label>Server
              <select value={serverId} onChange={(e) => setServerId(e.target.value)} disabled={running}>
                <option value="">Pick a server…</option>
                {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label>Present at least (minutes)
              <input type="number" min={0} value={minMinutes} onChange={(e) => setMinMinutes(e.target.value)} />
            </label>
          </div>
          <div className="form-row">
            <label>Opens
              <select value={openMode} onChange={(e) => setOpenMode(e.target.value as typeof openMode)} disabled={running}>
                <option value="match_start_after">with the first match starting at/after</option>
                <option value="at">at exactly</option>
              </select>
            </label>
            <label>Open time ({zoneLabel()})<input type="datetime-local" value={openAnchor} onChange={(e) => setOpenAnchor(e.target.value)} disabled={running} /></label>
            <label>Closes
              <select value={closeMode} onChange={(e) => setCloseMode(e.target.value as typeof closeMode)}>
                <option value="match_end_after">when the match running at that time ends</option>
                <option value="at">at exactly</option>
              </select>
            </label>
            <label>Close time ({zoneLabel()})<input type="datetime-local" value={closeAnchor} onChange={(e) => setCloseAnchor(e.target.value)} /></label>
          </div>
          <p className="muted fs-sm" style={{ marginTop: 2 }}>
            Times are read in {effectiveZone()} — change it under Settings, or set your own zone there.
          </p>
          <div className="form-row">
            {canPinMaps && (profiles !== null ? (
              <label>Map vote during the event
                <select value={mapVoteProfile} onChange={(e) => setMapVoteProfile(e.target.value)} disabled={!serverId}>
                  <option value="">Leave the schedule in charge</option>
                  {profiles.map((n) => <option key={n} value={n}>{n} (pinned while open)</option>)}
                </select>
              </label>
            ) : (
              <label>Map vote profile to pin (optional)
                <input value={mapVoteProfile} onChange={(e) => setMapVoteProfile(e.target.value)}
                  placeholder="profile name, or leave blank" disabled={!serverId} />
              </label>
            ))}
            {/* The field needs the list to pick from; when the list couldn't be read, say so where
                the field would be rather than leaving it out without a word. */}
            {rotationSetsErr && <p className="hint">Rotation when the event starts: couldn&apos;t read the saved rotations ({rotationSetsErr}).</p>}
            {rotationSets !== null && (
              <label>Rotation when the event starts
                <select value={rotationSetId} onChange={(e) => setRotationSetId(e.target.value)} disabled={!serverId}>
                  <option value="">Leave the rotation alone</option>
                  {rotationSets.map((st) => (
                    <option key={st.id} value={st.id} disabled={st.lineup === null}>
                      {st.name}{st.lineup === null ? " (vote recipe — no lineup)" : ` (${st.lineup} maps)`}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button className="primary" onClick={save} disabled={busy || !canCreate}>
              {editing ? "Save changes" : "Schedule event"}
            </button>
            {editing && <button className="quiet" onClick={blank} disabled={busy}>Cancel edit</button>}
          </div>
          <ActionResult ok={ok} error={err} />
        </>)}
        {!canRun && <ActionResult ok="" error={err} />}

        {events === null ? <SkeletonRows rows={3} cols={7} /> : events.length === 0
          ? <EmptyState title="No events yet">Schedule one for later, or point a window at last night — both work.</EmptyState>
          : (
            <div className="scroll-x">
              <table className="data">
                <thead><tr><th>Event</th><th>Server</th><th>Payment</th><th>Status</th><th>Window</th><th>Maps</th><th>Who</th><th /></tr></thead>
                <tbody>
                  {events.map((ev) => {
                    const server = ev.serverName ?? servers.find((s) => s.id === ev.serverId)?.name ?? null;
                    return (
                      <tr key={ev.id}>
                        <td>{ev.name}</td>
                        {/* The clamp goes on a block inside the cell: on the <td> itself its
                            display rule unmakes the table cell, and the row's borders split. */}
                        {server
                          ? <td><div className="server-cell" title={server}>{server}</div></td>
                          : <td className="muted">a removed server</td>}
                        <PaymentCell ev={ev} />
                        <td>{ev.status}</td>
                        <td className="muted">
                          {ev.openedAt ? fmt(ev.openedAt) : `${ev.openMode === "at" ? "at" : "first match after"} ${fmt(ev.openAnchor)}`}
                          {" → "}
                          {ev.closedAt ? fmt(ev.closedAt) : `${ev.closeMode === "at" ? "at" : "match end after"} ${fmt(ev.closeAnchor)}`}
                        </td>
                        <td className="muted">{ev.mapVoteProfile ?? "—"}</td>
                        <td>{ev.roster ? `${ev.roster.length} present` : ev.status === "open" ? "counting…" : "—"}</td>
                        <td className="row-actions">
                          {/* Paying is the payout grant, not the scheduling one: the hub hands `onPay`
                              down only to someone who holds it. */}
                          {onPay && (ev.status === "open" || ev.status === "closed") && (
                            <button className="quiet" onClick={() => onPay(ev)}>Pay this event</button>
                          )}
                          {/* Offered where the column says "Awaiting payment", and to take the mark
                              back; once a payout has run, the payout is what the column shows. */}
                          {canRun && ev.status === "closed" && !ev.payment && (ev.noPayoutAt
                            ? <button className="quiet" onClick={() => setNoPayout(ev, false)}>Needs a payout</button>
                            : ev.roster?.length !== 0 && <button className="quiet" onClick={() => setNoPayout(ev, true)}>No payout needed</button>)}
                          {canRun && (ev.status === "scheduled" || ev.status === "open") && (
                            <button className="quiet" onClick={() => edit(ev)}>Edit</button>
                          )}
                          {canRun && (ev.status === "scheduled" || ev.status === "open") && (
                            <button className="quiet" onClick={() => cancel(ev)}>Cancel</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        {events !== null && events.length > 0 && <Pager list={list} noun="event" />}
      </Panel>

      <Panel id="events-post" title="Post the list to Discord"
        subtitle="Unix timestamps, so every reader sees the times on their own clock." caps="events.manage"
        defaultCollapsed>
        <EventsPost canRun={canRun} />
      </Panel>
    </PanelGroup>
  );
}

/**
 * The Payment column. A closed event nobody has paid is the one that wants doing, so it and a
 * payout that left people unpaid are the two that stand out; the rest read as plain text. The
 * details stay on one line each so a phone reads them without a tooltip.
 */
function PaymentCell({ ev }: { ev: PayoutEvent }) {
  const p = ev.payment;
  if (p?.state === "paying") return <td>Paying…</td>;
  if (p?.state === "paid") return <td>✓ Paid<div className="muted fs-sm">{fmt(p.at)}</div></td>;
  if (p?.state === "part") {
    return (
      <td title="Retry failures (or Pay the rest) on the Payouts tab pays only the people it did not reach.">
        <span className="badge warn-badge">Part paid</span>
        <div className="muted fs-sm">{p.unpaid} unpaid</div>
      </td>
    );
  }
  // Staff decided this one is not being paid. A payout made anyway still shows above.
  if (ev.noPayoutAt) {
    return <td className="muted">No payout needed{ev.noPayoutBy && <div className="fs-sm">marked by {ev.noPayoutBy}</div>}</td>;
  }
  // Nobody on the roster is nobody to pay: a payout would be refused for want of recipients, so
  // "awaiting" would ask for something that can never be done.
  if (ev.status === "closed" && ev.roster?.length === 0) return <td className="muted">Nobody to pay</td>;
  if (ev.status === "closed") return <td><span className="badge warn-badge">Awaiting payment</span></td>;
  return <td className="muted">{ev.status === "open" ? "Not paid yet" : "—"}</td>;
}

interface PostConfig {
  enabled: boolean; channelId: string; daysAhead: number;
  weekday: number; atHour: number; atMinute: number; lastPostedOn: string | null;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The events list as a Discord post: one press now, or the same post sent by itself on a chosen
 * day and time.
 *
 * The preview is the real message — the API composes it from the same builder the automatic post
 * uses — so what is on screen is what the channel gets, `<t:…>` markup and all. Discord renders
 * those in each reader's own zone, which is the whole reason this is not a formatted date.
 */
function EventsPost({ canRun }: { canRun: boolean }) {
  const [cfg, setCfg] = useState<PostConfig | null>(null);
  const [botConfigured, setBot] = useState(true);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  useEffect(() => {
    api<{ config: PostConfig; botConfigured: boolean }>("/payout-events/post-config")
      .then((r) => { setCfg(r.config); setBot(r.botConfigured); })
      .catch((e) => setErr(e.message));
  }, []);

  const patch = (p: Partial<PostConfig>) => {
    setBusy(true); setErr(""); setOk("");
    api<{ config: PostConfig }>("/payout-events/post-config", { method: "PUT", body: p })
      .then((r) => { setCfg(r.config); setOk("Saved."); })
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  };

  const run = (send: boolean) => {
    setBusy(true); setErr(""); setOk("");
    api<{ message: string; posted: boolean }>("/payout-events/post", {
      method: "POST", body: { days: cfg?.daysAhead, preview: !send },
    })
      .then((r) => { setPreview(r.message); if (r.posted) setOk("Posted to Discord."); })
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  };

  if (!cfg) return err ? <ActionResult error={err} /> : <SkeletonRows rows={2} cols={3} />;
  return (
    <>
      {!botConfigured && <Callout variant="warn">No Discord bot token is configured on the API, so nothing can be posted yet.</Callout>}
      <div className="form-row">
        <label>Include events within (days)
          <input type="number" min={1} max={92} value={cfg.daysAhead} disabled={!canRun || busy}
            onChange={(e) => setCfg({ ...cfg, daysAhead: Number(e.target.value) })}
            onBlur={(e) => patch({ daysAhead: Number(e.target.value) })} />
        </label>
        <label>Channel
          <input value={cfg.channelId} placeholder="Discord channel id" disabled={!canRun || busy}
            onChange={(e) => setCfg({ ...cfg, channelId: e.target.value })}
            onBlur={(e) => patch({ channelId: e.target.value })} />
        </label>
        <button onClick={() => run(false)} disabled={busy}>Preview</button>
        <button className="primary" onClick={() => run(true)} disabled={!canRun || busy || !cfg.channelId}>Post now</button>
      </div>

      <div className="form-row">
        <Toggle checked={cfg.enabled} disabled={!canRun || busy}
          onChange={(v) => patch({ enabled: v })} label="Post this automatically" />
        <label>On
          <select value={cfg.weekday} disabled={!canRun || busy} onChange={(e) => patch({ weekday: Number(e.target.value) })}>
            <option value={-1}>every day</option>
            {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}s</option>)}
          </select>
        </label>
        <label>At ({zoneLabel()})
          <input type="time" value={`${String(cfg.atHour).padStart(2, "0")}:${String(cfg.atMinute).padStart(2, "0")}`}
            disabled={!canRun || busy}
            onChange={(e) => {
              const [h, m] = e.target.value.split(":").map(Number);
              if (Number.isInteger(h) && Number.isInteger(m)) patch({ atHour: h!, atMinute: m! });
            }} />
        </label>
      </div>
      <p className="muted fs-sm" style={{ marginTop: 2 }}>
        {cfg.enabled
          ? `The next ${cfg.daysAhead} days of events go out ${cfg.weekday < 0 ? "every day" : `every ${WEEKDAYS[cfg.weekday]}`} at ${String(cfg.atHour).padStart(2, "0")}:${String(cfg.atMinute).padStart(2, "0")} on the community clock${cfg.lastPostedOn ? ` — last sent ${cfg.lastPostedOn}.` : "."}`
          : "Automatic posting is off — the Post now button still works."}
      </p>
      <ActionResult ok={ok} error={err} />

      {preview !== null && (<>
        <Divider label="What will be posted" />
        {/* The raw message, markup included: `<t:…>` is what makes each reader see their own
            clock, and hiding it here would make the one thing worth checking invisible. */}
        <pre className="pre-wrap fs-sm">{preview}</pre>
      </>)}
    </>
  );
}
