"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, fmt, wasFiled } from "../lib/api";
import { wallToIso, zoneLabel } from "../lib/time";
import { useAlert, useConfirm } from "../lib/feedback";
import { useServers } from "../lib/servers";
import { useLatestLoad } from "../lib/resource";
import { PanelGroup, Panel } from "./Panel";
import { PlayerLink } from "./PlayerLink";
import { ActionResult, AskNotice, EmptyState, Modal, ObserveBanner, Pager, SearchInput, SkeletonRows, Toggle, Explanation } from "./ui";
import { useSortable, SortTh } from "../lib/sort";
import { useClientPages } from "../lib/paged";
import { isFlag, isText, oneOf, useRemembered } from "../lib/remembered";
import { Time } from "./Time";
import { GameId } from "./GameId";
import { PlayerPicker, type PickedPlayer } from "./PlayerPicker";
import { ServerScopePicker } from "./ServerScopePicker";
import { type BanScope } from "../lib/banScope";
import { platformLabel } from "../lib/platform";
import { fileStem, type Sheet } from "../lib/download";
import { DownloadButton } from "./Download";
import { UploadButton, type UploadResult } from "./Upload";
import { planBans, type BanLine, type PlanRow } from "../lib/uploadPlans";
import { canOnServer } from "../lib/access";
import { useGrants } from "../lib/grants";

/** What a ban row's game is called in a chip. Local on purpose: the full descriptor pipeline is
 *  per-server, and this label only exists on installs running BOTH games at once. */
const gameShortName = (g: string): string => (g === "hllv" ? "Vietnam" : g === "hll" ? "WW2" : g);

/** Temp bans the game still lists after their own time ran out: it no longer enforces them, and it
 *  refuses to remove them — so the sync and lift-all leave them be, and say so. Present tense: the
 *  same line serves the confirm, before anything has run, and the result after. */
const ranOutLine = (n: number): string =>
  `${n} temp ban${n === 1 ? "" : "s"} on its list had already run out — the game still lists ${n === 1 ? "it" : "them"} but no longer enforces ${n === 1 ? "it" : "them"}, and won't let ${n === 1 ? "it" : "them"} be removed, so ${n === 1 ? "it's" : "they're"} left alone`;

/** "Gunplay, Chaptheclown and 3 more — the game's answer", one entry per distinct reason: the
 *  sync's refusals name who they are about, rather than repeating one error for nobody. */
function whoAndWhy(rows: { playerId: string; playerName?: string | null; reason: string }[]): string {
  const byReason = new Map<string, string[]>();
  for (const r of rows) {
    const who = r.playerName || (r.playerId.length > 16 ? `${r.playerId.slice(0, 12)}…` : r.playerId);
    byReason.set(r.reason, [...(byReason.get(r.reason) ?? []), who]);
  }
  return [...byReason].map(([reason, who]) => `${who.length > 5 ? `${who.slice(0, 5).join(", ")} and ${who.length - 5} more` : who.join(", ")} — ${reason}`).join("; ");
}

/**
 * An uploaded ban list's new bans, placed one at a time the way the "Ban a player" form places one —
 * same route, same decision row, same scope rule. One without the permission is sent for approval,
 * as a ban typed in the form would be.
 */
async function uploadBans(serverId: string, rows: PlanRow<BanLine>[], reason: string, scope: BanScope, progress: (done: number) => void): Promise<UploadResult[]> {
  const out: UploadResult[] = [];
  for (const [i, row] of rows.entries()) {
    const b = row.payload!;
    try {
      await api(`/servers/${serverId}/actions`, { method: "POST", body: {
        action: b.type === "temp" ? "tempban" : "permaban", playerId: b.playerId, playerName: b.playerName, reason: b.reason || reason,
        hours: b.until ? Math.max(1, Math.ceil((Date.parse(b.until) - Date.now()) / 3_600_000)) : 0,
        ...(b.category ? { category: b.category } : {}), scope,
      } });
      out.push({ line: row.line, who: row.who, ok: true, detail: row.detail });
    } catch (e) {
      out.push({ line: row.line, who: row.who, ok: wasFiled(e), detail: wasFiled(e) ? "sent for approval" : (e as Error).message });
    }
    progress(i + 1);
  }
  return out;
}

/** The ban record as a file, row for row as on screen; servers by name, where the screen numbers them. */
function banSheet(rows: Ban[], servers: { id: string; name: string }[]): Sheet {
  const names = (ids: string[] = []) => ids.map((id) => servers.find((s) => s.id === id)?.name ?? id).join(", ");
  return {
    name: "Bans",
    columns: [
      { key: "when", label: "When", time: true },
      { key: "player", label: "Player" },
      { key: "playerId", label: "Player ID" },
      { key: "type", label: "Type" },
      { key: "until", label: "Until", time: true },
      { key: "platform", label: "Platform" },
      { key: "game", label: "Game" },
      { key: "where", label: "Where" },
      { key: "reason", label: "Reason" },
      { key: "category", label: "Category" },
      { key: "by", label: "By" },
      { key: "automatic", label: "Automatic" },
      { key: "status", label: "Status" },
      { key: "liftedBy", label: "Lifted by" },
      { key: "lifted", label: "Lifted", time: true },
    ],
    rows: rows.map((b) => [
      b.ts, b.playerName, b.playerId, b.type, b.expiresAt, platformLabel(b.platform) || null, gameShortName(b.game),
      b.scope.mode === "all" ? "All servers" : b.scope.mode === "except" ? `All but ${names(b.scope.serverIds)}` : names(b.serverIds),
      b.reason, b.category, b.by, b.auto, b.active ? "active" : b.liftedAt ? "lifted" : "expired", b.liftedBy, b.liftedAt,
    ]),
  };
}

