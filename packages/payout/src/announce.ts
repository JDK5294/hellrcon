/**
 * The events list, written for Discord — and the decision of when to post it by itself.
 *
 * Everything here is PURE (data in, a string or a verdict out), because both callers need the
 * identical answer: the API when staff press "Post now", and the worker when the weekly schedule
 * comes round. Two implementations of "what does the list look like" is how the automatic post
 * ends up disagreeing with the one a human just sent.
 *
 * ## Why unix timestamps
 *
 * Discord renders `<t:1756000000:F>` in each READER's own time zone. A community spans zones —
 * that is the whole reason the panel now has one — and a post that says "Saturday 8pm" is wrong
 * for most of the people reading it, in a way nobody can correct from the message. The unix form
 * is the only spelling that is right for everyone at once, so every instant in this post is
 * written that way and no wall-clock string is composed anywhere in it.
 */

/** The slice of an event this post reads — a structural subset of PayoutEventRow, so the store's
 *  row satisfies it without this package depending on @app/db. */
export interface AnnounceableEvent {
  id: string;
  name: string;
  serverId: string;
  status: "scheduled" | "open" | "closed" | "cancelled";
  openMode: "at" | "match_start_after";
  openAnchor: string;
  openedAt: string | null;
  closeMode: "at" | "match_end_after";
  closeAnchor: string;
  closedAt: string | null;
}

export interface EventsPostOptions {
  /** How many days ahead to include. The window is [now, now + days). */
  days: number;
  /** Server id → the name players know it by. A server absent from the map is simply unnamed. */
  serverNames?: Map<string, string> | Record<string, string>;
  /** Heading, when the community wants their own wording. */
  title?: string;
  /** Line under the heading — "Times show in your own zone" is the default, because the whole
   *  point of the timestamp markup is invisible until somebody says it once. */
  footer?: string;
  now?: number;
  /** Discord's practical message budget (default 1900, under the 2000 hard cap). The post fits
   *  itself inside it by dropping WHOLE entries — see buildEventsPost. */
  maxLen?: number;
  /** How an event's name, which staff type, is written into Discord's markdown so it shows as
   *  typed — the callers pass @app/shared's discordLiteral (this package keeps no dependencies).
   *  Without it a name is written as it is. */
  literal?: (text: string) => string;
}

/** Discord's timestamp markup: seconds since the epoch, in one of its display styles. */
export function discordTime(iso: string, style: "F" | "f" | "t" | "R" | "d" = "F"): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return `<t:${Math.floor(t / 1000)}:${style}>`;
}

/** When an event BEGINS, as far as anyone can know now: the resolved instant once it has opened,
 *  else the anchor it is waiting on. */
export function eventStart(ev: AnnounceableEvent): string {
  return ev.openedAt ?? ev.openAnchor;
}
/** The same for the end. */
export function eventEnd(ev: AnnounceableEvent): string {
  return ev.closedAt ?? ev.closeAnchor;
}

/**
 * The events worth announcing, soonest first: those still to come or running right now, whose
 * start falls inside the next `days`. A cancelled or closed event is a record, not an invitation.
 *
 * An event that is already OPEN is always included whatever its start says — it is happening as
 * the post goes up, which is the single most useful line in it.
 */
export function upcomingEvents(events: AnnounceableEvent[], days: number, now = Date.now()): AnnounceableEvent[] {
  const until = now + Math.max(0, days) * 86_400_000;
  return events
    .filter((ev) => {
      if (ev.status === "cancelled" || ev.status === "closed") return false;
      if (ev.status === "open") return true;
      const start = Date.parse(eventStart(ev));
      return Number.isFinite(start) && start >= now && start < until;
    })
    .sort((a, b) => Date.parse(eventStart(a)) - Date.parse(eventStart(b)));
}

const nameOf = (map: EventsPostOptions["serverNames"], id: string): string | null => {
  if (!map) return null;
  return (map instanceof Map ? map.get(id) : map[id]) ?? null;
};

/** One event as a two-line entry. Exported for the tests and for anything that wants a single
 *  event's line without the whole post. */
export function eventLine(ev: AnnounceableEvent, opts: Pick<EventsPostOptions, "serverNames" | "literal"> = {}): string {
  const start = eventStart(ev);
  const end = eventEnd(ev);
  const span = Date.parse(end) - Date.parse(start);
  // Under a day the end needs only a clock face; longer than that and the date matters too.
  const endStyle = Number.isFinite(span) && span > 0 && span < 86_400_000 ? "t" : "f";
  const server = nameOf(opts.serverNames, ev.serverId);
  const where = server ? ` · ${server}` : "";
  // A match-boundary event does not start at its anchor, it starts with the first round after it.
  // Saying so is the difference between a reader turning up on time and turning up to a lobby.
  const hint = ev.status === "open"
    ? " · **on now**"
    : ev.openMode === "match_start_after" ? " · starts with the first match after this" : "";
  const name = opts.literal ? opts.literal(ev.name) : ev.name;
  return `**${name}**${where}\n${discordTime(start, "F")} → ${discordTime(end, endStyle)} · ${discordTime(start, "R")}${hint}`;
}

