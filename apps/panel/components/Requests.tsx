"use client";
/**
 * The approvals queue — Moderation → Requests.
 *
 * Two halves of one conversation. "Waiting on you" lists other people's open requests holding at
 * least one line THIS viewer may sign (the API computes that: what you could do yourself, on that
 * server). "Your requests" is what you filed — and carries the same buttons, because a promotion
 * can make you the person who can cover your own earlier ask.
 *
 * A signature applies as much as the signer's own authority covers; the remainder is filed
 * onwards for someone with more, so coverage climbs the chain one signature at a time.
 *
 * Lines resolve one by one, each stamped with who signed or denied it and when — so whoever is
 * awake picks off the lines they can, and the trail on the card reads as the coverage story.
 * Approve all is the same per-line decision in a loop: it signs what YOU may sign and says what
 * it left alone.
 */
import { useCallback, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useResource } from "../lib/resource";
import { useServers } from "../lib/servers";
import { useConfirm, usePrompt, useToast } from "../lib/feedback";
import { KIND_LABEL } from "../lib/approvals";
import { routeDetails } from "../lib/requestLines";
import { fmtExact } from "../lib/time";
import { useRequestMode } from "../lib/requestMode";
import { PlayerLink } from "./PlayerLink";
import { Panel, PanelGroup } from "./Panel";
import { Time } from "./Time";
import { ActionResult, EmptyState, Pager, SkeletonRows } from "./ui";
import { useClientPages } from "../lib/paged";
import { useSortable, SortTh } from "../lib/sort";
import { isFlag, isText, useRemembered } from "../lib/remembered";

interface Line {
  id: string; seq: number; serverId: string | null; capability: string; kind: string;
  payload: Record<string, unknown>;
  playerId: string | null; playerName: string | null;
  // Mirrors @app/db ApprovalLineState. "executed" is the builder's own line — held at write, so
  // it ran under the requester's name at submit rather than waiting for a signature. It was
  // missing here, and a Record keyed on this union then had no entry for it: the moment a
  // submitted bundle contained one, rendering threw and took the whole page down with it.
  // A test asserts this union against the server's, because the crash is invisible until data
  // of that shape exists.
  state: "pending" | "approved" | "denied" | "voided" | "executed";
  decidedByName: string | null; decidedAt: string | null; denyReason: string | null;
  modified: Record<string, { requested: number; granted: number }> | null;
  appliedAt: string | null; applyError: string | null;
  canSign: boolean; signRefusal: string | null;
  /** Set when this signer's own limit covers only PART of the ask: approving applies this much
   *  and files the rest onwards. Absent when they can cover all of it. */
  coversHours?: number;
}
interface Req {
  id: string; requesterName: string; status: "open" | "resolved" | "expired" | "withdrawn";
  note: string | null; submittedAt: string | null; expiresAt: string | null;
  own: boolean; lines: Line[];
}

const STATE_BADGE: Record<Line["state"], { label: string; cls: string }> = {
  pending: { label: "waiting", cls: "observe" },
  approved: { label: "approved", cls: "active" },
  denied: { label: "denied", cls: "err" },
  voided: { label: "never decided", cls: "" },
  // Applied at submit under the requester's OWN permissions — it never needed a signature. The
  // label is written from the reader's seat below, because "you" is only true on your own card.
  executed: { label: "already done", cls: "active" },
};
/**
 * Never index STATE_BADGE bare: an unknown state must degrade to a plain chip, not a crash.
 *
 * `side` fixes a badge that lied. An executed line said "done by you" wherever it appeared — so
 * an approver reading someone else's request saw their queue claim THEY had done a thing they
 * had never seen before, directly above the requester's name. "You" is only the reader on their
 * own card; everywhere else the line was applied by whoever filed it.
 */
const stateBadge = (s: string, side: "queue" | "mine") => {
  const b = STATE_BADGE[s as Line["state"]] ?? { label: s, cls: "" };
  if (s === "executed") return { ...b, label: side === "mine" ? "done by you" : "done by requester" };
  return b;
};

