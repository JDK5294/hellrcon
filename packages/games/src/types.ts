/**
 * Game-module contracts. A game module bundles everything game-specific behind one seam:
 *
 *   - `commands`   — the logical→wire command table the RCON adapters resolve against
 *   - `normalizeLine` — raw admin-log line → canonical `evt.*` event
 *   - `descriptor` — JSON-safe domain data (teams, roles, score fields, config schema) that the
 *                    API serves and the panel renders from, so the UI stays game-agnostic
 *
 * Core (rcon-core, ingest, api, panel) resolves a module by `server.game` and never imports a
 * game's data directly. Adding a game = registering a new module; no core changes.
 */
import type { CommandTable } from "@app/rcon-core";
import type { Evt } from "@app/events";

// ---- descriptor: JSON-safe domain data (no functions — it crosses the API) ----

/** One faction/side. `teamValues` are the raw team numbers the game reports for it; `parity`
 *  is an optional fallback rule when a value isn't listed (HLL: allies odd, axis even). */
export interface GameSide {
  id: string;
  label: string;
  teamValues: number[];
  parity?: "even" | "odd";
  /** UI hint for consistent side coloring. */
  color?: "blue" | "red" | "neutral";
}

export interface GameScoreField {
  /** key inside the live player's `scoreData` object. */
  key: string;
  label: string;
  title?: string;
}

/** One editable server setting: how to read it, how to write it, and how to render it. */
export interface GameConfigField {
  field: string;
  label: string;
  kind: "bool" | "num" | "str";
  read?: { command: string; key: string };
  write?: { command: string; param: string };
  min?: number;
  max?: number;
}

/** One entry of a rotation or play-queue answer, as the game describes it. */
export interface GameMapListEntry {
  /** the id the answer gives — the rotation's layer id, or the play queue's level path. */
  id: string;
  /** the game's own words for the entry: "ST MARIE DU MONT", "Skirmish", "Day". */
  name: string;
  gameMode: string;
  timeOfDay: string;
}

/**
 * One bucket a weapon can fall into, for kill/death-type breakdowns on a player profile. Games name
 * their weapons freely, so the grouping has to come from the game module rather than the panel:
 * `patterns` are case-insensitive substrings matched against the weapon string the log reported, in
 * descriptor order (first match wins), with anything unmatched landing in "Other".
 */
export interface GameWeaponClass {
  id: string;
  label: string;
  patterns: string[];
  /** marks the melee bucket, which profiles report on separately (melee kills, melee streak). */
  melee?: boolean;
}

export interface GameDescriptor {
  id: string;
  label: string;
  /** factions, in display order (first two drive side-by-side team stats). */
  sides: GameSide[];
  /** numeric role id → display label. */
  roles: Record<number, string>;
  /** roles that count as a squad's leader (for "squad has no leader" warnings). */
  squadLeaderRoles: number[];
  /** what this game calls a squad/platoon (UI label). */
  squadLabel: string;
  /**
   * Squad type → the roles only that type of squad offers ("armor" → Crewman, Tank Commander).
   * The game does not offer a role across types, so a squad's type is read off any member's
   * role. The army commander belongs to no squad and is in none. Omitted by games without
   * typed squads.
   */
  squadTypes?: Record<string, number[]>;
  /** per-player score buckets shown on scoreboards, in display order. */
  scoreFields: GameScoreField[];
  /** editable server settings (drives the config editor). */
  configFields: GameConfigField[];
  /** weapon buckets for kill/death-type breakdowns; omitted by games that don't classify weapons. */
  weaponClasses?: GameWeaponClass[];
  /**
   * Every weapon name the game writes into a kill log, verbatim — the catalogue an individual-
   * weapon picker offers (some weapons are overpowered on a quiet server while their whole class
   * is fine). Grouping for display is computed via classifyWeapon, never stored. Omitted by games
   * without a verified name table; pickers then fall back to class chips + free text.
   */
  weaponCatalog?: string[];
  /**
   * Commander abilities that KILL, exactly as a kill line's weapon field spells them. Separate
   * from weaponCatalog because staff think of them as a different lever — "no commander strikes
   * while seeding" — not as one more gun. Omitted by games without commander kill abilities.
   */
  commanderAbilities?: string[];
}

