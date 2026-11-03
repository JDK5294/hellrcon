import { CAPABILITY_CATALOG, canAnywhere, hashToken, looksLikeToken, previewRoleGrants, requestViewGrants, verifySession } from "@app/access";
import type { Grant } from "@app/access";
import type { Repository, RoleAssignment, RoleRow, UserRow } from "@app/db";
import type { IncomingMessage } from "node:http";
import type { ApiConfig } from "./config.js";

export interface Principal {
  user: UserRow;
  /**
   * What to CALL this person — `displayNameOf(user)`, resolved once per request.
   *
   * Every place that records who did something reaches for a name, and reaching for
   * `user.username` there is a trap: that column is the account KEY, unique and deliberately
   * never renamed, so a Discord-linked account is stuck with the @handle it was provisioned
   * from. Written into an audit summary, a ban's admin field or a `createdByName`, that wrong
   * name is frozen forever — those are strings, not references, and nothing resolves them later.
   */
  name: string;
  /** EFFECTIVE grants: the union of individual grants and every held role's grants. */
  grants: Grant[];
  /** the user's own grants only (what the permission editor shows/edits). */
  personalGrants: Grant[];
  /** the distinct roles held by the user (their grants are folded into `grants`). */
  roles: RoleRow[];
  /** which roles are held WHERE — the same role may appear twice at different scopes. */
  assignments: RoleAssignment[];
  /** the role-derived half of `grants`, already scoped. */
  roleDerivedGrants: Grant[];
  /**
   * Set only while an approved request is carried out: the account whose grants these are — the
   * signer — while `user` is the requester the work is credited to. A "not your own account"
   * guard asks about both (routes/kit `ownAccounts`), so a request naming the signer's account
   * cannot do to it what the signer could not do to it by hand.
   */
  signer?: { userId: string; name: string };
  /**
   * Set while the panel previews a role ("View as"): the role `grants` were held down to. Reads
   * answer as that role would see them, and nothing may be written (routes/kit requirePrincipal).
   */
  preview?: { roleId: string };
}

/**
 * A role's bundle as RBAC grants, projected into the scope it was assigned at.
 *
 * The role itself names no server — it is a reusable set of capabilities — so the server comes
 * from the assignment. `scopeId: null` is the old behaviour and still means everywhere; a server
 * id turns every capability in the bundle into a grant on that server alone. This is the hop that
 * makes a per-server Discord mapping mean anything: it used to hardcode global here, so a role
 * mapped "for Server A" silently granted its capabilities across the whole community.
 */
export function roleGrants(role: RoleRow, scopeId: string | null = null): Grant[] {
  return role.grants.map((g) => ({
    capability: g.capability,
    scopeType: scopeId ? ("server" as const) : ("global" as const),
    scopeId,
    level: g.level,
    // Vetoes are per-source: this role's explicit `none` rows bind THIS role's grants only,
    // never another role's (see resolveLevel). Personal grants carry no source, so a direct
    // `none` on the user remains the absolute lockout.
    source: role.id,
  }));
}

/** Load a user's roles + effective grants (personal ∪ roles, each at its own scope). */
export async function resolveAccess(repo: Repository, userId: string): Promise<{
  personalGrants: Grant[]; roles: RoleRow[]; assignments: RoleAssignment[]; roleDerivedGrants: Grant[]; grants: Grant[];
}> {
  // Independent reads, so they go together. This runs on every authenticated request; awaiting
  // them one after another paid two round trips where one will do.
  const [personalGrants, assignments] = await Promise.all([
    repo.grants.listByUser(userId) as Promise<Grant[]>,
    repo.userRoles.listByUser(userId),
  ]);
  // One query for every distinct role, however many scopes each is held at. This was a `get` per
  // role — fine for one role, N round trips for a user who holds several.
  const wanted = [...new Set(assignments.map((a) => a.roleId))];
  const byId = new Map((await repo.roles.getMany(wanted)).map((r) => [r.id, r]));
  // Returned already scoped so callers never re-derive them — doing that by hand is how a
  // server-scoped role would get mistaken for a global one.
  const roleDerivedGrants = assignments.flatMap((a) => {
    const role = byId.get(a.roleId);
    return role ? roleGrants(role, a.scopeId) : [];
  });
  // `roles` is the distinct set the user holds — what the UI lists as their roles.
  return { personalGrants, roles: [...byId.values()], assignments, roleDerivedGrants, grants: [...personalGrants, ...roleDerivedGrants] };
}

