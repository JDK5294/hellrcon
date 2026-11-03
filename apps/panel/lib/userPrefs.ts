"use client";
/**
 * Per-user panel preferences that shape the whole app rather than one page: where it opens, how
 * tight the rows are, and which tab each hub was left on. Stored per signed-in username (same key
 * convention as panelPrefs) so several admins sharing a browser don't inherit each other's setup.
 *
 * These are display choices with no server meaning, so they stay local — no round-trip, instant
 * effect, and nothing to migrate.
 */

export type Density = "compact" | "cozy";

/** Where the phone's quick bar sits (components/QuickBar.tsx): along the bottom, where a thumb
 *  is, pinned at the top, or nowhere for those who would rather not have it. */
export type PhoneBar = "bottom" | "top" | "off";

/**
 * The quick bar's buttons, in order: each a screen's route id (a hub's tab is "<view>.<tab>"), or
 * "search". Each person picks the screens they use most; More, which opens the whole menu, always
 * comes after them. Out of the box: Live, Players, Bans and Search.
 */
export const PHONE_BAR_MAX = 4;
export const DEFAULT_PHONE_BAR_ITEMS: readonly string[] = ["live", "players", "moderation.bans", "search"];

/** What was stored, as a list the bar can use: strings, each once, at most PHONE_BAR_MAX. No list at
 *  all (never chosen) is the default set; an empty one is someone who took every button off. */
export function readPhoneBarItems(v: unknown): string[] {
  if (!Array.isArray(v)) return [...DEFAULT_PHONE_BAR_ITEMS];
  const out: string[] = [];
  for (const x of v) if (typeof x === "string" && x && !out.includes(x) && out.length < PHONE_BAR_MAX) out.push(x);
  return out;
}

/** Which phone notifications a person wants (Settings → Phone notifications). The panel's server
 *  reads these from the account when it sends one. The first three are on until switched off; the
 *  rest came later and are off until switched on. */
export interface PhoneAlerts {
  watch: boolean; requests: boolean; servers: boolean;
  admin: boolean; automod: boolean; seeding: boolean; decided: boolean;
  bans: boolean; permabans: boolean; settings: boolean; notices: boolean; camera: boolean; shop: boolean;
  /** Staff bans only by someone holding one of these roles; none picked is every staff ban. */
  banRoles: string[];
}

/**
 * Text size multiplier. Distinct from density on purpose: density moves the PADDING (how many rows
 * fit), this moves the TEXT (whether you can read them). Staff read the live roster on a phone at
 * arm's length and staff read it on a 1440p monitor, and the same 14px serves neither well.
 *
 * A multiplier rather than a pixel size, applied to the root, so every rem in the stylesheet
 * follows one number. Padding stays in px and does not scale — text grows inside a layout that
 * holds its shape, which is what keeps a 1.25× roster from becoming unusable.
 */
export const FONT_SCALES = [
  { value: 0.9, label: "Small" },
  { value: 1, label: "Default" },
  { value: 1.1, label: "Large" },
  { value: 1.25, label: "Larger" },
] as const;
export const MIN_FONT_SCALE = 0.9;
export const MAX_FONT_SCALE = 1.25;

/**
 * The screens the menu can be packed for (Settings → Workspace → Screen size), smallest to largest:
 * the common laptop and monitor sizes, by the pixels a browser sees. Windows' display scaling shrinks
 * those — a 1920 × 1080 laptop at 125% shows a browser 1536 × 864, at 150% 1280 × 720 — so the hints
 * say so. "auto", the default, packs the menu for the window itself (lib/menuFit).
 */
