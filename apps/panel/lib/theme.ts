/**
 * Theme state for the panel: light / dark / system, plus a user-customizable accent colour.
 * Applied by stamping `data-theme` and an inline `--accent` onto <html> (CSS derives every accent
 * shade from that one value). Persisted in localStorage; a matching inline script in the document
 * head applies it before first paint to avoid a flash.
 */
export type ThemeMode = "light" | "dark" | "system";
export interface ThemePref { mode: ThemeMode; accent: string | null } // accent null = theme default

export const MODE_KEY = "panel.theme.mode";
export const ACCENT_KEY = "panel.theme.accent";

/** Built-in accent choices; users can also pick any custom colour. */
export const ACCENT_PRESETS: { name: string; value: string }[] = [
  { name: "Slate (default)", value: "#64748b" },
  { name: "Blue", value: "#4f8cff" },
  { name: "Violet", value: "#7c5cff" },
  { name: "Emerald", value: "#22c39a" },
  { name: "Amber", value: "#f2a93b" },
  { name: "Rose", value: "#ff5d8f" },
  { name: "Cyan", value: "#3fd0e0" },
  { name: "Red", value: "#f85149" },
];

export function readTheme(): ThemePref {
  if (typeof window === "undefined") return { mode: "system", accent: null };
  const mode = (localStorage.getItem(MODE_KEY) as ThemeMode) || "system";
  const accent = localStorage.getItem(ACCENT_KEY);
  return { mode: mode === "light" || mode === "dark" || mode === "system" ? mode : "system", accent: accent || null };
}

/** Resolve "system" to a concrete theme via the OS preference. */
export function resolveMode(mode: ThemeMode): "light" | "dark" {
  if (mode === "light" || mode === "dark") return mode;
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(pref: ThemePref): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-theme", resolveMode(pref.mode));
  if (pref.accent) root.style.setProperty("--accent", pref.accent);
  else root.style.removeProperty("--accent");
}

/** Write + apply on THIS device only. Callers that should also reach the account use
 *  `saveTheme` from lib/accountPrefs, which wraps this. */
export function saveThemeLocal(pref: ThemePref): void {
  localStorage.setItem(MODE_KEY, pref.mode);
  if (pref.accent) localStorage.setItem(ACCENT_KEY, pref.accent);
  else localStorage.removeItem(ACCENT_KEY);
  applyTheme(pref);
}

/** Re-apply on OS theme changes while in "system" mode. Returns an unsubscribe. */
export function watchSystem(getPref: () => ThemePref): () => void {
  if (typeof window === "undefined") return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  const handler = () => { if (getPref().mode === "system") applyTheme(getPref()); };
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}

/**
 * Inline script (stringified) that applies the stored display settings before paint — no FOUC.
 *
 * Theme, density and text size all land here rather than waiting for React, because all three
 * change how the first paint LOOKS and correcting them afterwards is a visible jolt. Text size is
 * the worst of the three: applying it late reflows every line on the page, so a staff member who
 * chose "Larger" would watch the whole roster jump on every single load.
 *
 * It reads the same localStorage that lib/userPrefs writes (keyed per signed-in username, so a
 * shared browser does not inherit someone else's setup). Everything is wrapped in try/catch and
 * every value is guarded: this runs before anything else and must never be the reason a page fails
 * to render — a bad stored value costs the setting, not the app.
 */
export const THEME_INIT_SCRIPT = `(function(){try{
  var m=localStorage.getItem('${MODE_KEY}')||'system';
  var a=localStorage.getItem('${ACCENT_KEY}');
  var d=(m==='light'||m==='dark')?m:(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');
  var r=document.documentElement; r.setAttribute('data-theme',d);
  if(a)r.style.setProperty('--accent',a);
  try{
    var u=localStorage.getItem('panel.username')||'_';
    var p=JSON.parse(localStorage.getItem('panel.prefs.'+u)||'{}');
    r.setAttribute('data-density',p.density==='cozy'?'cozy':'compact');
    var f=Number(p.fontScale);
    if(isFinite(f)&&f!==1){r.style.setProperty('--font-scale',String(Math.min(1.25,Math.max(0.9,f))));}
  }catch(e2){}
}catch(e){}})();`;
