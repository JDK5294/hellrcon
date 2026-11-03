/**
 * Interactive Discord — the inbound half of the bot (the relay app is the outbound half). Uses
 * Discord's HTTP-interactions transport: Discord POSTs signed interactions to our endpoint, we verify
 * the Ed25519 signature and respond in-band. No gateway, no discord.js — Node verifies Ed25519
 * natively, and this reuses the API's existing public HTTP server + DB access.
 *
 * This is the foundation the richer surfaces build on (embed vote buttons, self-service identity
 * linking, staff commands): each new capability is a command/component handler registered below.
 */
import { createPublicKey, verify as edVerify } from "node:crypto";
import type { DiscordCommandConfig, Repository } from "@app/db";
import { canAnywhere, mappedRoleAssignments } from "@app/access";
import { createLogger } from "@app/shared";
import { resolveAccess } from "./auth.js";
import { guildMember } from "./discord-guild.js";
import { CUSTOM_ID_PREFIX, HOME_ID, PUBLIC_PREFIX, decodeCustomId, isModalResult, modalJson, modalValues, renderLauncher, renderModuleView, renderPublicView, type DiscordModuleRegistry } from "./discord-modules.js";
import { type PublicModuleRegistry } from "./discord-public.js";

// Interaction type + response type constants (Discord API).
export const INTERACTION_PING = 1;
export const INTERACTION_COMMAND = 2;
export const INTERACTION_COMPONENT = 3;
export const INTERACTION_MODAL_SUBMIT = 5;
const RESP_PONG = 1;
const RESP_MESSAGE = 4;
const RESP_DEFERRED_MESSAGE = 5;
const RESP_DEFERRED_UPDATE = 6;
const RESP_UPDATE = 7;
const RESP_MODAL = 9;
const EPHEMERAL = 64;

const log = createLogger("discord");

// Raw 32-byte Ed25519 public keys need an SPKI DER wrapper for Node's crypto; this is the fixed
// prefix for an Ed25519 SubjectPublicKeyInfo.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * How far the interaction's timestamp may be from our clock. Discord signs `timestamp + body`, so
 * the timestamp is authenticated — but a signature stays valid forever unless someone checks that
 * the timestamp is recent. Without this window, one captured request (a proxy log, a mirrored
 * request, anything that ever saw the bytes) can be replayed against this endpoint indefinitely.
 *
 * Harmless for a read-only listing, and not harmless at all for a component interaction — a
 * replayed button press is a request we will act on, and the panel's buttons spend money.
 *
 * Five minutes is Discord's own guidance and is generous for clock skew in both directions.
 */
const SIGNATURE_WINDOW_SECONDS = 300;

/** Signature timestamps are unix seconds as a string. Anything else is not from Discord. */
function timestampIsFresh(timestamp: string, nowMs: number, windowSeconds: number): boolean {
  // Deliberately strict: Number("") is 0 and Number(" 12 ") is 12, and neither should pass.
  if (!/^\d{1,15}$/.test(timestamp)) return false;
  const skewSeconds = Math.abs(nowMs / 1000 - Number(timestamp));
  return skewSeconds <= windowSeconds;
}

/**
 * Verify a Discord interaction signature (Ed25519 over timestamp + raw body) and reject stale
 * timestamps. Never throws.
 *
 * `now` and `windowSeconds` exist so the freshness rule can be tested without moving the clock.
 */
