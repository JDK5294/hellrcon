/**
 * Vote-surface abstraction: how a composed poll is presented and how its votes come back. The vote
 * engine (buildPoll) and the winner→apply placement don't care which surface is used — they just
 * open a vote, read a tally, and close it. This is the seam that lets the "basic native poll" ship
 * now while a richer custom-embed surface is added later behind the same interface.
 */
import { buildVoteAnnouncement, parseVoteBallot, type PollOption } from "@app/maps";
import type { MapVoteIngameVoter } from "@app/db";
import { createPoll, getPollCounts, expirePoll, getAnswerVoters, type PollVoter } from "./discord-poll.js";

export interface VoteHandle { messageId: string; channelId: string }

/** A counted in-game ballot as the fold keys it: the name typed under, and our player record id
 *  (or "name:<name>" where the log gave no id). */
export interface IngameBallotVoter { name: string; key: string }

export interface VoteSurface {
  readonly kind: string;
  /** open a vote for these options; returns a handle to read/close it. */
  open(question: string, options: PollOption[]): Promise<VoteHandle>;
  /** current counts, indexed to match the options order. */
  tally(handle: VoteHandle, optionCount: number): Promise<number[]>;
  /** finalize the vote and return the final counts. */
  close(handle: VoteHandle, optionCount: number): Promise<number[]>;
  /** who voted for each option, indexed to match the options order. Read once when a vote ends —
   *  it costs one request per option, so it is never part of the polling loop. A surface that
   *  cannot identify voters returns empty lists rather than failing. */
  voters(handle: VoteHandle, optionCount: number): Promise<PollVoter[][]>;
  /** The live counts with the in-game ballot's counted voters beside them, off the one chat read
   *  the counts already cost — for a surface with an in-game half. `ingame` is null when there is
   *  none, or it could not be read this time (which is not the same as nobody voting). */
  tallyWithVoters?(handle: VoteHandle, optionCount: number): Promise<{ counts: number[]; ingame: IngameBallotVoter[][] | null }>;
}

/**
 * The in-game ballot's voters as the public vote_status lists them, CRCON-style: per option, the
 * oldest standing ballot first (the fold reads newest first; CRCON's own list runs in the order
 * players voted), each under the name typed with it and the game's own player id, resolved from
 * our record id in one read. A ballot matched by name only has no id to give.
 */
export async function listIngameVoters(
  ingame: IngameBallotVoter[][],
  platformIds: (recordIds: string[]) => Promise<Map<string, string>>,
): Promise<MapVoteIngameVoter[][]> {
  const byName = (key: string) => key.startsWith("name:");
  const recordIds = [...new Set(ingame.flat().map((v) => v.key).filter((k) => !byName(k)))];
  const ids = recordIds.length ? await platformIds(recordIds) : new Map<string, string>();
  return ingame.map((list) => [...list].reverse().map((v) => ({ name: v.name, playerId: byName(v.key) ? null : ids.get(v.key) ?? null })));
}

/** The basic surface: a Discord native poll over REST (no gateway). */
export class NativeDiscordPoll implements VoteSurface {
  readonly kind = "native";
  constructor(private token: string, private channelId: string, private pollHours: number) {}

