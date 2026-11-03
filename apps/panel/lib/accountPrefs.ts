"use client";
/**
 * Display preferences belong to the PERSON, not the browser.
 *
 * Theme, accent colour, density, landing view and remembered tabs were localStorage-only. That
 * made "set your accent" a chore you had to repeat on every device, and — worse — it looked
 * broken: a colour picked on a desktop never reached the same admin's phone, which is
 * indistinguishable from the setting not working at all.
 *
 * They now live on the account. localStorage stays as the PRE-PAINT CACHE: the inline theme
 * script has to run before first paint and cannot wait for a network round trip, so the browser's
 * copy paints immediately and the account's copy (which arrives with /api/me, the request every
 * session already makes) corrects it a moment later if they disagree. Writes go both ways at
 * once — local first so the UI never lags behind a click, then the server, best effort.
 */
import { api } from "./api";
import { applyTheme, readTheme, saveThemeLocal, type ThemePref } from "./theme";
import { applyDensity, applyFontScale, applyPhoneBar, readPhoneAlerts, readPhoneBarItems, writeUserPrefsLocal, type PhoneAlerts, type UserPrefs } from "./userPrefs";

/** The account-side shape: theme + the panel preferences, flattened into one blob. */
export interface AccountPrefs {
  themeMode?: string;
  accent?: string | null;
  landing?: string;
  density?: string;
  fontScale?: number;
  localTimes?: boolean;
  /** Display time zone ("" = follow the community zone). */
  timeZone?: string;
  /** Where the quick bar sits on a phone ("bottom" | "top" | "off"). */
  phoneBar?: string;
  /** The quick bar's buttons, in order (route ids and "search"). */
  phoneBarItems?: string[];
  /** Which phone notifications come. The one preference the server reads (phone-alerts.ts). */
  phoneAlerts?: Partial<PhoneAlerts>;
  /** Open What's new after an update. */
  whatsNew?: boolean;
  /** The newest What's new build this person has closed (lib/whatsNew); a date, from before builds
   *  were numbered, on accounts that have not closed one since. */
  whatsNewSeen?: number | string;
  /** The version of Getting started this person has been through (lib/gettingStarted). */
  setupSeen?: number;
  /** The walkthroughs this person could not follow at the last check, and what it was made for
   *  (lib/walkNotice): one leaving the list is a walkthrough their new permissions opened. */
  walkthroughs?: { for: string; locked: string[] };
  lastTab?: Record<string, string>;
}

/**
 * Adopt the account's preferences over this browser's cache. Called with whatever /api/me
 * returned; an account that has never saved any (an empty blob) leaves the local ones alone, so
 * signing in on a fresh device does not wipe the setup you just made on it.
 */
export function adoptAccountPrefs(prefs: AccountPrefs | null | undefined): void {
  if (!prefs || typeof prefs !== "object") return;
  const theme: ThemePref = readTheme();
  let themeChanged = false;
  if (prefs.themeMode === "light" || prefs.themeMode === "dark" || prefs.themeMode === "system") {
    theme.mode = prefs.themeMode; themeChanged = true;
  }
  if (typeof prefs.accent === "string" || prefs.accent === null) { theme.accent = prefs.accent; themeChanged = true; }
  if (themeChanged) { saveThemeLocal(theme); applyTheme(theme); }

  const patch: Partial<UserPrefs> = {};
  if (typeof prefs.landing === "string") patch.landing = prefs.landing;
  if (prefs.density === "compact" || prefs.density === "cozy") patch.density = prefs.density;
  if (typeof prefs.fontScale === "number") patch.fontScale = prefs.fontScale;
  if (typeof prefs.localTimes === "boolean") patch.localTimes = prefs.localTimes;
  if (typeof prefs.timeZone === "string") patch.timeZone = prefs.timeZone;
  if (prefs.phoneBar === "bottom" || prefs.phoneBar === "top" || prefs.phoneBar === "off") patch.phoneBar = prefs.phoneBar;
  if (Array.isArray(prefs.phoneBarItems)) patch.phoneBarItems = readPhoneBarItems(prefs.phoneBarItems);
  if (prefs.phoneAlerts && typeof prefs.phoneAlerts === "object") patch.phoneAlerts = readPhoneAlerts(prefs.phoneAlerts);
  if (typeof prefs.whatsNew === "boolean") patch.whatsNew = prefs.whatsNew;
  if (prefs.lastTab && typeof prefs.lastTab === "object") patch.lastTab = prefs.lastTab;
  if (Object.keys(patch).length) {
    const merged = writeUserPrefsLocal(patch);
    applyDensity(merged.density);
    applyFontScale(merged.fontScale);
    applyPhoneBar(merged.phoneBar);
  }
}

/** Save the theme here AND on the account. Drop-in for the old lib/theme `saveTheme`. */
export function saveTheme(pref: ThemePref): void {
  saveThemeLocal(pref);
  pushAccountPrefs({ themeMode: pref.mode, accent: pref.accent });
}

/** Save panel preferences here AND on the account. Only the synced keys are sent — `lastTab` is
 *  device context and stays local (see userPrefs.rememberTab). */
export function writeUserPrefs(patch: Partial<UserPrefs>): UserPrefs {
  const merged = writeUserPrefsLocal(patch);
  const up: AccountPrefs = {};
  if (patch.landing !== undefined) up.landing = merged.landing;
  if (patch.density !== undefined) up.density = merged.density;
  if (patch.fontScale !== undefined) up.fontScale = merged.fontScale;
  if (patch.localTimes !== undefined) up.localTimes = merged.localTimes;
  if (patch.timeZone !== undefined) up.timeZone = merged.timeZone;
  if (patch.phoneBar !== undefined) up.phoneBar = merged.phoneBar;
  if (patch.phoneBarItems !== undefined) up.phoneBarItems = merged.phoneBarItems;
  if (patch.phoneAlerts !== undefined) up.phoneAlerts = merged.phoneAlerts;
  if (patch.whatsNew !== undefined) up.whatsNew = merged.whatsNew;
  if (Object.keys(up).length) pushAccountPrefs(up);
  return merged;
}

/**
 * Push a change up to the account. Fire-and-forget on purpose: the local write already happened,
 * so a failed sync costs cross-device agreement until the next save — never the setting itself,
 * and never an error in the user's face for having changed a colour.
 */
export function pushAccountPrefs(patch: AccountPrefs): void {
  void api("/me/prefs", { method: "PUT", body: patch }).catch(() => {});
}

/**
 * Save a change to the account and wait for it — for the one preference whose effect is the
 * server's: which phone notifications come (phone-alerts.ts reads them there, not from this
 * browser). Throws when it did not land, so the screen can say so rather than show a choice the
 * server never got.
 */
export async function saveAccountPrefs(patch: AccountPrefs): Promise<void> {
  await api("/me/prefs", { method: "PUT", body: patch });
}
