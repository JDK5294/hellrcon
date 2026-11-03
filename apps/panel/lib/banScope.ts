/**
 * Client-side mirror of the API's `BanScope` (apps/api/src/ban-scope.ts) — the panel deliberately
 * does not depend on workspace packages, so the type and its resolution are written twice on
 * purpose, the same way lib/access.ts mirrors `can()`. The API is authoritative; this only decides
 * what the picker shows and what the confirmation line says.
 *
 * A ban's scope is a RULE, not a list of ids, because "all servers" and "these three servers"
 * are different decisions that used to arrive as the same array — and only the first should cover
 * a server added next month. See docs/ban-model.md.
 */
export type BanScope =
  | { mode: "servers"; serverIds: string[] }
  | { mode: "all" }
  | { mode: "except"; serverIds: string[] };

/** `game` is optional here and required on the server: the panel's server list carries it only
 *  once /api/servers has landed, and a scope resolved before then simply does not filter by it. */
export interface ScopeServer { id: string; game?: string }

/** Which of `servers` this scope covers right now. Always filtered by game — ids don't cross. */
export function resolveBanScope<T extends ScopeServer>(scope: BanScope, servers: T[], game?: string): T[] {
  const ofGame = game ? servers.filter((s) => s.game === game) : servers;
  if (scope.mode === "all") return ofGame;
  if (scope.mode === "except") {
    const out = new Set(scope.serverIds);
    return ofGame.filter((s) => !out.has(s.id));
  }
  const want = new Set(scope.serverIds);
  return ofGame.filter((s) => want.has(s.id));
}

/**
 * The sentence shown under the picker, and the last chance to notice a ban is about to reach
 * further than intended. Says the RULE, not only the count: "all servers, including any added
 * later" is the part a staff member needs to have read before they click Ban.
 */
export function describeBanScope(scope: BanScope, covered: number, total: number): string {
  if (scope.mode === "all") return `All ${total} server${total === 1 ? "" : "s"} — and any added later.`;
  if (scope.mode === "except") {
    return scope.serverIds.length
      ? `${covered} of ${total} servers — and any added later, unless excluded too.`
      : `All ${total} server${total === 1 ? "" : "s"} — and any added later.`;
  }
  return `${covered} of ${total} server${total === 1 ? "" : "s"} — exactly these, not any added later.`;
}
