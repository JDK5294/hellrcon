/**
 * The two fates a server-scoped WRITE can have besides happening: captured into the request the
 * caller is building, or filed for somebody who holds the permission.
 *
 * It lives here rather than in `routes/kit.ts` to keep the imports one-way, and it reaches only
 * LEAVES (`requests.ts` for filing, `approval-cards.ts` for the Discord card) for the same reason:
 * the wrapper that gates those routes imports this, so anything this imports must not lead back to
 * the routing layer. Reaching for `approvals.ts` here — the executor — is what put `kit → ask →
 * approvals → kit` into an API whose approvals code had no cycles at all; the split that undid it
 * is what those two leaves are for. A test holds the line.
 *
 * WHAT IS DIFFERENT ABOUT THESE. A player action files a line the route has already validated
 * field by field, so an approver never debugs somebody's typo. A server-scoped write is filed as
 * the CALL it was — method, path, query, body — and validated when it is replayed at approval,
 * because the wrapper runs before the handler that knows what a valid body is. The trade buys the
 * whole surface at once (every map, vote, seeding, console and configuration route, and any route
 * added later, without a second list to keep in step), and it is not silent: a replay that the
 * handler refuses lands as `applyError` on the line, in the approver's face, exactly like a game
 * that could not be reached.
 */
import type { IncomingMessage } from "node:http";
import type { AppContext } from "./context.js";
import type { Principal } from "./auth.js";
import type { AskableWrite } from "./request-scope.js";
import { captureLine, fileRequest } from "./requests.js";
import { postApprovalCard } from "./approval-cards.js";
import { readJsonBody } from "./http.js";
import { describeSubject } from "./ask-subject.js";
import { can } from "@app/access";

/**
 * How each replayable write reads in the queue and on the Discord card.
 *
 * A request says what it will do in the reader's language or it cannot be judged: "POST
 * /api/servers/…/mapvote/skip" is a line nobody should be asked to sign. Keyed by `METHOD /path`,
 * and a test holds it to exactly the set of write routes that exist, in both directions — a route
 * added without a label would file requests that read as a URL, and a label left behind after its
 * route is gone is a promise about something that cannot happen.
 */
