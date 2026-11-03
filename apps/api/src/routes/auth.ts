/**
 * Signing in and identifying yourself: registration, login, the current user, API tokens, and the Discord OAuth handshake.
 *
 * Lifted verbatim out of app.ts; the order within this file is the order these were declared in.
 */
import { authenticate, displayNameOf, publicUser, resolveAccess } from "../auth.js";
import type { Principal } from "../auth.js";
import { buildAuthorizeUrl, discordAuthConfig, discordGet, isDiscordAuthConfigured, isDiscordTransient, oauthStateCookie, readStateCookie, linkStateNonce, memberRoleIds, parseLinkNonce, signState, verifyState } from "../discord-auth.js";
import { readJsonBody, sendError, sendJson, sendRedirect, str, boundedText, TEXT_MAX } from "../http.js";
import { clientAddrOf } from "../rate-limit.js";
import { panelBaseUrl } from "../panel-links.js";
import { canAnywhere, generateToken, hashPassword, mappedRoleAssignments, ownerGrants, sessionClaims, signSession, verifyPassword, verifySession } from "@app/access";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { logger, outrightTargetRefusal, requirePrincipal, route, sendForbidden, type Route } from "./kit.js";
import { SETUP_CODE_KEY, SETUP_STAGE_KEY, SETUP_THROTTLE_KEY, setupCodesMatch, setupLockedOut, spendSetupCode, WHERE_THE_CODE_IS } from "../setup.js";
import type { AppContext } from "../context.js";

/** How long a sign-in lasts, and how long a renewal extends it to. */
export const SESSION_WEEK_SEC = 7 * 24 * 3600;
/** A sign-in with less than this left of its week is renewed by the next /me (see renewedSession). */
export const SESSION_RENEW_WHEN_LEFT_SEC = 6 * 24 * 3600;
/** How long renewals can keep a sign-in going before a real sign-in is asked for again. */
export const SESSION_MAX_SIGNED_IN_SEC = 30 * 24 * 3600;

/**
 * A fresh week for the sign-in this request came with, when it has less than six days left.
 *
 * A sign-in lasted a week from when it was made and ended there however much the panel was in
 * use, so staff on a phone signed in again every week and landed back on the home screen. The open
 * panel asks for /me every minute, which makes this the place to renew: a sign-in in use stays
 * signed in, one left idle still runs out a week after it was last renewed. The new one carries the
 * account's epoch like any sign-in, so "Sign out everywhere" and a revoked account end it at once.
 * API tokens are left alone — one is no signed sign-in, so it verifies as none here and keeps the
 * expiry it was made with.
 *
 * Renewing stops thirty days after the person last actually signed in. A Discord sign-in checks
 * they are still in the Discord server, and the weekly sign-in was what turned away a hand-managed
 * account whose owner had left it; a monthly one still does.
 */
function renewedSession(req: IncomingMessage, p: Principal, ctx: AppContext): string | null {
  // The request was signed in by this header's Bearer token (authenticate, ../auth.ts).
  const claims = verifySession((req.headers.authorization ?? "").slice("Bearer ".length).trim(), ctx.config.sessionSecret);
  const now = Math.floor(Date.now() / 1000);
  if (!claims || claims.exp - now > SESSION_RENEW_WHEN_LEFT_SEC) return null;
  const signedInAt = claims.auth ?? claims.exp - SESSION_WEEK_SEC;
  const exp = Math.min(now + SESSION_WEEK_SEC, signedInAt + SESSION_MAX_SIGNED_IN_SEC);
  if (exp <= claims.exp) return null; // at its ceiling: the next sign-in is a real one
  return signSession({ sub: p.user.id, exp, ep: p.user.sessionEpoch, auth: signedInAt }, ctx.config.sessionSecret);
}

