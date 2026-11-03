/**
 * THE feature registry — the single declaration point that makes a per-server feature automatable.
 *
 * One FeatureDef here buys a feature, with no further code anywhere:
 *   - an "app:<id>.enabled" switch (Auto settings profiles can turn it on/off),
 *   - named presets (snapshot/apply of its whole behaviour config) with API routes, profile
 *     "preset:<id>" keys, worker application and the editors' PresetBar — all derived,
 *   - capability-gated access using the feature's own config capability.
 *
 * The derivations are generic on purpose — this is what "scalable for new features" means:
 *   - the SWITCH is always the config row's `enabled` flag, applied through patchConfig;
 *   - a PRESET is the config row minus identity (serverId/updatedAt), minus the arming switches
 *     (enabled/dryRun — applying behaviour must never arm anything), minus `presetExclude`
 *     (per-server plumbing like a Discord channel id that a community-wide preset must not carry).
 *
 * To add a feature: give it a config row with enabled/dryRun switches, write the one entry below
 * (two repo lambdas + any excludes), and — if it should have a toolbar — drop <PresetBar> into its
 * editor. That's the whole checklist.
 */
import type { Repository } from "./types.js";

export interface FeatureDef {
  /** short id: routes (/presets/<id>), profile keys (app:<id>.enabled, preset:<id>). */
  id: string;
  label: string;
  /** the capability gating this feature's config — presets and switches inherit it. */
  capability: string;
  /** what the app:<id>.enabled switch controls, for the editor's blurb. */
  description: string;
  getConfig(repo: Repository, serverId: string): Promise<Record<string, unknown> | null>;
  patchConfig(repo: Repository, serverId: string, patch: Record<string, unknown>): Promise<void>;
  /** per-server plumbing a community-wide preset must not carry (e.g. Discord channel ids). */
  presetExclude?: string[];
  /** a feature whose config is mostly per-server plumbing can opt out of presets and keep the
   *  switch — the registry entry still exists, so opting back in later is deleting one flag. */
  offersPresets?: boolean;
  /**
   * True when the feature's config only means something against ONE game's tables — raw role
   * numbers, map ids, weapon names. A preset of a game-scoped feature refuses to apply to a
   * server running a different game: role 13 is HLL's Commander and Vietnam's Mortar Support,
   * so applying across games would silently enforce the wrong policy. Broadcast messages, by
   * contrast, are just text and travel freely.
   */
  gameScoped?: boolean;
}

export const FEATURES: FeatureDef[] = [
  {
    id: "broadcast",
    label: "Broadcast rotation",
    capability: "broadcast.config",
    description: "The rotating server-broadcast messages.",
    getConfig: async (repo, serverId) => (await repo.broadcast.getConfig(serverId)) as Record<string, unknown> | null,
    patchConfig: async (repo, serverId, patch) => { await repo.broadcast.upsertConfig(serverId, patch as never); },
  },
  {
    id: "mapvote",
    label: "Map vote",
    capability: "mapvote.config",
    description: "The automated match-end map vote.",
    getConfig: async (repo, serverId) => (await repo.mapVote.getConfig(serverId)) as Record<string, unknown> | null,
    patchConfig: async (repo, serverId, patch) => { await repo.mapVote.setConfig(serverId, patch as never); },
    // Each server posts its poll into its own channel — a preset repointing that would aim every
    // server at one channel.
    presetExclude: ["channelId"],
    gameScoped: true, // the pool is map ids from one game's catalogue
  },
  {
    id: "seeding",
    label: "Seeding automation",
    capability: "seeding.config",
    description: "Seeding enforcement and the seed reward (VIP time, points, or both).",
    getConfig: async (repo, serverId) => (await repo.seeding.getConfig(serverId)) as Record<string, unknown> | null,
    patchConfig: async (repo, serverId, patch) => { await repo.seeding.upsertConfig(serverId, patch as never); },
    gameScoped: true, // disallowed roles are raw role numbers; weapon names/classes are per-game tables
    // The ground rules never ride a preset, in either direction. Presets are saved and applied
    // under seeding.config alone, and apply writes to the store directly — a preset that carried
    // these would let a staffer overwrite (or arm) rules that take the rules permission to change,
    // straight past the fence the seeding PUT holds. They are configured on Map zones and nowhere
    // else; a preset is the rest of the seeding behaviour.
    //
    // Nor does the reward bridge. Its stops are this server's wiring (seed here, get VIP on THAT
    // server), not behaviour, and the seeding PUT judges every stop it is given: never the server
    // itself (a stop there pays the round twice), never one retired, and only with the VIP key on
    // the stop's server. A preset carried it past all three.
    presetExclude: [
      "containEnabled", "containAutoEnabled", "positionalEnabled", "containGraceSec", "containMaxPlayers",
      "containNotice", "containZones", "paceEnabled", "paceUnlockMinutes", "paceNotice", "layoutLearnEnabled",
      "rewardBridge",
    ],
  },
  {
    id: "discordRelay",
    label: "Discord relay",
    capability: "discord.relay",
    description: "The per-server Discord event relay.",
    getConfig: async (repo, serverId) => (await repo.discordRelay.getConfig(serverId)) as Record<string, unknown> | null,
    patchConfig: async (repo, serverId, patch) => { await repo.discordRelay.upsertConfig(serverId, patch as never); },
    // Relay config is channel ids nearly wall to wall; a preset stripped of them would be empty.
    offersPresets: false,
  },
];