  async open(question: string, options: PollOption[]): Promise<VoteHandle> {
    const { messageId } = await createPoll(this.token, this.channelId, question, options.map((o) => o.name), this.pollHours);
    return { messageId, channelId: this.channelId };
  }
  /*
   * The stored id is not always a raw snowflake: the surface is rebuilt from config every tick,
   * so switching "Both" → "Discord only" mid-vote hands this surface a combined handle
   * ("<snowflake>|ingame:<iso>"). Sent to the wire verbatim, every read 404s — the tally froze at
   * its last parked value, close couldn't expire the poll, and the winner was picked from stale
   * counts. Reading our own half keeps the live Discord poll counting across the switch; a handle
   * with NO Discord half (switched from "In-game only") truthfully has no poll and no voters.
   */
  private wireId(handle: VoteHandle): string | null {
    return discordMessageIdOf(handle.messageId);
  }
  tally(handle: VoteHandle, optionCount: number): Promise<number[]> {
    const id = this.wireId(handle);
    if (!id) return Promise.resolve(Array.from({ length: optionCount }, () => 0));
    return getPollCounts(this.token, handle.channelId, id, optionCount);
  }
  async close(handle: VoteHandle, optionCount: number): Promise<number[]> {
    const id = this.wireId(handle);
    if (!id) return Array.from({ length: optionCount }, () => 0);
    await expirePoll(this.token, handle.channelId, id).catch(() => {});
    return getPollCounts(this.token, handle.channelId, id, optionCount);
  }
  async voters(handle: VoteHandle, optionCount: number): Promise<PollVoter[][]> {
    const id = this.wireId(handle);
    if (!id) return Array.from({ length: optionCount }, () => []);
    const out: PollVoter[][] = [];
    for (let i = 0; i < optionCount; i++) {
      // Answer ids are 1-based in the order the answers were added, which is our option order.
      //
      // A failure here is NOT an empty answer, and swallowing it into one is how an option's
      // Discord voters became zero votes in a merged result that was then announced as the count.
      // It throws, so the caller can tell "nobody picked this" from "we could not read it" and
      // fall back to the poll's own numbers.
      out.push(await getAnswerVoters(this.token, handle.channelId, id, i + 1));
    }
    return out;
  }
}

/**
 * Remember an async lookup's answer for a while, keyed by its argument.
 *
 * Both registration lookups below are read on EVERY tally — once per distinct voter, every poll
 * tick, for the life of a vote — and a Discord link is not something that changes between two
 * reads thirty seconds apart. Without this, a forty-voter in-game ballot cost forty round trips a
 * tick per server, all of them re-asking a question already answered.
 *
 * The TTL is what keeps it honest: a player who links their Discord mid-vote starts counting once
 * it lapses, rather than being locked out until the worker restarts. Failures are NOT cached — a
 * database hiccup must not decide a ballot for the next five minutes — and an in-flight lookup is
 * shared, so the first tally of a busy vote issues one query per voter rather than one per caller.
 */
export function ttlMemo<T>(fn: (key: string) => Promise<T>, ttlMs: number, now: () => number = Date.now): (key: string) => Promise<T> {
  const hits = new Map<string, { at: number; value: T }>();
  const inflight = new Map<string, Promise<T>>();
  return async (key: string) => {
    const hit = hits.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const running = inflight.get(key);
    if (running) return running;
    const p = fn(key).then(
      (value) => { hits.set(key, { at: now(), value }); inflight.delete(key); return value; },
      (err) => { inflight.delete(key); throw err; },
    );
    inflight.set(key, p);
    return p;
  };
}

/** The slice of a chat event a ballot fold reads. */
export interface ChatBallotEvent { ts: string; actorPlayerId?: string | null; actorName?: string | null; data?: Record<string, unknown> | null }

/**
 * Fold chat lines into ballots: one vote per player, their NEWEST numeric line wins.
 *
 * `events` arrive newest first — that is the repo's paged order — so the first parseable line
 * seen for a player is their standing vote and everything older from them is ignored. A line
 * that is anything more than a number is conversation, not a ballot ("3 tanks on E5" votes for
 * nothing), and a number outside 1..optionCount is a typo, not a vote for the nearest map.
 * Players are keyed by id where the log gave one, by name otherwise (console players whose id
 * the parser missed still get their vote).
 *
 * What COUNTS as a ballot-shaped line is `parseVoteBallot` (@app/maps) — the same definition the
 * rules engine uses to keep chat rules from punishing these lines, so the two can never fork.
 */
export function foldChatBallots(eventsNewestFirst: ChatBallotEvent[], optionCount: number): { counts: number[]; voters: { name: string; key: string }[][] } {
  const counts = Array.from({ length: optionCount }, () => 0);
  const voters: { name: string; key: string }[][] = Array.from({ length: optionCount }, () => []);
  const seen = new Set<string>();
  for (const e of eventsNewestFirst) {
    const msg = typeof e.data?.message === "string" ? e.data.message : "";
    const n = parseVoteBallot(msg);
    if (n === null || n < 1 || n > optionCount) continue;
    const key = e.actorPlayerId || `name:${(e.actorName ?? "").toLowerCase()}`;
    if (!key || key === "name:" || seen.has(key)) continue;
    seen.add(key);
    counts[n - 1]! += 1;
    voters[n - 1]!.push({ name: e.actorName?.trim() || "?", key });
  }
  return { counts, voters };
}

