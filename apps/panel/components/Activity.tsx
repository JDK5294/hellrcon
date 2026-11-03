"use client";
import { useCallback, useEffect, useState } from "react";
import { humanizeIsoInText } from "../lib/time";
import { api } from "../lib/api";
import { PanelGroup, Panel } from "./Panel";
import { StaffLink } from "./StaffLink";
import { PlayerLink } from "./PlayerLink";
import { GameId } from "./GameId";
import { ActionResult, EmptyState, Pager, ScopePicker, SearchInput, SkeletonRows } from "./ui";
import { useServers } from "../lib/servers";
import { isText, useRemembered, useRememberedSet } from "../lib/remembered";
import { useScope } from "../lib/scope";
import { Time } from "./Time";
import { useSortable, SortTh } from "../lib/sort";
import { DOWNLOAD_MAX, fileStem, readAll, type Sheet } from "../lib/download";
import { DownloadButton, type DownloadRange } from "./Download";
import { usePagedList } from "../lib/paged";
import { useGrants } from "../lib/grants";
import { hasCap } from "../lib/access";
import { AuditActionButton, AuditDetail, auditRowProps } from "./AuditDetail";

export interface AuditEntry {
  id: string;
  ts: string;
  actorUserId: string | null;
  actorName: string;        // historical: the name at the time of the action
  actorDisplayName?: string; // current name, resolved live (renames propagate)
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetName: string | null;        // historical: what the target was called at the time
  targetDisplayName?: string | null; // current in-game name, resolved live
  targetPlatformId?: string | null;  // the game id, for copying
  serverId: string | null;
  summary: string;
}
/** One page of the trail. The whole history is reachable a page at a time. */

interface StaffRow {
  actorUserId: string | null;
  actorName: string;
  actorDisplayName?: string;
  count: number;
  lastAt: string;
  byAction: Record<string, number>;
  roleIds?: string[];
}

interface RoleOpt { id: string; name: string }

/** The trail as a file, newest first. A server is named; an entry with none is community-wide. */
function trailSheet(rows: AuditEntry[], serverName: (id: string) => string | undefined, capped: boolean): Sheet {
  return {
    name: "Staff activity",
    columns: [
      { key: "time", label: "Time", time: true },
      { key: "staff", label: "Staff" },
      { key: "action", label: "Action" },
      { key: "target", label: "Target" },
      { key: "targetGameId", label: "Target game ID" },
      { key: "server", label: "Server" },
      { key: "detail", label: "Detail" },
    ],
    rows: rows.map((e) => [
      e.ts, e.actorDisplayName || e.actorName, e.action, e.targetDisplayName || e.targetName || e.targetId, e.targetPlatformId,
      e.serverId ? serverName(e.serverId) ?? e.serverId : null, humanizeIsoInText(e.summary),
    ]),
    ...(capped ? { notice: `Saved the newest ${DOWNLOAD_MAX.toLocaleString()} entries. Pick a shorter time range for the ones before them.` } : {}),
  };
}

/**
 * The "who was this done to" cell: their current in-game name, with the game id beneath it.
 *
 * `targetDisplayName` is resolved server-side against the players table, so a rename shows up on
 * every past entry; `targetName` is what it was called at the time and is only the fallback for a
 * target we no longer have a row for.
 */
export function AuditTarget({ entry: e }: { entry: AuditEntry }) {
  if (e.targetType !== "player") return <>{e.targetDisplayName || e.targetName || e.targetId || ""}</>;
  const name = e.targetDisplayName || e.targetName;
  const gameId = e.targetPlatformId || e.targetId;
  return (
    <div className="audit-target">
      {name
        ? <PlayerLink playerId={e.targetId} name={name} />
        : <span className="muted">unknown player</span>}
      {gameId && <GameId id={gameId} truncate={18} className="fs-xs muted" />}
    </div>
  );
}