export function verifyInteraction(
  publicKeyHex: string,
  signatureHex: string,
  timestamp: string,
  rawBody: string,
  opts: { now?: number; windowSeconds?: number } = {},
): boolean {
  try {
    if (!publicKeyHex || !signatureHex || !timestamp) return false;
    if (!timestampIsFresh(timestamp, opts.now ?? Date.now(), opts.windowSeconds ?? SIGNATURE_WINDOW_SECONDS)) return false;
    const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]);
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return edVerify(null, Buffer.from(timestamp + rawBody), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

/**
 * The command schemas to register with Discord: one command, or none when it is switched off.
 *
 * There is deliberately no command TABLE here. Every capability the bot has is a button inside
 * the panel (docs/discord-modules.md), gated per press by the invoker's own grants — a second
 * slash command would be a second thing to find, permission and register for no gain. The last
 * one that existed, a read-only `/status`, was a worse copy of the panel's Servers module.
 */
export function commandSchemas(cfg: DiscordCommandConfig): { name: string; description: string }[] {
  return cfg.enabled ? [{ name: cfg.name, description: cfg.description }] : [];
}

export interface InteractionResult {
  status: number;
  body: unknown;
  /** Set when a deferred module is doing its work: resolves when the follow-up PATCH lands.
   *  The route lets it run detached; tests await it. */
  followUp?: Promise<void>;
}

// --- the /staff module panel (docs/discord-modules.md) ---

/**
 * The guild roles the presser holds, straight off the interaction Discord signed.
 *
 * Taking them from the payload rather than fetching the member means the check costs nothing and
 * cannot be stale: Discord resolves the roles at press time. A DM has no member object and so no
 * roles — an empty list, which any role-gated feature must treat as "not allowed" rather than
 * "unrestricted".
 */
function interactionRoles(interaction: Record<string, unknown>): string[] {
  const roles = (interaction.member as { roles?: unknown } | undefined)?.roles;
  return Array.isArray(roles) ? roles.map(String) : [];
}

/**
 * The display names Discord ships alongside a user-select's chosen ids.
 *
 * A picker hands back ids and nothing else, so a module that acts on somebody it did not press as
 * knows only a number — which is how staff-registered members ended up in the economy roster as
 * "(unknown)", unfindable by name, permanently. Discord resolves the users it offered in the same
 * payload; taking the names from there costs nothing and needs no bot call.
 */
function interactionSelectedNames(interaction: Record<string, unknown>): Record<string, string> {
  const users = (interaction.data as { resolved?: { users?: Record<string, unknown> } } | undefined)?.resolved?.users;
  if (!users || typeof users !== "object") return {};
  const out: Record<string, string> = {};
  for (const [id, raw] of Object.entries(users)) {
    const u = raw as { username?: unknown; global_name?: unknown };
    const name = String(u?.global_name || u?.username || "").trim();
    if (name) out[id] = name;
  }
  return out;
}

/** The Discord user behind an interaction (guild presses carry `member.user`, DMs carry `user`). */
function interactionUser(interaction: Record<string, unknown>): { id: string; name: string } | null {
  const member = interaction.member as { user?: { id?: string; username?: string; global_name?: string } } | undefined;
  const direct = interaction.user as { id?: string; username?: string; global_name?: string } | undefined;
  const u = member?.user ?? direct;
  return u?.id ? { id: u.id, name: u.global_name || u.username || u.id } : null;
}

/**
 * The modules this Discord user may open — the launcher's contents AND the per-press gate.
 * Resolved fresh every time from their linked staff account's effective grants; a button
 * rendered yesterday proves nothing about today.
 */
async function permittedModules(repo: Repository, registry: DiscordModuleRegistry, discordUserId: string) {
  const account = await repo.users.findByDiscordId(discordUserId);
  if (!account) return { account: null, modules: [] as ReturnType<DiscordModuleRegistry["list"]> };
  const { grants } = await resolveAccess(repo, account.id);
  return { account, modules: registry.list().filter((m) => canAnywhere(grants, m.capability, m.capabilityLevel ?? "read")) };
}

const NO_ACCOUNT_MSG = "No staff account is linked to your Discord. Sign in to the panel with Discord first.";
const NOT_STAFF_MSG = "The staff panel is for staff. Your roles in the staff Discord don't grant access here.";
const CHECK_FAILED_MSG = "Couldn't check your staff roles with Discord just now — try again in a moment.";

/**
 * May this Discord account open the staff panel?
 *
 * The command lives in EVERY guild the bot is in, so the answer cannot come from where the press
 * happened — the roles Discord sends with an interaction are the roles of THAT guild, and in the
 * public server those are member roles, not staff ones. The answer comes from the STAFF guild: we
 * ask Discord, at press time, what roles this account holds there, and require one that the role
 * map grants panel access with.
 *
 * That is deliberately the same rule, off the same list, as signing in to the web panel
 * (routes/auth.ts step 3). Removing someone from staff in Discord therefore closes both doors at
 * once — no second list to prune, no "we forgot the bot" gap between losing the role and losing
 * the panel. It is checked live rather than from the linked account, because a linked account is
 * a snapshot and the whole point is that the snapshot must not outlive the role.
 *
 * Failure modes, chosen so a misconfiguration cannot silently grant access:
 *   - not a member of the staff guild (404) → refused;
 *   - a member, but no mapped role → refused;
 *   - Discord unreachable or refusing → refused, with "try again" (a blip must not be a bypass);
 *   - no bot token or no staff guild configured → UNCHECKED. Nothing can be verified, so the
 *     linked-staff-account check stands alone, exactly as it did before this existed.
 */
/**
 * Definitive verdicts, remembered briefly. This check runs on EVERY panel press, and the new
 * multi-press flows (a moderation volley, the objectives walk) made a dozen presses in half a
 * minute the normal shape of using the panel — a member fetch per press is exactly the Discord
 * request volume the shared roster work (task: one shared member roster) exists to avoid. Thirty
 * seconds keeps "losing the staff role closes an open panel" honest to within one breath while
 * collapsing a whole cart build into one request. Only YES and NOT-STAFF are cached: a failed
 * check is an outage, not an answer, and must not stick to anybody.
 */
const STAFF_ACCESS_TTL_MS = 30_000;
const staffAccessCache = new Map<string, { verdict: { ok: true } | { ok: false; message: string }; at: number }>();

export async function staffGuildAccess(
  repo: Repository,
  discordUserId: string,
  opts: { fetchImpl?: typeof fetch; cache?: boolean } = {},
): Promise<{ ok: true } | { ok: false; message: string }> {
  const token = process.env.DISCORD_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!token || !guildId) return { ok: true };

  // An injected transport is a test asserting per-call behavior — no caching across those
  // unless the test says so (`cache: true` is how the cache itself gets tested).
  const cacheable = opts.cache ?? !opts.fetchImpl;
  const key = `${guildId}:${discordUserId}`;
  if (cacheable) {
    const hit = staffAccessCache.get(key);
    if (hit && Date.now() - hit.at < STAFF_ACCESS_TTL_MS) return hit.verdict;
  }

  // Through guildMember and so through the shared Discord rate limiter (interactive lane) —
  // the raw fetch this used to be was the one member read in the app outside the limiter.
  const m = await guildMember(guildId, discordUserId, opts.fetchImpl ?? fetch, "interactive");
  if (m.kind === "unavailable") {
    log.warn("staff guild member lookup failed", { reason: m.reason });
    return { ok: false, message: CHECK_FAILED_MSG };
  }
  let verdict: { ok: true } | { ok: false; message: string };
  if (m.kind === "notInGuild") {
    verdict = { ok: false, message: NOT_STAFF_MSG };
  } else {
    const mappings = await repo.discordRoleMap.list();
    // An empty role map is not "everyone" — nobody can sign in to the panel under it either.
    verdict = mappedRoleAssignments(m.roleIds, mappings).length ? { ok: true } : { ok: false, message: NOT_STAFF_MSG };
  }
  if (cacheable) {
    for (const [k, v] of staffAccessCache) if (Date.now() - v.at >= STAFF_ACCESS_TTL_MS) staffAccessCache.delete(k);
    staffAccessCache.set(key, { verdict, at: Date.now() });
  }
  return verdict;
}

