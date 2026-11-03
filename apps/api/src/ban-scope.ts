/**
 * Which servers a ban covers — as a RULE, not a list of ids.
 *
 * The distinction is the whole point. Today a ban arrives as `serverIds: ["#1","#2","#3"]` and
 * there is no way to tell two very different decisions apart:
 *
 *   • "banned from the community"  — should cover #4 when we stand it up next month
 *   • "banned from those three"    — should not
 *
 * Both are the same array, so neither can be honoured later. Storing the rule instead of its
 * current expansion is what makes a ban inheritable by a server that does not exist yet, and it
 * fell out of a UI request: staff wanted to say "everywhere except #2" the way the map vote says
 * "any map except these", rather than ticking three boxes out of four.
 *
 * A scope is always PER GAME. Player ids do not cross games — a Hell Let Loose Steam64 means
 * nothing to an HLL: Vietnam server, which keys everyone by its own EOS id — so "every server"
 * can only ever mean "every server running the game this player id belongs to". Resolution takes
 * the game and filters on it rather than trusting the caller to have done so.
 *
 * See docs/ban-model.md.
 */

import { banScopeCovers } from "@app/db";

export type BanScope =
  /** Exactly these servers. A snapshot: a server added later is NOT covered. */
  | { mode: "servers"; serverIds: string[] }
  /** Every server of this game, including ones added later. */
  | { mode: "all" }
  /** Every server of this game except these, including ones added later. */
  | { mode: "except"; serverIds: string[] };

/** Just enough of a server row to resolve a scope against. */
export interface ScopeServer { id: string; game: string }

/**
 * `all` is `except` with an empty list, and they resolve identically. They are kept as separate
 * modes because they are different sentences — "banned everywhere" and "banned everywhere except
 * nowhere" read differently in an audit summary, and staff mean the first.
 */
export function resolveBanScope<T extends ScopeServer>(scope: BanScope, servers: T[], game: string): T[] {
  const ofGame = servers.filter((s) => s.game === game);
  if (scope.mode === "all") return ofGame;
  if (scope.mode === "except") {
    const out = new Set(scope.serverIds);
    return ofGame.filter((s) => !out.has(s.id));
  }
  const want = new Set(scope.serverIds);
  return ofGame.filter((s) => want.has(s.id));
}

/**
 * Does this scope, as a rule, cover this server?
 *
 * The rule itself lives in @app/db as `banScopeCovers`, because that is the copy the RECONCILER
 * reasons with — the thing that decides what a game server's ban list should actually hold. This
 * had its own second implementation of the same three lines, which meant the tests here were
 * exercising a twin nothing ran while the copy that decides real bans had no direct test at all,
 * and either could have been edited without the other. One rule, one place; the game check is the
 * part that genuinely belongs to this layer, since `banScopeCovers` is deliberately game-blind.
 */
export function scopeCovers(scope: BanScope, server: ScopeServer, game: string): boolean {
  if (server.game !== game) return false;
  return banScopeCovers(scope, server.id);
}

/**
 * Read a scope off a request body.
 *
 * Accepts the original `serverIds` array as `{mode:"servers"}` so nothing that already fans out
 * has to change at once — the group bulk-apply path and any saved automation keep working, and
 * they mean a snapshot, which is the honest reading of a list of ids.
 *
 * Returns `null` for "not specified", which the route reads as "just the server in the path".
 */
export function parseBanScope(body: Record<string, unknown>): { ok: true; scope: BanScope | null } | { ok: false; error: string } {
  const raw = body.scope;
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "scope must be an object" };
    const mode = (raw as { mode?: unknown }).mode;
    const ids = idList((raw as { serverIds?: unknown }).serverIds);
    if (mode === "all") return { ok: true, scope: { mode: "all" } };
    if (mode === "except") return { ok: true, scope: { mode: "except", serverIds: ids } };
    if (mode === "servers") {
      // An empty list here is the one case worth refusing outright: "these servers, and there are
      // none of them" is not a decision anyone means to make, and silently doing nothing to a ban
      // request is the worst possible outcome.
      if (!ids.length) return { ok: false, error: "scope.mode 'servers' needs at least one server id" };
      return { ok: true, scope: { mode: "servers", serverIds: ids } };
    }
    return { ok: false, error: `scope.mode must be one of: all, except, servers` };
  }
  if (Array.isArray(body.serverIds)) {
    const ids = idList(body.serverIds);
    if (!ids.length) return { ok: false, error: "serverIds was given but empty — name at least one server" };
    return { ok: true, scope: { mode: "servers", serverIds: ids } };
  }
  return { ok: true, scope: null };
}

const idList = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map((x) => String(x ?? "").trim()).filter(Boolean))] : [];

/**
 * What an unban that landed on `liftedServerIds` does to ONE decision.
 *
 * The panel's unban dialog lets staff untick servers — "lift it on the seed server only" is a
 * real decision — and the record has to keep up. Lifting the whole row for a partial unban made
 * the Bans page show a community ban as over while the game still enforced it on every other
 * server; worse, the reconciler then read those live bans as placed outside the panel, and armed
 * it would have removed them — finishing an unban nobody asked for.
 *
 * Three honest outcomes:
 *   • `keep`   — the unban touched none of this decision's servers; the row is not its business.
 *   • `lift`   — every server the rule covers TODAY was unbanned. This retires `all`/`except`
 *                rules too: the dialog offered exactly the covered servers and staff took them
 *                all, and a ghost rule that springs back on a server added next month is a trap,
 *                not an inheritance.
 *   • `narrow` — some covered servers remain banned; the rule shrinks to exactly them.
 *                `all` minus a lift is `except [lifted]` (servers added later stay covered —
 *                the community-wide sentence still stands where it wasn't lifted); a literal
 *                list just loses the lifted ids.
 */
export function narrowBanScope<T extends ScopeServer>(
  scope: BanScope,
  liftedServerIds: string[],
  servers: T[],
  game: string,
): { outcome: "keep" } | { outcome: "lift" } | { outcome: "narrow"; scope: BanScope } {
  const covered = resolveBanScope(scope, servers, game).map((s) => s.id);
  const lifted = new Set(liftedServerIds);
  const hit = covered.filter((id) => lifted.has(id));
  if (!hit.length) return { outcome: "keep" };
  const remaining = covered.filter((id) => !lifted.has(id));
  if (!remaining.length) return { outcome: "lift" };
  if (scope.mode === "servers") return { outcome: "narrow", scope: { mode: "servers", serverIds: remaining } };
  const except = scope.mode === "except" ? scope.serverIds : [];
  return { outcome: "narrow", scope: { mode: "except", serverIds: [...new Set([...except, ...hit])] } };
}

/**
 * One line for the audit trail. Numbers, not names: server names in this community run to eighty
 * characters and differ by a digit in the middle, so a summary built from them is unreadable.
 */
export function describeBanScope(scope: BanScope, numberOf: (id: string) => number | string): string {
  if (scope.mode === "all") return "all servers (including any added later)";
  const list = scope.serverIds.map(numberOf).join(", ");
  if (scope.mode === "except") {
    return scope.serverIds.length
      ? `all servers except ${list} (including any added later)`
      : "all servers (including any added later)";
  }
  return scope.serverIds.length === 1 ? `server ${list}` : `servers ${list}`;
}
