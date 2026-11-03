/**
 * PLACEHOLDERS — one vocabulary for every message the app sends to players.
 *
 * Staff wrote "{player_name}" and "{vip_until}" into a group message and players received the
 * braces verbatim: only the seed reward had ever filled tokens, each feature with its own copy of
 * the idea. This is the single implementation. Every path that hands staff-written text to the
 * game renders it here first, so a token means the same thing wherever it is typed.
 *
 * Cheap by construction: a text with no tokens is returned untouched with no reads at all, and a
 * renderer resolves only the tokens its text actually uses, caching what a batch shares (the
 * server's timezone, its VIP list, the currency name) across every player it renders.
 * A token it does not know, or cannot fill here (a player token in a server-wide broadcast), is
 * left exactly as typed — a visible mistake beats a silently empty sentence.
 */
import type { Repository } from "./types.js";

/** The tokens, for the panel's hint lists. `scope` says where a token can be filled. */
export const MESSAGE_PLACEHOLDERS: { token: string; label: string; scope: "player" | "server" }[] = [
  { token: "player_name", label: "the player's in-game name", scope: "player" },
  { token: "player_id", label: "the player's game id", scope: "player" },
  { token: "vip_until", label: "when their VIP on this server ends — a date, “permanent”, or “no VIP”", scope: "player" },
  { token: "vip_remaining", label: "how long their VIP has left — “2d 4h”, “permanent”, or “no VIP”", scope: "player" },
  { token: "balance", label: "their points balance (needs a linked Discord)", scope: "player" },
  { token: "currency", label: "what the community calls its points", scope: "server" },
  { token: "server_name", label: "this server's name", scope: "server" },
  { token: "map_name", label: "the map being played", scope: "server" },
  { token: "player_count", label: "how many players are on", scope: "server" },
  { token: "seed_count", label: "how many seed rounds they've been rewarded for on this server", scope: "player" },
  { token: "playtime", label: "their total time played on this server — “312h”", scope: "player" },
  { token: "players_needed", label: "how many more players until the server is seeded (0 once it's live)", scope: "server" },
  { token: "next_map", label: "the next map — staff's pick, else the vote's leader, else the rotation", scope: "server" },
];

/**
 * Tokens that take a SERVER after a colon — "{vip_until:Vietnam}" is that player's VIP on the
 * Vietnam server, read from a WW2 message. The name is matched against each server's name (the
 * staff nickname when set), its in-game name, its public name and slug, case-insensitively; then
 * any name it has had before (a rename never breaks a saved message); a game id ("hll", "hllv")
 * also works when exactly one server runs that game.
 */
export const SERVER_QUALIFIED_PLACEHOLDERS = ["vip_until", "vip_remaining"] as const;

/** `{name}` or `{name:qualifier}` — the qualifier is a server name, so it may hold spaces. */
const TOKEN_RE = /\{([a-z_]+)(?::([^{}:]{1,120}))?\}/gi;
const KNOWN = new Set(MESSAGE_PLACEHOLDERS.map((p) => p.token));
const QUALIFIED = new Set<string>(SERVER_QUALIFIED_PLACEHOLDERS);

const known = (name: string, qualifier: string | undefined) =>
  qualifier === undefined ? KNOWN.has(name) : QUALIFIED.has(name);

/** Does this text use any token this module fills? The fast path every caller takes first. */
export function hasPlaceholders(text: string | null | undefined): boolean {
  if (!text) return false;
  for (const m of text.matchAll(TOKEN_RE)) if (known(m[1]!.toLowerCase(), m[2])) return true;
  return false;
}

/**
 * The PLAYER placeholders a text uses — the ones that need one recipient to fill. A text shown to
 * the whole server at once (a broadcast, the game's welcome message, the admin-camera notice) can
 * never fill them, so every player would read the raw braces; the saves for those refuse them.
 */
export function playerPlaceholdersIn(text: string | null | undefined): string[] {
  if (!text) return [];
  const player = new Set(MESSAGE_PLACEHOLDERS.filter((p) => p.scope === "player").map((p) => p.token));
  const found = new Set<string>();
  for (const m of text.matchAll(TOKEN_RE)) {
    const name = m[1]!.toLowerCase();
    if ((m[2] === undefined && player.has(name)) || (m[2] !== undefined && QUALIFIED.has(name))) found.add(m[0]);
  }
  return [...found];
}