/** The game's own ban list as a file. */
function gameBanSheet(rows: GameBan[], serverName: string): Sheet {
  return {
    name: "Bans on the server",
    columns: [
      { key: "when", label: "When", time: true },
      { key: "player", label: "Player" },
      { key: "playerId", label: "Player ID" },
      { key: "type", label: "Type" },
      { key: "hours", label: "Hours" },
      { key: "reason", label: "Reason" },
      { key: "by", label: "By" },
      { key: "ranOut", label: "Ran out" },
      { key: "server", label: "Server" },
    ],
    rows: rows.map((b) => [b.ts, b.playerName, b.playerId, b.type, b.type === "perma" ? null : b.durationHours, b.reason, b.by, Boolean(b.ranOut), serverName]),
  };
}

/** One ban DECISION — however many servers its scope rule covers. */
interface Ban {
  id: string;
  ts: string;
  by: string;
  playerName: string | null;
  playerId: string | null;
  /** The platform the game reported for this player, as the directory holds it (the same token
   *  the analytics split by). Null for an id the panel has never seen. */
  platform?: string | null;
  type: "temp" | "perma";
  reason: string | null;
  category: string | null;
  scope: { mode: "all" | "except" | "servers"; serverIds?: string[] };
  game: string;
  expiresAt: string | null;
  liftedAt: string | null;
  liftedBy: string | null;
  active: boolean;
  auto: boolean;
  /** The servers the rule covers today — the rule itself still travels, because "these two" and
   *  "all (which is two today)" must not render identically. */
  serverIds: string[];
}
// Live ban list read straight from the game (GET /servers/:id/bans/live).
interface GameBan {
  playerId: string;
  playerName: string | null;
  ts: string | null;
  durationHours: number;
  reason: string;
  by: string | null;
  type: "temp" | "perma";
  /** A temp ban the game still lists after its own time ran out: it holds nobody, and the game
   *  won't remove it (the API's gameBanRanOut). */
  ranOut?: boolean;
}

/**
 * The servers an unban will reach, ticked inside the confirm dialog.
 *
 * This is not `ServerScopePicker`: that one asks "which of the servers you can act on", for an
 * action being composed. Here the answer is already known and much narrower — the servers this
 * player is actually banned on — and offering the rest would invite unbanning someone somewhere
 * they were never banned.
 *
 * It reports upwards through a callback rather than owning the value, because the dialog it lives
 * in hands back only yes/no.
 */
function UnbanScope({ offered, numberOf, onChange }: {
  offered: string[];
  numberOf: (id: string) => number | null;
  onChange: (ids: string[]) => void;
}) {
  const [sel, setSel] = useState<string[]>(offered);
  const put = (next: string[]) => { setSel(next); onChange(next); };
  return (
    <div className="scope-pick">
      <div className="scope-pick-head">
        <span>They are banned on {offered.length} servers — lift on</span>
        <button type="button" className="mini ghost" onClick={() => put(sel.length === offered.length ? [] : offered)}>
          {sel.length === offered.length ? "None" : "All servers"}
        </button>
      </div>
      <div className="scope-pick-row">
        {offered.map((id) => {
          const on = sel.includes(id);
          return (
            <button
              key={id}
              type="button"
              className={`scope-chip${on ? " on" : ""}`}
              aria-pressed={on}
              onClick={() => put(on ? sel.filter((x) => x !== id) : [...sel, id])}
            >
              <span className="scope-no">{numberOf(id) ?? "?"}</span>
            </button>
          );
        })}
      </div>
      {/* Unticking is the unusual choice, so it is the one that gets said out loud. */}
      {sel.length < offered.length && (
        <p className="hint scope-pick-note">
          {sel.length === 0 ? "Nothing ticked — this will do nothing." : `Still banned on ${offered.length - sel.length} after this.`}
        </p>
      )}
    </div>
  );
}

/**
 * Ban somebody who is not in front of you.
 *
 * Every other ban in the panel starts from a player you can already see: a row on the live roster,
 * a profile you opened. This one starts from an ID — the cheater a neighbouring community just
 * warned you about, the account posted in the staff channel an hour before they turn up. The
 * blacklist used to be the only surface that could take a pasted id, and what it produced was a
 * record the game never enforced. This does the same thing for real: same route, same decision
 * row, same scope rule as a ban placed from the roster.
 *
 * The player need not exist in our records at all — the id goes to the game as typed, which is
 * exactly what makes a pre-emptive ban possible.
 */
