/**
 * Filing, and the builder's capture — the two ways a line gets INTO a request.
 *
 * Deliberately a leaf: it reaches nothing but the repository, so the route wrapper that files a
 * refused call can call in without dragging the whole executor (and, through it, `routes/kit`)
 * behind it. Executing an approved line is a different job with different dependencies, and it
 * lives in `approvals.ts`.
 */
import type { AppContext } from "./context.js";
import type { Principal } from "./auth.js";
import type { ApprovalRequestRow, NewApprovalLine } from "@app/db";

/** How long a filed request waits before it ages out — nothing this stale should auto-execute,
 *  and a queue that never forgets fills with cards nobody can act on. */
export const REQUEST_TTL_HOURS = 48;

/**
 * A line's player as the directory knows them. The name a call arrives with is whatever the caller
 * sent — the panel's live roster, or anything at all — and the queue and the Discord card print it
 * beside the action, so a ban filed on one id under another player's name read as that other
 * player. The directory's name wins wherever it has one; an id it has never seen keeps the name it
 * came with.
 */
async function withDirectoryName<T extends Pick<NewApprovalLine, "playerId" | "playerName">>(ctx: AppContext, line: T): Promise<T> {
  if (!line.playerId) return line;
  const known = await ctx.repo.players.findByPlatformId(line.playerId).catch(() => null);
  return known?.name ? { ...line, playerName: known.name } : line;
}

/**
 * File a request: one draft, its lines, submitted in one motion, audited once.
 *
 * `continues` names the request this one carries on — the cascade files the unsigned remainder of
 * an ask under the requester's name, and that is the SAME ask still climbing, not a second one
 * they made. The audit row is marked so the staff counts skip it (`countableActions`): a 48h ban
 * that needed three signatures is one request on their record, not three.
 */
export async function fileRequest(
  ctx: AppContext, p: { user: { id: string }; name: string }, lines: NewApprovalLine[],
  opts: { note?: string | null; continues?: string } = {},
): Promise<ApprovalRequestRow> {
  const draft = await ctx.repo.approvals.create({ requesterUserId: p.user.id, requesterName: p.name, note: opts.note ?? null });
  let seq = 0;
  for (const line of lines) await ctx.repo.approvals.addLine(draft.id, { ...(await withDirectoryName(ctx, line)), seq: seq++ });
  const filed = (await ctx.repo.approvals.submit(draft.id, new Date(Date.now() + REQUEST_TTL_HOURS * 3_600_000).toISOString()))!;
  await ctx.repo.audit.create({
    actorUserId: p.user.id, actorName: p.name, action: "request.file",
    targetType: "request", targetId: filed.id,
    // A filed CALL has its own words (see ROUTE_ASK_LABELS) and names no player — "route" would
    // tell a reader of the trail nothing at all.
    summary: `filed an approval request: ${filed.lines.map((l) => {
      if (l.kind !== "route") return `${l.kind} ${l.playerName || l.playerId || ""}`.trim();
      const { label, subject } = l.payload as { label?: unknown; subject?: unknown };
      const named = Array.isArray(subject) ? subject.filter((x): x is string => typeof x === "string") : [];
      return `${String(label ?? "a server change")}${named.length ? ` (${named.join(" · ")})` : ""}`;
    }).join(", ")}`,
    data: {
      requestId: filed.id,
      lines: filed.lines.map((l) => ({ kind: l.kind, capability: l.capability, serverId: l.serverId, playerId: l.playerId })),
      ...(opts.continues ? { continues: opts.continues } : {}),
    },
  });
  return filed;
}

/**
 * The builder's capture: one already-validated line into the caller's open draft.
 *
 * Creating the draft on demand and un-parking it are both part of "capture" — a saved draft that
 * takes a line IS building again, so the view elevation always matches actual activity rather than
 * leaving a second tab building blind. Shared because every capturing route wrote the same three
 * lines out by hand, and a route that forgot the un-park would be silently wrong.
 */
export async function captureLine(
  ctx: AppContext, p: Principal, line: Omit<NewApprovalLine, "seq">,
): Promise<{ captured: true; draftId: string; lines: number }> {
  const draft = (await ctx.repo.approvals.findDraft(p.user.id)) ?? await ctx.repo.approvals.create({ requesterUserId: p.user.id, requesterName: p.name });
  if (draft.parkedAt) await ctx.repo.approvals.parkDraft(p.user.id, false);
  await ctx.repo.approvals.addLine(draft.id, { ...(await withDirectoryName(ctx, line)), seq: draft.lines.length });
  return { captured: true, draftId: draft.id, lines: draft.lines.length + 1 };
}
