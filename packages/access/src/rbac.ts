/**
 * Per-server RBAC — the improvement over CRCON's global-only permissions.
 *
 * A grant is `(capability, scope, level)` where scope is global | server | group.
 * Effective access for a user on a specific server = the highest level among all grants
 * whose capability matches and whose scope applies to that server. So a moderator can be
 * WRITE on one server, READ on another, and NONE elsewhere — while an owner holds a single
 * global grant.
 */
import type { AccessLevel, GrantScope } from "@app/shared";

const ORDER: Record<AccessLevel, number> = { none: 0, read: 1, write: 2 };

export interface Grant {
  /** capability key, or "*" for all capabilities. */
  capability: string;
  scopeType: GrantScope;
  /** server id or group id; null for global. */
  scopeId: string | null;
  level: AccessLevel;
  /**
   * Where this grant came from: a role id when projected from a role, absent for a personal
   * (direct) grant. Vetoes are scoped by source — see resolveLevel.
   */
  source?: string;
}

/** Grants bucketed by origin: each role is its own bucket, personal grants are their own. */
function bySource(grants: Grant[]): Map<string, Grant[]> {
  const groups = new Map<string, Grant[]>();
  for (const g of grants) {
    const key = g.source ?? PERSONAL;
    const list = groups.get(key);
    if (list) list.push(g);
    else groups.set(key, [g]);
  }
  return groups;
}

const PERSONAL = "";

export interface ResolveContext {
  /** the server being acted on (if any). */
  serverId?: string | null;
  /** groups the server belongs to (for group-scoped grants). */
  serverGroupIds?: string[];
}

function capabilityMatches(grant: Grant, capability: string): boolean {
  return grant.capability === "*" || grant.capability === capability;
}

function scopeApplies(grant: Grant, ctx: ResolveContext): boolean {
  switch (grant.scopeType) {
    case "global":
      return true;
    case "server":
      return !!ctx.serverId && grant.scopeId === ctx.serverId;
    case "group":
      return !!grant.scopeId && !!ctx.serverGroupIds?.includes(grant.scopeId);
    default:
      return false;
  }
}

/**
 * The access level the grants confer for `capability` in `ctx`.
 *
 * Two rules, layered:
 *
 *  1. WITHIN one source (one role, or the personal grants), an explicit `none` is a veto:
 *     it blocks the capability in its scope no matter what the same source also grants.
 *     That is how a role expresses "read everywhere, but not on server X".
 *  2. ACROSS sources, the best level wins, and a vetoed source simply contributes nothing.
 *     People hold every role their Discord roles map to, so a restricted role sitting
 *     beside an admin role must never subtract from it. Before this split one `none` in
 *     ANY held role silently vetoed every other role's write — gaining a role LOST you
 *     access ("lower permissions blocking higher permissions").
 *
 * The one deliberate exception: a PERSONAL `none` (a direct grant on the user, no source)
 * still vetoes across everything. That is the per-person lockout — "this person may not
 * touch this, whatever their roles say" — and it stays impossible to trip by accident
 * precisely because role-borne `none` no longer behaves that way.
 */
export function resolveLevel(grants: Grant[], capability: string, ctx: ResolveContext = {}): AccessLevel {
  let best: AccessLevel = "none";
  for (const [source, group] of bySource(grants)) {
    let groupBest: AccessLevel = "none";
    let vetoed = false;
    for (const g of group) {
      if (!capabilityMatches(g, capability) || !scopeApplies(g, ctx)) continue;
      if (g.level === "none") {
        vetoed = true;
        continue;
      }
      if (ORDER[g.level] > ORDER[groupBest]) groupBest = g.level;
    }
    if (vetoed) {
      if (source === PERSONAL) return "none"; // the per-person lockout outranks every role
      continue;
    }
    if (ORDER[groupBest] > ORDER[best]) best = groupBest;
  }
  return best;
}

/** Does the user meet the `required` level for `capability` in `ctx`? */
export function can(grants: Grant[], capability: string, required: AccessLevel, ctx: ResolveContext = {}): boolean {
  return ORDER[resolveLevel(grants, capability, ctx)] >= ORDER[required];
}

/**
 * Scope-blind access test for navigation: does the user meet `required` for `capability`
 * on ANY server? Used to decide whether a section is shown at all — per-request checks
 * still enforce the exact scope. Vetoes follow resolveLevel's source rule: a GLOBAL
 * explicit `none` silences ITS OWN source everywhere (a personal one hides the section
 * outright); a server-scoped `none` only affects that server, so the section stays
 * visible; and no role's `none` can hide what another role grants.
 */
