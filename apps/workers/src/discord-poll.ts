/**
 * Minimal Discord REST client for native polls — no gateway, no discord.js. Discord lets us create a
 * poll and read its live results + finalize it entirely over REST, which is exactly what the "basic"
 * native vote surface needs. (The richer custom-embed surface, which needs interaction handling, is a
 * later increment.)
 *
 * Docs: a message can carry a `poll` object; results live under `message.poll.results.answer_counts`
 * keyed by 1-based answer id; `POST /channels/{c}/polls/{m}/expire` finalizes early.
 */
const API = "https://discord.com/api/v10";

/**
 * Every call gets a hard deadline. These requests are awaited inline in the worker's loops — a
 * board edit inside the ingest loop, a poll read inside the vote tick — so a hung socket without
 * one stalls that server's ingestion for as long as the runtime's defaults allow, which is minutes.
 * Fifteen seconds is generous for a REST call and an eternity for a loop.
 */
const DEADLINE_MS = 15_000;

/**
 * A refusal from Discord, carrying the parts a caller may need to act on rather than only a
 * sentence. The message is unchanged, so every existing `catch` still logs what it always did;
 * `status` and `body` exist for the one caller that must tell "rate limited, wait and retry" from
 * "forbidden, stop asking" — reading that back out of a formatted string would be guesswork.
 */
export class DiscordHttpError extends Error {
  constructor(public readonly status: number, public readonly body: string, message: string) {
    super(message);
    this.name = "DiscordHttpError";
  }
}

