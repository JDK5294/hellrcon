"use client";
/**
 * Bulk payouts, as a panel screen (docs/bulk-payout.md).
 *
 * The flow IS the safety story, in order: pick who (source + audience) → PREVIEW the exact list,
 * with everyone the rules dropped counted out loud → strike people off by hand → dry run if you
 * want the receipts without the money → execute → watch the receipts arrive. The server re-runs
 * the whole resolution on execute, so this screen's list is display, never authority.
 *
 * Currency reaches linked members only (a balance is a Discord-account fact); VIP chooses its
 * audience: everyone the source saw, linked only, or holders of one Discord role.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { api, fmt } from "../lib/api";
import { useServers } from "../lib/servers";
import { isoToWall, wallToIso, zoneLabel } from "../lib/time";
import { fileStem, type Sheet } from "../lib/download";
import { DownloadButton } from "./Download";
import { ActionResult, AskNotice, Callout, Divider, EmptyState, Pager, SkeletonRows, Explanation, roleListNote } from "./ui";
import { useClientPages, usePagedList } from "../lib/paged";
import { Panel, PanelGroup } from "./Panel";
import type { PayoutEvent } from "./Events";

interface Recipient {
  discordId: string | null; playerId: string | null; displayName: string; sourceName: string | null; minutes: number | null;
  /** Set under a role-tiered payout: the tier amount (null = the base amount) and the role that decided it. */
  amount?: number | null; tierRoleId?: string;
}
interface Dropped { unlinked: number; noRole: number; underMinutes: number; removed: number; noGameAccount: number }
interface Job {
  id: string; sourceType: string; payoutType: "currency" | "vip"; amount: number; serverIds: string[];
  audience: string; dryRun: boolean; status: string; requestedByName: string; createdAt: string;
  completedAt: string | null; totalCount: number; successCount: number; failedCount: number;
  /** The source's stored parameters; carries the role tiers when the payout was tiered. */
  sourceRef?: { tiers?: { roleId: string; amount: number | null }[] };
}
interface Item { id: number; displayName: string; discordId: string | null; status: "PASS" | "FAIL" | "PENDING"; error: string; detail: Record<string, unknown> }
interface GuildRole { id: string; name: string }

type SourceType = "linked" | "online" | "window" | "event" | "retry";

const recipientKey = (r: { discordId: string | null; playerId: string | null }) => (r.discordId ? `d:${r.discordId}` : `p:${r.playerId ?? ""}`);

// Typed window bounds are read in the DISPLAY zone (wallToIso) — the community's clock, or the
// zone this admin chose in Settings — never whatever the device happens to be set to.

