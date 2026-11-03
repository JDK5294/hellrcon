"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, wasFiled } from "../lib/api";
import { useConfirm } from "../lib/feedback";
import { PanelGroup, Panel } from "./Panel";
import { AskNotice, Toggle, Explanation } from "./ui";
import { Time } from "./Time";

/** One trimmable thing as /trim/options describes it — the catalog lives in @app/db and is served
 *  by the API, so a data type added there appears here without a panel change. */
interface TrimOption { id: string; label: string; hint: string }

const DAY_PRESETS = [30, 90, 180, 365];

/** What is deliberately never offered here, said out loud — an absent toggle otherwise reads as
 *  an oversight rather than a decision. */
const KEPT_FOREVER =
  "Kept forever, on purpose: bans and blacklist records, watch history, VIP grants, the economy " +
  "ledger (balances stay explainable), player notes, players themselves and their career stats.";

export default function Trim() {
  const confirm = useConfirm();
  const [options, setOptions] = useState<{ categories: TrimOption[]; datasets: TrimOption[] } | null>(null);
  const [optionsError, setOptionsError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [days, setDays] = useState("90");
  const [backup, setBackup] = useState(true);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [countsFor, setCountsFor] = useState(""); // the days value the counts were computed at
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");

  useEffect(() => {
    // An answer missing its lists is nothing to trim, not a crash.
    api<{ categories?: TrimOption[]; datasets?: TrimOption[] }>("/trim/options")
      .then((o) => setOptions({ categories: o.categories ?? [], datasets: o.datasets ?? [] }))
      .catch((e) => setOptionsError((e as Error).message));
  }, []);

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  /**
   * The cutoff has to be a number before anything may act on it.
   *
   * The box is free text, and `Number("")` and `Number("abc")` are 0 and NaN — both of which
   * reached the API as "everything older than now", the most destructive cutoff there is, from a
   * cleared field or a typo. The API refuses those now; this stops the buttons before they ask.
   */
  const cutoff = days.trim() === "" ? NaN : Number(days);
  const cutoffOk = Number.isFinite(cutoff) && cutoff >= 0;

  /**
   * Counts are fetched for EVERY row at the current cutoff, not just the selected ones — a toggle
   * is a decision, and the number beside it is what the decision is about. Selection only decides
   * what the trim button removes.
   */
  const checkSizes = useCallback(async () => {
    if (!options) return;
    setBusy(true);
    setResult("");
    try {
      const r = await api<{ perCategory: Record<string, number>; datasets: Record<string, number> }>("/trim/preview", {
        method: "POST",
        body: { categories: options.categories.map((c) => c.id), datasets: options.datasets.map((d) => d.id), olderThanDays: cutoff },
        timeoutMs: 0, // counting a year of events on a busy install can legitimately take a while
      });
      setCounts({ ...r.perCategory, ...r.datasets });
      setCountsFor(days);
    } catch (e) {
      setResult("Error: " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [options, days, cutoff]);

  const selectedTotal = useMemo(() => {
    if (!counts || countsFor !== days) return null;
    let n = 0;
    for (const id of selected) n += counts[id] ?? 0;
    return n;
  }, [counts, countsFor, days, selected]);

  async function run() {
    if (!options || selected.size === 0) return;
    const categories = options.categories.filter((c) => selected.has(c.id)).map((c) => c.id);
    const datasets = options.datasets.filter((d) => selected.has(d.id)).map((d) => d.id);
    const what = selectedTotal !== null ? `${selectedTotal.toLocaleString()} row(s)` : "the selected data";
    if (!(await confirm({
      title: `Permanently remove ${what} older than ${days} day(s)?`,
      body: backup ? "A backup is written first; the trim only runs if the backup succeeds. This cannot be undone from the panel." : "No backup was chosen. This cannot be undone.",
      confirmLabel: "Remove", danger: true,
    }))) return;
    setBusy(true);
    setResult("Trimming…");
    try {
      // No timeout: this deletes millions of rows and legitimately runs for minutes. The button is
      // disabled while it runs, so a stuck one is visible either way.
      const r = await api<{ total: number; events: { backupPath: string | null } | null; datasets: Record<string, { backupPath: string | null }> }>(
        "/trim", { method: "POST", body: { categories, datasets, olderThanDays: cutoff, backup }, timeoutMs: 0 });
      const files = [r.events?.backupPath, ...Object.values(r.datasets).map((d) => d.backupPath)].filter(Boolean);
      setResult(`Removed ${r.total.toLocaleString()} row(s).${files.length ? ` Backups: ${files.join(", ")}` : ""}`);
      setCounts(null); // the numbers on screen no longer describe the database
    } catch (e) {
      // Sent for approval is news, not a failure.
      setResult((wasFiled(e) ? "" : "Error: ") + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const row = (o: TrimOption) => (
    <div className={`setting-switch trim-row${selected.has(o.id) ? " on" : ""}`} key={o.id}>
      <div className="setting-switch-head">
        <Toggle checked={selected.has(o.id)} onChange={() => toggle(o.id)} label={o.label} />
        {counts && countsFor === days && (
          <span className={`badge ${counts[o.id] ? "" : "observe"}`} title={`rows older than ${days} day(s)`}>
            {(counts[o.id] ?? 0).toLocaleString()}
          </span>
        )}
      </div>
      <p className="hint">{o.hint}</p>
    </div>
  );

  return (
    <PanelGroup viewId="trim">
      <Panel id="trim" caps="open" title="Data trim">
        <AskNotice capability="admin.trim" />
        <Explanation>
          Delete old stored data by type. Career stats and the leaderboard are accumulated separately and are
          never touched. Check sizes first — every row shows exactly what the cutoff would remove.
        </Explanation>
        {optionsError && <p className="muted">Could not load the catalog: {optionsError}</p>}
        {options && (
          <>
            <div className="trim-cutoff">
              <label>Older than (days)
                <input inputMode="numeric" value={days} onChange={(e) => { setDays(e.target.value); }} />
              </label>
              {DAY_PRESETS.map((d) => (
                <button key={d} className={`mini ${days === String(d) ? "primary" : "ghost"}`} onClick={() => setDays(String(d))}>{d}d</button>
              ))}
              <button className="ghost" onClick={checkSizes} disabled={busy || !cutoffOk}>Check sizes</button>
              {!cutoffOk && <span className="hint">Type a number of days — a blank box is not "everything", it is nothing said.</span>}
            </div>

            <h3>Game events</h3>
            {options.categories.map(row)}

            <h3>Records</h3>
            {options.datasets.map(row)}

            <div className={`setting-switch${backup ? " on" : ""}`}>
              <div className="setting-switch-head">
                <Toggle checked={backup} onChange={setBackup} label="Write a backup first" />
              </div>
              <p className="hint">One gzipped archive per data type, on the server&apos;s disk. The trim only runs if the backup succeeds.</p>
            </div>

            <div className="actions">
              <button className="danger" onClick={run} disabled={busy || selected.size === 0 || !cutoffOk}>
                Trim{selectedTotal !== null ? ` ${selectedTotal.toLocaleString()} row(s)` : ""}
              </button>
            </div>
            {result && <p className="muted">{result}</p>}
            <p className="muted fs-sm">{KEPT_FOREVER}</p>
          </>
        )}
      </Panel>
      <LastSeenDriftPanel />
    </PanelGroup>
  );
}

interface DriftRow {
  id: string; name: string; platformId: string;
  lastSeen: string; best: string; firstSeen: string;
  lastSessionEnd: string | null; lastEvent: string | null;
}

/**
 * "Last seen" that nothing can vouch for. The store only ever pushes last_seen forward, so a clock
 * a bad import once bumped stays wrong forever on its own — this finds those players, shows what
 * the evidence actually says for each, and lowers them back to it.
 */
function LastSeenDriftPanel() {
  const confirm = useConfirm();
  const [drift, setDrift] = useState<{ total: number; sample: DriftRow[] } | null>(null);
  const [msg, setMsg] = useState("");

  async function check() {
    setMsg("Checking…");
    setDrift(null);
    try {
      const d = await api<{ total?: number; sample?: DriftRow[] }>("/players/last-seen-drift?limit=15");
      setDrift({ total: d.total ?? 0, sample: d.sample ?? [] });
      setMsg("");
    } catch (e) { setMsg("Error: " + (e as Error).message); }
  }

  async function repair() {
    if (!(await confirm({ title: "Lower these players' last seen to what the evidence supports?", confirmLabel: "Repair" }))) return;
    setMsg("Repairing…");
    try {
      const r = await api<{ repaired: number }>("/players/last-seen-drift/repair", { method: "POST", timeoutMs: 0 });
      setMsg(r.repaired ? `Repaired ${r.repaired} player(s).` : "Nothing needed repairing.");
      await check();
    } catch (e) { setMsg((wasFiled(e) ? "" : "Error: ") + (e as Error).message); }
  }

  const why = (r: DriftRow) =>
    r.lastEvent && r.lastEvent === r.best ? "their last event"
      : r.lastSessionEnd && r.lastSessionEnd === r.best ? "their last session"
        : "first seen — no session or event on record";

  return (
    <Panel id="last-seen" caps="open" title="Last-seen clocks">
      <Explanation>
        A player&apos;s last seen should never outrun every sighting of them. Earlier CRCON imports stamped
        players as seen at the moment of the import, and because the clock only ever moves forward it stays
        wrong until it&apos;s lowered back to the evidence. This is safe to run any time: it never moves a
        clock forward, and a player who really is online is re-stamped by the next roster snapshot.
      </Explanation>
      <div className="actions">
        <button className="ghost" onClick={check}>Check</button>
        <button onClick={repair} disabled={!drift?.total}>Repair {drift?.total ? `${drift.total} player(s)` : ""}</button>
      </div>
      {msg && <p className="muted">{msg}</p>}
      {drift && (drift.total === 0
        ? <p className="muted">Every last seen is backed by a session, an event, or a first sighting. Nothing to repair.</p>
        : (
          <>
            <p className="muted">{drift.total} player(s) drifted{drift.total > drift.sample.length ? `, worst ${drift.sample.length} shown` : ""}:</p>
            <div className="scroll-x">
              <table>
                <thead><tr><th>Player</th><th>Shows as</th><th>Evidence says</th><th>Which is</th></tr></thead>
                <tbody>
                  {drift.sample.map((r) => (
                    <tr key={r.id}>
                      <td>{r.name || r.platformId}</td>
                      <td><Time iso={r.lastSeen} /></td>
                      <td><Time iso={r.best} /></td>
                      <td className="muted">{why(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ))}
    </Panel>
  );
}
