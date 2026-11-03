/**
 * The /staff panel's module system (docs/discord-modules.md).
 *
 * Three parts, all pure enough to test without Discord:
 *   - the custom_id codec — `sp:<moduleId>:<action>:<state>`, refused at RENDER time when it
 *     cannot fit Discord's 100-char limit (a too-long id refused at press time is a dead button);
 *   - the registry — first-party modules and SDK plugins land in the same map, plugins namespaced
 *     `<pluginId>.<id>` upstream;
 *   - the renderer — a declarative DiscordView becomes Discord component JSON, with the host's
 *     own Back row appended so every module screen can return to the launcher.
 *
 * Who may see what is the HOST's job: the launcher lists only modules whose capability the
 * invoker holds, and the capability is re-checked on every press (discord.ts).
 */
import type { DiscordButton, DiscordModal, DiscordModuleDef, DiscordModuleResult, DiscordView } from "@app/plugin-sdk";
import type { Repository } from "@app/db";
import { can, canAnywhere } from "@app/access";
import { resolveAccess } from "./auth.js";
import { manualRegistrationModule } from "./discord-manual-registration.js";
import { economyModule } from "./discord-economy.js";
import { moderationModule } from "./discord-moderation.js";
import { mapsModule } from "./discord-maps.js";

/** The staff panel's custom_id prefix; the public VIP panel uses PUBLIC_PREFIX. Two prefixes,
 *  one codec — the gate they dispatch through differs (capabilities vs linking), never the wire. */
export const CUSTOM_ID_PREFIX = "sp";
export const PUBLIC_PREFIX = "pp";
/** Discord's hard limit on a component custom_id. */
const CUSTOM_ID_MAX = 100;
const MODULE_ID_RE = /^[a-z0-9_-]{1,32}(\.[a-z0-9_-]{1,32})?$/;
const ACTION_RE = /^[a-z0-9_-]{0,24}$/;

/** The host's own launcher id: Back rows point here; `page` pages the launcher. */
export const HOME_ID = "home";

export function encodeCustomId(moduleId: string, action: string, state = "", prefix = CUSTOM_ID_PREFIX): string {
  if (!MODULE_ID_RE.test(moduleId)) throw new Error(`bad module id in custom_id: "${moduleId}"`);
  if (!ACTION_RE.test(action)) throw new Error(`bad action in custom_id: "${action}"`);
  const id = `${prefix}:${moduleId}:${action}:${state}`;
  if (id.length > CUSTOM_ID_MAX) throw new Error(`custom_id too long (${id.length} > ${CUSTOM_ID_MAX}): ${id.slice(0, 40)}…`);
  return id;
}

/** null = not ours (some other surface's component — leave it alone). */
export function decodeCustomId(raw: string, prefix = CUSTOM_ID_PREFIX): { moduleId: string; action: string; state: string } | null {
  if (!raw.startsWith(`${prefix}:`)) return null;
  const rest = raw.slice(prefix.length + 1);
  const first = rest.indexOf(":");
  if (first < 0) return null;
  const second = rest.indexOf(":", first + 1);
  if (second < 0) return null;
  const moduleId = rest.slice(0, first);
  const action = rest.slice(first + 1, second);
  const state = rest.slice(second + 1); // may itself contain colons — the module owns it
  if (!MODULE_ID_RE.test(moduleId) || !ACTION_RE.test(action)) return null;
  return { moduleId, action, state };
}

export class DiscordModuleRegistry {
  private modules = new Map<string, DiscordModuleDef>();

  register(def: DiscordModuleDef): void {
    if (!MODULE_ID_RE.test(def.id)) throw new Error(`bad discord module id: "${def.id}"`);
    if (def.id === HOME_ID) throw new Error(`"${HOME_ID}" is the host's own id`);
    if (this.modules.has(def.id)) throw new Error(`discord module already registered: ${def.id}`);
    this.modules.set(def.id, def);
  }

  unregister(id: string): void {
    this.modules.delete(id);
  }

  get(id: string): DiscordModuleDef | undefined {
    return this.modules.get(id);
  }

