/**
 * Clan tags — one main tag for every spelling of it.
 *
 * Players type their clan tags however they like, and the same clan arrives as `[ABC]`, `ᴀʙᴄ`,
 * `A.B.C`, `𝔸𝔹ℂ★` and `ＡＢＣ`. Grouping them by exact text splits one clan across a dozen rows,
 * so every spelling gets a FOLD KEY first: the letters it is made of, with the styling taken off.
 * Spellings with the same key are one clan automatically.
 *
 * Folding cannot know everything — a sister tag that shares nothing with the main one, or two
 * different clans that happen to fold alike — so staff can also combine groups and split a
 * spelling back out (Players → Clans). Those choices are kept in `ClanTagSettings` and applied on
 * top of the fold. Everything here is pure: (settings, spellings) → groups, (settings, choice) →
 * settings. The API, the Clans tab and the rules trigger all read the same answers from it.
 */

/** Staff choices on top of the automatic fold. Keys are described on `clanGroupOf`. */
export interface ClanTagSettings {
  /**
   * Where a spelling or a whole fold group belongs: `"s:<spelling>"` → a main key (one spelling
   * moved — split out, or combined into another group), `"k:<fold key>"` → a main key (a whole
   * automatic group combined into another). Every value is a FINAL main key; combining repoints
   * the old entries, so no lookup ever follows a chain.
   */
  merges: Record<string, string>;
  /** Main key → the name staff gave the group. Absent = its most-worn spelling. */
  labels: Record<string, string>;
}

export const CLAN_TAG_SETTINGS_DEFAULTS: ClanTagSettings = { merges: {}, labels: {} };

/** How long after a player's own last sighting their newest tag still counts as worn now. The
 *  roster records tags once a minute; the player's last seen also moves on log lines (a kill, the
 *  disconnect), so a tag a few minutes older than the player is still the one they had on. */
export const CLAN_CURRENT_GRACE_SEC = 15 * 60;

/** Bounds on what one install can store — far past any real community, short of a runaway list. */
export const CLAN_MERGES_MAX = 5000;
export const CLAN_LABEL_MAX = 40;

/**
 * Letters that LOOK like Latin ones and that fancy-text generators and players use in their place:
 * small capitals, Cyrillic and Greek lookalikes. Unicode normalisation (NFKC) already turns the
 * fullwidth, circled, squared, superscript and mathematical alphabets back into plain letters;
 * these have no such mapping, so they are listed. `ǫ` is here because the generators' small-capital
 * "q" is that letter, and decomposing it would read it as an "o".
 */
const LOOKALIKES: Record<string, string> = {
  // small capitals
  "ᴀ": "a", "ʙ": "b", "ᴄ": "c", "ᴅ": "d", "ᴇ": "e", "ꜰ": "f", "ɢ": "g", "ʜ": "h", "ɪ": "i", "ᴊ": "j",
  "ᴋ": "k", "ʟ": "l", "ᴍ": "m", "ɴ": "n", "ᴏ": "o", "ᴘ": "p", "ǫ": "q", "ʀ": "r", "ꜱ": "s", "ᴛ": "t",
  "ᴜ": "u", "ᴠ": "v", "ᴡ": "w", "ʏ": "y", "ᴢ": "z", "ɡ": "g",
  // Cyrillic that reads as Latin
  "А": "a", "В": "b", "Е": "e", "К": "k", "М": "m", "Н": "h", "О": "o", "Р": "p", "С": "c", "Т": "t",
  "У": "y", "Х": "x", "Ѕ": "s", "І": "i", "Ј": "j", "Ԛ": "q", "Ԝ": "w", "Ь": "b",
  "а": "a", "е": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y",
  "х": "x", "ѕ": "s", "і": "i", "ј": "j", "ԛ": "q", "ԝ": "w", "ь": "b",
  // Greek that reads as Latin
  "Α": "a", "Β": "b", "Ε": "e", "Ζ": "z", "Η": "h", "Ι": "i", "Κ": "k", "Μ": "m", "Ν": "n", "Ο": "o",
  "Ρ": "p", "Τ": "t", "Υ": "y", "Χ": "x", "Ϲ": "c",
  "α": "a", "β": "b", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u",
  "χ": "x", "ω": "w", "ϲ": "c", "ϳ": "j",
};

