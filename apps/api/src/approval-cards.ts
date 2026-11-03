/**
 * The approvals CARD: what a filed request looks like in Discord, and posting/editing it.
 *
 * Split from the relay's button handling so that filing a request can post a card without
 * importing the decision path — the route wrapper files refused calls, and dragging
 * `approveLine` (and through it the whole executor and `routes/kit`) into that import chain is
 * what put a cycle in an API that had none. Rendering reaches nothing but the repository and
 * Discord's HTTP API.
 *
 * Every send/edit here is fire-and-forget: a Discord outage must never fail a filing or an
 * approval that already happened, so nothing in this file throws.
 */
import type { AppContext } from "./context.js";
import { APPROVAL_CARD_MAX, APPROVALS_RELAY_KV_NS } from "@app/db";
import type { ApprovalLineRow, ApprovalRequestRow } from "@app/db";
import { createLogger, discordLiteral as asTyped } from "@app/shared";

const log = createLogger("approvals-relay");

const KV_NS = APPROVALS_RELAY_KV_NS;

/** The relay's switch: token + configured channel, or null (off — the normal state). */
async function armedRelay(ctx: AppContext): Promise<{ token: string; channelId: string; mentionRoleId: string | null } | null> {
  const token = process.env.DISCORD_TOKEN;
  if (!token) return null;
  const cfg = await ctx.repo.appConfig.get();
  if (!cfg.approvalsChannelId) return null;
  return { token, channelId: cfg.approvalsChannelId, mentionRoleId: cfg.approvalsMentionRoleId || null };
}

/** What each kind of line is called — on a card, and in a phone notification (phone-alerts). */
export const KIND_WORD: Record<string, string> = {
  message: "Message", kick: "Kick", punish: "Punish", tempban: "Temp ban", permaban: "Perma ban",
  unban_temp: "Lift temp ban", unban_perma: "Lift perma ban", switch: "Switch team", switch_death: "Switch on death",
  vip: "Grant VIP", vipRevoke: "Revoke VIP", tempban_extend: "Extend temp ban",
  watch: "Add to watchlist", unwatch: "Take off the watchlist",
};
const STATE_MARK: Record<string, string> = { pending: "⏳", approved: "✅", denied: "❌", voided: "⌛", executed: "✔" };

/** A filed CALL's subject and body, in the few words a card has room for — an approver pressing
 *  Approve on "Broadcast to the server" has to see the message, not just the verb, and one on
 *  "Rename a map" has to see WHICH map, which some routes carry in the path rather than the body.
 *  Says the same thing as the panel queue's `routeDetails`, which the two apps cannot share; each
 *  has its own test on the sentence it produces. */
function routeBits(p: Record<string, unknown>): string[] {
  const params = (p.params ?? {}) as Record<string, unknown>;
  // Named when it was filed (ask-subject.ts): the account, the group, the rule — never just an id.
  // Lines filed before that print their path parameters as they came.
  const which = Array.isArray(p.subject)
    ? (p.subject as unknown[]).filter((s): s is string => typeof s === "string").map(asTyped)
    : typeof params === "object" && params !== null
      ? Object.entries(params)
        .filter(([k, v]) => k !== "id" && (typeof v === "string" || typeof v === "number") && String(v) !== "")
        .map(([k, v]) => `${k}: ${asTyped(String(v))}`)
      : [];
  const body = (p.body ?? {}) as Record<string, unknown>;
  if (typeof body !== "object" || body === null) return which;
  const scalars: string[] = [];
  const structured: string[] = [];
  // A comment someone typed for the call goes first: every VIP added carries one (kit.ts
  // requiredVipComment), and on a selection's or a group's grant it is the fifth field or later,
  // which the four shown below would leave behind "+N more".
  const entries = Object.entries(body);
  for (const [k, v] of [...entries.filter(([k]) => k === "comment"), ...entries.filter(([k]) => k !== "comment")]) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") scalars.push(`${k}: “${asTyped(v.length > 70 ? `${v.slice(0, 70)}…` : v)}”`);
    else if (typeof v === "number" || typeof v === "boolean") scalars.push(`${k}: ${v}`);
    else structured.push(k);
  }
  const bits = scalars.slice(0, 4);
  if (scalars.length > 4) bits.push(`+${scalars.length - 4} more`);
  if (structured.length) bits.push(`changes ${structured.slice(0, 4).join(", ")}`);
  return [...which, ...bits];
}