  /** Launcher order: registration order — stable, and first-party modules register first. */
  list(): DiscordModuleDef[] {
    return [...this.modules.values()];
  }
}

// --- rendering: DiscordView → Discord component JSON ---

const BUTTON_STYLE: Record<NonNullable<DiscordButton["style"]>, number> = { primary: 1, secondary: 2, success: 3, danger: 4 };
/** Discord's component limits: 5 rows of 5 buttons. The host reserves the last row for Back. */
const MAX_ROWS = 5;
const MAX_PER_ROW = 5;

function buttonJson(moduleId: string, b: DiscordButton, prefix = CUSTOM_ID_PREFIX): Record<string, unknown> {
  const sep = b.customId.indexOf(":");
  const action = sep < 0 ? b.customId : b.customId.slice(0, sep);
  const state = sep < 0 ? "" : b.customId.slice(sep + 1);
  return {
    type: 2, // button
    style: BUTTON_STYLE[b.style ?? "secondary"],
    label: b.label.slice(0, 80),
    // `b.moduleId` is a hub's door into a sub-panel: the press routes to THAT module and passes
    // through its own capability gate, exactly as a launcher press would — the jump buys no access.
    custom_id: encodeCustomId(b.moduleId ?? moduleId, action, state, prefix),
    ...(b.disabled ? { disabled: true } : {}),
  };
}

/** `"<action>"` or `"<action>:<state>"` — the half a module owns, split for the codec. */
function splitCustomId(raw: string): { action: string; state: string } {
  const sep = raw.indexOf(":");
  return sep < 0 ? { action: raw, state: "" } : { action: raw.slice(0, sep), state: raw.slice(sep + 1) };
}

/**
 * One renderer for both panels. They differ in exactly two ways — the custom_id prefix, and which
 * escape row the host appends — so they are one function with two parameters rather than two
 * functions that drift apart. The staff panel got selects for free the day this merged.
 *
 * Every select costs a row, and so does the escape row. Charging for them BEFORE slicing the
 * button rows is the whole point: the roster picker once rendered four rows of names and had its
 * navigation row silently dropped here, leaving "page 1/5" with no way to reach page 2.
 */
function renderView(
  moduleId: string,
  view: DiscordView,
  opts: { prefix: string; escape: { label: string; target: string } | null },
): { content: string; components: unknown[] } {
  const budget = MAX_ROWS - (opts.escape ? 1 : 0) - (view.userSelect ? 1 : 0) - (view.select ? 1 : 0);
  const rows: { type: number; components: Record<string, unknown>[] }[] = (view.rows ?? []).slice(0, budget).map((row) => ({
    type: 1, // action row
    components: row.slice(0, MAX_PER_ROW).map((b) => buttonJson(moduleId, b, opts.prefix)),
  }));
  if (view.select) {
    const { action, state } = splitCustomId(view.select.customId);
    rows.unshift({
      type: 1,
      components: [{
        type: 3, // string select
        custom_id: encodeCustomId(moduleId, action, state, opts.prefix),
        ...(view.select.placeholder ? { placeholder: view.select.placeholder.slice(0, 150) } : {}),
        options: view.select.options.slice(0, 25).map((o) => ({
          label: o.label.slice(0, 100),
          value: o.value.slice(0, 100),
          ...(o.description ? { description: o.description.slice(0, 100) } : {}),
        })),
      }],
    });
  }
  if (view.userSelect) {
    const { action, state } = splitCustomId(view.userSelect.customId);
    rows.push({ type: 1, components: [{ type: 5, custom_id: encodeCustomId(moduleId, action, state, opts.prefix), ...(view.userSelect.placeholder ? { placeholder: view.userSelect.placeholder } : {}) }] });
  }
  if (opts.escape) {
    rows.push({ type: 1, components: [{ type: 2, style: 2, label: opts.escape.label, custom_id: encodeCustomId(opts.escape.target, "", "", opts.prefix) }] });
  }
  /**
   * No two components in one message may share a custom_id — Discord refuses the entire message,
   * so the screen the press was meant to produce never arrives and the panel appears frozen.
   *
   * Refused HERE, loudly, for the same reason a too-long id is: a view that cannot be rendered is
   * a bug in the view, and a caller that sees an error can say so, where Discord's silent 400
   * left a roster stuck on page 1 with no clue anywhere. (It happens when two buttons mean the
   * same thing — "Refresh" and "‹ Previous" both pointing at page 0.)
   */
  const seen = new Set<string>();
  for (const row of rows) {
    for (const c of row.components) {
      const id = String(c.custom_id ?? "");
      if (seen.has(id)) throw new Error(`two components share the custom_id "${id}" — Discord would reject the whole message`);
      seen.add(id);
    }
  }
  return { content: view.content.slice(0, 1900), components: rows };
}

