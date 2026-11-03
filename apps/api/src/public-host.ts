/**
 * The public-hostname view — what exists when a request arrives on the stats site's own domain.
 *
 * The concern this solves is SECRECY OF THE ADMIN ADDRESS, not authorization (every admin
 * surface is login-gated regardless): a stats link gets pasted in Discord, indexed, forwarded —
 * and if it carries the panel's hostname, the panel's login page is now public knowledge. With a
 * dedicated hostname configured, that hostname serves the public surface and NOTHING else, so
 * the shared link says nothing about where the panel lives.
 *
 * On the public host:
 *   - the public API passes through untouched (/api/public/*, /stats/<slug>/api/*, /s/<id>/api/*);
 *   - every other /api/* path answers 404 — no login endpoint, no authed surface, nothing to
 *     probe or brute-force on the hostname players hold;
 *   - asset paths pass through (the export's JS/CSS under /_next/, game art under /game/,
 *     anything with a file extension — all public artifacts);
 *   - everything else is REWRITTEN under /stats, which is what makes the short links work:
 *     stats.example.com/nam is /stats/nam, stats.example.com is the index. The page detects
 *     which base it is running under and builds its links bare on the public host.
 *
 * The Host header is client-controlled, which is fine for this purpose: sending the admin
 * hostname to the same address yields exactly the login-gated app the attacker already knew
 * existed — nothing here grants anything, it only hides.
 *
 * Pure, so the routing decision is testable without sockets — which is also why this module
 * imports nothing: the tests load it straight from source, where a relative .js import has no
 * compiled file to resolve to.
 */

/** A hostname as the Host header comparison needs it: lowercase, no port, no protocol, no path. */
export function normalizeHost(value: string | null | undefined): string | null {
  const h = String(value ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0]!.split(":")[0]!;
  return h || null;
}

export interface PublicHostView {
  /** false = this path does not exist on the public hostname (uniform 404). */
  allowed: boolean;
  /** the path to route/serve — rewritten under /stats when the short form was used. */
  path: string;
}

export function publicHostView(hostHeader: string | null | undefined, path: string, publicHost: string | null | undefined): PublicHostView {
  const host = normalizeHost(hostHeader);
  const wanted = normalizeHost(publicHost);
  // No dedicated host configured, or the request is on the admin host: everything as normal.
  if (!wanted || host !== wanted) return { allowed: true, path };

  if (path.startsWith("/api/")) {
    return { allowed: path.startsWith("/api/public/"), path };
  }
  // The public surface's own mounts and the page's paths, already fully qualified.
  if (path === "/stats" || path.startsWith("/stats/") || /^\/s\/[^/]+\/api\//.test(path)) {
    return { allowed: true, path };
  }
  // Assets, by PREFIX and only by prefix: the export's chunks and the bundled game art. An
  // earlier draft allowed any dotted filename, which quietly served the panel's own artifacts on
  // the players' hostname — /index.html IS the login shell, /brand/* is the panel's identity —
  // and "no panel on this hostname" is the entire point. A dotted path outside these prefixes is
  // a file request, never a page address (slugs cannot contain dots), so it 404s rather than
  // being rewritten into a page lookup.
  const last = path.split("/").pop() ?? "";
  if (path.startsWith("/_next/") || path.startsWith("/game/")) {
    return { allowed: true, path };
  }
  if (last.includes(".")) return { allowed: false, path };
  // The short form: stats.example.com/nam → /stats/nam, the bare host → the index.
  return { allowed: true, path: path === "/" ? "/stats" : `/stats${path}` };
}