/** Resolve a principal from a raw token string (session token OR API token), or null. */
export async function principalFromToken(token: string, repo: Repository, config: ApiConfig): Promise<Principal | null> {
  const t = token.trim();
  if (!t) return null;

  let userId: string | null = null;
  // Only a session token carries an epoch; a stored API token is revoked by deleting its row.
  let epoch: number | null = null;
  if (looksLikeToken(t)) {
    const row = await repo.tokens.findByHash(hashToken(t));
    if (row && (!row.expiresAt || Date.parse(row.expiresAt) > Date.now())) userId = row.userId;
  } else {
    const claims = verifySession(t, config.sessionSecret);
    userId = claims?.sub ?? null;
    epoch = claims ? claims.ep ?? 0 : null;
  }
  if (!userId) return null;

  // The account and its access are independent reads, so they overlap. Every authenticated request
  // pays this, and fetching the user first only to then fetch its grants meant an extra serial
  // round trip on all of them. A token for a deleted or re-epoched account does the access reads
  // and throws them away — cheap indexed queries, in the case that is rare by construction.
  // The draft lookup rides in the same batch: an open draft is the request builder's visibility
  // elevation (see below), and it has to be answered on every request anyway to be worth anything.
  const [user, access, draft] = await Promise.all([
    repo.users.findById(userId), resolveAccess(repo, userId), repo.approvals.findDraft(userId),
  ]);
  if (!user) return null;
  // The signature says the token was ours and has not expired; this says the account still honours
  // it. Without the comparison a leaked session is good for its full seven days and nothing short
  // of deleting the account can stop it — which is why the epoch exists.
  if (epoch !== null && epoch !== user.sessionEpoch) return null;
  // An API token works only while its maker may make one. Otherwise taking the permission away
  // would stop new tokens and leave every old one working, which limits nothing.
  if (looksLikeToken(t) && !canAnywhere(access.grants, "api.tokens", "write")) return null;
  /*
   * REQUEST-VIEW ELEVATION: while this user has an open draft (request mode), their READ view is
   * widened so they can browse the surfaces their request touches — capped by the configured
   * ceiling role ("see what the approvers see"), or everything readable when no ceiling is set.
   * The open draft is the server-verifiable signal for "building a request"; the elevation rides
   * on `grants` (never on personalGrants, so the permission editor still shows the truth), is
   * clamped to read by requestViewGrants, and a dangling ceiling role id fails CLOSED — no
   * elevation at all — because a deleted role must never silently widen into "everything".
   */
  let grants = access.grants;
  // A PARKED draft ("Save draft") is kept but confers nothing — leaving the builder ends the
  // widened view; resuming it un-parks and the elevation returns with the bar.
  if (draft && !draft.parkedAt) {
    const ceilingId = (await repo.appConfig.get()).requestCeilingRoleId;
    if (!ceilingId) grants = [...grants, ...requestViewGrants(null)];
    else {
      const ceiling = await repo.roles.get(ceilingId);
      if (ceiling) grants = [...grants, ...requestViewGrants(ceiling.grants)];
    }
  }
  return { user, name: displayNameOf(user), ...access, grants };
}

/** Resolve the authenticated principal from a Bearer token (session token OR API token). */
export async function authenticate(req: IncomingMessage, repo: Repository, config: ApiConfig): Promise<Principal | null> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const p = await principalFromToken(header.slice("Bearer ".length), repo, config);
  return p ? withRolePreview(p, req, repo) : null;
}

/** Signing in by `?token=`: the only way an EventSource can, so the stream routes take it too. */
export async function authenticateByQuery(req: IncomingMessage, repo: Repository, config: ApiConfig): Promise<Principal | null> {
  const p = await principalFromToken(new URL(req.url ?? "", "http://x").searchParams.get("token") ?? "", repo, config);
  return p ? withRolePreview(p, req, repo) : null;
}

/** The role a request previews: the panel names it on every read while "View as" is on — in a
 *  header, or in the address for the live stream, which cannot carry one. */
function previewRoleOf(req: IncomingMessage): string | null {
  const header = req.headers["x-preview-role"];
  const named = (typeof header === "string" ? header : new URL(req.url ?? "", "http://x").searchParams.get("previewRole") ?? "").trim();
  return named || null;
}

/**
 * A role preview, answered as the role: the previewer's grants held down to the role's
 * (previewRoleGrants), so every read inside "View as" is what that role would get, and never more
 * than the previewer may see. The panel used to narrow only its own screens, so whatever a screen
 * showed without asking first came back on the previewer's grants.
 *
 * Only someone who may read roles looks through one; anyone else is answered as themselves. A role
 * deleted mid-preview shows nothing, rather than the previewer's own view.
 */
export async function withRolePreview(p: Principal, req: IncomingMessage, repo: Repository): Promise<Principal> {
  const roleId = previewRoleOf(req);
  if (!roleId || !canAnywhere(p.grants, "admin.users", "read")) return p;
  const role = await repo.roles.get(roleId);
  const grants = role ? previewRoleGrants(p.grants, role.grants, CAPABILITY_CATALOG.map((d) => d.key)) : [];
  return { ...p, grants, preview: { roleId } };
}

/**
 * The name to SHOW for a user. Discord-linked accounts go by their guild nickname (what the team
 * calls each other), falling back to the @handle, then the panel account name. Identity is never
 * the name — it's the user id / discord id — so renaming is purely cosmetic.
 */
export function displayNameOf(user: Pick<UserRow, "username" | "discordNick" | "discordUsername">): string {
  return user.discordNick || user.discordUsername || user.username;
}

/** Shape a user for API responses (never expose the password hash). */
export function publicUser(user: UserRow): { id: string; username: string; displayName: string; email: string | null; createdAt: string; discordId: string | null; discordUsername: string | null; discordNick: string | null; discordManaged: boolean; hasPassword: boolean } {
  return {
    id: user.id, username: user.username, displayName: displayNameOf(user), email: user.email, createdAt: user.createdAt,
    discordId: user.discordId, discordUsername: user.discordUsername, discordNick: user.discordNick,
    discordManaged: user.discordManaged, hasPassword: Boolean(user.passwordHash),
  };
}
