/**
 * The Discord integration: setup status, per-server relay config, role mapping, and inbound interactions.
 *
 * Lifted verbatim out of app.ts; the order within this file is the order these were declared in.
 */
import { discordAuthConfig, isDiscordAuthConfigured } from "../discord-auth.js";
import { communityGuild } from "../discord-guild.js";
import { launcherMessage } from "../discord-public.js";
import { handleInteraction, registerCommands } from "../discord.js";
import { previewServerScreen, previewStaffPanel } from "../discord-preview.js";
import { decideFromDiscord } from "../approvals-relay.js";
import { readJsonBody, readRawBody, readRawBodyBuffer, sendError, sendJson, str } from "../http.js";
import { can, canAnywhere } from "@app/access";
import { DISCORD_RELAY_CATEGORIES, DISCORD_RELAY_DEFAULTS, installEnvSetting } from "@app/db";
import type { AppContext } from "../context.js";
import { refreshInstallEnv } from "../install-env.js";
import { priorOf } from "../audit-changes.js";
import { assignmentGrants, outrightGain, outrightTargetRefusal, parseDiscordCommands, parseDiscordRelay, parseRoleAssignments, requirePrincipal, route, sendForbidden, serverRoute, type Route } from "./kit.js";

/** The panel's callback path: Discord sends a signing-in member back here (routes/auth.ts). */
const CALLBACK_PATH = "/api/auth/discord/callback";

/**
 * The Setup & status form's fields: the variable each sets (install-env.ts), what the trail calls
 * it, and how a pasted value is tidied and checked.
 */