export const ROUTE_ASK_LABELS: Record<string, string> = {
  // Maps and the rotation
  "POST /api/servers/:id/maps/next": "Set the next map",
  "POST /api/servers/:id/maps/change": "Change the map now",
  "POST /api/servers/:id/maps/objectives": "Set the objectives",
  "POST /api/servers/:id/maprotation/add": "Add to the map rotation",
  "POST /api/servers/:id/maprotation/remove": "Remove from the map rotation",
  "POST /api/servers/:id/maprotation/move": "Reorder the map rotation",
  "POST /api/servers/:id/maprotation/apply-set": "Replace the map rotation with a saved set",
  "PUT /api/servers/:id/maps/:mapId/name": "Rename a map",
  "PUT /api/servers/:id/maps/objective-points": "Teach an objective its place and name",
  "POST /api/servers/:id/maps/objectives/clear": "Clear a map's saved objective layout",
  "PUT /api/servers/:id/maps/:mapId/family": "Re-file a map's family",
  // The vote
  "PUT /api/servers/:id/mapvote/config": "Change the map-vote settings",
  "POST /api/servers/:id/mapvote/pause": "Pause or resume the map vote",
  "POST /api/servers/:id/mapvote/override": "Override the map vote",
  "POST /api/servers/:id/mapvote/skip": "Skip the map vote",
  "POST /api/servers/:id/mapvote/reroll": "Re-roll the map-vote options",
  "POST /api/servers/:id/mapvote/start": "Start a map vote",
  "POST /api/servers/:id/mapvote/resync": "Re-sync the map vote",
  "POST /api/servers/:id/mapvote/announce": "Announce the map vote",
  // Talking to the whole server
  "POST /api/servers/:id/broadcast/send": "Broadcast to the server",
  "POST /api/servers/:id/message/send": "Message everyone on the server",
  "PUT /api/servers/:id/broadcast": "Change the rotating broadcast",
  "PUT /api/servers/:id/welcome": "Change the live welcome message",
  "PUT /api/servers/:id/game-rewards": "Change the game rewards",
  // Automation and configuration
  "PUT /api/servers/:id/seeding": "Change the seeding rules",
  "PUT /api/servers/:id/autosettings": "Change the auto settings",
  "POST /api/servers/:id/autosettings/apply-template": "Apply an auto-settings template",
  "PUT /api/servers/:id/admincam/config": "Change the admin-camera alerts",
  "PUT /api/servers/:id/discord": "Change the Discord relay",
  "POST /api/servers/:id/discord/test": "Send a Discord relay test",
  // The server itself
  "POST /api/servers/:id/config": "Change the server settings",
  "POST /api/servers/:id/raw": "Run a raw console command",
  "POST /api/servers/:id/nickname": "Rename a server's panel nickname",
  "POST /api/servers/:id/bans/lift-all": "Lift every ban on a server",
  // Presets, one route per presettable feature (see FEATURE_PRESETS)
  "POST /api/servers/:id/presets/broadcast/apply": "Apply a broadcast preset",
  "POST /api/servers/:id/presets/mapvote/apply": "Apply a map-vote preset",
  "POST /api/servers/:id/presets/seeding/apply": "Apply a seeding preset",
  "POST /api/servers/:id/seeding/pay-last": "Pay the last seed cycle's missed reward",
  "POST /api/servers/:id/presets/rules/apply": "Apply a rules preset",

  /*
   * EVERY OTHER WRITE a role can be granted. These are not behind the server wrapper — they are
   * about the community (groups, rules, roles, the shop) or need their key decided from the body —
   * so they ask from inside: the handler's own refusal files the call (see request-scope.ts).
   */
  // Players and groups
  "POST /api/player-groups": "Create a player group",
  "PUT /api/player-groups/:id": "Rename or describe a player group",
  "DELETE /api/player-groups/:id": "Delete a player group",
  "POST /api/player-groups/:id/members": "Add a player to a group",
  "DELETE /api/player-groups/:id/members/:playerId": "Remove a player from a group",
  "PUT /api/player-groups/:id/perk": "Set up a group's VIP perk",
  "DELETE /api/player-groups/:id/perk": "Switch off a group's VIP perk",
  "PUT /api/player-groups/:id/discord-role": "Tie a group to a Discord role",
  "POST /api/player-groups/:id/apply": "Run an action on a whole group",
  "POST /api/players/:id/tags": "Tag a player",
  "DELETE /api/players/:id/tags/:tagId": "Remove a player's tag",
  "PATCH /api/players/:id/links": "Change a player's linked accounts",
  "POST /api/players/:id/notes": "Add a note to a player's profile",
  "PATCH /api/players/:id/watch/reasons/:reasonId": "Edit a watch reason",
  "DELETE /api/players/:id/watch/reasons/:reasonId": "Close a watch reason",
  "POST /api/players/:id/triggers": "Set a player trigger",
  "PATCH /api/players/:id/triggers/:triggerId": "Switch a player trigger on or off",
  "PUT /api/players/:id/triggers/:triggerId": "Edit a player trigger",
  "DELETE /api/players/:id/triggers/:triggerId": "Delete a player trigger",
  "POST /api/players/:id/vip/pause": "Give a player a VIP timeout",
  "POST /api/players/:id/vip/resume": "End a VIP timeout early",
  "POST /api/vips/integrity/ignore": "Dismiss a VIP integrity finding",
  "POST /api/clans/combine": "Combine clan tags",
  "POST /api/clans/split": "Split a spelling out of a clan",
  "POST /api/clans/reset": "Undo a clan's combining",
  "POST /api/clans/rename": "Rename a clan",
  // One server's players, VIP and bans
  "POST /api/servers/:id/actions/bulk": "Run an action on several players",
  "POST /api/servers/:id/admins": "Add a console admin",
  "DELETE /api/servers/:id/admins/:playerId": "Remove a console admin",
  "POST /api/servers/:id/vips/bulk": "Grant VIP to several players",
  "POST /api/servers/:id/vips/reduce": "Remove VIP time",
  "POST /api/servers/:id/vips/reconcile": "Sync the game's VIP list",
  "POST /api/servers/:id/bans/reconcile": "Sync the game's ban list",
  "POST /api/bans/seed": "Fill the ban records from the game's ban lists",
  // The server itself
  "POST /api/servers/:id/retire": "Retire a server",
  "POST /api/servers/:id/unretire": "Bring a retired server back",
  "POST /api/servers/:id/refresh-name": "Refresh a server's name from the game",
  "POST /api/servers/:id/game": "Change which game a server runs",
  "PUT /api/servers/:id/automation": "Switch a server's automations on or off",
  "POST /api/servers/:id/engagement": "Switch a server between observe and active",
  "POST /api/servers/:id/streamer-mode": "Change a server's streamer mode",
  "POST /api/servers/:id/public-profile": "Change a server's public stats page",
  // Rules, zones and the chat filter
  "POST /api/enforcer/rules": "Create a rule",
  "PATCH /api/enforcer/rules/:id": "Edit a rule",
  "DELETE /api/enforcer/rules/:id": "Delete a rule",
  "POST /api/enforcer/versions/:id/restore": "Restore an earlier version of a rule",
  "POST /api/enforcer/rules/:id/pause": "Pause a rule",
  "DELETE /api/enforcer/rules/:id/pause": "Resume a paused rule",
  "POST /api/enforcer/sections": "Create a rules section",
  "PATCH /api/enforcer/sections/:id": "Edit a rules section",
  "DELETE /api/enforcer/sections/:id": "Delete a rules section",
  "POST /api/enforcer/sections/assign": "Move rules between sections",
  "PUT /api/chat-filter": "Change the chat filter",
  "POST /api/zones": "Create a map zone set",
  "PUT /api/zones/:id": "Edit a map zone set",
  "DELETE /api/zones/:id": "Delete a map zone set",
  // Map sets and their schedules
  "POST /api/mapvote/sets": "Create a map set",
  "PUT /api/mapvote/sets/:id": "Edit a map set",
  "DELETE /api/mapvote/sets/:id": "Delete a map set",
  "POST /api/mapvote/schedules": "Create a map-set schedule",
  "PUT /api/mapvote/schedules/:id": "Edit a map-set schedule",
  "DELETE /api/mapvote/schedules/:id": "Delete a map-set schedule",
  "POST /api/mapvote/versions/:id/restore": "Restore an earlier version of a map set or schedule",
  // Presets and templates
  "POST /api/presets/broadcast": "Save a broadcast preset",
  "DELETE /api/presets/broadcast/:presetId": "Delete a broadcast preset",
  "POST /api/presets/mapvote": "Save a map-vote preset",
  "DELETE /api/presets/mapvote/:presetId": "Delete a map-vote preset",
  "POST /api/presets/seeding": "Save a seeding preset",
  "DELETE /api/presets/seeding/:presetId": "Delete a seeding preset",
  "POST /api/presets/rules": "Save a rules preset",
  "DELETE /api/presets/rules/:presetId": "Delete a rules preset",
  "POST /api/autosettings/templates": "Save an auto-settings template",
  "DELETE /api/autosettings/templates/:templateId": "Delete an auto-settings template",
  "PUT /api/signatures": "Change the message signatures",
  "POST /api/templates": "Add a message template",
  "PATCH /api/templates/:id": "Edit a message template",
  "DELETE /api/templates/:id": "Delete a message template",
  "POST /api/vip-presets": "Add a VIP preset",
  "PATCH /api/vip-presets/:id": "Edit a VIP preset",
  "DELETE /api/vip-presets/:id": "Delete a VIP preset",
  // Points, the shop, payouts and events
  "PUT /api/economy/config": "Change the points and shop settings",
  "POST /api/economy/trim-balances": "Bring point balances down to the cap",
  "POST /api/economy/resync-game-roles": "Re-check members' game roles in Discord",
  "POST /api/economy/members/:discordId/adjust": "Adjust a member's points",
  "POST /api/economy/groups/:groupId/adjust": "Adjust a group's points",
  "POST /api/economy/members/:discordId/purchase": "Make a shop purchase for a member",
  "POST /api/economy/members/:discordId/gift": "Gift points to a member",
  "POST /api/payouts": "Run a payout",
  "POST /api/payout-events": "Create an event",
  "PATCH /api/payout-events/:id": "Edit an event",
  "POST /api/payout-events/post": "Post the events list to Discord",
  "PUT /api/payout-events/post-config": "Change where the events list is posted",
  "POST /api/payout-events/:id/cancel": "Cancel an event",
  "POST /api/payout-events/:id/no-payout": "Mark an event as needing no payout",
  // Discord
  "POST /api/discord/vip-launcher": "Post the Discord VIP panel launcher",
  "PUT /api/discord/role-map/:discordRoleId": "Tie a Discord role to a panel role",
  "DELETE /api/discord/role-map/:discordRoleId": "Untie a Discord role from a panel role",
  "DELETE /api/discord/board-badge": "Remove the match board badge",
  "PUT /api/discord/commands": "Change the Discord commands",
  "PUT /api/online/stats-site": "Change the public stats site's address or name",
  "PUT /api/online/domain": "Change the panel's own domain",
  "PUT /api/online/demo": "Turn the public demo on or off",
  "POST /api/discord/commands/register": "Register the Discord commands",
  // Staff notices
  "POST /api/community/announcements": "Post a notice to staff",
  "PATCH /api/community/announcements/:id": "Edit a staff notice",
  "DELETE /api/community/announcements/:id": "Delete a staff notice",
  "PUT /api/community/announcements/nudge-config": "Change the reminders for unread notices",
  // Staff accounts and roles
  "PUT /api/app-config": "Change the app-wide settings",
  "POST /api/users/:id/grants": "Give a staff account a permission",
  "DELETE /api/users/:id/grants/:grantId": "Take a permission from a staff account",
  "PUT /api/users/:id/grants": "Set a staff account's permissions",
  "PUT /api/users/:id/roles": "Set a staff account's roles",
  "PUT /api/users/:id/discord-managed": "Change whether Discord manages a staff account's roles",
  "POST /api/users/:id/revoke-sessions": "Sign a staff account out everywhere",
  "POST /api/users/:id/merge": "Merge two staff accounts",
  "DELETE /api/users/:id": "Delete a staff account",
  "POST /api/roles": "Create a role",
  "PUT /api/roles/:id": "Edit a role",
  "DELETE /api/roles/:id": "Delete a role",
  "PUT /api/layout/:surface": "Change a screen's layout for everyone",
  // Stored data
  "POST /api/trim": "Trim stored data",
  "POST /api/players/last-seen-drift/repair": "Repair players' last-seen times",
  "POST /api/data/export": "Export data",
  "POST /api/data/backup": "Make a backup",
  "DELETE /api/data/backups/:name": "Delete a backup",
};