/**
 * The normalized live-player shape adapters must produce from `readState("players")` (either an
 * array or `{ players: [...] }`). Every field is optional — the panel renders what's present and
 * hides the rest — but the KEYS are the contract; adapters map their game's raw output onto them.
 */
export interface NormalizedLivePlayer {
  /** game platform id (Steam64 / GamerTag hash / …) — required for actions + profile links. */
  iD?: string;
  id?: string;
  name?: string;
  clanTag?: string;
  level?: number;
  platform?: string;
  /** raw team number; the descriptor's sides map it to a faction. */
  team?: number;
  /** raw role number; the descriptor's roles map it to a label. */
  role?: number;
  /** squad name + index, if the game has squads. */
  platoon?: string;
  platoonIndex?: number;
  loadout?: string;
  /** per-game score buckets — keys must match the descriptor's scoreFields. */
  scoreData?: Record<string, number>;
  stats?: { infantryKills?: number; vehicleKills?: number; deaths?: number; teamKills?: number };
}

// ---- identity: how a live player becomes (or matches) a database row ----

/**
 * How this game's roster answers map onto our player identity.
 *
 * `platformId` is the value that keys the players table — the one identity a human has across
 * every server and game we track. `links` are OTHER namespaces the same payload names the player
 * in, stored in external_links so they stay searchable without becoming a second person.
 *
 * This is a per-game decision, not a formatting detail. HLL reports the platform id directly.
 * HLL: Vietnam keys everyone by a per-game EOS id and reports the Steam64 alongside it for Steam
 * players — so its module must key on the Steam64 when present (same human as their HLL profile)
 * and fall back to the EOS id only when there is nothing better. Getting this wrong forks one
 * person into twin rows, which is cheap to do and expensive to unpick; the module is the only
 * place that knows which of its fields is the durable one.
 */
export interface PlayerIdentity {
  platform: string;
  platformId: string;
  /** other id namespaces from the same payload, for external_links: [{provider, externalId}]. */
  links?: { provider: string; externalId: string }[];
}

// ---- the module itself ----

export interface GameModule {
  id: string;
  label: string;
  /** wire protocols this game's servers can be reached over (must have adapters in rcon-core).
   *  Drives the Add Server form's protocol options and create-time validation. */
  protocols: { id: string; label: string }[];
  /** logical→wire command table for the RCON adapters. */
  commands: CommandTable;
  /** raw admin-log line → canonical event (null = unrecognized). */
  normalizeLine: (line: string, ctx: { serverId: string; ts?: string }) => Evt | null;
  /** stable identity for a raw log line ACROSS POLLS (drives ingest dedup). Must strip any
   *  volatile prefix (relative ages etc.) and keep a timestamp when the format has one — a key
   *  that collides for two distinct events silently drops the second one. */
  logLineKey: (line: string) => string;
  /** how to understand this game's `readState` answers (the inverse of `commands`). */
  stateReader: GameStateReader;
  /** which of a live player's fields is the durable identity (see PlayerIdentity). Optional:
   *  games whose reported id IS the platform id can rely on the shared default. */
  identity?: (pl: Record<string, unknown>) => PlayerIdentity | null;
  descriptor: GameDescriptor;
}

/**
 * Reading a `readState` response.
 *
 * The command table says how to ASK; this says how to understand the answer. It lives on the game
 * module because the field names involved are the game's own — the API and the worker each used to
 * carry a private copy of these parsers, spelling HLL's keys into code that is meant to work for
 * any game, and the two copies drifted apart until they disagreed about what a server had said.
 *
 * Every parser degrades rather than throws: an unrecognised answer is an empty list or a null
 * count, never an exception thrown into a poll loop.
 */
export interface GameStateReader {
  /** the map rotation, and where in it the server currently sits. */
  rotation(raw: unknown): { maps: string[]; currentIndex: number };
  /** the rotation entry the game plays next (the one after its own place, not the first), or null
   *  when the answer does not say where the game is. */
  nextInRotation(raw: unknown): number | null;
  /** whether the game shuffles its play order; null when the answer does not say. */
  mapShuffle(raw: unknown): boolean | null;
  /** a rotation or play-queue answer's entries, with the game's description of each. */
  mapEntries(raw: unknown): GameMapListEntry[];
  /** every map id the server will accept. */
  mapCatalogue(raw: unknown): string[];
  /** players online. Null means the answer did not say — which is not zero. */
  playerCount(raw: unknown): number | null;
}
