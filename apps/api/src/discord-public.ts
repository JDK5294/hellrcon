/**
 * The PUBLIC VIP panel (docs/vip-module.md): the launcher anyone can press, and behind it the
 * registration flow — the identity system. No staff account, no capability: the gate here is
 * LINKING, proven by a code sent to the player in game.
 *
 *   pick a server → find yourself on the live roster → a code lands in your game chat →
 *   type it into a Discord modal → the link is written.
 *
 * Registration state (the outstanding code) lives in the DB (plugin_kv, one key per Discord
 * user), never in process memory — an API restart must not kill a half-done registration. Codes
 * are stored hashed, expire in 10 minutes, allow 3 attempts, and a burned code locks the flow
 * for 15 minutes; the lockout message points at staff, not at retrying.
 *
 * The module contract mirrors the staff one (docs/discord-modules.md) with two differences:
 * handlers may return a MODAL (the code entry, the roster search), and `defer` may name specific
 * actions — a modal can only be the FIRST response, so the actions that open one must never
 * defer, while the ones that talk to a game server must.
 */
import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import type { DiscordButton, DiscordModal, DiscordModuleResult, DiscordView } from "@app/plugin-sdk";
import type { PlayerRow, Repository, ServerRow, VipRow } from "@app/db";
import { normalizePlatformToken, platformFamilyTokens } from "@app/db";
import { getGame, playerIdentityOf } from "@app/games";
import { createLogger, discordLiteral as asTyped } from "@app/shared";
import { claimPrefix, claimWindow, dayBonusKey, rollClaim, REGISTRATION_KV_NS, type ClaimKind } from "./economy.js";
import { syncGameRoles } from "./discord-game-roles.js";
import { flagBanEvasion } from "./evasion.js";
import { communityGuild, guildMember } from "./discord-guild.js";
import { gift as pointsGift, grantDays, purchase } from "./shop.js";
import { connectGameClient, gameClientFor } from "./routes/kit.js";
import { vipBought, type VipBought } from "./vip-bought.js";

const log = createLogger("vip-panel");

/**
 * A date as Discord renders it: `<t:1755000000:D>` becomes "12 August 2026" **in the reader's own
 * time zone**, on their own device, in their own language.
 *
 * This is why nothing here prints a UTC string. A community spans time zones even when its staff
 * do not, and a bot that says "expires 2026-08-20" is saying it in a zone that is nobody's. Letting
 * Discord do it costs one helper and is right for every reader at once.
 *
 *   R  relative — "in 3 days"        f  short date+time — "12 August 2026 20:00"
 *   D  long date — "12 August 2026"
 */
export function discordTime(iso: string | null | undefined, style: "R" | "f" | "D" = "f"): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:${style}>` : "";
}

/**
 * A purchase's VIP dates as small lines beneath its history line, one per server: when the days
 * bought start and when that VIP now ends (vip-bought.ts).
 */
export function vipBoughtLines(bought: readonly VipBought[] | undefined): string[] {
  return (bought ?? []).flatMap((b) => {
    const where = asTyped(b.serverName);
    if (b.held) return [`-# ${where}: days saved for when the group's permanent VIP ends`];
    if (!b.until) return [];
    return [`-# ${where}: VIP ${b.from ? `from ${discordTime(b.from)} ` : ""}until ${discordTime(b.until)}`];
  });
}

/**
 * A history page with each line's VIP dates beneath it, as many as fit. The host cuts a view at
 * 1,900 characters, and a page of purchases over several servers can run past that, losing its
 * last lines part way through; the dates give way first, from the oldest line up, so every line
 * stays whole.
 */
export function historyPage(head: string, entries: readonly { line: string; dates: string[] }[], budget = 1900): string {
  const keep = entries.map((e) => e.dates);
  const text = (): string => [head, ...entries.flatMap((e, i) => [e.line, ...keep[i]!])].join("\n");
  for (let i = entries.length - 1; i >= 0 && text().length > budget; i--) keep[i] = [];
  return text();
}

// --- the public module contract ---

/** Modals are the same shape on both panels, so they are one type in the SDK; these aliases keep
 *  the public module's own vocabulary readable. */
export type PublicModal = DiscordModal;
export type PublicResult = DiscordModuleResult;

export interface PublicModuleEvent {
  discordUserId: string;
  discordUserName: string;
  action: string;
  state: string;
  /** The interaction's own id — Discord's natural idempotency key for purchases and gifts:
   *  a double-click is two interactions, a retry of ONE is the same id. */
  interactionId: string;
  /** Present on modal submits: field id → what the user typed. */
  values?: Record<string, string>;
  /** Present on user-select interactions: the picked Discord user ids. */
  selected?: string[];
  /** The guild roles Discord says the presser holds, resolved at press time. Empty in a DM, and
   *  empty is never "unrestricted" — a role-gated feature refuses when it cannot see the roles. */
  roleIds?: string[];
}

export interface PublicModuleDef {
  id: string;
  label: string;
  /** Actions that do slow work (RCON) and must defer. Actions that RETURN A MODAL must not be
   *  listed — Discord only accepts a modal as the first response. */
  deferActions?: string[];
  open(ev: PublicModuleEvent): Promise<PublicResult> | PublicResult;
  action?(ev: PublicModuleEvent): Promise<PublicResult> | PublicResult;
}

export class PublicModuleRegistry {
  private modules = new Map<string, PublicModuleDef>();
  register(def: PublicModuleDef): void {
    if (this.modules.has(def.id)) throw new Error(`public module already registered: ${def.id}`);
    this.modules.set(def.id, def);
  }
  get(id: string): PublicModuleDef | undefined {
    return this.modules.get(id);
  }
}

export { isModalResult } from "./discord-modules.js";

// --- registration state (plugin_kv, namespace vip-registration, key = discord user id) ---

const KV_NS = REGISTRATION_KV_NS;
const CODE_TTL_MS = 10 * 60_000;
const LOCKOUT_MS = 15 * 60_000;
const RESEND_COOLDOWN_MS = 60_000;
const ATTEMPTS = 3;

interface Challenge {
  serverId: string;
  platform: string;
  platformId: string;
  playerName: string;
  codeHash: string;
  expiresAt: number;
  attemptsLeft: number;
  lastSentAt: number;
  lockedUntil?: number;
}

const hashCode = (code: string, discordUserId: string): string =>
  createHash("sha256").update(`${code}:${discordUserId}`).digest("hex");

async function loadChallenge(repo: Repository, discordUserId: string): Promise<Challenge | null> {
  const raw = await repo.pluginKv.get(KV_NS, discordUserId);
  return raw && typeof raw === "object" ? (raw as unknown as Challenge) : null;
}
const saveChallenge = (repo: Repository, discordUserId: string, c: Challenge | Record<string, never>) =>
  repo.pluginKv.set(KV_NS, discordUserId, c);
/** A spent challenge is FORGOTTEN, not blanked. Writing `{}` left one dead row per player who
 *  ever registered — the store grew with the community and nothing ever read those rows again. */
const clearChallenge = (repo: Repository, discordUserId: string) => repo.pluginKv.remove(KV_NS, discordUserId);

/**
 * One registration step at a time per Discord account: sending a code, or checking one.
 *
 * Both steps read the account's challenge, wait on something (the game, the database) and write it
 * back, so two at once undid each other. A double-click on a name, or on Send again, sent the
 * player TWO codes, and only the one saved last worked — the code that arrived first could be
 * "wrong". Codes entered at the same moment were all checked against the same "3 tries left" and
 * each saved "2 tries left", so a burst was a dozen guesses for the price of one; and one saved
 * after the lockout put the tries back.
 *
 * A step that arrives while one runs is answered, not queued: it checks nothing and changes
 * nothing, and the running step's own answer replaces it on the panel a moment later. Process
 * memory is right for this one — it guards the seconds a step takes, not the registration, which
 * stays in the database.
 */
const registrationStep = new Map<string, "send" | "verify">();

async function oneStep(discordUserId: string, step: "send" | "verify", run: () => Promise<DiscordView>): Promise<DiscordView> {
  const running = registrationStep.get(discordUserId);
  if (running === "send") {
    return {
      content: "A code is on its way to you in game — check the chat in a moment, then press Enter code.",
      rows: [[{ label: "Enter code", customId: "codem", style: "primary" }]],
    };
  }
  if (running === "verify") return { content: "Checking the code you entered — one moment." };
  registrationStep.set(discordUserId, step);
  try {
    return await run();
  } finally {
    registrationStep.delete(discordUserId);
  }
}

/**
 * The roster names players by a token, never by their platform id.
 *
 * The picker is a public surface: anyone in the Discord can open it, and everything a select
 * carries reaches their client — an option's value is in the message even though Discord does not
 * draw it. It used to carry each connected player's platform id twice (the value, and the line
 * under the name), so the panel listed the ids of a whole server for anybody who asked.
 *
 * The token is a keyed hash: one player on one server to this process, nothing to anyone else,
 * and it cannot be worked back to an id. The key lives for the process, so a list drawn before a
 * restart stops resolving — which answers "pick yourself again", the same as a player who left.
 */
