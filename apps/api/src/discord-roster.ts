/**
 * ONE ANSWER TO "WHAT ROLES DOES THIS PERSON HOLD" — cached, shared, and fetched once.
 *
 * Discord's rate limits cannot be raised. They are per bot token, there is no paid tier, and
 * spreading load across several tokens is API abuse that gets the application banned. So the only
 * lever is to ASK LESS, and the way to ask less is to stop asking per person.
 *
 * Every role question in the app used to be its own request: the payout preview asked once per
 * candidate, the role sweep once per staff member every five minutes, a badge once per player
 * seen. They all carry the same route key, so the shared limiter — correctly — runs them one at a
 * time in a single bucket. Forty staff is forty requests every sweep, forever, to learn something
 * that one member-list request answers in full.
 *
 * This holds that list. One fetch serves every caller until it goes stale, so the cost stops
 * scaling with how many people are asked about and starts scaling with the refresh interval —
 * which is a number we choose.
 *
 * ## What this is not
 *
 * It is not a way around the limits, and it must not become one. It is fewer requests for the same
 * answers. The limiter underneath is still the only thing pacing the wire, and a cache miss still
 * queues behind everything else.
 *
 * ## Staleness is the trade, and it is bounded
 *
 * A role granted in Discord is visible here within TTL_MS rather than instantly. That is the right
 * trade for badges, payouts and sweeps — all of which were already reading a value that could be
 * minutes old — but it is the WRONG trade for anything that decides access on the spot. Callers
 * that must not be stale pass `maxAgeMs: 0`, which forces a fresh read.
 *
 * ## A failed refresh serves the roster in hand, briefly
 *
 * The refresh most likely to fail is the one that fires while Discord is rate-limiting or flaky —
 * and answering it with a failure sent every caller down the per-person fallback: a badge sweep
 * over fifty players became fifty lookups against the API that was already struggling, and a large
 * payout preview refused outright, all while a roster from a minute ago sat unused in the cache.
 * That is the amplification this file exists to prevent, triggered at the worst possible moment.
 * So a caller that tolerates staleness at all (`maxAgeMs > 0`) is handed the last good roster when
 * a refresh fails, up to STALE_MAX_MS old; past that ceiling — or for forced-fresh callers, or for
 * a guild that has never listed successfully (the misconfiguration cases, whose failure carries
 * the advice) — the failure propagates exactly as before.
 */
import { guildMembers, guildMember } from "./discord-guild.js";
import { createLogger } from "@app/shared";

const log = createLogger("discord-roster");

/** How long a fetched roster is served before it is refetched. */
const TTL_MS = Number(process.env.DISCORD_ROSTER_TTL_MS ?? 60_000);
/**
 * After a failed read, wait this long before trying the whole list again.
 *
 * Without it, a guild that cannot be listed (the Server Members intent off, or one too large to
 * page) would re-attempt the full walk on every single lookup — turning a cache into an amplifier,
 * which is the opposite of the point.
 */
const FAILURE_BACKOFF_MS = 30_000;
/**
 * How old a roster may be and still stand in for a FAILED refresh.
 *
 * The trade is a bounded one: someone who joined the guild inside this window reads as "not in
 * the guild" (an empty set) instead of "unknown" while Discord is down — the same reading anyone
 * gets inside the ordinary TTL, just for longer, and only during an outage. The ceiling is what
 * keeps that honest: past it the failure propagates, so a guild that stays unreadable degrades to
 * the per-person fallback rather than serving last week's roles forever.
 */
const STALE_MAX_MS = Number(process.env.DISCORD_ROSTER_STALE_MAX_MS ?? 10 * 60_000);

/**
 * The same three outcomes `guildMembers` reports, with the list already indexed. The failure cases
 * are carried through rather than flattened to null because callers give different advice for
 * each — a refused list is a setting to change, a guild too large to page is a request to narrow.
 */
export type Roster =
  | { kind: "roster"; byUser: Map<string, string[]>; fetchedAt: number }
  | { kind: "tooLarge"; seen: number }
  | { kind: "unavailable"; reason: string };

/**
 * Everything here is keyed by guild, because a community runs TWO: the staff server that decides
 * who may sign in, and the public one the VIP panel lives in. A single slot for any of these is a
 * bug rather than a simplification — a lone cache entry thrashes when the two alternate (every
 * lookup evicting the other, so the cache never hits and each miss walks a whole guild), and a
 * lone in-flight promise is worse still: a caller asking about the public server while the staff
 * server is mid-fetch would be handed the staff server's roster and believe it.
 */
type LoadedRoster = Roster & { kind: "roster" };
const cached = new Map<string, LoadedRoster>();
/** In-flight fetches per guild. Concurrent callers for the SAME guild await one request — a payout
 *  preview and a badge sweep arriving together must be one, not two. */
