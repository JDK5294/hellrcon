/**
 * The unread-notice nudge message, pure so it's testable: one Discord post per notice posting,
 * naming everyone who hasn't opened the announcements board since it went up. Linked staff get a
 * real @mention (<@discordId>); unlinked ones are named in plain text.
 */
import { discordLiteral } from "@app/shared";

export interface NudgeTarget {
  discordId: string | null;
  name: string;
}

/** "3h" / "2d 4h" since posting, for the reminder line. */
export function agoLabel(publishedAt: string, nowMs: number): string {
  const h = Math.max(1, Math.floor((nowMs - Date.parse(publishedAt)) / 3_600_000));
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * Split the staff who haven't read a notice into the ones the reminder NAMES and the ones it
 * leaves alone — the excused (away, on leave). Pure so the away-list rule is a tested fact, not a
 * filter buried in the sweep: an excused member is never named however long the notice sits, and
 * they are returned separately so the audit row can say who was left out rather than going quiet.
 */
export function splitUnread<T extends { id: string }>(users: T[], readIds: Set<string>, excusedIds: string[]): { named: T[]; excused: T[] } {
  const excused = new Set(excusedIds);
  const named: T[] = [];
  const away: T[] = [];
  for (const u of users) {
    if (readIds.has(u.id)) continue;
    (excused.has(u.id) ? away : named).push(u);
  }
  return { named, excused: away };
}

export function buildNudgeMessage(title: string, publishedAt: string, nowMs: number, unread: NudgeTarget[]): string {
  // The title and the names are typed text, shown as typed: an underscore in a username is not
  // Discord's italics.
  const who = unread.map((u) => (u.discordId ? `<@${u.discordId}>` : `**${discordLiteral(u.name)}**`)).join(" ");
  return `📣 Staff notice **${discordLiteral(title)}** has been up for ${agoLabel(publishedAt, nowMs)} and is still unread by: ${who}\nPlease open the panel → Announcements (reading it there checks you off).`;
}

/**
 * Who the reminder may ping: exactly the linked staff it names, never a role or everyone. The post
 * that carries it lets nothing else through, so without this list its mentions would show as names
 * and notify nobody — which is what they did for a while.
 */
export function nudgePings(unread: NudgeTarget[]): string[] {
  return [...new Set(unread.map((u) => u.discordId).filter((id): id is string => Boolean(id)))];
}