/**
 * Every use of the staff panel leaves a row. The HOST writes it, not the modules — a module that
 * forgot would be a hole in the trail, and the whole point of the trail is that it is not a
 * convention anybody can forget. Adding a module therefore cannot add an unrecorded action.
 *
 * Attribution is the linked PANEL account: the trail answers "which staff member", and a Discord
 * id is not one. The Discord id and channel ride along in `data` so the row can be matched back to
 * what someone saw in Discord.
 *
 * Host navigation (Back, launcher paging) is not recorded. It is movement between screens, not an
 * act on the community, and recording it would bury the presses that are.
 */
async function recordPanelUse(
  repo: Repository,
  account: { id: string },
  actorName: string,
  what: { summary: string; action: string; moduleId?: string; moduleLabel?: string; data?: Record<string, unknown> },
): Promise<void> {
  await repo.audit.create({
    actorUserId: account.id, actorName, action: what.action,
    targetType: "discord-panel", targetId: what.moduleId ?? "panel", targetName: what.moduleLabel ?? "Staff panel",
    summary: what.summary,
    data: what.data ?? null,
  }).catch(() => { /* the trail must never be what breaks a staff action */ });
}

/** The channel a press came from, named where Discord told us the name. */
function interactionChannel(interaction: Record<string, unknown>): { id: string; name: string } {
  const ch = interaction.channel as { id?: unknown; name?: unknown } | undefined;
  return { id: String(ch?.id ?? interaction.channel_id ?? ""), name: String(ch?.name ?? "") };
}

/** "#testing" when Discord named the channel, the raw id when it did not (a DM has neither). */
function channelLabel(ch: { id: string; name: string }): string {
  return ch.name ? `#${ch.name}` : ch.id ? `channel ${ch.id}` : "a direct message";
}

/**
 * Panels with a slow press still running, keyed `<discord user>:<message>`.
 *
 * A slow press is acknowledged with "thinking" in place, and Discord leaves the panel's buttons
 * pressable while the work runs. So a second press on the same panel ran the same work again: a
 * moderation volley fired twice (every kick, ban and message, and a second request filed),
 * "Change map now" loaded the map twice, an objectives Apply restarted the round twice, a VIP
 * grant added its hours twice. While a press is running on a panel, another press there by the
 * same person is acknowledged and dropped — the running press's own answer lands on the panel a
 * moment later. A press older than PRESS_STALE_MS stops holding its panel, so a follow-up that
 * never returns cannot lock one for good.
 */
