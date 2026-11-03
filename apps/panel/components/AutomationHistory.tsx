"use client";
/**
 * Auto settings → History — every action the app's own machinery took, in one paged, filterable
 * list: Rules firings and breaker trips, seeding enforcement, server-settings profile applies and
 * drift rewrites, map-vote and broadcast automation. Machinery only: a staff member's own rule
 * EDITS are their action, not the automation's, and live in Activity like every other staff act.
 * The per-rule "fired 12×" badge answers "is it alive?"; this answers "what exactly has the
 * automation been doing, to whom, and when" — without digging through the full Activity trail.
 *
 * Reads its own automation-scoped endpoint (action-prefix allowlisted server-side), so holding an
 * automation config capability is enough — the general audit capability is not required and no
 * staff member's own actions can appear here.
 */
import { useCallback, useMemo } from "react";
import { api } from "../lib/api";
import { useServers } from "../lib/servers";
import { isFlag, isText, isTextList, oneOf, useRemembered } from "../lib/remembered";
import { usePagedList } from "../lib/paged";
import { PanelGroup, Panel } from "./Panel";
import { ActionResult, Pager, SearchInput, SkeletonRows, Toggle, Explanation } from "./ui";
import { Time } from "./Time";
import { useResource } from "../lib/resource";
import { useGrants } from "../lib/grants";
import { hasCap } from "../lib/access";

interface HistRow {
  id: string; ts: string; actorName: string; action: string;
  targetName: string | null; targetId: string | null; serverId: string | null; summary: string;
  data: Record<string, unknown> | null;
}
interface RuleOpt { id: string; name: string }

const SOURCES: [string, string][] = [
  ["rules", "Rules"], ["seeding", "Seeding"], ["autosettings", "Server settings"],
  ["mapvote", "Map vote"], ["broadcast", "Broadcast"],
];
const SOURCE_LABEL: Record<string, string> = Object.fromEntries(SOURCES);

/** The row's Action column, minus the family prefix. "blacklist" is the enforcer's stored name
 *  from the era when it filed a record — today it places a real ban, and the table says so
 *  instead of leaking the legacy key. */
function verbOf(action: string): string {
  const verb = action.replace(/^[a-z]+\./, "");
  return verb === "blacklist" ? "ban" : verb;
}

/** Which family an audit action belongs to, for the row's Source chip. */
function sourceOf(action: string): string {
  if (action.startsWith("enforcer.") || action.startsWith("rule.")) return "rules";
  if (action.startsWith("seed.")) return "seeding";
  if (action.startsWith("autosettings.")) return "autosettings";
  if (action.startsWith("mapvote.") || action.startsWith("map.")) return "mapvote";
  if (action.startsWith("broadcast.")) return "broadcast";
  return action.split(".")[0] ?? action;
}