/** How much of the card one line, the note, and the "more lines" footer may take. */
const LINE_MAX = 300;
const NOTE_MAX = 300;
const MORE_ROOM = 110;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function lineText(l: ApprovalLineRow, serverName: string | null): string {
  const p = l.payload as Record<string, unknown>;
  const bits: string[] = l.kind === "route" ? routeBits(p) : [];
  if (l.kind === "route") { /* said above */ }
  else if (l.kind === "tempban_extend") bits.push(`${p.appliedHours}h applied · asking ${p.hours}h total`);
  else if (l.kind === "vipRevoke") {
    // What signing ENDS, because a permanent grant is very often a paid one: the grant as it stood
    // when this was asked for (the executor refuses one that turned permanent since).
    const grant = (p.grant ?? null) as { expiration?: unknown; comment?: unknown } | null;
    if (grant) {
      const until = typeof grant.expiration === "string" ? Date.parse(grant.expiration) : NaN;
      bits.push(grant.expiration === null ? "⚠️ ends **permanent** VIP" : Number.isFinite(until) ? `VIP until <t:${Math.floor(until / 1000)}:D>` : "dated VIP");
      if (typeof grant.comment === "string" && grant.comment) bits.push(`note “${asTyped(grant.comment)}”`);
    }
  } else {
    if (typeof p.hours === "number" && p.hours > 0) bits.push(`${p.hours}h`);
    if (typeof p.days === "number" && p.days > 0) bits.push(`${p.days}d`);
    if (l.kind === "vip") {
      // What signing GRANTS, the same way: a grant that never ends is called out, a date is said,
      // and the comment every VIP added carries (kit.ts requiredVipComment) — who paid, what for,
      // which event — is shown, because it is what the approver is vouching for.
      const until = typeof p.expiresAt === "string" ? Date.parse(p.expiresAt) : NaN;
      if (p.mode === "permanent") bits.push("**permanent** VIP");
      else if (p.mode === "until" && Number.isFinite(until)) bits.push(`VIP until <t:${Math.floor(until / 1000)}:D>`);
      if (typeof p.comment === "string" && p.comment) bits.push(`comment “${asTyped(p.comment)}”`);
    }
  }
  if (l.kind !== "route") {
    if (typeof p.reason === "string" && p.reason) bits.push(`“${asTyped(p.reason)}”`);
    if (typeof p.message === "string" && p.message) bits.push(`“${asTyped(p.message)}”`);
  }
  const stamp = l.decidedByName
    ? ` — ${l.state}${l.state === "executed" ? " (own permission)" : ""} by **${asTyped(l.decidedByName)}**${l.denyReason ? `: “${asTyped(l.denyReason)}”` : ""}`
    : "";
  const failed = l.applyError ? ` ⚠️ not applied: ${asTyped(l.applyError)}` : "";
  // A filed CALL (map work, votes, configuration) carries its own words and names no player, so
  // it reads "Skip the map vote on Server 1" rather than "route ? on Server 1".
  const word = KIND_WORD[l.kind] ?? (typeof p.label === "string" && p.label ? p.label : l.kind);
  // The player's name as they wrote it: "*ABC* Smith" kept its asterisks, a "[x](https://…)" name
  // stays words instead of a link on a card people press Approve under.
  const who = asTyped(l.playerName || l.playerId || (l.kind === "route" ? "" : "?"));
  // Some decisions belong to no server: a watch follows the PERSON across the community, so its
  // line carries no serverId and must not claim to be "on ?" — the queue in the panel has always
  // left the server column empty for those, and the card now agrees with it.
  const where = serverName ? ` on ${serverName}` : "";
  return `${STATE_MARK[l.state] ?? ""} **${word}**${who ? ` ${who}` : ""}${where}${bits.length ? ` · ${bits.join(" · ")}` : ""}${stamp}${failed}`;
}

/** Exported for the card's own test: what an approver reads in Discord is worth asserting on
 *  directly, rather than only through whatever the relay happened to send. */