const panelsBusy = new Map<string, { at: number }>();
const PRESS_STALE_MS = 2 * 60_000;

/** Hold a panel for one slow press: a release function, "busy" when a press is already running
 *  there, or null when the press names no message to key on (it is then not guarded). */
function holdPanel(whoId: string, interaction: Record<string, unknown>): (() => void) | "busy" | null {
  const messageId = (interaction.message as { id?: unknown } | undefined)?.id;
  if (typeof messageId !== "string" || !messageId) return null;
  const key = `${whoId}:${messageId}`;
  const held = panelsBusy.get(key);
  if (held && Date.now() - held.at < PRESS_STALE_MS) return "busy";
  const mine = { at: Date.now() };
  panelsBusy.set(key, mine);
  // Only this hold is released: a stale press finishing late must not free the panel out from
  // under the press that took it over.
  return () => { if (panelsBusy.get(key) === mine) panelsBusy.delete(key); };
}

/** PATCH the original ephemeral message once a deferred handler finishes. */
async function followUpEdit(
  fetchImpl: typeof fetch,
  appId: string,
  interactionToken: string,
  payload: { content: string; components?: unknown[] },
): Promise<void> {
  const res = await fetchImpl(`https://discord.com/api/v10/webhooks/${appId}/${interactionToken}/messages/@original`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`follow-up edit failed: ${res.status}`);
}

/**
 * Verify + dispatch one interaction. Returns the HTTP status + JSON body to send back to Discord.
 * A missing/invalid signature is 401 (Discord requires this for its endpoint validation).
 */