export default function AutomationHistory() {
  const { serverId, servers } = useServers();
  // The history as it was left, for the sitting.
  const [sources, setSources] = useRemembered<string[]>("automation.history.sources", [], isTextList, "session"); // empty = every family
  const [keptRule, setRuleId] = useRemembered("automation.history.rule", "", isText, "session");
  const [q, setQ] = useRemembered("automation.history.search", "", isText, "session");
  const [order, setOrder] = useRemembered<"desc" | "asc">("automation.history.order", "desc", oneOf(["desc", "asc"] as const), "session");
  const [thisServerOnly, setThisServerOnly] = useRemembered("automation.history.thisServer", true, isFlag, "session");

  const toggleSource = (s: string) => {
    setSources((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
    setRuleId(""); // a rule filter only means anything while Rules is in view
  };
  const rulesShown = !sources.length || sources.includes("rules");

  // The rule dropdown — soft-fail: the history still reads without the rules list. Asked only of
  // those who may read the rules: staff here for seeding or auto settings alone were refused it
  // on every visit.
  const readsRules = hasCap(useGrants(), "admin.moderation");
  const rulesLoader = useMemo(() => (readsRules ? () => api<{ rules: RuleOpt[] }>("/enforcer/rules").catch(() => ({ rules: [] as RuleOpt[] })) : null), [readsRules]);
  const { data: rulesResp } = useResource(rulesLoader);
  // The rule kept for the sitting narrows the history only while it is still a rule. Deleted, it
  // went on narrowing it to that rule's old firings from a dropdown that no longer offers it, and
  // so read as "— every rule —".
  const ruleId = keptRule && rulesResp && !rulesResp.rules.some((r) => r.id === keptRule) ? "" : keptRule;
  const ruleName = new Map((rulesResp?.rules ?? []).map((r) => [r.id, r.name]));

  const fetchPage = useCallback((offset: number, limit: number) => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset), order });
    if (sources.length) params.set("sources", sources.join(","));
    if (ruleId) params.set("ruleId", ruleId);
    if (q.trim()) params.set("q", q.trim());
    if (thisServerOnly && serverId) params.set("serverId", serverId);
    // An empty-bodied answer (a stubbed or half-configured API) must render the empty state,
    // not white-screen on `.length` of undefined.
    return api<{ entries?: HistRow[]; total?: number }>(`/automation/history?${params}`)
      .then((r) => ({ items: r.entries ?? [], total: r.total ?? 0 }));
  }, [sources, ruleId, q, order, thisServerOnly, serverId]);
  const list = usePagedList<HistRow>(fetchPage, "automation.history", thisServerOnly ? serverId : "");

  const serverName = new Map(servers.map((s) => [s.id, s.name]));

  return (
    <PanelGroup viewId="automation-history">
      <Panel id="history" caps="open" title="Automation history" subtitle={list.total != null ? String(list.total) : undefined}
        actions={
          <>
            <SearchInput value={q} onChange={setQ} placeholder="Search player, rule, detail…" />
            <Toggle checked={thisServerOnly} onChange={setThisServerOnly} disabled={!serverId} label="this server only" />
          </>
        }
      >
        <Explanation>Everything the automation did — firings, dry-runs, breaker trips, profile applies — newest first. Pick a family, or a single rule, to narrow it.</Explanation>
        <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div className="chips">
            {SOURCES.map(([id, label]) => {
              const on = !sources.length || sources.includes(id);
              return <button key={id} type="button" className={sources.includes(id) ? "badge active chip-btn" : "badge chip-btn"} title={on ? undefined : "hidden"} onClick={() => toggleSource(id)}>{sources.includes(id) ? "✓ " : ""}{label}</button>;
            })}
            {sources.length > 0 && <button type="button" className="badge chip-btn" onClick={() => setSources([])}>every family</button>}
          </div>
          {rulesShown && (rulesResp?.rules?.length ?? 0) > 0 && (
            <select value={ruleId} onChange={(e) => setRuleId(e.target.value)} aria-label="Rule">
              <option value="">— every rule —</option>
              {rulesResp!.rules.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          )}
        </div>
        <ActionResult error={list.error} />
        {list.items === null && !list.error && <SkeletonRows rows={8} cols={5} />}
        {list.items !== null && list.items.length === 0 && <p className="nothing">Nothing recorded for this filter yet.</p>}
        {list.items !== null && list.items.length > 0 && (
          <div className="scroll-x">
            <table>
              <thead><tr>
                <th><button className="linklike" title="Flip the time order" onClick={() => setOrder(order === "desc" ? "asc" : "desc")}>When {order === "desc" ? "↓" : "↑"}</button></th>
                <th>Source</th>
                <th>What</th>
                <th>Player / target</th>
                <th>Detail</th>
              </tr></thead>
              <tbody>
                {list.items.map((r) => {
                  const rid = (r.data as { ruleId?: string } | null)?.ruleId;
                  return (
                    <tr key={r.id}>
                      <td className="nowrap"><Time iso={r.ts} /></td>
                      <td><span className="badge">{SOURCE_LABEL[sourceOf(r.action)] ?? sourceOf(r.action)}</span></td>
                      <td className="nowrap">{verbOf(r.action)}{rid && ruleName.get(rid) ? <span className="muted"> · {ruleName.get(rid)}</span> : null}</td>
                      <td>{r.targetName ?? r.targetId ?? <span className="muted">—</span>}</td>
                      <td>{r.summary}{!thisServerOnly && r.serverId ? <span className="muted"> · {serverName.get(r.serverId) ?? r.serverId}</span> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pager list={list} noun="entry" />
      </Panel>
    </PanelGroup>
  );
}
