/**
 * An error status that came from whatever stands in front of the panel's API (Cloudflare, Caddy,
 * nginx) rather than from the API itself. It carries none of the API's words, and a bare
 * "HTTP 530" reads like a fault in the panel, so it is said as what it is and what to do. Null for
 * any other status: the API's own message, or the bare status, answers those.
 *
 * A leaf, so the tests can load it; lib/api asks it only when the reply had no message of the
 * API's own.
 */
export function proxyAnswer(status: number): string | null {
  // The proxy is up, and the API behind it did not answer it (502), or not in time (504).
  if (status === 502 || status === 504) {
    return `The panel's API did not answer (HTTP ${status} came from the proxy in front of it). Check that the API service is up, or retry in a moment.`;
  }
  // Cloudflare's error 1033: its tunnel to the computer the panel runs on is not connected.
  // cloudflared stopped, or the computer is off or restarting, as it does for an update.
  if (status === 530) {
    return "Cloudflare can't reach the computer the panel runs on (HTTP 530). It may be restarting, switched off or offline. Try again in a minute.";
  }
  return null;
}