/**
 * A staff module's view. The Back row is the host's: it re-renders the launcher, so a module can
 * never strand the user — and never needs to know the launcher exists. A sub-panel absorbed by a
 * hub passes the hub's id as `backTo`, so leaving it lands where the user actually came from.
 */
export function renderModuleView(moduleId: string, view: DiscordView, backTo?: string): { content: string; components: unknown[] } {
  return renderView(moduleId, view, { prefix: CUSTOM_ID_PREFIX, escape: { label: "‹ Back", target: backTo ?? HOME_ID } });
}

/**
 * The public panel's variant: `pp:` ids, and the escape row is "‹ Menu" back to the MODULE's root
 * (there is no staff launcher to return to). The root view itself gets no Menu row — it IS the menu.
 */
export function renderPublicView(moduleId: string, view: DiscordView, opts: { root?: boolean } = {}): { content: string; components: unknown[] } {
  return renderView(moduleId, view, { prefix: PUBLIC_PREFIX, escape: opts.root ? null : { label: "‹ Menu", target: moduleId } });
}

/** Did the handler ask for a form instead of a screen? Both panels ask the same question. */
export function isModalResult(r: DiscordModuleResult): r is { modal: DiscordModal } {
  return typeof r === "object" && r !== null && "modal" in r;
}

/** A modal response body (Discord type 9 data): text inputs routed back through the codec. */
export function modalJson(moduleId: string, modal: DiscordModal, prefix = PUBLIC_PREFIX): Record<string, unknown> {
  return {
    title: modal.title.slice(0, 45),
    custom_id: encodeCustomId(moduleId, modal.action, modal.state ?? "", prefix),
    components: modal.fields.slice(0, 5).map((f) => ({
      type: 1,
      components: [{ type: 4, custom_id: f.id, label: f.label.slice(0, 45), style: 1, required: true, ...(f.placeholder ? { placeholder: f.placeholder } : {}), ...(f.maxLength ? { max_length: f.maxLength } : {}) }],
    })),
  };
}

/** Field values out of a modal submit: data.components[].components[] → { id: value }. */
export function modalValues(interaction: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const rows = (interaction.data as { components?: { components?: { custom_id?: string; value?: unknown }[] }[] } | undefined)?.components ?? [];
  for (const row of rows) for (const c of row.components ?? []) if (c.custom_id) out[c.custom_id] = String(c.value ?? "");
  return out;
}

/**
 * The launcher itself: one button per permitted module, paged when a community collects more
 * modules than a message can hold. `page` is 0-based and lives in the custom_id.
 */
