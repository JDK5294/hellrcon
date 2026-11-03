/**
 * Theme for the PUBLIC stats site, deliberately separate from the panel's (lib/theme.ts).
 *
 * Visitors out here are players, not staff: they have no account, and the in-app Settings screen
 * where the panel's theme lives sits behind the sign-in. So the public site carries its own
 * toggle in its own header, stores the choice under its own key, and defaults to DARK — with no
 * "system" mode, because a visitor who wants the other look has exactly one switch to find.
 *
 * The two surfaces never bleed into each other: a staff member's light panel stays light after
 * they flip the public page, and a player's choice never rewrites anything behind the sign-in.
 */
export type PublicThemeMode = "light" | "dark";

export const PUBLIC_MODE_KEY = "public.theme.mode";

/** The stored choice, defaulting to dark — including when storage is unreadable (private
 *  windows, blocked site data). A failed read costs the memory of the choice, never the page. */
export function readPublicTheme(): PublicThemeMode {
  try {
    return localStorage.getItem(PUBLIC_MODE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyPublicTheme(mode: PublicThemeMode): void {
  document.documentElement.setAttribute("data-theme", mode);
}

/** Persist + apply. A storage failure costs the persistence, never the switch. */
export function savePublicTheme(mode: PublicThemeMode): void {
  try {
    localStorage.setItem(PUBLIC_MODE_KEY, mode);
  } catch {
    /* private window — the choice still applies for this visit */
  }
  applyPublicTheme(mode);
}

/**
 * Pre-paint restamp for the public pages, rendered inline by app/stats/page.tsx.
 *
 * The shared root layout's THEME_INIT_SCRIPT has already run by the time the body parses, and it
 * stamped the PANEL's stored preference — or, for a visitor with nothing stored, the OS
 * preference. Neither is this audience's setting: a player on a light OS would get a white page
 * with no way to change it. This script runs first thing inside the public page's markup, before
 * any of its content exists to paint, and restamps from the public key (default dark) — same
 * no-flash mechanics as the layout script, one authority further down the cascade.
 */
export const PUBLIC_THEME_INIT_SCRIPT = `(function(){try{
  var m=localStorage.getItem('${PUBLIC_MODE_KEY}');
  document.documentElement.setAttribute('data-theme',m==='light'?'light':'dark');
}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;
