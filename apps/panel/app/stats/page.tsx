/**
 * /stats — the public stats site's entry. Everything lives in PublicStatsApp; this file exists so
 * the static export emits stats/index.html, which the API's static handler serves for every
 * /stats/* deep link (a public URL must never land on the panel's sign-in shell).
 *
 * Deliberately NOT a client component. It renders one, but it stays a server component so it can
 * export `metadata` — the root layout titles every page after the app, and this is a page players
 * open, who neither know nor care what the admin software is called. Page metadata overrides the
 * layout's in the exported HTML, so the tab says "Stats" from the first byte rather than being
 * corrected by script afterwards. PublicStatsApp refines it to the community's name at runtime
 * when one is configured.
 */
import PublicStatsApp from "../../components/public/PublicStatsApp";
import { PUBLIC_THEME_INIT_SCRIPT } from "../../lib/publicTheme";

// Its own manifest, not the panel's (app/manifest.ts), which would make a saved stats page open the
// staff sign-in. The API serves it, since where the site starts depends on the host it is opened
// on, and it lets a saved stats page turn with the phone (see routes/streamer.ts).
// No icons: they are the installed panel's, and an install with no community logo draws them from
// the admin software's own mark.
export const metadata = { title: "Stats", manifest: "/api/public/webmanifest", icons: null };

export default function StatsPage() {
  return (
    <>
      {/* Restamp the theme from the PUBLIC key before this page paints. The layout's head script
          just applied the panel/OS preference, which is not this audience's: players default to
          dark and get their own toggle, since Settings sits behind the sign-in. See lib/publicTheme. */}
      <script dangerouslySetInnerHTML={{ __html: PUBLIC_THEME_INIT_SCRIPT }} />
      <PublicStatsApp />
    </>
  );
}
