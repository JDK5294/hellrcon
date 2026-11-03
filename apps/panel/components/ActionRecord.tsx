"use client";
/**
 * The record of ONE kind of admin action — every kick, every punishment, every team switch — read
 * from the audit trail and shown on its own tab under Moderation.
 *
 * Moderation used to be the ban record and nothing else, which meant every other decision a staff
 * member made was only findable by scrolling the whole staff-activity trail and reading past
 * everything else. Sorting the trail by the action it records turns "did anyone kick this guy last
 * night" from an archaeology exercise into a tab.
 *
 * It reads `/api/audit`, which is scoped per server and filtered by action server-side — so a
 * moderator with `audit.trail` on one server sees that server's record and only that one. Several
 * audit actions can make up one record (a ban is a temp ban OR a permanent one), which is what the
 * `actions` filter is for.
 *
 * Paging is `usePagedList`, like every other list in the panel, rather than hand-rolled here. That
 * hook already carries the things this screen was quietly getting wrong on its own: it replays the
 * snapshot cursor page one established (staff keep acting while the record is being read, so
 * without it "Older" repeats a row page one already showed), it drops answers from a query you have
 * since moved on from, and it resets to page one and clears the rows when the question changes.
 */
import { useCallback, useEffect, useState } from "react";
import { humanizeIsoInText } from "../lib/time";
import { api, fmt } from "../lib/api";
import { usePagedList } from "../lib/paged";
import { isText, useRemembered } from "../lib/remembered";
import { useServers } from "../lib/servers";
import { AuditTarget, type AuditEntry } from "./Activity";
import { EmptyState, Pager, SearchInput, SkeletonRows } from "./ui";
import { Panel, PanelGroup } from "./Panel";
import { StaffLink } from "./StaffLink";

export function ActionRecord({ id, title, subtitle, actions, emptyText }: {
  /** Panel id — also the layout key, so it must be stable across renames. */
  id: string;
  title: string;
  subtitle: string;
  /** The audit action names this record is made of, e.g. ["player.tempban", "player.permaban"]. */
  actions: string[];
  emptyText: string;
}) {
  const { serverId } = useServers();
  // Debounced so typing does not fire a request per keystroke — same as the staff trail next door.
  // Kept per record for the sitting, with its page: a player opened from a row comes back to it.
  const [q, setQ] = useRemembered(`${id}.search`, "", isText, "session");
  const [search, setSearch] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setSearch(q), 200);
    return () => clearTimeout(t);
  }, [q]);

  // Keyed on the query, so changing the search IS a new query to the hook — which is what makes it
  // throw away the old snapshot and go back to page one. The server is what the record is read on:
  // another one is another list, which opens on its own page.
  const key = actions.join(",");
  const fetchPage = useCallback(
    (offset: number, limit: number, cursor?: string) => {
      const params = new URLSearchParams({ actions: key, limit: String(limit), offset: String(offset) });
      if (search) params.set("q", search);
      if (serverId) params.set("serverId", serverId);
      if (cursor) params.set("anchor", cursor);
      return api<{ entries: AuditEntry[]; total?: number; anchor?: string }>(`/audit?${params}`)
        .then((r) => ({ items: r.entries, total: r.total ?? null, cursor: r.anchor }));
    },
    [key, search, serverId],
  );
  const list = usePagedList<AuditEntry>(fetchPage, id, serverId);

  return (
    <PanelGroup viewId={id}>
      <Panel id={id} caps="audit.trail" title={title} subtitle={subtitle}
        actions={<SearchInput value={q} onChange={setQ} placeholder="Search player, reason, staff…" />}>
        {list.error && <p className="muted" role="alert">{list.error}</p>}
        {list.items === null ? <SkeletonRows rows={6} cols={4} /> : list.items.length === 0
          ? <EmptyState title="Nothing recorded yet">{emptyText}</EmptyState>
          : (
            <>
              <div className="scroll-x">
                <table className="data">
                  <thead><tr><th>When</th><th>Staff</th><th>Player</th><th>What</th></tr></thead>
                  <tbody>
                    {list.items.map((e) => (
                      <tr key={e.id}>
                        <td className="muted nowrap">{fmt(e.ts)}</td>
                        <td><StaffLink userId={e.actorUserId} name={e.actorDisplayName || e.actorName} /></td>
                        <td><AuditTarget entry={e} /></td>
                        <td style={{ whiteSpace: "normal" }}>{humanizeIsoInText(e.summary)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager list={list} noun="entry" />
            </>
          )}
      </Panel>
    </PanelGroup>
  );
}