const INGAME_HANDLE_PREFIX = "ingame:";

/**
 * Both halves of a STORED vote message id, in one place.
 *
 * The state row's `activeMessageId` is not always a Discord message id: a combined vote stores
 * both halves as "<discordId>|ingame:<iso>", and a pure in-game vote stores an id Discord has
 * never heard of. The combined surface routes on this split, and so must anything OUTSIDE the
 * surfaces that compares the stored id against what Discord's REST API returns — a single-surface
 * id from before a config change routes to its own half, exactly as before.
 */
function splitVoteMessageId(messageId: string): { discord: string | null; ingame: string | null } {
  const i = messageId.indexOf("|");
  if (i >= 0) return { discord: messageId.slice(0, i) || null, ingame: messageId.slice(i + 1) || null };
  if (messageId.startsWith(INGAME_HANDLE_PREFIX)) return { discord: null, ingame: messageId };
  return { discord: messageId || null, ingame: null };
}

/**
 * The id DISCORD knows for a stored vote message id — or null when there is no Discord half.
 *
 * This exists because the channel sweep learned the hard way: it keeps a message only when its
 * RAW snowflake is in the keep list, and it was handed the stored id verbatim. On a combined vote
 * that id is "<discordId>|ingame:<iso>", which matches nothing Discord returns — so the sweep,
 * asked to clear the spent ballot while sparing the new one, deleted them both. Anything that
 * hands a stored vote id back to Discord's wire goes through here.
 */
export function discordMessageIdOf(messageId: string | null | undefined): string | null {
  return messageId ? splitVoteMessageId(messageId).discord : null;
}

/** The slice of ANOTHER server's vote config+state the shared-channel spare list reads. */
export interface SiblingVoteState {
  serverId: string;
  activeMessageId: string | null;
  activeChannelId: string | null;
  configChannelId: string | null;
  pauseNoticeId: string | null;
}

/**
 * What OTHER servers' votes still need in a channel this sweep is about to clear.
 *
 * Nothing stops two servers from pointing their map votes at the same Discord channel — and the
 * tidy sweep works BY AUTHOR (everything this bot posted goes), sparing only the sweeping
 * server's own new ballot. Shared, that meant server A's open deleted server B's LIVE ballot,
 * and B's next open returned the favour: every round, each vote erased the other. The spare
 * list now names every sibling's live ballot (the Discord half of its stored handle — a pure
 * in-game vote has nothing in the channel to spare) and its standing pause notice, so sharing
 * a channel degrades to shared tidiness instead of mutual destruction.
 */
export function spareForSiblingVotes(targetChannelId: string, selfServerId: string, siblings: SiblingVoteState[]): string[] {
  const keep: string[] = [];
  for (const s of siblings) {
    if (s.serverId === selfServerId) continue;
    // The ballot lives where it was POSTED (the state's channel), which survives a config move;
    // only a state row from before channels were tracked falls back to the config.
    if (s.activeMessageId && (s.activeChannelId ?? s.configChannelId) === targetChannelId) {
      const id = discordMessageIdOf(s.activeMessageId);
      if (id) keep.push(id);
    }
    if (s.pauseNoticeId && s.configChannelId === targetChannelId) keep.push(s.pauseNoticeId);
  }
  return keep;
}
/** The repo pages at 500; a match's chat can be longer. 8 pages = 4000 lines of chat scanned per
 *  tally, which covers hours of a full server — votes older than that on a still-noisier server
 *  age out, which beats an unbounded scan every tick. */
const INGAME_PAGE = 500;
const INGAME_MAX_PAGES = 8;

/**
 * The IN-GAME surface: players vote by typing the option's number in team or unit chat — the
 * shape CRCON's votemap made standard, and the one that reaches console players who never open
 * Discord. Deliberately stateless: the ballot is DERIVED from the stored chat events since the
 * vote opened (the handle carries the open time), so a worker restart mid-vote loses nothing and
 * this object can be rebuilt every tick like the Discord one is.
 *
 * open() announces the numbered list as a broadcast, best-effort — the configured reminders are
 * the reliable channel (they message every player individually, numbered the same way), and a
 * vote that failed to announce is still a vote the next reminder explains.
 */