const ROSTER_KEY = randomBytes(32);
const rosterToken = (serverId: string, platformId: string): string =>
  createHmac("sha256", ROSTER_KEY).update(`${serverId}:${platformId}`).digest("base64url").slice(0, 16);

/** The line under a name in the picker: the platform in words (the panel's labels), which tells
 *  two players of one name apart without an id. Nothing when the game did not say. */
const PLATFORM_WORDS: [family: string, word: string][] = [
  ["steam", "Steam (PC)"], ["epic", "Epic (PC)"], ["msstore", "MS Store (PC)"], ["xbox", "Xbox"], ["playstation", "PlayStation"],
];
const platformWord = (platform: string): string | undefined => {
  const token = normalizePlatformToken(platform);
  return PLATFORM_WORDS.find(([family]) => platformFamilyTokens(family)?.includes(token))?.[1];
};

// --- game-side helpers ---

/** The live roster as pickable identities. Slow (a real RCON round trip) — callers defer.
 *  Exported for the staff panel's manual registration, which picks from the same list. */
export async function readRoster(repo: Repository, server: ServerRow): Promise<{ platform: string; platformId: string; name: string }[]> {
  const client = gameClientFor(server);
  try {
    await connectGameClient(client, server);
    const raw = await client.readState("players");
    const roster = Array.isArray(raw) ? raw : Array.isArray((raw as { players?: unknown[] })?.players) ? (raw as { players: unknown[] }).players : [];
    const mod = getGame(server.game);
    return (roster as Record<string, unknown>[])
      .map((pl) => ({ who: playerIdentityOf(mod, pl), name: String(pl?.name ?? "") }))
      .filter((x): x is { who: NonNullable<ReturnType<typeof playerIdentityOf>>; name: string } => !!x.who && !!x.name)
      .map((x) => ({ platform: x.who.platform, platformId: x.who.platformId, name: x.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/**
 * The welcome for a newly linked account, whoever did the linking.
 *
 * Points ride the ledger's unique ref (idempotent forever); days ride the same grant path as a
 * purchase, guarded by a kv flag. Both are keyed the same way, so the two halves of the welcome can
 * never disagree about whether it has already been paid.
 *
 * HOW OFTEN it pays is `bonusPerGame`:
 *   - off (default): once per Discord ACCOUNT, ever. A second game linked later, or a staff member
 *     finishing a registration the member started, finds the key taken and pays nothing.
 *   - on: once per Discord account PER GAME. Registering on Hell Let Loose pays; registering on
 *     Vietnam later pays again. Never twice for the same game, however many of its servers exist,
 *     and never twice for the same link.
 *
 * Either way the key is what makes this safe to call from anywhere, and that shared key is the
 * entire reason self-service and manual registration call THIS rather than each rolling their own.
 *
 * Returns the human bits to append to the confirmation ("50 points and 7 days of VIP"), empty
 * when nothing was paid.
 */
/** Day bonuses being granted right now, by scope — see applyWelcomeBonus. */
const dayBonusInFlight = new Set<string>();

export async function applyWelcomeBonus(repo: Repository, discordUserId: string, player: PlayerRow): Promise<string[]> {
  const cfg = await repo.economy.config();
  const bits: string[] = [];
  // The suffix IS the policy. Adding the game to the key is what turns "once ever" into "once per
  // game" — for the ledger ref and the kv flag alike, so points and days always agree.
  const scope = cfg.registration.bonusPerGame ? `${discordUserId}:${player.game}` : discordUserId;
  if (cfg.registration.bonusPoints > 0) {
    const bonus = await repo.economy.apply(
      { discordId: discordUserId, delta: cfg.registration.bonusPoints, reason: "welcome: linked account", ref: `bonus:${scope}`, actorName: "registration" },
      { maxBalance: cfg.balanceCap },
    );
    if (bonus.applied) bits.push(`**${bonus.entry.delta} ${cfg.currencyName}**`);
  }
  // The flag is only written once the days have LANDED (see below), so two registrations landing
  // together — a double-pressed button, or Discord and a staff hand-link at once — both read it
  // unspent. The claim is taken right after that read, with no await between, and the second
  // walks away: the days add up, and a member must not collect the welcome week twice.
  if (cfg.registration.bonusDays > 0 && !(await repo.pluginKv.get(KV_NS, dayBonusKey(scope))) && !dayBonusInFlight.has(scope)) {
    dayBonusInFlight.add(scope);
    try {
      let landed = 0;
      let attempted = 0;
      // Which account each server's grant uses is decided PER GAME, never guessed: the games issue
      // different player ids, and the other game's id is one a server accepts and applies to nobody
      // — the shop's old silent no-op, with a dead VIP row left behind.
      //
      // Default: only the just-linked account's own game. With bonusAllGames on, every game whose
      // account this member has ALSO linked gets the days on ITS servers with ITS id; a game they
      // have not linked is skipped — there is nothing addressable to grant to.
      //
      // bonusPerGame overrules it rather than combining: paying every game's servers AND paying again
      // per game is the same week counted twice, so per-game keeps the days on the game just linked.
      const spread = cfg.registration.bonusAllGames && !cfg.registration.bonusPerGame;
      const linked = spread ? await repo.externalLinks.findPlayers("discord", discordUserId) : [player];
      const accountFor = new Map(linked.map((p) => [p.game, p]));
      accountFor.set(player.game, player); // the account being linked right now always counts
      for (const server of await repo.servers.list()) {
        const account = accountFor.get(server.game);
        if (!account) continue;
        attempted++;
        // A member who already holds PERMANENT VIP here counts as landed: the bonus days have nowhere
        // to stack (permanent already outlasts them), and treating that as a failure would leave the
        // flag unspent forever, retrying a grant that can never change anything on every login.
        try { await grantDays(repo, server, account, cfg.registration.bonusDays, "registration", `bonus:${scope}`, null, "registration bonus"); landed++; }
        catch (err) { log.warn("registration day-bonus grant failed", { serverId: server.id, err: (err as Error).message }); }
      }
      // The flag is spent by a bonus that LANDED, never by one that was merely attempted. Marking it
      // up front — which is what this did — meant registering while the game server was down, or in
      // observe mode, marked the welcome VIP paid without a day of it reaching anybody, and nothing
      // anywhere would ever pay it: the flag has no expiry and no repair path. Nothing landed means
      // nothing was spent, so the next attempt (a second game linked later, or staff finishing the
      // registration by hand) pays it properly.
      //
      // A PARTIAL success still spends it: the days are cumulative, so re-running would stack a
      // second week onto the servers that already took the first.
      if (landed) {
        await repo.pluginKv.set(KV_NS, dayBonusKey(scope), true);
        bits.push(`**${cfg.registration.bonusDays} day${cfg.registration.bonusDays === 1 ? "" : "s"} of VIP**`);
      } else if (attempted) {
        log.warn("welcome VIP days reached no server — the bonus stays unpaid and the next registration will retry it", {
          discordUserId, servers: attempted, days: cfg.registration.bonusDays,
        });
      }
    } finally {
      dayBonusInFlight.delete(scope);
    }
  }
  return bits;
}

async function messageInGame(server: ServerRow, platformId: string, message: string): Promise<void> {
  const client = gameClientFor(server);
  try {
    await connectGameClient(client, server);
    await client.execute("messagePlayer", { playerId: platformId, message });
  } finally {
    await client.disconnect().catch(() => {});
  }
}

// --- the vip module (arc 6: root + registration; claims/buy/gift arrive in the next arc) ---

const PLAYERS_PER_PAGE = 25; // Discord's hard ceiling on select options

/**
 * May this member make this claim?
 *
 * No configured roles means everyone — the default, and what a community gets by switching the
 * claim on and nothing else. With roles configured, holding ANY of them is enough (they are
 * alternatives: booster OR patron OR member, never all three).
 *
 * `held` undefined is a press we could not read roles from, which is only a DM. A gated claim
 * refuses there rather than assuming the best.
 */
export function claimAllowed(claim: { roleIds?: string[] }, held: string[] | undefined): boolean {
  const required = claim.roleIds ?? [];
  if (!required.length) return true;
  return (held ?? []).some((r) => required.includes(r));
}

/**
 * Why a gated feature was withheld — for the LOG, never for the member.
 *
 * A hidden claim is correct behaviour and deliberately says nothing on screen. But that silence
 * also covers the two ways the gate can be wrong, and from outside they look identical:
 *   - the presser genuinely lacks the role (working as intended), or
 *   - the interaction arrived carrying NO roles at all, which is a refusal by accident: every
 *     role-gated feature vanishes at once and nothing anywhere records that it happened.
 * Only the second is a fault, so only the second gets logged.
 *
 * It also names the case that cost an afternoon of guessing: an UNGATED claim rendering proves
 * nothing about gating, because the empty list short-circuits to true before roles are consulted.
 */
export function gateDiagnosis(claim: { roleIds?: string[] }, held: string[] | undefined): "ungated" | "allowed" | "lacks-role" | "no-roles-seen" {
  const required = claim.roleIds ?? [];
  if (!required.length) return "ungated";
  if (!held || held.length === 0) return "no-roles-seen";
  return held.some((r) => required.includes(r)) ? "allowed" : "lacks-role";
}

/**
 * Should this offer be drawn for the member who would RECEIVE it? The claim gate, applied per
 * offer, with the same logging discipline: an offer withheld because they lack the role is
 * normal and says nothing on screen, while an offer withheld because no roles could be read is
 * the refusal-by-accident — every gated offer vanishes at once, and without this line nothing
 * anywhere records that it happened.
 *
 * `rolesRead` separates the two, because an empty list means opposite things depending on where
 * it came from: nothing at all in a DM press (a fault) versus a member Discord positively told
 * us holds no roles (working correctly, and only worth a debug line).
 *
 * Visibility only. `purchase()` runs the same check again, because a button on a panel someone
 * still has open outlives the roles it was drawn for.
 */
function offerVisible(offer: { id: string; roleIds?: string[] }, held: string[] | undefined, discordUserId: string, rolesRead = false): boolean {
  const verdict = gateDiagnosis(offer, held);
  if (verdict === "no-roles-seen" && !rolesRead) {
    log.warn("offer hidden: no roles were available to check the gate against", {
      offerId: offer.id, discordUserId, requiredRoleIds: offer.roleIds,
    });
  } else if (verdict === "lacks-role" || verdict === "no-roles-seen") {
    log.debug("offer not shown: the recipient holds none of the required roles", {
      offerId: offer.id, discordUserId, requiredRoleIds: offer.roleIds, heldRoleIds: held,
    });
  }
  return verdict === "ungated" || verdict === "allowed";
}

/** What the game is called when the panel has to say it — "hllv" is an id, not an answer. */
const gameLabelOf = (game: string): string => getGame(game)?.label ?? game;

/**
 * The servers a MEMBER may register on, in the app's own server order.
 *
 * `registration.serverIds` empty means every server — the default, and what a community running
 * one set of servers wants. A non-empty list is a whitelist, for the server that exists but is not
 * open to registration yet: a test box, an event server, a game still being set up.
 *
 * Every caller must go through this rather than `servers.list()`, and that is the whole reason it
 * exists as one function. The root decides whether to draw the link button from which GAMES are
 * still registrable; the picker draws the buttons. Compute those from different lists and a member
 * whose only unlinked game has no open server gets an invitation to a screen with nothing on it.
 *
 * `no` is the server's number in the FULL list, so "#2" here is the same "#2" as everywhere else
 * in the app even when #1 is not offered.
 */
async function registrableServers(repo: Repository): Promise<{ s: ServerRow; no: number }[]> {
  const all = (await repo.servers.list()).map((s, i) => ({ s, no: i + 1 }));
  const allowed = new Set((await repo.economy.config()).registration.serverIds ?? []);
  if (!allowed.size) return all;
  // An id that no longer resolves (a deleted server still listed in the config) simply drops out
  // — the intersection is the answer, and a stale id is not worth refusing a registration over.
  return all.filter(({ s }) => allowed.has(s.id));
}

export function vipPublicModule(repo: Repository): PublicModuleDef {
  /**
   * The one refusal the whole registration flow shares: this Discord account already holds an
   * account for this server's game. Checked at every step that could move the flow forward —
   * the server picker filters, the roster refuses, and above all SENDING THE CODE refuses,
   * because that step messages a player in game and is what somebody malicious would lean on to
   * spam registered players. Staff clearing the link (the panel or the staff module) is what
   * re-opens the game, and nothing here needs to know that happened.
   */
  /** Refuse a server staff have withheld from registration. Checked at every step that moves the
   *  flow on, not only in the picker: a button pressed from a panel that was open before the
   *  restriction, or an id typed by hand, must land on the same answer as the screen. */
  const notOpen = async (server: ServerRow): Promise<DiscordView | null> => {
    const open = await registrableServers(repo);
    return open.some(({ s }) => s.id === server.id)
      ? null
      : { content: `Registration isn't open on **${server.name}** right now. Ask staff.` };
  };

  const alreadyLinked = async (discordUserId: string, game: string): Promise<DiscordView | null> => {
    const held = (await repo.externalLinks.findPlayers("discord", discordUserId)).find((p) => p.game === game);
    if (!held) return null;
    return { content: `You're already linked for **${gameLabelOf(game)}** as **${asTyped(held.name)}** — one account per game. If that's wrong, ask staff to move it.` };
  };

  /**
   * Is this IN-GAME player already claimed by some Discord account?
   *
   * The other direction from `alreadyLinked`, and the one that was missing. That one asks "is the
   * REQUESTER already registered", which stops somebody registering twice — it says nothing about
   * who they picked. So an unregistered account could pick a player who WAS registered, and the
   * app would message that player in game with a code they never asked for. The registered player
   * had no way to stop it and no way to see who did it: one account per game was supposed to mean
   * the end of being bothered, and instead it only bound the sender.
   *
   * Checked before anything reaches the game. Deliberately does not name the Discord account that
   * holds the link — the person asking has just demonstrated they are not it.
   */
  /*
   * Three answers, not two. A guard whose lookup FAILED has not established that the account is
   * free, and saying so let a database hiccup hand somebody a claim on an account another Discord
   * already holds — the one thing this check exists to prevent. "unknown" refuses and asks them to
   * try again, which costs a retry; guessing "no" costs staff an unpicking.
   */
  const playerAlreadyClaimed = async (platformId: string): Promise<"yes" | "no" | "unknown"> => {
    let player;
    try { player = await repo.players.findByPlatformId(platformId); }
    catch (err) { log.warn("registration: could not look the player up", { err: (err as Error).message }); return "unknown"; }
    if (!player) return "no"; // never seen here — nobody can hold a link to them
    try {
      const links = await repo.externalLinks.list(player.id);
      return links.some((l) => l.provider === "discord") ? "yes" : "no";
    } catch (err) {
      log.warn("registration: could not read who holds this player's link", { err: (err as Error).message });
      return "unknown";
    }
  };

  /** The panel's home: who you are, what you hold, and every enabled thing you can do. The
   *  buttons RENDER FROM CONFIGURATION — an offer per button, claims only when switched on —
   *  so per-server vs community-wide selling is a settings change, never a code change. */
  const root = async (ev: PublicModuleEvent): Promise<DiscordView> => {
    const cfg = await repo.economy.config();
    const players = await repo.externalLinks.findPlayers("discord", ev.discordUserId);
    const member = await repo.economy.member(ev.discordUserId);
    const servers = await repo.servers.list();
    // Two different questions, two different lists. Whether to name the game beside each linked
    // account is about what the COMMUNITY runs — restricting registration must not stop telling a
    // WW2 account from a Vietnam one. Whether to offer the link button is about what is still
    // OPEN to register on, which is narrower when staff have restricted the picker.
    const games = [...new Set(servers.map((s) => s.game))];
    const openGames = new Set((await registrableServers(repo)).map(({ s }) => s.game));

    // Unlinked is a MISSING PIECE, not a locked door. The panel still shows the balance and still
    // offers the claims, because points are held against the Discord id and were never a property
    // of a game account; linking is what lets VIP and purchases reach a player in game. An earlier
    // cut replaced this whole screen with a single "link first" button, which hid a real balance
    // from its owner and made a claim they were entitled to look like a bug.
    const lines = [
      players.length
        // Which GAME each account is, once there is more than one to confuse: the same person is
        // two different names across WW2 and Vietnam, and "linked as X, Y" answers nothing.
        ? `Linked: ${players.map((p) => `**${asTyped(p.name)}**${games.length > 1 ? ` (${gameLabelOf(p.game)})` : ""}`).join(", ")}.`
        : `**Not linked yet** — you can still collect ${cfg.currencyName}, but VIP needs a linked game account to land on.`,
      `Balance: **${member?.balance ?? 0} ${cfg.currencyName}**.`,
    ];
    const vipLines: string[] = [];
    // One read per LINKED ACCOUNT, not one per (server × account). This is the most-pressed screen
    // in the bot and it sat behind a nested loop of point reads: a member with both games linked,
    // on four servers, opened the panel with eight round trips before a word of it rendered.
    const held = new Map<string, VipRow>();
    for (const rows of await Promise.all(players.map((p) => repo.vips.listByPlayer(p.platformId)))) {
      for (const v of rows) held.set(`${v.serverId} ${v.playerId}`, v);
    }
    for (const s of servers) {
      for (const p of players) {
        const v = held.get(`${s.id} ${p.platformId}`);
        if (!v) continue;
        const paused = v.pausedUntil && Date.parse(v.pausedUntil) > Date.now();
        // "until <date in YOUR zone> (in 12 days)" — Discord renders both from the same instant.
        vipLines.push(`• **${s.name}** — ${v.expiration ? `until ${discordTime(v.expiration, "D")} (${discordTime(v.expiration, "R")})` : "permanent"}${paused ? " (paused)" : ""}`);
      }
    }
    if (players.length) lines.push(vipLines.length ? `VIP:\n${vipLines.join("\n")}` : "No active VIP.");
    // When the next claim opens — the old bot's status line people actually checked. Computed by the same
    // function the press itself uses, so this can never disagree with what pressing would do.
    const { timezone: tz } = await repo.appConfig.get();
    for (const kind of ["daily", "monthly"] as const) {
      if (!cfg.claims[kind].enabled || !claimAllowed(cfg.claims[kind], ev.roleIds)) continue;
      const last = await repo.economy.lastEntryWithRefPrefix(ev.discordUserId, claimPrefix(kind, ev.discordUserId));
      const w = claimWindow(kind, ev.discordUserId, last?.createdAt ?? null, new Date(), tz);
      lines.push(`${kind === "daily" ? "Daily" : "Monthly"} claim: ${w.ready ? "**ready**" : `next ${discordTime(w.nextAt!, "R")}`}.`);
    }

    const rows: DiscordButton[][] = [];
    const claims: DiscordButton[] = [];
    // A claim they cannot make is not shown greyed out — it is not shown. Offering a button that
    // answers "not for you" is worse than the button never being there.
    for (const kind of ["daily", "monthly"] as const) {
      const claim = cfg.claims[kind];
      if (!claim.enabled) { log.debug("claim not offered: disabled", { kind, discordUserId: ev.discordUserId }); continue; }
      const verdict = gateDiagnosis(claim, ev.roleIds);
      // The refusal-by-accident: gated, but the interaction carried no roles to check against.
      if (verdict === "no-roles-seen") {
        log.warn("claim hidden: the interaction carried no roles to check the gate against", {
          kind, discordUserId: ev.discordUserId, requiredRoleIds: claim.roleIds,
        });
      } else if (verdict === "lacks-role") {
        log.debug("claim not offered: presser holds none of the required roles", {
          kind, discordUserId: ev.discordUserId, requiredRoleIds: claim.roleIds, heldRoleIds: ev.roleIds,
        });
      }
      if (verdict === "ungated" || verdict === "allowed") {
        claims.push({ label: `${kind === "daily" ? "Daily" : "Monthly"} claim`, customId: `claim:${kind}`, style: "success" });
      }
    }
    if (claims.length) rows.push(claims);
    // Buying and gifting DO need a linked account — that is where the VIP days land, and both
    // sides of a gift have to be reachable. Hidden rather than disabled, same as everything else.
    //
    // An offer can also be gated on a Discord role, and the gate the shop was built for is the
    // per-game registration role: a community running two games sold both games' VIP to everyone,
    // so a Vietnam-only member was shown WW2 offers they had no account to receive them on. With
    // each offer pointed at its game's registration role, the shop shows each member what they can
    // actually buy — and the same predicate refuses the purchase (shop.ts), so a button on a panel
    // they still have open cannot spend on an offer that is no longer theirs.
    const offers = players.length
      ? cfg.offers.filter((o) => o.enabled && offerVisible(o, ev.roleIds, ev.discordUserId))
      .slice(0, 10)
      : [];
    for (let i = 0; i < offers.length; i += 5) {
      // `buyask`, not `buy`: an offer button opens the confirmation, and only the button ON that
      // confirmation spends anything. See confirmPurchase.
      rows.push(offers.slice(i, i + 5).map((o) => ({ label: `${o.label} · ${o.points}`, customId: `buyask:${o.id}`, style: "primary" as const })));
    }
    const extra: DiscordButton[] = [];
    if (players.length && cfg.gifting.enabled) extra.push({ label: `Gift ${cfg.currencyName}`, customId: "giftpick" });
    if (players.length && cfg.vipGifting.enabled && offers.length && claimAllowed(cfg.vipGifting, ev.roleIds)) {
      extra.push({ label: "Gift VIP", customId: "giftvippick" });
    }
    // The link button exists while any OPEN game is still unlinked, and only then: registered for
    // everything means there is nothing left to register, and the button's absence is what tells a
    // fully linked member the job is done. A game whose servers staff have withheld is not open,
    // so it never puts up a button that leads to an empty picker.
    const linkedGames = new Set(players.map((p) => p.game));
    if ([...openGames].some((g) => !linkedGames.has(g))) {
      extra.push(players.length
        ? { label: "Link another account", customId: "link" }
        : { label: "Link my game account", customId: "link", style: "primary" });
    }
    extra.push({ label: "History", customId: "history:0" });
    extra.push({ label: "Leaderboard", customId: "leaderboard:0" });
    extra.push({ label: "Refresh", customId: "" });
    rows.push(extra);
    return { content: `**VIP panel**\n${lines.join("\n")}`, rows };
  };

  /**
   * The community standings, richest first.
   *
   * The one social surface of the economy: without it a balance is a private number and there is
   * nothing to chase. Paged like the history so a large community is readable rather than
   * truncated at ten and silently cut off.
   *
   * The caller's own line is marked wherever it lands, and their balance is always in the header
   * even when their page is not the one on screen — "where am I" is the question this screen is
   * opened to answer. An exact global rank is deliberately NOT shown: it would take a
   * count-of-everyone-above query the store does not have, and a number computed from the current
   * page only would be wrong for anybody past the first one. A wrong rank is worse than no rank.
   */
  const leaderboard = async (ev: PublicModuleEvent): Promise<DiscordView> => {
    const PER = 10;
    const [cfg, total, me] = await Promise.all([
      repo.economy.config(),
      repo.economy.membersCount(),
      repo.economy.member(ev.discordUserId),
    ]);
    if (!total) {
      return { content: `**${cfg.currencyName} leaderboard**\nNobody has earned anything yet.` };
    }
    // Clamp BEFORE reading, same as the history: a stale button can name a page that is now gone.
    const pages = Math.max(1, Math.ceil(total / PER));
    const p = Math.min(Math.max(Number(ev.state) || 0, 0), pages - 1);
    const rows = await repo.economy.members({ limit: PER, offset: p * PER });
    const lines = rows.map((m, i) => {
      const place = p * PER + i + 1;
      const mine = m.discordId === ev.discordUserId;
      // The stored Discord name is absent for a member the name resync has never seen — an id is
      // the honest fallback rather than a blank line. For the CALLER we can do better without
      // guessing: the interaction we are answering carries their current username, so the one
      // person guaranteed to be reading this never sees themselves as a raw id.
      // Names as their owners wrote them: this is Discord text, and "*star*" is not italics.
      const who = asTyped((mine ? ev.discordUserName : null) || m.discordName || m.discordId);
      return `${place}. ${mine ? `**${who}** ←` : who} — **${m.balance}**`;
    });
    const nav: DiscordButton[] = [];
    if (pages > 1) {
      nav.push({ label: "‹ Previous", customId: `leaderboard:${p - 1}`, disabled: p === 0 });
      nav.push({ label: "Next ›", customId: `leaderboard:${p + 1}`, disabled: p === pages - 1 });
    }
    return {
      content: [
        `**${cfg.currencyName} leaderboard**${pages > 1 ? ` — page ${p + 1}/${pages}` : ""}`,
        ...lines,
        "",
        `You have **${me?.balance ?? 0}**.`,
      ].join("\n"),
      rows: nav.length ? [nav] : [],
    };
  };

  /**
   * The member's own ledger, newest first — every claim, purchase, gift and staff correction,
   * with the balance it adds up to. The same rows staff read in the app; a member asking "where
   * did my ${points} go" should not need to ask staff to look. Under a VIP purchase, when its days
   * start and when that VIP now ends, so nobody has to work it out.
   */
  const history = async (ev: PublicModuleEvent): Promise<DiscordView> => {
    const PER = 10;
    const cfg = await repo.economy.config();
    const [member, total] = await Promise.all([
      repo.economy.member(ev.discordUserId),
      repo.economy.ledgerCount(ev.discordUserId),
    ]);
    if (!total) {
      return { content: `**${cfg.currencyName} history**\nNothing yet — claims, purchases and gifts will show up here.` };
    }
    // Clamp BEFORE reading: a stale button can name a page that no longer exists.
    const pages = Math.max(1, Math.ceil(total / PER));
    const p = Math.min(Math.max(Number(ev.state) || 0, 0), pages - 1);
    const [entries, players] = await Promise.all([
      repo.economy.ledger(ev.discordUserId, { limit: PER, offset: p * PER }),
      repo.externalLinks.findPlayers("discord", ev.discordUserId),
    ]);
    const bought = await vipBought(repo, entries);
    // Dates only for VIP that landed on their own accounts: a gift's line says who it was for, and
    // when that member's VIP now ends is theirs to tell.
    const mine = new Set(players.map((pl) => pl.platformId));
    // "by" names somebody ELSE. Their own presses are recorded as `discord:<their name>` (that
    // prefix is how the audit trail tells a button press from a panel action), and echoing it back
    // reads as though a stranger called `discord:BEAST` had been spending their points.
    const isSelf = (actor: string): boolean => actor === ev.discordUserName || actor === `discord:${ev.discordUserName}`;
    const lines = entries.map((e) => ({
      line: `${e.delta >= 0 ? "**+" : "**"}${e.delta}** — ${asTyped(e.reason)}${e.actorName && !isSelf(e.actorName) ? ` (by ${asTyped(e.actorName)})` : ""} — ${discordTime(e.createdAt, "R")}`,
      dates: vipBoughtLines(e.ref ? bought.get(e.ref)?.filter((b) => mine.has(b.playerId)) : undefined),
    }));
    const nav: DiscordButton[] = [];
    if (pages > 1) {
      nav.push({ label: "‹ Previous", customId: `history:${p - 1}`, disabled: p === 0 });
      nav.push({ label: "Next ›", customId: `history:${p + 1}`, disabled: p === pages - 1 });
    }
    return {
      content: historyPage(`**${cfg.currencyName} history** — balance **${member?.balance ?? 0}**${pages > 1 ? `, page ${p + 1}/${pages}` : ""}, newest first.`, lines),
      rows: nav.length ? [nav] : [],
    };
  };

  /** A claim: the ledger's unique ref IS the cooldown — the second press in a period finds the
   *  ref taken and pays nothing, whatever raced it. Fast (no game server), so never deferred. */
  const claim = async (ev: PublicModuleEvent): Promise<DiscordView> => {
    const kind = (ev.state === "monthly" ? "monthly" : "daily") as ClaimKind;
    const cfg = await repo.economy.config();
    if (!cfg.claims[kind].enabled) return { content: `The ${kind} claim is switched off.` };
    // Re-checked on the press, not just when the button was drawn: a panel sits open in Discord
    // for as long as the member leaves it there, and roles are lost as well as given.
    if (!claimAllowed(cfg.claims[kind], ev.roleIds)) return { content: `The ${kind} claim is for members with a particular role.` };
    // No link needed. The balance belongs to the Discord account, and the old bot paid claims the same way;
    // linking is what a PURCHASE needs, because that is when something has to reach a game id.
    // The community's calendar day, so "once a day" turns over at midnight where the community
    // lives rather than at 8pm on the American east coast.
    const { timezone: tz } = await repo.appConfig.get();
    // Read their own last claim first: monthly's window is anchored on it (a shared calendar month
    // hands a second payout to anyone who claims just before the 1st and again just after).
    const last = await repo.economy.lastEntryWithRefPrefix(ev.discordUserId, claimPrefix(kind, ev.discordUserId));
    const w = claimWindow(kind, ev.discordUserId, last?.createdAt ?? null, new Date(), tz);
    if (!w.ready) {
      return { content: `Already claimed — come back ${discordTime(w.nextAt!, "R")} (${discordTime(w.nextAt!, "f")}).` };
    }
    const amount = rollClaim(cfg.claims[kind]);
    const r = await repo.economy.apply(
      { discordId: ev.discordUserId, delta: amount, reason: `${kind} claim`, ref: w.ref, actorName: null, discordName: ev.discordUserName },
      { maxBalance: cfg.balanceCap },
    );
    // The window said open but the ref was taken: two presses raced. The ledger's unique index is
    // the real arbiter — the check above is for the message, never for the money.
    if (!r.applied) {
      const now = claimWindow(kind, ev.discordUserId, r.entry?.createdAt ?? last?.createdAt ?? new Date().toISOString(), new Date(), tz);
      return { content: `Already claimed — come back ${discordTime(now.nextAt ?? new Date().toISOString(), "R")}.` };
    }
    return { content: `💰 **+${r.entry.delta} ${cfg.currencyName}** — balance **${r.member.balance}**.${r.entry.delta < amount ? " (Trimmed at the balance cap.)" : ""}` };
  };

  /**
   * The step between pressing an offer and spending anything.
   *
   * Points are bought with time — claimed daily, earned by seeding, given as a gift — and a
   * purchase cannot be undone: the VIP days land on a game server immediately and there is no
   * "return" path in the economy. A panel of primary-styled buttons where one press is final is a
   * design that produces mistakes, and every one of those mistakes arrives at staff as a refund
   * request they have no button for either.
   *
   * So the offer buttons open this instead, and only the button on THIS screen buys. It is also
   * the natural place to say the thing that was previously said nowhere: purchases are
   * non-refundable.
   *
   * Checks the offer again rather than trusting the press. The panel is ephemeral but it sits open
   * indefinitely, so the offer it names may since have been disabled, deleted, or gated behind a
   * role this member no longer holds — and a confirmation screen for something that will be
   * refused a moment later is worse than the refusal on its own. `purchase()` re-checks everything
   * a third time; this is about what the member is shown, not about what is allowed.
   */
  const confirmPurchase = async (ev: PublicModuleEvent, offerId: string, forDiscordId: string | null): Promise<DiscordView> => {
    const cfg = await repo.economy.config();
    const offer = cfg.offers.find((o) => o.id === offerId && o.enabled);
    if (!offer) return { content: "That offer is no longer available. Refresh the panel to see what is." };
    // Buying for yourself: the gate follows the recipient, and the recipient is the presser, so the
    // roles Discord sent with this press answer it with no round trip. A gift's recipient was
    // already filtered by the picker and is re-checked by purchase().
    if (!forDiscordId && !offerVisible(offer, ev.roleIds, ev.discordUserId)) {
      return { content: "That offer isn't available to you — you may not be registered for the game it applies to." };
    }
    // Too few points: the refusal members meet most. The presser pays, gift or not.
    const balance = (await repo.economy.member(ev.discordUserId))?.balance ?? 0;
    if (balance < offer.points) {
      return { content: `**${offer.label}** costs **${offer.points} ${cfg.currencyName}**, and you have **${balance}**.` };
    }
    const who = forDiscordId ? ` for <@${forDiscordId}>` : "";
    // This screen IS the purchase. Its Confirm carries the id of the press that opened it, and that
    // is the purchase's ledger ref — so a double-click on Confirm (two presses, two interaction ids)
    // buys once and answers the second as a replay. The panel only says "thinking" while the grant
    // reaches the game, and the button stays pressable the whole time.
    const screen = ev.interactionId;
    return {
      content: `⚠️ **${cfg.currencyName} purchases are non-refundable.**

`
        + `Please verify you wish to purchase **${offer.label}**${who} for **${offer.points} ${cfg.currencyName}**.`,
      rows: [[
        // The state carried through is exactly what the original button carried, so confirming is
        // the press that used to happen directly.
        { label: "Confirm purchase", customId: forDiscordId ? `buyfor:${offer.id}:${forDiscordId}:${screen}` : `buy:${offer.id}:${screen}`, style: "danger" },
        // Its own action rather than an empty id: an empty one encodes to the same custom_id as the
        // "‹ Menu" escape button the host appends to every sub-view, and two components sharing an
        // id makes Discord reject the whole message. `cancel` re-renders the panel, so saying no
        // puts them back where they were instead of on a dead-end.
        { label: "Cancel", customId: "cancel" },
      ]],
    };
  };

  /** A purchase (own or gift): the confirmation screen is the idempotency ref, so a double-click
   *  on Confirm or a Discord retry cannot pay twice (a button drawn before screens carried their id
   *  falls back to the press's own id). Deferred — the grant is a real RCON round trip per server.
   *  Only reachable from the confirmation above. */
  const buy = async (ev: PublicModuleEvent, offerId: string, forDiscordId: string | null, screen = ""): Promise<DiscordView> => {
    const cfg = await repo.economy.config();
    try {
      const outcome = await purchase(repo, {
        buyerDiscordId: ev.discordUserId, offerId, forDiscordId,
        // The service is the actor; the member is the member. Stamping `discord:<name>` here
        // made every buyer a one-row "service" on the System page's machinery rollup.
        ref: `buy:${screen || ev.interactionId}`, actorName: "shop", memberName: ev.discordUserName,
        // Buying for yourself: the presser IS the recipient, so the roles Discord sent with THIS
        // press are the ones the gate wants — fresher than a lookup and a round trip cheaper.
        // A gift is somebody else's roles, so it is left for purchase() to go and ask.
        ...(forDiscordId ? {} : { recipientRoleIds: ev.roleIds }),
      });
      if (outcome.status === "replay") return { content: "That purchase already went through." };
      if (outcome.status === "refunded") {
        // The server list is empty when this press is a REPLAY of a purchase that already refunded
        // itself — the reasons were reported the first time, and an empty "()" here would read as
        // the message being broken rather than as the purchase having failed.
        const where = outcome.skipped.length ? ` (${outcome.skipped.map((s) => s.serverName).join(", ")})` : "";
        // "Could not be granted" would be a lie when the member simply has permanent VIP already:
        // nothing went wrong, there was just nothing to sell them. An error face on that sends
        // someone with working VIP to open a ticket about it.
        if (outcome.skipped.length && outcome.skipped.every((s) => s.reason.startsWith("already has permanent VIP"))) {
          const who = forDiscordId ? `<@${forDiscordId}> already has` : "You already have";
          return { content: `ℹ️ ${who} **permanent VIP**${where} — nothing to add, so your ${cfg.currencyName} were not spent. Balance **${outcome.balance}**.` };
        }
        /*
         * The reason line is the whole difference between a ticket and a self-fix. This message
         * used to name only the SERVERS, so a buyer with no Vietnam account linked saw the same
         * bare ❌ as one hit by an outage, retried forever, and opened a ticket staff could only
         * answer by re-deriving the grant loop by hand (ticket-4764). `memberReason` is the safe
         * wording — our own refusals verbatim, infrastructure failures generalised so a connect
         * error's host:port never lands in Discord. One reason is stated inline; different
         * per-server reasons are listed. Capped well inside Discord's limit either way.
         */
        const reasons = [...new Set(outcome.skipped.map((s) => s.memberReason))];
        const why = reasons.length === 1
          ? ` — ${reasons[0]}`
          : outcome.skipped.length
            ? `\n${outcome.skipped.slice(0, 6).map((s) => `• **${s.serverName}**: ${s.memberReason}`).join("\n")}`
            : "";
        return { content: `❌ **${outcome.offer.label}** could not be granted${reasons.length === 1 ? where : ""}${why}\nYour ${cfg.currencyName} were returned. Balance **${outcome.balance}**.`.slice(0, 1900) };
      }
      const where = outcome.applied.map((a) => a.serverName).join(", ");
      const skipped = outcome.skipped.length ? ` (${outcome.skipped.length} server(s) skipped — staff will see it)` : "";
      return { content: `✅ **${outcome.offer.label}**${forDiscordId ? ` for <@${forDiscordId}>` : ""} — ${outcome.offer.days} days of VIP on ${where}${skipped}. Balance **${outcome.balance} ${cfg.currencyName}**.` };
    } catch (err) {
      return { content: `❌ ${(err as Error).message}` };
    }
  };

  // Roster page: state `<serverId>:<page>` (from a button) or `<serverId>` + values.q (from the
  // search modal). Names become buttons; pressing yours sends the code.
  /**
   * Pick yourself out of the live roster.
   *
   * A DROPDOWN, not a wall of buttons. A full server is a hundred names; as buttons that is four
   * rows of five per page, which fills Discord's row budget and leaves nothing for "next page" —
   * the first cut of this shipped exactly that and stranded people on page 1 of 5 with no search.
   * One select holds 25 names and costs one row, which leaves room for paging and for finding
   * your own name, and it is the same shape the old bot used.
   */
  const rosterView = async (ev: PublicModuleEvent, serverId: string, page: number, filter: string): Promise<DiscordView> => {
    const server = await repo.servers.findById(serverId);
    if (!server) return { content: "That server no longer exists." };
    // Re-checked here, not only in the server picker: this panel sits open for as long as the
    // member leaves it, and a roster button pressed after they registered elsewhere — or after
    // staff withdrew the server from registration — must refuse.
    const closed = await notOpen(server);
    if (closed) return closed;
    const taken = await alreadyLinked(ev.discordUserId, server.game);
    if (taken) return taken;
    const all = await readRoster(repo, server);
    const matches = filter ? all.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase())) : all;
    /**
     * Two buttons in one message may never carry the same custom_id — Discord rejects the whole
     * message, so the screen that would have shown simply never arrives.
     *
     * That is not hypothetical: "Refresh list" and "Clear search" were both `roster:<id>:0`, and so
     * was "‹ Previous" from page 2. Pressing Next built a page whose ids collided, the edit was
     * refused, and the panel sat on page 1 — with 95 players, four fifths of the server could not
     * find themselves. So each button here means a DIFFERENT page: refresh stays on the page you
     * are reading, and the one that drops a search is the only one that means page 0.
     */
    const searchRow = (p: number): DiscordButton[] => [
      { label: "Find my name", customId: `searchm:${serverId}`, style: "primary" },
      // While searching, "refresh" and "clear" would be the same request — the roster is always
      // re-read — so only one of them is offered, and it says which one it is.
      filter
        ? { label: "Show everyone", customId: `roster:${serverId}:0` }
        : { label: "Refresh list", customId: `roster:${serverId}:${p}` },
    ];
    if (!matches.length) {
      return {
        content: filter
          ? `Nobody on **${server.name}** matches "${asTyped(filter)}". You need to be connected right now.`
          : `Nobody is on **${server.name}** right now. Join the server first, then press Refresh.`,
        rows: [searchRow(0)],
      };
    }
    const pages = Math.max(1, Math.ceil(matches.length / PLAYERS_PER_PAGE));
    const p = Math.min(Math.max(page, 0), pages - 1);
    const slice = matches.slice(p * PLAYERS_PER_PAGE, (p + 1) * PLAYERS_PER_PAGE);
    // Paging belongs to the WHOLE roster. A search carries no page in its id, so a Next here would
    // silently drop the search and land the reader back in the full list — worse than not offering
    // it. A narrowed list is short by construction; when it is not, the line below says so.
    const nav: DiscordButton[] = [];
    if (pages > 1 && !filter) {
      nav.push({ label: "‹ Previous", customId: `roster:${serverId}:${p - 1}`, disabled: p === 0 });
      nav.push({ label: "Next ›", customId: `roster:${serverId}:${p + 1}`, disabled: p === pages - 1 });
    }
    return {
      content: [
        `**Pick yourself** on **${server.name}** — ${matches.length} player${matches.length === 1 ? "" : "s"}${filter ? ` matching "${asTyped(filter)}"` : ""}${filter ? "." : `, page ${p + 1}/${pages}.`}`,
        filter
          ? (pages > 1 ? `Showing the first ${PLAYERS_PER_PAGE} — type more of your name if you can't see yourself.` : "")
          : `Discord shows ${PLAYERS_PER_PAGE} at a time; use **Find my name** or **Next** if you can't see yourself.`,
        "The code goes to THAT player in game — picking someone else sends it to them, not you.",
      ].filter(Boolean).join("\n"),
      select: {
        customId: `pick:${serverId}`,
        placeholder: "Choose your in-game name",
        options: slice.map((pl) => {
          const word = platformWord(pl.platform);
          return { label: pl.name, value: rosterToken(serverId, pl.platformId), ...(word ? { description: word } : {}) };
        }),
      },
      rows: [searchRow(p), ...(nav.length ? [nav] : [])],
    };
  };

  // Send (or resend) the code to the picked player, in game. state `<serverId>:<roster token>`.
  // Runs under oneStep (the dispatch below) — never two for one Discord account at once.
  const sendCode = async (ev: PublicModuleEvent): Promise<DiscordView> => {
    const existing = await loadChallenge(repo, ev.discordUserId);
    const now = Date.now();
    if (existing?.lockedUntil && existing.lockedUntil > now) {
      return { content: `Too many wrong codes — registration is locked for a while. Ask in the staff channel if you're stuck.` };
    }
    if (existing && existing.lastSentAt && now - existing.lastSentAt < RESEND_COOLDOWN_MS && !existing.lockedUntil) {
      return {
        content: "A code was already sent less than a minute ago — check your in-game chat.",
        rows: [[{ label: "Enter code", customId: "codem", style: "primary" }]],
      };
    }
    const sep = ev.state.indexOf(":");
    const serverId = ev.state.slice(0, sep);
    const picked = ev.state.slice(sep + 1);
    const server = await repo.servers.findById(serverId);
    if (!server) return { content: "That server no longer exists." };
    // THE gate that matters. Every earlier screen filters and refuses too, but this is the step
    // that messages a player IN GAME — without it, anyone could pick a registered player off the
    // roster over and over and use the code sender as a harassment cannon. Once a game is linked,
    // no code goes out for it until staff clear the link; and a server staff have withheld sends
    // nothing at all, which is the point of withholding it.
    const closed = await notOpen(server);
    if (closed) return closed;
    const taken = await alreadyLinked(ev.discordUserId, server.game);
    if (taken) return taken;
    // The roster is re-read so the name/platform stored with the challenge is the CURRENT one,
    // and a stale button (player left) fails here with a clear message instead of a dead send.
    // The pick is a roster token (see rosterToken). A bare platform id is a button drawn before
    // the tokens, and resolves the same way — against who is on the server now.
    const roster = await readRoster(repo, server);
    const player = roster.find((pl) => rosterToken(serverId, pl.platformId) === picked) ?? roster.find((pl) => pl.platformId === picked);
    if (!player) {
      return {
        content: "That player isn't on the server now, or this list is out of date. Pick yourself again.",
        rows: [[{ label: "Back to the roster", customId: `roster:${serverId}:0` }]],
      };
    }
    const platformId = player.platformId;
    // Send again / Try again carry the token too — never the id, whatever the press arrived with.
    const again = `code:${serverId}:${rosterToken(serverId, platformId)}`;
    // The player being picked must not already belong to somebody. This check used to live only at
    // the VERIFY step, which is too late by the length of the whole problem: the code had already
    // been sent, so the registered player got an admin message in game for a registration they did
    // not start, and the attempt only failed afterwards — for the sender, silently, out of sight.
    // Refusing here is what makes "one account per game" mean "and then you are left alone".
    const claimed = await playerAlreadyClaimed(platformId);
    if (claimed === "yes") {
      return {
        content: `**${asTyped(player.name)}** is already registered to a Discord account. If that is you, ask staff — nothing was sent in game.`,
        rows: [[{ label: "Back to the roster", customId: `roster:${serverId}:0` }]],
      };
    }
    if (claimed === "unknown") {
      // Not a refusal of them — a refusal to proceed on a check that did not complete. Nothing was
      // sent in game, so trying again costs one tap.
      return {
        content: "Could not check whether that player is already registered. Nothing was sent in game — try again in a moment.",
        rows: [[{ label: "Try again", customId: again }]],
      };
    }
    const code = String(randomInt(100_000, 1_000_000)); // 6 digits, never leading-zero ambiguity
    try {
      // No app name in the player-facing message: players know their community, not the tool
      // behind it.
      await messageInGame(server, platformId, `Your Discord link code is ${code} — type it into the Discord panel. Not you? Ignore this.`);
    } catch (err) {
      log.warn("registration code send failed", { serverId, err: (err as Error).message });
      // Why is for the log: this panel is public, and a connection refused names the game
      // server's address and port.
      return { content: "Could not message you in game just now. Check you're still on the server, then try again.", rows: [[{ label: "Try again", customId: again }]] };
    }
    // A new code does not bring back the tries the last one used. Send again a minute later used
    // to restore all three — two guesses, a resend, two more — so the lockout never came. The
    // tries left carry over while the code they were spent on is still live; one left to run out
    // starts the next code fresh.
    const tries = existing?.codeHash && existing.expiresAt > now && existing.attemptsLeft < ATTEMPTS ? existing.attemptsLeft : ATTEMPTS;
    await saveChallenge(repo, ev.discordUserId, {
      serverId, platform: player.platform, platformId, playerName: player.name,
      codeHash: hashCode(code, ev.discordUserId), expiresAt: now + CODE_TTL_MS, attemptsLeft: tries, lastSentAt: now,
    });
    /*
     * Record WHO asked for this, because the message itself cannot say.
     *
     * The player-facing line deliberately carries no Discord name — putting one in would let
     * anyone print any name into another player's chat. So the accountability has to live here
     * instead: a code send is now a trail entry naming the requesting Discord account, and a
     * staff member who is asked "who made my game tell me to enter a code" can answer it.
     * The code itself is never recorded — only that a send happened, to whom, by whom.
     */
    await repo.audit.create({
      actorUserId: null, actorName: "registration", action: "player.link.code",
      targetType: "player", targetId: player.platformId, targetName: player.name, serverId,
      summary: `sent a registration code to ${player.name} on ${server.name} — requested by Discord ${ev.discordUserName || ev.discordUserId}`,
      data: { discordId: ev.discordUserId, discordName: ev.discordUserName ?? null, serverId, platformId },
    });
    return {
      content: `A 6-digit code was just sent to **${asTyped(player.name)}** in game (check the chat). It expires in 10 minutes${tries < ATTEMPTS ? ` — ${tries} ${tries === 1 ? "try" : "tries"} left` : ""}.`,
      rows: [[{ label: "Enter code", customId: "codem", style: "primary" }, { label: "Send again", customId: again }]],
    };
  };

  // The verify: modal submit with values.code. The moment of truth for the whole identity system.
  // Runs under oneStep, like sendCode: one check at a time per Discord account.
  const verify = async (ev: PublicModuleEvent): Promise<DiscordView> => {
    const c = await loadChallenge(repo, ev.discordUserId);
    const now = Date.now();
    if (c?.lockedUntil && c.lockedUntil > now) {
      return { content: "Too many wrong codes — registration is locked for a while. Ask in the staff channel if you're stuck." };
    }
    if (!c || !c.codeHash) {
      // A lapsed lockout leaves a stub with no code in it. It has nothing left to say, so it is
      // dropped rather than kept forever alongside the rows of everyone else who ever mistyped.
      if (c) await clearChallenge(repo, ev.discordUserId).catch(() => {});
      return { content: "There's no code waiting for you — start again from Link my game account." };
    }
    if (c.expiresAt < now) {
      await clearChallenge(repo, ev.discordUserId);
      return { content: "That code expired. Start again from Link my game account." };
    }
    const typed = (ev.values?.code ?? "").trim();
    if (hashCode(typed, ev.discordUserId) !== c.codeHash) {
      const attemptsLeft = c.attemptsLeft - 1;
      if (attemptsLeft <= 0) {
        await saveChallenge(repo, ev.discordUserId, { lockedUntil: now + LOCKOUT_MS } as unknown as Challenge);
        return { content: "Wrong code, and that was the last try — registration is locked for a while. Ask in the staff channel if you're stuck." };
      }
      await saveChallenge(repo, ev.discordUserId, { ...c, attemptsLeft });
      return { content: `Wrong code — ${attemptsLeft} ${attemptsLeft === 1 ? "try" : "tries"} left.`, rows: [[{ label: "Enter code", customId: "codem", style: "primary" }]] };
    }

    // Proven. Write the link — refusing, not overwriting, when either side is already claimed:
    // identity conflicts are a staff decision (the panel's manual link path), never an overwrite
    // a player can trigger from a button.
    // The challenge remembers WHICH SERVER the roster pick came from, and that server's game is what
    // this account belongs to: HLL: Vietnam issues different ids from HLL, so a row filed under the
    // wrong game is a VIP grant that reaches nobody.
    const challengeServer = await repo.servers.findById(c.serverId);
    if (!challengeServer) return { content: "That server has gone since you started — press Register again." };
    const player = await repo.players.upsert({ game: challengeServer.game, platform: c.platform, platformId: c.platformId, name: c.playerName });
    // One linked account PER GAME. The games issue different player ids, so a member who plays both
    // holds two accounts and needs both linked before a Discord purchase can land on both — an
    // existing WW2 link must not block registering the Vietnam account. What stays refused is a
    // second account for the SAME game: that is an identity conflict, and a staff decision.
    const holders = await repo.externalLinks.findPlayers("discord", ev.discordUserId);
    const sameGame = holders.find((h) => h.game === player.game && h.id !== player.id);
    if (sameGame) {
      // A second account for the game their Discord already has one on is the exact shape of ban
      // evasion — and the presser has just proven, code-in-game, that they OWN the new account.
      // The refusal below stays word-for-word what it always was: a message that says "we
      // noticed" teaches an evader to bring a fresh Discord next time, and the one they kept is
      // the only thread there is. The flag lands silently instead.
      await flagBanEvasion(repo, player, ev.discordUserId, { via: "registration (refused duplicate link)", others: holders }).catch(() => {});
      return { content: `Your Discord is already linked to **${asTyped(sameGame.name)}** for this game. Ask staff to move it if that's wrong.` };
    }
    const existingLink = (await repo.externalLinks.list(player.id)).find((l) => l.provider === "discord");
    if (existingLink && existingLink.externalId !== ev.discordUserId) {
      return { content: `**${asTyped(c.playerName)}** is already linked to a different Discord account. Ask staff to sort it out.` };
    }
    await repo.externalLinks.set(player.id, "discord", ev.discordUserId, "registration");
    // The cross-game half of the tripwire: banned on WW2, registering a Vietnam account (or the
    // reverse) links cleanly — one account per game — and is exactly when the flag must land.
    await flagBanEvasion(repo, player, ev.discordUserId, { via: "registration", others: holders }).catch(() => {});
    await repo.economy.ensureMember(ev.discordUserId, ev.discordUserName);
    await clearChallenge(repo, ev.discordUserId);
    await repo.audit.create({
      actorUserId: null, actorName: "registration", action: "player.link",
      targetType: "player", targetId: player.id, targetName: player.name,
      summary: `linked discord for ${player.name} — verified by in-game code`,
      data: { discordId: ev.discordUserId, serverId: c.serverId },
    });
    // The per-game registration role, if one is configured — best-effort, after the link is real.
    await syncGameRoles(repo, ev.discordUserId);

    const bonusBits = await applyWelcomeBonus(repo, ev.discordUserId, player);
    // No button of its own back to the panel: the host appends "‹ Menu", which goes to exactly the
    // same place and therefore carries the same custom_id. Two components with one id is a message
    // Discord refuses outright — this screen, the one that says the link worked, would never have
    // arrived.
    return {
      content: `✅ Linked! You are **${asTyped(player.name)}**.` + (bonusBits.length ? `\nWelcome bonus: ${bonusBits.join(" and ")}.` : ""),
    };
  };

  return {
    id: "vip",
    label: "VIP panel",
    // Everything that touches a game server defers; the modal-openers must not.
    deferActions: ["roster", "search", "code", "pick", "verify", "buy", "buyfor"],
    open: root,
    action: async (ev): Promise<PublicResult> => {
      switch (ev.action) {
        case "claim":
          return claim(ev);
        case "buyask":
          return confirmPurchase(ev, ev.state, null);
        // Declining a purchase. `default` would do the same thing, but a button people press to
        // NOT spend money should be findable in this switch rather than implied by falling off it.
        case "cancel":
          return root(ev);
        case "buy": {
          const [offerId = "", screen = ""] = ev.state.split(":");
          return buy(ev, offerId, null, screen);
        }
        // Gift points: pick the person (user select) → the select interaction opens the amount
        // modal with the recipient in its state → the submit moves the points.
        case "giftpick": {
          const cfg = await repo.economy.config();
          if (!cfg.gifting.enabled) return { content: "Gifting is switched off." };
          return { content: `**Gift ${cfg.currencyName}** — pick the member:`, rows: [], userSelect: { customId: "giftsel", placeholder: "Who gets them?" } };
        }
        case "giftsel": {
          const to = ev.selected?.[0];
          if (!to) return { content: "Nobody picked." };
          const cfg = await repo.economy.config();
          return { modal: { title: `Gift ${cfg.currencyName}`, action: "gift", state: to, fields: [{ id: "amount", label: `How many? (min ${Math.max(1, cfg.gifting.minAmount)})`, maxLength: 9 }] } };
        }
        case "gift": {
          const amount = Number((ev.values?.amount ?? "").trim());
          try {
            const r = await pointsGift(repo, { fromDiscordId: ev.discordUserId, toDiscordId: ev.state, amount, ref: `gift:${ev.interactionId}`, actorName: "shop", memberName: ev.discordUserName });
            const cfg = await repo.economy.config();
            if (r.status === "replay") return { content: "That gift already went through." };
            return { content: `🎁 Sent **${Math.trunc(amount)} ${cfg.currencyName}** to <@${ev.state}>. Your balance: **${r.fromBalance}**.` };
          } catch (err) {
            return { content: `❌ ${(err as Error).message}` };
          }
        }
        // Gift VIP: pick the person → pick the offer → the same purchase, different beneficiary.
        // The role gate is re-checked at every press, same as a claim's: the panel sits open
        // indefinitely, and roles are lost as well as given.
        case "giftvippick": {
          const cfg = await repo.economy.config();
          if (!cfg.vipGifting.enabled) return { content: "Gifting VIP is switched off." };
          if (!claimAllowed(cfg.vipGifting, ev.roleIds)) return { content: "Gifting VIP is for members with a particular role." };
          return { content: "**Gift VIP** — pick the member:", rows: [], userSelect: { customId: "giftvipsel", placeholder: "Who gets the VIP?" } };
        }
        case "giftvipsel": {
          const to = ev.selected?.[0];
          if (!to) return { content: "Nobody picked." };
          const cfg = await repo.economy.config();
          if (!cfg.vipGifting.enabled) return { content: "Gifting VIP is switched off." };
          if (!claimAllowed(cfg.vipGifting, ev.roleIds)) return { content: "Gifting VIP is for members with a particular role." };
          // Gated offers follow the RECIPIENT, because the gate is about where the days can land
          // — the same rule purchase() enforces. Which is why the picker asks WHO first: with
          // them chosen, this list is the offers that will actually fit them, so a Vietnam-only
          // giver sees the WW2 offer they can buy for a WW2 friend, and nobody is shown an offer
          // that would be refused after they pressed it.
          const enabled = cfg.offers.filter((o) => o.enabled);
          // Their roles are only worth a round trip if some offer is actually gated.
          const theirRoles = enabled.some((o) => (o.roleIds ?? []).length)
            ? await guildMember((await communityGuild(repo)).guildId, to)
            : null;
          if (theirRoles && theirRoles.kind !== "member") {
            return { content: theirRoles.kind === "notInGuild"
              ? `<@${to}> is not in this Discord server, so which offers they can receive cannot be checked.`
              : `Could not check which offers <@${to}> can receive (${theirRoles.reason}). Try again shortly.` };
          }
          const offers = enabled.filter((o) => offerVisible(o, theirRoles?.roleIds ?? undefined, to, true)).slice(0, 20);
          if (!offers.length) return { content: `There is nothing <@${to}> can receive — they may not be registered for the games this shop sells VIP for.` };
          const rows: DiscordButton[][] = [];
          offers.forEach((o, i) => {
            if (i % 5 === 0) rows.push([]);
            rows.at(-1)!.push({ label: `${o.label} · ${o.points}`, customId: `buyforask:${o.id}:${to}`, style: "primary" });
          });
          return { content: `**Gift VIP** for <@${to}> — pick an offer:`, rows };
        }
        // Both halves of gifting VIP re-check the gift switch and the giver's role, because the
        // panel sits open across changes to either. The ask is the same checks plus the warning.
        case "buyforask": {
          const cfg = await repo.economy.config();
          if (!cfg.vipGifting.enabled) return { content: "Gifting VIP is switched off." };
          if (!claimAllowed(cfg.vipGifting, ev.roleIds)) return { content: "Gifting VIP is for members with a particular role." };
          const sep = ev.state.indexOf(":");
          return confirmPurchase(ev, ev.state.slice(0, sep), ev.state.slice(sep + 1));
        }
        case "buyfor": {
          const cfg = await repo.economy.config();
          if (!cfg.vipGifting.enabled) return { content: "Gifting VIP is switched off." };
          if (!claimAllowed(cfg.vipGifting, ev.roleIds)) return { content: "Gifting VIP is for members with a particular role." };
          const [offerId = "", to = "", screen = ""] = ev.state.split(":");
          return buy(ev, offerId, to, screen);
        }
        case "link": {
          // The servers staff offer for registration, which is every server unless they said
          // otherwise — see registrableServers.
          const servers = await registrableServers(repo);
          if (!servers.length) return { content: "Registration isn't open on any server right now. Ask staff." };
          // Of those, only the games this member has NOT registered: a linked game's servers are
          // not options, they are the reason the flow refuses.
          const linkedGames = new Set((await repo.externalLinks.findPlayers("discord", ev.discordUserId)).map((p) => p.game));
          const open = servers.filter(({ s }) => !linkedGames.has(s.game)).slice(0, 20);
          if (!open.length) return { content: "You're already registered for every game we run. If an account needs moving, ask staff." };
          const rows: DiscordButton[][] = [];
          open.forEach(({ s, no }, i) => {
            if (i % 5 === 0) rows.push([]);
            rows.at(-1)!.push({ label: `#${no} ${s.name}`.slice(0, 80), customId: `roster:${s.id}:0` });
          });
          return { content: "**Which server are you on right now?** You need to be in game to receive the code.", rows };
        }
        case "roster": {
          const [serverId, page] = [ev.state.slice(0, ev.state.lastIndexOf(":")), Number(ev.state.slice(ev.state.lastIndexOf(":") + 1)) || 0];
          return rosterView(ev, serverId, page, "");
        }
        case "searchm":
          return { modal: { title: "Find yourself on the roster", action: "search", state: ev.state, fields: [{ id: "q", label: "Part of your in-game name", maxLength: 40 }] } };
        case "search":
          return rosterView(ev, ev.state, 0, (ev.values?.q ?? "").trim());
        case "code":
          return oneStep(ev.discordUserId, "send", () => sendCode(ev));
        // The roster dropdown: the chosen player's token arrives in `selected`, not in the id.
        case "pick": {
          const picked = ev.selected?.[0];
          if (!picked) return rosterView(ev, ev.state, 0, "");
          return oneStep(ev.discordUserId, "send", () => sendCode({ ...ev, state: `${ev.state}:${picked}` }));
        }
        case "history":
          return history(ev);
        case "leaderboard":
          return leaderboard(ev);
        case "codem":
          return { modal: { title: "Enter your link code", action: "verify", fields: [{ id: "code", label: "The 6-digit code from the game chat", placeholder: "123456", maxLength: 8 }] } };
        case "verify":
          return oneStep(ev.discordUserId, "verify", () => verify(ev));
        default:
          return root(ev);
      }
    },
  };
}

export function registerPublicModules(registry: PublicModuleRegistry, repo: Repository): void {
  registry.register(vipPublicModule(repo));
}

// The launcher message is built in discord-modules.ts, where both posters (the /staff module and
// the app's Economy screen) can reach one definition. Re-exported here because this is the module
// it opens, and that is where people look for it.
export { launcherMessage } from "./discord-modules.js";