export function renderLauncher(allPermitted: DiscordModuleDef[], page = 0): { content: string; components: unknown[] } {
  // Hidden modules stay pressable (a hub's jump buttons reach them, capability-gated as ever) —
  // they just don't take a launcher slot, which is the whole point of a hub absorbing them.
  const permitted = allPermitted.filter((m) => !m.hidden);
  const PER_PAGE = (MAX_ROWS - 1) * MAX_PER_ROW; // last row reserved for paging when needed
  const pages = Math.max(1, Math.ceil(permitted.length / PER_PAGE));
  const p = Math.min(Math.max(page, 0), pages - 1);
  const slice = permitted.slice(p * PER_PAGE, (p + 1) * PER_PAGE);

  const rows: { type: number; components: Record<string, unknown>[] }[] = [];
  for (let i = 0; i < slice.length; i += MAX_PER_ROW) {
    rows.push({
      type: 1,
      components: slice.slice(i, i + MAX_PER_ROW).map((m) => ({
        type: 2, style: 1, label: m.label.slice(0, 80), custom_id: encodeCustomId(m.id, "", ""),
      })),
    });
  }
  if (pages > 1) {
    rows.push({ type: 1, components: [
      { type: 2, style: 2, label: "‹ Prev", custom_id: encodeCustomId(HOME_ID, "page", String(p - 1)), ...(p === 0 ? { disabled: true } : {}) },
      { type: 2, style: 2, label: `${p + 1}/${pages}`, custom_id: encodeCustomId(HOME_ID, "page", "noop"), disabled: true },
      { type: 2, style: 2, label: "Next ›", custom_id: encodeCustomId(HOME_ID, "page", String(p + 1)), ...(p === pages - 1 ? { disabled: true } : {}) },
    ] });
  }

  const lines = slice.map((m) => `• **${m.label}**${m.description ? ` — ${m.description}` : ""}`);
  return {
    content: permitted.length
      ? `**Staff panel** — pick a module:\n${lines.join("\n")}`
      : "**Staff panel** — you don't have access to any modules yet. Ask an admin to grant your account the capabilities the modules need.",
    components: rows,
  };
}

// --- first-party modules ---

/**
 * The proof-of-life module: server status at a glance. Deliberately tiny — it exists so the
 * launcher has something real on day one and so the registry's whole path (capability gate,
 * open, action, Back) is exercised before the VIP module lands on it.
 */
export function serversModule(repo: Repository): DiscordModuleDef {
  return {
    id: "servers",
    label: "Servers",
    description: "Connection and mode of every game server",
    capability: "server.view",
    open: async (ev) => {
      const [all, beats, grants] = await Promise.all([
        repo.servers.list({ includeRetired: true }), repo.heartbeats.list(),
        ev.staffUserId ? resolveAccess(repo, ev.staffUserId).then((a) => a.grants) : [],
      ]);
      // The panel's own server list (GET /api/servers), read the same way: numbered over every
      // server ever added, then narrowed to the ones this reader may see. A grant on one server
      // listed every server here, and numbering after the narrowing would call that one "#1".
      const live = all.map((s, i) => ({ s, no: i + 1 })).filter(({ s }) => !s.retiredAt);
      if (!live.length) return { content: "No servers are configured." };
      const shown = canAnywhere(grants, "admin.users", "read")
        ? live
        : live.filter(({ s }) => can(grants, "server.view", "read", { serverId: s.id }));
      if (!shown.length) return { content: "No server your permissions can see." };
      const beat = beats.find((b) => b.name === "ingestion");
      const lines = shown.map(({ s, no }) => `**#${no} ${s.name}** — ${s.engagementMode}${s.game ? ` · ${s.game}` : ""}`);
      return { content: `**Servers (${shown.length})**\n${lines.join("\n")}${beat ? `\nIngestion: ${beat.status}` : ""}` };
    },
  };
}

/**
 * The permanent launcher message staff post into a channel: one button, a static custom_id, no
 * state — it survives restarts and redeploys because there is nothing to lose.
 *
 * It lives here rather than beside the public module it opens so that BOTH posters — this file's
 * /staff module and the app's Economy screen — build the identical message from one place.
 */
export function launcherMessage(): { content: string; components: unknown[] } {
  return {
    content: `**VIP panel** — check your VIP, collect and spend points, link your game account.`,
    components: [{ type: 1, components: [{ type: 2, style: 1, label: "Open VIP panel", custom_id: encodeCustomId("vip", "", "", PUBLIC_PREFIX) }] }],
  };
}

/**
 * Post the public VIP launcher into the channel the panel was opened in.
 *
 * "Staff launches vip panel opener, public can open it" — this is the launching half, and it
 * lives here as well as in the app because the person who wants it is usually already in Discord,
 * in the channel they want it in. The app's Economy screen does the same thing for anyone who
 * would rather paste a channel id.
 *
 * The posted message is permanent and stateless (a static custom_id), so posting it twice makes
 * two working launchers rather than breaking the first — which is why this asks for a confirming
 * press instead of firing on open.
 */
