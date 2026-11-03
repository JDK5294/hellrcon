/**
 * The public demo's look (app/demo): dark, for every visitor, from the first paint.
 *
 * The shared root layout's THEME_INIT_SCRIPT has already run by the time the body parses, and it
 * stamped the real panel's look stored on this device, or else the device's own preference. The
 * demo is a showcase, the same for everyone: this script, first in the demo's page, puts the dark
 * look back before any of the page paints, with the default accent, and tints the browser's own
 * bar to match. The layout's tint tags follow the device's preference, and are left as they are —
 * one changed under React is put back beside it when the page hydrates — with the demo's own put
 * ahead of them, since a browser takes the first that applies. The panel's store in the demo starts
 * dark (lib/demo/install), so it stays so; a visitor can still change it in Settings, for the
 * visit. The same mechanics as the public stats site's own default (lib/publicTheme).
 */

/** The dark theme's `--bg` (app/globals.css), as the layout's tag for a dark device writes it. */
const DARK_BG = "#0a0c10";

export const DEMO_THEME_INIT_SCRIPT = `(function(){
  var r=document.documentElement; r.setAttribute('data-theme','dark'); r.style.removeProperty('--accent');
  var t=document.createElement('meta'); t.name='theme-color'; t.content='${DARK_BG}'; document.head.prepend(t);
})();`;
