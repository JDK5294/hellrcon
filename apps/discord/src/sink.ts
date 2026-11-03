/**
 * Discord transport: posts a message to a channel via the Discord REST API using a bot token.
 * No gateway/websocket — the relay only sends, so plain REST is enough (and keeps this app
 * dependency-free). Inbound slash commands, which need the gateway, are a later increment.
 *
 * The bot must be a member of the guild with permission to post in the target channels.
 */
import type { Logger } from "@app/shared";
import type { MessageSink } from "./relay.js";

const API_BASE = "https://discord.com/api/v10";

/**
 * Discord's hard cap on message content. A post over it is rejected outright — the whole message,
 * not the tail.
 *
 * The relay already respects this by packing its lines at 1900, but ALERTS do not go through the
 * relay: they are built and handed straight to `sendAlert`, and they interpolate text nobody here
 * bounds — a watchlist reason, an automod rule's reason, the chat line behind an `!admin` request.
 * A long one therefore came back 400, got logged as "rejected message", and was dropped. That is
 * the worst thing to drop silently: an admin request and a watched player joining are the two
 * messages someone is waiting on.
 *
 * Capping HERE rather than in each builder makes it a property of the transport, so no future
 * caller can reintroduce it by taking a different path to the same API.
 */
const MAX_CONTENT = 2000;

export class DiscordRestSink implements MessageSink {
  /** Read at each post: the token is set in the panel and can change, or be removed, while the bot runs. */
  private readonly token: () => string;
  private readonly log: Logger;

  constructor(token: string | (() => string), log: Logger) {
    this.token = typeof token === "function" ? token : () => token;
    this.log = log;
  }

  async send(channelId: string, content: string): Promise<void> {
    await this.post(channelId, content, true);
  }

  /** Post an alert that MAY ping one role. Unlike send(), this allows exactly the given role id to be
   *  mentioned (nothing else — never @everyone/@here or arbitrary roles). */
  async sendAlert(channelId: string, text: string, mentionRoleId: string | null): Promise<void> {
    const content = mentionRoleId ? `<@&${mentionRoleId}> ${text}` : text;
    const allowed_mentions = mentionRoleId ? { parse: [], roles: [mentionRoleId] } : { parse: [] };
    await this.post(channelId, content, true, allowed_mentions);
  }

  private async post(channelId: string, content: string, allowRetry: boolean, allowedMentions: unknown = { parse: [] }): Promise<void> {
    // Removed in the panel: Discord is switched off, so nothing is sent rather than refused.
    const token = this.token();
    if (!token) return;
    if (content.length > MAX_CONTENT) {
      // The head is the part that matters — the mention, the headline and the player — so the
      // tail is what goes. Said out loud, because something a person wrote has been cut.
      this.log.warn("discord message truncated to fit the 2000-character cap", { channelId, length: content.length });
      content = content.slice(0, MAX_CONTENT - 1) + "…";
    }
    const res = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
      // allowed_mentions parse:[] means relayed chat/names can never ping @everyone/@here or roles.
      body: JSON.stringify({ content, allowed_mentions: allowedMentions }),
      // A hard deadline, same reason as the worker's Discord client: these sends are awaited in
      // the relay loop, and a hung socket without one stalls every queued message for minutes.
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return;

    if (res.status === 429 && allowRetry) {
      const retryMs = await retryAfterMs(res);
      this.log.warn("discord rate-limited, retrying", { channelId, retryMs });
      await new Promise((r) => setTimeout(r, retryMs));
      return this.post(channelId, content, false, allowedMentions);
    }
    const detail = await res.text().catch(() => "");
    this.log.warn("discord API rejected message", { channelId, status: res.status, detail: detail.slice(0, 200) });
  }
}

async function retryAfterMs(res: Response): Promise<number> {
  const header = res.headers.get("retry-after");
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs)) return Math.min(secs * 1000, 10_000);
  }
  const bodyMs = await res
    .clone()
    .json()
    .then((b) => (typeof (b as { retry_after?: number }).retry_after === "number" ? (b as { retry_after: number }).retry_after * 1000 : 1000))
    .catch(() => 1000);
  return Math.min(bodyMs, 10_000);
}