export class InGameChatVote implements VoteSurface {
  readonly kind = "ingame";
  constructor(private readonly opts: {
    serverId: string;
    /** repo.events.query, narrowed — newest first, paged. */
    query: (q: { serverId: string; kinds: string[]; from: string; limit: number; offset: number }) => Promise<ChatBallotEvent[]>;
    /** the in-game broadcast (already observe-guarded by the client it wraps). */
    announce: (message: string) => Promise<void>;
    /** Count only REGISTERED voters: a ballot needs a Discord link to count, and carries that
     *  Discord id as its identity — which is what lets the combined surface collapse one person's
     *  in-game and Discord ballots into a single vote. */
    registeredOnly?: boolean;
    /** playerId → linked Discord id (null when unlinked). Only consulted for id-keyed voters. */
    linkOf?: (playerId: string) => Promise<string | null>;
    log?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  }) {}

  async open(question: string, options: PollOption[]): Promise<VoteHandle> {
    const message = buildVoteAnnouncement({
      header: `${question} — type the map's NUMBER in chat:`,
      layout: "map_list", options, numbered: true,
    });
    try { await this.opts.announce(message); }
    catch (err) { this.opts.log?.warn("in-game vote open announcement failed — reminders will carry it", { err: (err as Error).message }); }
    return { messageId: `${INGAME_HANDLE_PREFIX}${new Date().toISOString()}`, channelId: "ingame" };
  }

  private async ballots(handle: VoteHandle, optionCount: number) {
    // Read OUR half of whatever id is stored: a combined vote's handle carries the in-game open
    // time after the "|", so switching "Both" → "In-game only" mid-vote keeps counting the chat
    // ballots players already cast (they voted on THIS surface; the config change didn't). A
    // handle with no in-game half at all — a raw Discord snowflake from a "Discord only" era —
    // has no open time to bound the scan, and counting the newest few thousand chat lines against
    // it would invent a tally out of old conversation. Zero ballots is the honest answer there;
    // the vote closes empty and the next one opens on this surface.
    const own = splitVoteMessageId(handle.messageId).ingame;
    if (!own?.startsWith(INGAME_HANDLE_PREFIX)) {
      return {
        counts: Array.from({ length: optionCount }, () => 0),
        voters: Array.from({ length: optionCount }, () => [] as { name: string; key: string; discordId: string | null }[]),
      };
    }
    const from = own.slice(INGAME_HANDLE_PREFIX.length);
    const all: ChatBallotEvent[] = [];
    for (let page = 0; page < INGAME_MAX_PAGES; page++) {
      const rows = await this.opts.query({
        serverId: this.opts.serverId, kinds: ["evt.chat.team", "evt.chat.squad"],
        from, limit: INGAME_PAGE, offset: page * INGAME_PAGE,
      });
      all.push(...rows);
      if (rows.length < INGAME_PAGE) break;
    }
    const folded = foldChatBallots(all, optionCount);
    // Attach each voter's Discord identity where a link exists. With registeredOnly on, a ballot
    // WITHOUT one does not count — the whole point is that every counted vote maps to a single
    // registered person — so the counts are refigured from the voters who survive.
    const links = new Map<string, string | null>();
    const resolve = async (key: string): Promise<string | null> => {
      if (key.startsWith("name:") || !this.opts.linkOf) return null;
      if (!links.has(key)) links.set(key, await this.opts.linkOf(key).catch(() => null));
      return links.get(key) ?? null;
    };
    const voters: { name: string; key: string; discordId: string | null }[][] = [];
    const counts = Array.from({ length: optionCount }, () => 0);
    for (let i = 0; i < optionCount; i++) {
      const kept: { name: string; key: string; discordId: string | null }[] = [];
      for (const v of folded.voters[i] ?? []) {
        const discordId = await resolve(v.key);
        if (this.opts.registeredOnly && !discordId) continue;
        kept.push({ ...v, discordId });
      }
      voters.push(kept);
      counts[i] = kept.length;
    }
    return { counts, voters };
  }

