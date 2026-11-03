/**
 * EVERY member of a guild and their roles, in pages of a thousand.
 *
 * Lives in shared because BOTH processes need it: the API (payout previews, badges, the roster
 * cache) and the worker's staff-role sweep. Asking per person is one Discord round trip each, and
 * they all carry the same route key — so the limiter next door puts them in one bucket and runs
 * them one at a time, pausing whenever the window empties. Forty staff is forty requests every
 * sweep, forever, to learn what a single member-list request answers in full.
 *
 * Needs the SERVER MEMBERS privileged intent.
 */
import { discordRest } from "./discord-rest.js";

const API = "https://discord.com/api/v10";

export interface GuildMemberLite {
  userId: string;
  /** The resolved display name — nickname, else global name, else handle. */
  name: string;
  /**
   * The two names kept APART, because they are not interchangeable and one caller stores both.
   * The staff-role sweep writes `username` to the stored @handle and `nick` to the nickname;
   * handing it the resolved display name for both would rewrite everybody's handle to their
   * nickname on the first pass.
   */
  username: string | null;
  nick: string | null;
  roleIds: string[];
}

/**
 * Three outcomes, for the same reason `guildMember` has three: the caller has to tell them apart
 * to say anything useful. "The list was refused" and "this server is bigger than we page through"
 * lead to opposite advice, and collapsing them into one null had the payout telling people to
 * switch on an intent that was already on.
 */
export type GuildMemberList =
  | { kind: "list"; members: GuildMemberLite[] }
  | { kind: "tooLarge"; seen: number }
  | { kind: "unavailable"; reason: string };

const MEMBER_PAGE = 1000;
/**
 * Twenty-five pages — twenty-five thousand members.
 *
 * A ceiling has to exist: an unbounded loop against a paging endpoint is how one preview spends
 * the whole rate limit. It sits here because a page is a thousand people, so this covers every
 * community that is not enormous, and the ones past it get told so plainly rather than being
 * handed a wrong diagnosis.
 */
const MAX_MEMBER_PAGES = 25;

/**
 * `token` overrides DISCORD_TOKEN. The worker's sweep is handed its token explicitly rather than
 * reading the environment, and silently falling back to env made this work in production and fail
 * anywhere the two were not the same value.
 */
export async function guildMembers(guildId: string, fetchImpl: typeof fetch = fetch, tokenOverride?: string): Promise<GuildMemberList> {
  const token = tokenOverride ?? process.env.DISCORD_TOKEN;
  if (!token) return { kind: "unavailable", reason: "no bot token is set (Discord → Setup & status)" };
  if (!guildId) return { kind: "unavailable", reason: "no Discord server is configured" };
  const out: GuildMemberLite[] = [];
  let after = "0";
  try {
    for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
      const path = `/guilds/${guildId}/members?limit=${MEMBER_PAGE}&after=${after}`;
      const r = fetchImpl === fetch
        ? await discordRest().request({ routeKey: `GET /guilds/${guildId}/members/list`, path })
        : await fetchImpl(`${API}${path}`, { headers: { authorization: `Bot ${token}` } });
      if (!r.ok) {
        // 403 here is almost always the privileged intent rather than a channel permission, and
        // saying which knob to turn is the difference between a fixable error and a mystery.
        const hint = r.status === 403
          ? " — is the SERVER MEMBERS INTENT switched on for the bot? (Discord Developer Portal → your app → Bot → Privileged Gateway Intents)"
          : "";
        return { kind: "unavailable", reason: `Discord returned ${r.status}${hint}` };
      }
      const rows = (await r.json()) as { user?: { id?: unknown; username?: unknown; global_name?: unknown }; nick?: unknown; roles?: unknown }[];
      if (!Array.isArray(rows)) return { kind: "unavailable", reason: "Discord's answer was not a member list" };
      // The cursor comes from the page AS RECEIVED, not from the rows we kept. Discord pages by
      // ascending user id over what it sent, so taking the id off the filtered list would restart
      // the next page behind any trailing row we skipped — refetching members forever, or, if a
      // whole page were unusable, reading an id off an empty array.
      let lastId = "";
      for (const m of rows) {
        const userId = String(m.user?.id ?? "");
        if (!userId) continue;
        lastId = userId;
        const username = m.user?.username == null ? null : String(m.user.username);
        const nick = m.nick ? String(m.nick) : m.user?.global_name ? String(m.user.global_name) : null;
        out.push({
          userId,
          name: nick || username || userId,
          username,
          nick,
          roleIds: Array.isArray(m.roles) ? m.roles.map(String) : [],
        });
      }
      if (rows.length < MEMBER_PAGE) return { kind: "list", members: out }; // the last page is a short one
      // A full page that advanced nothing cannot be paged past; treating it as the whole guild
      // would be the truncation this function exists to refuse.
      if (!lastId) return { kind: "unavailable", reason: "a page of members arrived with no readable ids" };
      after = lastId;
    }
    // Hit the ceiling with a full page in hand: there are more, so this list is not the whole
    // guild and must not be read as one.
    return { kind: "tooLarge", seen: out.length };
  } catch (err) {
    return { kind: "unavailable", reason: (err as Error).message };
  }
}

