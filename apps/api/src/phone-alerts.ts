/**
 * Phone notifications: the moments worth a buzz in someone's pocket, sent to every phone or
 * computer they turned notifications on for (Settings → Phone notifications):
 *
 *   - a watched player joins a server;
 *   - a request is waiting for their OK;
 *   - a server stops answering, and when it is back;
 *   - a player calls for an admin in chat;
 *   - the automatic rules kick or ban someone;
 *   - a server starts seeding and needs players, and when it goes live;
 *   - a request they filed has been decided;
 *   - a staff member bans a player — every one, or only those by the roles they pick;
 *   - a player is banned for good, by staff or by the automatic rules;
 *   - a staff member changes a setting;
 *   - a notice is posted on the staff board;
 *   - an admin goes into the admin camera;
 *   - a member buys something in the shop.
 *
 * Off until a person turns it on: a device is on once its browser has subscribed (routes/push.ts),
 * and which of these it gets is theirs to choose, kept with the rest of their own settings
 * (`phoneAlerts` in their account preferences). The first three are on until switched off; the
 * rest came later, and are off until switched on.
 *
 * Each person is told only what the panel would show them: joins if they may read the watchlist,
 * a server's outages, chat and seeding if they may see that server, a request if it holds a line
 * they could sign — the queue's own rule, so a notification never leads to an empty queue — the
 * automatic rules' actions if they may read that server's automation history, and their own
 * requests' outcome. Bans if they may read the ban record, a changed setting if they may read
 * that server's staff activity, the admin camera if they may see its log, purchases if they may
 * read members' balances, and the notice board, which is everyone's. Names only, never a player's
 * id or a watch reason: a notification can be read off a locked screen.
 *
 * Staff actions and changed settings are heard from the audit trail as each row is written
 * (repo.audit.watch), so every door they come through — the panel, Discord, an approved request —
 * is heard the same way. A run of them from one person (a ban list uploaded, a settings page saved
 * five times) is one notification and then a count, not a buzz per row.
 */
import { approvalRefusal, can, canAnywhere, type Grant } from "@app/access";
import type { ApprovalLineRow, AuditRow, PushSubscriptionRow, Repository } from "@app/db";
import { getGame } from "@app/games";
import { background, createLogger } from "@app/shared";
import { displayNameOf, resolveAccess, type Principal } from "./auth.js";
import { KIND_WORD } from "./approval-cards.js";
import type { EventBus } from "./plugin-host.js";
import { signerCoverage } from "./sign-coverage.js";
import { sendPush, vapidKeys, type PushMessage } from "./web-push.js";

const log = createLogger("phone-alerts");

/** Which notifications a person wants, from their own settings. */
export interface AlertChoices {
  watch: boolean; requests: boolean; servers: boolean;
  admin: boolean; automod: boolean; seeding: boolean; decided: boolean;
  bans: boolean; permabans: boolean; settings: boolean; notices: boolean; camera: boolean; shop: boolean;
  /** Staff bans only by someone holding one of these roles; none picked is every staff ban. */
  banRoles: string[];
}
/** The on/off choices — everything but the list of roles. */
type AlertSwitch = Exclude<keyof AlertChoices, "banRoles">;
export function alertChoices(prefs: Record<string, unknown>): AlertChoices {
  const raw = (prefs.phoneAlerts && typeof prefs.phoneAlerts === "object" ? prefs.phoneAlerts : {}) as Record<string, unknown>;
  return {
    watch: raw.watch !== false, requests: raw.requests !== false, servers: raw.servers !== false,
    // Added later, and off until switched on: someone who turned notifications on for the first
    // three does not start hearing about more without asking to.
    admin: raw.admin === true, automod: raw.automod === true, seeding: raw.seeding === true, decided: raw.decided === true,
    bans: raw.bans === true, permabans: raw.permabans === true, settings: raw.settings === true,
    notices: raw.notices === true, camera: raw.camera === true, shop: raw.shop === true,
    banRoles: Array.isArray(raw.banRoles) ? raw.banRoles.filter((r): r is string => typeof r === "string").slice(0, 100) : [],
  };
}

/** Don't buzz again for the same player rejoining the same server within this — the Discord
 *  watchlist alert's own cooldown. */
const WATCH_COOLDOWN_MS = 5 * 60_000;
/** One call for an admin per player per server within this: "!admin" typed three times is one call. */
const CALL_COOLDOWN_MS = 3 * 60_000;
/** A server's seeding news once per change within this, whichever way a slow seed wavers. */
const SEED_COOLDOWN_MS = 20 * 60_000;
/** Who may read a server's automatic actions: its automation history's own rule (routes/automation). */
const AUTOMATION_CAPS = ["admin.moderation", "autosettings.profiles", "seeding.config"];
/** A run from one source within this is one notification, then a count per window (see Runs). */
const RUN_MS = 2 * 60_000;
/** An admin popping in and out of the camera is one visit within this. */
const CAMERA_COOLDOWN_MS = 10 * 60_000;
/** A purchase lands one server at a time; its rows are gathered for this long, then told as one. */
const SHOP_GATHER_MS = 3_000;

