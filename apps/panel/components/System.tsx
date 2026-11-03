"use client";
/** System view: host metrics + background-service health (CRCON-style Services panel) + the
 *  instance's loaded plugins. Everything here is instance-level, never per-user. */
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { hasCap } from "../lib/access";
import { useGrants } from "../lib/grants";
import { useResource } from "../lib/resource";
import { fmtDay, fmtRelative } from "../lib/time";
import { ActionResult, Callout, EmptyState, SkeletonLines, SkeletonRows, Explanation } from "./ui";
import { PanelGroup, Panel } from "./Panel";

interface UpdatesResp {
  shown: boolean;
  state?: "current" | "available" | "unknown";
  commit?: string | null;
  branch?: string | null;
  behindBy?: number;
  changes?: { sha: string; title: string; date: string | null }[];
  reason?: string;
  checkedAt?: string | null;
}

/** Newer versions, for the account made at setup alone: the API tells anyone else there is nothing
 *  for them, and then nothing is shown. */
function UpdatesPanel() {
  const load = useCallback(() => api<UpdatesResp>("/updates"), []);
  const { data } = useResource(load);
  if (!data?.shown) return null;
  return (
    <Panel id="updates" caps="open" title="Updates" subtitle={data.checkedAt ? `checked ${fmtRelative(data.checkedAt)}` : undefined}>
      {data.state === "available" && (
        <>
          <p className="mt-0"><strong>{data.behindBy} update{data.behindBy === 1 ? "" : "s"}</strong> since this version ({data.commit} on {data.branch}):</p>
          <ul className="update-changes">
            {(data.changes ?? []).map((c) => <li key={c.sha}>{c.title} <span className="muted">· {fmtDay(c.date)}</span></li>)}
          </ul>
          <p className="muted">To update, run start.bat on the PC the panel runs on (on a VM: sudo ./start.sh).</p>
        </>
      )}
      {data.state === "current" && <p className="muted mt-0">Up to date: {data.commit} is the newest version on {data.branch}.</p>}
      {data.state === "unknown" && <p className="muted mt-0">{data.reason}</p>}
    </Panel>
  );
}

interface Svc { name: string; group: string; status: "running" | "degraded" | "down"; detail: Record<string, unknown>; updatedAt?: string }
/** `unlisted`: listed only to those who may open one of its pages, by its name alone. */
interface Plugin { id: string; name: string; version: string; apiVersion: number; capabilities: string[]; unlisted?: boolean }
interface ServicesResp { services: Svc[]; summary: { running: number; degraded: number; down: number } }
interface Metrics { cpuPct: number; memory: { pct: number }; disk: { pct: number } | null; uptimeSec: number; hostname: string; node: string; appVersion: string | null; appCommit: string | null }