  async tally(handle: VoteHandle, optionCount: number): Promise<number[]> {
    return (await this.ballots(handle, optionCount)).counts;
  }
  async tallyWithVoters(handle: VoteHandle, optionCount: number): Promise<{ counts: number[]; ingame: IngameBallotVoter[][] }> {
    const { counts, voters } = await this.ballots(handle, optionCount);
    return { counts, ingame: voters.map((list) => list.map((v) => ({ name: v.name, key: v.key }))) };
  }
  /** Nothing to take down in game — closing is just the final read. */
  async close(handle: VoteHandle, optionCount: number): Promise<number[]> {
    return this.tally(handle, optionCount);
  }
  async voters(handle: VoteHandle, optionCount: number): Promise<PollVoter[][]> {
    const { voters } = await this.ballots(handle, optionCount);
    // A linked voter is recorded under their REAL Discord id, so the leaderboard's joins land and
    // one person's in-game and Discord ballots share an identity. An unlinked one gets a synthetic
    // "player:" id, NOT an empty one: both stores drop id-less voters when they flatten the ballot,
    // so an empty id erased them from who-voted-what entirely; under the prefix the Discord joins
    // simply miss (LEFT JOINs) and the in-game name renders from the ballot row itself.
    return voters.map((list) => list.map((v) => ({ discordId: v.discordId ?? `player:${v.key}`, name: v.name })));
  }
}

/**
 * Merge the two surfaces' ballots into one result — the pure heart of "Discord AND in game at
 * the same time". Identity is the Discord id: an in-game voter who is linked carries their real
 * one, an unlinked one carries a synthetic "player:" id that can never collide with Discord's.
 *
 *  - One vote per identity. A person who voted in game AND on the poll counts ONCE, and the
 *    DISCORD ballot wins the conflict — the poll is the deliberate, visible act, and Discord
 *    cannot say WHEN a click landed, so "Discord stands, chat fills in" is the one rule that
 *    never needs a timestamp it cannot have.
 *  - The registered-only gates are PER SURFACE, because the postures differ: `registeredDiscord`
 *    (a set) discounts Discord clicks outside it, `registeredIngameOnly` drops in-game voters
 *    with no link ("player:" ids). Either may be off — a LINKED voter is deduped regardless,
 *    because their in-game ballot already carries their real Discord id.
 */
export function mergeBallots(input: {
  optionCount: number;
  /** per-option Discord voters (real Discord ids). */
  discord: PollVoter[][];
  /** per-option in-game voters (linked Discord id, or "player:<key>"). */
  ingame: PollVoter[][];
  /** Discord ids allowed to count on the DISCORD half; null = every click counts. */
  registeredDiscord: Set<string> | null;
  /** Drop in-game voters with no link. (The in-game surface also filters at source; this keeps
   *  the merge correct on its own.) */
  registeredIngameOnly: boolean;
}): { counts: number[]; voters: PollVoter[][] } {
  const counts = Array.from({ length: input.optionCount }, () => 0);
  const voters: PollVoter[][] = Array.from({ length: input.optionCount }, () => []);
  const seen = new Set<string>();
  const take = (i: number, v: PollVoter) => {
    if (!v.discordId || seen.has(v.discordId)) return;
    seen.add(v.discordId);
    counts[i]! += 1;
    voters[i]!.push(v);
  };
  // Discord first, so a dual voter's in-game line lands on an already-seen identity.
  for (let i = 0; i < input.optionCount; i++) {
    for (const v of input.discord[i] ?? []) {
      if (input.registeredDiscord && !input.registeredDiscord.has(v.discordId)) continue;
      take(i, v);
    }
  }
  for (let i = 0; i < input.optionCount; i++) {
    for (const v of input.ingame[i] ?? []) {
      if (input.registeredIngameOnly && v.discordId.startsWith("player:")) continue;
      take(i, v);
    }
  }
  return { counts, voters };
}

/**
 * Both surfaces at once: the Discord poll AND in-game chat numbers, combined for the final score.
 *
 * The handle carries both halves ("<discordMessageId>|ingame:<iso>"); a handle minted by a SINGLE
 * surface before the config changed routes to the half that understands it, so a mid-vote switch
 * keeps counting what it can instead of inventing or dropping everything.
 *
 * Live tallies are the raw SUM of the halves — cheap, and honest enough to track the leader. The
 * CLOSE is exact: it reads both voter lists and merges them (one vote per identity, Discord wins,
 * registered-only applied), because Discord can only say who voted per option, not when. The
 * merged ballot is cached so the history's who-voted-what read moments later agrees with the
 * counts to the vote.
 *
 * The wrapper also serves a Discord-only vote with the Discord gate on (`ingame` null): the poll
 * card counts every click, and the merge here is where unregistered clicks stop counting.
 */