const inflight = new Map<string, Promise<Roster>>();
/**
 * The last failure PER GUILD, replayed during its backoff so the reason survives instead of
 * becoming a blank "could not read" the second time anybody asks.
 *
 * Keyed by guild because a community runs two of them — the staff server and the public one — and
 * an unkeyed backoff replayed whichever failed most recently for whichever was next asked about.
 * That reports the wrong cause for the wrong server, which is worse than no cache at all.
 */
const failures = new Map<string, { failure: Roster; until: number }>();

/** Tests, and anything that changes which guild is configured. */
export function resetRoster(): void {
  cached.clear();
  inflight.clear();
  failures.clear();
}

/** Strictly younger than `maxAgeMs`, so that `maxAgeMs: 0` really does mean "fetch a fresh one".
 *  With `<=`, a roster read in the same millisecond satisfied an age of zero and the forced-fresh
 *  caller silently got the stale answer it had just asked not to have. */
const fresh = (e: LoadedRoster | undefined, maxAgeMs: number): e is LoadedRoster =>
  !!e && Date.now() - e.fetchedAt < maxAgeMs;

/**
 * The roster to serve INSTEAD of a failure, or null when the failure must stand: the caller asked
 * for a fresh read (`maxAgeMs: 0` — an access decision must never act on an outage-old answer),
 * or nothing usable is in hand (never listed, or older than STALE_MAX_MS).
 */
const lastGoodRoster = (guildId: string, maxAgeMs: number): LoadedRoster | null => {
  if (maxAgeMs <= 0) return null;
  const have = cached.get(guildId);
  return have && Date.now() - have.fetchedAt < STALE_MAX_MS ? have : null;
};

/**
 * The whole guild as user id → role ids.
 *
 * Anything but `roster` means "could not find out", never "holds nothing". A caller that read a
 * failure as an empty guild would drop everybody out of whatever it was gating.
 */
export async function guildRoster(guildId: string, opts: { maxAgeMs?: number } = {}): Promise<Roster> {
  if (!guildId) return { kind: "unavailable", reason: "no Discord server is configured" };
  const maxAgeMs = opts.maxAgeMs ?? TTL_MS;
  const have = cached.get(guildId);
  if (fresh(have, maxAgeMs)) return have;
  // A forced-fresh caller still joins THIS GUILD's in-flight read: it started at most moments ago,
  // so it is as fresh as anything this caller would have fetched for itself.
  const already = inflight.get(guildId);
  if (already) {
    const got = await already;
    return got.kind === "roster" ? got : lastGoodRoster(guildId, maxAgeMs) ?? got;
  }
  const failed = failures.get(guildId);
  if (failed && Date.now() < failed.until) return lastGoodRoster(guildId, maxAgeMs) ?? failed.failure;

  const run = (async (): Promise<Roster> => {
    const r = await guildMembers(guildId);
    if (r.kind !== "list") {
      const failure: Roster = r.kind === "tooLarge" ? { kind: "tooLarge", seen: r.seen } : { kind: "unavailable", reason: r.reason };
      failures.set(guildId, { failure, until: Date.now() + FAILURE_BACKOFF_MS });
      log.warn("could not read the guild member list — serving the last good roster where callers allow it, else per-person lookups", {
        guildId, why: r.kind === "tooLarge" ? `more than ${r.seen} members` : r.reason,
      });
      return failure;
    }
    failures.delete(guildId);
    return { kind: "roster", byUser: new Map(r.members.map((m) => [m.userId, m.roleIds])), fetchedAt: Date.now() };
  })();
  inflight.set(guildId, run);

  try {
    const got = await run;
    if (got.kind === "roster") {
      cached.set(guildId, got);
      return got;
    }
    return lastGoodRoster(guildId, maxAgeMs) ?? got;
  } finally {
    inflight.delete(guildId);
  }
}

/**
 * One person's roles: from the roster when it can be had, from a single lookup when it cannot.
 *
 * The fallback is what keeps a guild too large to page — or one whose list is refused — working
 * exactly as it did before this file existed, one request at a time.
 */
export async function memberRoles(guildId: string, discordId: string, opts: { maxAgeMs?: number } = {}): Promise<string[] | null> {
  if (!guildId || !discordId) return null;
  const roster = await guildRoster(guildId, opts);
  // Present means these roles; ABSENT from a complete list means not in the guild, which is an
  // empty set rather than an unknown — the same reading the payout preview relies on.
  if (roster.kind === "roster") return roster.byUser.get(discordId) ?? [];
  const m = await guildMember(guildId, discordId);
  return m.kind === "member" ? m.roleIds : m.kind === "notInGuild" ? [] : null;
}