export function canAnywhere(grants: Grant[], capability: string, required: AccessLevel): boolean {
  let best = 0;
  for (const [source, group] of bySource(grants)) {
    let groupBest = 0;
    let silenced = false;
    for (const g of group) {
      if (!capabilityMatches(g, capability)) continue;
      if (g.level === "none") {
        if (g.scopeType === "global") {
          if (source === PERSONAL) return false; // per-person lockout hides it everywhere
          silenced = true;
        }
        continue;
      }
      if (ORDER[g.level] > groupBest) groupBest = ORDER[g.level];
    }
    if (!silenced && groupBest > best) best = groupBest;
  }
  return best >= ORDER[required];
}

/** Owner preset: full write across everything, everywhere. */
export function ownerGrants(): Grant[] {
  return [{ capability: "*", scopeType: "global", scopeId: null, level: "write" }];
}

/**
 * The panel roles a Discord member's role set grants, and where each one applies.
 *
 * Lives here rather than in either app because BOTH of them decide it: the API when someone signs
 * in with Discord, and the bot's background sweep when it re-checks people who signed in a while
 * ago. They each used to carry their own copy — one commented "mirrors the API's", which is a
 * comment admitting a bug waiting to happen. Two implementations of "what access does this person
 * get" that drift apart mean the sweep quietly grants or revokes something the login would not.
 *
 * Deduping is on role AND scope: one Discord role may grant a panel role on two servers, and two
 * Discord roles may both grant it on the same one. The first is two assignments, the second is one.
 *
 * A member holding no mapped Discord role gets an empty list, which is what denies them sign-in.
 */
export function mappedRoleAssignments(
  memberDiscordRoleIds: string[],
  mappings: { discordRoleId: string; roleId: string; scopeId?: string | null }[],
): { roleId: string; scopeId: string | null }[] {
  const held = new Set(memberDiscordRoleIds);
  const out = new Map<string, { roleId: string; scopeId: string | null }>();
  for (const m of mappings) {
    if (!held.has(m.discordRoleId)) continue;
    const scopeId = m.scopeId ?? null;
    out.set(`${m.roleId}|${scopeId ?? ""}`, { roleId: m.roleId, scopeId });
  }
  return [...out.values()];
}

/**
 * Who may sign an approval request.
 *
 * ONE rule: the signer must be able to PERFORM the action themselves — the capability at write,
 * on that server. No separate approver list or seniority ladder exists, because the matrix
 * already wrote it: anyone may FILE a request (lacking the permission is the ask — there is no
 * grant for proposing), so the write-holders are by construction the senior tier for every
 * action, and a second list saying who outranks whom could only ever disagree with the grants.
 *
 * There is deliberately NO never-yourself clause, and it is worth saying why, because one used
 * to be here. A request climbs: whoever signs it applies as much as their own authority covers
 * and the REMAINDER is filed onwards for someone with more (see the cap cascade in
 * apps/api/src/approvals.ts). So a requester promoted between filing and signing is not
 * "approving themselves" into anything — their signature can only ever reach as far as they
 * could reach unilaterally, and one hour past their own cap still needs somebody above them.
 * The old clause bought no safety and cost the obvious thing: a promoted moderator's request had
 * no path left at all, which is the one case the whole feature exists to serve.
 *
 * Returns the refusal as a sentence, or null when the approval may proceed — the same shape as
 * tempbanRefusal, because the wording of a refusal is part of the contract and the panel shows
 * it verbatim ("needs someone who can permaban on this server").
 */
export function approvalRefusal(
  approver: { userId: string; grants: Grant[] },
  capability: string,
  serverId: string | null | undefined,
): string | null {
  /*
   * A line with no server is a COMMUNITY-wide action (a watch follows the player everywhere), and
   * the routes that perform those ask `canAnywhere`. Testing them with a scope-less `can` would
   * demand a global grant instead — so the admin who watchlists people on the server they run
   * could not sign a request to watchlist somebody, though they may do it themselves all day.
   */
  const allowed = serverId
    ? can(approver.grants, capability, "write", { serverId })
    : canAnywhere(approver.grants, capability, "write");
  if (!allowed) {
    return `approving this needs ${capability} at write${serverId ? " on this server" : ""} — you can only sign what you could do yourself`;
  }
  return null;
}

/** The source tag on request-view elevation grants — see requestViewGrants. */
export const REQUEST_VIEW_SOURCE = "request-view";

/**
 * Does the account ITSELF hold `capability` at `required` everywhere? Global grants only, and never
 * through the request builder's view elevation.
 *
 * For surfaces granted to a person outright that span every server at once. A grant confined to one
 * server is full control of THAT server, not a key to all of them — and an open request draft lends
 * a global read of everything (requestViewGrants), which must not open a need-to-know surface that
 * nobody actually granted. `can` with no server context already resolves global grants only.
 */