export const SCREEN_SIZES = [
  { id: "1280x720", label: "1280 × 720", hint: "small laptop, or 1920 × 1080 at 150% scaling" },
  { id: "1280x800", label: "1280 × 800", hint: "small laptop" },
  { id: "1366x768", label: "1366 × 768", hint: "common laptop" },
  { id: "1440x900", label: "1440 × 900", hint: "laptop" },
  { id: "1536x864", label: "1536 × 864", hint: "1920 × 1080 laptop at 125% scaling" },
  { id: "1600x900", label: "1600 × 900", hint: "laptop" },
  { id: "1680x1050", label: "1680 × 1050", hint: "monitor" },
  { id: "1920x1080", label: "1920 × 1080", hint: "full HD monitor" },
  { id: "1920x1200", label: "1920 × 1200", hint: "monitor" },
  { id: "2560x1440", label: "2560 × 1440", hint: "QHD monitor" },
  { id: "2560x1600", label: "2560 × 1600", hint: "large laptop or monitor" },
  { id: "3440x1440", label: "3440 × 1440", hint: "ultrawide monitor" },
  { id: "3840x2160", label: "3840 × 2160", hint: "4K monitor" },
] as const;

/** A stored screen size the list still has, else "auto". */
export function readScreenSize(v: unknown): string {
  return typeof v === "string" && SCREEN_SIZES.some((s) => s.id === v) ? v : "auto";
}

export interface UserPrefs {
  /** view id the app opens on. "dashboard" unless the user picks something they use more. */
  landing: string;
  /** row/padding scale. compact = maximum data per screen; cozy = roomier touch targets. */
  density: Density;
  /** text size multiplier — see FONT_SCALES. */
  fontScale: number;
  /** last tab used per destination, so returning to a hub resumes where you left it. */
  lastTab: Record<string, string>;
  /**
   * Show schedule times on the viewer's own clock too. Schedules are stored and evaluated in a
   * configured zone (usually UTC, because the game logs in UTC); an admin in New York reading
   * "20:00" should not have to do the subtraction themselves.
   */
  localTimes: boolean;
  /**
   * The IANA zone every timestamp is DISPLAYED in — and the zone typed dates are read in. Empty
   * means "follow the community time zone" (Users & roles → Community time zone), which is the
   * default so the whole staff reads one clock unless someone asks for their own.
   */
  timeZone: string;
  /** Where the quick bar sits on a phone — see PhoneBar. */
  phoneBar: PhoneBar;
  /** The quick bar's buttons — see DEFAULT_PHONE_BAR_ITEMS. */
  phoneBarItems: string[];
  /** Which phone notifications come — see PhoneAlerts. */
  phoneAlerts: PhoneAlerts;
  /**
   * Open What's new after an update (components/WhatsNew). Off, an update's notes are marked seen
   * without opening, and Help → What's new still keeps every one.
   */
  whatsNew: boolean;
  /**
   * The screen the menu is packed for — "auto" (the window itself) or one of SCREEN_SIZES. This
   * device's alone, never the account's: a laptop and a monitor want different answers, and the
   * same person uses both (written with writeUserPrefsLocal, like lastTab).
   */
  screenSize: string;
}

export const DEFAULT_USER_PREFS: UserPrefs = {
  landing: "dashboard", density: "compact", fontScale: 1, lastTab: {}, localTimes: true, timeZone: "", phoneBar: "bottom",
  phoneBarItems: [...DEFAULT_PHONE_BAR_ITEMS], phoneAlerts: {
    watch: true, requests: true, servers: true, admin: false, automod: false, seeding: false, decided: false,
    bans: false, permabans: false, settings: false, notices: false, camera: false, shop: false, banRoles: [],
  },
  whatsNew: true,
  screenSize: "auto",
};

/** Stored choices over the defaults: the first three unless switched off, the rest only if on. */
export function readPhoneAlerts(v: unknown): PhoneAlerts {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    watch: o.watch !== false, requests: o.requests !== false, servers: o.servers !== false,
    admin: o.admin === true, automod: o.automod === true, seeding: o.seeding === true, decided: o.decided === true,
    bans: o.bans === true, permabans: o.permabans === true, settings: o.settings === true,
    notices: o.notices === true, camera: o.camera === true, shop: o.shop === true,
    banRoles: Array.isArray(o.banRoles) ? o.banRoles.filter((r): r is string => typeof r === "string") : [],
  };
}
const DEFAULTS = DEFAULT_USER_PREFS;