const STATUS_ORDER: Svc["status"][] = ["down", "degraded", "running"];
const STATUS_LABEL: Record<Svc["status"], string> = { running: "Running", degraded: "Degraded", down: "Down" };

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
function detailText(s: Svc): string {
  const parts: string[] = [];
  const d = s.detail || {};
  if (typeof d.lastSeenSec === "number") parts.push(`seen ${d.lastSeenSec}s ago`);
  for (const [k, v] of Object.entries(d)) {
    if (k === "lastSeenSec") continue;
    parts.push(`${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  }
  return parts.join(" · ");
}

export default function System() {
  const [data, setData] = useState<ServicesResp | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState("");

  const load = () => {
    api<ServicesResp>("/health/services").then(setData).catch((e) => setError(e.message));
    api<Metrics>("/health/metrics").then(setMetrics).catch(() => {});
  };
  // A hidden tab skips its polls — same discipline as useResource; these are two requests a tick.
  useEffect(() => {
    load();
    const h = setInterval(() => { if (!(typeof document !== "undefined" && document.hidden)) load(); }, 15_000);
    return () => clearInterval(h);
  }, []);

  const groups = STATUS_ORDER
    .map((status) => ({ status, items: (data?.services ?? []).filter((s) => s.status === status) }))
    .filter((g) => g.items.length);

  return (
    <PanelGroup viewId="system">
      <Panel
        id="host"
        caps="open"
        title="System"
        subtitle={metrics ? `${metrics.hostname} · up ${fmtUptime(metrics.uptimeSec)}${metrics.appCommit ? ` · commit ${metrics.appCommit}` : ""}` : undefined}
        actions={<button className="ghost mini" onClick={load}>Refresh</button>}
      >
      {error && <Callout variant="danger">{error}</Callout>}

      {metrics && (
        <div className="metric-row">
          <MetricTile label="CPU" pct={metrics.cpuPct} />
          <MetricTile label="Memory" pct={metrics.memory.pct} />
          {metrics.disk && <MetricTile label="Disk" pct={metrics.disk.pct} />}
        </div>
      )}

      {/* The summary is a rollup the endpoint computes; an older API answers without it, and the
          count line is not worth taking the System page down for. */}
      {data?.summary && (
        <p className="muted" style={{ marginTop: 14 }}>
          {data.summary.running} running{data.summary.degraded ? ` · ${data.summary.degraded} degraded` : ""}{data.summary.down ? ` · ${data.summary.down} down` : ""}
        </p>
      )}
      {!data && !error && <SkeletonLines lines={3} />}

      </Panel>

      <UpdatesPanel />

      <Panel id="services" caps="open" title="Services" subtitle={data?.summary ? `${data.summary.running} running` : undefined}>
      {groups.map((g) => (
        <div key={g.status} className="svc-group">
          <div className={`svc-group-head ${g.status}`}><span className="dot" /> {STATUS_LABEL[g.status]} ({g.items.length})</div>
          {g.items.map((s) => (
            <div key={s.name} className="svc-row">
              <span className={`dot ${s.status}`} />
              <span className="svc-name">{s.name}</span>
              <span className="svc-group-tag">{s.group}</span>
              <span className="svc-detail">{detailText(s)}</span>
            </div>
          ))}
        </div>
      ))}
      {!groups.length && !error && (
        <EmptyState icon="🩺" title="No services reporting">
          The API lists each background service it started. An empty list normally means the worker
          process isn&apos;t running — check it came up alongside the API.
        </EmptyState>
      )}
      </Panel>

      <AutomatedActivity />
      <Plugins />
    </PanelGroup>
  );
}

interface AutoActor { actorName: string; count: number; lastAt: string; byAction: Record<string, number> }

/**
 * What the app's own automation has been doing — VIP expiry, seeding rewards, auto settings, the
 * map vote. These used to sit inside the STAFF statistics, where "system 204 · 78%" buried every
 * human on the page; the population is machinery, so it reports here with the other instance-level
 * health, and the staff pages count people only.
 */
function AutomatedActivity() {
  // The rollup is the staff statistics' read, and answers to Staff profiles: asked without it, it
  // could only be refused. Every failure used to hide the panel, so a read that broke for any
  // other reason looked like the permission — it says so now.
  const allowed = hasCap(useGrants(), "staff.profiles");
  const [actors, setActors] = useState<AutoActor[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!allowed) return;
    api<{ staff: AutoActor[] }>("/audit/staff?actors=auto").then((r) => setActors(r.staff)).catch((e) => setError((e as Error).message));
  }, [allowed]);
  if (!allowed) return null;

  const total = (actors ?? []).reduce((n, a) => n + a.count, 0);
  return (
    <Panel id="auto-activity" caps="staff.profiles" title="Automated activity" subtitle={actors ? `${total} action${total === 1 ? "" : "s"}` : undefined}>
      <Explanation>
        Actions the app performed on its own — VIP expiry, seeding rewards, auto settings, the map
        vote. Staff pages count people; the machinery is accounted for here. Every individual entry
        is still in the staff activity trail.
      </Explanation>
      <ActionResult error={error ? `Couldn't read the automated activity: ${error}` : ""} />
      {!actors && !error && <SkeletonRows rows={3} cols={3} />}
      {actors && !actors.length && (
        <EmptyState icon="🤖" title="No automated actions yet">
          Nothing has fired on its own — no VIPs expired, no automation acted. Entries appear here
          as the background services do their work.
        </EmptyState>
      )}
      {actors && actors.length > 0 && (
        <div className="scroll-x">
          <table>
            <thead><tr><th>Service</th><th>Actions</th><th>What it did</th></tr></thead>
            <tbody>
              {actors.map((a) => (
                <tr key={a.actorName}>
                  <td><strong>{a.actorName}</strong></td>
                  <td>{a.count}</td>
                  <td>
                    {Object.entries(a.byAction).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([action, n]) => (
                      <span key={action} className="badge observe" style={{ marginRight: 6 }}>{action} ×{n}</span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** Loaded plugins — instance-level, so it lives here rather than in personal Settings. */
function Plugins() {
  const [plugins, setPlugins] = useState<Plugin[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api<{ plugins: Plugin[] }>("/plugins").then((r) => setPlugins(r.plugins)).catch((e) => setError(e.message)); }, []);

  return (
    <Panel id="plugins" caps="open" title="Loaded plugins" subtitle={plugins ? String(plugins.length) : undefined}>
      <p className="muted mt-0">Extensions the server loaded at startup, with the capabilities they were granted.</p>
      <ActionResult error={error} />
      {!plugins && !error && <SkeletonRows rows={4} cols={3} />}
      {plugins && !plugins.length && (
        <EmptyState icon="🧩" title="No plugins loaded">
          Plugins are optional extensions the API loads at startup, each granted only the
          capabilities it declares. None are installed — this is the normal state.
        </EmptyState>
      )}
      {plugins && plugins.length > 0 && (
        <div className="scroll-x">
          <table>
            <thead><tr><th>Plugin</th><th>Version</th><th>Capabilities</th></tr></thead>
            <tbody>
              {plugins.map((pl) => (
                <tr key={pl.id}>
                  <td><strong>{pl.name}</strong> <span className="muted">{pl.unlisted ? "listed only for those who may open it" : pl.id}</span></td>
                  <td>{pl.version} <span className="muted">(api v{pl.apiVersion})</span></td>
                  <td>{pl.capabilities.length ? pl.capabilities.map((c) => <span key={c} className="badge observe" style={{ marginRight: 6 }}>{c}</span>) : <span className="muted">none</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function MetricTile({ label, pct }: { label: string; pct: number }) {
  const cls = pct >= 90 ? "crit" : pct >= 75 ? "warn" : "ok";
  return (
    <div className="metric-tile">
      <div className="metric-label">{label}</div>
      <div className={`metric-val ${cls}`}>{pct}%</div>
      <div className="metric-bar"><span className={cls} style={{ width: `${Math.min(pct, 100)}%` }} /></div>
    </div>
  );
}