/** The refusal for a whole-server text that uses player placeholders, or null when it is fine. */
export function serverWideTextError(text: string | null | undefined, what: string): string | null {
  const bad = playerPlaceholdersIn(text);
  return bad.length
    ? `${bad.join(", ")} can't work in ${what} — it goes to everyone at once, so there is no one player to fill ${bad.length === 1 ? "it" : "them"} for, and every player would see the raw text. Use server placeholders ({server_name}, {map_name}, {next_map}…) there, or send a message to each player instead.`
    : null;
}

/** Time played, the way players say it: whole hours once there is one, minutes before that. */
export function playtimeSpan(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return s >= 3600 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 60)}m`;
}

/**
 * VIP time the way people talk about it — "1mo 6d" beats "756h". A month is 30 days flat (the
 * unit VIP is sold in), zero parts stay out, and anything under a day stays plain hours.
 */
export function vipSpan(hours: number): string {
  const total = Math.max(0, Math.round(hours));
  const mo = Math.floor(total / 720), d = Math.floor((total % 720) / 24), h = total % 24;
  const parts: string[] = [];
  if (mo > 0) parts.push(`${mo}mo`);
  if (d > 0) parts.push(`${d}d`);
  if (h > 0 || parts.length === 0) parts.push(`${h}h`);
  return parts.join(" ");
}

/**
 * A VIP expiration for a player to read — "Oct 3, 7:45 PM EDT" — in the server's zone
 * (serverTimezone). A bad or missing timezone falls back to UTC rather than costing the message;
 * the year is spelled only when it is not this year, because cumulative VIP can genuinely stack
 * past one.
 */
export function formatVipUntil(expirationIso: string, timezone: string | null | undefined, nowMs: number): string | null {
  const t = Date.parse(expirationIso);
  if (!Number.isFinite(t)) return null;
  const opts: Intl.DateTimeFormatOptions = {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    ...(new Date(t).getUTCFullYear() !== new Date(nowMs).getUTCFullYear() ? { year: "numeric" } : {}),
  };
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: timezone || "UTC" }).format(t);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(t);
  }
}

/**
 * The zone a server's players are told times in and have their days counted by: the server's own
 * Auto settings zone when it has one, else the community's. A server whose Auto settings were
 * never saved has no zone of its own, and reading that as UTC put players' VIP end times and their
 * play and seeding days on UTC — 8pm on the US east coast — the default the community clock was
 * set up to end. Null only when neither is readable (the caller's own fallback is UTC).
 */
export async function serverTimezone(repo: Pick<Repository, "autosettings" | "appConfig">, serverId: string): Promise<string | null> {
  const own = (await repo.autosettings.getConfig(serverId).catch(() => null))?.timezone;
  if (own) return own;
  return (await repo.appConfig.get().catch(() => null))?.timezone || null;
}

/** What the renderer may read off the live game server — only when a text asks. */
export interface LiveFacts {
  /** The session: the map in play and how many are on. */
  session(): Promise<{ mapName?: string | null; playerCount?: number | null } | null>;
  /** The game's own rotation, for {next_map} when no vote or staff pick says otherwise. */
  rotation?(): Promise<{ maps: string[]; currentIndex: number } | null>;
}

export interface RendererTarget {
  serverId: string;
  serverName: string;
  /** The server's game — which id namespace its players live in (for {vip_until:<server>}). */
  game?: string;
  /** Server-wide facts read live, only when a text asks for them (a read costs a round trip to
   *  the game). Optional: without it, {map_name}/{player_count}/{players_needed} are left as typed. */
  live?: LiveFacts;
  /** A seed round being paid right now, counted by {seed_count} before its receipt is written. */
  seedRound?: string;
  /** Pretty name for a raw map id — {next_map} from the rotation reads "Carentan — Warfare". */
  mapLabel?: (mapId: string) => string;
  /** Read each player's VIP on this server fresh, not from one batch-wide list — for a batch that
   *  WRITES VIP between renders (grant, then message), so {vip_until} reads the grant just made. */
  vipPerPlayer?: boolean;
  nowMs?: number;
}

export interface MessageRenderer {
  /** Fill the tokens this text uses, for one player (or none, for a server-wide text). */
  render(text: string, player?: { playerId: string; playerName?: string | null } | null): Promise<string>;
}

type VipFacts = { expiration: string | null; pausedAt: string | null; pausedUntil: string | null; pauseMode: "running" | "banked" | null };

/**
 * VIP wording for one grant (or none), shared by this server's and another server's token.
 *
 * A PAUSED grant is still theirs — players pay for VIP — so it never reads "no VIP". A banked pause
 * freezes the meter (the expiry moves out by the pause's length on resume), so the date is not
 * knowable yet: it reads "paused" with the time they have banked. A running pause keeps ticking,
 * so the date stands, marked as paused.
 */
function vipWords(v: VipFacts | null, tz: string | null, nowMs: number): { until: string; remaining: string } {
  if (!v) return { until: "no VIP", remaining: "no VIP" };
  const paused = v.pausedAt !== null && (v.pausedUntil === null || Date.parse(v.pausedUntil) > nowMs);
  if (v.expiration === null) return paused ? { until: "permanent (paused)", remaining: "permanent (paused)" } : { until: "permanent", remaining: "permanent" };
  if (paused && v.pauseMode === "banked") {
    const banked = Date.parse(v.expiration) - Date.parse(v.pausedAt!);
    if (banked > 0) return { until: "paused", remaining: `${vipSpan(banked / 3_600_000)} (paused)` };
  }
  const left = Date.parse(v.expiration) - nowMs;
  if (!(left > 0)) return { until: "no VIP", remaining: "no VIP" };
  const until = formatVipUntil(v.expiration, tz, nowMs) ?? "no VIP";
  const remaining = vipSpan(left / 3_600_000);
  return paused ? { until: `${until} (paused)`, remaining: `${remaining} (paused)` } : { until, remaining };
}

/**
 * A renderer for one server and one batch of sends. Everything a batch shares is read once, lazily,
 * the first time a text needs it — so messaging a whole group is one VIP-list read, not one per
 * member, and a message with no tokens reads nothing.
 */
export function messageRenderer(repo: Repository, target: RendererTarget): MessageRenderer {
  const now = () => target.nowMs ?? Date.now();
  const once = <T>(fn: () => Promise<T>, fallback: T) => {
    let p: Promise<T> | null = null;
    return () => (p ??= fn().catch(() => fallback));
  };
  const perKey = <T>(fn: (key: string) => Promise<T>, fallback: T) => {
    const m = new Map<string, Promise<T>>();
    return (key: string) => {
      let p = m.get(key);
      if (!p) { p = fn(key).catch(() => fallback); m.set(key, p); }
      return p;
    };
  };

  const tz = once(() => serverTimezone(repo, target.serverId), null);
  const vipsOn = perKey((serverId) => repo.vips.list(serverId)
    .then((rows) => new Map(rows.map((r): [string, VipFacts] => [r.playerId, {
      expiration: r.expiration, pausedAt: r.pausedAt ?? null, pausedUntil: r.pausedUntil ?? null, pauseMode: r.pauseMode ?? null,
    }]))), new Map<string, VipFacts>());
  /** One player's VIP read now — for a batch that writes VIP between renders (vipPerPlayer). */
  const vipNow = (serverId: string, playerId: string): Promise<VipFacts | null> => repo.vips.get(serverId, playerId)
    .then((r): VipFacts | null => (r ? { expiration: r.expiration, pausedAt: r.pausedAt ?? null, pausedUntil: r.pausedUntil ?? null, pauseMode: r.pauseMode ?? null } : null))
    .catch(() => null);
  const session = once(async () => (target.live ? target.live.session() : null), null);
  const currencyName = once(() => repo.economy.config().then((c) => c?.currencyName || "Points"), "Points");
  const servers = once(() => repo.servers.list(), [] as Awaited<ReturnType<Repository["servers"]["list"]>>);
  // The player record behind a platform id — this server's game first, as ids do not cross games.
  const rowOf = perKey(async (playerId) => {
    const rows = await repo.players.findByPlatformIds([playerId]);
    return rows.find((r) => !target.game || r.game === target.game) ?? rows[0] ?? null;
  }, null as Awaited<ReturnType<Repository["players"]["findByPlatformIds"]>>[number] | null);
  const discordOf = perKey(async (playerId) => {
    const row = await rowOf(playerId);
    if (!row) return null;
    return (await repo.externalLinks.list(row.id)).find((l) => l.provider === "discord")?.externalId ?? null;
  }, null as string | null);

  const balanceOf = async (playerId: string): Promise<string | null> => {
    const link = await discordOf(playerId);
    if (!link) return null;
    const member = await repo.economy.member(link).catch(() => null);
    return String(member?.balance ?? 0);
  };

  /**
   * Rounds this player was PAID for seeding here — distinct rounds, so a retry of one payout is
   * still one seed. Dry-runs, failures and bridge landings (another server's seed paid out here)
   * are not seeds of this server. The round being paid right now counts before its receipt lands.
   */
  const seedCountOf = perKey(async (playerId) => {
    const rounds = new Set<string>();
    for (let offset = 0, page = 0; page < 20; page++, offset += 500) {
      const rows = await repo.audit.list({ actions: ["seed.reward"], targetId: playerId, serverId: target.serverId, limit: 500, offset });
      for (const r of rows) {
        const d = (r.data ?? {}) as Record<string, unknown>;
        if (d.dryRun || d.failed || d.bridgeFrom) continue;
        rounds.add(typeof d.round === "string" && d.round ? d.round : `row:${r.id}`);
      }
      if (rows.length < 500) break;
    }
    if (target.seedRound) rounds.add(target.seedRound);
    return String(rounds.size);
  }, null as string | null);

  const playtimeOf = perKey(async (playerId) => {
    const row = await rowOf(playerId);
    if (!row) return playtimeSpan(0);
    const stat = (await repo.stats.visitsFor([row.id], target.serverId)).get(row.id);
    return playtimeSpan(stat?.playtimeSec ?? 0);
  }, null as string | null);

  const playersNeeded = once(async () => {
    const [cfg, s] = await Promise.all([repo.seeding.getConfig(target.serverId), session()]);
    if (!cfg || s?.playerCount == null) return null;
    return String(Math.max(0, cfg.seedTarget - s.playerCount));
  }, null as string | null);

  /**
   * The next map, in the order it will actually be decided: a staff pick overrides everything; an
   * open vote's leader is what the vote will apply (no votes yet = its first option, the same
   * default the vote uses); otherwise whatever the game's own rotation plays next.
   */
  const nextMap = once(async () => {
    // Named the way the vote announces it: the custom display name staff set, else the pretty name.
    const custom = target.game ? await repo.mapNames.list(target.game).catch(() => []) : [];
    const label = (id: string) => custom.find((n) => n.mapId.toLowerCase() === id.toLowerCase())?.displayName
      || (target.mapLabel ? target.mapLabel(id) : id);
    const [cfg, st] = await Promise.all([
      repo.mapVote.getConfig(target.serverId).catch(() => null),
      repo.mapVote.getState(target.serverId).catch(() => null),
    ]);
    if (st?.overrideMapId) return label(st.overrideMapId);
    if (cfg?.enabled && st && !st.paused && st.activeMessageId && st.options.length) {
      let best = 0;
      st.options.forEach((_, i) => { if ((st.tallies[i] ?? 0) > (st.tallies[best] ?? 0)) best = i; });
      const opt = st.options[best]!;
      return opt.name || label(opt.id);
    }
    const rot = target.live?.rotation ? await target.live.rotation() : null;
    if (!rot?.maps.length) return null;
    return label(rot.maps[(rot.currentIndex + 1) % rot.maps.length]!);
  }, null as string | null);

  /**
   * The server a "{vip_until:<name>}" means, and the id this player has THERE. Same game: the same
   * id. Another game: ids do not cross games, so the join is the one registration built and the
   * seed-reward bridge uses — the player's Discord link, and that game's account under it.
   */
  const serverNamed = async (q: string) => {
    const want = q.trim().toLowerCase();
    const list = await servers();
    const byName = list.find((sv) => [sv.name, sv.gameName, sv.nickname, sv.publicName, sv.publicSlug]
      .some((n) => n && n.trim().toLowerCase() === want));
    if (byName) return byName;
    // A name the server USED to have — a message saved before a rename keeps working. Checked
    // only after every current name, so a server now called X always beats one that once was.
    const byFormer = list.find((sv) => (sv.formerNames ?? []).some((n) => n.trim().toLowerCase() === want));
    if (byFormer) return byFormer;
    const byGame = list.filter((sv) => sv.game.toLowerCase() === want);
    return byGame.length === 1 ? byGame[0]! : null;
  };
  const idOn = async (playerId: string, server: { id: string; game: string }): Promise<string | null | "unlinked"> => {
    if (server.id === target.serverId || !target.game || server.game === target.game) return playerId;
    const link = await discordOf(playerId);
    if (!link) return "unlinked";
    const accounts = await repo.externalLinks.findPlayers("discord", link);
    return accounts.find((a) => a.game === server.game)?.platformId ?? "unlinked";
  };

  return {
    async render(text, player) {
      if (!hasPlaceholders(text)) return text;
      const used = [...text.matchAll(TOKEN_RE)].map((m) => ({ name: m[1]!.toLowerCase(), q: m[2] }));
      const has = (name: string) => used.some((u) => u.name === name && u.q === undefined);
      // No prototype: "{constructor}" must stay as typed, never become Object's source text.
      const vars: Record<string, string> = Object.create(null);
      const set = (k: string, v: string | null | undefined) => { if (v != null) vars[k] = v; };
      vars.server_name = target.serverName;
      if (has("currency")) vars.currency = await currencyName();
      if (has("map_name") || has("player_count")) {
        const s = await session();
        if (s?.mapName) vars.map_name = s.mapName;
        if (s?.playerCount != null) vars.player_count = String(s.playerCount);
      }
      if (has("players_needed")) set("players_needed", await playersNeeded());
      if (has("next_map")) set("next_map", await nextMap());
      if (player?.playerId) {
        const id = player.playerId;
        vars.player_id = id;
        if (has("player_name")) vars.player_name = player.playerName || (await rowOf(id))?.name || id;
        if (has("vip_until") || has("vip_remaining")) {
          const own = target.vipPerPlayer ? await vipNow(target.serverId, id) : (await vipsOn(target.serverId)).get(id) ?? null;
          const w = vipWords(own, await tz(), now());
          vars.vip_until = w.until; vars.vip_remaining = w.remaining;
        }
        if (has("balance")) set("balance", await balanceOf(id));
        if (has("seed_count")) set("seed_count", await seedCountOf(id));
        if (has("playtime")) set("playtime", await playtimeOf(id));
        for (const u of used) {
          if (u.q === undefined || !QUALIFIED.has(u.name)) continue;
          const key = `${u.name}:${u.q}`;
          if (key in vars) continue;
          const server = await serverNamed(u.q).catch(() => null);
          if (!server) continue; // an unknown server name stays as typed — a visible typo
          const there = await idOn(id, server).catch(() => null);
          if (there === null) continue;
          if (there === "unlinked") { vars[key] = "not linked"; continue; }
          // Fresh in a grant-then-message batch, exactly like the plain token: "{vip_until:WW2}"
          // written on the WW2 server is the same VIP, and read from the batch's one list it showed
          // every player after the first their time from BEFORE the grant.
          const facts = target.vipPerPlayer ? await vipNow(server.id, there) : (await vipsOn(server.id)).get(there) ?? null;
          const w = vipWords(facts, await tz(), now());
          vars[key] = u.name === "vip_until" ? w.until : w.remaining;
        }
      }
      return text.replace(TOKEN_RE, (m, k: string, q: string | undefined) => vars[q === undefined ? k.toLowerCase() : `${k.toLowerCase()}:${q}`] ?? m);
    },
  };
}