/** A filed CALL (map work, votes, configuration) says what it is from its own payload — the API
 *  writes the label in when it files it, so the queue never shows anybody a URL to sign. */
const kindLabel = (l: { kind: string; payload: Record<string, unknown> }) =>
  KIND_LABEL[l.kind] ?? (typeof l.payload.label === "string" ? l.payload.label : l.kind);

function lineDetails(l: Line): string {
  const p = l.payload;
  if (l.kind === "route") return routeDetails(p);
  const parts: string[] = [];
  // The over-cap split's card shows the live arithmetic the approver is signing: what was
  // applied at filing, how much of the sentence is already served, what approving adds.
  if (l.kind === "tempban_extend") {
    const applied = Number(p.appliedHours ?? 0);
    const total = Number(p.hours ?? 0);
    const start = Date.parse(String(p.banStart ?? ""));
    const served = Number.isFinite(start) ? Math.min(Math.max(0, (Date.now() - start) / 3_600_000), applied) : 0;
    const remaining = Math.max(0, total - served);
    const out = [`${applied}h applied at filing · served ${served.toFixed(1)}h of ${total}h asked — approving bans ${remaining.toFixed(1)}h more`];
    if (typeof p.reason === "string" && p.reason) out.push(`“${p.reason}”`);
    return out.join(" · ");
  }
  // What a revoke ENDS — a permanent grant is very often a paid one (the card says the same).
  if (l.kind === "vipRevoke" && p.grant && typeof p.grant === "object") {
    const g = p.grant as { expiration?: unknown; comment?: unknown };
    parts.push(g.expiration === null ? "ends PERMANENT VIP" : typeof g.expiration === "string" ? `VIP until ${fmtExact(g.expiration)}` : "dated VIP");
    if (typeof g.comment === "string" && g.comment) parts.push(`note “${g.comment}”`);
  }
  if (typeof p.hours === "number" && p.hours > 0) parts.push(`${p.hours}h`);
  if (typeof p.days === "number" && p.days > 0) parts.push(`${p.days}d`);
  // What a grant GIVES, the same way: the date it runs to rather than a bare "until", and the
  // comment every VIP added carries (who paid, what for, which event) — what the approver vouches for.
  if (l.kind === "vip" && p.mode === "until" && typeof p.expiresAt === "string") parts.push(`until ${fmtExact(p.expiresAt)}`);
  else if (typeof p.mode === "string" && p.mode) parts.push(String(p.mode));
  if (l.kind === "vip" && typeof p.comment === "string" && p.comment) parts.push(`comment “${p.comment}”`);
  if (typeof p.reason === "string" && p.reason) parts.push(`“${p.reason}”`);
  if (typeof p.message === "string" && p.message) parts.push(`“${p.message}”`);
  return parts.join(" · ");
}

/** One decided line, as the history table reads it — a DECISION, not a bundle. */
interface Decision {
  requestId: string; lineId: string;
  requesterName: string; filedAt: string | null; requestStatus: string;
  kind: string; serverId: string | null; serverName: string | null;
  playerId: string | null; playerName: string | null;
  state: string; decidedByName: string | null; decidedAt: string | null;
  denyReason: string | null; applyError: string | null;
  modified: Record<string, { requested: number; granted: number }> | null;
  /** `label`/`body` only for a filed CALL (kind "route") — its own words, and what it would do. */
  payload: { hours?: unknown; days?: unknown; reason?: unknown; message?: unknown; label?: unknown; body?: unknown };
}

/**
 * THE RECORD — every staff member's finished requests, for whoever holds the permission.
 *
 * Deliberately a flat table of decisions rather than the cards above it: the questions this
 * answers are "was that ban approved?", "who keeps denying these?", "what did we decide about this
 * player last month?" — all of which sort by a column. Sorting and filtering happen over the
 * window the API returned, and the panel says how big that window is rather than implying it has
 * everything.
 */