/**
 * The changes a "setting was changed" notification is about, and the area each is told under:
 * what staff change to decide how the servers and the panel behave. Bans, VIP, messages, notes and
 * map changes are things done to players or to a round, not settings, and are not here. Matched
 * by exact action or by a prefix ending in a dot.
 */
const SETTING_AREAS: [match: string, area: string][] = [
  ["config.set", "server settings"],
  ["server.automation", "the server's setup"], ["server.engagement", "the server's setup"], ["server.streamer_mode", "the server's setup"],
  ["server.public_profile", "the server's setup"], ["server.connection", "the server's setup"], ["server.rename", "the server's setup"],
  ["server.nickname", "the server's setup"], ["server.game", "the server's setup"],
  ["server.add", "the servers"], ["server.delete", "the servers"], ["server.retire", "the servers"], ["server.unretire", "the servers"],
  ["server.decommission", "the servers"], ["server.recommission", "the servers"],
  ["autosettings.", "Auto settings"], ["preset.", "Auto settings"],
  ["seeding.config", "seeding"],
  ["rule.create", "the rules"], ["rule.update", "the rules"], ["rule.delete", "the rules"], ["rule.pause", "the rules"],
  ["rule.resume", "the rules"], ["rule.restore", "the rules"], ["rule.section.", "the rules"], ["trigger.", "the rules"],
  ["chatfilter.", "the chat filter"],
  ["mapvote.config", "the map vote"], ["mapvote.schedule.", "the map vote"], ["mapvote.set.", "the map vote"],
  ["map.rotation.", "the map rotation"],
  ["broadcast.config", "broadcasts"], ["welcome.config", "broadcasts"], ["announcement.nudge_config", "broadcasts"],
  ["discord.relay.config", "Discord"], ["discord.commands.config", "Discord"], ["discord.rolemap.", "Discord"], ["discord.setup", "Discord"],
  ["role.", "roles and permissions"], ["user.roles", "roles and permissions"], ["grant.", "roles and permissions"],
  ["token.", "roles and permissions"], ["user.create", "staff accounts"], ["user.delete", "staff accounts"],
  ["signatures.", "signatures"], ["app.timezone", "the community clock"], ["online.", "online access"],
  ["admincam.config", "the admin camera"], ["gamerewards.config", "game rewards"], ["stats.site", "the stats site"],
  ["economy.manage", "the shop"], ["vip_preset.", "VIP presets"], ["template.", "templates"],
  ["group.create", "player groups"], ["group.update", "player groups"], ["group.delete", "player groups"],
  ["group.perk", "player groups"], ["group.discord_role", "player groups"],
];
const settingArea = (action: string) =>
  SETTING_AREAS.find(([m]) => (m.endsWith(".") ? action.startsWith(m) : action === m))?.[1] ?? null;

/**
 * What changed, for the lock screen: a server setting by the name the settings page gives it and
 * its new value (a long text, such as the welcome message, only as changed), anything else in the
 * trail's own words. The two whose words carry a server's address say what happened without it.
 */