export default function Payouts({ canRun, payEvent }: {
  canRun: boolean;
  /** Handed across from the Events tab's "Pay this event" — pre-selects the event source. The
   *  nonce makes a repeat press of the SAME event a new value, so it lands every time. */
  payEvent?: { id: string; nonce: number } | null;
}) {
  const { servers } = useServers();

  // The builder.
  const [sourceType, setSourceType] = useState<SourceType>("online");
  const [sourceServer, setSourceServer] = useState("");
  const [winFrom, setWinFrom] = useState("");
  const [winTo, setWinTo] = useState("");
  const [minMinutes, setMinMinutes] = useState("0");
  const [retryJobId, setRetryJobId] = useState("");
  const [eventId, setEventId] = useState("");
  const [kind, setKind] = useState<"currency" | "vip">("currency");
  const [audience, setAudience] = useState<"everyone" | "linked" | "role">("linked");
  const [roleId, setRoleId] = useState("");
  const [roles, setRoles] = useState<GuildRole[] | null>(null);
  // Why the role pickers are empty, when they are: Discord's answer, or a read that failed.
  const [rolesNote, setRolesNote] = useState("");
  const [amount, setAmount] = useState("");
  /** Role tiers: per-role amounts. Order is priority; a blank amount means the base Amount. */
  const [tiers, setTiers] = useState<{ roleId: string; amount: string }[]>([]);
  const [vipServers, setVipServers] = useState<string[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(new Set());

  // Preview + run state.
  const [recipients, setRecipients] = useState<Recipient[] | null>(null);
  const [dropped, setDropped] = useState<Dropped | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [watch, setWatch] = useState<{ job: Job; items: Item[]; itemsTotal: number } | null>(null);
  const watchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // History.
  const [openJob, setOpenJob] = useState<{ job: Job; items: Item[] } | null>(null);

  // Events (named self-resolving windows).
  const [events, setEvents] = useState<PayoutEvent[] | null>(null);

  // The history a page at a time, newest first. It read the newest fifty and no more, so an older
  // run — its receipts, its "Pay the rest" — could not be reached from here.
  const fetchHistory = useCallback((offset: number, limit: number) =>
    api<{ items?: Job[]; total?: number }>(`/payouts?offset=${offset}&limit=${limit}`)
      .then((r) => ({ items: r.items ?? [], total: r.total ?? null })), []);
  const historyList = usePagedList<Job>(fetchHistory, "payouts.history");
  const history = historyList.items;
  const loadHistory = historyList.reload;
  useEffect(() => { if (historyList.error) setErr(historyList.error); }, [historyList.error]);
  // What "Payout to retry" offers: the newest runs with someone still unpaid, read when it is the
  // source — and a run picked from any page of the history with its button, older or not. Read
  // again when a run finishes, as the history is.
  const [retryable, setRetryable] = useState<Job[] | null>(null);
  const [retryPick, setRetryPick] = useState<Job | null>(null);
  const [retryRead, setRetryRead] = useState(0);
  useEffect(() => {
    if (sourceType !== "retry") return;
    let live = true;
    api<{ items?: Job[] }>("/payouts?limit=200")
      .then((r) => { if (live) setRetryable((r.items ?? []).filter((j) => !j.dryRun && j.failedCount > 0)); })
      .catch((e) => { if (live) setErr((e as Error).message); });
    return () => { live = false; };
  }, [sourceType, retryRead]);
  const retryOptions = retryPick && !(retryable ?? []).some((j) => j.id === retryPick.id) ? [retryPick, ...(retryable ?? [])] : retryable ?? [];

  const loadEvents = useCallback(() => {
    api<{ items?: PayoutEvent[] }>("/payout-events?limit=50").then((r) => setEvents(r.items ?? [])).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { loadEvents(); }, [loadEvents]);

  // "Pay this event" arriving from the Events tab: point the builder at that event.
  useEffect(() => {
    if (payEvent) { setSourceType("event"); setEventId(payEvent.id); }
  }, [payEvent]);

  // An event carries its own attendance floor, set when it was scheduled, and the API applies it
  // whether or not this screen mentions it. Show the number that is about to exclude people —
  // "3 were under the minutes" with no floor on screen is not something anybody can act on.
  useEffect(() => {
    if (sourceType !== "event" || !eventId) return;
    const ev = (events ?? []).find((e) => e.id === eventId);
    if (ev) setMinMinutes(String(ev.minMinutes ?? 0));
  }, [sourceType, eventId, events]);

  useEffect(() => {
    if (roles !== null) return;
    // Roles are needed the moment any role-shaped choice appears: the VIP role audience, or a tier row.
    if (!(kind === "vip" && audience === "role") && tiers.length === 0) return;
    api<{ roles?: GuildRole[]; error?: string; botConfigured?: boolean }>("/discord/roles?guild=community")
      .then((r) => { setRoles(r.roles ?? []); setRolesNote(roleListNote(r)); })
      .catch((e) => { setRoles([]); setRolesNote(`Couldn't read the Discord role list: ${(e as Error).message}`); });
  }, [kind, audience, roles, tiers.length]);

  /** The tiers as the API takes them; null when no rows (an untiered payout). */
  const tierBody = useCallback(() => (tiers.length
    ? tiers.map((t) => ({ roleId: t.roleId, amount: t.amount.trim() === "" ? null : Number(t.amount) }))
    : null), [tiers]);

  const sourceBody = useCallback(() => {
    const src: Record<string, unknown> = { type: sourceType };
    if (sourceType === "online" || sourceType === "window") src.serverId = sourceServer;
    if (sourceType === "window") {
      src.from = wallToIso(winFrom);
      src.to = wallToIso(winTo);
    }
    /*
     * Both presence sources carry per-person minutes, so both can be floored — and only they can:
     * a retry's candidates come from an earlier job's rows and have no minutes at all, so a floor
     * riding along would drop every one of them.
     *
     * The event's own floor is sent EXPLICITLY, including a zero. The API falls back to the
     * event's stored `minMinutes` when the request names none, so a blank field is not "no floor"
     * there — it is the event's floor, silently. The box is seeded from the event below, so the
     * default stays the event's; typing 0 into it now means what it says.
     */
    if (sourceType === "window" || sourceType === "event") {
      const n = Number(minMinutes);
      if (Number.isInteger(n) && n >= 0 && (n > 0 || sourceType === "event")) src.minMinutes = n;
    }
    if (sourceType === "retry") src.jobId = retryJobId;
    if (sourceType === "event") src.eventId = eventId;
    return src;
  }, [sourceType, sourceServer, winFrom, winTo, minMinutes, retryJobId, eventId]);

  const preview = useCallback((removedNow: Set<string>) => {
    setBusy(true); setErr(""); setOk(""); setWatch(null);
    api<{ recipients: Recipient[]; dropped: Dropped }>("/payouts/preview", {
      method: "POST",
      body: { source: sourceBody(), kind, audience: kind === "currency" ? "linked" : audience, roleId: roleId || null, tiers: tierBody(), removedKeys: [...removedNow] },
    })
      .then((r) => { setRecipients(r.recipients ?? []); setDropped(r.dropped ?? null); })
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  }, [sourceBody, kind, audience, roleId, tierBody]);

  // A preview goes stale the moment its inputs change — showing yesterday's list above today's
  // button is how the wrong hundred people get paid.
  useEffect(() => { setRecipients(null); setDropped(null); setRemoved(new Set()); }, [sourceType, sourceServer, winFrom, winTo, minMinutes, retryJobId, eventId, kind, audience, roleId, tiers]);

  const strike = (r: Recipient) => {
    const next = new Set(removed);
    next.add(recipientKey(r));
    setRemoved(next);
    setRecipients((cur) => cur?.filter((x) => recipientKey(x) !== recipientKey(r)) ?? null);
  };

  // A named function expression so the re-poll can call itself — a useCallback referencing its
  // own binding trips the no-use-before-declare rule.
  const pollJob = useCallback(function poll(jobId: string) {
    api<{ job: Job; items: Item[]; itemsTotal: number }>(`/payouts/${jobId}?limit=2000`)
      .then((r) => {
        setWatch(r);
        if (r.job.status === "RUNNING") {
          watchTimer.current = setTimeout(() => poll(jobId), 1000);
        } else {
          loadHistory();
          setRetryRead((n) => n + 1);
          setOk(r.job.status === "COMPLETE"
            ? `${r.job.dryRun ? "Dry run" : "Payout"} complete: ${r.job.successCount}/${r.job.totalCount} ${r.job.dryRun ? "would be paid" : "paid"}.`
            : `${r.job.dryRun ? "Dry run" : "Payout"} finished with failures: ${r.job.successCount} ok, ${r.job.failedCount} failed — the receipts say why, and Retry failures pays the rest.`);
        }
      })
      .catch((e) => setErr(e.message));
  }, [loadHistory]);
  useEffect(() => () => { if (watchTimer.current) clearTimeout(watchTimer.current); }, []);

  const execute = (dryRun: boolean) => {
    setBusy(true); setErr(""); setOk("");
    api<{ job: Job }>("/payouts", {
      method: "POST",
      body: {
        source: sourceBody(), kind, audience: kind === "currency" ? "linked" : audience, roleId: roleId || null,
        tiers: tierBody(), removedKeys: [...removed], amount: Number(amount), serverIds: kind === "vip" ? vipServers : [], dryRun,
      },
    })
      .then((r) => pollJob(r.job.id))
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  };

  const openHistoryJob = (job: Job) => {
    api<{ job: Job; items: Item[] }>(`/payouts/${job.id}?limit=2000`).then((r) => setOpenJob(r)).catch((e) => setErr(e.message));
  };
  const retryFailures = (job: Job) => {
    setRetryPick(job);
    setSourceType("retry"); setRetryJobId(job.id); setKind(job.payoutType);
    setAmount(String(job.amount)); setVipServers(job.serverIds); setOpenJob(null);
    // A tiered job retries with its tiers, or the retried rows would all get the base amount.
    setTiers((job.sourceRef?.tiers ?? []).map((t) => ({ roleId: t.roleId, amount: t.amount === null ? "" : String(t.amount) })));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const amountLabel = kind === "vip" ? "VIP days" : "points";
  const previewReady = recipients !== null && recipients.length > 0;
  const tiersComplete = tiers.every((t) => t.roleId && (t.amount.trim() === "" || Number(t.amount) > 0));
  /** A blank tier pays the base, so the base is only needed once one is left blank — price every
   *  tier and the base is never read. Requiring it anyway refused payouts that were complete. */
  const basePays = !tiers.length || tiers.some((t) => t.amount.trim() === "");
  const baseOk = basePays ? Number.isInteger(Number(amount)) && Number(amount) > 0 : true;
  const canExecute = canRun && previewReady && baseOk
    && tiersComplete && (kind === "currency" || vipServers.length > 0);

  return (
    <div>
      <PanelGroup viewId="payouts">
        <Panel id="payout-build" title="New payout" subtitle="Choose who, preview the exact list, rehearse, then pay." caps="economy.payout">
          {canRun && <AskNotice capability="economy.payout" />}

          <div className="form-row">
            <label>Recipients come from
              <select value={sourceType} onChange={(e) => setSourceType(e.target.value as SourceType)}>
                <option value="online">Players online now</option>
                <option value="window">Everyone on during a time window</option>
                <option value="event">A scheduled event</option>
                <option value="linked">All linked members</option>
                <option value="retry">Failed or unreached rows of an earlier payout</option>
              </select>
            </label>
            {sourceType === "event" && (
              <label>Event
                <select value={eventId} onChange={(e) => setEventId(e.target.value)}>
                  <option value="">Pick an event…</option>
                  {(events ?? []).filter((ev) => ev.status === "open" || ev.status === "closed").map((ev) => (
                    <option key={ev.id} value={ev.id}>{ev.name} — {ev.status}</option>
                  ))}
                </select>
              </label>
            )}
            {(sourceType === "online" || sourceType === "window") && (
              <label>Server
                <select value={sourceServer} onChange={(e) => setSourceServer(e.target.value)}>
                  <option value="">Pick a server…</option>
                  {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
            )}
            {sourceType === "window" && (<>
              <label>From ({zoneLabel()})<input type="datetime-local" value={winFrom} onChange={(e) => setWinFrom(e.target.value)} /></label>
              <label>To ({zoneLabel()})<input type="datetime-local" value={winTo} onChange={(e) => setWinTo(e.target.value)} /></label>
            </>)}
            {/* The attendance floor belongs to both presence sources. An EVENT is the one people
                actually pay — "everyone who came on Friday" — and it read attendance the same way
                a hand-typed window does, minute for minute, while the field that keeps somebody
                who joined for ninety seconds off the list was only offered on the window. */}
            {(sourceType === "window" || sourceType === "event") && (
              <label>Present at least (minutes)
                <input type="number" min={0} value={minMinutes} onChange={(e) => setMinMinutes(e.target.value)} />
              </label>
            )}
            {sourceType === "retry" && (
              <label>Payout to retry
                <select value={retryJobId} onChange={(e) => setRetryJobId(e.target.value)}>
                  <option value="">Pick a payout with people still unpaid…</option>
                  {retryOptions.map((j) => (
                    <option key={j.id} value={j.id}>{fmt(j.createdAt)} — {j.amount} {j.payoutType === "vip" ? "days" : "pts"}, {j.failedCount} {j.status === "INTERRUPTED" ? "unpaid (cut off)" : "failed"}</option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div className="form-row">
            <label>Pay
              <select value={kind} onChange={(e) => setKind(e.target.value as "currency" | "vip")}>
                <option value="currency">Currency (linked members only)</option>
                <option value="vip">VIP days</option>
              </select>
            </label>
            {kind === "vip" && tiers.length === 0 && (
              <label>To
                <select value={audience} onChange={(e) => setAudience(e.target.value as typeof audience)}>
                  <option value="everyone">Everyone the source saw</option>
                  <option value="linked">Linked members only</option>
                  <option value="role">Holders of a Discord role</option>
                </select>
              </label>
            )}
            {kind === "vip" && tiers.length === 0 && audience === "role" && (
              <label>Role
                <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                  <option value="">Pick a role…</option>
                  {(roles ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </label>
            )}
            {/* Say when the base is not needed, rather than leaving a blank field that looks
                unfinished: with every tier priced, nothing reads it. */}
            <label>{tiers.length ? `Base amount${basePays ? "" : " (not used)"}` : "Amount"} ({amountLabel})
              <input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)}
                placeholder={!basePays ? "every tier has its own" : kind === "vip" ? "days" : "points"} />
            </label>
          </div>
          {rolesNote && roles !== null && roles.length === 0 && ((kind === "vip" && audience === "role") || tiers.length > 0) && <p className="hint">{rolesNote}</p>}

          {/* Role tiers: pay different roles different amounts, instead of all-or-nothing. */}
          <div className="form-stack">
            {tiers.length > 0 && (
              <Explanation>
                Only linked members holding one of these roles are paid. The first matching row decides
                someone's amount, so put the generous tiers first. A blank amount pays the base amount.
              </Explanation>
            )}
            {tiers.map((t, i) => (
              <div className="form-row" key={i}>
                <label>Role
                  <select value={t.roleId} onChange={(e) => setTiers((cur) => cur.map((x, j) => j === i ? { ...x, roleId: e.target.value } : x))}>
                    <option value="">Pick a role…</option>
                    {(roles ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </label>
                <label>Amount ({amountLabel})
                  <input type="number" min={1} value={t.amount} placeholder="same as base"
                    onChange={(e) => setTiers((cur) => cur.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} />
                </label>
                <button className="quiet" title="Remove this tier"
                  onClick={() => setTiers((cur) => cur.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            <div>
              <button className="quiet" onClick={() => setTiers((cur) => [...cur, { roleId: "", amount: "" }])}>
                {tiers.length ? "+ Add another role tier" : "+ Split by role (pay roles different amounts)"}
              </button>
            </div>
          </div>

          {kind === "vip" && (
            <div className="form-row" role="group" aria-label="VIP lands on">
              <span className="muted">VIP lands on:</span>
              {servers.map((s) => (
                <label key={s.id} className="inline">
                  <input type="checkbox" checked={vipServers.includes(s.id)}
                    onChange={(e) => setVipServers((cur) => e.target.checked ? [...cur, s.id] : cur.filter((x) => x !== s.id))} />
                  {s.name}
                </label>
              ))}
            </div>
          )}

          <div className="form-row">
            <button onClick={() => preview(removed)} disabled={busy}>Preview recipients</button>
            <button onClick={() => execute(true)} disabled={busy || !canExecute}>Dry run</button>
            <button className="primary" onClick={() => execute(false)} disabled={busy || !canExecute}
              title={previewReady ? "" : "Preview first — execute refuses an unseen list"}>
              Pay {recipients?.length ?? ""} {recipients ? `recipient${recipients.length === 1 ? "" : "s"}` : ""}
            </button>
          </div>
          <ActionResult ok={ok} error={err} />

          {dropped && (dropped.unlinked + dropped.noRole + dropped.underMinutes + dropped.noGameAccount + dropped.removed > 0) && (
            <Callout variant="info">
              Not on the list: {[
                dropped.unlinked ? `${dropped.unlinked} not linked to Discord` : "",
                dropped.noRole ? `${dropped.noRole} without the role` : "",
                dropped.underMinutes ? `${dropped.underMinutes} under the minutes floor` : "",
                dropped.noGameAccount ? `${dropped.noGameAccount} with no game account` : "",
                dropped.removed ? `${dropped.removed} struck off by hand` : "",
              ].filter(Boolean).join(" · ")}
            </Callout>
          )}

          {recipients !== null && (recipients.length === 0
            ? <EmptyState title="Nobody matches">The source and audience produced no recipients.</EmptyState>
            : (
              <Paged rows={recipients} noun="recipient" render={(rows) => {
                const tiered = rows.some((r) => r.tierRoleId);
                const roleName = (id?: string) => (id && (roles ?? []).find((x) => x.id === id)?.name) || null;
                return (
                  <div className="scroll-x">
                    <table className="data">
                      <thead><tr><th>Recipient</th><th>In game</th><th>Linked</th><th>Minutes</th>{tiered && <th>Gets</th>}<th /></tr></thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={recipientKey(r)}>
                            <td>{r.displayName}</td>
                            <td>{r.sourceName ?? "—"}</td>
                            <td>{r.discordId ? "yes" : "no"}</td>
                            <td>{r.minutes ?? "—"}</td>
                            {tiered && (
                              <td title={roleName(r.tierRoleId) ? `via ${roleName(r.tierRoleId)}` : undefined}>
                                {r.amount ?? (Number(amount) || "base")} {amountLabel}
                              </td>
                            )}
                            <td><button className="quiet" onClick={() => strike(r)} title="Strike off this payout">✕</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              }} />
            ))}
        </Panel>

        {watch && (
          <Panel id="payout-run" title={watch.job.dryRun ? "Dry run" : "Payout"} subtitle={`Job ${watch.job.id}`} caps="economy.payout">
            <p>
              {watch.job.status === "RUNNING"
                ? `Paying… ${watch.items.filter((i) => i.status !== "PENDING").length}/${watch.job.totalCount}`
                : watch.job.status === "INTERRUPTED"
                  ? `Cut off part-way (the panel restarted) — ${watch.job.successCount} paid, ${watch.job.failedCount} not. "Pay the rest" in the history below pays only those.`
                  : `${watch.job.status} — ${watch.job.successCount} ok, ${watch.job.failedCount} failed`}
            </p>
            <ReceiptTable job={watch.job} items={watch.items} />
          </Panel>
        )}

        <Panel id="payout-history" title="Payout history" subtitle="Every run, with per-person receipts." caps="economy.payout">
          {history === null ? <SkeletonRows rows={4} cols={6} /> : history.length === 0
            ? <EmptyState title="No payouts yet">The first one will be on the record here.</EmptyState>
            : (
              <div className="scroll-x">
                <table className="data">
                  <thead><tr><th>When</th><th>What</th><th>Who</th><th>Result</th><th>By</th><th /></tr></thead>
                  <tbody>
                    {history.map((j) => (
                      <tr key={j.id}>
                        <td>{fmt(j.createdAt)}</td>
                        <td>{j.amount} {j.payoutType === "vip" ? "VIP day(s)" : "point(s)"}{j.dryRun ? " (dry run)" : ""}</td>
                        <td>{j.totalCount} via {j.sourceType}</td>
                        <td>{j.status === "COMPLETE" ? `✓ ${j.successCount}` : j.status === "RUNNING" ? "running…"
                          : j.status === "INTERRUPTED" ? `cut off: ${j.successCount} paid / ${j.failedCount} unpaid` : `${j.successCount} ok / ${j.failedCount} failed`}</td>
                        <td>{j.requestedByName}</td>
                        <td className="row-actions">
                          <button className="quiet" onClick={() => openHistoryJob(j)}>Receipts</button>
                          {canRun && !j.dryRun && j.failedCount > 0 && <button className="quiet" onClick={() => retryFailures(j)}>{j.status === "INTERRUPTED" ? "Pay the rest" : "Retry failures"}</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          {history !== null && history.length > 0 && <Pager list={historyList} noun="payout" />}

          {openJob && (<>
            <Divider label={`Receipts — ${fmt(openJob.job.createdAt)}`} />
            <ReceiptTable job={openJob.job} items={openJob.items} />
          </>)}
        </Panel>
      </PanelGroup>
    </div>
  );
}

/** A long list a page at a time, with the pager every list has: a 2000-recipient preview drawn
 *  whole locks the tab. It drew the first 300 and no more; now every row is a page away. */
function Paged<T>({ rows, noun, render }: { rows: T[]; noun: string; render: (rows: T[]) => ReactElement }) {
  const pages = useClientPages(rows);
  return (
    <div>
      {render(pages.items ?? [])}
      <Pager list={pages} noun={noun} />
    </div>
  );
}

function ReceiptTable({ job, items }: { job: Job; items: Item[] }) {
  if (!items.length) return <p className="muted">No receipts yet.</p>;
  return (
    <>
    <div className="control-row">
      <DownloadButton file={fileStem("payout", isoToWall(job.createdAt).slice(0, 10), "receipts")} title="Download the receipts"
        count={job.totalCount} noun="receipt" scope="every one this payout wrote" sheet={() => receiptSheet(job)} />
    </div>
    {job.totalCount > items.length && (
      <p className="muted fs-sm">The first {items.length.toLocaleString()} of {job.totalCount.toLocaleString()} are here — the receipts&apos; Download has all of them.</p>
    )}
    <Paged rows={items} noun="receipt" render={(rows) => (
      <div className="scroll-x">
        <table className="data">
          <thead><tr><th>Recipient</th><th>Status</th><th>Detail</th></tr></thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id}>
                <td>{i.displayName}</td>
                <td>{i.status === "PASS" ? "✓ paid" : i.status === "PENDING" ? "… not reached" : "✗ failed"}</td>
                <td className="muted">{i.status === "FAIL" ? i.error : i.status === "PENDING" ? "" : receiptSummary(i.detail)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )} />
    </>
  );
}

/** The most receipts one read returns. */
const RECEIPT_PAGE = 2000;

/** Every receipt a payout wrote, read a page at a time: the screen holds the first page only. */
async function receiptSheet(job: Job): Promise<Sheet> {
  const items: Item[] = [];
  for (;;) {
    const r = await api<{ items: Item[]; itemsTotal: number }>(`/payouts/${job.id}?limit=${RECEIPT_PAGE}&offset=${items.length}`);
    items.push(...r.items);
    if (r.items.length < RECEIPT_PAGE || items.length >= r.itemsTotal) break;
  }
  return {
    name: "Receipts",
    columns: [
      { key: "recipient", label: "Recipient" },
      { key: "discordId", label: "Discord ID" },
      { key: "result", label: "Result" },
      { key: "detail", label: "Detail" },
    ],
    rows: items.map((i) => [
      i.displayName, i.discordId, i.status === "PASS" ? "paid" : i.status === "PENDING" ? "not reached" : "failed",
      i.status === "FAIL" ? i.error : i.status === "PENDING" ? "" : receiptSummary(i.detail),
    ]),
  };
}

/** One line a human can read off the jsonb receipt, whichever payout type wrote it. */
function receiptSummary(detail: Record<string, unknown>): string {
  // Under a tiered payout each row was paid its own amount — the receipt says which.
  const tier = typeof detail.amount === "number" ? `${detail.amount} · ` : "";
  if (typeof detail.balanceAfter === "number") {
    if (detail.applied === false) return `${tier}already paid by the run this retries — ${detail.balanceAfter}`;
    const capped = detail.capped ? " (capped)" : "";
    return `${tier}${detail.balanceBefore} → ${detail.balanceAfter}${capped}`;
  }
  const servers = detail.servers as Record<string, { after?: string | null; alreadyPermanent?: boolean; alreadyPaid?: boolean; skipped?: string; error?: string }> | undefined;
  if (servers) {
    return tier + Object.values(servers).map((s) =>
      s.error ? `failed: ${s.error}`
        : s.skipped ? `skipped (${s.skipped})`
          : s.alreadyPaid ? "already paid by the run this retries — untouched"
          : s.alreadyPermanent ? "already permanent — untouched"
            : s.after ? `until ${fmt(s.after)}` : "granted",
    ).join(" · ");
  }
  return "";
}