/** Clamp whatever was stored (or synced from an account, or hand-edited) into the supported range.
 *  A scale of 0 would erase the app; 4 would make one row fill the screen. */
export function normalizeFontScale(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULTS.fontScale;
  return Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, Math.round(n * 100) / 100));
}

const key = () => {
  let user = "";
  try { user = localStorage.getItem("panel.username") ?? ""; } catch { /* ignore */ }
  return `panel.prefs.${user || "_"}`;
};

export function readUserPrefs(): UserPrefs {
  try {
    const raw = localStorage.getItem(key());
    if (!raw) return { ...DEFAULTS, phoneBarItems: [...DEFAULTS.phoneBarItems] };
    const p = JSON.parse(raw) as Partial<UserPrefs>;
    return {
      landing: typeof p.landing === "string" ? p.landing : DEFAULTS.landing,
      density: p.density === "cozy" ? "cozy" : "compact",
      fontScale: normalizeFontScale(p.fontScale),
      lastTab: p.lastTab && typeof p.lastTab === "object" ? p.lastTab : {},
      localTimes: typeof p.localTimes === "boolean" ? p.localTimes : DEFAULTS.localTimes,
      timeZone: typeof p.timeZone === "string" ? p.timeZone : DEFAULTS.timeZone,
      phoneBar: p.phoneBar === "top" || p.phoneBar === "off" ? p.phoneBar : DEFAULTS.phoneBar,
      phoneBarItems: readPhoneBarItems(p.phoneBarItems),
      phoneAlerts: readPhoneAlerts(p.phoneAlerts),
      whatsNew: p.whatsNew !== false,
      screenSize: readScreenSize(p.screenSize),
    };
  } catch { return { ...DEFAULTS, phoneBarItems: [...DEFAULTS.phoneBarItems] }; }
}

/** Write on THIS device only. Callers that should also reach the account use `writeUserPrefs`
 *  from lib/accountPrefs, which wraps this. */
export function writeUserPrefsLocal(next: Partial<UserPrefs>): UserPrefs {
  const merged = { ...readUserPrefs(), ...next };
  try { localStorage.setItem(key(), JSON.stringify(merged)); } catch { /* best effort */ }
  applyDensity(merged.density);
  applyFontScale(merged.fontScale);
  applyPhoneBar(merged.phoneBar);
  // The quick bar redraws its buttons from this when they change, in Settings or from the account.
  try { window.dispatchEvent(new CustomEvent("panel:prefs")); } catch { /* no window */ }
  return merged;
}

/**
 * Remember the tab a hub was left on. Deliberately NOT synced to the account: it changes on
 * every click, and "where I was" is context for this device rather than a preference — a phone
 * resuming the tab a desktop was left on would be surprising, not helpful.
 */
export function rememberTab(viewId: string, tabId: string): void {
  const cur = readUserPrefs();
  if (cur.lastTab[viewId] === tabId) return;
  writeUserPrefsLocal({ lastTab: { ...cur.lastTab, [viewId]: tabId } });
}
export const recallTab = (viewId: string): string | undefined => readUserPrefs().lastTab[viewId];

/** Density is a single attribute on <html>; the stylesheet scales spacing off it. */
export function applyDensity(d: Density): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-density", d);
}

/** The quick bar's place is a single attribute on <html>; the stylesheet does the placing, so a
 *  change in Settings moves it at once. */
export function applyPhoneBar(at: PhoneBar): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-phone-bar", at);
}

/** Text size is a single custom property on <html>; the root font-size multiplies by it, and every
 *  rem in the stylesheet follows. Cleared at 1 so the default costs no inline style. */
export function applyFontScale(scale: number): void {
  if (typeof document === "undefined") return;
  const s = normalizeFontScale(scale);
  if (s === 1) document.documentElement.style.removeProperty("--font-scale");
  else document.documentElement.style.setProperty("--font-scale", String(s));
}