/**
 * The writes that are never asked for, and why. Each is a decision, held to the route list by a
 * test: a write is either labelled above or named here, so a new one cannot slip out of the
 * approvals surface without somebody writing down the reason.
 */
export const NOT_ASKABLE: Record<string, string> = {
  // Your own account and screens: there is no permission to lack.
  "POST /api/auth/login": "signing in",
  "PUT /api/me/prefs": "your own preferences",
  "PUT /api/me/push": "your own phone notifications",
  "POST /api/me/push/off": "your own phone notifications",
  "POST /api/me/push/test": "your own phone notifications",
  "PUT /api/me/password": "your own password",
  "POST /api/me/announcements-seen": "your own read marks",
  "DELETE /api/tokens/:id": "your own API tokens",
  "POST /api/community/announcements/read": "your own read marks",
  "POST /api/community/announcements/:id/ack": "your own read marks",
  "DELETE /api/layout/:surface": "resetting your own layout",
  // The request system itself.
  "POST /api/requests/:id/lines/:lineId/approve": "deciding a request",
  "POST /api/requests/:id/lines/:lineId/deny": "deciding a request",
  "POST /api/requests/:id/approve-all": "deciding a request",
  "POST /api/requests/:id/withdraw": "withdrawing your own request",
  "POST /api/requests/draft": "building a request",
  "POST /api/requests/draft/park": "building a request",
  "DELETE /api/requests/draft": "building a request",
  "DELETE /api/requests/draft/lines/:lineId": "building a request",
  "POST /api/requests/draft/submit": "submitting a request",
  // A password rides in the body. A request keeps its call to replay it, so the password would sit
  // in the queue in plain text, where approvers and the Discord card can read it.
  "POST /api/auth/register": "carries a password",
  "POST /api/setup/test-server": "carries the RCON password",
  "POST /api/users": "carries a password",
  "PATCH /api/users/:id": "carries a password",
  "POST /api/servers": "carries the RCON password",
  "PUT /api/servers/:id/connection": "carries the RCON password",
  // A new API token's secret is in the answer, shown once to whoever made it. Carried out later
  // for somebody else's signature, it would be shown to nobody.
  "POST /api/tokens": "the new token is shown only to whoever makes it",
  // A file rides in the body, or the write works on one just uploaded. A request stores the call,
  // and the file cannot wait in it for a signature.
  "POST /api/data/upload": "a file upload",
  "POST /api/data/import": "imports the file just uploaded",
  "POST /api/economy/import-botdb": "a file upload",
  "PUT /api/discord/board-badge": "a file upload",
  // Only the owner, or only the account that set the panel up. No role can be granted these, so
  // there is nobody a request could reach.
  "POST /api/data/restore": "owner only",
  "POST /api/servers/:id/decommission": "the setup account only",
  "POST /api/servers/:id/recommission": "the setup account only",
  "DELETE /api/servers/:id": "the setup account only",
  // First-run setup: before any account exists, or the owner's own walk-through.
  "POST /api/setup/verify": "first-run setup, before any account exists",
  "POST /api/setup/finish": "the owner's own setup walk-through",
  "PUT /api/discord/setup": "carries the Discord bot token and the OAuth client secret",
  "PUT /api/online/tunnel": "carries the Cloudflare tunnel's token",
  // Changes nothing.
  "POST /api/servers/:id/maps/poll/preview": "a preview",
  "POST /api/trim/preview": "a preview",
  "POST /api/payouts/preview": "a preview",
  "POST /api/data/counts": "a preview",
  // Called by machines, not people.
  "POST /api/discord/interactions": "Discord's own callback",
  "POST /api/servers/:id/ingest": "an agent's log feed",
  // Asked for already, as validated player lines rather than replayed calls.
  "POST /api/servers/:id/actions": "files its own player lines",
  "PATCH /api/players/:id/flags": "files its own player lines",
  "POST /api/players/:id/watch/reasons": "files its own player lines",
  "POST /api/servers/:id/vips": "files its own player lines",
  "DELETE /api/servers/:id/vips/:playerId": "files its own player lines",
  // The CRCON import stays exactly as installed.
  "POST /api/servers/:id/import/crcon/job": "the CRCON import",
  "POST /api/servers/:id/import/crcon/job/pause": "the CRCON import",
  "POST /api/servers/:id/import/crcon/job/retry": "the CRCON import",
  "POST /api/servers/:id/import/crcon/upload": "the CRCON import",
  "POST /api/servers/:id/import/crcon/transform": "the CRCON import",
  "DELETE /api/servers/:id/import/crcon/archive": "the CRCON import",
  "POST /api/servers/:id/import/crcon/vip-drift/restore": "the CRCON import",
  "POST /api/servers/:id/purge": "the CRCON import",
  "POST /api/servers/:id/import/crcon/reset": "the CRCON import",
  // A plugin's own routes: what its viewer may do there is the plugin's call, made in its handler.
  "POST /api/plugins/:id/*rest": "a plugin's own routes, outside the request system",
  "PUT /api/plugins/:id/*rest": "a plugin's own routes, outside the request system",
  "DELETE /api/plugins/:id/*rest": "a plugin's own routes, outside the request system",
};