export function holdsOutright(grants: Grant[], capability: string, required: AccessLevel): boolean {
  return can(grants.filter((g) => g.source !== REQUEST_VIEW_SOURCE), capability, required);
}

/**
 * The request builder's visibility elevation: what a user with an open draft may SEE on top of
 * their own grants.
 *
 * Building a request means browsing surfaces the request touches — a trial mod proposing a ban
 * wants the player's history and the ban record in front of them, which their own grants may not
 * show. The elevation is READ-CLAMPED grants under one ceiling:
 *
 *   - no ceiling configured (null) → a global wildcard READ: everything readable, nothing more;
 *   - a ceiling role → that role's bundle with every `write` clamped to `read` ("see what the
 *     approvers see, do nothing they do"). Its explicit `none` rows come along, so a capability
 *     the ceiling role is blocked from stays invisible — per-source veto semantics mean they
 *     silence only this elevation, never the user's own grants.
 *
 * Write is decided by the user's REAL grants alone: nothing here ever reaches `write`, so no
 * action gate, submit fate, or approval signature widens. A personal wildcard `none` (the
 * per-person lockout) still vetoes everything, elevation included, because it is source-less.
 */
export function requestViewGrants(ceiling: { capability: string; level: AccessLevel }[] | null): Grant[] {
  if (!ceiling) {
    return [{ capability: "*", scopeType: "global", scopeId: null, level: "read", source: REQUEST_VIEW_SOURCE }];
  }
  return ceiling.map((g) => ({
    capability: g.capability,
    scopeType: "global" as const,
    scopeId: null,
    level: g.level === "write" ? ("read" as const) : g.level,
    source: REQUEST_VIEW_SOURCE,
  }));
}

/**
 * What a ROLE PREVIEW ("View as" on Users & roles) reads with: the previewer's own grants, each
 * held down to what the previewed role confers for its capability.
 *
 * The preview used to narrow only in the panel, while every read still went out on the previewer's
 * own grants — so whatever a screen showed without asking first (the dashboard's cards, the server
 * list, the status line) showed the owner's data inside a role that may hold nothing. Answered here
 * instead, every read is the role's.
 *
 * For any capability on any server the result resolves to the lower of what the previewer holds
 * THERE and what the role confers, so it can only ever show less than the previewer may see:
 *
 *   - a grant naming a capability keeps its scope and source, at no more than the role's level,
 *     and is dropped where the role confers nothing (dropped, never turned into a `none`, which
 *     would veto the rest of its source);
 *   - a wildcard is spelled out capability by capability over `known` (the catalogue — the role's
 *     own and the previewer's named capabilities are added), each held down the same way;
 *   - a GLOBAL wildcard is also kept as a wildcard where the role carries one, for ownership and for
 *     capabilities nobody listed — in a source of its own, beside a veto for every capability the
 *     role holds back (its `none`s), so it can never lift them, and the vetoes its own source held;
 *   - every veto the previewer carries stays as it is.
 *
 * Roles confer global grants (the role editor's), so what the role confers is the same on every
 * server; the previewer's own scopes are what keep a per-server previewer to their servers.
 */
export function previewRoleGrants(
  real: Grant[],
  role: readonly { capability: string; level: AccessLevel }[],
  known: Iterable<string>,
): Grant[] {
  const bundle: Grant[] = role.map((g) => ({ capability: g.capability, scopeType: "global", scopeId: null, level: g.level, source: "role" }));
  const conferred = (capability: string): AccessLevel => resolveLevel(bundle, capability);
  const lower = (a: AccessLevel, b: AccessLevel): AccessLevel => (ORDER[a] < ORDER[b] ? a : b);
  const named = new Set<string>([...known, ...role.map((g) => g.capability), ...real.map((g) => g.capability)]);
  named.delete("*");
  const out: Grant[] = [];
  for (const g of real) {
    if (g.level === "none") { out.push(g); continue; }
    if (g.capability !== "*") {
      const level = lower(g.level, conferred(g.capability));
      if (level !== "none") out.push({ ...g, level });
      continue;
    }
    for (const capability of named) {
      const level = lower(g.level, conferred(capability));
      if (level !== "none") out.push({ ...g, capability, level });
    }
    const star = g.scopeType === "global" ? lower(g.level, conferred("*")) : "none";
    if (star === "none") continue;
    const source = `${g.source ?? ""}#preview`;
    out.push({ ...g, level: star, source });
    for (const capability of named) {
      if (ORDER[conferred(capability)] < ORDER[star]) out.push({ capability, scopeType: "global", scopeId: null, level: "none", source });
    }
    for (const veto of real) {
      if (veto.level === "none" && (veto.source ?? "") === (g.source ?? "")) out.push({ ...veto, source });
    }
  }
  return out;
}
