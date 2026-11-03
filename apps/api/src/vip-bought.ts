/**
 * What a VIP shop purchase bought, read back for the points history: on each server its days
 * landed on, when they start and when that VIP now ends.
 *
 * The ledger cannot say it. Nothing edits a ledger row, and a purchase's row is written before the
 * grant it pays for, when those dates are not known yet. Each server's grant leaves a `vip.grant`
 * row in the audit trail carrying the purchase's ledger ref (shop.ts grantDays), with the end it
 * set and the days it added. The days go on top of whatever VIP was already there, so they start
 * where that ended: the new end less the days.
 *
 * A purchase that landed nowhere (refunded), or whose rows have been trimmed off the trail, simply
 * has no dates.
 */
import { economyActivityKind, type EconomyLedgerRow, type Repository } from "@app/db";

/** One server's part in a purchase. */
export interface VipBought {
  serverId: string | null;
  serverName: string;
  /** The game account the days landed on — the buyer's own, or a gift's recipient's. */
  playerId: string;
  /** When the days bought start: when the VIP already there ran out, or the purchase itself. */
  from: string | null;
  /** When the VIP on this server now ends. */
  until: string | null;
  /** A group gives them permanent VIP here: the days are saved for when that ends. */
  held: boolean;
}

const DAY_MS = 86_400_000;

/** The purchases among `entries`, by ledger ref, each with what its days landed as. */
export async function vipBought(repo: Repository, entries: readonly Pick<EconomyLedgerRow, "ref">[]): Promise<Map<string, VipBought[]>> {
  const refs = [...new Set(entries.flatMap((e) => (e.ref !== null && economyActivityKind(e.ref) === "purchase" ? [e.ref] : [])))];
  const out = new Map<string, VipBought[]>();
  if (!refs.length) return out;
  const [rows, servers] = await Promise.all([repo.audit.vipGrantsByRef(refs), repo.servers.list({ includeRetired: true })]);
  const names = new Map(servers.map((s) => [s.id, s.name]));
  for (const row of rows) {
    const d = (row.data ?? {}) as { ref?: unknown; playerId?: unknown; expiration?: unknown; days?: unknown; groupHeld?: unknown };
    if (typeof d.ref !== "string") continue;
    const held = d.groupHeld === true;
    const end = !held && typeof d.expiration === "string" ? Date.parse(d.expiration) : NaN;
    const days = typeof d.days === "number" && d.days > 0 ? d.days : NaN;
    const list = out.get(d.ref) ?? [];
    list.push({
      serverId: row.serverId,
      serverName: (row.serverId && names.get(row.serverId)) || "a removed server",
      playerId: typeof d.playerId === "string" ? d.playerId : row.targetId ?? "",
      from: Number.isFinite(end) && Number.isFinite(days) ? new Date(end - days * DAY_MS).toISOString() : null,
      until: Number.isFinite(end) ? new Date(end).toISOString() : null,
      held,
    });
    out.set(d.ref, list);
  }
  return out;
}

/** Ledger rows as the panel reads them: a purchase with its dates beside it, as `vip`. */
export function withVipBought<T extends Pick<EconomyLedgerRow, "ref">>(entries: readonly T[], bought: ReadonlyMap<string, VipBought[]>): (T & { vip?: VipBought[] })[] {
  return entries.map((e) => {
    const vip = e.ref ? bought.get(e.ref) : undefined;
    return vip ? { ...e, vip } : e;
  });
}