/** The stored shape of a filed call. Kept flat and boring: it is replayed, not interpreted. */
export interface AskedRoute {
  method: string;
  /** The route PATTERN (`/api/servers/:id/...`), which is the replay registry's key. */
  route: string;
  /** The concrete url, query and all — some handlers read their options from it. */
  url: string;
  params: Record<string, string>;
  body: unknown;
  label: string;
  /** Who or what the call is about, named when it was filed (ask-subject.ts) — the account, the
   *  group, the rule — so an approver never signs an id. Absent on lines filed before it existed. */
  subject?: string[];
}

/**
 * Decide the fate of one server-scoped write, and carry it out if it is not "just do it".
 *
 * Returns the 202 body when the call was captured or filed, and null when the caller should go
 * ahead and run it. An open, unparked draft wins over holding the permission, because that is what
 * the builder promises on every screen while it is up: nothing executes until submit.
 */
export async function askOrCapture(
  ctx: AppContext, p: Principal,
  what: { method: string; path: string; capability: string; req: IncomingMessage; params: Record<string, string>; serverId: string },
): Promise<Record<string, unknown> | null> {
  const draft = await ctx.repo.approvals.findDraft(p.user.id);
  const building = Boolean(draft && !draft.parkedAt);
  const allowed = can(p.grants, what.capability, "write", { serverId: what.serverId });
  if (!building && allowed) return null;

  const label = ROUTE_ASK_LABELS[`${what.method} ${what.path}`] ?? what.path;
  const body = await readJsonBody(what.req).catch(() => ({}));
  const asked: AskedRoute = {
    method: what.method,
    route: what.path,
    url: what.req.url ?? what.path,
    params: what.params,
    body,
    label,
    subject: await describeSubject(ctx, what.method, what.path, what.params, body),
  };
  const line = { serverId: what.serverId, capability: what.capability, kind: "route", payload: { ...asked }, playerId: null, playerName: null };
  if (building) return { ...(await captureLine(ctx, p, line)), label };
  const filed = await fileRequest(ctx, p, [line]);
  void postApprovalCard(ctx, filed.id);
  return { requested: true, requestId: filed.id, label };
}

