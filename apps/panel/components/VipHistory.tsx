"use client";
/**
 * Every VIP grant, reduction and revoke for one player.
 *
 * The VIP list says who holds a slot right now. It cannot say whether this player has held one
 * for two years, or was given it last Tuesday, or lost it in March and got it back — which is
 * exactly what you want to know when someone asks why their VIP is gone. The audit log has been
 * recording all of it; this reads it back as a timeline.
 */
import { useCallback, useMemo } from "react";
import { api } from "../lib/api";
import { hasCap } from "../lib/access";
import { useGrants } from "../lib/grants";
import { useResource } from "../lib/resource";
import { Panel } from "./Panel";
import { ActionResult, EmptyState, Pager, SkeletonRows } from "./ui";
import { StaffLink } from "./StaffLink";
import { Time } from "./Time";
import { fmtExact } from "../lib/time";
import { useSortable, SortTh } from "../lib/sort";
import { useClientPages } from "../lib/paged";

export interface VipHistoryRow {
  id: string;
  ts: string;
  /** "reduced" = time taken back; its expiration is the NEW expiry (null when it ended the VIP).
   *  "expired" = the sweep removed a grant whose date had passed; "seed reward" = an automated
   *  reward moved the expiry — the two events that used to be invisible here, which made a paid
   *  grant's disappearance read as a mystery instead of a receipt. */
  action: "granted" | "reduced" | "revoked" | "expired" | "seed reward" | "game reward" | "rule VIP";
  by: string;
  byUserId: string | null;
  serverId: string | null;
  serverName: string | null;
  expiration: string | null;
  comment: string | null;
  /** Written while a group perk held the grant: it stayed permanent (the group's), and the change
   *  landed in the VIP of their own frozen beneath the hold. */
  held?: boolean;
}

export function VipHistory({ playerId, reloadKey }: {
  playerId: string;
  /**
   * Changes whenever the page around it reloads. The profile reloads after a VIP action taken on
   * it (and its VIP status box shows the new grant straight away) — this timeline used to load
   * once per player and stay stale, so a grant just made read as missing from the history.
   */
  reloadKey?: unknown;
}) {
  // The panel answers to either VIP permission, as its read does; without one it is not drawn,
  // and asking would only be refused.
  const grants = useGrants();
  const sees = hasCap(grants, "vip.grant") || hasCap(grants, "vip.revoke");
  const loader = useCallback(
    () => (sees ? api<{ history: VipHistoryRow[] }>(`/players/${encodeURIComponent(playerId)}/vip-history`).then((r) => r.history) : Promise.resolve([])),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloadKey is the refetch trigger, not an input
    [playerId, reloadKey, sees],
  );
  const { data: history, error } = useResource(loader);
  const sort = useSortable<VipHistoryRow>({
    ts: (h) => h.ts,
    action: (h) => h.action,
    server: (h) => h.serverName ?? "",
    by: (h) => h.by,
  }, "ts", "desc", "viphistory");
  const sorted = useMemo(() => sort.sorted(history ?? []), [sort, history]);
  // Nothing until the history is in: an empty list while it loads would read as a short one and
  // send the page left back to the first.
  const pages = useClientPages(history ? sorted : null, `players.profile.${playerId}.vipHistory`, "", `${sort.key}:${sort.dir}`);

  // A one-line summary above the table, because the shape of the history is usually the answer:
  // "granted six times, revoked twice" tells you this is a long-standing donator at a glance.
  const summary = useMemo(() => {
    if (!history?.length) return null;
    const count = (a: VipHistoryRow["action"]) => history.filter((h) => h.action === a).length;
    const granted = count("granted"); const reduced = count("reduced"); const revoked = count("revoked");
    const expired = count("expired"); const seeded = count("seed reward"); const game = count("game reward"); const ruled = count("rule VIP");
    const parts = [`${granted} grant${granted === 1 ? "" : "s"}`];
    if (reduced) parts.push(`${reduced} reduction${reduced === 1 ? "" : "s"}`);
    parts.push(`${revoked} revoke${revoked === 1 ? "" : "s"}`);
    if (expired) parts.push(`${expired} expir${expired === 1 ? "y" : "ies"}`);
    if (seeded) parts.push(`${seeded} seed rewrite${seeded === 1 ? "" : "s"}`);
    if (game) parts.push(`${game} game reward${game === 1 ? "" : "s"}`);
    if (ruled) parts.push(`${ruled} rule VIP${ruled === 1 ? "" : "s"}`);
    return parts.join(", ");
  }, [history]);

  return (
    <Panel defaultCollapsed id="viphistory" caps={["vip.grant", "vip.revoke"]} title="VIP history" subtitle={summary ?? undefined}>
      <ActionResult error={error} />
      {!history && !error && <SkeletonRows rows={4} cols={4} />}
      {history && history.length === 0 && (
        <EmptyState icon="★" title="No VIP activity for this player">
          Grants and revokes made through the panel are recorded here with who did it and why. VIP
          set directly on the game server, or before this panel was watching, leaves no entry.
        </EmptyState>
      )}
      {history && history.length > 0 && (
        <div className="scroll-x">
          <table>
            <thead><tr>
              <SortTh s={sort} k="ts">When</SortTh>
              <SortTh s={sort} k="action">What</SortTh>
              <SortTh s={sort} k="server">Server</SortTh>
              <SortTh s={sort} k="by">By</SortTh>
              <th>Until</th><th>Comment</th>
            </tr></thead>
            <tbody>
              {(pages.items ?? []).map((h) => (
                <tr key={h.id}>
                  <td><Time iso={h.ts} /></td>
                  <td><span className={`badge ${h.action === "granted" ? "active" : h.action === "reduced" || h.action === "seed reward" || h.action === "game reward" ? "warn-badge" : "observe"}`}>{h.action}</span></td>
                  <td>{h.serverName ?? <span className="muted">—</span>}</td>
                  <td><StaffLink userId={h.byUserId ?? undefined} name={h.by} /></td>
                  {/* For a reduction the date is the NEW expiry after time was taken back; a
                      reduction with no date used the grant up on the spot. */}
                  {/* An "expired" row's date is the moment the grant died — the most useful
                      number on the row when tracing why a VIP vanished. */}
                  {/* Under a group perk's hold the grant stayed the group's permanent whatever was
                      changed beneath it — a revoke or a reduction there ended nothing. */}
                  <td>{h.held ? "permanent (group)" : h.action === "revoked" ? <span className="muted">—</span> : h.expiration ? fmtExact(h.expiration) : h.action === "reduced" ? "ended the VIP" : h.action === "expired" ? <span className="muted">—</span> : "permanent"}</td>
                  <td className="wrap">{h.comment || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {history && history.length > 0 && <Pager list={pages} noun="entry" />}
    </Panel>
  );
}