export default function Activity() {
  const { servers } = useServers();
  // The trail as it was left, for the sitting: a staff member or player opened from it comes back
  // to the same search, server, roles and page.
  const [q, setQ] = useRemembered("activity.search", "", isText, "session");
  // Every entry in the trail carries the server it happened on, and nothing read it: "who did what
  // on THIS server" was unanswerable, and the merged answer sat under a sidebar naming one server.
  const [scopeId, setScope] = useScope("activity.scope");
  const sort = useSortable<AuditEntry>({
    ts: (e) => e.ts,
    staff: (e) => e.actorDisplayName || e.actorName,
    action: (e) => e.action,
    target: (e) => e.targetName ?? e.targetId ?? "",
  }, "ts", "desc", "activity");
  // The team is the staff profiles permission (the trail is audit.trail). A moderator holds the
  // trail alone, and was shown "No staff actions recorded yet" above a trail full of them: the
  // refused list read as an empty one. Without it the team is neither asked for nor shown, and the
  // server picker moves down to the trail it narrows.
  const seesTeam = hasCap(useGrants(), "staff.profiles");
  // Null until read: the team is not known to be empty before then, and said "No staff actions
  // recorded yet" while it was on its way.
  const [staff, setStaff] = useState<StaffRow[] | null>(null);
  const [teamErr, setTeamErr] = useState("");
  const [roles, setRoles] = useState<RoleOpt[]>([]);
  const [roleFilter, toggleRole, clearRoles] = useRememberedSet("activity.roles");
  const [rolesOpen, setRolesOpen] = useState(false);
  // The action open in its own window: what it changed, setting by setting.
  const [openId, setOpenId] = useState<string | null>(null);

  // Debounced so typing doesn't fire a request per keystroke; a new search resets to page one.
  const [search, setSearch] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setSearch(q), 200);
    return () => clearTimeout(t);
  }, [q]);

  const fetchPage = useCallback(
    // Staff keep acting while the trail is being read; the anchor keeps every page on one snapshot.
    (offset: number, limit: number, cursor?: string) => api<{ entries: AuditEntry[]; total?: number; anchor?: string }>(
      `/audit?q=${encodeURIComponent(search)}&limit=${limit}&offset=${offset}${scopeId ? `&serverId=${encodeURIComponent(scopeId)}` : ""}${cursor ? `&anchor=${encodeURIComponent(cursor)}` : ""}`,
    ).then((r) => ({ items: r.entries, total: r.total ?? null, cursor: r.anchor })),
    [search, scopeId],
  );
  const log = usePagedList<AuditEntry>(fetchPage, "activity", scopeId);
  const entries = log.items;
  // The whole trail the search and server match over the picked time, for a download.
  const trailFile = async (range: DownloadRange): Promise<Sheet> => {
    const { items, capped } = await readAll<AuditEntry>((offset, limit, anchor) => {
      const qs = new URLSearchParams({ q: search, limit: String(limit), offset: String(offset) });
      if (scopeId) qs.set("serverId", scopeId);
      if (range.from) qs.set("from", range.from);
      if (range.to) qs.set("to", range.to);
      if (anchor) qs.set("anchor", anchor);
      return api<{ entries: AuditEntry[]; total?: number; anchor?: string }>(`/audit?${qs}`).then((r) => ({ items: r.entries, total: r.total, anchor: r.anchor }));
    });
    return trailSheet(items, (id) => servers.find((sv) => sv.id === id)?.name, capped);
  };

  useEffect(() => {
    if (!seesTeam) return;
    let live = true;
    api<{ staff: StaffRow[]; roles?: RoleOpt[] }>(`/audit/staff${scopeId ? `?serverId=${encodeURIComponent(scopeId)}` : ""}`)
      .then((r) => { if (live) { setTeamErr(""); setStaff(r.staff ?? []); setRoles(r.roles ?? []); } })
      .catch((e) => { if (live) { setStaff([]); setTeamErr((e as Error).message); } });
    return () => { live = false; };
  }, [scopeId, seesTeam]);

  // Narrow the team to holders of any selected role; empty selection = everyone.
  const team = staff ?? [];
  const shownStaff = roleFilter.size ? team.filter((s) => (s.roleIds ?? []).some((id) => roleFilter.has(id))) : team;

  const topActions = (m: Record<string, number>) =>
    Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([a, n]) => `${a} ×${n}`)
      .join(" · ");

  if (log.error) return <div className="card"><ActionResult error={log.error} /></div>;

  const picker = <ScopePicker servers={servers} value={scopeId} onChange={setScope} noun="Staff actions" />;
  const about = <p className="muted mt-0">Every staff action, who did it and when. Searchable across action, staff, target, and summary.</p>;

  return (
    <PanelGroup viewId="activity">
      <Panel id="team" caps="staff.profiles" title="The team" subtitle={team.length ? `${roleFilter.size ? `${shownStaff.length} of ` : ""}${team.length}` : undefined}>
        {picker}
        {roles.length > 0 && (
          <div className="control-row" style={{ marginBottom: 8 }}>
            <button className={`ghost mini${roleFilter.size ? " pressed" : ""}`} onClick={() => setRolesOpen((o) => !o)} aria-expanded={rolesOpen}>
              Roles{roleFilter.size ? ` (${roleFilter.size})` : ""} {rolesOpen ? "▴" : "▾"}
            </button>
            {rolesOpen && (
              <div className="seg" role="group" aria-label="Filter by role">
                {roles.map((r) => (
                  <button key={r.id} className={`seg-btn ${roleFilter.has(r.id) ? "active" : ""}`}
                    aria-pressed={roleFilter.has(r.id)} onClick={() => toggleRole(r.id)}>
                    {/* A role with no name still has to be pickable — an unlabelled chip is
                        indistinguishable from a rendering bug. */}
                    {r.name.trim() || "Unnamed role"}
                  </button>
                ))}
              </div>
            )}
            {rolesOpen && roleFilter.size > 0 && <button className="ghost mini" onClick={clearRoles}>Clear</button>}
          </div>
        )}
        {about}
        {teamErr && <ActionResult error={`Couldn't load the team: ${teamErr}`} />}
        {staff === null && !teamErr && <SkeletonRows rows={2} cols={3} />}
        {staff !== null && !staff.length && !teamErr && (
          <EmptyState icon="👥" title="No staff actions recorded yet">
            Every kick, ban, VIP grant and setting change made through the panel is logged here against the
            admin who did it. It fills as your team uses the panel.
          </EmptyState>
        )}
        {roleFilter.size > 0 && !shownStaff.length && team.length > 0 && (
          <p className="muted">Nobody holding the selected role(s) acted in this window.</p>
        )}
        <div className="staff-grid">
          {shownStaff.map((s) => (
            <div className="subcard staff-card" key={s.actorUserId ?? s.actorName}>
              <div className="row">
                <span className="avatar">{(s.actorDisplayName || s.actorName).charAt(0).toUpperCase()}</span>
                <div className="grow">
                  <div className="name"><StaffLink userId={s.actorUserId} name={s.actorDisplayName || s.actorName} /></div>
                  <div className="muted fs-xs">last active <Time iso={s.lastAt} /></div>
                </div>
                <div className="stat-value" style={{ fontSize: "1.6rem" }}>{s.count}</div>
              </div>
              <div className="muted" style={{ fontSize: "0.78rem", marginTop: 6 }}>{topActions(s.byAction)}</div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel
        id="trail"
        caps="open"
        title="Trail"
        actions={<>
          <SearchInput value={q} onChange={setQ} placeholder="Search actions, staff, targets…" />
          <DownloadButton file={fileStem("staff-activity", servers.find((sv) => sv.id === scopeId)?.name)} title="Download staff activity"
            noun="entry" ranged scope="matching the trail's search and server, in the time range picked" sheet={trailFile} />
        </>}
      >
        {!seesTeam && <>{picker}{about}</>}
        {!entries && <SkeletonRows rows={8} cols={5} />}
        {entries && !entries.length && (
          <EmptyState icon="📋" title={q ? "No activity matches your search" : "No staff activity recorded yet"}
            filtered={Boolean(q)} onClear={() => setQ("")}>
            {q ? "Try a shorter search — it covers the action, the staff member and the target."
               : "Every action your staff take — in this panel or through the Discord bot — is recorded here, with who did it and to whom."}
          </EmptyState>
        )}
        {entries && entries.length > 0 && (
          <div className="scroll-x">
            <table>
              <thead><tr>
                <SortTh s={sort} k="ts">Time</SortTh>
                <SortTh s={sort} k="staff">Staff</SortTh>
                <SortTh s={sort} k="action">Action</SortTh>
                <SortTh s={sort} k="target">Target</SortTh>
                <th>Detail</th>
              </tr></thead>
              <tbody>
                {sort.sorted(entries).map((e) => (
                  <tr key={e.id} {...auditRowProps(() => setOpenId(e.id))}>
                    <td><Time iso={e.ts} /></td>
                    <td title={e.actorDisplayName && e.actorDisplayName !== e.actorName ? `acted as "${e.actorName}"` : undefined}>
                      <StaffLink userId={e.actorUserId} name={e.actorDisplayName || e.actorName} />
                    </td>
                    <td><AuditActionButton action={e.action} onOpen={() => setOpenId(e.id)} /></td>
                    {/* Name on top, game id underneath and copyable. The column used to print the
                        raw id as the whole answer to "who", which is the one form of a player that
                        tells a reader nothing. */}
                    <td><AuditTarget entry={e} /></td>
                    <td style={{ whiteSpace: "normal" }}>{humanizeIsoInText(e.summary)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager list={log} noun="entry" />
        {openId && <AuditDetail id={openId} onClose={() => setOpenId(null)} />}
      </Panel>
    </PanelGroup>
  );
}