export async function handleInteraction(
  repo: Repository,
  publicKeyHex: string,
  headers: { signature?: string; timestamp?: string },
  rawBody: string,
  opts: {
    now?: number; windowSeconds?: number;
    /** The /staff module registry. Absent = the panel simply isn't offered (tests of the bare endpoint). */
    registry?: DiscordModuleRegistry;
    /** The public VIP panel's modules — gated by linking, not by a staff account. */
    publicRegistry?: PublicModuleRegistry;
    /** Needed for deferred follow-ups (the webhook path embeds it). */
    appId?: string;
    fetchImpl?: typeof fetch;
    /** The approvals relay's button handler — absent when the feature is off. */
    approvals?: { decide(d: { discordUserId: string; requestId: string; verb: "all" | "deny"; reason?: string }): Promise<string> };
  } = {},
): Promise<InteractionResult> {
  if (!publicKeyHex) return { status: 503, body: { error: "Discord interactions are not configured" } };
  if (!verifyInteraction(publicKeyHex, headers.signature ?? "", headers.timestamp ?? "", rawBody, opts)) {
    return { status: 401, body: { error: "invalid request signature" } };
  }
  let interaction: Record<string, unknown>;
  try { interaction = JSON.parse(rawBody) as Record<string, unknown>; } catch { return { status: 400, body: { error: "bad body" } }; }

  if (interaction.type === INTERACTION_PING) return { status: 200, body: { type: RESP_PONG } };

  if (interaction.type === INTERACTION_COMMAND) {
    const say = (content: string) => ({ status: 200, body: { type: RESP_MESSAGE, data: { content, flags: EPHEMERAL } } });
    const name = (interaction.data as { name?: string } | undefined)?.name ?? "";
    // Dispatch on the CONFIGURED name: what Discord sends is whatever the last registration
    // installed, so a rename in the panel has to be matched here or the command goes dead.
    const cmdCfg = await repo.discordCommands.get();
    if (name !== cmdCfg.name) return say(`Unknown command: ${name}`);
    // Switched off in the panel but still installed in Discord, because nobody pressed Register
    // afterwards. Saying so beats "Unknown command", which reads like a broken bot.
    if (!cmdCfg.enabled) return say(`/${name} is switched off.`);
    if (!opts.registry) return say("The panel is not available on this instance.");

    // The module launcher — the bot's ONLY command. Ephemeral and personalised: one button per
    // module the invoker may open, decided from their linked staff account at press time.
    const who = interactionUser(interaction);
    if (!who) return say("Could not tell who pressed that.");
    // Staff-guild roles first: the command exists in every server the bot is in, so a member of
    // the public Discord will type it. "That's for staff" is the honest answer to them — sending
    // them off to link a staff account would be an invitation to something they cannot have.
    const staffing = await staffGuildAccess(repo, who.id, { fetchImpl: opts.fetchImpl });
    if (!staffing.ok) return say(staffing.message);
    const { account, modules } = await permittedModules(repo, opts.registry, who.id);
    if (!account) return say(NO_ACCOUNT_MSG);
    const ch = interactionChannel(interaction);
    await recordPanelUse(repo, account, who.name, {
      action: "discord.panel.open",
      summary: `opened the staff panel in ${channelLabel(ch)} (${modules.length} module${modules.length === 1 ? "" : "s"} available)`,
      data: { discordUserId: who.id, discordUserName: who.name, channelId: ch.id, channelName: ch.name || null, command: cmdCfg.name },
    });
    return { status: 200, body: { type: RESP_MESSAGE, data: { ...renderLauncher(modules, 0), flags: EPHEMERAL } } };
  }

  // Public panel presses and modal submits (`pp:` ids) — no staff account, no capability: the
  // modules themselves gate on linking. Modal submits carry the typed values.
  /*
   * The approvals relay's card buttons (`apr:<requestId>:<verb>`). Handled ahead of both module
   * registries because the card lives in an ordinary channel, not inside a panel. The heavy work
   * (game connections) is deferred; "Deny…" opens a modal that DEMANDS the reason, because the
   * requester reads it. Who may sign is decided inside the callback — the same approveLine path
   * as the panel — so a button proves nothing by itself.
   */
  if ((interaction.type === INTERACTION_COMPONENT || interaction.type === INTERACTION_MODAL_SUBMIT) && opts.approvals) {
    const customId = String((interaction.data as { custom_id?: unknown } | undefined)?.custom_id ?? "");
    if (customId.startsWith("apr:")) {
      const [, requestId = "", verb = ""] = customId.split(":");
      const who = interactionUser(interaction);
      if (!who) return { status: 200, body: { type: RESP_MESSAGE, data: { content: "Could not tell who pressed that.", flags: EPHEMERAL } } };
      if (interaction.type === INTERACTION_COMPONENT && verb === "deny") {
        return { status: 200, body: { type: RESP_MODAL, data: {
          custom_id: `apr:${requestId}:denysub`, title: "Deny this request",
          components: [{ type: 1, components: [{ type: 4, custom_id: "reason", label: "Why — the requester reads this", style: 2, required: true, max_length: 300 }] }],
        } } };
      }
      const reason = interaction.type === INTERACTION_MODAL_SUBMIT ? String(modalValues(interaction).reason ?? "") : undefined;
      const decide = () => opts.approvals!.decide({ discordUserId: who.id, requestId, verb: verb === "denysub" ? "deny" : "all", reason })
        .catch((err) => `That didn't work: ${(err as Error).message}`);
      if (opts.appId) {
        const token = String(interaction.token ?? "");
        const fetchImpl = opts.fetchImpl ?? fetch;
        void decide()
          .then((sentence) => followUpEdit(fetchImpl, opts.appId!, token, { content: sentence }))
          .catch((err) => log.error("approvals button follow-up failed", { err: (err as Error).message }));
        return { status: 200, body: { type: RESP_DEFERRED_MESSAGE, data: { flags: EPHEMERAL } } };
      }
      // No appId (bare-endpoint tests): answer inline.
      return { status: 200, body: { type: RESP_MESSAGE, data: { content: await decide(), flags: EPHEMERAL } } };
    }
  }

  if ((interaction.type === INTERACTION_COMPONENT || interaction.type === INTERACTION_MODAL_SUBMIT) && opts.publicRegistry) {
    const customId = String((interaction.data as { custom_id?: unknown } | undefined)?.custom_id ?? "");
    const decoded = decodeCustomId(customId, PUBLIC_PREFIX);
    if (decoded) {
      const who = interactionUser(interaction);
      // Whether the pressed message is the user's own ephemeral panel or the shared, public
      // launcher decides the response KIND: updating the launcher in place would rewrite it for
      // the whole channel, so a launcher press opens a NEW ephemeral message instead.
      const fromEphemeral = (Number((interaction.message as { flags?: unknown } | undefined)?.flags ?? 0) & EPHEMERAL) !== 0;
      const respond = (data: Record<string, unknown>) =>
        fromEphemeral
          ? { status: 200, body: { type: RESP_UPDATE, data } }
          : { status: 200, body: { type: RESP_MESSAGE, data: { ...data, flags: EPHEMERAL } } };
      if (!who) return respond({ content: "Could not tell who pressed that.", components: [] });
      const def = opts.publicRegistry.get(decoded.moduleId);
      if (!def) return respond({ content: "That panel is no longer available.", components: [] });
      const selected = (interaction.data as { values?: unknown[] } | undefined)?.values;
      const ev = {
        discordUserId: who.id, discordUserName: who.name,
        action: decoded.action, state: decoded.state,
        interactionId: String(interaction.id ?? ""),
        roleIds: interactionRoles(interaction),
        ...(interaction.type === INTERACTION_MODAL_SUBMIT ? { values: modalValues(interaction) } : {}),
        ...(Array.isArray(selected) ? { selected: selected.map(String) } : {}),
      };
      const run = async () => {
        const result = decoded.action === "" ? await def.open(ev) : await (def.action ?? def.open)(ev);
        return result;
      };
      const render = (result: Awaited<ReturnType<typeof run>>) =>
        isModalResult(result)
          ? null // a modal cannot follow a defer — the branch below guards it
          : renderPublicView(decoded.moduleId, result, { root: decoded.action === "" });

      if (def.deferActions?.includes(decoded.action) && opts.appId) {
        // One slow press at a time on a member's own panel (see panelsBusy). The shared launcher
        // is never held: every member presses that one message.
        const release = fromEphemeral ? holdPanel(who.id, interaction) : null;
        if (release === "busy") return { status: 200, body: { type: RESP_DEFERRED_UPDATE } };
        const token = String(interaction.token ?? "");
        const fetchImpl = opts.fetchImpl ?? fetch;
        const followUp = run()
          .then((result) => render(result) ?? { content: `**${def.label}**: that step cannot open a form after a slow operation — report this to staff.`, components: [] })
          .catch((err) => ({ content: `**${def.label}** failed: ${(err as Error).message}`, components: [] }))
          .then((payload) => followUpEdit(fetchImpl, opts.appId!, token, payload))
          .catch((err) => log.error("public deferred follow-up failed", { module: def.id, err: (err as Error).message }))
          .finally(() => release?.());
        // From an ephemeral panel a deferred UPDATE (6) shows "thinking" in place; from the
        // public launcher it must instead defer a NEW ephemeral reply (5), or the shared
        // message would flicker for everyone. @original then edits the right message either way.
        const ack = fromEphemeral
          ? { type: RESP_DEFERRED_UPDATE }
          : { type: 5 /* DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE */, data: { flags: EPHEMERAL } };
        return { status: 200, body: ack, followUp };
      }

      try {
        const result = await run();
        if (isModalResult(result)) return { status: 200, body: { type: RESP_MODAL, data: modalJson(decoded.moduleId, result.modal) } };
        return respond(render(result)!);
      } catch (err) {
        return respond({ content: `**${def.label}** failed: ${(err as Error).message}`, components: [] });
      }
    }
  }

  if ((interaction.type === INTERACTION_COMPONENT || interaction.type === INTERACTION_MODAL_SUBMIT) && opts.registry) {
    const registry = opts.registry;
    const customId = String((interaction.data as { custom_id?: unknown } | undefined)?.custom_id ?? "");
    const decoded = decodeCustomId(customId);
    // Not ours (a vote surface, a future feature): keep the old refusal rather than guessing.
    if (!decoded) return { status: 200, body: { type: RESP_MESSAGE, data: { content: "Unsupported interaction.", flags: EPHEMERAL } } };

    // Editing the panel in place is the normal answer, and a component press always has a message
    // to edit. A modal submit only carries one when the modal was opened from a component — which
    // is the only way this panel opens them, but answering 7 without a message is an error, so the
    // fallback is a fresh ephemeral reply rather than a broken interaction.
    const canEdit = interaction.type === INTERACTION_COMPONENT || !!interaction.message;
    const respond = (data: Record<string, unknown>): InteractionResult => canEdit
      ? { status: 200, body: { type: RESP_UPDATE, data } }
      : { status: 200, body: { type: RESP_MESSAGE, data: { ...data, flags: EPHEMERAL } } };

    const who = interactionUser(interaction);
    if (!who) return respond({ content: "Could not tell who pressed that.", components: [] });
    // Re-checked on every press, not just at the command: losing the staff role has to close a
    // panel that is still sitting open in somebody's Discord, not wait for them to reopen it.
    const staffing = await staffGuildAccess(repo, who.id, { fetchImpl: opts.fetchImpl });
    if (!staffing.ok) return respond({ content: staffing.message, components: [] });
    const { account, modules } = await permittedModules(repo, registry, who.id);
    if (!account) return respond({ content: NO_ACCOUNT_MSG, components: [] });

    // The host's own Back/launcher presses.
    if (decoded.moduleId === HOME_ID) {
      const page = decoded.action === "page" ? Number(decoded.state) || 0 : 0;
      return respond(renderLauncher(modules, page));
    }

    const def = registry.get(decoded.moduleId);
    if (!def) return respond({ content: "That module is no longer installed.", components: [] });
    // The per-press gate: permission is a fact about NOW, not about when the button was drawn.
    if (!modules.some((m) => m.id === def.id)) return respond({ content: `You don't have access to **${def.label}**.`, components: [] });

    const ch = interactionChannel(interaction);
    const selected = (interaction.data as { values?: unknown[] } | undefined)?.values;
    const ev = {
      discordUserId: who.id, discordUserName: who.name, action: decoded.action, state: decoded.state,
      channelId: ch.id, channelName: ch.name,
      interactionId: String(interaction.id ?? ""),
      roleIds: interactionRoles(interaction),
      // Modules attribute their own writes to the staff ACCOUNT, so a VIP granted from Discord
      // and one granted from the web panel name the same person in the trail.
      staffUserId: account.id, staffName: who.name,
      ...(interaction.type === INTERACTION_MODAL_SUBMIT ? { values: modalValues(interaction) } : {}),
      ...(Array.isArray(selected) ? { selected: selected.map(String), selectedNames: interactionSelectedNames(interaction) } : {}),
    };
    const run = async () => {
      const result = decoded.action === "" ? await def.open(ev) : await (def.action ?? def.open)(ev);
      // A modal cannot follow a defer, so the deferred path never gets one — the branch below
      // refuses to defer a modal-opening action, and this is the safety net if one slips through.
      return isModalResult(result)
        ? renderModuleView(def.id, { content: `**${def.label}**: that step cannot open a form after a slow operation — report this to staff.` }, def.backTo)
        : renderModuleView(def.id, result, def.backTo);
    };
    // Slow modules: acknowledge inside Discord's 3-second budget, then edit the original message
    // through the interaction webhook when the work lands. `deferActions` names the slow steps one
    // by one, which is what a module with modals needs — `defer: true` would swallow the modal.
    const slow = def.defer === true || (def.deferActions?.includes(decoded.action) ?? false);
    // One slow press at a time per panel (see panelsBusy) — decided before the press is recorded,
    // so a dropped double-click does not read in the trail as a second action.
    const release = slow && opts.appId ? holdPanel(who.id, interaction) : null;
    if (release === "busy") return { status: 200, body: { type: RESP_DEFERRED_UPDATE } };

    // Recorded before the work runs: a press that then fails is still a press somebody made, and
    // "they tried" is exactly what you want to see when something went wrong.
    await recordPanelUse(repo, account, who.name, {
      action: decoded.action === "" ? "discord.module.open" : "discord.module.action",
      moduleId: def.id, moduleLabel: def.label,
      summary: decoded.action === ""
        ? `opened **${def.label}** in the staff panel`
        : `used **${def.label}** in the staff panel — ${decoded.action}${decoded.state ? ` (${decoded.state})` : ""}`,
      data: { discordUserId: who.id, moduleId: def.id, action: decoded.action || "open", state: decoded.state || null, channelId: ch.id, channelName: ch.name || null },
    });

    if (slow && opts.appId) {
      const token = String(interaction.token ?? "");
      const fetchImpl = opts.fetchImpl ?? fetch;
      const followUp = run()
        .catch((err) => renderModuleView(def.id, { content: `**${def.label}** failed: ${(err as Error).message}` }, def.backTo))
        .then((payload) => followUpEdit(fetchImpl, opts.appId!, token, payload))
        .catch((err) => log.error("deferred follow-up failed", { module: def.id, err: (err as Error).message }))
        .finally(() => release?.());
      // "Thinking" in place when there is a message to edit; otherwise a deferred ephemeral reply.
      const ack = canEdit ? { type: RESP_DEFERRED_UPDATE } : { type: RESP_DEFERRED_MESSAGE, data: { flags: EPHEMERAL } };
      return { status: 200, body: ack, followUp };
    }

    try {
      const result = decoded.action === "" ? await def.open(ev) : await (def.action ?? def.open)(ev);
      // A form: Discord only takes one as the FIRST response, which is why this is not routed
      // through `run()` and why a modal-opening action must never be listed in `deferActions`.
      if (isModalResult(result)) return { status: 200, body: { type: RESP_MODAL, data: modalJson(def.id, result.modal, CUSTOM_ID_PREFIX) } };
      return respond(renderModuleView(def.id, result, def.backTo));
    } catch (err) {
      return respond(renderModuleView(def.id, { content: `**${def.label}** failed: ${(err as Error).message}` }, def.backTo));
    }
  }

  // Component (button/select) interactions land here — handlers added with the embed vote surface.
  return { status: 200, body: { type: RESP_MESSAGE, data: { content: "Unsupported interaction.", flags: EPHEMERAL } } };
}