/**
 * A write refused from INSIDE its handler, filed instead — the path every write outside the server
 * wrapper takes, and the second key of one inside it (a seeding change that pays VIP needs the VIP
 * key too). The handler has already checked whatever it checks before its permissions, so the call
 * filed is the call that was refused, with the permission it was refused and the scope it was
 * checked at; replayed on a signature, it runs the same handler again with the signer's grants.
 *
 * Returns the 202 body: captured into the request being built, or filed for a signature.
 */
export async function fileRefusedWrite(
  scope: { ask: AskableWrite; principal: Principal; building?: boolean },
  capability: string, serverId: string | null,
): Promise<Record<string, unknown>> {
  const { ask, principal: p } = scope;
  const label = ROUTE_ASK_LABELS[`${ask.method} ${ask.path}`] ?? ask.path;
  // Usually read already — a handler validates before it checks a second key — and kept by
  // readJsonBody for exactly this.
  const body = await readJsonBody(ask.req).catch(() => ({}));
  const asked: AskedRoute = {
    method: ask.method,
    route: ask.path,
    url: ask.req.url ?? ask.path,
    params: ask.params,
    body,
    label,
    subject: await describeSubject(ask.ctx, ask.method, ask.path, ask.params, body),
  };
  const line = { serverId, capability, kind: "route", payload: { ...asked }, playerId: null, playerName: null };
  if (scope.building) return { ...(await captureLine(ask.ctx, p, line)), label };
  const filed = await fileRequest(ask.ctx, p, [line]);
  void postApprovalCard(ask.ctx, filed.id);
  return { requested: true, requestId: filed.id, label };
}
