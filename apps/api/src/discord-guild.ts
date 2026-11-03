/**
 * Which Discord server a role id belongs to — the question nothing used to ask.
 *
 * A community is usually two servers: the STAFF one that decides who may sign in
 * (DISCORD_GUILD_ID), and the PUBLIC one everybody joins, where the VIP panel lives. Role ids are
 * per-server, so an id picked out of one is meaningless in the other.
 *
 * That matters because `communityGuildId` is optional and falls back to the staff server when it is
 * blank — correct for a one-server community, and a silent trap for a two-server one. The claim
 * gate picker then offers STAFF roles, the gate is saved against a staff role id, the VIP panel is
 * pressed in the public server where the member's roles are public ids, and nothing ever matches.
 * The button simply is not there, for everyone, forever, with no error anywhere: hiding a claim the
 * presser cannot make is the designed behaviour, so the accident wears the same face as the rule.
 *
 * So the fallback stops being invisible. Callers learn they got the staff server instead of the
 * public one (`fellBack`), and a gate can be checked against the roles that actually exist where it
 * will be read.
 */
import type { Repository } from "@app/db";
import { discordAuthConfig } from "./discord-auth.js";
import { discordRest, type DiscordLane } from "@app/shared";
// The member-LIST read lives in @app/shared, because the worker's role sweep needs the same one.
// Re-exported here so every existing caller keeps importing guild things from one place.
export { guildMembers, type GuildMemberLite, type GuildMemberList } from "@app/shared";

const API = "https://discord.com/api/v10";

export interface CommunityGuild {
  /** The server the VIP panel runs in — empty when neither is configured. */
  guildId: string;
  /** True when `communityGuildId` is blank and this is the STAFF server standing in for it. */
  fellBack: boolean;
}

/** The server the public-facing modules run in, and whether it is really the staff one. */
export async function communityGuild(repo: Repository): Promise<CommunityGuild> {
  const configured = (await repo.appConfig.get()).communityGuildId || "";
  if (configured) return { guildId: configured, fellBack: false };
  const staff = discordAuthConfig().guildId || process.env.DISCORD_GUILD_ID || "";
  return { guildId: staff, fellBack: Boolean(staff) };
}

/**
 * Every role id that exists in a guild, or null when we could not find out.
 *
 * Null is not "no roles" and callers must not treat it as one: no bot token, Discord down, the bot
 * not in that server. A check built on this refuses only what it can positively disprove, so an
 * outage can never block staff from saving their settings.
 */
export async function guildRoleIds(guildId: string, fetchImpl: typeof fetch = fetch): Promise<Set<string> | null> {
  const roles = await guildRoles(guildId, fetchImpl);
  return roles && new Set(roles.map((role) => role.id));
}

/** The guild's roles as id + name, or null when we could not find out (same rule as above). */
export async function guildRoles(guildId: string, fetchImpl: typeof fetch = fetch): Promise<{ id: string; name: string }[] | null> {
  const token = process.env.DISCORD_TOKEN;
  if (!token || !guildId) return null;
  try {
    const r = fetchImpl === fetch
      ? await discordRest().request({ routeKey: `GET /guilds/${guildId}/roles`, path: `/guilds/${guildId}/roles` })
      : await fetchImpl(`${API}/guilds/${guildId}/roles`, { headers: { authorization: `Bot ${token}` } });
    if (!r.ok) return null;
    const roles = (await r.json()) as { id?: unknown; name?: unknown }[];
    if (!Array.isArray(roles)) return null;
    return roles.map((role) => ({ id: String(role.id ?? ""), name: String(role.name ?? "") })).filter((role) => role.id);
  } catch {
    return null;
  }
}

/**
 * One member of a guild, as Discord sees them right now.
 *
 * Three outcomes, kept apart because they mean different things to whoever is asking: the member and
 * their roles; "notInGuild" (Discord answered, they are not there); "unavailable" (we could not ask
 * — no token, an outage, the bot not in that server, or the Server Members intent switched off).
 * Collapsing the last two would turn "I could not check" into "they hold nothing", which is the
 * exact mistake that makes a role gate look broken.
 */
export type GuildMember =
  | { kind: "member"; userId: string; name: string; roleIds: string[] }
  | { kind: "notInGuild" }
  | { kind: "unavailable"; reason: string };

export async function guildMember(
  guildId: string,
  userId: string,
  fetchImpl: typeof fetch = fetch,
  /** "background" for sweeps (badges, role re-sync): they yield to anything a person is waiting on. */
  lane: DiscordLane = "interactive",
): Promise<GuildMember> {
  const token = process.env.DISCORD_TOKEN;
  if (!token) return { kind: "unavailable", reason: "no bot token is set (Discord → Setup & status)" };
  if (!guildId) return { kind: "unavailable", reason: "no Discord server is configured" };
  try {
    // Through the shared limiter: member reads are the highest-volume call the app makes, and the
    // sweeps that drive them must never be what stops a registration going through.
    const r = fetchImpl === fetch
      ? await discordRest().request({ routeKey: `GET /guilds/${guildId}/members`, path: `/guilds/${guildId}/members/${userId}`, lane })
      : await fetchImpl(`${API}/guilds/${guildId}/members/${userId}`, { headers: { authorization: `Bot ${token}` } });
    if (r.status === 404) return { kind: "notInGuild" };
    if (!r.ok) {
      const hint = r.status === 403 ? " — is the bot in that server, with the Server Members intent on?" : "";
      return { kind: "unavailable", reason: `Discord returned ${r.status}${hint}` };
    }
    const m = (await r.json()) as { roles?: unknown; nick?: unknown; user?: { username?: unknown; global_name?: unknown } };
    const roleIds = Array.isArray(m.roles) ? m.roles.map(String) : [];
    const name = String(m.nick || m.user?.global_name || m.user?.username || userId);
    return { kind: "member", userId, name, roleIds };
  } catch (err) {
    return { kind: "unavailable", reason: (err as Error).message };
  }
}