/**
 * Register the slash command with Discord — GLOBALLY, which is every guild the bot is in.
 *
 * Not guild-scoped, and not a list of guilds. A guild-scoped command exists only where it was
 * installed, so any list is a list somebody has to maintain: add a Discord, remember to re-press
 * Register, or the command silently is not there. Global covers every server the bot is in today
 * and every one it joins later, with nothing to remember. The cost is propagation — Discord can
 * take up to an hour to show a change everywhere.
 *
 * Being visible everywhere is safe because visibility is not access: `staffGuildAccess` asks the
 * STAFF guild what roles the presser holds, so a member of the public Discord who types it is told
 * it is for staff.
 *
 * `staleGuildIds` are guilds a previous version installed a guild-scoped copy into. Those copies
 * outlive this change and would sit alongside the global one, so each is PUT an empty list. Failure
 * there is ignored: a guild the bot has left cannot hold a stale command anyway.
 *
 * PUT is a REPLACE: whatever is not in the payload gets deleted, which is how a command switched
 * off in the panel — or renamed — stops existing under its old name.
 *
 * Returns the names it installed, so the caller can say what happened.
 */
/**
 * Every guild this bot is in, as Discord sees it right now.
 *
 * Registration needs this because a GLOBAL command list says nothing about the guild-scoped
 * copies an earlier build (or an earlier bot sharing this application) left behind, and a
 * guild-scoped command takes precedence over the global one of the same name. Asking Discord is
 * the only way to know where to look — a list kept in our own config only ever covers the guilds
 * somebody remembered to write down.
 */