export const EVENTS_POST_TITLE = "📅 Upcoming events";
export const EVENTS_POST_FOOTER = "Times show in your own time zone.";

/**
 * The whole post, or null when there is nothing to announce — null rather than a cheerful "no
 * events!", because a scheduled weekly post that says nothing is happening, every week, is how a
 * channel teaches people to ignore it.
 */
export function buildEventsPost(events: AnnounceableEvent[], opts: EventsPostOptions): string | null {
  const now = opts.now ?? Date.now();
  const list = upcomingEvents(events, opts.days, now);
  if (!list.length) return null;
  const head = `${opts.title ?? EVENTS_POST_TITLE}${opts.days > 0 ? ` — next ${opts.days} day${opts.days === 1 ? "" : "s"}` : ""}`;
  const foot = opts.footer ?? EVENTS_POST_FOOTER;
  /*
   * The post fits Discord's budget by ITSELF, dropping whole entries from the far end of the
   * window and saying how many were dropped. The callers used to `slice(0, 1900)` instead, which
   * on a full calendar sheared the last entry mid-`<t:…>` token — Discord renders a broken
   * timestamp as its raw markup — and ate the footer that explains the time zone.
   */
  const maxLen = opts.maxLen ?? 1900;
  const lines = list.map((ev) => eventLine(ev, opts));
  const compose = (keep: number) => {
    const dropped = lines.length - keep;
    return `${head}\n\n${lines.slice(0, keep).join("\n\n")}`
      + (dropped > 0 ? `\n\n-# …and ${dropped} more event${dropped === 1 ? "" : "s"} later in the window.` : "")
      + (foot ? `\n\n-# ${foot}` : "");
  };
  let keep = lines.length;
  while (keep > 1 && compose(keep).length > maxLen) keep--;
  return compose(keep);
}

/* ------------------------------------------------------------------------------------------- *
 * The schedule: post this by itself, on a chosen day, at a chosen time.
 * ------------------------------------------------------------------------------------------- */

/** 0 = Sunday … 6 = Saturday; -1 = every day. */
export type PostWeekday = -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * The schedule as this engine reads it — structural, so the store's config row satisfies it
 * without @app/payout growing a dependency on @app/db (the same seam `VipGrantLike` uses).
 * `weekday` is therefore a plain number: anything outside -1..6 simply never matches a day, which
 * is the safe reading of a value that should have been refused at the door.
 */
export interface EventPostSchedule {
  enabled: boolean;
  channelId: string;
  /** How many days ahead the posted list covers. */
  daysAhead: number;
  /** Which day to post on: 0 = Sunday … 6 = Saturday, -1 = every day. */
  weekday: number;
  /** Local time of day to post at, in the community zone. */
  atHour: number;
  atMinute: number;
  /** The last local date (YYYY-MM-DD) a post went out for — the once-per-day latch. */
  lastPostedOn: string | null;
}

/** The community-zone wall clock at an instant, as the scheduler needs to read it. */
function zoned(nowMs: number, tz: string): { date: string; weekday: number; minutes: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(nowMs))) if (part.type !== "literal") p[part.type] = part.value;
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const hour = Number(p.hour === "24" ? "0" : p.hour);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: days.indexOf((p.weekday ?? "sun").slice(0, 3).toLowerCase()),
    minutes: hour * 60 + Number(p.minute),
  };
}

/**
 * Should the automatic post go out right now?
 *
 * Answers with the local DATE it would be posting for, so the caller can latch it — that latch is
 * what makes a worker ticking every few minutes post once, and what makes a worker that was down
 * at the appointed minute still post when it comes back the same day (rather than silently
 * skipping the week). Past midnight the date has changed, so a missed post is missed for good,
 * which is the right call: nobody wants Monday's list arriving on Tuesday morning.
 */
export function dueEventsPost(schedule: EventPostSchedule, tz: string, nowMs = Date.now()): { postFor: string } | null {
  if (!schedule.enabled || !schedule.channelId) return null;
  let at: { date: string; weekday: number; minutes: number };
  try { at = zoned(nowMs, tz); } catch { at = zoned(nowMs, "UTC"); }
  if (schedule.weekday >= 0 && at.weekday !== schedule.weekday) return null;
  const due = Math.max(0, Math.min(23, schedule.atHour)) * 60 + Math.max(0, Math.min(59, schedule.atMinute));
  if (at.minutes < due) return null;
  if (schedule.lastPostedOn === at.date) return null;
  return { postFor: at.date };
}