/** Keys never carried by a preset: row identity, and the arming switches (behaviour only — a
 *  preset that could set `enabled` would arm features as a side effect of applying content). */
const PRESET_STRIP = ["serverId", "updatedAt", "enabled", "dryRun"];

// ---- derived: the "app:" switches (profiles turning features on/off) ----

export interface AppSettingDef {
  key: string;
  label: string;
  kind: "bool";
  description: string;
  apply(repo: Repository, serverId: string, value: boolean): Promise<void>;
}

export const APP_SETTINGS: AppSettingDef[] = FEATURES.map((f) => ({
  key: `app:${f.id}.enabled`,
  label: f.label,
  kind: "bool" as const,
  description: f.description,
  apply: async (repo, serverId, value) => { await f.patchConfig(repo, serverId, { enabled: value }); },
}));

export function getAppSetting(key: string): AppSettingDef | undefined {
  return APP_SETTINGS.find((s) => s.key === key);
}

/** True for keys the app-setting family owns (everything else in a settings map is a game field). */
export function isAppSettingKey(key: string): boolean {
  return key.startsWith("app:");
}

// ---- derived: the presettable features (snapshot/apply of behaviour config) ----

export interface FeaturePresetDef {
  feature: string;
  label: string;
  capability: string;
  /** see FeatureDef.gameScoped — carried here so every apply path can run the same guard. */
  gameScoped: boolean;
  snapshot(repo: Repository, serverId: string): Promise<Record<string, unknown>>;
  apply(repo: Repository, serverId: string, config: Record<string, unknown>): Promise<void>;
}

/**
 * The cross-game guard every preset-apply path runs (the API route AND the worker's profile
 * `preset:` keys — one rule, two doors). Returns the refusal message, or null when the apply is
 * fine. A legacy preset with no recorded game is allowed through: refusing it would brick every
 * preset saved before the game was stamped, and the common single-game install was never at risk.
 */
export function presetGameMismatch(
  def: Pick<FeaturePresetDef, "gameScoped" | "label">,
  presetGame: string | null | undefined,
  serverGame: string,
): string | null {
  if (!def.gameScoped || !presetGame || presetGame === serverGame) return null;
  return `this ${def.label} preset was saved from a ${presetGame} server and cannot apply to a ${serverGame} server — its ids mean different things there`;
}

function stripKeys(body: Record<string, unknown>, extra: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (PRESET_STRIP.includes(k) || extra.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Player rules are the one presettable feature that is not a single config row — they are a
 * LIST, so they cannot be derived from FeatureDef's getConfig/patchConfig and are written out
 * here instead.
 *
 * A saved setup captures the rules PINNED TO THIS SERVER. Community-wide rules (serverId null)
 * are deliberately left out: they already apply to every server including the new one, so
 * copying them in would turn one policy into a per-server duplicate of itself — and the next
 * edit would then have to be made in as many places as you have servers.
 *
 * Applying replaces this server's pinned rules and leaves community-wide policy untouched, which
 * is the same promise the other features make: a saved setup replaces the thing it is a setup
 * FOR, and nothing else.
 */
/** The section a saved setup names, found by name (ignoring case) and made when missing — the
 *  setup said these rules sit together, and a section is only a label. Null for none. */
/** A rule's identity, bookkeeping and passing state — never part of what it does. `sectionOff`
 *  is read from the section's switch and a pause lifts itself: a setup saved while a section was
 *  off or a rule was paused (or before either existed) must still recognise the rule as unchanged,
 *  or applying it would delete and remake it — and a setup must never carry a pause to a server. */
const RULE_IDENTITY_KEYS = new Set(["id", "serverId", "createdAt", "updatedAt", "sectionId", "section", "sectionOff", "pausedUntil", "pauseReason", "pausedBy"]);

/** JSON with object keys sorted and undefined left out: two values that mean the same compare equal. */
function stableJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x as Record<string, unknown>).sort()) {
        const val = (x as Record<string, unknown>)[k];
        if (val !== undefined) out[k] = norm(val);
      }
      return out;
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