function RequestHistory() {
  const loader = useCallback(() => api<{ decisions?: Decision[]; limit?: number }>("/requests/history")
    .then((r) => ({ decisions: r.decisions ?? [], limit: r.limit ?? 0 })), []);
  const { data, error, reload } = useResource(loader);
  const [q, setQ] = useRemembered("requests.history.search", "", isText, "session");
  // The panel's shared table sorting: same header interaction, caret and remembered choice as
  // every other sortable table here.
  const sort = useSortable<Decision>({
    decided: (d) => d.decidedAt ?? "",
    filed: (d) => d.filedAt ?? "",
    outcome: (d) => d.state,
    action: (d) => kindLabel(d),
    player: (d) => d.playerName || d.playerId || "",
    asked: (d) => d.requesterName,
    signed: (d) => d.decidedByName ?? "",
    server: (d) => d.serverName ?? "",
  }, "decided", "desc", "request-history");

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = (data?.decisions ?? []).filter((d) => !needle || [
      d.playerName, d.playerId, d.requesterName, d.decidedByName, d.serverName,
      kindLabel(d), d.denyReason,
    ].some((v) => String(v ?? "").toLowerCase().includes(needle)));
    return sort.sorted(filtered);
  }, [data, q, sort]);
  // A page of the window at a time, filtered and sorted over all of it first.
  const pages = useClientPages(data ? rows : null, "requests.history", "", `${q.trim().toLowerCase()}\n${sort.key}:${sort.dir}`);

  return (
    <Panel id="history" caps="open" title="All request history" subtitle={data ? String(rows.length) : undefined}
      actions={<button className="mini ghost" onClick={reload}>Refresh</button>}>
      <ActionResult error={error} />
      {!data && !error && <SkeletonRows rows={4} cols={6} />}
      {data && !data.decisions.length && (
        <EmptyState icon="📚" title="No finished requests yet">
          Once staff requests are approved, denied or age out, every one of them is listed here —
          whoever asked, whoever signed, and why.
        </EmptyState>
      )}
      {data && data.decisions.length > 0 && (
        <>
          <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
            <input placeholder="Filter by player, staff member, action or reason…" value={q}
              onChange={(e) => setQ(e.target.value)} style={{ flex: "1 1 240px" }} />
            <span className="muted fs-sm">
              {rows.length} of {data.decisions.length} decision{data.decisions.length === 1 ? "" : "s"}
              {data.decisions.length >= (data.limit || Infinity) ? " (most recent)" : ""}
            </span>
          </div>
          <div className="scroll-x">
            <table>
              <thead><tr>
                <SortTh s={sort} k="decided">Decided</SortTh>
                <SortTh s={sort} k="outcome">Outcome</SortTh>
                <SortTh s={sort} k="action">Action</SortTh>
                <SortTh s={sort} k="player">Player</SortTh>
                <SortTh s={sort} k="server">Server</SortTh>
                <SortTh s={sort} k="asked">Asked by</SortTh>
                <SortTh s={sort} k="signed">Signed by</SortTh>
              </tr></thead>
              <tbody>
                {(pages.items ?? []).map((d) => (
                  <tr key={d.lineId}>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {d.decidedAt ? <Time iso={d.decidedAt} /> : <span className="muted">—</span>}
                    </td>
                    <td>
                      <span className={`badge ${stateBadge(d.state, "queue").cls}`}>{stateBadge(d.state, "queue").label}</span>
                      {d.denyReason && <div className="muted fs-xs wrap">“{d.denyReason}”</div>}
                      {d.applyError && <div className="fs-xs wrap" style={{ color: "var(--err)" }}>not applied: {d.applyError}</div>}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {kindLabel(d)}
                      {d.modified?.hours && <span className="muted fs-xs"> {d.modified.hours.requested}→{d.modified.hours.granted}h</span>}
                    </td>
                    <td>
                      {d.playerId
                        ? <><PlayerLink playerId={d.playerId} name={d.playerName || undefined} />
                            <div className="muted fs-xs mono-id">{d.playerId}</div></>
                        : <span className="muted">—</span>}
                    </td>
                    <td className="wrap">{d.serverName ?? <span className="muted">—</span>}</td>
                    <td>{d.requesterName}</td>
                    <td>{d.decidedByName || <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > 0 && <Pager list={pages} noun="decision" />}
        </>
      )}
    </Panel>
  );
}

export default function Requests({ canHistory = false }: { canHistory?: boolean }) {
  const { servers } = useServers();
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const requestMode = useRequestMode();
  const serverName = useMemo(() => new Map(servers.map((s) => [s.id, s.name])), [servers]);
  // Coalesced at the edge: an empty or older API answers {} and this page must render, not crash.
  const loader = useCallback(() => api<{ mine?: Req[]; queue?: Req[] }>("/requests").then((r) => ({ mine: r.mine ?? [], queue: r.queue ?? [] })), []);
  const { data, error, reload } = useResource(loader);
  const [busy, setBusy] = useState(false);
  // Per-line hour override for approve-with-modification — only DOWN from what was asked.
  const [modHours, setModHours] = useState<Record<string, string>>({});
  // Finished requests are history: present, folded, and out of the way of the live ones.
  const [showDone, setShowDone] = useRemembered("requests.showDone", false, isFlag, "session");
  const mineOpen = useMemo(() => (data?.mine ?? []).filter((r) => r.status === "open"), [data]);
  const mineDone = useMemo(() => (data?.mine ?? []).filter((r) => r.status !== "open"), [data]);

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try { await fn(); toast.success(done); reload(); }
    catch (e) { toast.error((e as Error).message); reload(); }
    finally { setBusy(false); }
  }

  function approve(r: Req, l: Line) {
    const requested = Number(l.payload.hours ?? 0);
    const overridden = modHours[l.id]?.trim();
    const granted = overridden ? Number(overridden) : requested;
    const modified = l.kind === "tempban" && overridden && granted !== requested ? { hours: granted } : undefined;
    void act(async () => {
      const res = await api<{ cascaded?: { appliedHours: number; requestedHours: number } }>(
        `/requests/${r.id}/lines/${l.id}/approve`, { method: "POST", body: modified ? { modified } : {} });
      // The chain, said out loud: what YOUR signature covered, and that the rest went upwards.
      if (res.cascaded) {
        toast.info(`Banned ${res.cascaded.appliedHours}h now (your limit) — the remaining ${res.cascaded.requestedHours - res.cascaded.appliedHours}h went for higher approval`);
      }
    }, modified ? `Approved at ${granted}h (asked ${requested}h)` : "Approved — executing now");
  }

  async function deny(r: Req, l: Line) {
    const reason = await prompt({
      title: `Deny ${kindLabel(l)}${l.playerName || l.playerId ? ` on ${l.playerName || l.playerId}` : ""}?`,
      label: "Why — the requester reads this",
      confirmLabel: "Deny",
    });
    if (!reason?.trim()) return;
    void act(() => api(`/requests/${r.id}/lines/${l.id}/deny`, { method: "POST", body: { reason: reason.trim() } }), "Denied — the requester sees your reason");
  }

  async function approveAll(r: Req) {
    const n = r.lines.filter((l) => l.canSign).length;
    if (!(await confirm({ title: `Approve ${n} line${n === 1 ? "" : "s"} from ${r.requesterName}?`, body: `Each line executes immediately on your authority, carried out under ${r.requesterName}'s name. Lines outside your permissions are left for someone who holds them.`, confirmLabel: `Approve ${n}` }))) return;
    void act(async () => {
      const res = await api<{ approved: unknown[]; skipped: { reason: string }[] }>(`/requests/${r.id}/approve-all`, { method: "POST" });
      if (res.skipped.length) toast.info(`${res.skipped.length} line(s) left for another approver`);
    }, "Approved");
  }

  function withdraw(r: Req) {
    void act(() => api(`/requests/${r.id}/withdraw`, { method: "POST" }), "Request withdrawn");
  }

  /*
   * ONE LINE PER ACTION.
   *
   * This was a five-column table, which on a phone meant a server called "[ABC] Example Community #1 |
   * MICS ON | LVL 50+ SL | LVL 100+ CMD…" wrapped to eight lines and a two-action request
   * filled the screen twice over. The facts are short — verb, who, where, the detail, the state —
   * so they belong on one row that truncates, with the full text one tap away in the title. What
   * cannot be truncated (a denial's reason, an execution that failed) drops to its own line
   * underneath, because those are the sentences someone is actually here to read.
   */
  const lineRow = (r: Req, l: Line, side: "queue" | "mine") => {
    const badge = stateBadge(l.state, side);
    const server = l.serverId ? serverName.get(l.serverId) ?? "server gone" : null;
    const detail = lineDetails(l);
    return (
      <div key={l.id} className="req-line">
        <div className="req-line-main">
          <span className={`badge ${badge.cls} req-line-state`}>{badge.label}</span>
          <strong className="req-line-kind">{kindLabel(l)}</strong>
          {l.playerId
            ? <span className="req-line-who" title={`${l.playerName ? `${l.playerName} · ` : ""}${l.playerId}`}>
                <PlayerLink playerId={l.playerId} name={l.playerName || undefined} />
                <span className="muted mono-id fs-xs"> · {l.playerId}</span>
              </span>
            /* A filed CALL is about a SERVER and never had a player, so the dash that stands for
               "we do not know who" read on those rows as data that failed to load. (The history
               table below keeps its dash — a column needs something to hold the cell.) */
            : l.kind !== "route" && <span className="muted">—</span>}
          {server && <span className="muted fs-sm req-line-where" title={server}>{server}</span>}
          {/* A filed CALL's detail is not decoration — it is the message being broadcast, the map
              being changed, the command being run — so it gets a line of its own below rather than
              the truncated slot that fits a player action's "24h · reason". */}
          {detail && l.kind !== "route" && <span className="muted fs-sm req-line-detail" title={detail}>{detail}</span>}
          {l.decidedByName && l.decidedAt && (
            <span className="muted fs-xs req-line-by">{l.decidedByName} <Time iso={l.decidedAt} /></span>
          )}
          {l.modified && Object.entries(l.modified).map(([f, m]) => (
            <span key={f} className="muted fs-xs">{f} {m.requested}→{m.granted}</span>
          ))}
          <span className="grow" />
          {l.state === "pending" && l.canSign && (
            <span className="row req-line-acts">
              {(l.kind === "tempban" || l.kind === "tempban_extend") && (
                <input
                  type="number" min="1" className="req-line-hours" aria-label="Hours to approve"
                  title="Approve at fewer hours than asked — only down, never up"
                  placeholder={String(l.payload.hours ?? "")}
                  value={modHours[l.id] ?? ""}
                  onChange={(e) => setModHours((s) => ({ ...s, [l.id]: e.target.value }))}
                />
              )}
              <button className="mini" disabled={busy} onClick={() => approve(r, l)}
                title={l.coversHours ? `Your limit covers ${l.coversHours}h of the ${l.payload.hours}h asked — the rest is filed for someone with a longer limit` : undefined}>
                {l.coversHours ? `Approve ${l.coversHours}h` : "Approve"}
              </button>
              <button className="mini ghost danger-ghost" disabled={busy} onClick={() => void deny(r, l)}>Deny</button>
            </span>
          )}
          {l.state === "pending" && !l.canSign && (
            <span className="muted fs-xs" title={l.signRefusal ?? undefined}>
              {side === "mine" ? "waiting for approval" : "not yours to sign"}
            </span>
          )}
        </div>
        {l.kind === "route" && detail && <div className="muted fs-sm req-line-note">{detail}</div>}
        {l.denyReason && <div className="muted fs-sm req-line-note">“{l.denyReason}”</div>}
        {/* An approval whose execution failed must never read as done. */}
        {l.applyError && <div className="fs-sm req-line-note" style={{ color: "var(--err)" }}>approved, but not applied: {l.applyError}</div>}
      </div>
    );
  };

  const card = (r: Req, side: "queue" | "mine") => (
    <div key={r.id} className="role-card req-card">
      <div className="row req-card-head">
        <strong>{side === "mine" ? "Your request" : r.requesterName}</strong>
        {r.submittedAt && <span className="muted fs-sm">filed <Time iso={r.submittedAt} /></span>}
        {r.status !== "open" && <span className={`badge ${r.status === "resolved" ? "active" : r.status === "expired" ? "err" : "observe"}`}>{r.status}</span>}
        {r.note && <span className="muted fs-sm">— {r.note}</span>}
        <span className="grow" />
        {side === "queue" && r.status === "open" && r.lines.filter((l) => l.canSign).length > 1 && (
          <button className="mini" disabled={busy} onClick={() => approveAll(r)}>Approve all ({r.lines.filter((l) => l.canSign).length})</button>
        )}
        {side === "mine" && r.status === "open" && (
          <button className="mini ghost" disabled={busy} onClick={() => withdraw(r)}>Withdraw</button>
        )}
      </div>
      {r.lines.map((l) => lineRow(r, l, side))}
    </div>
  );

  return (
    <PanelGroup viewId="requests">
      <Panel id="queue" caps="open" title="Waiting on you" subtitle={data ? String(data.queue.length) : undefined}
        actions={<>
          {!requestMode.building && (
            <button className="mini" onClick={() => void requestMode.start().catch((e) => toast.error(`Couldn't start a request: ${(e as Error).message}`))} title="Use the app as normal — every action you confirm is captured into one request instead of executing, until you review and submit.">
              Build a request
            </button>
          )}
          <button className="mini ghost" onClick={reload}>Refresh</button>
        </>}>
        <ActionResult error={error} />
        {!data && !error && <SkeletonRows rows={3} cols={5} />}
        {data && !data.queue.length && (
          <EmptyState icon="✅" title="Nothing waiting on you">
            When staff who need approval file a request you can sign — an action you hold at write,
            on that server — it appears here with Approve and Deny on every line.
          </EmptyState>
        )}
        {data?.queue.map((r) => card(r, "queue"))}
      </Panel>

      {/*
        * Live requests only. A finished one is a record, not a task: leaving them stacked above
        * the thing you came to do meant scrolling past last week's approvals to find today's
        * open one. They keep their reasons and stamps — folded away, one click from being read.
        */}
      <Panel id="mine" caps="open" title="Your requests" subtitle={data ? String(mineOpen.length) : undefined}>
        {!data && !error && <SkeletonRows rows={2} cols={5} />}
        {data && !mineOpen.length && !mineDone.length && (
          <EmptyState icon="✋" title="You have not filed any requests">
            Any action you lack the permission for submits from its usual dialog — the confirm
            reads “Send for approval” and files it here for someone who holds the permission to
            sign, and the outcome (with any reason) lands back on this page.
          </EmptyState>
        )}
        {data && !mineOpen.length && mineDone.length > 0 && (
          <p className="muted mt-0">Nothing of yours is waiting — {mineDone.length} finished request{mineDone.length === 1 ? "" : "s"} below.</p>
        )}
        {mineOpen.map((r) => card(r, "mine"))}

        {mineDone.length > 0 && (
          <div className="req-done">
            <button className="mini ghost" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
              {showDone ? "▾" : "▸"} Completed ({mineDone.length})
            </button>
            {showDone && mineDone.map((r) => card(r, "mine"))}
          </div>
        )}
      </Panel>

      {/* The team's finished work — its own permission, because reading everyone else's decisions
          is a different question from filing your own or signing what waits on you. */}
      {canHistory && <RequestHistory />}
    </PanelGroup>
  );
}