/** Letter blocks with no normalisation of their own: negative circled (🅐), negative squared (🅰)
 *  and regional indicators (🇹 — players spell tags in flag letters). */
const LETTER_BLOCKS: [number, number][] = [[0x1f150, 0x1f169], [0x1f170, 0x1f189], [0x1f1e6, 0x1f1ff]];

function plainLetter(ch: string): string {
  const mapped = LOOKALIKES[ch];
  if (mapped) return mapped;
  const cp = ch.codePointAt(0) ?? 0;
  for (const [lo, hi] of LETTER_BLOCKS) if (cp >= lo && cp <= hi) return String.fromCharCode(97 + cp - lo);
  return ch;
}

/**
 * The letters and digits a tag is made of, styling removed: `[ABC]`, `ᴀʙᴄ`, `A.B.C`, `𝔸𝔹ℂ★`,
 * `ＡＢＣ` and `abc` all fold to `abc`. Digits are kept as they are (a `101st` is not an `ioist`),
 * and letters of any script survive, so a tag written in Cyrillic still has a key of its own. A
 * tag made only of symbols or emoji keeps its exact spelling (lower-cased, marked with `~`), so
 * `★★` and `☠☠` stay two tags instead of collapsing into one empty one.
 */
export function clanFoldKey(raw: string): string {
  const text = raw.trim();
  const plain = Array.from(text.normalize("NFKC"), plainLetter).join("")
    .normalize("NFD").replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
  return plain || `~${text.toLowerCase()}`;
}

const SPELLING = "s:";
const FOLD = "k:";

/**
 * The main key a spelling belongs to: a spelling moved on its own first (split out, or combined
 * one by one), then its whole fold group's destination, else the fold key itself. A split
 * spelling's key is `s:<spelling>` — which no fold key can equal, since fold keys hold no colon.
 */
export function clanGroupOf(settings: ClanTagSettings, spelling: string): string {
  const tag = spelling.trim();
  const own = settings.merges[SPELLING + tag];
  if (own) return own;
  const fold = clanFoldKey(tag);
  return settings.merges[FOLD + fold] ?? fold;
}

/**
 * A main key saved earlier (in a rule, a link), as it reads under today's settings. Combining
 * repoints a group's fold entry, so a rule naming an absorbed group follows it into the group it
 * joined; a split spelling's key that has since been reset is read as the spelling again.
 */
export function clanResolveKey(settings: ClanTagSettings, key: string): string {
  if (key.startsWith(SPELLING)) return clanGroupOf(settings, key.slice(SPELLING.length));
  return settings.merges[FOLD + key] ?? key;
}

/** Every spelling, grouped under its main key. */
export function groupClanSpellings(settings: ClanTagSettings, spellings: Iterable<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const s of spellings) {
    const key = clanGroupOf(settings, s);
    const list = out.get(key);
    if (list) list.push(s); else out.set(key, [s]);
  }
  return out;
}

/**
 * The name staff gave a group, if they gave it one. Read as an OWN key: a fold key is the tag's
 * bare letters, so a clan tagged "CONSTRUCTOR" is keyed "constructor" — which every plain object
 * answers with its constructor function, and that broke the whole Clans tab.
 */
export function clanGroupName(settings: ClanTagSettings, key: string): string | undefined {
  return Object.hasOwn(settings.labels, key) ? settings.labels[key] : undefined;
}

/** A group's name: what staff called it, else its most-worn spelling, else the key. */
export function clanLabel(settings: ClanTagSettings, key: string, spellings: { tag: string; ever: number; lastSeen: string | null }[]): string {
  const named = clanGroupName(settings, key);
  if (named) return named;
  const best = [...spellings].sort((a, b) => b.ever - a.ever || String(b.lastSeen ?? "").localeCompare(String(a.lastSeen ?? "")))[0];
  return best?.tag ?? (key.startsWith(SPELLING) ? key.slice(SPELLING.length) : key);
}

/** Point every entry that names `from` at `to` instead. */
function repoint(merges: Record<string, string>, from: string, to: string): void {
  for (const [k, v] of Object.entries(merges)) if (v === from) merges[k] = to;
}