function BanComposer({ serverId, game, onDone, onClose }: {
  serverId: string;
  game?: string;
  onDone: (note: string) => void;
  onClose: () => void;
}) {
  const [pick, setPick] = useState<PickedPlayer | null>(null);
  const [kind, setKind] = useState<"temp" | "perma">("perma");
  const [f, setF] = useState({ reason: "", hours: "24", until: "", category: "" });
  // Same default as the roster's ban dialog: the server you are pinned to, and reaching further is
  // a deliberate tick. A surface that quietly defaulted to "everywhere" would be a different
  // promise from the one the button makes.
  const [scope, setScope] = useState<BanScope>({ mode: "servers", serverIds: serverId ? [serverId] : [] });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  const capability = kind === "temp" ? "action.tempban" : "action.permaban";

  // "Nothing ticked" is a property of the RULE, not of today's server list: only an explicit list
  // can be empty ("everywhere" and "everywhere but" always name something). Resolving the rule
  // against the servers to count them would answer a different question — and answer it wrongly
  // here, where this component does not hold the list.
  const blockedWhy = !pick ? "Search a player, or paste their platform id."
    : scope.mode === "servers" && !(scope.serverIds ?? []).length ? "Pick at least one server."
    : !f.reason.trim() ? "Type a reason — the player sees it, and it goes on the record."
    : "";

  async function submit() {
    if (!pick) return;
    setBusy(true); setErr("");
    try {
      const hours = kind === "temp"
        ? (f.until ? Math.max(1, Math.ceil((Date.parse(wallToIso(f.until) ?? "") - Date.now()) / 3_600_000)) : Number(f.hours) || 0)
        : 0;
      const r = await api<{ results?: { serverName: string; ok: boolean; error?: string }[]; applied?: number }>(
        `/servers/${serverId}/actions`,
        { method: "POST", body: {
          action: kind === "temp" ? "tempban" : "permaban",
          playerId: pick.playerId, playerName: pick.name, reason: f.reason.trim(), hours,
          ...(f.category.trim() ? { category: f.category.trim() } : {}),
          scope,
        } },
      );
      const refused = (r.results ?? []).filter((x) => !x.ok);
      if (refused.length) throw new Error(`${r.applied ?? 0} of ${r.results?.length ?? 0} server${r.results?.length === 1 ? "" : "s"} — ${refused.map((x) => `${x.serverName}: ${x.error}`).join("; ")}`);
      onDone(`Banned ${pick.name || pick.playerId}.`);
      onClose();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="Ban a player" onClose={onClose} busy={busy}>
      <ServerScopePicker capability={capability} game={game} value={scope} onChange={setScope} />
      <div className="pa-fields">
        {/* Deliberately NOT a <label>. A label forwards a click on anything inside it to the
            control it labels — here the picker's own text box — and that forwarding swallows the
            click on the dropdown option, so picking a player silently does nothing. A caption
            beside the field says the same thing without hijacking the clicks. */}
        <div className="field">
          <span className="field-label">Player</span>
          <PlayerPicker value={pick} onChange={setPick} game={game} placeholder="Search a player, or paste their platform id…" />
          <span className="hint">They do not have to have played here — a pasted id is banned before they ever connect.</span>
        </div>
        <label>Ban
          <span className="seg">
            <button type="button" className={`seg-btn ${kind === "perma" ? "active" : ""}`} onClick={() => setKind("perma")}>Permanent</button>
            <button type="button" className={`seg-btn ${kind === "temp" ? "active" : ""}`} onClick={() => setKind("temp")}>Temporary</button>
          </span>
        </label>
        {kind === "temp" && (
          <>
            <label>Hours<input type="number" min="1" value={f.hours} onChange={set("hours")} disabled={!!f.until} /></label>
            <label>…or until a date ({zoneLabel()})
              <input type="datetime-local" value={f.until} onChange={set("until")} />
              {f.until && <span className="hint">The date wins — hours are computed from it when you submit.</span>}
            </label>
          </>
        )}
        <label>Reason<input value={f.reason} onChange={set("reason")} autoFocus /></label>
        <label>Category <span className="muted">(optional)</span>
          <input value={f.category} onChange={set("category")} placeholder="e.g. cheating, racism, ban evasion" />
        </label>
      </div>
      <ActionResult error={err} />
      {blockedWhy && <p className="hint pa-blocked">{blockedWhy}</p>}
      <div className="pa-actions">
        <button className="ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="danger" onClick={submit} disabled={busy || blockedWhy !== ""}>{busy ? "Working…" : "Ban player"}</button>
      </div>
    </Modal>
  );
}

export default function Bans() {
  const confirm = useConfirm();
  // An Unban that fails says why in a dialog: the note line sits above the whole list, often a
  // screen or more away from the row that was pressed.
  const alert = useAlert();
  const { serverId, server, numberOf, servers } = useServers();
  const [composing, setComposing] = useState(false);
  const grants = useGrants();
  const mayBan = Boolean(serverId && (canOnServer(grants, "action.permaban", serverId) || canOnServer(grants, "action.tempban", serverId)));
  const [uploadReason, setUploadReason] = useState("");
  const [uploadScope, setUploadScope] = useState<BanScope>({ mode: "servers", serverIds: serverId ? [serverId] : [] });
  // The server you are on, as the "Ban a player" form starts — and again whenever you switch.
  useEffect(() => { setUploadScope({ mode: "servers", serverIds: serverId ? [serverId] : [] }); }, [serverId]);
  // Two games in one community is when a ban row needs to say WHICH game its rule covers.
  const multiGame = new Set(servers.map((s) => s.game).filter(Boolean)).size > 1;
  // The record as it was left, for the sitting — the view, the search, lifted bans shown, the
  // server — so a player opened from a ban comes back to the same list.
  const [mode, setMode] = useRemembered<"platform" | "live">("bans.mode", "platform", oneOf(["platform", "live"] as const), "session");

  const [q, setQ] = useRemembered("bans.search", "", isText, "session");
  const [showLifted, setShowLifted] = useRemembered("bans.lifted", false, isFlag, "session");
  /**
   * "" = every server; an id narrows the record to decisions whose rule covers it today. Kept for
   * the sitting, and read only while that server is still one of this account's: deleted, or no
   * longer theirs, it went on narrowing the record from a dropdown that cannot show it, under a
   * "Lift all on this server" aimed at a server that is not there.
   */
  const [keptServer, setServerFilter] = useRemembered("bans.server", "", isText, "session");
  const serverFilter = servers.some((sv) => sv.id === keptServer) ? keptServer : "";
  const [liftingAll, setLiftingAll] = useState(false);
  const [bans, setBans] = useState<Ban[] | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const [live, setLive] = useState<GameBan[] | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const claimLive = useLatestLoad();
  const [liveError, setLiveError] = useState("");

  const load = () => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (showLifted) params.set("history", "1");
    const qs = params.toString();
    return api<{ bans: Ban[] }>(`/bans${qs ? `?${qs}` : ""}`).then((r) => setBans(r.bans)).catch((e) => setError(e.message));
  };
  // Typing in the search waits a moment, so each keystroke is not a read of its own. Opening the
  // list, or changing what it shows, does not: it used to wait the same moment before anything.
  const searched = useRef(q);
  useEffect(() => {
    if (mode !== "platform") return;
    const typing = searched.current !== q;
    searched.current = q;
    const t = setTimeout(load, typing ? 200 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, mode, showLifted]);

  /** Read every server's live ban list into the record — the bootstrap, safe to re-run. */
  async function seed() {
    if (!(await confirm({
      title: "Sync the ban record from the game servers?",
      body: <p className="muted notice">Reads every connected server&apos;s own ban list and records any ban the panel has no decision for. A player banned on every server is recorded as banned everywhere — including servers added later. Safe to run again; nothing is duplicated.</p>,
      confirmLabel: "Sync",
    }))) return;
    setNote("Reading ban lists…");
    try {
      const r = await api<{ created: number; collapsed: number; skippedExisting: number; servers: { serverName: string; ok: boolean; error?: string }[] }>("/bans/seed", { method: "POST", body: {} });
      const down = r.servers.filter((x) => !x.ok);
      setNote(`Recorded ${r.created} ban(s) — ${r.collapsed} community-wide, ${r.skippedExisting} already on record.${down.length ? ` Unreachable: ${down.map((x) => x.serverName).join(", ")}.` : ""}`);
      load();
    } catch (e) { setNote("Sync failed: " + (e as Error).message); }
  }

  const [syncing, setSyncing] = useState(false);
  /**
   * Compare the pinned server's LIVE ban lists against the ban record, then repair with the plan
   * on screen. Same two-call shape as the VIPs page's sync: the first call is a pure read, the
   * confirm shows its numbers, and only the second call writes. This is the recovery path for a
   * server that lost its ban file (the launch-week wipe took a whole VIP list; ban lists live in
   * the same server state) — until now only the armed worker could replay standing decisions.
   */
  async function syncWithGame() {
    if (!serverId) return;
    setSyncing(true); setNote("");
    try {
      const plan = await api<{ onGame: number; apply: { playerId: string }[]; lift: { playerId: string }[]; foreign: { playerId: string }[]; ranOut?: { playerId: string }[] }>(
        `/servers/${serverId}/bans/reconcile`, { method: "POST", body: {} });
      const ranOut = plan.ranOut?.length ?? 0;
      if (!plan.apply.length && !plan.lift.length) {
        // "Matching the record" is what is left once the outside bans are counted on their own —
        // the "+N" after it is in addition, not part of it.
        setNote(`In sync: this server enforces ${plan.onGame - ranOut - plan.foreign.length} ban(s) matching the record${plan.foreign.length ? ` (+${plan.foreign.length} placed outside the panel, left alone — adopt them with Sync from servers)` : ""}.${ranOut ? ` ${ranOutLine(ranOut)}.` : ""}`);
        return;
      }
      const ok = await confirm({
        title: "Sync this server's ban list?",
        body: <p className="muted">The server enforces <b>{plan.onGame - ranOut}</b> ban(s).
          This will apply <b>{plan.apply.length}</b> standing ban(s) it is missing{plan.lift.length ? <> and lift <b>{plan.lift.length}</b> whose decision was unbanned or expired</> : null}
          {plan.foreign.length ? <>. {plan.foreign.length} ban(s) placed outside the panel will not be touched</> : null}
          {ranOut ? <>. {ranOutLine(ranOut)}</> : null}.</p>,
        confirmLabel: "Sync now",
        danger: true,
      });
      if (!ok) return;
      const r = await api<{ restored: string[]; lifted: string[]; skipped: { playerId: string; playerName?: string | null; reason: string }[]; ranOut?: { playerId: string }[]; before: number; after: number | null; warning?: string }>(
        `/servers/${serverId}/bans/reconcile`, { method: "POST", body: { apply: true } });
      const parts = [`Applied ${r.restored.length}, lifted ${r.lifted.length} — server list ${r.before} → ${r.after ?? "?"}`];
      if (r.ranOut?.length) parts.push(ranOutLine(r.ranOut.length));
      if (r.skipped.length) parts.push(`skipped ${r.skipped.length}: ${whoAndWhy(r.skipped)}`);
      if (r.warning) parts.push(r.warning);
      setNote(parts.join(" · "));
      load();
      if (mode === "live") loadLive();
    } catch (e) {
      setNote("Sync failed: " + (e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  /**
   * Clear the FILTERED server of every ban it enforces. Scope-aware on the record: a decision
   * scoped only to it is lifted, a broader one is narrowed to the servers still banned — nobody
   * gets unbanned anywhere staff did not name. The game's own list is emptied too, bans placed
   * outside the panel included.
   */
  async function liftAllOn() {
    if (!serverFilter) return;
    const target = servers.find((sv) => sv.id === serverFilter);
    // Counted from the whole record, as the lift reaches it: the list on screen is narrowed by any
    // search typed above it, and "1 decision" above a lift that takes forty is the wrong thing to
    // ask somebody to confirm.
    let record: Ban[];
    try { record = (await api<{ bans: Ban[] }>("/bans")).bans; }
    catch (e) { setNote("Lift-all failed: " + (e as Error).message); return; }
    const covered = record.filter((b) => b.active && b.serverIds.includes(serverFilter));
    const ok = await confirm({
      title: `Lift every ban on ${target?.name ?? "this server"}?`,
      body: <div className="muted">
        {/* "you can see": a per-server moderator reads a filtered record, and the operation acts
            on every covering decision — the count must not promise the whole reach. */}
        <p><b>{covered.length}</b> standing decision(s) you can see currently cover it. Each is handled by its rule:
          a ban scoped only to this server is lifted; one that also covers other servers stays in force
          there and merely stops covering this one.</p>
        <p>The server&apos;s own ban list is then emptied — <b>including bans placed outside the panel</b>,
          which have no record here. Every lift is recorded; re-banning anyone is a fresh decision.</p>
      </div>,
      confirmLabel: "Lift everything",
      danger: true,
    });
    if (!ok) return;
    setLiftingAll(true); setNote("");
    try {
      const r = await api<{ lifted: number; narrowed: number; cleared: number; ranOut?: number; failed: { playerId: string; reason: string }[]; gameError: string | null; requested?: boolean }>(
        `/servers/${serverFilter}/bans/lift-all`, { method: "POST", body: {} });
      // Without the unban permission the write is filed for approval instead of running — the
      // numbers do not exist yet, and pretending otherwise reads as "nothing was lifted".
      if (r.requested) { setNote("Sent for approval — nothing is lifted until someone who holds the unban permission signs it."); return; }
      const parts = [`Lifted ${r.lifted} decision(s), narrowed ${r.narrowed} to other servers, cleared ${r.cleared} off the game.`];
      if (r.ranOut) parts.push(`${ranOutLine(r.ranOut)}.`);
      if (r.failed.length) parts.push(`${r.failed.length} game entr${r.failed.length === 1 ? "y" : "ies"} refused: ${r.failed.slice(0, 3).map((f) => f.reason).join("; ")}${r.failed.length > 3 ? "…" : ""}`);
      if (r.gameError) parts.push(`Game list not cleared (${r.gameError}) — the leftover entries now read as unbanned decisions and the next Sync sweeps them.`);
      setNote(parts.join(" "));
      load();
      if (mode === "live") loadLive();
    } catch (e) { setNote("Lift-all failed: " + (e as Error).message); }
    finally { setLiftingAll(false); }
  }

  async function loadLive() {
    if (!serverId) return;
    // Reading the list off the game server is slow enough to be overtaken by a server switch, and
    // this list is what the Lift buttons act on — the wrong server's bans here would be offered
    // for lifting against the one now selected.
    const fresh = claimLive();
    setLiveLoading(true); setLiveError(""); setLive(null);
    try {
      const r = await api<{ bans: GameBan[] }>(`/servers/${serverId}/bans/live`);
      if (fresh()) setLive(r.bans);
    } catch (e) {
      if (fresh()) setLiveError((e as Error).message);
    } finally {
      if (fresh()) setLiveLoading(false);
    }
  }
  // Auto-load the live list when switching into live mode or changing server.
  useEffect(() => {
    if (mode === "live" && serverId) loadLive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, serverId]);

  /**
   * Lift this ban, and offer the player's other bans of the same type alongside it.
   *
   * Each row is one server, because a ban IS per server. But a player barred from the whole
   * community has a row per server, and clearing them one at a time is how someone ends up still
   * banned on the one nobody clicked. So the confirm opens with every one of those servers already
   * ticked — and lets any of them be unticked, because "lift it on the seed server only" is a real
   * decision staff make.
   */
  async function unban(b: Ban) {
    const who = b.playerName || b.playerId || "this player";
    if (!b.playerId) return void alert({ title: "Can't remove this ban", body: "The record has no player id to unban." });
    // One row is one decision; its rule already says which servers it covers today.
    const offered = b.serverIds;
    if (!offered.length) return void alert({ title: `Can't remove the ban on ${who}`, body: "This ban covers no current server — nothing to lift on the game side." });
    // The picker writes here as chips are ticked; the dialog only hands back yes/no.
    let targets = offered;
    const ok = await confirm({
      title: `Remove ${b.type} ban on ${b.playerName || b.playerId}?`,
      body: offered.length > 1
        ? <UnbanScope offered={offered} numberOf={numberOf} onChange={(v) => { targets = v; }} />
        : undefined,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    if (!targets.length) return void alert({ title: "Nothing was removed", body: "No servers were ticked." });
    setNote("Removing ban…");
    try {
      const r = await api<{ results?: { serverName: string; ok: boolean; error?: string }[]; applied?: number }>(
        `/servers/${targets[0]}/actions`,
        { method: "POST", body: { action: b.type === "perma" ? "unban_perma" : "unban_temp", playerId: b.playerId, ...(targets.length > 1 ? { serverIds: targets } : {}) } },
      );
      const refused = (r.results ?? []).filter((x) => !x.ok);
      // A partial lift is the dangerous outcome — the player is unbanned enough to look fixed and
      // still barred somewhere. Say which, where it cannot be missed.
      if (refused.length) {
        setNote("");
        void alert({
          title: `${who} is still banned on ${refused.map((x) => x.serverName).join(", ")}`,
          body: `Unbanned on ${r.applied ?? 0} of ${targets.length} server${targets.length === 1 ? "" : "s"}. ${refused[0]!.error ?? ""}`.trim(),
        });
      } else setNote(`Unbanned ${who}${targets.length > 1 ? ` on ${targets.length} servers` : ""}.`);
      load();
    } catch (e) {
      // Filed for approval is news, not a failure: it keeps the note line.
      if (wasFiled(e)) { setNote(e.message); return; }
      setNote("");
      void alert({ title: `Couldn't remove the ban on ${who}`, body: (e as Error).message });
    }
  }

  async function unbanLive(b: GameBan) {
    if (!serverId) return;
    if (!(await confirm({ title: `Remove ${b.type} ban on ${b.playerName || b.playerId}?`, confirmLabel: "Remove", danger: true }))) return;
    setNote("Removing ban…");
    try {
      await api(`/servers/${serverId}/actions`, { method: "POST", body: { action: b.type === "perma" ? "unban_perma" : "unban_temp", playerId: b.playerId } });
      setNote(`Unbanned ${b.playerName || b.playerId}.`);
      loadLive();
    } catch (e) {
      if (wasFiled(e)) { setNote(e.message); return; }
      setNote("");
      void alert({ title: `Couldn't remove the ban on ${b.playerName || b.playerId}`, body: (e as Error).message });
    }
  }

  // The two lists carry different shapes — what the panel recorded vs what the game server holds —
  // so each gets its own accessors. Newest first is the useful default for both.
  const sortPanel = useSortable<Ban>({
    when: (b) => b.ts,
    player: (b) => b.playerName ?? b.playerId ?? "",
    type: (b) => b.type,
    platform: (b) => platformLabel(b.platform),
    reason: (b) => b.reason ?? "",
    by: (b) => b.by,
  }, "when", "desc", "bans.panel");
  const sortLive = useSortable<GameBan>({
    when: (b) => b.ts ?? "",
    player: (b) => b.playerName ?? b.playerId,
    type: (b) => b.type,
    reason: (b) => b.reason,
    by: (b) => b.by ?? "",
  }, "when", "desc", "bans.live");
  // The record narrowed to one server's coverage — rules resolving to nothing stay under "All"
  // only, where they are visible enough to be dealt with rather than stranded.
  const shownBans = useMemo(() => (bans && serverFilter ? bans.filter((b) => b.serverIds.includes(serverFilter)) : bans), [bans, serverFilter]);
  const needle = q.trim().toLowerCase();
  const liveFiltered = useMemo(() => (live ?? []).filter((b) => {
    if (!needle) return true;
    return (b.playerName || "").toLowerCase().includes(needle) || b.playerId.toLowerCase().includes(needle) || b.reason.toLowerCase().includes(needle) || (b.by || "").toLowerCase().includes(needle);
  }), [live, needle]);
  // A page of each list at a time, sorted over all of it first: the record as the search found it
  // (asked of the API), and the game's own list, which the game hands over whole.
  const recordOrder = useMemo(() => (shownBans ? sortPanel.sorted(shownBans) : null), [sortPanel, shownBans]);
  const recordPages = useClientPages(recordOrder, "bans.record", "", `${needle}\n${showLifted}\n${serverFilter}\n${sortPanel.key}:${sortPanel.dir}`);
  const liveOrder = useMemo(() => sortLive.sorted(liveFiltered), [sortLive, liveFiltered]);
  const livePages = useClientPages(live ? liveOrder : null, "bans.live", serverId, `${needle}\n${sortLive.key}:${sortLive.dir}`);

  return (
    <PanelGroup viewId="bans">
      <ObserveBanner server={server}>Bans placed here are written to the game server, so they will not land.</ObserveBanner>
      <Panel
        id="bans"
        caps="open"
        title="Bans"
        actions={
          <>
            <div className="seg">
              <button className={`seg-btn ${mode === "platform" ? "active" : ""}`} onClick={() => setMode("platform")}>Platform</button>
              <button className={`seg-btn ${mode === "live" ? "active" : ""}`} onClick={() => setMode("live")}>Live</button>
            </div>
            {mode === "live" && <button className="mini ghost" onClick={loadLive} disabled={liveLoading || !serverId}>{liveLoading ? "…" : "Refresh"}</button>}
            {mode === "platform"
              ? <DownloadButton file={fileStem("bans", servers.find((sv) => sv.id === serverFilter)?.name)} title="Download the ban record"
                  count={shownBans?.length ?? 0} noun="ban" scope="as the list stands — its search, filters and order"
                  sheet={() => banSheet(recordOrder ?? [], servers)} />
              : <DownloadButton file={fileStem("bans-on", server?.name)} title="Download the game's ban list"
                  count={liveFiltered.length} noun="ban" scope="as the game's list stands — its search and order"
                  sheet={() => gameBanSheet(liveOrder, server?.name ?? "")} />}
            {mode === "platform" && mayBan && serverId && (
              <UploadButton title="Upload a ban list" onDone={() => void load()}
                intro="Bans still in force are placed on the servers picked below. Lifted and finished bans, and players already banned, are left alone."
                plan={async (t) => planBans(t, (await api<{ bans: Ban[] }>("/bans")).bans, server?.game)}
                fields={<>
                  <ServerScopePicker capability="action.permaban" game={server?.game} value={uploadScope} onChange={setUploadScope} label="Ban on" />
                  <label>Reason for lines without one<input value={uploadReason} onChange={(e) => setUploadReason(e.target.value)} placeholder="the player sees it, and it goes on the record" /></label>
                </>}
                blocked={(rows) => uploadScope.mode === "servers" && !(uploadScope.serverIds ?? []).length ? "Pick at least one server."
                  : rows.some((r) => !r.payload?.reason) && !uploadReason.trim() ? "Type a reason for the lines without one — the player sees it." : ""}
                apply={(rows, progress) => uploadBans(serverId, rows, uploadReason.trim(), uploadScope, progress)} />
            )}
          </>
        }
      >

      {mode === "platform" ? (
        <>
          <Explanation>The community&apos;s ban record — one row per decision, however many servers it covers. Bans placed straight on a game server arrive via <em>Sync from servers</em>. Unban requires the server to be in <strong>active</strong> mode.</Explanation>
          <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {/* Banning, syncing and lifting are offered to everyone who sees the record: without the
                permission each one is sent for approval, as the line below says. */}
            <button className="mini" onClick={() => setComposing(true)} disabled={!serverId}>Ban a player…</button>
            <button className="mini ghost" onClick={seed}>Sync from servers</button>
            <button className="mini ghost" onClick={syncWithGame} disabled={syncing || !serverId}>{syncing ? "Syncing…" : "Sync with game"}</button>
            <Toggle checked={showLifted} onChange={setShowLifted} label="Show lifted & expired" />
            <label className="muted fs-sm">Server{" "}
              <select value={serverFilter} onChange={(e) => setServerFilter(e.target.value)}
                title="Narrow the record to decisions whose rule covers one server today">
                <option value="">All servers</option>
                {servers.map((sv) => <option key={sv.id} value={sv.id}>{sv.name}</option>)}
              </select>
            </label>
            {serverFilter && (
              <button className="mini danger" onClick={() => void liftAllOn()} disabled={liftingAll || !bans}
                title="Lift every ban this server enforces — decisions scoped only to it are lifted, broader ones stop covering it, and the game's own list is emptied, bans placed outside the panel included">
                {liftingAll ? "Lifting…" : "Lift all on this server"}
              </button>
            )}
          </div>
          <AskNotice capability={["action.tempban", "action.permaban", "action.unban", "moderation.bans.sync"]} serverId={serverFilter || serverId} />
          {note && <p className="muted">{note}</p>}
          {composing && serverId && (
            <BanComposer
              serverId={serverId}
              game={servers.find((sv) => sv.id === serverId)?.game}
              onDone={(msg) => { setNote(msg); load(); }}
              onClose={() => setComposing(false)}
            />
          )}
          {/* In the list itself rather than the panel header: up there it wrapped out of sight on a
              phone and read as a page control, and this is the one control people reach for first. */}
          <div className="ban-search">
            <SearchInput value={q} onChange={setQ} placeholder="Search player, id, reason, staff, server…" />
          </div>
          <ActionResult error={error} />
          {!bans && !error && <SkeletonRows rows={6} cols={5} />}
          {bans && !bans.length && (q.trim() ? (
            <EmptyState icon="🚫" title="No bans match your search" filtered onClear={() => setQ("")}>
              Nothing on record matches “{q.trim()}”{showLifted ? "" : " — lifted and expired bans are hidden; switch them on to search those too"}.
            </EmptyState>
          ) : (
            <EmptyState icon="🚫" title="No bans on record">
              Bans your staff issue through the panel are listed here with who set them and why. Bans placed
              directly on the game server are under <strong>Live</strong>, above.
            </EmptyState>
          ))}
          {bans && bans.length > 0 && shownBans && !shownBans.length && (
            <p className="muted">No decision on record covers this server{showLifted ? "" : " (lifted and expired rows are hidden)"}.</p>
          )}
          {shownBans && shownBans.length > 0 && (
            <div className="scroll-x">
              <table>
                <thead><tr>
                  <SortTh s={sortPanel} k="when">When</SortTh>
                  <SortTh s={sortPanel} k="player">Player</SortTh>
                  <th>Id</th>
                  <SortTh s={sortPanel} k="type">Type</SortTh>
                  <SortTh s={sortPanel} k="platform">Platform</SortTh>
                  <th>Where</th>
                  <SortTh s={sortPanel} k="reason">Reason</SortTh>
                  <SortTh s={sortPanel} k="by">By</SortTh>
                  <th></th>
                </tr></thead>
                <tbody>
                  {(recordPages.items ?? []).map((b) => (
                    <tr key={b.id} style={b.active ? undefined : { opacity: 0.55 }}>
                      <td><Time iso={b.ts} /></td>
                      {/* Name and id are separate columns: a 32-hex id wearing the Player heading
                          read as a glitch, and the name is what a ban book is scanned by. The API
                          fills missing names from the directory; "unknown" is the honest remainder
                          — a player the panel has genuinely never seen. */}
                      <td><PlayerLink playerId={b.playerId} name={b.playerName || <span className="muted">unknown</span>} /></td>
                      {/* nowrap: a truncated hex id is one token; letting the column squeeze it
                          rendered a tall stack of two-character lines. */}
                      <td style={{ whiteSpace: "nowrap" }}><GameId id={b.playerId} truncate={12} /></td>
                      <td>
                        <span className={`badge ${b.type === "perma" ? "active" : "observe"}`}>{b.type}</span>
                        {b.expiresAt && b.active && <span className="muted"> until <Time iso={b.expiresAt} /></span>}
                      </td>
                      {/* The same names the By platform analytics use. A dash is an id the panel
                          has never seen, so there is no platform on record to show. */}
                      <td style={{ whiteSpace: "nowrap" }}>{platformLabel(b.platform) || <span className="muted">—</span>}</td>
                      {/* The RULE, not just today's expansion — "All servers" and a list of every
                          number look the same until the next server is added. On a two-game
                          install the game is folded INTO the phrase for the rule modes: a scope
                          is always per game, and "All servers · WW2" read as if it reached the
                          Vietnam box too — "All WW2 servers" says exactly how far it goes. */}
                      <td>{b.scope.mode === "all" ? (multiGame ? `All ${gameShortName(b.game)} servers` : "All servers")
                        : b.scope.mode === "except" ? `All ${multiGame ? `${gameShortName(b.game)} ` : ""}but ${(b.scope.serverIds ?? []).map((id) => numberOf(id) ?? "?").join(", ")}`
                        : <>{b.serverIds.map((id) => numberOf(id) ?? "?").join(", ") || "—"}{multiGame && <span className="muted"> · {gameShortName(b.game)}</span>}</>}</td>
                      <td style={{ whiteSpace: "normal" }}>{b.reason || ""}{b.category && <span className="muted"> · {b.category}</span>}</td>
                      <td>{b.by}{b.auto && <span className="muted"> (auto)</span>}</td>
                      {/* Over, and since when — and lifted by whom — in the row itself. Who lifted it lived in a
                          hover note a phone cannot show, and when was not said anywhere on the page. */}
                      <td>{b.active
                        ? <button className="mini ghost" disabled={!b.playerId} onClick={() => unban(b)}>Unban</button>
                        : <span className="muted">{b.liftedAt ? "lifted" : "expired"}
                            {b.liftedAt
                              ? <span className="ban-ended">{b.liftedBy ? `by ${b.liftedBy} · ` : ""}<Time iso={b.liftedAt} /></span>
                              : b.expiresAt && <span className="ban-ended"><Time iso={b.expiresAt} /></span>}
                          </span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {shownBans && shownBans.length > 0 && <Pager list={recordPages} noun="ban" />}
        </>
      ) : (
        <>
          <p className="muted">The server&apos;s own ban list, read live over RCON. Unban requires the server to be in <strong>active</strong> mode.</p>
          {note && <p className="muted">{note}</p>}
          {/* In the list itself rather than the panel header: up there it wrapped out of sight on a
              phone and read as a page control, and this is the one control people reach for first. */}
          <div className="ban-search">
            <SearchInput value={q} onChange={setQ} placeholder={"Search player, id, reason, staff…"} />
          </div>

          <ActionResult error={liveError} />
          {liveLoading && <p className="muted">Reading ban list…</p>}
          {live && (
            <p className="muted">
              {live.filter((b) => b.type === "temp").length} temporary{live.some((b) => b.ranOut) ? ` (${live.filter((b) => b.ranOut).length} ran out)` : ""} · {live.filter((b) => b.type === "perma").length} permanent
              {q.trim() && ` · ${liveFiltered.length} match “${q.trim()}”`}
            </p>
          )}
          {live && !liveFiltered.length && !liveLoading && (
            <EmptyState
              icon="⚖"
              title={q.trim() ? "No bans match your search" : "No bans on this server"}
              filtered={!!q.trim()}
              onClear={() => setQ("")}
            >
              {q.trim()
                ? <>The server has {live.length} ban{live.length === 1 ? "" : "s"}; none of them match “{q.trim()}”.</>
                : <>Bans you place from the panel, and any the game already holds, appear here.</>}
            </EmptyState>
          )}
          {liveFiltered.length > 0 && (
            <div className="scroll-x">
              <table>
                <thead><tr>
                  <SortTh s={sortLive} k="when">When</SortTh>
                  <SortTh s={sortLive} k="player">Player</SortTh>
                  <SortTh s={sortLive} k="type">Type</SortTh>
                  <th>Duration</th>
                  <SortTh s={sortLive} k="reason">Reason</SortTh>
                  <SortTh s={sortLive} k="by">By</SortTh>
                  <th></th>
                </tr></thead>
                <tbody>
                  {(livePages.items ?? []).map((b, i) => (
                    <tr key={i} style={b.ranOut ? { opacity: 0.55 } : undefined}>
                      <td>{b.ts ? fmt(b.ts) : "—"}</td>
                      <td>{b.playerName
                        ? <PlayerLink playerId={b.playerId} name={b.playerName} />
                        : <GameId id={b.playerId} truncate={12} />}</td>
                      <td><span className={`badge ${b.type === "perma" ? "active" : "observe"}`}>{b.type}</span></td>
                      <td>{b.type === "perma" ? "∞" : `${b.durationHours}h`}</td>
                      <td style={{ whiteSpace: "normal" }}>{b.reason}</td>
                      <td>{b.by || <span className="muted">—</span>}</td>
                      {/* A finished temp ban holds nobody and the game refuses to remove it: said, like an
                          expired decision in the record, rather than an Unban that fails. */}
                      <td>{b.ranOut
                        ? <span className="muted" title="Its time is up: the game no longer enforces it, and won't let it be removed">ran out</span>
                        : <button className="mini ghost" onClick={() => unbanLive(b)}>Unban</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {liveFiltered.length > 0 && <Pager list={livePages} noun="ban" />}
        </>
      )}
      </Panel>
    </PanelGroup>
  );
}