export class CombinedVoteSurface implements VoteSurface {
  readonly kind = "both";
  private lastMerged: { messageId: string; counts: number[]; voters: PollVoter[][]; exact: boolean } | null = null;
  constructor(
    private readonly discord: VoteSurface,
    private readonly ingame: VoteSurface | null,
    private readonly opts: {
      /** Discount unregistered Discord clicks at the exact close. */
      registeredOnlyDiscord?: boolean;
      /** Drop unlinked in-game voters in the merge (the in-game half also filters at source). */
      registeredOnlyIngame?: boolean;
      /** which of these Discord ids are registered (linked to a game account). */
      registeredAmong?: (discordIds: string[]) => Promise<Set<string>>;
      log?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
    } = {},
  ) {}

  private split(h: VoteHandle): { d: VoteHandle | null; g: VoteHandle | null } {
    const { discord, ingame } = splitVoteMessageId(h.messageId);
    return {
      d: discord ? { messageId: discord, channelId: h.channelId } : null,
      g: ingame ? { messageId: ingame, channelId: "ingame" } : null,
    };
  }

  async open(question: string, options: PollOption[]): Promise<VoteHandle> {
    // The Discord half must succeed (it is configured on, and its failure is the operator's to
    // see); the in-game half's announcement is already best-effort inside its own open().
    const d = await this.discord.open(question, options);
    if (!this.ingame) return d;
    const g = await this.ingame.open(question, options);
    return { messageId: `${d.messageId}|${g.messageId}`, channelId: d.channelId };
  }

  /** Raw sum of the halves; a half that cannot answer right now contributes zero to this READ
   *  (never to the record — the close is what counts). */
  async tally(handle: VoteHandle, optionCount: number): Promise<number[]> {
    const { d, g } = this.split(handle);
    const zero = () => Array.from({ length: optionCount }, () => 0);
    const [a, b] = await Promise.all([
      d ? this.discord.tally(d, optionCount).catch(() => zero()) : zero(),
      g && this.ingame ? this.ingame.tally(g, optionCount).catch(() => zero()) : zero(),
    ]);
    return a.map((n, i) => n + (b[i] ?? 0));
  }

  /** The raw sum, as `tally`, with the in-game half's voters beside it (null without an in-game
   *  half, or when it could not be read: a read that failed is not an empty ballot). */
  async tallyWithVoters(handle: VoteHandle, optionCount: number): Promise<{ counts: number[]; ingame: IngameBallotVoter[][] | null }> {
    const { d, g } = this.split(handle);
    const zero = () => Array.from({ length: optionCount }, () => 0);
    const ingame = this.ingame;
    const [a, b] = await Promise.all([
      d ? this.discord.tally(d, optionCount).catch(() => zero()) : zero(),
      g && ingame
        ? (ingame.tallyWithVoters
            ? ingame.tallyWithVoters(g, optionCount)
            : ingame.tally(g, optionCount).then((counts) => ({ counts, ingame: null }))
          ).catch(() => ({ counts: zero(), ingame: null }))
        : { counts: zero(), ingame: null },
    ]);
    return { counts: a.map((n, i) => n + (b.counts[i] ?? 0)), ingame: b.ingame };
  }