const DISCORD_SETUP_FIELDS: { field: string; env: string; label: string; tidy: (v: string) => string | { error: string } }[] = [
  { field: "botToken", env: "DISCORD_TOKEN", label: "bot token", tidy: (v) => {
    const token = v.replace(/^Bot\s+/i, "");
    return /\s/.test(token) ? { error: "the bot token has a space in it — copy it again from the Developer Portal (Bot → Reset Token)" } : token;
  } },
  { field: "appId", env: "DISCORD_APP_ID", label: "application id", tidy: (v) => snowflake(v, "the application id") },
  { field: "publicKey", env: "DISCORD_PUBLIC_KEY", label: "public key", tidy: (v) => (/^[0-9a-f]{64}$/i.test(v) ? v.toLowerCase() : { error: "the public key is 64 letters and digits — Developer Portal → General Information → Public Key" }) },
  { field: "clientId", env: "DISCORD_CLIENT_ID", label: "OAuth client id", tidy: (v) => snowflake(v, "the OAuth client id") },
  { field: "clientSecret", env: "DISCORD_CLIENT_SECRET", label: "OAuth client secret", tidy: (v) => (/\s/.test(v) ? { error: "the client secret has a space in it — copy it again from the Developer Portal (OAuth2 → Reset Secret)" } : v) },
  { field: "guildId", env: "DISCORD_GUILD_ID", label: "staff server id", tidy: (v) => snowflake(v, "the staff server id") },
  { field: "redirectUri", env: "DISCORD_OAUTH_REDIRECT", label: "sign-in return address", tidy: (v) => {
    let u: URL;
    try { u = new URL(v); } catch { return { error: `the return address is the panel's web address followed by ${CALLBACK_PATH}` }; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return { error: "the return address starts with https://" };
    // The panel's address alone is enough: the path is always this one.
    const path = u.pathname.replace(/\/+$/, "");
    if (path !== "" && path !== CALLBACK_PATH) return { error: `the return address ends in ${CALLBACK_PATH}` };
    return `${u.origin}${CALLBACK_PATH}`;
  } },
];
function snowflake(v: string, what: string): string | { error: string } {
  return /^\d{5,25}$/.test(v) ? v : { error: `${what} is a long number — in Discord, turn on Developer Mode and use Copy ID` };
}

/** Which pieces are set (secrets as booleans only), the non-secret values, and what they unlock. */
async function discordSetupReadout(ctx: AppContext) {
  const cfg = discordAuthConfig();
  const env = process.env;
  const has = (v: string | undefined) => Boolean(v && v.trim());
  const pieces = {
    botToken: has(env.DISCORD_TOKEN),
    appId: has(env.DISCORD_APP_ID),
    publicKey: has(env.DISCORD_PUBLIC_KEY),
    clientId: has(cfg.clientId),
    clientSecret: has(cfg.clientSecret),
    guildId: has(cfg.guildId),
    redirectUri: has(cfg.redirectUri),
  };
  // Non-secret values are safe to echo so the operator can eyeball them; secrets are booleans only.
  const app = await ctx.repo.appConfig.get();
  const values = {
    guildId: cfg.guildId || null, redirectUri: cfg.redirectUri || null, clientId: cfg.clientId || null,
    appId: env.DISCORD_APP_ID || null, publicKey: env.DISCORD_PUBLIC_KEY || null,
    communityGuildId: app.communityGuildId || null,
  };
  const features = {
    relay: pieces.botToken,                                   // outbound event posting
    interactions: pieces.publicKey,                            // inbound slash commands
    signIn: isDiscordAuthConfigured(cfg),                     // OAuth login
    roleSync: pieces.botToken && pieces.guildId,               // background role re-sync
    commandRegistration: pieces.botToken && pieces.appId,      // /slash command install
  };
  return { pieces, values, features };
}

/** The STAFF guild: the one that decides who may sign in, whose role map also gates the bot. */
const staffGuildId = (): string => discordAuthConfig().guildId || process.env.DISCORD_GUILD_ID || "";

/** The match board badge's ceiling: a crisp badge is a few hundred kilobytes. */
export const BOARD_BADGE_MAX_BYTES = 2_000_000;

/**
 * What a badge upload really is, from its first bytes: one of the three formats the board's renderer
 * reads, or null. Never what the request says it is, which costs nothing to get wrong.
 */
export function badgeImageType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

export const discordRoutes: Route[] = [
  // --- The match board's corner badge: the community's own image, one for every server's board. It
  // shipped inside the program once, which put one community's badge on every install's board; now
  // each community uploads its own, and without one the board carries only the server's name. Anyone
  // who may see a match board may see it; changing it changes every server's board, so that takes the
  // match board's permission for every server, not for one. ---
  route("GET", "/api/discord/board-badge", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "discord.relay", "read")) return sendForbidden(res, "discord.relay", "read");
    const image = await ctx.repo.brandImages.get("board-badge");
    if (!image) return sendError(res, 404, "no match board badge");
    res.writeHead(200, { "content-type": image.mime, "content-length": String(image.bytes.byteLength), "cache-control": "no-store" });
    res.end(Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength));
  }),

  route("PUT", "/api/discord/board-badge", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!can(p.grants, "discord.relay", "write")) return sendForbidden(res, "discord.relay", "write");
    let bytes: Buffer;
    try {
      bytes = await readRawBodyBuffer(req, BOARD_BADGE_MAX_BYTES);
    } catch {
      return sendError(res, 400, "the badge is larger than 2 MB");
    }
    const mime = badgeImageType(bytes);
    if (!mime) return sendError(res, 400, "the badge must be a PNG, JPG or WebP image");
    const before = await ctx.repo.brandImages.get("board-badge");
    await ctx.repo.brandImages.set("board-badge", { mime, bytes, by: p.name });
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "discord.board-badge",
      targetType: "system", targetId: "board-badge",
      summary: before ? "replaced the match board badge" : "set the match board badge",
      data: { mime, bytes: bytes.length },
    });
    sendJson(res, 200, { ok: true, mime, bytes: bytes.length });
  }),

  route("DELETE", "/api/discord/board-badge", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!can(p.grants, "discord.relay", "write")) return sendForbidden(res, "discord.relay", "write");
    const removed = await ctx.repo.brandImages.remove("board-badge");
    if (removed) {
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "discord.board-badge",
        targetType: "system", targetId: "board-badge", summary: "removed the match board badge", data: { removed: true },
      });
    }
    sendJson(res, 200, { removed });
  }),

  // --- Discord relay routing (per server): which event categories post to which channels. The bot
  // token stays in the env; this only manages the channel map. server.config-gated. ---
  serverRoute("GET", "/api/servers/:id/discord", "discord.relay", "read", async ({ res, ctx, params }) => {
    const stored = await ctx.repo.discordRelay.getConfig(params.id!);
    const config = stored ?? { serverId: params.id!, ...DISCORD_RELAY_DEFAULTS, updatedAt: new Date(0).toISOString() };
    // botConfigured tells the panel whether a token exists at all (so it can warn if not).
    sendJson(res, 200, { config, categories: DISCORD_RELAY_CATEGORIES, botConfigured: Boolean(process.env.DISCORD_TOKEN), configured: stored !== null });
  }),

  serverRoute("PUT", "/api/servers/:id/discord", "discord.relay", "write", async ({ req, res, ctx, params, p, server }) => {
    // The stored row goes in so the status board's message id survives the save (see parseDiscordRelay).
    const stored = await ctx.repo.discordRelay.getConfig(params.id!);
    const parsed = parseDiscordRelay(await readJsonBody(req), stored);
    if ("error" in parsed) return sendError(res, 400, parsed.error);
    const before = priorOf(stored, parsed.value, DISCORD_RELAY_DEFAULTS);
    const config = await ctx.repo.discordRelay.upsertConfig(params.id!, parsed.value);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "discord.relay.config",
      targetType: "server", targetId: params.id!, targetName: server.name, serverId: params.id!,
      summary: `updated Discord relay for ${server.name}${config.enabled ? "" : " (disabled)"} — ${config.categories.length} categor${config.categories.length === 1 ? "y" : "ies"}`,
      data: { patch: parsed.value, before },
    });
    sendJson(res, 200, { config });
  }),

  // Post a one-off test message to a category's channel, using the bot token, so staff can confirm
  // the routing works before enabling it. Doesn't require the relay to be enabled.
  serverRoute("POST", "/api/servers/:id/discord/test", "discord.relay", "write", async ({ req, res, ctx, params, server }) => {
    // Validate the request (400s) before checking server-side prerequisites (409s).
    const category = str((await readJsonBody(req)).category).trim();
    if (!DISCORD_RELAY_CATEGORIES.includes(category as typeof DISCORD_RELAY_CATEGORIES[number])) return sendError(res, 400, "unknown category");
    const config = await ctx.repo.discordRelay.getConfig(params.id!);
    const channelId = config?.channels?.[category];
    if (!channelId) return sendError(res, 400, `no channel set for "${category}"`);
    const token = process.env.DISCORD_TOKEN;
    if (!token) return sendError(res, 409, "no Discord bot token is set — add it under Discord → Setup & status");
    const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ content: `✅ Relay test — **${category}** relay for **${server.name}** is wired up.`, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return sendError(res, 502, `Discord rejected the test (${r.status}) — check the channel id and that the bot can post there`);
    sendJson(res, 200, { ok: true });
  }),

  // Discord HTTP-interactions endpoint. PUBLIC — authenticated by Discord's Ed25519 signature, not
  // our session (Discord validates the endpoint by POSTing a signed PING). Handles slash commands.
  route("POST", "/api/discord/interactions", async (req, res, ctx) => {
    const raw = await readRawBody(req);
    const result = await handleInteraction(
      ctx.repo,
      process.env.DISCORD_PUBLIC_KEY ?? "",
      { signature: String(req.headers["x-signature-ed25519"] ?? ""), timestamp: String(req.headers["x-signature-timestamp"] ?? "") },
      raw,
      {
        registry: ctx.pluginRuntime.discordModules, publicRegistry: ctx.pluginRuntime.publicModules, appId: process.env.DISCORD_APP_ID,
        // The relay card's Approve/Deny buttons — same decision path as the panel's queue.
        approvals: { decide: (d) => decideFromDiscord(ctx, d) },
      },
    );
    // A deferred module's follow-up runs after the ACK is on the wire — that is the whole point.
    sendJson(res, result.status, result.body);
  }),

  // Post the permanent VIP-panel launcher into a channel — "Staff launches vip panel opener".
  // The message's button carries a STATIC custom_id, so it works forever, across restarts.
  route("POST", "/api/discord/vip-launcher", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "economy.config", "write")) return sendForbidden(res, "economy.config", "write");
    const channelId = str((await readJsonBody(req)).channelId).trim();
    if (!/^\d{5,25}$/.test(channelId)) return sendError(res, 400, "channelId must be a numeric Discord channel id");
    const token = process.env.DISCORD_TOKEN;
    if (!token) return sendError(res, 409, "no Discord bot token is set — add it under Discord → Setup & status");
    const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...launcherMessage(), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return sendError(res, 502, `Discord rejected the post (${r.status}) — check the channel id and that the bot can post there`);
    // The channel goes in the SUMMARY, not just the data: "posted a launcher somewhere" is not
    // an answer, and the trail is read as a list of sentences.
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "economy.launcher",
      targetType: "discord-channel", targetId: channelId, targetName: `channel ${channelId}`,
      summary: `posted the VIP panel launcher to channel ${channelId}`,
      data: { channelId, via: "app" },
    });
    sendJson(res, 200, { ok: true });
  }),

  // --- Discord role → panel role mapping (admin) ---
  // The guild's roles (id + name + color), fetched via the bot token, for the mapping UI.
  route("GET", "/api/discord/roles", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    // Every screen that names Discord roles reads them here: the role MAP (admin.users), the
    // economy's claim gates (economy.manage), the bot setup tab (discord.setup), a rule's "only
    // players holding" gate and its exemptions (admin.moderation — without the list a rules editor
    // could not exempt staff from a rule that punishes), and a player group's tie to a role
    // (player.groups). What it returns is public guild furniture — role names, ids and colours — so
    // widening the read to the screens that legitimately need it discloses nothing new.
    if (!canAnywhere(p.grants, "admin.users", "read") && !canAnywhere(p.grants, "economy.config", "read")
      && !canAnywhere(p.grants, "economy.payout", "read") && !canAnywhere(p.grants, "discord.setup", "read")
      && !canAnywhere(p.grants, "admin.moderation", "read") && !canAnywhere(p.grants, "player.groups", "read")) {
      return sendForbidden(res, "admin.users", "read");
    }
    // WHICH Discord server's roles. A community is usually two: the STAFF server that decides who
    // may sign in (DISCORD_GUILD_ID), and the PUBLIC one everybody joins, where the VIP panel lives.
    // The role map wants staff roles; the claim gates want public ones. Asking for the wrong guild
    // was why the claim picker only ever offered staff roles.
    //
    // When the public server is not configured the staff one stands in for it, which is right for a
    // one-server community and a trap for a two-server one: a gate saved from THIS list would name a
    // staff role that nobody in the public server can hold, and the gated feature would then be
    // invisible to everyone with nothing to show for it. So the substitution is reported
    // (`fellBack`) rather than made quietly, and the caller says so where the picker is.
    const cfg = discordAuthConfig();
    const wantCommunity = new URL(req.url ?? "", "http://x").searchParams.get("guild") === "community";
    const community = await communityGuild(ctx.repo);
    const guildId = wantCommunity ? community.guildId : cfg.guildId;
    const fellBack = wantCommunity && community.fellBack;
    const botToken = process.env.DISCORD_TOKEN;
    if (!botToken || !guildId) return sendJson(res, 200, { roles: [], botConfigured: false, guildId: guildId || null, fellBack });
    try {
      const r = await fetch(`https://discord.com/api/v10/guilds/${guildId}/roles`, { headers: { authorization: `Bot ${botToken}` }, signal: AbortSignal.timeout(15_000) });
      // 403/404 here almost always means the bot is not IN that server — worth saying, because the
      // fix is an invite, not a setting.
      if (!r.ok) {
        const hint = r.status === 403 || r.status === 404 ? " — is the bot in that server?" : "";
        return sendJson(res, 200, { roles: [], botConfigured: true, guildId, fellBack, error: `Discord returned ${r.status}${hint}` });
      }
      const roles = (await r.json()) as { id: string; name: string; color?: number; managed?: boolean }[];
      /**
       * Everything except @everyone, with `managed` flagged rather than filtered.
       *
       * This used to drop every managed role, on the reasoning that a bot cannot hand them out.
       * True — and irrelevant to most of what these lists are for. The roles a community gates
       * its perks on are precisely the managed ones: Server Booster, and the Patreon / Twitch /
       * donor roles their integrations own. Filtering them left the claim and gifting pickers
       * unable to express "boosters only", which is the single most common rule there is.
       *
       * So the distinction moves to where it actually applies: GATING reads any role, while the
       * pickers that ASSIGN a role (the per-game registration roles) filter on `managed`, since
       * that is the only place a bot's inability to grant one matters.
       */
      const usable = roles
        .filter((role) => role.id !== guildId)
        .map((role) => ({ id: role.id, name: role.name, color: role.color ?? 0, managed: role.managed === true }));
      sendJson(res, 200, { roles: usable, botConfigured: true, guildId, fellBack });
    } catch (err) {
      sendJson(res, 200, { roles: [], botConfigured: true, guildId, fellBack, error: (err as Error).message });
    }
  }),

  // List current Discord→panel role mappings + whether OAuth is configured.
  route("GET", "/api/discord/role-map", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.users", "read")) return sendForbidden(res, "admin.users", "read");
    sendJson(res, 200, { mappings: await ctx.repo.discordRoleMap.list(), oauthConfigured: isDiscordAuthConfigured(discordAuthConfig()) });
  }),

  // Set the panel roles a given Discord role grants (empty list clears the mapping).
  route("PUT", "/api/discord/role-map/:discordRoleId", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.users", "write")) return sendForbidden(res, "admin.users", "write");
    const body = await readJsonBody(req);
    const discordRoleName = str(body.discordRoleName) || null;
    // Clearing the mapping is sending nothing, which the parser treats as a missing field — so
    // handle the empty case before asking it to read a set.
    const empty = !Array.isArray(body.roles) && !Array.isArray(body.roleIds);
    const parsed = empty ? { ok: true as const, assignments: [], roles: [] } : await parseRoleAssignments(ctx.repo, body);
    if (!parsed.ok) return sendError(res, parsed.status, parsed.message);
    const { assignments } = parsed;
    // A mapping confers its roles on whoever holds the Discord role — the same escalation as
    // assigning them. Judged on what this Discord role's mapping confers before and after: whoever
    // holds it gains at most what the new set adds over the old, since roles only ever add.
    const current = (await ctx.repo.discordRoleMap.list()).filter((m) => m.discordRoleId === params.discordRoleId);
    const before = assignmentGrants(current, await ctx.repo.roles.getMany([...new Set(current.map((m) => m.roleId))]));
    // A mapping that already hands out a power the actor lacks is not theirs to change either:
    // narrowing or clearing it takes that power from whoever holds the Discord role.
    if (outrightTargetRefusal(p.grants, before)) return sendError(res, 403, "this Discord role hands out permissions on every server that you do not — only someone who holds them too can change its mapping");
    const escalation = outrightGain(p.grants, before, assignmentGrants(assignments, parsed.roles));
    if (escalation) return sendError(res, 403, escalation);
    await ctx.repo.discordRoleMap.setForDiscordRole(params.discordRoleId!, discordRoleName, assignments);
    // Say WHERE in the trail — "→ 1 panel role" cannot distinguish community-wide access from
    // access on one server, and that is the whole difference this mapping now expresses.
    const servers = new Map((await ctx.repo.servers.list()).map((s) => [s.id, s.name]));
    const scopes = new Set(assignments.map((a) => (a.scopeId ? servers.get(a.scopeId) ?? a.scopeId : "everywhere")));
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "discord.rolemap.set",
      targetType: "role", targetId: params.discordRoleId!, targetName: discordRoleName ?? params.discordRoleId!,
      summary: `mapped Discord role ${discordRoleName ?? params.discordRoleId} → ${assignments.length} panel role${assignments.length === 1 ? "" : "s"}`
        + (assignments.length ? ` (${[...scopes].join(", ")})` : ""),
      data: { discordRoleId: params.discordRoleId, assignments },
    }).catch(() => {});
    sendJson(res, 200, { mappings: await ctx.repo.discordRoleMap.list() });
  }),

  route("DELETE", "/api/discord/role-map/:discordRoleId", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.users", "write")) return sendForbidden(res, "admin.users", "write");
    const current = (await ctx.repo.discordRoleMap.list()).filter((m) => m.discordRoleId === params.discordRoleId);
    const before = assignmentGrants(current, await ctx.repo.roles.getMany([...new Set(current.map((m) => m.roleId))]));
    if (outrightTargetRefusal(p.grants, before)) return sendError(res, 403, "this Discord role hands out permissions on every server that you do not — only someone who holds them too can change its mapping");
    const ok = await ctx.repo.discordRoleMap.remove(params.discordRoleId!);
    if (ok) await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "discord.rolemap.remove",
      targetType: "role", targetId: params.discordRoleId!, targetName: params.discordRoleId!,
      summary: `cleared Discord role mapping ${params.discordRoleId}`,
    }).catch(() => {});
    sendJson(res, 200, { ok });
  }),

  // --- The slash command: its name is configuration ---
  // The bot has exactly one command and everything else is a button inside the panel it opens.
  // What that command is CALLED is a per-community decision (a guild that already has a `/staff`
  // bot needs ours to be something else), and switching it off must not need a code edit. Same
  // discord.setup gate as the rest of the app-level Discord wiring below (it was admin.users until
  // the bot's setup became a permission of its own).
  route("GET", "/api/discord/commands", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "discord.setup", "read")) return sendForbidden(res, "discord.setup", "read");
    sendJson(res, 200, {
      config: await ctx.repo.discordCommands.get(),
      // What Register would do right now, so the panel can explain the button instead of just
      // failing on press — and what the gate behind it can actually check.
      canRegister: Boolean(process.env.DISCORD_TOKEN && process.env.DISCORD_APP_ID),
      guildId: staffGuildId() || null,
      // The gate reads these two: without a bot token or a staff guild it cannot ask Discord who
      // is staff, and with an empty role map nobody is. The panel says so rather than letting an
      // operator believe the command is gated when it is not.
      canCheckRoles: Boolean(process.env.DISCORD_TOKEN && staffGuildId()),
      mappedRoles: (await ctx.repo.discordRoleMap.list()).length,
    });
  }),

  route("PUT", "/api/discord/commands", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "discord.setup", "write")) return sendForbidden(res, "discord.setup", "write");
    const stored = await ctx.repo.discordCommands.get();
    const parsed = parseDiscordCommands(await readJsonBody(req), stored);
    if ("error" in parsed) return sendError(res, 400, parsed.error);
    const before = priorOf(stored, parsed.value);
    const config = await ctx.repo.discordCommands.set(parsed.value);
    // Saving does NOT install anything — Discord only learns the new name on the next Register —
    // so the trail says what changed and the panel says the rest.
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "discord.commands.config",
      targetType: "system", targetId: "discord-commands",
      summary: config.enabled ? `set the Discord slash command to /${config.name}` : "switched the Discord slash command off",
      data: { patch: parsed.value, before },
    }).catch(() => {});
    sendJson(res, 200, { config });
  }),

  // The staff command, drawn for Help's Discord walkthrough: the panel it opens in Discord as this
  // person would see it, every part their permissions open drawn by the part itself
  // (discord-preview.ts). Open to everyone signed in, since each sees only their own parts; and
  // read-only — no part is pressed, nothing is recorded or posted, and Discord is never asked.
  route("GET", "/api/discord/staff-panel", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const cfg = await ctx.repo.discordCommands.get();
    sendJson(res, 200, {
      command: { name: cfg.name, enabled: cfg.enabled },
      // Without a linked account the command answers only that it needs one.
      linked: Boolean(p.user.discordId),
      ...(await previewStaffPanel(ctx.pluginRuntime.discordModules, p)),
    });
  }),

  // One server's screen in a part that starts by picking one (Maps & vote, Moderation), drawn the
  // same way: what picking it in Discord shows, with nothing changed and no cart started.
  route("GET", "/api/discord/staff-panel/:part/:server", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const message = await previewServerScreen(ctx.pluginRuntime.discordModules, p, params.part ?? "", params.server ?? "");
    if (!message) return sendError(res, 404, "no part of yours picks a server like that");
    sendJson(res, 200, { message });
  }),

  // Install the configured commands with Discord. This is the button that replaces the deploy-time
  // CLI: a PUT is a REPLACE, so it also removes a command that was renamed or switched off.
  route("POST", "/api/discord/commands/register", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "discord.setup", "write")) return sendForbidden(res, "discord.setup", "write");
    const token = process.env.DISCORD_TOKEN;
    const appId = process.env.DISCORD_APP_ID;
    if (!token) return sendError(res, 409, "no Discord bot token is set — add it under Discord → Setup & status");
    if (!appId) return sendError(res, 409, "no Discord application id is set — add it under Discord → Setup & status");
    // Global: every guild the bot is in, now and later. These two ids are only a floor for the
    // guild-scoped sweep — registerCommands asks Discord for the real list, because a guild we
    // have no id for is exactly where an old guild-scoped command survives unnoticed.
    const { communityGuildId } = await ctx.repo.appConfig.get();
    const stale = [...new Set([staffGuildId(), communityGuildId].filter(Boolean))];
    const config = await ctx.repo.discordCommands.get();
    let outcome;
    try {
      outcome = await registerCommands(token, appId, config, stale);
    } catch (err) {
      // Discord's own complaint is the useful part (a bad name, a stale token) — pass it through.
      return sendError(res, 502, (err as Error).message);
    }
    const { names: registered, clearedGuilds } = outcome;
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "discord.commands.register",
      targetType: "system", targetId: "discord-commands",
      summary: (registered.length
        ? `registered ${registered.map((n) => "/" + n).join(", ")} with Discord for every server the bot is in`
        : "cleared every slash command from Discord")
        + ` (cleared older per-server copies in ${clearedGuilds.length} server${clearedGuilds.length === 1 ? "" : "s"})`,
      data: { registered, clearedGuildScopes: clearedGuilds },
    }).catch(() => {});
    sendJson(res, 200, { registered, scope: "global", clearedGuilds: clearedGuilds.length });
  }),

  // Health of the whole Discord integration — which pieces are set and which features that
  // unlocks. Booleans + non-secret values only (never the token/secret). Drives the hub's Setup tab
  // so an operator can see, at a glance, that Discord is OFF until configured. discord.setup gated.
  route("GET", "/api/discord/setup", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "discord.setup", "read")) return sendForbidden(res, "discord.setup", "read");
    sendJson(res, 200, await discordSetupReadout(ctx));
  }),

  /**
   * The Discord app's settings, set here instead of in infra/.env and kept with the install's own
   * (install-env.ts). Only the fields sent change, and an empty one clears; every field is checked
   * before any is stored. In force in the API at once, and in the worker and the bot within their
   * next refresh. Never filed for approval: the request would carry the token.
   */
  route("PUT", "/api/discord/setup", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "discord.setup", "write")) return sendForbidden(res, "discord.setup", "write");
    const body = await readJsonBody(req);
    const changes: { env: string; label: string; value: string }[] = [];
    for (const f of DISCORD_SETUP_FIELDS) {
      if (!(f.field in body)) continue;
      const given = str(body[f.field]).trim();
      const value = given ? f.tidy(given) : "";
      if (typeof value !== "string") return sendError(res, 400, value.error);
      changes.push({ env: f.env, label: f.label, value });
    }
    if (!changes.length) return sendError(res, 400, "nothing to change");
    for (const c of changes) {
      const s = installEnvSetting(c.env)!;
      await ctx.repo.installSettings.set(s.key, c.value, { secret: s.secret, by: p.name });
    }
    await refreshInstallEnv(ctx.repo, ctx.config);
    const set = changes.filter((c) => c.value).map((c) => c.label);
    const cleared = changes.filter((c) => !c.value).map((c) => c.label);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "discord.setup",
      targetType: "system", targetId: "discord-setup",
      // What changed, never the values: two of them are secrets, and the trail is read by staff.
      summary: [set.length ? `set the Discord ${set.join(", ")}` : "", cleared.length ? `removed the Discord ${cleared.join(", ")}` : ""].filter(Boolean).join("; "),
      data: { set, cleared },
    }).catch(() => {});
    sendJson(res, 200, await discordSetupReadout(ctx));
  }),
];
