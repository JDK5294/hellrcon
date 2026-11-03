/**
 * "Filed, not done" — the one answer every screen in the panel has to understand, whether or not
 * it has ever heard of approvals.
 *
 * A write can come back 202 from anywhere now: the player menus, the VIP editor, the watchlist,
 * and every server-scoped write there is (map work, votes, seeding, console, configuration). Two
 * things happen to it — the caller is told in words that reach the user, and anything watching the
 * request builder is told so its count stays honest. Both live here, in a module with no imports,
 * because `lib/api` is where they are raised and the toast layer and the inline error strip are
 * where they are read, and none of those three should have to depend on the other two.
 */

/** The opening words of each notice. The renderers match on them to style news as news rather
 *  than as failure — see the note in `feedback.tsx`. */
export const SENT_FOR_APPROVAL = "Sent for approval";
export const ADDED_TO_REQUEST = "Added to your request";

export interface FiledNotice {
  requested?: boolean;
  captured?: boolean;
  lines?: number;
  label?: string;
  requestId?: string;
}

/** Is this 202 body a filing, rather than some other "accepted" answer? */
export function isFiled(status: number, data: unknown): data is FiledNotice {
  if (status !== 202 || !data || typeof data !== "object") return false;
  const d = data as FiledNotice;
  return Boolean(d.requested || d.captured);
}

/** What to tell the person who pressed the button. The label is the API's own words for the
 *  action ("Skip the map vote"), so the sentence names the thing rather than the URL. */
export function filedMessage(n: FiledNotice): string {
  const what = n.label ? ` — ${n.label}` : "";
  return n.captured
    ? `${ADDED_TO_REQUEST}${what}. Nothing happens until you review and submit.`
    : `${SENT_FOR_APPROVAL}${what} — it waits for someone who holds this permission (Moderation → Requests).`;
}

let listener: ((n: FiledNotice) => void) | null = null;
/** The request bar's count follows captures made from screens that know nothing about it. */
export function onRequestFiled(fn: (n: FiledNotice) => void): () => void {
  listener = fn;
  return () => { if (listener === fn) listener = null; };
}
export function announceFiled(n: FiledNotice): void {
  listener?.(n);
}
