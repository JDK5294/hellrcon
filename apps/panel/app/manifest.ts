/**
 * The panel as a home-screen app. Without a manifest a phone has to guess how an installed panel
 * should behave, and on phones it was staying upright: the panel never locks orientation, but
 * nothing told the phone it may turn either. `orientation: "any"` says it works both ways, so it
 * follows the phone (and the phone's own rotation lock) — wide tables and maps read better on
 * their side. Full-screen like an app; the panel carries its own back and forward buttons.
 *
 * The icons are what make Chrome (and Samsung Internet) INSTALL it, its own window with no browser
 * bar, rather than drop a plain shortcut: they want one of at least 192 px and one of 512. The
 * maskable one is full-bleed, for Android launchers that crop icons to their own shape. They are
 * the program's own mark, drawn by scripts/make-icons.mjs; no service worker is needed for
 * "Install app" in Chrome's menu.
 *
 * Only the panel's: the public stats page (app/stats) opts out, so a player saving that page
 * keeps the page, not the staff sign-in. Read when an icon is ADDED — an icon saved before this
 * existed has to be removed and added again to pick it up.
 */
import type { MetadataRoute } from "next";
import { APP_NAME } from "../lib/brand";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: APP_NAME,
    short_name: APP_NAME,
    description: "Hell Let Loose server management panel",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#0a0c10",
    theme_color: "#0a0c10",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