async function discord(token: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(DEADLINE_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new DiscordHttpError(res.status, text, `Discord ${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

export interface CreatedPoll { messageId: string }

/** What a channel sweep did, and what stopped it. `refused` counts messages Discord would not let
 *  us delete (a missing permission, almost always); `status` is the first refusal's HTTP code. */
export interface SweepResult { removed: number; refused: number; status: number }

/** Create a single-choice poll message. `answers` are shown in order; ids downstream come from the
 *  caller's option order, so we never key logic off the answer text. */
export async function createPoll(token: string, channelId: string, question: string, answers: string[], durationHours: number): Promise<CreatedPoll> {
  const msg = (await discord(token, "POST", `/channels/${channelId}/messages`, {
    poll: {
      question: { text: question.slice(0, 300) },
      answers: answers.map((text) => ({ poll_media: { text: text.slice(0, 55) } })), // Discord caps answer text at 55
      duration: Math.max(1, Math.min(768, Math.round(durationHours))), // Discord allows 1h..32d
      allow_multiselect: false,
    },
  })) as { id?: string };
  if (!msg.id) throw new Error("Discord poll create returned no message id");
  return { messageId: msg.id };
}

/** Read live vote counts as an array indexed by the ORIGINAL answer order (answer_id − 1). */
export async function getPollCounts(token: string, channelId: string, messageId: string, answerCount: number): Promise<number[]> {
  const msg = (await discord(token, "GET", `/channels/${channelId}/messages/${messageId}`)) as {
    poll?: { results?: { answer_counts?: { id: number; count: number }[] } };
  };
  const counts = new Array(answerCount).fill(0) as number[];
  for (const a of msg.poll?.results?.answer_counts ?? []) {
    const idx = a.id - 1; // answer ids are 1-based, in creation order
    if (idx >= 0 && idx < answerCount) counts[idx] = Number(a.count) || 0;
  }
  return counts;
}

/** Finalize a poll early (stops voting, freezes results). */
export async function expirePoll(token: string, channelId: string, messageId: string): Promise<void> {
  await discord(token, "POST", `/channels/${channelId}/polls/${messageId}/expire`);
}

export interface PollVoter { discordId: string; name: string }

/**
 * Who voted for one answer. `GET /channels/{c}/polls/{m}/answers/{answerId}` is plain REST — no
 * gateway needed — and pages 100 at a time with an `after` cursor.
 *
 * Answer ids are 1-based and follow the order the answers were added, which is the caller's option
 * order, so index i ↔ answerId i+1.
 */
export async function getAnswerVoters(token: string, channelId: string, messageId: string, answerId: number): Promise<PollVoter[]> {
  const out: PollVoter[] = [];
  let after = "";
  // A poll can't realistically exceed a few thousand voters; the cap stops a bad cursor from
  // spinning forever rather than expressing a real limit.
  for (let page = 0; page < 50; page++) {
    const q = `?limit=100${after ? `&after=${after}` : ""}`;
    // Honour a rate limit rather than losing the page to it. This read is no longer incidental:
    // since the combined surface merges ballots, it is what DECIDES the final tally, and it is
    // issued once per option — several requests in a row, at the moment a match ends. Giving up on
    // the first 429 dropped a whole option's Discord voters and the vote was then settled, and
    // announced, on the number that was left.
    const res = (await withRateLimitRetry(() =>
      discord(token, "GET", `/channels/${channelId}/polls/${messageId}/answers/${answerId}${q}`),
    )) as {
      users?: { id?: string; username?: string; global_name?: string | null }[];
    };
    const users = res?.users ?? [];
    for (const u of users) {
      if (!u?.id) continue;
      out.push({ discordId: String(u.id), name: String(u.global_name || u.username || u.id) });
    }
    if (users.length < 100) break;
    after = String(users[users.length - 1]!.id);
  }
  return out;
}

/** Best-effort: post a plain message (e.g. announcing the applied winner). Never throws. */
export async function postMessage(token: string, channelId: string, content: string, pingUserIds: readonly string[] = []): Promise<void> {
  // parse:[] — nothing this bot relays as plain text may ever ping a person, a role or everyone.
  // The one exception is a post that names people on purpose (the unread-notice reminder): it
  // lists exactly those accounts, and Discord takes at most 100.
  const allowed = pingUserIds.length ? { parse: [], users: pingUserIds.slice(0, 100) } : { parse: [] };
  try { await discord(token, "POST", `/channels/${channelId}/messages`, { content: content.slice(0, 1900), allowed_mentions: allowed }); } catch { /* best-effort */ }
}

/** Post an embed and return its message id, so it can be edited or taken down later (the paused
 *  notice, the match board). Returns null rather than throwing — a missing notice must not stall
 *  the vote loop. `file` attaches an image the embed can reference as `attachment://<name>`. */
export async function postEmbedTracked(token: string, channelId: string, embed: Record<string, unknown>, file?: EmbedFile | null): Promise<string | null> {
  try {
    const path = `/channels/${channelId}/messages`;
    const msg = (file
      ? await discordWithFile(token, "POST", path, { embeds: [embed] }, file)
      : await discord(token, "POST", path, { embeds: [embed] })) as { id?: string };
    return msg?.id ? String(msg.id) : null;
  } catch { return null; }
}

/** An image to upload with a message, referenced from the embed as `attachment://<name>`. */
export interface EmbedFile { name: string; bytes: Uint8Array }

/**
 * Send an embed with a file attached (multipart), for the boards that carry map artwork.
 *
 * Discord resolves `attachment://<filename>` against the files on the SAME message, so a bundled
 * image can be shown without hosting it anywhere public — which matters, because the panel is
 * usually only reachable on the operator's own network.
 */
async function discordWithFile(token: string, method: string, path: string, payload: unknown, file: EmbedFile): Promise<unknown> {
  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  form.append("files[0]", new Blob([file.bytes]), file.name);
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bot ${token}` }, body: form, signal: AbortSignal.timeout(DEADLINE_MS) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Discord ${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/**
 * Edit one of our own messages: its embeds (possibly none — a message can be just a picture) and,
 * when a file is given, its attachment.
 *
 * Reports "gone" separately from "failed": a board whose message someone deleted must be re-posted
 * once, while a network blip must NOT be, or the channel fills with the duplicates the whole
 * single-message design exists to prevent.
 *
 * Passing `file` REPLACES the message's attachments; omitting it leaves them untouched, which is
 * how a board keeps a picture across edits that don't change it.
 */
export async function editMessage(token: string, channelId: string, messageId: string, embeds: Record<string, unknown>[], file?: EmbedFile | null): Promise<"ok" | "gone" | "failed"> {
  const path = `/channels/${channelId}/messages/${messageId}`;
  try {
    if (file) {
      await discordWithFile(token, "PATCH", path, { embeds, attachments: [{ id: 0, filename: file.name }] }, file);
    } else {
      await discord(token, "PATCH", path, { embeds });
    }
    return "ok";
  } catch (err) {
    // `discord()` puts the status in the message; 404 is the only one that means "post again".
    return /→ 404\b/.test((err as Error).message) ? "gone" : "failed";
  }
}

/**
 * Edit a plain-text message: replace its content and/or strip its buttons.
 *
 * The approvals card is the caller. When a request expires unanswered nobody re-renders it — the
 * sweep that expires it runs here, and how a request is worded belongs to the API — so the card
 * kept a live "✋ Approval request" with working Approve and Deny buttons on something that had
 * closed days earlier. The API stores the card's rendered text beside its message id; this puts
 * that text back with a closing line under it, and no components at all.
 */
export async function editText(token: string, channelId: string, messageId: string, content: string): Promise<"ok" | "gone" | "failed"> {
  try {
    await discord(token, "PATCH", `/channels/${channelId}/messages/${messageId}`, {
      content, components: [], allowed_mentions: { parse: [] },
    });
    return "ok";
  } catch (err) {
    return /→ 404\b/.test((err as Error).message) ? "gone" : "failed";
  }
}

/** Post a message (embeds and/or one attached file) and return its id, so it can be edited later. */
export async function postMessageTracked(token: string, channelId: string, embeds: Record<string, unknown>[], file?: EmbedFile | null): Promise<string | null> {
  try {
    const path = `/channels/${channelId}/messages`;
    const msg = (file
      ? await discordWithFile(token, "POST", path, { embeds }, file)
      : await discord(token, "POST", path, { embeds })) as { id?: string };
    return msg?.id ? String(msg.id) : null;
  } catch { return null; }
}

/** Best-effort: delete one of our own messages (taking the paused notice down on resume). */
export async function deleteMessage(token: string, channelId: string, messageId: string): Promise<void> {
  try { await discord(token, "DELETE", `/channels/${channelId}/messages/${messageId}`); } catch { /* best-effort */ }
}

// --- clearing a vote channel -------------------------------------------------------------------

/** Discord's own epoch (2015-01-01); a message id carries its timestamp in the high bits. */
const DISCORD_EPOCH_MS = 1_420_070_400_000;
/** Discord's page size for message history, and the most bulk-delete accepts at once. */
const MESSAGE_PAGE = 100;
/** How far back one sweep reads. Five pages clears a long backlog on the first run; after that
 *  there is nothing to find and the first page ends the walk. */
const SWEEP_MAX_PAGES = 5;
/**
 * Bulk delete refuses anything older than 14 days — and refuses the WHOLE batch when one member is
 * too old, so age has to be checked before asking. Half a day of margin covers clock skew.
 */
const BULK_MAX_AGE_MS = 13.5 * 24 * 60 * 60 * 1000;

/** When a message was posted, from its id alone — no extra request to date what we are deleting. */
const sentAtMs = (id: string): number => Number(BigInt(id) >> 22n) + DISCORD_EPOCH_MS;

/** Seconds Discord asked us to wait, or 0 when the refusal was not a rate limit. */
function retryAfterMs(err: unknown): number {
  if (!(err instanceof DiscordHttpError) || err.status !== 429) return 0;
  try {
    const after = Number((JSON.parse(err.body || "{}") as { retry_after?: number }).retry_after);
    return Math.min(5_000, Math.max(250, Math.ceil((Number.isFinite(after) ? after : 1) * 1000)));
  } catch { return 1_000; }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run a Discord call, waiting out a 429 the number of times Discord is worth waiting for.
 *
 * Only a rate limit is retried: a 403 or a 404 means asking again changes nothing, and a read that
 * keeps retrying a permanent refusal is a loop, not resilience. `retryAfterMs` already clamps the
 * wait, so the worst case here is a few seconds rather than however long Discord asked for.
 */
async function withRateLimitRetry<T>(call: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const wait = attempt < attempts ? retryAfterMs(err) : 0;
      if (!wait) throw err;
      await sleep(wait);
    }
  }
}

let cachedSelf: { token: string; id: string } | null = null;

/** This bot's own user id — the only thing that reliably separates our messages from everyone
 *  else's. Cached per token: it cannot change, and the sweep asks on every vote. */
export async function botUserId(token: string): Promise<string> {
  if (cachedSelf?.token === token) return cachedSelf.id;
  const me = (await discord(token, "GET", "/users/@me")) as { id?: string };
  if (!me?.id) throw new Error("Discord /users/@me returned no id");
  cachedSelf = { token, id: String(me.id) };
  return cachedSelf.id;
}

/** One at a time, honouring a rate limit once. Deleting your OWN message needs no permission
 *  beyond posting it, which is why this is the fallback when bulk delete is refused. */
/** Deletes one at a time, reporting how many went and — when Discord refused rather than the
 *  message simply being gone — the status it refused with. A silent refusal here is what let a
 *  channel fill up with spent ballots while every log line said the sweep had run. */
async function deleteEach(token: string, channelId: string, ids: string[]): Promise<{ gone: number; refused: number; status: number }> {
  let gone = 0, refused = 0, status = 0;
  for (const id of ids) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await discord(token, "DELETE", `/channels/${channelId}/messages/${id}`);
        gone++;
        break;
      } catch (err) {
        const wait = attempt === 0 ? retryAfterMs(err) : 0;
        if (!wait) {
          // 404 is "already gone", which is success by another name. Anything else is a refusal
          // the operator can act on, and the status is the whole diagnosis.
          const code = err instanceof DiscordHttpError ? err.status : 0;
          if (code !== 404) { refused++; status = status || code; }
          break; // a tidy-up must never stall the vote
        }
        await sleep(wait);
      }
    }
  }
  return { gone, refused, status };
}

/**
 * Which channels the on-open tidy must visit — normally just the current vote channel.
 *
 * When staff MOVE the vote to another channel between rounds, the previous ballot closed in the
 * old one, and a sweep that only ever looks at the current channel leaves the spent poll and
 * Discord's own "poll has closed" notice standing there forever. The state row parks the closing
 * channel (`lastClosedChannelId`) for exactly this moment — it was written on every close and
 * read by nothing. Both channels are visited, current first; a channel that never moved
 * collapses to one entry.
 */
export function channelsToSweep(current: string | null | undefined, lastClosed: string | null | undefined): string[] {
  const out: string[] = [];
  for (const id of [current, lastClosed]) if (id && !out.includes(id)) out.push(id);
  return out;
}

/**
 * Clear everything THIS BOT has left in a channel, except the messages named in `keep`.
 *
 * Deleting the spent ballot by id was never enough. Discord posts its own message when a poll
 * closes ("…'s poll has closed! The results were tied") — a separate message, of its own type,
 * that survives deleting the poll it describes — and any ballot whose id we lost (a worker restart
 * mid-round, a poll from before this app tracked them) stayed forever too. Both are ours, so both
 * are found by asking WHO POSTED IT rather than by remembering ids.
 *
 * Only our own messages: anything a person said in the channel is theirs, and a vote tidying up
 * after itself has no business touching it.
 *
 * Best-effort throughout — a channel that cannot be tidied is a cosmetic problem, and never a
 * reason to fail the vote that triggered it. But it must never be a SILENT problem: the result
 * separates "removed nothing because there was nothing" from "Discord refused", and carries the
 * status, because the two look identical in a channel and have completely different fixes.
 */
export async function sweepOwnMessages(token: string, channelId: string, keep: string[] = [], maxPages = SWEEP_MAX_PAGES): Promise<SweepResult> {
  const me = await botUserId(token);
  const spare = new Set(keep);
  const doomed: string[] = [];
  let before: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const q = `?limit=${MESSAGE_PAGE}${before ? `&before=${before}` : ""}`;
    const batch = (await discord(token, "GET", `/channels/${channelId}/messages${q}`)) as { id?: string; author?: { id?: string } }[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const m of batch) if (m?.id && m.author?.id === me && !spare.has(m.id)) doomed.push(m.id);
    if (batch.length < MESSAGE_PAGE) break; // reached the start of the channel
    before = String(batch[batch.length - 1]!.id);
  }
  if (!doomed.length) return { removed: 0, refused: 0, status: 0 };

  const now = Date.now();
  const fresh = doomed.filter((id) => now - sentAtMs(id) < BULK_MAX_AGE_MS);
  const old = doomed.filter((id) => now - sentAtMs(id) >= BULK_MAX_AGE_MS);
  let removed = 0, refused = 0, status = 0;
  const fold = (r: { gone: number; refused: number; status: number }) => {
    removed += r.gone; refused += r.refused; status = status || r.status;
  };

  for (let i = 0; i < fresh.length; i += MESSAGE_PAGE) {
    const chunk = fresh.slice(i, i + MESSAGE_PAGE);
    // Bulk delete takes 2..100 and needs Manage Messages; one-at-a-time needs neither. Try the
    // cheap call, fall back to the one that always works for our own posts.
    if (chunk.length < 2) { fold(await deleteEach(token, channelId, chunk)); continue; }
    try {
      await discord(token, "POST", `/channels/${channelId}/messages/bulk-delete`, { messages: chunk });
      removed += chunk.length;
    } catch { fold(await deleteEach(token, channelId, chunk)); }
  }
  fold(await deleteEach(token, channelId, old));
  return { removed, refused, status };
}


/** The "voting is paused" notice players see in place of the poll, so a missing vote reads as a
 *  deliberate pause rather than a broken bot. */
export function buildPausedEmbed(reason: "staff" | "empty", serverName: string): Record<string, unknown> {
  return {
    title: "⏸️ Map voting is paused",
    description: reason === "empty"
      ? "The server is quiet right now, so voting is on hold.\nIt starts again by itself once people are playing."
      : "Voting is on hold for the moment.\nA new vote will be posted here when it resumes.",
    footer: { text: serverName },
    color: 0xf0a500,
  };
}
