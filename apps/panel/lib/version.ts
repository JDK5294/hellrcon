/**
 * The bundle's own build stamp, against the server's. Docker bakes NEXT_PUBLIC_APP_COMMIT into
 * the panel at build time and APP_COMMIT into the API's environment; /api/health/metrics reports
 * the latter, and comparing the two is how an already-open tab — a phone left on the panel for
 * days — learns the server has moved on. Without this, a stale tab keeps polling a NEW api with
 * OLD code forever, looking exactly like "the update didn't land".
 */
export const BUILT_COMMIT: string | null = process.env.NEXT_PUBLIC_APP_COMMIT || null;

/**
 * Stale only when BOTH sides carry a stamp and they disagree. A missing stamp on either side
 * (dev server, a manual `docker compose` build, an old API) proves nothing — nagging every
 * unstamped install to reload would train people to ignore the banner.
 */
export function bundleIsStale(built: string | null, running: string | null | undefined): boolean {
  return Boolean(built && running && built !== running);
}