async function botGuildIds(token: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const ids: string[] = [];
  let after = "";
  // Bots read their own guilds 200 at a time; a community runs a handful, but paging costs one
  // line and stops this quietly truncating for anyone who runs more.
  for (let page = 0; page < 10; page++) {
    const res = await fetchImpl(`https://discord.com/api/v10/users/@me/guilds?limit=200${after ? `&after=${after}` : ""}`, {
      headers: { authorization: `Bot ${token}` },
    });
    if (!res.ok) {
      log.warn("could not list the bot's guilds — guild-scoped commands may survive elsewhere", { status: res.status });
      break;
    }
    const batch = (await res.json()) as { id?: string }[];
    if (!Array.isArray(batch) || !batch.length) break;
    for (const g of batch) if (g?.id) ids.push(String(g.id));
    if (batch.length < 200) break;
    after = ids[ids.length - 1]!;
  }
  return ids;
}

export interface RegisteredCommands {
  /** The command names now installed globally. */
  names: string[];
  /** The guilds whose guild-scoped copies were cleared, so the global list is what everyone sees. */
  clearedGuilds: string[];
}

export async function registerCommands(
  token: string,
  appId: string,
  cfg: DiscordCommandConfig,
  staleGuildIds: string[] = [],
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<RegisteredCommands> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const schemas = commandSchemas(cfg);
  const put = (path: string, body: unknown) => fetchImpl(`https://discord.com/api/v10${path}`, {
    method: "PUT",
    headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const res = await put(`/applications/${appId}/commands`, schemas);
  if (!res.ok) throw new Error(`Discord command registration failed: ${res.status} ${(await res.text()).slice(0, 300)}`);

  /**
   * Then clear the guild-scoped copies EVERYWHERE, not just in the two guilds we happen to have
   * ids for in config.
   *
   * This is the whole bug behind "one of my Discords still shows the old command": a guild-scoped
   * command outranks the global one, and clearing only the staff and community guilds left every
   * other server the bot is in showing whatever an earlier version installed there — forever,
   * because nothing ever went back to look.
   *
   * Best-effort per guild: a server that refuses (no applications.commands scope there, most
   * likely) must not fail a registration that has already succeeded globally.
   */
  const targets = [...new Set([...staleGuildIds, ...(await botGuildIds(token, fetchImpl))])];
  const clearedGuilds: string[] = [];
  for (const guildId of targets) {
    try {
      const r = await put(`/applications/${appId}/guilds/${guildId}/commands`, []);
      if (r.ok) clearedGuilds.push(guildId);
      else log.warn("could not clear guild-scoped commands", { guildId, status: r.status });
    } catch (err) {
      log.warn("could not clear guild-scoped commands", { guildId, err: (err as Error).message });
    }
  }
  return { names: schemas.map((s) => s.name), clearedGuilds };
}