export function renderCard(r: ApprovalRequestRow, serverName: (id: string | null) => string | null, mentionRoleId: string | null): Record<string, unknown> {
  const open = r.status === "open";
  const head = open
    ? `✋ **Approval request** from **${asTyped(r.requesterName)}**`
    : `**Approval request** from **${asTyped(r.requesterName)}** — **${r.status}**`;
  const note = r.note ? `\n> ${asTyped(clip(r.note, NOTE_MAX))}` : "";
  const mention = open && mentionRoleId ? `<@&${mentionRoleId}> ` : "";
  /*
   * Kept under Discord's limit, whatever the request. A message over it is refused outright: a big
   * bundle never posted at all, so the people who approve from Discord never saw it, and an edit
   * past it left the card stale with live buttons. Each line is held to a size, and the lines that
   * do not fit are counted under the last one that does — the panel has them all.
   */
  let content = `${mention}${head}${note}`;
  const rendered = r.lines.map((l) => clip(lineText(l, serverName(l.serverId)), LINE_MAX));
  let shown = 0;
  for (const [i, text] of rendered.entries()) {
    const limit = i === rendered.length - 1 ? APPROVAL_CARD_MAX : APPROVAL_CARD_MAX - MORE_ROOM;
    if (content.length + 1 + text.length > limit) break;
    content += `\n${text}`;
    shown++;
  }
  const hidden = rendered.length - shown;
  if (hidden) content += `\n…and ${hidden} more line${hidden === 1 ? "" : "s"} — every line is under Moderation → Requests in the panel`;
  return {
    content,
    // Buttons only while there is something to decide; a closed card keeps the story, not the levers.
    components: open ? [{
      type: 1,
      components: [
        { type: 2, style: 3, label: "Approve all I can", custom_id: `apr:${r.id}:all` },
        { type: 2, style: 4, label: "Deny…", custom_id: `apr:${r.id}:deny` },
      ],
    }] : [],
    allowed_mentions: { parse: [], roles: mentionRoleId ? [mentionRoleId] : [] },
  };
}

/**
 * Post the card for a freshly filed request. Never throws — the filing already happened.
 *
 * Every filing comes through here, so this is also where the phones of the people who could sign
 * it hear about it (phone-alerts) — whether or not Discord is set up. A context built without them
 * (a test's, wiring only the repository) has nobody to tell, and this still never throws.
 */
export async function postApprovalCard(ctx: AppContext, requestId: string): Promise<void> {
  void ctx.phoneAlerts?.requestFiled(requestId).catch((err: unknown) => log.warn("request notification failed", { err: (err as Error).message }));
  try {
    const relay = await armedRelay(ctx);
    if (!relay) return;
    const r = await ctx.repo.approvals.get(requestId);
    if (!r || r.status !== "open") return;
    const servers = await ctx.repo.servers.list();
    const names = new Map(servers.map((s) => [s.id, s.name]));
    const payload = renderCard(r, (id) => (id ? names.get(id) ?? "?" : null), relay.mentionRoleId);
    const res = await fetch(`https://discord.com/api/v10/channels/${relay.channelId}/messages`, {
      method: "POST", headers: { authorization: `Bot ${relay.token}`, "content-type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) { log.warn("approvals relay post refused", { status: res.status }); return; }
    const msg = (await res.json()) as { id: string };
    // The rendered text is stored with the reference, and kept current on every edit below. It is
    // what lets the EXPIRY sweep close this card: that sweep runs in the worker, which has no
    // reason to know how a request is worded, and can now say "expired" under the card's own
    // sentences and take the buttons away without re-rendering anything.
    await ctx.repo.pluginKv.set(KV_NS, requestId, { channelId: relay.channelId, messageId: msg.id, content: String(payload.content ?? "") });
  } catch (err) {
    log.warn("approvals relay post failed", { err: (err as Error).message });
  }
}

/** Re-render the card after any decision (or withdrawal). Never throws. */
export async function updateApprovalCard(ctx: AppContext, requestId: string): Promise<void> {
  // The requester's phone first, Discord or not: every decision comes through here.
  void ctx.phoneAlerts?.requestDecided(requestId).catch((err: unknown) => log.warn("decided-request notification failed", { err: (err as Error).message }));
  try {
    const token = process.env.DISCORD_TOKEN;
    if (!token) return;
    const ref = (await ctx.repo.pluginKv.get(KV_NS, requestId)) as { channelId?: string; messageId?: string; content?: string } | null;
    if (!ref?.channelId || !ref.messageId) return;
    const r = await ctx.repo.approvals.get(requestId);
    if (!r) return;
    const servers = await ctx.repo.servers.list();
    const names = new Map(servers.map((s) => [s.id, s.name]));
    const cfg = await ctx.repo.appConfig.get();
    const payload = renderCard(r, (id) => (id ? names.get(id) ?? "?" : null), cfg.approvalsMentionRoleId || null);
    // Edits never re-ping: the mention did its job when the card was posted.
    payload.content = String(payload.content ?? "").replace(/^<@&\d+> /, "");
    const res = await fetch(`https://discord.com/api/v10/channels/${ref.channelId}/messages/${ref.messageId}`, {
      method: "PATCH", headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
    });
    // Keep the stored copy in step, so the expiry sweep closes the card as it last read, not as it
    // was first posted. (A still-open request can expire after several lines were already signed.)
    if (res.ok) await ctx.repo.pluginKv.set(KV_NS, requestId, { ...ref, content: String(payload.content ?? "") });
  } catch (err) {
    log.warn("approvals relay update failed", { err: (err as Error).message });
  }
}