async function sectionNamed(repo: Repository, raw: unknown): Promise<string | null> {
  const name = typeof raw === "string" ? raw.trim().slice(0, 200) : "";
  if (!name) return null;
  const found = (await repo.ruleSections.list()).find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (found) return found.id;
  try {
    return (await repo.ruleSections.create(name)).id;
  } catch {
    // Made by somebody else in the meantime: theirs is the one.
    return (await repo.ruleSections.list()).find((x) => x.name.toLowerCase() === name.toLowerCase())?.id ?? null;
  }
}

const RULES_PRESET: FeaturePresetDef = {
  feature: "rules",
  label: "Player rules",
  capability: "admin.moderation",
  // Rules travel between games: the trigger vocabulary is shared, and the rest is text, numbers
  // and Discord ids. State-trigger params CAN name role numbers (tank roles, helicopter roles),
  // but the worker only runs a state rule on games its trigger applies to, so a rule carried to
  // the other game's server is inert rather than wrong.
  gameScoped: false,
  snapshot: async (repo, serverId) => {
    const mine = (await repo.enforcerRules.list()).filter((r) => r.serverId === serverId);
    const sectionName = new Map((await repo.ruleSections.list()).map((x) => [x.id, x.name]));
    // Identity and bookkeeping are dropped; everything that describes BEHAVIOUR is kept — the
    // ladder, the gates, the exemptions, the trial switch and the alert routing included. The
    // Rules page section travels by NAME (an id means nothing on the server it is applied to).
    const rules = mine.map(({ id: _id, serverId: _s, createdAt: _c, updatedAt: _u, sectionId, sectionOff: _off, pausedUntil: _pu, pauseReason: _pr, pausedBy: _pb, ...rest }) => ({
      ...rest,
      section: sectionId ? sectionName.get(sectionId) ?? null : null,
    }));
    return { rules };
  },
  apply: async (repo, serverId, config) => {
    const raw = (config as { rules?: unknown }).rules;
    const wanted = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
    /*
     * A rule the setup describes exactly as it already stands is KEPT, not deleted and made again.
     * The worker applies a server's active setups on every profile change and after every
     * reconnect, and a rule made again is a new rule: its per-player limits and VIP cooldowns
     * forget who they counted, and a schedule's "came round before it was saved" guard reads the
     * fresh save as an edit — a monthly grant whose midnight a reconnect landed on never ran. Only
     * rules that differ in behaviour are replaced; everything else is left as it is.
     */
    const sectionName = new Map((await repo.ruleSections.list()).map((x) => [x.id, x.name]));
    const behaviour = (r: Record<string, unknown>, section: unknown) => {
      const rest: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) if (!RULE_IDENTITY_KEYS.has(k)) rest[k] = v;
      rest.section = typeof section === "string" && section.trim() ? section.trim().toLowerCase() : null;
      return stableJson(rest);
    };
    const standing = new Map<string, string[]>();
    const mine = (await repo.enforcerRules.list()).filter((r) => r.serverId === serverId);
    for (const r of mine) {
      const key = behaviour(r as unknown as Record<string, unknown>, r.sectionId ? sectionName.get(r.sectionId) ?? null : null);
      standing.set(key, [...(standing.get(key) ?? []), r.id]);
    }
    const keep = new Set<string>();
    const fresh: Record<string, unknown>[] = [];
    for (const r of wanted) {
      const id = standing.get(behaviour(r, r.section))?.shift();
      if (id) keep.add(id); else fresh.push(r);
    }
    for (const r of mine) if (!keep.has(r.id)) await repo.enforcerRules.remove(r.id);
    for (const r of fresh) {
      // Pinned to the server being applied to, whatever the snapshot said — a setup is being
      // applied HERE. Identity keys are stripped for the same reason as the other features:
      // a hand-edited row must not be able to smuggle one in.
      const rest: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (RULE_IDENTITY_KEYS.has(k)) continue;
        rest[k] = v;
      }
      await repo.enforcerRules.create({ ...rest, serverId, sectionId: await sectionNamed(repo, r.section) } as never);
    }
  },
};

export const FEATURE_PRESETS: FeaturePresetDef[] = [
  ...FEATURES
    .filter((f) => f.offersPresets !== false)
    .map((f) => ({
      feature: f.id,
      label: f.label,
      capability: f.capability,
      gameScoped: f.gameScoped === true,
      snapshot: async (repo: Repository, serverId: string) => {
        const c = await f.getConfig(repo, serverId);
        return c ? stripKeys(c, f.presetExclude) : {};
      },
      // Stripped again on the way back in: preset bodies are our own snapshots, but an old row
      // (or a hand-edited one) must not be able to smuggle a switch through apply.
      apply: async (repo: Repository, serverId: string, config: Record<string, unknown>) => {
        await f.patchConfig(repo, serverId, stripKeys(config, f.presetExclude));
      },
    })),
  RULES_PRESET,
];

export function getFeaturePreset(feature: string): FeaturePresetDef | undefined {
  return FEATURE_PRESETS.find((p) => p.feature === feature);
}
