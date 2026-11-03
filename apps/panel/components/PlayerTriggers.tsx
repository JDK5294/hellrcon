"use client";
import { useMemo, useRef, useState } from "react";
import { api, fmt, wasFiled } from "../lib/api";
import { useResource } from "../lib/resource";
import { isPickedPlayer, useRemembered } from "../lib/remembered";
import { useClientPages } from "../lib/paged";
import { useAlert, useConfirm } from "../lib/feedback";
import { useServers } from "../lib/servers";
import { ActionResult, EmptyState, Pager, SkeletonRows, Toggle, Explanation } from "./ui";
import { PanelGroup, Panel } from "./Panel";
import { PlayerPicker, type PickedPlayer } from "./PlayerPicker";
import { Time } from "./Time";
import { PlaceholderHint } from "./Placeholders";
import { RoleChips, StateTriggerParams } from "./StateTriggerParams";
import { NumField } from "./NumField";
import { useGameDescriptor } from "../lib/game";
import { ROSTER_CLEAR_MINUTES, ROSTER_CONDITIONS, ROSTER_DEFAULTS, isRosterCondition, rosterKindOf, type RosterCondition } from "../lib/rosterConditions";

type Event = "connect" | "disconnect" | "kill" | "teamkill" | "chat" | "death" | "teamkilled" | "kicked" | "banned" | "punished"
  | "teamswitch" | "weaponkill" | "camenter" | "camexit" | "votestart" | "votecast" | "afk" | RosterCondition;
type Action = "message" | "kick" | "punish" | "tempban" | "permaban" | "vip" | "vipremove" | "points" | "takepoints" | "switch" | "watch";

interface Step {
  action: Action;
  message: string | null;
  hours: number;
  points: number;
  delaySec: number;
}
interface Trigger {
  id: string;
  playerId: string;
  playerName: string | null;
  event: Event;
  /** what the event needs beyond itself — the weapons a weapon-kill trigger listens for, a roster
   *  condition's settings. */
  params?: Record<string, unknown>;
  steps: Step[];
  fireOnce: boolean;
  enabled: boolean;
  note: string | null;
  serverId: string | null;
  serverName: string | null;
  createdByName: string;
  createdAt: string;
  firedCount: number;
  lastFiredAt: string | null;
  disarmedAt: string | null;
  updatedAt?: string | null;
  updatedByName?: string | null;
  summary: string;
}

const EVENTS: { id: Event; label: string }[] = [
  { id: "connect", label: "connects" },
  { id: "disconnect", label: "disconnects" },
  { id: "kill", label: "gets a kill" },
  { id: "death", label: "dies (is killed)" },
  { id: "teamkill", label: "team-kills" },
  { id: "teamkilled", label: "gets team-killed" },
  { id: "chat", label: "sends chat" },
  { id: "kicked", label: "gets kicked" },
  { id: "banned", label: "gets banned" },
  { id: "teamswitch", label: "switches team" },
  { id: "weaponkill", label: "gets a kill with a chosen weapon" },
  { id: "camenter", label: "goes on the admin camera" },
  { id: "camexit", label: "comes off the admin camera" },
  { id: "votestart", label: "starts a vote" },
  { id: "votecast", label: "votes in a vote" },
  { id: "afk", label: "goes AFK (no kills for a while)" },
];
/** How long an AFK trigger waits for a kill when nobody changes it — the API's AFK_DEFAULT_MINUTES. */
const AFK_DEFAULT_MINUTES = 10;
const ACTIONS: { id: Action; label: string }[] = [
  { id: "message", label: "Send a message" },
  { id: "kick", label: "Kick" },
  { id: "punish", label: "Punish" },
  { id: "tempban", label: "Temp ban" },
  { id: "permaban", label: "Perma ban" },
  { id: "switch", label: "Switch team" },
  { id: "vip", label: "Grant VIP" },
  { id: "vipremove", label: "Remove VIP" },
  { id: "points", label: "Grant points" },
  { id: "takepoints", label: "Take points" },
  { id: "watch", label: "Add to watchlist" },
];
const needsMessage = (a: Action) => a === "message";
const needsReason = (a: Action) => a === "kick" || a === "punish" || a === "tempban" || a === "permaban";
const needsWatchReason = (a: Action) => a === "watch";
const needsPoints = (a: Action) => a === "points" || a === "takepoints";
// The kill-shaped events carry who did it, to whom, and with what — the trigger's own tokens
// ({attacker_name} on a death trigger is who killed them), on top of the shared placeholders.
const KILL_EVENTS: Event[] = ["kill", "death", "teamkill", "teamkilled", "weaponkill"];
/** What an event is called in the builder, from either list. */
const eventLabel = (e: Event) => EVENTS.find((x) => x.id === e)?.label ?? ROSTER_CONDITIONS.find((x) => x.id === e)?.label ?? e;

