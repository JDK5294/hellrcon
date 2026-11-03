/** The path Discord sends a signing-in member back to (the API's routes/auth.ts). */
export const DISCORD_CALLBACK_PATH = "/api/auth/discord/callback";

/**
 * The sign-in return address to offer from where the panel is open: this address and the callback
 * path, except when it is this computer's own. Offered on http://localhost:8080, where the first
 * setup happens, it filled in a return address that works for nobody signing in from anywhere else.
 */
export function suggestedCallback(location: { hostname: string; origin: string }): string {
  const host = location.hostname;
  const loopback = host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "[::1]";
  return loopback ? "" : `${location.origin}${DISCORD_CALLBACK_PATH}`;
}