export function vipLauncherModule(repo: Repository, postMessage: PostMessage): DiscordModuleDef {
  const HOW = "Members press its button to check VIP, collect points, buy, gift and link their game account.";
  return {
    id: "viplauncher",
    label: "VIP launcher",
    description: "Post the public VIP panel opener into this channel",
    capability: "economy.config",
    capabilityLevel: "write",
    defer: true, // one round trip to Discord's API; deferring keeps us inside the 3-second budget
    open: async () => ({
      content: `**Post the VIP panel launcher here?**\n${HOW}\nIt stays put and keeps working after restarts.`,
      rows: [[{ label: "Post it in this channel", customId: "post", style: "primary" }]],
    }),
    action: async (ev) => {
      if (ev.action !== "post") return { content: "Unknown action." };
      if (!ev.channelId) return { content: "I can't tell which channel this is — post it from a channel, or use the app." };
      const cfg = await repo.economy.config();
      const where = ev.channelName ? `#${ev.channelName}` : `channel ${ev.channelId}`;
      try {
        await postMessage(ev.channelId, launcherMessage());
      } catch (err) {
        // A failed post is still worth a row: "they tried and Discord refused" is the answer to
        // "why is there no launcher in that channel".
        await repo.audit.create({
          actorUserId: ev.staffUserId ?? null, actorName: ev.staffName ?? ev.discordUserName, action: "economy.launcher.failed",
          targetType: "discord-channel", targetId: ev.channelId, targetName: where,
          summary: `could not post the VIP panel launcher to ${where} — ${(err as Error).message}`,
          data: { channelId: ev.channelId, channelName: ev.channelName ?? null, via: "discord" },
        }).catch(() => {});
        return { content: `❌ Could not post it: ${(err as Error).message}` };
      }
      // Who pasted a launcher, when, and into which channel — a permanent public message is a
      // thing somebody has to answer for later.
      await repo.audit.create({
        actorUserId: ev.staffUserId ?? null, actorName: ev.staffName ?? ev.discordUserName, action: "economy.launcher",
        targetType: "discord-channel", targetId: ev.channelId, targetName: where,
        summary: `posted the VIP panel launcher to ${where}`,
        data: { channelId: ev.channelId, channelName: ev.channelName ?? null, discordUserId: ev.discordUserId, via: "discord" },
      }).catch(() => {});
      return { content: `✅ Posted in ${where}. Members can now open the ${cfg.currencyName} / VIP panel from this channel.` };
    },
  };
}

/** How a module reaches Discord to post a message. Injected so the registry stays testable — the
 *  real one is the bot token; tests hand in a recorder. */
export type PostMessage = (channelId: string, message: { content: string; components: unknown[] }) => Promise<void>;

/** Post as the bot, or explain why we can't. The token lives in the environment, never in config. */
export async function postAsBot(channelId: string, message: { content: string; components: unknown[] }): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("no bot token is set (Discord → Setup & status)");
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ...message, allowed_mentions: { parse: [] } }),
    // Awaited inside a request handler, so a hung socket holds an HTTP connection open with it.
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Discord returned ${res.status} — check the bot can post in that channel`);
}

/** Register everything first-party. One place, so startup and tests assemble the same panel. */
export function registerBuiltinModules(registry: DiscordModuleRegistry, repo: Repository, postMessage: PostMessage = postAsBot): void {
  registry.register(serversModule(repo));
  registry.register(economyModule(repo));
  registry.register(moderationModule(repo));
  registry.register(mapsModule(repo));
  // Absorbed by the Economy hub: still whole modules with their own flows, gates and tests —
  // hidden from the launcher and reached through the hub's doors, with Back leading home to it.
  registry.register({ ...manualRegistrationModule(repo), hidden: true, backTo: "economy" });
  registry.register({ ...vipLauncherModule(repo, postMessage), hidden: true, backTo: "economy" });
}