export default function PlayerTriggers() {
  const confirm = useConfirm();
  // A list row's button that fails says why in a dialog — not in the builder's error line, which
  // sits above the form, out of sight of the list and about something else.
  const alert = useAlert();
  const { servers } = useServers();
  // The player whose triggers are on screen, kept for the sitting like every screen's picked player.
  const [picked, setPicked] = useRemembered<PickedPlayer | null>("triggers.player", null, isPickedPlayer, "session");
  // The trigger being re-edited, or null when the builder makes a new one.
  const [editing, setEditing] = useState<Trigger | null>(null);
  const [rearm, setRearm] = useState(true);
  const builderRef = useRef<HTMLFieldSetElement>(null);

  const loader = useMemo(
    () => (picked ? () => api<{ triggers: Trigger[]; allowedActions: Action[]; game?: string; rosterEvents?: string[] }>(`/players/${encodeURIComponent(picked.playerId)}/triggers`) : null),
    [picked],
  );
  const { data, error, reload } = useResource(loader);
  const triggers = data?.triggers;
  const allowed = useMemo(() => new Set(data?.allowedActions ?? []), [data]);
  // The roster conditions read roles in the PLAYER's game, and offer only the conditions that game
  // has (the API says which); until the list loads, all of them.
  const playerGame = useGameDescriptor(data?.game);
  const offeredConditions = data?.rosterEvents ? new Set(data.rosterEvents) : null;
  // The overview: EVERY player's triggers, armed first — so an armed trigger is findable without
  // remembering whose it was. Loaded regardless of the picker, refreshed after every mutation.
  const allLoader = useMemo(() => () => api<{ triggers: Trigger[] }>("/player-triggers"), []);
  const { data: allData, error: allError, reload: reloadAll } = useResource(allLoader);
  // Both lists a page at a time, in the order the API keeps them (armed first); nothing until read.
  const allPages = useClientPages(allData ? allData.triggers ?? [] : null, "triggers.all");
  const playerPages = useClientPages(triggers ?? null, picked ? `triggers.${picked.playerId}` : undefined);

  // build form — a trigger is one event and a LIST of action steps, each with its own delay.
  interface FormStep { action: Action; message: string; hours: string; points: string; delaySec: string }
  const blankStep = (): FormStep => ({ action: "message", message: "", hours: "72", points: "100", delaySec: "0" });
  const [event, setEvent] = useState<Event>("connect");
  // The weapon-kill event's list: any part of a weapon's name, comma-separated.
  const [weapons, setWeapons] = useState("");
  // A roster condition's settings, in its Rules trigger's own shape.
  const [condition, setCondition] = useState<Record<string, unknown>>({});
  const [steps, setSteps] = useState<FormStep[]>([blankStep()]);
  const [serverId, setServerId] = useState(""); // "" = any server
  const [fireOnce, setFireOnce] = useState(true);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const patchStep = (i: number, patch: Partial<FormStep>) =>
    setSteps((prev) => prev.map((st, x) => (x === i ? { ...st, ...patch } : st)));

  const resetForm = () => {
    setEvent("connect"); setWeapons(""); setCondition({}); setSteps([blankStep()]); setServerId(""); setFireOnce(true); setNote(""); setFormError("");
  };
  /** Picking a roster condition starts it from its Rules trigger's defaults; AFK from its minutes. */
  const changeEvent = (next: Event) => {
    setEvent(next);
    setCondition(isRosterCondition(next) ? { ...ROSTER_DEFAULTS[next] } : next === "afk" ? { minutes: AFK_DEFAULT_MINUTES } : {});
  };
  /** Load a trigger into the builder to change it — its own player picked, every field as it is. */
  const startEdit = (t: Trigger) => {
    if (!picked || picked.playerId !== t.playerId) setPicked({ playerId: t.playerId, name: t.playerName ?? "" });
    setEditing(t);
    setEvent(t.event);
    setWeapons(String(t.params?.weapons ?? ""));
    setCondition(isRosterCondition(t.event) ? { ...ROSTER_DEFAULTS[t.event], ...(t.params ?? {}) }
      : t.event === "afk" ? { minutes: AFK_DEFAULT_MINUTES, ...(t.params ?? {}) } : {});
    setSteps(t.steps.map((st) => ({
      action: st.action, message: st.message ?? "",
      hours: st.hours > 0 ? String(st.hours) : "72", points: st.points > 0 ? String(st.points) : "100",
      delaySec: String(st.delaySec || 0),
    })));
    setServerId(t.serverId ?? "");
    setFireOnce(t.fireOnce);
    setNote(t.note ?? "");
    setRearm(true);
    setFormError("");
    requestAnimationFrame(() => builderRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
  const cancelEdit = () => { setEditing(null); resetForm(); };
  // Picking a different player abandons an edit — the builder is about whoever is picked.
  const pick = (next: PickedPlayer | null) => {
    if (editing && next?.playerId !== editing.playerId) cancelEdit();
    setPicked(next);
  };

  const create = async () => {
    if (!picked) return;
    setBusy(true); setFormError("");
    try {
      const path = editing
        ? `/players/${encodeURIComponent(editing.playerId)}/triggers/${editing.id}`
        : `/players/${encodeURIComponent(picked.playerId)}/triggers`;
      await api(path, {
        method: editing ? "PUT" : "POST",
        body: {
          event,
          params: event === "weaponkill" ? { weapons } : isRosterCondition(event) || event === "afk" ? condition : undefined,
          steps: steps.map((st) => ({
            action: st.action,
            message: needsMessage(st.action) || needsReason(st.action) || needsWatchReason(st.action) ? st.message : undefined,
            hours: st.action === "tempban" || st.action === "vip" ? Number(st.hours) : undefined,
            points: needsPoints(st.action) ? Number(st.points) : undefined,
            delaySec: Number(st.delaySec) || 0,
          })),
          serverId: serverId || undefined,
          fireOnce, note: note || undefined,
          ...(editing ? { rearm: editing.disarmedAt !== null && rearm } : {}),
        },
      });
      if (editing) { setEditing(null); resetForm(); } else { setSteps([blankStep()]); setNote(""); }
      reload(); reloadAll();
    } catch (err) { setFormError((err as Error).message); }
    finally { setBusy(false); }
  };

  // Addressed by the trigger's OWN player id, so the overview list can disable/delete rows for
  // players who are not the picked one.
  const toggle = async (t: Trigger) => {
    try { await api(`/players/${encodeURIComponent(t.playerId)}/triggers/${t.id}`, { method: "PATCH", body: { enabled: !t.enabled } }); reload(); reloadAll(); }
    catch (err) {
      if (wasFiled(err)) setFormError(err.message);
      else void alert({ title: `Couldn't ${t.enabled ? "disable" : "re-arm"} the trigger on ${t.playerName || t.playerId}`, body: (err as Error).message });
    }
  };
  const remove = async (t: Trigger) => {
    if (!(await confirm({ title: "Delete this trigger?", body: <p>{t.summary}</p>, confirmLabel: "Delete", danger: true }))) return;
    try {
      await api(`/players/${encodeURIComponent(t.playerId)}/triggers/${t.id}`, { method: "DELETE" });
      // Deleting the one open in the builder ends the edit — there is nothing left to save to.
      if (editing?.id === t.id) cancelEdit();
      reload(); reloadAll();
    }
    catch (err) {
      if (wasFiled(err)) setFormError(err.message);
      else void alert({ title: `Couldn't delete the trigger on ${t.playerName || t.playerId}`, body: (err as Error).message });
    }
  };

  return (
    <PanelGroup viewId="playertriggers">
      <Panel id="triggerbuild" caps="server.view" title="Player triggers"
        subtitle="When one player does something, fire an action — once, or every time">
        <Explanation>
          A trigger watches ONE player and follows them. The classic use: leave a message waiting so
          the next time they connect, they get it — once, then it disarms itself. Every action here
          is one you could do by hand; you can only build the ones your role already lets you do.
        </Explanation>
        <PlayerPicker value={picked} onChange={pick} placeholder="Pick the player this is about…" />

        {picked && (
          <fieldset ref={builderRef} className="vip-form" style={{ marginTop: 12 }}>
            {editing && (
              <p className="hint" style={{ marginTop: 0 }}>
                <b>Editing</b> — {editing.summary}. Saving replaces what it does; who made it and how
                many times it has fired stay as they are.
              </p>
            )}
            <div className="control-row" style={{ flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <span className="muted">When</span>
              <b>{picked.name || picked.playerId.slice(0, 12) + "…"}</b>
              <select aria-label="When" value={event} onChange={(e) => changeEvent(e.target.value as Event)}>
                <optgroup label="Something they do">
                  {EVENTS.map((ev) => <option key={ev.id} value={ev.id}>{ev.label}</option>)}
                </optgroup>
                {/* What they ARE right now, read off the live roster: the Rules tab's roster
                    triggers, aimed at this one player. */}
                <optgroup label="Something about them (live roster)">
                  {ROSTER_CONDITIONS.filter((c) => !offeredConditions || offeredConditions.has(c.id) || c.id === event)
                    .map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </optgroup>
              </select>
            </div>
            {event === "weaponkill" && (
              <label>Weapons (comma-separated — part of the name is enough)
                <input value={weapons} onChange={(e) => setWeapons(e.target.value)} placeholder="e.g. FLAMETHROWER, SATCHEL, 150MM" />
                <span className="hint">Team kills with these weapons count too.</span>
              </label>
            )}
            {event === "teamswitch" && (
              <p className="hint">Only a move to the other side counts — not joining a team on connect, and not dropping to Unassigned on the way across.</p>
            )}
            {event === "afk" && (
              <label>Minutes without a kill
                <NumField min="1" max="180" value={Number(condition.minutes ?? AFK_DEFAULT_MINUTES)}
                  onValue={(n) => setCondition({ ...condition, minutes: n })} />
                <span className="hint">Counted from when they connect or last get a kill — or from when you arm it, if they are already on. With “Fire every time” it fires again after their next kill and another quiet spell.</span>
              </label>
            )}
            {isRosterCondition(event) && (
              <div>
                {/* The Rules trigger's own knobs, with the roles of the player's game. */}
                {event === "role"
                  ? <RoleChips label="Roles (any of these)" roles={playerGame?.roles ?? {}} value={condition.roles} onChange={(ids) => setCondition({ ...condition, roles: ids })} />
                  : <StateTriggerParams kind={rosterKindOf(event)} value={condition} onChange={setCondition} roles={playerGame?.roles ?? {}} />}
                <p className="hint">
                  Checked on the live roster every 30 seconds. It fires when this becomes true; with
                  “Fire every time” it fires again only after it has stopped being true for
                  {" "}{ROSTER_CLEAR_MINUTES} minutes (they left the role or the server, and came back).
                </p>
              </div>
            )}

            {/* One block per step: what to do, its own fields, and its own delay — so one trigger
                can say "message now, kick in 60 seconds". */}
            {steps.map((st, i) => (
              <fieldset key={i} className="vip-form" style={{ marginTop: 8 }}>
                {/* Read in ONE direction, the way it runs: wait, THEN act. Each wait counts from
                    the step before it (the first from the event itself), so 60 + 60 + 30 lands
                    the last action 2½ minutes after the event — the timeline below spells it out. */}
                <div className="control-row" style={{ flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                  <span className="muted">{i === 0 ? "→ wait" : "and then wait"}</span>
                  <input type="number" min="0" max="3600" style={{ width: 76 }} aria-label="Wait (seconds)"
                    value={st.delaySec} onChange={(e) => patchStep(i, { delaySec: e.target.value })} />
                  <span className="muted">seconds, then</span>
                  <select aria-label="Then" value={st.action} onChange={(e) => patchStep(i, { action: e.target.value as Action })}>
                    {ACTIONS.map((a) => <option key={a.id} value={a.id} disabled={!allowed.has(a.id)}>{a.label}{allowed.has(a.id) ? "" : " (no permission)"}</option>)}
                  </select>
                  {steps.length > 1 && (
                    <button type="button" className="mini ghost" title="Remove this action"
                      onClick={() => setSteps((prev) => prev.filter((_, x) => x !== i))}>✕</button>
                  )}
                </div>
                {(needsMessage(st.action) || needsReason(st.action) || needsWatchReason(st.action)) && (
                  <label>{needsMessage(st.action) ? "Message to send" : needsWatchReason(st.action) ? "Watch reason (shown on their profile)" : "Reason (shown to the player)"}
                    <textarea value={st.message} onChange={(e) => patchStep(i, { message: e.target.value })} rows={2}
                      placeholder={needsMessage(st.action) ? "e.g. Welcome back — please read the rules in Discord." : needsWatchReason(st.action) ? "e.g. Suspected teaming — watch their squad choice." : "e.g. Repeated team killing."} />
                    {!needsWatchReason(st.action) && <PlaceholderHint extra={KILL_EVENTS.includes(event) ? ["attacker_name", "victim_name", "weapon"] : isRosterCondition(event) ? ["violation"] : undefined} />}
                  </label>
                )}
                {(st.action === "tempban" || st.action === "vip") && (
                  <label>{st.action === "vip" ? "VIP length (hours)" : "Ban length (hours)"}
                    <input type="number" min="1" value={st.hours} onChange={(e) => patchStep(i, { hours: e.target.value })} />
                    {st.action === "vip" && <span className="hint">Added to any VIP they already hold. A permanent VIP is never shortened.</span>}
                  </label>
                )}
                {st.action === "vipremove" && (
                  <span className="hint">Removes their VIP on the server the event happens on. A PERMANENT VIP is never touched — that stays a by-hand decision on the VIPs page, and permanent VIP from a group perk lasts until they leave the group.</span>
                )}
                {needsPoints(st.action) && (
                  <label>{st.action === "takepoints" ? "Points to take" : "Points to grant"}
                    <input type="number" min="1" value={st.points} onChange={(e) => patchStep(i, { points: e.target.value })} />
                    <span className="hint">Needs the player to have linked their Discord.{st.action === "takepoints" ? " Never takes a balance below zero." : ""}</span>
                  </label>
                )}
              </fieldset>
            ))}
            {/* The whole chain as a clock, so nobody has to work out what the waits add up to:
                "connect → 2m 0s: message → 2m 20s: remove VIP". Offsets are cumulative because
                that is exactly how the runner executes them. */}
            {(steps.length > 1 || steps.some((st) => (Number(st.delaySec) || 0) > 0)) && (
              <p className="hint" style={{ margin: "6px 0 0" }}>
                {(() => {
                  const fmtAt = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
                  let at = 0;
                  const marks = steps.map((st) => {
                    at += Math.max(0, Number(st.delaySec) || 0);
                    const label = ACTIONS.find((a) => a.id === st.action)?.label ?? st.action;
                    return `${fmtAt(at)}: ${label.toLowerCase()}`;
                  });
                  return <>Timeline — {eventLabel(event)} → {marks.join(" → ")}</>;
                })()}
              </p>
            )}
            {steps.length < 5 && (
              <button type="button" className="ghost mini" onClick={() => setSteps((prev) => [...prev, blankStep()])}>
                + Add another action
              </button>
            )}

            <label>Server
              <select value={serverId} onChange={(e) => setServerId(e.target.value)}>
                <option value="">Any server</option>
                {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>

            <Toggle checked={fireOnce} onChange={setFireOnce}
              label={fireOnce ? "Fire once, then disarm (fire and forget)" : "Fire every time it happens"} />

            <label>Note (optional — why this trigger exists)
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Owner asked us to welcome them back personally" />
            </label>

            {editing?.disarmedAt && (
              <Toggle checked={rearm} onChange={setRearm}
                label={rearm ? "Arm it again when saved (it already fired once)" : "Keep it spent — just save the changes"} />
            )}

            <ActionResult error={formError} />
            <div className="control-row">
              <button onClick={create} disabled={busy || steps.some((st) => !allowed.has(st.action))}>
                {busy ? "Saving…" : editing ? "Save changes" : "Arm this trigger"}
              </button>
              {editing && <button type="button" className="ghost" onClick={cancelEdit} disabled={busy}>Cancel</button>}
            </div>
          </fieldset>
        )}
      </Panel>

      {/* The overview: EVERY player's triggers, armed first — always visible, so nothing armed
          can hide behind having to guess which player it was built for. */}
      <Panel id="triggerall" caps="server.view" title="All triggers"
        subtitle="Every player's, armed first — click a player to open theirs">
        <ActionResult error={allError} />
        {!allData && !allError && <SkeletonRows rows={3} cols={5} />}
        {allData && (allData.triggers ?? []).length === 0 && (
          <EmptyState icon="⚡" title="No triggers anywhere yet">
            Pick a player above and build one — every trigger in the community will show here.
          </EmptyState>
        )}
        {allData && (allData.triggers ?? []).length > 0 && (
          <div className="scroll-x">
            <table>
              <thead><tr><th>Player</th><th>Trigger</th><th></th><th>Scope</th><th>Fired</th><th>By</th><th></th></tr></thead>
              <tbody>
                {(allPages.items ?? []).map((t) => {
                  const spent = t.disarmedAt !== null;
                  return (
                    <tr key={t.id} style={spent ? { opacity: 0.55 } : undefined}>
                      <td>
                        <button className="linklike" onClick={() => setPicked({ playerId: t.playerId, name: t.playerName ?? "" })}>
                          {t.playerName || <span className="muted">{t.playerId.slice(0, 12)}…</span>}
                        </button>
                      </td>
                      <td className="wrap">
                        {t.summary}
                        {t.note && <div className="muted fs-sm">{t.note}</div>}
                      </td>
                      <td>
                        <span className={`badge ${spent ? "observe" : t.enabled ? "active" : "warn-badge"}`}>
                          {spent ? "spent" : t.enabled ? "armed" : "off"}
                        </span>
                      </td>
                      <td>{t.serverName ?? <span className="muted">any server</span>}</td>
                      <td>{t.firedCount}{t.lastFiredAt && <div className="muted fs-sm">last <Time iso={t.lastFiredAt} /></div>}</td>
                      <td>{t.createdByName}<div className="muted fs-sm">{fmt(t.createdAt)}</div>{t.updatedByName && t.updatedAt && <div className="muted fs-sm">edited by {t.updatedByName}, {fmt(t.updatedAt)}</div>}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button className="mini ghost" onClick={() => startEdit(t)}>Edit</button>
                        {!spent && <button className="mini ghost" onClick={() => toggle(t)}>{t.enabled ? "Disable" : "Re-arm"}</button>}
                        <button className="mini ghost" onClick={() => remove(t)}>Delete</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {allData && (allData.triggers ?? []).length > 0 && <Pager list={allPages} noun="trigger" />}
      </Panel>

      {picked && (
        <Panel id="triggerlist" caps="server.view" title="Armed & spent triggers"
          subtitle={picked.name || undefined}>
          <ActionResult error={error} />
          {!triggers && !error && <SkeletonRows rows={3} cols={4} />}
          {triggers && triggers.length === 0 && (
            <EmptyState icon="⚡" title="No triggers for this player yet">
              Build one above — it will show here with how many times it has fired.
            </EmptyState>
          )}
          {triggers && triggers.length > 0 && (
            <div className="scroll-x">
              <table>
                <thead><tr><th>Trigger</th><th></th><th>Scope</th><th>Fired</th><th>By</th><th></th></tr></thead>
                <tbody>
                  {(playerPages.items ?? []).map((t) => {
                    const spent = t.disarmedAt !== null;
                    return (
                      <tr key={t.id} style={spent ? { opacity: 0.55 } : undefined}>
                        <td className="wrap">
                          {t.summary}
                          {t.note && <div className="muted fs-sm">{t.note}</div>}
                          {t.steps.filter((st) => st.message).map((st, i) => <div key={i} className="muted fs-sm">“{st.message}”</div>)}
                        </td>
                        <td>
                          <span className={`badge ${spent ? "observe" : t.enabled ? "active" : "warn-badge"}`}>
                            {spent ? "spent" : t.enabled ? "armed" : "off"}
                          </span>
                        </td>
                        <td>{t.serverName ?? <span className="muted">any server</span>}</td>
                        <td>{t.firedCount}{t.lastFiredAt && <div className="muted fs-sm">last <Time iso={t.lastFiredAt} /></div>}</td>
                        <td>{t.createdByName}<div className="muted fs-sm">{fmt(t.createdAt)}</div>{t.updatedByName && t.updatedAt && <div className="muted fs-sm">edited by {t.updatedByName}, {fmt(t.updatedAt)}</div>}</td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <button className="mini ghost" onClick={() => startEdit(t)}>Edit</button>
                          {!spent && <button className="mini ghost" onClick={() => toggle(t)}>{t.enabled ? "Disable" : "Re-arm"}</button>}
                          <button className="mini ghost" onClick={() => remove(t)}>Delete</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {triggers && triggers.length > 0 && <Pager list={playerPages} noun="trigger" />}
        </Panel>
      )}
    </PanelGroup>
  );
}