export const authRoutes: Route[] = [
  // First-run detection for the UI: is the instance uninitialized (no accounts yet)? Returns
  // only a boolean — no auth needed, nothing sensitive exposed.
  route("GET", "/api/auth/status", async (_req, res, ctx) => {
    const hasUsers = (await ctx.repo.users.count()) > 0;
    sendJson(res, 200, { hasUsers });
  }),

  // Bootstrap the first user as owner; afterwards only a global-write user may create users.
  route("POST", "/api/auth/register", async (req, res, ctx) => {
    const body = await readJsonBody(req);
    // Bounded like every other name a person reads in a list: the username is frozen into audit
    // summaries ("created user …") and rendered on every row that cites it, so an unbounded one
    // is a permanent mess rather than a transient request problem.
    const username = boundedText(body.username, TEXT_MAX.name, "username");
    const password = str(body.password);
    if (!username || !password) return sendError(res, 400, "username and password are required");

    const isFirstUser = (await ctx.repo.users.count()) === 0;
    let creator: Principal | null = null;
    // The first account is the owner, so while the install holds a setup code it takes the code:
    // otherwise whoever reached the page first — on a public VM, a scanner — would own the panel.
    if (isFirstUser) {
      const held = await ctx.repo.installSettings.get(SETUP_CODE_KEY);
      if (held !== null) {
        const addr = clientAddrOf(req.headers, req.socket?.remoteAddress ?? undefined);
        const gate = ctx.loginThrottle.check(SETUP_THROTTLE_KEY, addr);
        if (!gate.allowed) {
          res.setHeader("retry-after", String(gate.retryAfterSec));
          return sendError(res, 429, setupLockedOut(gate.retryAfterSec));
        }
        if (!setupCodesMatch(body.setupCode, held)) {
          ctx.loginThrottle.fail(SETUP_THROTTLE_KEY, addr);
          logger.warn("owner account refused: wrong setup code", { addr });
          return sendError(res, 403, `the setup code is missing or wrong — ${WHERE_THE_CODE_IS}`);
        }
      }
    }
    if (!isFirstUser) {
      creator = await authenticate(req, ctx.repo, ctx.config);
      // canAnywhere, like every other admin.users route. The scope-blind form left this one route
      // out of step: a holder of an all-access grant scoped to a single server could edit accounts
      // and roles everywhere else and be refused here alone.
      if (!creator || !canAnywhere(creator.grants, "admin.users", "write")) return sendForbidden(res, "admin.users", "write");
    }

    const user = await ctx.repo.users.create({ username, passwordHash: await hashPassword(password), email: str(body.email) || null });
    if (isFirstUser) {
      for (const g of ownerGrants()) await ctx.repo.grants.create({ userId: user.id, ...g });
      // The code is spent, and the owner is taken through the rest of setup once signed in.
      await spendSetupCode(ctx.repo);
      await ctx.repo.installSettings.set(SETUP_STAGE_KEY, "walkthrough");
    }
    await ctx.repo.audit.create({
      actorUserId: creator?.user.id ?? user.id,
      actorName: creator?.name ?? displayNameOf(user),
      action: isFirstUser ? "user.bootstrap" : "user.create",
      targetType: "user",
      targetId: user.id,
      targetName: displayNameOf(user),
      summary: isFirstUser ? "created as owner (first run)" : `created user ${displayNameOf(user)}`,
    });
    sendJson(res, 201, { user: publicUser(user), owner: isFirstUser });
  }),

  route("POST", "/api/auth/login", async (req, res, ctx) => {
    const body = await readJsonBody(req);
    const username = str(body.username).trim();
    // Throttled BEFORE any lookup or hashing: five failures on a username or thirty from one
    // address inside fifteen minutes, and the answer is a 429 that costs no bcrypt time. The
    // window and the reasoning live in rate-limit.ts.
    const addr = clientAddrOf(req.headers, req.socket?.remoteAddress ?? undefined);
    const gate = ctx.loginThrottle.check(username, addr);
    if (!gate.allowed) {
      logger.warn("login throttled", { username, addr });
      res.setHeader("retry-after", String(gate.retryAfterSec));
      return sendError(res, 429, "too many attempts — try again later");
    }
    const user = await ctx.repo.users.findByUsername(username);
    // A Discord-only account has no password hash — it can never authenticate by password.
    if (!user || !user.passwordHash || !(await verifyPassword(str(body.password), user.passwordHash))) {
      ctx.loginThrottle.fail(username, addr);
      return sendError(res, 401, "invalid credentials");
    }
    ctx.loginThrottle.succeed(username);
    const token = signSession(sessionClaims(user.id, undefined, user.sessionEpoch), ctx.config.sessionSecret);
    sendJson(res, 200, { token, user: publicUser(user) });
  }),

  route("GET", "/api/me", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    // Staff announcements posted since this user last opened the board. Computed here — at the
    // one request every session starts with — so returning staff are told there's news instead of
    // having to remember to check.
    const seenAt = p.user.announcementsSeenAt;
    const published = await ctx.repo.announcements.listPublished(50);
    const unseenAnnouncements = published.filter((a) => !seenAt || a.updatedAt > seenAt).length;
    const renewed = renewedSession(req, p, ctx);
    sendJson(res, 200, {
      user: publicUser(p.user), grants: p.grants, limits: await ctx.repo.userLimits.get(p.user.id),
      roles: p.roles.map((r) => ({ id: r.id, name: r.name })),
      unseenAnnouncements,
      // Display preferences ride along on the request every session already makes, so the panel
      // can apply the account's theme/accent/density on the first paint after sign-in instead of
      // spending a second round trip to find out it is showing the wrong colours.
      prefs: await ctx.repo.users.getPrefs(p.user.id),
      // A fresh week for this sign-in when its current one is running down (renewedSession).
      ...(renewed ? { session: { token: renewed } } : {}),
    });
  }),

  // Your own display preferences — theme, accent, density, landing view, remembered tabs. No
  // capability: these are your own settings, and every signed-in account has exactly one set.
  // PUT takes a PATCH (the panel saves one setting at a time) and answers with the merged whole.
  route("PUT", "/api/me/prefs", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const body = await readJsonBody(req);
    const patch = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
    if (!patch) return sendError(res, 400, "expected an object of preferences");
    // A bounded blob: these are a handful of display choices, and the column should never become
    // somewhere to park arbitrary data.
    if (JSON.stringify(patch).length > 8_000) return sendError(res, 400, "preferences are too large");
    sendJson(res, 200, { prefs: await ctx.repo.users.setPrefs(p.user.id, patch) });
  }),

  /*
   * Change your OWN password. No capability — like prefs, it is your own account — but unlike
   * prefs it demands the CURRENT password first, because that is the whole difference between
   * self-service and the admin reset above it: a stolen session must not be able to mint itself
   * a permanent credential.
   *
   * Wrong guesses spend the login throttle's own budget, deliberately: this route is otherwise a
   * quiet side door for brute-forcing a password that the login front door already rate-limits.
   *
   * On success every OTHER session dies (the epoch bumps) and THIS one continues on the fresh
   * token in the response — "signed out everywhere else" is the standard people expect from a
   * password change, and half the time the reason for the change is a device they lost. API
   * tokens survive on purpose: they are separate credentials, and killing a person's bot because
   * they rotated their password would be a surprise (the admin revoke route kills both, and says
   * so).
   */
  route("PUT", "/api/me/password", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    // A Discord-only account has no password to prove — and letting a session invent one would
    // hand a hijacked tab a way in that outlives the hijack. An admin can set one deliberately.
    if (!p.user.passwordHash) {
      return sendError(res, 400, "this account signs in with Discord and has no password — an admin can set one under Administration → Users");
    }
    const body = await readJsonBody(req);
    const current = str(body.currentPassword);
    const next = str(body.newPassword);
    if (!current || !next) return sendError(res, 400, "currentPassword and newPassword are required");

    const addr = clientAddrOf(req.headers, req.socket?.remoteAddress ?? undefined);
    const gate = ctx.loginThrottle.check(p.user.username, addr);
    if (!gate.allowed) {
      res.setHeader("retry-after", String(gate.retryAfterSec));
      return sendError(res, 429, "too many attempts — try again later");
    }
    if (!(await verifyPassword(current, p.user.passwordHash))) {
      ctx.loginThrottle.fail(p.user.username, addr);
      return sendError(res, 403, "the current password is incorrect");
    }
    ctx.loginThrottle.succeed(p.user.username);

    await ctx.repo.users.setPassword(p.user.id, await hashPassword(next));
    // Bump the epoch FIRST, then sign this session's replacement against the new one — the other
    // way round would hand back a token that the bump immediately invalidates.
    const epoch = (await ctx.repo.users.revokeSessions(p.user.id)) ?? 0;
    const token = signSession(sessionClaims(p.user.id, undefined, epoch), ctx.config.sessionSecret);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "user.password",
      targetType: "user", targetId: p.user.id, targetName: p.name,
      summary: "changed their own password — other sessions were signed out",
    });
    sendJson(res, 200, { ok: true, token });
  }),

  // The user opened the announcements board — everything published up to now stops being "new".
  route("POST", "/api/me/announcements-seen", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    await ctx.repo.users.setAnnouncementsSeen(p.user.id);
    sendJson(res, 200, { ok: true });
  }),

  // A user's own API tokens. Making one takes the api.tokens permission, which every use of the
  // token answers to as well (principalFromToken); seeing and revoking your own takes nothing, so a
  // person who lost it can still clear away what they made. The secret is shown once on create and
  // never again; the list/revoke endpoints never expose the hash.
  route("GET", "/api/tokens", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const tokens = (await ctx.repo.tokens.listByUser(p.user.id)).map(({ tokenHash: _h, ...rest }) => rest);
    sendJson(res, 200, { tokens });
  }),

  route("POST", "/api/tokens", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "api.tokens", "write")) return sendForbidden(res, "api.tokens", "write");
    const body = await readJsonBody(req);
    const { token, hash } = generateToken();
    const row = await ctx.repo.tokens.create({ userId: p.user.id, name: str(body.name) || "token", tokenHash: hash });
    // A token is a second key to this account with the same powers, so its existence is a fact the
    // team should be able to see.
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "token.create",
      targetType: "token", targetId: row.id, targetName: row.name,
      summary: `issued the API token "${row.name}"`,
      data: { tokenId: row.id },
    });
    // token is returned exactly once and never stored in plaintext.
    sendJson(res, 201, { token, id: row.id, name: row.name, createdAt: row.createdAt });
  }),

  route("DELETE", "/api/tokens/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const ok = await ctx.repo.tokens.remove(params.id!, p.user.id);
    if (!ok) return sendError(res, 404, "token not found");
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "token.revoke",
      targetType: "token", targetId: params.id!,
      summary: `revoked an API token`,
      data: { tokenId: params.id },
    });
    sendJson(res, 200, { ok: true });
  }),

  // --- Discord OAuth sign-in ---
  // Public: does the instance offer "Sign in with Discord"? (drives the login button).
  route("GET", "/api/auth/discord/status", async (_req, res, _ctx) => {
    sendJson(res, 200, { configured: isDiscordAuthConfigured(discordAuthConfig()) });
  }),

  // Begin the OAuth flow: sign a short-lived CSRF state and bounce the user to Discord.
  route("GET", "/api/auth/discord/start", async (_req, res, ctx) => {
    const cfg = discordAuthConfig();
    if (!isDiscordAuthConfigured(cfg)) return sendError(res, 503, "Discord sign-in is not configured");
    // The nonce goes two places: signed into the state Discord echoes back, and into a cookie only
    // this browser holds. The callback requires both, which is what stops somebody else's
    // half-finished sign-in from completing in a staff member's browser.
    const nonce = randomUUID();
    res.setHeader("set-cookie", oauthStateCookie(nonce, cfg.redirectUri));
    sendRedirect(res, buildAuthorizeUrl(cfg, signState(ctx.config.sessionSecret, nonce)));
  }),

  // Begin a LINK flow for the logged-in user: same OAuth dance, but the signed state carries their
  // user id, so the callback attaches the verified Discord identity to THIS account instead of
  // signing in — and if that Discord id already auto-created a duplicate account, the duplicate is
  // merged in (its history moves here, then it's deleted). Returns the URL as JSON because the
  // panel calls this with its bearer token and then navigates; a bare redirect would arrive
  // unauthenticated.
  route("GET", "/api/auth/discord/link/start", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const cfg = discordAuthConfig();
    if (!isDiscordAuthConfigured(cfg)) return sendError(res, 503, "Discord sign-in is not configured");
    // Link mode already binds the state to a user id, so it cannot be minted for somebody else —
    // but it gets the same cookie anyway, so the callback has one rule instead of two.
    const nonce = linkStateNonce(p.user.id, randomUUID());
    res.setHeader("set-cookie", oauthStateCookie(nonce, cfg.redirectUri));
    sendJson(res, 200, { url: buildAuthorizeUrl(cfg, signState(ctx.config.sessionSecret, nonce)) });
  }),

  // OAuth redirect target: exchange the code, read the member's guild roles, map → panel roles,
  // provision/refresh the account, and hand a session token back to the panel via the URL fragment.
  route("GET", "/api/auth/discord/callback", async (req, res, ctx) => {
    const cfg = discordAuthConfig();
    const panelBase = panelBaseUrl();
    const back = (frag: string) => sendRedirect(res, `${panelBase}/#${frag}`);
    // A refused sign-in bounces the user back to the login screen with a message. That message is
    // deliberately vague to the browser, so ALSO log the reason (plus any detail) server-side —
    // otherwise "it just sends me back to the login page" is undiagnosable from the logs.
    const refuse = (reason: string, detail?: Record<string, unknown>) => {
      logger.warn("discord sign-in refused", { reason, ...detail });
      return back("discord_error=" + encodeURIComponent(reason));
    };
    if (!isDiscordAuthConfigured(cfg)) return sendError(res, 503, "Discord sign-in is not configured");

    const url = new URL(req.url ?? "", "http://x").searchParams;
    const code = url.get("code") ?? "";
    const state = url.get("state") ?? "";
    const nonce = verifyState(ctx.config.sessionSecret, state);
    // Spend the cookie whatever happens next: a nonce that has reached the callback once must not
    // be usable a second time, including after a refusal.
    const cookieNonce = readStateCookie(req.headers.cookie);
    res.setHeader("set-cookie", oauthStateCookie(null, cfg.redirectUri));
    if (!code || !nonce) return refuse("sign-in expired or invalid — try again", { hasCode: Boolean(code), stateOk: Boolean(nonce) });
    // The signature says the state is ours; this says it is THIS browser's. Without it, a signed
    // state is only proof that somebody — anybody — started a flow.
    if (!cookieNonce || cookieNonce !== nonce) {
      return refuse("sign-in did not start in this browser — try again from the sign-in page", { hadCookie: Boolean(cookieNonce) });
    }
    // A link-mode state means a logged-in user is attaching Discord to their existing account.
    const linkUserId = parseLinkNonce(nonce);

    try {
      // 1) Exchange the auth code for an access token.
      const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: "authorization_code",
          code, redirect_uri: cfg.redirectUri,
        }),
        // A person is waiting on this: the browser is parked on the OAuth callback until it
        // answers. Without a deadline a stalled socket holds the tab there indefinitely, with no
        // error to act on. Fifteen seconds and they get a message they can retry.
        signal: AbortSignal.timeout(15_000),
      });
      if (!tokenRes.ok) return refuse("Discord rejected the sign-in", { status: tokenRes.status, body: (await tokenRes.text()).slice(0, 300) });
      const tok = (await tokenRes.json()) as { access_token?: string };
      if (!tok.access_token) return refuse("Discord did not return a token");

      // 2) Who is this, and what are their roles in our guild?
      // Both reads go through discordGet, which retries Discord being busy rather than reporting it
      // as an answer about the user — see discord-auth.ts. What survives the retries still has to
      // be told apart: "Discord is down" and "you are not in this guild" need opposite reactions
      // from the person reading the message, and they used to get the second for both.
      const authHeader = { authorization: `Bearer ${tok.access_token}` };
      const unavailable = "Discord isn't answering right now — wait a moment and try signing in again";
      const meRes = await discordGet("https://discord.com/api/users/@me", authHeader);
      if (!meRes.ok) return refuse(isDiscordTransient(meRes.status) ? unavailable : "could not read your Discord account", { status: meRes.status });
      const me = (await meRes.json()) as { id?: string; username?: string; global_name?: string };
      if (!me.id) return refuse("could not read your Discord account");
      const memberRes = await discordGet(`https://discord.com/api/users/@me/guilds/${cfg.guildId}/member`, authHeader);
      if (!memberRes.ok) {
        // 404 is Discord's answer for "this user is not in that guild" — the only status that
        // genuinely means what the old message said.
        const reason = memberRes.status === 404
          ? "you're not a member of this Discord server"
          : isDiscordTransient(memberRes.status)
            ? unavailable
            : "the sign-in could not read your server membership — the Discord app may be missing the guilds.members.read scope";
        return refuse(reason, { status: memberRes.status, guildId: cfg.guildId });
      }
      const member = await memberRes.json();
      const roleIdsHeld = memberRoleIds(member);
      const handle0 = me.username || null;
      const nick0 = (member as { nick?: string | null } | null)?.nick || me.global_name || me.username || `discord:${me.id}`;

      // LINK MODE: attach this verified Discord identity to the requesting account. No role-map
      // gate here — the account's access already exists (manual roles); only membership matters.
      if (linkUserId) {
        const target = await ctx.repo.users.findById(linkUserId);
        if (!target) return refuse("that account no longer exists");
        const holder = await ctx.repo.users.findByDiscordId(me.id);
        let merged: string | null = null;
        if (holder && holder.id !== target.id) {
          // The Discord id already lives on another account — almost always the auto-created
          // duplicate from a first Discord sign-in. The OAuth round-trip just proved the presser
          // owns that Discord account, so fold the duplicate's history into the account they're
          // actually logged into and let the identity transfer.
          //
          // The merge deletes that account, and its roles and grants go with it, so it answers to
          // what the merge under Users refuses: never the setup account (its server keys would pass
          // to the next-oldest login), never one holding more than the account signed in — the last
          // owner among them. That is losing access, not tidying a duplicate.
          if (holder.id === await ctx.repo.users.firstUserId()) {
            return refuse(`this Discord account is already linked to "${holder.username}", the setup account, which cannot be merged away — sign in with Discord to use it`);
          }
          const [targetAccess, holderAccess] = await Promise.all([resolveAccess(ctx.repo, target.id), resolveAccess(ctx.repo, holder.id)]);
          if (outrightTargetRefusal(targetAccess.grants, holderAccess.grants)) {
            return refuse(`this Discord account is already linked to "${holder.username}", which holds permissions this account does not, and linking here would delete it — sign in with Discord to use it, or ask an owner to merge the two under Administration → Users`);
          }
          const survived = await ctx.repo.users.merge(target.id, holder.id);
          if (!survived) return refuse("could not merge the duplicate account");
          merged = holder.username;
          await ctx.repo.users.linkDiscord(target.id, { discordId: me.id, username: handle0, nick: nick0 });
        } else {
          // Unclaimed (or already ours): plain attach/refresh. discordManaged is left untouched so
          // a manual account's hand-tuned roles stay hand-tuned until the admin flips the toggle.
          await ctx.repo.users.linkDiscord(target.id, { discordId: me.id, username: handle0, nick: nick0 });
        }
        await ctx.repo.audit.create({
          // nick0 over the row we read: that read happened BEFORE the link, so the row still
          // carries the pre-link name. nick0 is what we just set it to.
          actorUserId: target.id, actorName: nick0, action: merged ? "user.merge" : "user.discord_link",
          targetType: "user", targetId: target.id, targetName: nick0,
          summary: merged
            ? `linked Discord and absorbed duplicate account "${merged}" (history combined)`
            : "linked their Discord account",
          data: { discordId: me.id, mergedUsername: merged },
        }).catch(() => {});
        return back(merged ? "discord_linked=merged" : "discord_linked=1");
      }

      // 3) Map Discord roles → panel roles. No mapped role ⇒ no access (the configured gate).
      const mappings = await ctx.repo.discordRoleMap.list();
      // Each assignment carries the server it applies on, so a Discord role mapped for one
      // server signs the person in with access there and nowhere else.
      const mappedRoles = mappedRoleAssignments(roleIdsHeld, mappings);
      if (mappedRoles.length === 0) return refuse("your Discord roles don't grant access here — an admin must map one of them under Discord \u2192 Sign-in & roles", { discordRoles: roleIdsHeld, mappingsConfigured: mappings.length });

      // 4) Provision or refresh the linked account. New users are Discord-managed and get their roles
      // synced from the mapping. An existing user whose admin turned OFF "manage roles from Discord"
      // (discordManaged=false) keeps their hand-tuned roles — we refresh the display name but neither
      // re-sync roles nor flip them back to managed.
      // Discord gives three names. Keep the @handle (stable, unique) AND the guild nickname
      // (what the team actually calls each other, and what changes). Identity is me.id, which never
      // changes — so a rename only refreshes these display fields, it never creates a second account.
      const handle = handle0;
      const nick = nick0;
      let user = await ctx.repo.users.findByDiscordId(me.id);
      let managed = true;
      if (!user) {
        // The panel username is the account key and stays put once created (renaming it on every
        // Discord change would churn a UNIQUE column); display always comes from the fields above.
        const base = (handle || nick).slice(0, 40);
        const taken = await ctx.repo.users.findByUsername(base);
        const username = taken ? `${base}#${me.id.slice(-4)}` : base;
        user = await ctx.repo.users.create({ username, discordId: me.id, discordUsername: handle, discordNick: nick, discordManaged: true });
      } else {
        managed = user.discordManaged;
        await ctx.repo.users.linkDiscord(user.id, { discordId: me.id, username: handle, nick, managed });
      }
      if (managed) await ctx.repo.userRoles.set(user.id, mappedRoles);
      await ctx.repo.audit.create({
        // Same as the link path: `nick` is the name Discord just gave us, `user` predates the refresh.
        actorUserId: user.id, actorName: nick, action: "user.discord_login",
        targetType: "user", targetId: user.id, targetName: nick,
        summary: managed
          ? `signed in via Discord (${mappedRoles.length} role${mappedRoles.length === 1 ? "" : "s"} synced)`
          : "signed in via Discord (roles hand-managed — not synced)",
        data: { discordId: me.id, roles: mappedRoles, managed },
      }).catch(() => {});

      const token = signSession(sessionClaims(user.id, undefined, user.sessionEpoch), ctx.config.sessionSecret);
      return back("discord_token=" + encodeURIComponent(token));
    } catch (err) {
      return refuse(`sign-in failed: ${(err as Error).message}`);
    }
  }),
];