  private async merged(handle: VoteHandle, optionCount: number): Promise<{ counts: number[]; voters: PollVoter[][] }> {
    if (this.lastMerged && this.lastMerged.messageId === handle.messageId) return this.lastMerged;
    const { d, g } = this.split(handle);
    const empty = () => Array.from({ length: optionCount }, () => [] as PollVoter[]);
    // Who voted, per half. A half that CANNOT be read is not a half with no voters, and the
    // difference decides a vote: reading the Discord ballot costs one request per option at the
    // moment a match ends, so a rate limit there used to erase those ballots from the count and
    // the result was announced on what was left. `null` is "unknown", and the count falls back to
    // the poll's own numbers below.
    const readOr = async <T>(read: () => Promise<T>, why: string): Promise<T | null> => {
      try { return await read(); } catch (err) {
        this.opts.log?.warn(`combined vote: ${why} could not be read — falling back to its own counts`, { err: (err as Error).message });
        return null;
      }
    };
    const ingame = this.ingame;
    const [discordRead, ingameRead] = await Promise.all([
      d ? readOr(() => this.discord.voters(d, optionCount), "the Discord ballot") : Promise.resolve(empty()),
      g && ingame ? readOr(() => ingame.voters(g, optionCount), "the in-game ballot") : Promise.resolve(empty()),
    ]);
    // An unreadable half contributes its raw tally instead of nothing. Those votes cannot be
    // deduped against the other half — that is the cost of not having the names — but a vote that
    // is slightly over-counted beats one that silently threw ballots away.
    const fallback = async (side: VoteSurface | null, h: VoteHandle | null): Promise<number[]> => {
      if (!side || !h) return Array.from({ length: optionCount }, () => 0);
      return side.tally(h, optionCount).catch(() => Array.from({ length: optionCount }, () => 0));
    };
    const unreadCounts = [
      discordRead === null ? await fallback(this.discord, d) : null,
      ingameRead === null ? await fallback(this.ingame, g) : null,
    ];
    const discordVoters = discordRead ?? empty();
    const ingameVoters = ingameRead ?? empty();
    let registeredDiscord: Set<string> | null = null;
    let gateUnapplied = false;
    if (this.opts.registeredOnlyDiscord) {
      const ids = discordVoters.flat().map((v) => v.discordId).filter((id) => id && !id.startsWith("player:"));
      // "Which of these are registered" has three answers, and a failed lookup is the third one.
      // Treating it as the empty set said NOBODY is registered, which discounts every click and
      // hands the vote to the other half — one database hiccup at close time, and a gated Discord
      // poll recorded zero votes. A gate that cannot be applied is not applied, and says so.
      const check = this.opts.registeredAmong;
      if (!check) {
        // The gate is on and nothing was wired up to answer it. That is a caller's mistake, not a
        // finding about the voters — and the empty set that used to stand in here discounted every
        // single one of them, which is the same zero the catch below exists to stop.
        this.opts.log?.warn("combined vote: the Discord gate is on but no registration check was provided — counting every ballot");
        registeredDiscord = null;
        gateUnapplied = true;
      }
      try {
        if (check) registeredDiscord = await check(ids);
      } catch (err) {
        this.opts.log?.warn("combined vote: could not check who is registered — counting every Discord ballot for this close", { err: (err as Error).message });
        registeredDiscord = null;
        gateUnapplied = true;
      }
    }
    const merged = mergeBallots({
      optionCount, discord: discordVoters, ingame: ingameVoters,
      registeredDiscord, registeredIngameOnly: this.opts.registeredOnlyIngame === true,
    });
    const out = {
      counts: merged.counts.map((n, i) => n + (unreadCounts[0]?.[i] ?? 0) + (unreadCounts[1]?.[i] ?? 0)),
      voters: merged.voters,
      // An EXACT close is one where every ballot was read by name and every gate was applied to
      // it. Anything less still produces the best number available — but the channel post must
      // not describe it as "counted, registered voters only" when neither is quite true.
      exact: discordRead !== null && ingameRead !== null && !gateUnapplied,
    };
    this.lastMerged = { messageId: handle.messageId, ...out };
    return out;
  }

  /**
   * Whether the last close of this handle was settled on a full read, or on a fallback.
   *
   * The caller announces the result in Discord, and the wording differs: a number that includes a
   * half we could not dedupe, or a gate we could not apply, is an estimate and has to read like
   * one. Undefined until this handle has been closed.
   */
  closeWasExact(handle: VoteHandle): boolean | undefined {
    return this.lastMerged?.messageId === handle.messageId ? this.lastMerged.exact : undefined;
  }

  async close(handle: VoteHandle, optionCount: number): Promise<number[]> {
    const { d } = this.split(handle);
    // Take the Discord poll down (stops late clicks); its counts are superseded by the merge.
    if (d) await this.discord.close(d, optionCount).catch((err) => {
      this.opts.log?.warn("combined vote: the Discord poll could not be closed — merging what can be read", { err: (err as Error).message });
    });
    return (await this.merged(handle, optionCount)).counts;
  }

  async voters(handle: VoteHandle, optionCount: number): Promise<PollVoter[][]> {
    return (await this.merged(handle, optionCount)).voters;
  }
}