/**
 * Which of several groups stays when they are combined: the first automatic (fold) group among
 * them, else the first. A split spelling's key is that one spelling's — a combined clan anchored
 * on it could never let that spelling go again — so it stays only when every group is one.
 */
export function clanCombineTarget(keys: string[]): string | undefined {
  const unique = [...new Set(keys.filter(Boolean))];
  return unique.find((k) => !k.startsWith(SPELLING)) ?? unique[0];
}

/**
 * Make several groups one. `keys` are current main keys; `clanCombineTarget` picks the one that
 * stays, and `label` (when given) becomes its name. Every other group is pointed at it — its own
 * entries repointed, and its fold group (or split spelling) sent there — and loses its name.
 */
export function combineClanGroups(settings: ClanTagSettings, keys: string[], label?: string | null): ClanTagSettings {
  const target = clanCombineTarget(keys);
  const rest = [...new Set(keys.filter(Boolean))].filter((k) => k !== target);
  const merges = { ...settings.merges };
  const labels = { ...settings.labels };
  if (!target) return { merges, labels };
  for (const key of rest) {
    if (key === target) continue;
    repoint(merges, key, target);
    // A split spelling's own entry was repointed above; a fold group gets an entry now.
    if (!key.startsWith(SPELLING)) merges[FOLD + key] = target;
    delete labels[key];
  }
  const name = (label ?? "").trim().slice(0, CLAN_LABEL_MAX);
  if (name) labels[target] = name;
  return { merges, labels };
}

/**
 * Take one spelling out of whatever group it is in: it becomes a group of its own.
 *
 * When the group is keyed on that very spelling (several split spellings combined, this one
 * staying), the rest of the group cannot stay under its key — the key IS the spelling — so it
 * moves to a new one, taking the group's name with it: the first other member's own key (its fold
 * group, or its spelling).
 */
export function splitClanSpelling(settings: ClanTagSettings, spelling: string): ClanTagSettings {
  const tag = spelling.trim();
  const own = SPELLING + tag;
  const merges = { ...settings.merges };
  const labels = { ...settings.labels };
  const others = Object.keys(merges).filter((k) => k !== own && merges[k] === own);
  if (merges[own] === own && others.length) {
    const first = others[0]!;
    const anchor = first.startsWith(FOLD) ? first.slice(FOLD.length) : first;
    for (const k of others) merges[k] = anchor;
    // An automatic group needs no entry to be its own key; a spelling does.
    if (first.startsWith(FOLD)) delete merges[first]; else merges[first] = first;
    if (labels[own]) { labels[anchor] = labels[own]; delete labels[own]; }
  }
  merges[own] = own;
  return { merges, labels };
}

/** Undo every choice that made this group: whatever was combined into it goes back to its own
 *  automatic group, a split spelling rejoins its fold group, and the name is dropped. */
export function resetClanGroup(settings: ClanTagSettings, key: string): ClanTagSettings {
  const merges: Record<string, string> = {};
  for (const [k, v] of Object.entries(settings.merges)) if (v !== key) merges[k] = v;
  const labels = { ...settings.labels };
  delete labels[key];
  return { merges, labels };
}

/** Name a group (an empty name goes back to its most-worn spelling). */
export function renameClanGroup(settings: ClanTagSettings, key: string, label: string): ClanTagSettings {
  const labels = { ...settings.labels };
  const name = label.trim().slice(0, CLAN_LABEL_MAX);
  if (name) labels[key] = name; else delete labels[key];
  return { merges: { ...settings.merges }, labels };
}

/** Whether a group carries any staff choice — what the Clans tab offers to reset. */
export function clanGroupCustomised(settings: ClanTagSettings, key: string): boolean {
  return Boolean(clanGroupName(settings, key)) || Object.values(settings.merges).includes(key);
}

/** Read stored settings defensively: a row written by hand or by an older build is still usable. */
export function normalizeClanTagSettings(raw: unknown): ClanTagSettings {
  const src = (raw && typeof raw === "object" ? raw : {}) as { merges?: unknown; labels?: unknown };
  const strings = (v: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!v || typeof v !== "object" || Array.isArray(v)) return out;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (typeof val === "string" && val) out[k] = val;
    return out;
  };
  return { merges: strings(src.merges), labels: strings(src.labels) };
}