function settingWords(row: AuditRow, game: string | undefined): string {
  const d = (row.data ?? {}) as { field?: unknown; value?: unknown };
  if (row.action === "config.set" && typeof d.field === "string") {
    const label = (game ? getGame(game)?.descriptor.configFields.find((f) => f.field === d.field)?.label : undefined) ?? d.field;
    if (typeof d.value === "boolean") return `${label} is now ${d.value ? "on" : "off"}.`;
    if (typeof d.value === "number") return `${label} is now ${d.value}.`;
    return `${label} was changed.`;
  }
  if (row.action === "server.add") return `Added the server ${short(row.targetName) || "a new server"}.`;
  if (row.action === "server.connection") return `Changed how the panel reaches ${short(row.targetName) || "a server"}.`;
  const words = short(row.summary, 140);
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}${/[.!?…]$/.test(words) ? "" : "."}`;
}

interface Recipient { p: Principal; choices: AlertChoices; devices: PushSubscriptionRow[] }
interface BusEvent { kind?: string; serverId?: string | null; actorPlayerId?: string | null; actorName?: string | null; data?: unknown }
/** One staff ban, as a notification needs it. */
interface BanItem { by: string; serverId: string | null; player: string; perma: boolean; hours: number; reason: string }

/**
 * A run of the same news from one source — a ban list uploaded line by line, a settings page saved
 * five times — told as the first item now, then one count per window while it lasts, so a phone
 * buzzes a few times, not three hundred.
 */
class Runs<T> {
  private readonly open = new Map<string, { items: T[]; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly ms: () => number, private readonly flush: (key: string, items: T[]) => Promise<void>) {}

  /** True for the first of a run, which is told now; the rest wait for the window's count. */
  add(key: string, item: T): boolean {
    const run = this.open.get(key);
    if (run) {
      run.items.push(item);
      return false;
    }
    this.open.set(key, { items: [], timer: this.arm(key) });
    return true;
  }

  private arm(key: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const run = this.open.get(key);
      if (!run) return;
      // A quiet window ends the run; a busy one is told, and the run goes on.
      if (!run.items.length) {
        this.open.delete(key);
        return;
      }
      const items = run.items;
      run.items = [];
      run.timer = this.arm(key);
      background(log, "phone notification", () => this.flush(key, items));
    }, this.ms());
    timer.unref?.();
    return timer;
  }

  stop(): void {
    for (const run of this.open.values()) clearTimeout(run.timer);
    this.open.clear();
  }
}

/** May this person see this server? The rule the server list itself applies. */
const seesServer = (grants: Grant[], serverId: string) =>
  canAnywhere(grants, "admin.users", "read") || can(grants, "server.view", "read", { serverId });
/** May this person read the ban record on this server? The Bans page's own rule. */
const readsBans = (grants: Grant[], serverId: string | null) =>
  serverId ? can(grants, "moderation.bans", "read", { serverId }) : canAnywhere(grants, "moderation.bans", "read");
/** May this person read this row on Staff activity? A server's rows go to whoever may read that
 *  server's; a row that belongs to no server only to someone who may read every server's
 *  (routes/kit serverScope, AuditQuery.includeUnscoped). */
const readsTrail = (grants: Grant[], serverId: string | null, allServerIds: string[]) =>
  serverId ? can(grants, "audit.trail", "read", { serverId }) : allServerIds.every((id) => can(grants, "audit.trail", "read", { serverId: id }));

/** A name as it goes on a lock screen: trimmed, one line, not a paragraph. */
const short = (s: string | null | undefined, max = 60) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export class PhoneAlerts {
  private unsubscribe: (() => void) | null = null;
  private unwatch: (() => void) | null = null;
  private readonly watchSeen = new Map<string, number>();
  private readonly callSeen = new Map<string, number>();
  private readonly seedSeen = new Map<string, number>();
  private readonly cameraSeen = new Map<string, number>();
  private readonly triggers = new Map<string, { at: number; trigger: string }>();
  private readonly decidedSent = new Set<string>();
  private readonly shopGathering = new Map<string, { rows: AuditRow[]; timer: ReturnType<typeof setTimeout> }>();
  private readonly banRuns: Runs<BanItem>;
  private readonly settingRuns: Runs<AuditRow>;

  constructor(private readonly deps: { repo: Repository; bus: EventBus; send?: typeof sendPush; watchCooldownMs?: number; runMs?: number; shopGatherMs?: number }) {
    const runMs = () => this.deps.runMs ?? RUN_MS;
    this.banRuns = new Runs(runMs, (key, items) => this.tellBans(key, items, true));
    this.settingRuns = new Runs(runMs, (_key, rows) => this.tellSetting(rows[0]!, rows.length));
  }

  start(): void {
    this.unsubscribe ??= this.deps.bus.on("*", (e) => background(log, "phone notification", () => this.onEvent(e as BusEvent)));
    this.unwatch ??= this.deps.repo.audit.watch((row) => this.onAudit(row));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unwatch?.();
    this.unwatch = null;
    this.banRuns.stop();
    this.settingRuns.stop();
    for (const g of this.shopGathering.values()) clearTimeout(g.timer);
    this.shopGathering.clear();
  }

  private async onEvent(e: BusEvent): Promise<void> {
    if (e.kind === "evt.player.connected") await this.playerJoined(e);
    else if (e.kind === "app.server.dark" || e.kind === "app.server.recovered") await this.serverHealth(e);
    else if (e.kind === "evt.chat.team" || e.kind === "evt.chat.squad") await this.adminCall(e);
    else if (e.kind === "app.enforcement" || e.kind === "app.seeding.kick") await this.automaticAction(e);
    else if (e.kind === "app.seeding.phase") await this.seedingChange(e);
    else if (e.kind === "evt.admin.camera") await this.cameraUsed(e);
  }

  /**
   * Every row the trail is written in this process comes through here, so this sorts them with
   * nothing but string checks before anything is read: a staff member's ban, a changed setting, a
   * notice posted, a shop purchase. A person did the first three — the app's own work (the
   * automatic rules, a profile applying itself) is told elsewhere or not at all.
   */
  private onAudit(row: AuditRow): void {
    const d = (row.data ?? {}) as Record<string, unknown>;
    const byStaff = Boolean(row.actorUserId);
    if (byStaff && (row.action === "player.tempban" || row.action === "player.permaban")) {
      const item: BanItem = {
        by: short(row.actorName) || "A staff member",
        serverId: row.serverId, player: short(row.targetName) || "a player", perma: row.action === "player.permaban",
        hours: Math.max(0, Math.round(Number(d.hours) || 0)), reason: short(typeof d.reason === "string" ? d.reason : "", 100),
      };
      if (this.banRuns.add(row.actorUserId!, item)) background(log, "phone notification", () => this.tellBans(row.actorUserId!, [item], false));
    } else if (byStaff && settingArea(row.action)) {
      const key = `${row.actorUserId}|${settingArea(row.action)}|${row.serverId ?? ""}`;
      if (this.settingRuns.add(key, row)) background(log, "phone notification", () => this.tellSetting(row, 1));
    } else if (byStaff && (row.action === "announcement.publish" || (row.action === "announcement.create" && d.published === true))) {
      background(log, "phone notification", () => this.noticePosted(row));
    } else if (row.action === "vip.grant" && d.via === "VIP shop" && typeof d.ref === "string") {
      this.shopRow(d.ref, row);
    }
  }

  /**
   * Everyone with a device on, as the panel would see them. A device turned on under an earlier
   * sign-in is dropped here: "sign out everywhere" (or a password change) moves the account to a
   * new epoch, and a lost phone must stop hearing about the community along with its sign-in. The
   * panel turns its own device back on under the new one when it next opens (lib/push syncPush).
   */
  private async recipients(want: AlertSwitch | AlertSwitch[], all?: PushSubscriptionRow[]): Promise<Recipient[]> {
    const wanted = Array.isArray(want) ? want : [want];
    const { repo } = this.deps;
    all ??= await repo.pushSubscriptions.list();
    const byUser = new Map<string, PushSubscriptionRow[]>();
    for (const s of all) byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), s]);
    const out: Recipient[] = [];
    for (const [userId, devices] of byUser) {
      const user = await repo.users.findById(userId);
      const live = devices.filter((d) => user && d.epoch === user.sessionEpoch);
      for (const d of devices) if (!live.includes(d)) await repo.pushSubscriptions.remove(d.endpoint);
      if (!user || !live.length) continue;
      const choices = alertChoices(await repo.users.getPrefs(userId));
      if (!wanted.some((w) => choices[w])) continue;
      out.push({ p: { user, name: displayNameOf(user), ...(await resolveAccess(repo, userId)) }, choices, devices: live });
    }
    return out;
  }

  private async serverName(serverId: string): Promise<string> {
    return short((await this.deps.repo.servers.list({ includeRetired: true })).find((s) => s.id === serverId)?.name) || "A server";
  }

  private async deliver(devices: PushSubscriptionRow[], message: PushMessage, opts: { ttl: number; urgency?: "normal" | "high" }): Promise<void> {
    const keys = await vapidKeys(this.deps.repo);
    const send = this.deps.send ?? sendPush;
    await Promise.all(devices.map(async (d) => {
      const out = await send(d, message, keys, opts);
      // Gone: the browser unsubscribed, or the phone was reset. Nothing will reach it again.
      if (out.outcome === "gone") await this.deps.repo.pushSubscriptions.remove(d.endpoint);
      else if (out.outcome === "failed") log.warn("a phone notification was not accepted", { host: new URL(d.endpoint).host, status: out.status, error: out.error });
    }));
  }

  /** Every connect on every server comes through here, so the cheap questions go first: is any
   *  device on at all, is this a rejoin, is the player watched. */
  private async playerJoined(e: BusEvent): Promise<void> {
    const serverId = e.serverId, playerId = e.actorPlayerId;
    if (!serverId || !playerId) return;
    const all = await this.deps.repo.pushSubscriptions.list();
    if (!all.length) return;
    const key = `${serverId}|${playerId}`;
    const now = Date.now();
    const cooldown = this.deps.watchCooldownMs ?? WATCH_COOLDOWN_MS;
    if ((this.watchSeen.get(key) ?? -Infinity) + cooldown > now) return;
    const flags = await this.deps.repo.playerFlags.get(playerId).catch(() => null);
    if (!flags?.watchlist) return;
    for (const [k, at] of this.watchSeen) if (at + cooldown <= now) this.watchSeen.delete(k);
    this.watchSeen.set(key, now);
    const people = (await this.recipients("watch", all)).filter((r) => canAnywhere(r.p.grants, "player.watchlist", "read") && seesServer(r.p.grants, serverId));
    if (!people.length) return;
    const message: PushMessage = {
      title: "Watched player joined",
      body: `${short(e.actorName) || "A watched player"} joined ${await this.serverName(serverId)}.`,
      url: `/#/players/~${encodeURIComponent(playerId)}`,
      tag: `watch-${playerId}`,
    };
    for (const r of people) await this.deliver(r.devices, message, { ttl: 600, urgency: "high" });
  }

  private async serverHealth(e: BusEvent): Promise<void> {
    const serverId = e.serverId;
    if (!serverId) return;
    const people = (await this.recipients("servers")).filter((r) => seesServer(r.p.grants, serverId));
    if (!people.length) return;
    const minutes = Math.max(1, Math.round(Number((e.data as { minutes?: unknown } | undefined)?.minutes) || 1));
    const name = await this.serverName(serverId);
    const span = `${minutes} minute${minutes === 1 ? "" : "s"}`;
    const dark = e.kind === "app.server.dark";
    // One tag for both, so "back" replaces "stopped answering" on the phone instead of piling up.
    const message: PushMessage = dark
      ? { title: `${name} stopped answering`, body: `No answer for ${span}. Kicks, bans and automatic rules can't reach it until it's back.`, url: "/#/dashboard", tag: `server-${serverId}` }
      : { title: `${name} is back`, body: `It's answering again, after about ${span}.`, url: "/#/dashboard", tag: `server-${serverId}` };
    for (const r of people) await this.deliver(r.devices, message, { ttl: 3600, urgency: dark ? "high" : "normal" });
  }

  /** The server's trigger for a call for an admin: the Discord admin-ping alert's own, "!admin"
   *  unless staff changed it. Every chat line comes through here, so it is kept for a minute. */
  private async triggerFor(serverId: string): Promise<string> {
    const hit = this.triggers.get(serverId);
    if (hit && Date.now() - hit.at < 60_000) return hit.trigger;
    const cfg = await this.deps.repo.discordRelay.getConfig(serverId).catch(() => null);
    const trigger = (cfg?.alerts?.adminPing?.trigger || "!admin").trim().toLowerCase();
    this.triggers.set(serverId, { at: Date.now(), trigger });
    return trigger;
  }

  /** A chat line that STARTS with the trigger — "no need to !admin this" is talk about it, not a
   *  call (the Discord alert's rule). Told with what they wrote, to whoever may see the server and
   *  so read its chat. */
  private async adminCall(e: BusEvent): Promise<void> {
    const serverId = e.serverId;
    if (!serverId) return;
    const message = String((e.data as { message?: unknown } | undefined)?.message ?? "").trim();
    const trigger = await this.triggerFor(serverId);
    if (!trigger || !message.toLowerCase().startsWith(trigger)) return;
    const key = `${serverId}|${e.actorPlayerId ?? e.actorName ?? ""}`;
    const now = Date.now();
    if ((this.callSeen.get(key) ?? -Infinity) + CALL_COOLDOWN_MS > now) return;
    for (const [k, at] of this.callSeen) if (at + CALL_COOLDOWN_MS <= now) this.callSeen.delete(k);
    this.callSeen.set(key, now);
    const people = (await this.recipients("admin")).filter((r) => seesServer(r.p.grants, serverId));
    if (!people.length) return;
    const rest = short(message.slice(trigger.length), 120);
    const note: PushMessage = {
      title: `${short(e.actorName) || "A player"} is asking for an admin`,
      body: `On ${await this.serverName(serverId)}${rest ? `: ${rest}` : "."}`,
      url: "/#/live",
      tag: `admin-${key}`,
    };
    for (const r of people) await this.deliver(r.devices, note, { ttl: 900, urgency: "high" });
  }

  /**
   * The automatic rules removed somebody: a kick or a ban by a rule in Auto settings → Rules
   * (`app.enforcement`, which the Discord "rule fired" alert reads too), or a kick by the seeding
   * rules (`app.seeding.kick`). Warnings and punishes are the rules working quietly and are left
   * out; a dry run or a failed attempt removed nobody. Told to whoever may read that server's
   * automation history.
   */
  private async automaticAction(e: BusEvent): Promise<void> {
    const serverId = e.serverId;
    if (!serverId) return;
    const d = (e.data ?? {}) as { ruleName?: string; action?: string; hours?: number | null; dryRun?: boolean; error?: string | null };
    const bySeeding = e.kind === "app.seeding.kick";
    // "blacklist" is the stored name of a rule's ban: temporary with hours, permanent without.
    const action = bySeeding ? "kick" : d.action === "blacklist" ? (d.hours ? "tempban" : "permaban") : d.action;
    if ((action !== "kick" && action !== "tempban" && action !== "permaban") || d.dryRun || d.error) return;
    // A ban for good is news too to whoever picked permanent bans and may read the ban record —
    // told once, whichever of the two choices brought it.
    const people = (await this.recipients(["automod", "permabans"])).filter((r) =>
      (r.choices.automod && AUTOMATION_CAPS.some((c) => can(r.p.grants, c, "read", { serverId })))
      || (r.choices.permabans && action === "permaban" && readsBans(r.p.grants, serverId)));
    if (!people.length) return;
    const what = action === "kick" ? "was kicked" : action === "tempban" && d.hours ? `was banned for ${d.hours}h` : action === "permaban" ? "was banned for good" : "was banned";
    const by = bySeeding ? "the seeding rules" : d.ruleName ? `the rule “${short(d.ruleName, 40)}”` : "an automatic rule";
    const note: PushMessage = {
      title: `${short(e.actorName) || "A player"} ${what}`,
      body: `On ${await this.serverName(serverId)}, by ${by}.`,
      url: "/#/autosettings/history",
      tag: `auto-${serverId}-${short(e.actorName)}-${action}`,
    };
    for (const r of people) {
      // A tap goes where they may look: the automation history, or the ban record for someone told
      // only because it was a ban for good.
      const history = AUTOMATION_CAPS.some((c) => can(r.p.grants, c, "read", { serverId }));
      await this.deliver(r.devices, history ? note : { ...note, url: "/#/moderation/bans" }, { ttl: 3600, urgency: "normal" });
    }
  }

  /**
   * A server's seeding moved on (the seeding worker's `app.seeding.phase`, sent for real changes
   * only, never for a restart finding its feet): it started seeding, or fell back to seeding, and
   * needs players; or it reached the seed target and is live. A server emptying out is no news.
   * Once per change per server within SEED_COOLDOWN_MS, however a slow seed wavers.
   */
  private async seedingChange(e: BusEvent): Promise<void> {
    const serverId = e.serverId;
    if (!serverId) return;
    const d = (e.data ?? {}) as { from?: string; to?: string; count?: number; target?: number };
    if (d.to !== "seeding" && !(d.to === "live" && d.from === "seeding")) return;
    const key = `${serverId}|${d.to}`;
    const now = Date.now();
    if ((this.seedSeen.get(key) ?? -Infinity) + SEED_COOLDOWN_MS > now) return;
    this.seedSeen.set(key, now);
    const people = (await this.recipients("seeding")).filter((r) => seesServer(r.p.grants, serverId));
    if (!people.length) return;
    const name = await this.serverName(serverId);
    const count = Math.max(0, Math.round(Number(d.count) || 0));
    const target = Math.max(0, Math.round(Number(d.target) || 0));
    const note: PushMessage = d.to === "live"
      ? { title: `${name} is live`, body: `It reached ${count} players.`, url: "/#/live", tag: `seeding-${serverId}` }
      : {
        title: `${name} needs players`,
        body: d.from === "live"
          ? `It dropped to ${count} players, under the ${target} it takes to be live.`
          : `Seeding has started: ${count} players on, and it goes live at ${target}.`,
        url: "/#/live", tag: `seeding-${serverId}`,
      };
    for (const r of people) await this.deliver(r.devices, note, { ttl: 1800, urgency: "normal" });
  }

  /**
   * Staff bans: told to whoever may read the ban record on its server and picked either staff bans
   * — every staff member's, or only those by someone holding a role they picked, on that server —
   * or permanent bans, if it is one. Never to the one who banned. The first of a run is told as
   * itself, the rest as one count per window (Runs).
   */
  private async tellBans(actorUserId: string, items: BanItem[], more: boolean): Promise<void> {
    const people = (await this.recipients(["bans", "permabans"])).filter((r) => r.p.user.id !== actorUserId);
    if (!people.length) return;
    const held = await this.deps.repo.userRoles.listByUser(actorUserId);
    const names = new Map((await this.deps.repo.servers.list({ includeRetired: true })).map((s) => [s.id, short(s.name)]));
    const by = items[0]!.by;
    for (const r of people) {
      const { bans, permabans, banRoles } = r.choices;
      // A role held on one server is the role they acted under there, and nowhere else.
      const byRole = (it: BanItem) => !banRoles.length || held.some((a) => banRoles.includes(a.roleId) && (a.scopeId === null || a.scopeId === it.serverId));
      const theirs = items.filter((it) => ((bans && byRole(it)) || (permabans && it.perma)) && readsBans(r.p.grants, it.serverId));
      if (!theirs.length) continue;
      const where = (it: BanItem) => (it.serverId ? names.get(it.serverId) ?? "a server" : "every server");
      let note: PushMessage;
      if (!more || theirs.length === 1) {
        const it = theirs[0]!;
        note = {
          title: `${by} banned ${it.player}`,
          body: `${it.perma ? "For good" : `For ${it.hours}h`}, on ${where(it)}${it.reason ? `: ${it.reason}` : "."}`,
          url: "/#/moderation/bans", tag: `bans-${actorUserId}`,
        };
      } else {
        const players = theirs.slice(0, 3).map((it) => it.player).join(", ");
        const servers = [...new Set(theirs.map(where))].join(", ");
        note = {
          title: `${by} banned ${theirs.length} more player${theirs.length === 1 ? "" : "s"}`,
          body: `${players}${theirs.length > 3 ? ` and ${theirs.length - 3} more` : ""}, on ${servers}.`,
          url: "/#/moderation/bans", tag: `bans-${actorUserId}`,
        };
      }
      await this.deliver(r.devices, note, { ttl: 3600, urgency: "normal" });
    }
  }

  /**
   * A staff member changed a setting: told to whoever picked it and may read that change on Staff
   * activity, which is where a tap goes. Never to the one who changed it. The first change of a run
   * (one person, one area, one server) is told in the trail's own words — a server setting by its
   * name and new value — and the rest of the run as a count.
   */
  private async tellSetting(row: AuditRow, count: number): Promise<void> {
    const people = (await this.recipients("settings")).filter((r) => r.p.user.id !== row.actorUserId);
    if (!people.length) return;
    const servers = await this.deps.repo.servers.list({ includeRetired: true });
    const allIds = servers.map((s) => s.id);
    const area = settingArea(row.action) ?? "a setting";
    const server = row.serverId ? servers.find((s) => s.id === row.serverId) : undefined;
    // A server added, retired or removed is the news itself: "On Bravo: Retired Bravo" says it twice.
    const lead = server && area !== "the servers" ? `On ${short(server.name)}: ` : "";
    const note: PushMessage = {
      title: `${short(row.actorName) || "A staff member"} changed ${area}${count > 1 ? " again" : ""}`,
      body: count > 1 ? `${lead}${count} more change${count === 1 ? "" : "s"}.` : `${lead}${settingWords(row, server?.game)}`,
      url: "/#/admin/activity",
      tag: `setting-${row.actorUserId}-${area}-${row.serverId ?? ""}`,
    };
    for (const r of people) {
      if (!readsTrail(r.p.grants, row.serverId, allIds)) continue;
      await this.deliver(r.devices, note, { ttl: 3600, urgency: "normal" });
    }
  }

  /** A notice posted on the staff board, which every staff member may read: told to whoever picked
   *  it, but not to its author. */
  private async noticePosted(row: AuditRow): Promise<void> {
    const people = (await this.recipients("notices")).filter((r) => r.p.user.id !== row.actorUserId);
    const note: PushMessage = {
      title: `New notice from ${short(row.actorName) || "staff"}`,
      body: short(row.targetName, 120) || "Open the board to read it.",
      url: "/#/announcements",
      tag: `notice-${row.targetId ?? row.id}`,
    };
    for (const r of people) await this.deliver(r.devices, note, { ttl: 12 * 3600, urgency: "normal" });
  }

  /**
   * An admin went into the admin camera (the game log's camera line, entering): told to whoever
   * picked it and may read that server's camera log. Once a visit: in and out again within
   * CAMERA_COOLDOWN_MS is the same visit.
   */
  private async cameraUsed(e: BusEvent): Promise<void> {
    const serverId = e.serverId;
    if (!serverId || (e.data as { entered?: unknown } | undefined)?.entered !== true) return;
    const key = `${serverId}|${e.actorPlayerId ?? e.actorName ?? ""}`;
    const now = Date.now();
    if ((this.cameraSeen.get(key) ?? -Infinity) + CAMERA_COOLDOWN_MS > now) return;
    for (const [k, at] of this.cameraSeen) if (at + CAMERA_COOLDOWN_MS <= now) this.cameraSeen.delete(k);
    this.cameraSeen.set(key, now);
    const people = (await this.recipients("camera")).filter((r) => can(r.p.grants, "server.admins", "read", { serverId }));
    if (!people.length) return;
    const note: PushMessage = {
      title: `${short(e.actorName) || "An admin"} is in the admin camera`,
      body: `On ${await this.serverName(serverId)}.`,
      url: "/#/history/admincam",
      tag: `camera-${key}`,
    };
    for (const r of people) await this.deliver(r.devices, note, { ttl: 900, urgency: "normal" });
  }

  /** A shop purchase lands one server at a time, a VIP row each (shop.ts grantDays): its rows are
   *  gathered by the purchase's ref and told as one. */
  private shopRow(ref: string, row: AuditRow): void {
    const open = this.shopGathering.get(ref);
    if (open) {
      open.rows.push(row);
      return;
    }
    const timer = setTimeout(() => {
      const rows = this.shopGathering.get(ref)?.rows ?? [];
      this.shopGathering.delete(ref);
      background(log, "phone notification", () => this.tellShop(rows));
    }, this.deps.shopGatherMs ?? SHOP_GATHER_MS);
    timer.unref?.();
    this.shopGathering.set(ref, { rows: [row], timer });
  }

  /** What a purchase bought, and for whom: told to whoever picked it and may read members' balances. */
  private async tellShop(rows: AuditRow[]): Promise<void> {
    const first = rows[0];
    if (!first) return;
    const people = (await this.recipients("shop")).filter((r) => canAnywhere(r.p.grants, "economy.balances", "read"));
    if (!people.length) return;
    const d = (first.data ?? {}) as { buyer?: unknown; days?: unknown };
    const days = Math.max(0, Math.round(Number(d.days) || 0));
    const player = short(first.targetName) || "a player";
    const buyer = typeof d.buyer === "string" ? short(d.buyer) : "";
    const names = new Map((await this.deps.repo.servers.list({ includeRetired: true })).map((s) => [s.id, short(s.name)]));
    const servers = [...new Set(rows.map((r) => (r.serverId ? names.get(r.serverId) : undefined)).filter((n): n is string => Boolean(n)))];
    const what = `${days} day${days === 1 ? "" : "s"} of VIP`;
    const note: PushMessage = {
      title: buyer ? `${buyer} bought ${what}` : `${player} got ${what} from the shop`,
      body: `${buyer ? `For ${player}, on` : "On"} ${servers.join(", ") || "a server"}.`,
      url: "/#/players/economy",
      tag: `shop-${first.id}`,
    };
    for (const r of people) await this.deliver(r.devices, note, { ttl: 3600, urgency: "normal" });
  }

  /**
   * A request was filed (approval-cards postApprovalCard, which every filing goes through): tell
   * whoever could sign one of its lines. The queue's rule — routes/approvals annotateLine — minus
   * the deadline, which a request just filed is nowhere near.
   */
  async requestFiled(requestId: string): Promise<void> {
    const { repo } = this.deps;
    const people = await this.recipients("requests");
    if (!people.length) return;
    const r = await repo.approvals.get(requestId);
    if (!r || r.status !== "open") return;
    const pending = r.lines.filter((l) => l.state === "pending");
    const servers = new Map((await repo.servers.list({ includeRetired: true })).map((s) => [s.id, s.name]));
    for (const person of people) {
      if (person.p.user.id === r.requesterUserId) continue;
      const theirs: ApprovalLineRow[] = [];
      for (const l of pending) {
        if (approvalRefusal({ userId: person.p.user.id, grants: person.p.grants }, l.capability, l.serverId)) continue;
        if (!(await signerCoverage({ repo }, person.p, l)).progress) continue;
        theirs.push(l);
      }
      if (!theirs.length) continue;
      const more = theirs.length > 1 ? ` (and ${theirs.length - 1} more)` : "";
      await this.deliver(person.devices, {
        title: "A request needs your approval",
        body: `${short(r.requesterName) || "Someone"} asks for: ${lineWords(theirs[0]!, servers)}${more}.`,
        url: "/#/moderation/requests",
        tag: `request-${r.id}`,
      }, { ttl: 12 * 3600, urgency: "high" });
    }
  }

  /**
   * A request has been decided, every line of it (approval-cards updateApprovalCard, which every
   * decision goes through, in the panel or in Discord): tell whoever filed it, once. A withdrawn
   * or expired request was nobody's decision, and one still open is not decided yet.
   */
  async requestDecided(requestId: string): Promise<void> {
    if (this.decidedSent.has(requestId)) return;
    const { repo } = this.deps;
    const r = await repo.approvals.get(requestId);
    // Asked again after the read: the last two lines decided together both come through here.
    if (!r || r.status !== "resolved" || this.decidedSent.has(requestId)) return;
    if (this.decidedSent.size > 2000) this.decidedSent.clear();
    this.decidedSent.add(requestId);
    const them = (await this.recipients("decided")).find((x) => x.p.user.id === r.requesterUserId);
    if (!them) return;
    // A line they carried out under their own permissions (a request built with some of each) was
    // nobody's decision but theirs.
    const decided = r.lines.filter((l) => l.decidedByUserId !== r.requesterUserId);
    const yes = decided.filter((l) => l.state === "approved" || l.state === "executed");
    const no = decided.filter((l) => l.state === "denied");
    if (!yes.length && !no.length) return;
    const servers = new Map((await repo.servers.list({ includeRetired: true })).map((s) => [s.id, s.name]));
    const by = [...new Set([...yes, ...no].map((l) => l.decidedByName).filter((n): n is string => Boolean(n)))];
    const first = (yes[0] ?? no[0])!;
    const what = yes.length && no.length
      ? `${yes.length} approved, ${no.length} denied`
      : `${lineWords(first, servers)}${yes.length + no.length > 1 ? ` (and ${yes.length + no.length - 1} more)` : ""}`;
    await this.deliver(them.devices, {
      title: !no.length ? "Your request was approved" : !yes.length ? "Your request was denied" : "Your request was decided",
      body: `${what}${by.length ? ` — by ${short(by.join(", "))}` : ""}.`,
      url: "/#/moderation/requests",
      tag: `decided-${r.id}`,
    }, { ttl: 12 * 3600, urgency: "normal" });
  }

  /** "Send a test" in Settings: one notification to one of the person's own devices. */
  async test(device: PushSubscriptionRow): Promise<{ ok: true } | { ok: false; error: string }> {
    const keys = await vapidKeys(this.deps.repo);
    const out = await (this.deps.send ?? sendPush)(device, {
      title: "Notifications are on",
      body: "This is a test. From now on, this is how the panel tells you when something needs you.",
      url: "/#/settings",
      tag: "test",
    }, keys, { ttl: 300, urgency: "high" });
    if (out.outcome === "sent") return { ok: true };
    if (out.outcome === "gone") await this.deps.repo.pushSubscriptions.remove(device.endpoint);
    return { ok: false, error: out.outcome === "gone" ? "this device has stopped taking notifications — turn them on again" : `the notification service said no (${out.status ?? out.error})` };
  }
}

/** One line of a request in the few words a notification has: "Temp ban · Bob · 24h · Alpha". */
function lineWords(l: ApprovalLineRow, servers: Map<string, string>): string {
  const what = l.kind === "route" ? String(l.payload.label ?? "a server change") : KIND_WORD[l.kind] ?? l.kind;
  const hours = l.kind === "tempban" || l.kind === "tempban_extend" ? Number(l.payload.hours) || 0 : 0;
  return [what, short(l.playerName), hours ? `${hours}h` : "", l.serverId ? short(servers.get(l.serverId)) : ""].filter(Boolean).join(" · ");
}
