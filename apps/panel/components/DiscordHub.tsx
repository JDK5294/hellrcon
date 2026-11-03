"use client";
/**
 * Discord control center — the single home for everything Discord, which is an optional integration
 * layered on top of the core (never native to it). Tabs:
 *   • Setup & status  — the Discord app's settings, set here, and which features they unlock (all OFF until set)
 *   • Relay & alerts  — everything the bot POSTS: per-server event→channel routing, ping alerts,
 *                       and the instance-wide unread-notice nudge for the staff noticeboard. They
 *                       are one tab because they are one decision — which channel, and what makes
 *                       the bot write in it — even though they are gated separately.
 *   • Sign-in & roles — OAuth login status + Discord-role → panel-role mapping
 * Each tab is gated by the capability it needs, so a user only sees the parts they can use: the
 * setup on discord.setup (carved off user & role admin), the role mapping on admin.users.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { suggestedCallback } from "../lib/discordCallback";
import { useToast } from "../lib/feedback";
import { ActionResult, AskNotice, Callout, Divider, Hub, RoleChips, SettingSwitch, SkeletonLines, SkeletonRows, type GuildRole, type HubTab, Explanation } from "./ui";
import { PanelGroup, Panel } from "./Panel";
import { RelayAlertsPanel } from "./Discord";
import { useServers } from "../lib/servers";
import { ServerScopeChips, describeScopes } from "./ServerScopeChips";

/**
 * Which tab you SEE is the read grant; what you can change on it is the write grant. They were the
 * same check here — every tab gated on write — while lib/routes.ts gated the sidebar's sub-nav on
 * read, so a read-only holder was offered these tabs in the sidebar and then bounced off them.
 */
export default function DiscordHub({ canServerConfig, canServerConfigView, canAdminUsers, canAdminUsersView, canDiscordSetup = false, canCommunity = false, canCommunityView = false }: {
  canServerConfig: boolean; canServerConfigView?: boolean;
  canAdminUsers: boolean; canAdminUsersView?: boolean;
  /** discord.setup — the bot, sign-in settings, slash command and the community Discord settings. */
  canDiscordSetup?: boolean;
  canCommunity?: boolean; canCommunityView?: boolean;
}) {
  const seeAdmin = canAdminUsersView ?? canAdminUsers;
  const seeRelay = (canServerConfigView ?? canServerConfig) || (canCommunityView ?? canCommunity);
  const tabs: HubTab[] = [
    { id: "setup", label: "Setup & status", show: canDiscordSetup, render: () => <DiscordSetup canManage={canDiscordSetup} /> },
    // Either capability opens the tab, and each panel inside it checks its own — the relay needs
    // discord.config, the noticeboard nudge needs community.edit.
    { id: "relay", label: "Relay & alerts", show: seeRelay, render: () => <RelayAlertsPanel canManage={canServerConfig} canCommunity={canCommunity} /> },
    { id: "signin", label: "Sign-in & roles", show: seeAdmin, render: () => <SignInRolesPanel canManage={canAdminUsers} /> },
  ];
  // "Announcements" was its own tab until the nudge moved in beside the relay; a bookmark or a
  // remembered tab pointing at it lands where it went.
  return <Hub routeId="discord" tabs={tabs} renamedTabs={{ announcements: "relay" }} />;
}

/* ---------------- Setup & status ---------------- */

/** Every field is optional here on purpose — see the read-defensively note in DiscordSetup. */
interface SetupResp {
  pieces?: Record<string, boolean>;
  values?: { guildId: string | null; redirectUri: string | null; clientId: string | null; appId?: string | null; publicKey?: string | null; communityGuildId?: string | null };
  features?: Record<string, boolean>;
}
/** The Discord app's settings, in the order the Developer Portal shows them. Secrets are never sent back. */
const PIECE_HELP: { key: string; label: string; secret: boolean; how: string; placeholder?: string }[] = [
  { key: "botToken", label: "Bot token", secret: true, how: "Developer Portal → your app → Bot → Reset Token. Powers the relay, alerts, the role list and role sync." },
  { key: "appId", label: "Application id", secret: false, how: "Developer Portal → General Information → Application ID. Needed to register the slash command." },
  { key: "publicKey", label: "Public key", secret: false, how: "Developer Portal → General Information → Public Key. Proves a slash-command press came from Discord." },
  { key: "clientId", label: "OAuth client id", secret: false, how: "Developer Portal → OAuth2 → Client ID." },
  { key: "clientSecret", label: "OAuth client secret", secret: true, how: "Developer Portal → OAuth2 → Reset Secret." },
  { key: "guildId", label: "Staff server id", secret: false, how: "In Discord with Developer Mode on: right-click your staff server → Copy Server ID." },
  { key: "redirectUri", label: "Sign-in return address", secret: false, how: "Add the same address in the Developer Portal under OAuth2 → Redirects.", placeholder: "https://panel.example.com/api/auth/discord/callback" },
];
const FEATURE_LABEL: Record<string, string> = {
  relay: "Event relay & alerts",
  interactions: "Slash command (inbound)",
  signIn: "Sign in with Discord",
  roleSync: "Background role re-sync",
  commandRegistration: "Slash-command registration (the Register button below)",
};

function DiscordSetup({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<SetupResp | null>(null);
  const [err, setErr] = useState("");
  // What has been typed, field by field; a field not in here is unchanged. "" clears.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const [saveErr, setSaveErr] = useState("");
  useEffect(() => { api<SetupResp>("/discord/setup").then(setData).catch((e) => setErr(e.message)); }, []);

  if (err) return <div className="card"><ActionResult error={err} /></div>;
  if (!data) return <div className="card"><SkeletonLines lines={4} /></div>;

  // Read defensively. This is a status readout, and a status readout that white-screens the entire
  // panel because one key was absent is worse than one that says "nothing is set up".
  const pieces = data.pieces ?? {};
  const features = data.features ?? {};
  const values = (data.values ?? {}) as Record<string, string | null>;
  const anyFeature = Object.values(features).some(Boolean);
  const dirty = Object.keys(draft).length > 0;
  const ownCallback = typeof window === "undefined" ? "" : suggestedCallback(window.location);

  async function save() {
    setBusy(true);
    setSaved("");
    setSaveErr("");
    try {
      const r = await api<SetupResp>("/discord/setup", { method: "PUT", body: draft });
      setData(r);
      setDraft({});
      setSaved("Saved. The panel uses it now; the bot and the background worker within half a minute.");
    } catch (e) {
      setSaveErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const edit = (key: string, value: string | undefined) => setDraft((d) => {
    const next = { ...d };
    if (value === undefined) delete next[key];
    else next[key] = value;
    return next;
  });

  return (
    <PanelGroup viewId="discord-setup">
      <Panel id="setup" caps="open" title="Setup &amp; status">
      {anyFeature ? (
        <Callout variant="info">Some Discord features are active. Each still requires its own per-server opt-in (relay, alerts, and map vote are off until enabled on a server).</Callout>
      ) : (
        <Callout variant="warn">Discord is <strong>completely off</strong> — nothing is set yet, so nothing posts, syncs, or authenticates. Fill in the pieces below to enable individual features.</Callout>
      )}

      <div className="drm-list" style={{ marginTop: 10 }}>
        {PIECE_HELP.map((p) => {
          const set = pieces[p.key];
          const typed = draft[p.key];
          const clearing = typed === "" && (p.secret ? set : Boolean(values[p.key]));
          return (
            <div key={p.key} className="setup-row">
              <span className={`setup-dot ${set ? "on" : "off"}`} aria-hidden>{set ? "✓" : "○"}</span>
              <div className="grow">
                <div className="setup-label">{p.label} {set ? <span className="badge active">set</span> : <span className="badge">not set</span>}{clearing && <span className="badge warn-badge">removed on save</span>}</div>
                {p.secret ? (
                  <div className="row" style={{ gap: 6, alignItems: "center" }}>
                    <input type="password" aria-label={p.label} value={typed ?? ""} disabled={!canManage} autoComplete="off" spellCheck={false}
                      placeholder={set ? "saved — leave blank to keep it" : "paste it here"}
                      onChange={(e) => edit(p.key, e.target.value || undefined)} />
                    {set && canManage && typed === undefined && <button className="ghost mini" onClick={() => edit(p.key, "")}>Remove</button>}
                    {clearing && <button className="ghost mini" onClick={() => edit(p.key, undefined)}>Keep it</button>}
                  </div>
                ) : (
                  <div className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <input aria-label={p.label} value={typed ?? values[p.key] ?? ""} disabled={!canManage} autoComplete="off" spellCheck={false} placeholder={p.placeholder}
                      onChange={(e) => edit(p.key, e.target.value === (values[p.key] ?? "") ? undefined : e.target.value)} />
                    {p.key === "redirectUri" && canManage && ownCallback && (typed ?? values[p.key]) !== ownCallback && (
                      <button className="ghost mini" onClick={() => edit(p.key, ownCallback === (values[p.key] ?? "") ? undefined : ownCallback)}>Use this panel&apos;s address</button>
                    )}
                  </div>
                )}
                <div className="muted fs-xs">{p.how}</div>
              </div>
            </div>
          );
        })}
      </div>
      {canManage && (
        <div className="actions">
          <button className="primary" onClick={save} disabled={busy || !dirty}>{busy ? "Saving…" : "Save"}</button>
          {dirty && <button className="ghost" onClick={() => setDraft({})} disabled={busy}>Undo changes</button>}
        </div>
      )}
      <ActionResult ok={saved} error={saveErr} />

      <Divider label="Features unlocked" />
      <div className="drm-list">
        {Object.entries(features).map(([k, on]) => (
          <div key={k} className="setup-row">
            <span className={`setup-dot ${on ? "on" : "off"}`} aria-hidden>{on ? "✓" : "○"}</span>
            <div className="setup-label">{FEATURE_LABEL[k] ?? k} {on ? <span className="badge active">available</span> : <span className="badge">unavailable</span>}</div>
          </div>
        ))}
      </div>
      <Explanation>
        <p className="mt-0">Turn on the <strong>Server Members</strong> privileged intent for the bot (Developer Portal → Bot) so it can read roles for the mapping and the sync.</p>
        <p>For the slash command, set the app&apos;s <strong>Interactions Endpoint URL</strong> (Developer Portal → General Information) to this panel&apos;s address followed by <code>/api/discord/interactions</code>.</p>
        <p>The bot token and the client secret are kept encrypted and never shown again; paste a new one to replace it. Settings an older install kept in infra/.env were carried over here on its first start with this version, and are changed here from now on.</p>
      </Explanation>
      </Panel>
      <PublicServerPanel staffGuildId={values.guildId ?? null} />
      <ApprovalsRelay />
      <CommunityBadgesPanel />
      <SlashCommandPanel />
    </PanelGroup>
  );
}

/* ---------------- The public Discord server ---------------- */

/**
 * MOST COMMUNITIES RUN TWO DISCORDS: a staff server people are invited into, and a public one
 * everybody joins. The app knew about one.
 *
 * DISCORD_GUILD_ID is the STAFF server — it decides who may sign in to the panel and which Discord
 * roles map to panel roles. That is the wrong server to read MEMBER roles from, which is why the
 * claim role picker only ever offered staff roles: it was asking the only guild the app knew about.
 *
 * Set here rather than in the environment because it is a community fact, not a deployment one,
 * and because getting it wrong should be a dropdown away from being right.
 */
function PublicServerPanel({ staffGuildId }: { staffGuildId: string | null }) {
  const toast = useToast();
  const [value, setValue] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [roles, setRoles] = useState<{ count: number; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [readErr, setReadErr] = useState("");

  const loadRoles = () => {
    api<{ roles?: unknown[]; error?: string }>("/discord/roles?guild=community")
      .then((r) => setRoles({ count: (r.roles ?? []).length, error: r.error }))
      .catch((e) => setRoles({ count: 0, error: (e as Error).message }));
  };
  useEffect(() => {
    // A failed read is said, not shown as "not set": blank here means the staff server stands in.
    api<{ config: { communityGuildId?: string } }>("/app-config")
      .then((r) => { setValue(r.config.communityGuildId ?? ""); setDraft(r.config.communityGuildId ?? ""); })
      .catch((e) => setReadErr((e as Error).message));
    loadRoles();
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ config: { communityGuildId?: string } }>("/app-config", { method: "PUT", body: { communityGuildId: draft.trim() } });
      const next = r.config.communityGuildId ?? "";
      setValue(next);
      toast.success(next ? "Public Discord server saved" : "Cleared — the staff server is used for both");
      loadRoles();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };

  if (readErr) return <Panel id="publicguild" caps="open" title="Public Discord server"><ActionResult error={`Couldn't read the saved server: ${readErr}`} /></Panel>;
  if (value === null) return null;
  const usingStaff = !value;
  return (
    <Panel id="publicguild" caps="open" title="Public Discord server">
      <Explanation>
        Where your members are — the server the VIP launcher is posted in, and whose roles gate the claims.
        Leave it blank if you run a single Discord for everyone.
      </Explanation>
      <label className="field">Public server id
        <input value={draft} inputMode="numeric" placeholder={staffGuildId ? `blank = same as staff (${staffGuildId})` : "blank = same as staff"}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))} />
      </label>
      <div className="actions">
        <button className="primary" disabled={busy || draft.trim() === value} onClick={save}>{busy ? "Saving…" : "Save"}</button>
      </div>
      {roles && (roles.error
        ? <Callout variant="warn">Can&apos;t read that server&apos;s roles: {roles.error} The bot has to be a member of the public server too — invite it there.</Callout>
        : <p className="hint">{roles.count} role{roles.count === 1 ? "" : "s"} readable from {usingStaff ? "the staff server" : "the public server"} — these are what the claim gates offer.</p>)}
      <Explanation>
        Discord → Developer Mode on → right-click the server → Copy Server ID. Staff sign-in and the role map always use the <strong>staff</strong> server ({staffGuildId ?? "not set"}).
      </Explanation>
    </Panel>
  );
}

/* ---------------- Approvals relay ---------------- */

/**
 * Where approval requests get posted — OPTIONAL, off while blank. The Requests tab under
 * Moderation is always the source of truth; this pushes each filed request to a Discord channel
 * as a card with Approve/Deny buttons (pressers act through their linked staff account, under
 * exactly the same permission checks as the panel), and the card updates as lines are decided.
 */
function ApprovalsRelay() {
  const toast = useToast();
  const [value, setValue] = useState<{ channelId: string; roleId: string } | null>(null);
  const [draft, setDraft] = useState({ channelId: "", roleId: "" });
  const [busy, setBusy] = useState(false);
  const [readErr, setReadErr] = useState("");

  useEffect(() => {
    // Read failed: no form. Shown blank, a save sends both fields and clears the one not retyped.
    api<{ config: { approvalsChannelId?: string; approvalsMentionRoleId?: string } }>("/app-config")
      .then((r) => {
        const v = { channelId: r.config.approvalsChannelId ?? "", roleId: r.config.approvalsMentionRoleId ?? "" };
        setValue(v); setDraft(v);
      })
      .catch((e) => setReadErr((e as Error).message));
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ config: { approvalsChannelId?: string; approvalsMentionRoleId?: string } }>("/app-config", {
        method: "PUT", body: { approvalsChannelId: draft.channelId.trim(), approvalsMentionRoleId: draft.roleId.trim() },
      });
      const v = { channelId: r.config.approvalsChannelId ?? "", roleId: r.config.approvalsMentionRoleId ?? "" };
      setValue(v); setDraft(v);
      toast.success(v.channelId ? "Approvals relay armed — filed requests post there now" : "Approvals relay off — the Requests tab is the only surface");
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };

  if (readErr) return <Panel id="approvalsrelay" caps="open" title="Approvals relay"><ActionResult error={`Couldn't read the saved relay: ${readErr}`} /></Panel>;
  if (value === null) return null;
  return (
    <Panel id="approvalsrelay" caps="open" title="Approvals relay">
      <Explanation>
        Optional. When set, every approval request staff file (Moderation → Requests) also posts
        here as a card with <strong>Approve all I can</strong> and <strong>Deny…</strong> buttons.
        Button presses act through the presser&apos;s linked staff account with the panel&apos;s own
        permission checks — a button proves nothing by itself. Blank = off; the panel queue always works.
      </Explanation>
      <label className="field">Approvals channel id
        <input value={draft.channelId} inputMode="numeric" placeholder="blank = relay off"
          onChange={(e) => setDraft((d) => ({ ...d, channelId: e.target.value.replace(/[^0-9]/g, "") }))} />
      </label>
      <label className="field">Mention role id (optional)
        <input value={draft.roleId} inputMode="numeric" placeholder="pinged when a request is filed"
          onChange={(e) => setDraft((d) => ({ ...d, roleId: e.target.value.replace(/[^0-9]/g, "") }))} />
      </label>
      <div className="actions">
        <button className="primary" disabled={busy || (draft.channelId === value.channelId && draft.roleId === value.roleId)} onClick={save}>{busy ? "Saving…" : "Save"}</button>
      </div>
      <p className="hint">Needs the bot token (above). Right-click the channel/role with Developer Mode on → Copy ID.</p>
    </Panel>
  );
}

/* ---------------- Community badges ---------------- */

interface RoleBadge { id?: string; emoji: string; label: string; roleIds: string[] }

/**
 * Keep at most two whole emoji, measured by GRAPHEME.
 *
 * `"👨‍👩‍👧‍👦".length` is 11 — an input `maxlength` (or any `.length` check) cuts that in half and
 * leaves an unpaired surrogate, which renders as the hatched box, not as a smaller emoji. The
 * server normalizes again on save; this is so the field never SHOWS the mangled version.
 */
function clampEmoji(raw: string): string {
  const Seg = (Intl as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(x: string): Iterable<{ segment: string }> } }).Segmenter;
  const parts = Seg
    ? [...new Seg(undefined, { granularity: "grapheme" }).segment(raw)].map((g) => g.segment)
    : Array.from(raw); // older Safari: code points, still never mid-surrogate
  return parts.slice(0, 2).join("");
}

/**
 * Discord roles → an emoji beside the player, everywhere the VIP star already shows (the live
 * roster's marks, the profile's status chips).
 *
 * Exists because Vietnam has no clan tags: "is this one of ours?" cannot be read off a name, but
 * the community Discord already knows, and members link their game account through the VIP panel.
 * A badge is DERIVED, like the star — it appears with the role and disappears with it; nobody
 * sets it on a player, so it can never go stale or be forgotten.
 *
 * Several badges, each earned by ANY of its roles; a player can wear several at once.
 */
function CommunityBadgesPanel() {
  const toast = useToast();
  const [badges, setBadges] = useState<RoleBadge[] | null>(null);
  const [roles, setRoles] = useState<GuildRole[]>([]);
  const [rolesNote, setRolesNote] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [readErr, setReadErr] = useState("");

  useEffect(() => {
    // Read failed: no editor. The badges save as one list, so an editor started from "none yet"
    // replaces every badge it never showed.
    api<{ config: { roleBadges?: RoleBadge[] } }>("/app-config")
      .then((r) => setBadges(r.config.roleBadges ?? []))
      .catch((e) => setReadErr((e as Error).message));
    // The COMMUNITY guild's roles — where the members are — not the staff server's.
    api<{ roles?: GuildRole[]; error?: string }>("/discord/roles?guild=community")
      .then((r) => { setRoles(r.roles ?? []); setRolesNote(r.error ?? ""); })
      // Said as what it is: the chips' own fallback sends staff to set up the bot.
      .catch((e) => { setRoles([]); setRolesNote(`Couldn't read the Discord role list: ${(e as Error).message}`); });
  }, []);

  const edit = (i: number, patch: Partial<RoleBadge>) => {
    setBadges((b) => (b ? b.map((x, j) => (j === i ? { ...x, ...patch } : x)) : b));
    setDirty(true);
  };

  const save = async () => {
    if (!badges) return;
    // Half-built rows are refused with a toast rather than a 400 the user has to decode.
    for (const b of badges) {
      if (!b.emoji.trim()) return toast.error("Every badge needs an emoji.");
      if (!b.roleIds.length) return toast.error(`Badge ${b.emoji} has no roles picked — it would never appear on anyone.`);
    }
    setBusy(true);
    try {
      const r = await api<{ config: { roleBadges?: RoleBadge[] } }>("/app-config", { method: "PUT", body: { roleBadges: badges } });
      setBadges(r.config.roleBadges ?? []);
      setDirty(false);
      toast.success("Community badges saved — they appear on the roster within a minute or two.");
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };

  if (readErr) return <Panel id="badges" caps="open" title="Community badges"><ActionResult error={`Couldn't read the saved badges: ${readErr}`} /></Panel>;
  if (badges === null) return <Panel id="badges" caps="open" title="Community badges"><SkeletonLines lines={3} /></Panel>;
  return (
    <Panel id="badges" caps="open" title="Community badges" subtitle={badges.length ? `${badges.length} badge${badges.length === 1 ? "" : "s"}` : "none yet"}>
      <Explanation>
        <p>
          Give members an emoji beside their name — on the live roster&apos;s marks and on their profile,
          like the VIP ★. A badge follows a Discord role in the <strong>public</strong> server: anyone
          holding any of a badge&apos;s roles wears it (once they&apos;ve linked their game account through the
          VIP panel), and it disappears with the role. Handy where the game has no clan tags.
        </p>
        <p>
          Tap the emoji box and use your keyboard&apos;s emoji key — any emoji works, including the
          multi-part ones. On a desktop it is <kbd>Win</kbd>+<kbd>.</kbd> or <kbd>Ctrl</kbd>+<kbd>Cmd</kbd>+<kbd>Space</kbd>.
        </p>
      </Explanation>
      {badges.map((b, i) => (
        <div key={b.id ?? `new-${i}`} className="badge-def">
          <div className="control-row">
            {/* Any emoji, from the device's own keyboard — there is no curated list, because the
                right badge for a community is theirs to choose, not ours to guess at.
                NO maxLength: it counts UTF-16 units, so it silently cut a family emoji (11 units)
                or a flag mid-sequence — and half an emoji is not a smaller emoji, it is the
                hatched .notdef box. The clamp is by grapheme, on the way in. */}
            <label className="inline">Emoji
              <input value={b.emoji} style={{ width: 72, textAlign: "center", fontSize: "1.25rem" }}
                onChange={(e) => edit(i, { emoji: clampEmoji(e.target.value) })}
                placeholder="🙂" aria-label="Badge emoji" />
            </label>
            <label className="inline grow-min">Means
              <input value={b.label} maxLength={60} onChange={(e) => edit(i, { label: e.target.value })}
                placeholder="e.g. Community member" />
            </label>
            <button type="button" className="ghost mini" title="Remove this badge"
              onClick={() => { setBadges((all) => (all ?? []).filter((_, j) => j !== i)); setDirty(true); }}>✕</button>
          </div>
          <RoleChips roles={roles} note={rolesNote} value={b.roleIds}
            onChange={(ids) => edit(i, { roleIds: ids })}
            emptyLabel="pick the role(s) that earn it" someLabel="earned by any of" />
          {/* Exactly how it will look beside a player's name — so a badge that renders as a box on
              this device is visible HERE, before it is saved onto a hundred rows. */}
          <p className="hint badge-preview">
            Shows as <span className="row-marks"><span className="mark badge">{b.emoji || "?"}</span></span>
            {b.label.trim() ? <> beside the name, labelled “{b.label.trim()}”.</> : <> beside the name.</>}
          </p>
        </div>
      ))}
      <div className="actions">
        {badges.length < 20 && (
          <button type="button" className="ghost" onClick={() => { setBadges((all) => [...(all ?? []), { emoji: "", label: "", roleIds: [] }]); setDirty(true); }}>
            + Add badge
          </button>
        )}
        <button type="button" className="primary" disabled={!dirty || busy} onClick={save}>{busy ? "Saving…" : "Save badges"}</button>
      </div>
    </Panel>
  );
}

/* ---------------- The slash command ---------------- */

interface CommandConfig { name: string; description: string; enabled: boolean }
interface CommandResp {
  config: CommandConfig; canRegister: boolean;
  guildId: string | null; canCheckRoles: boolean; mappedRoles: number;
}

/**
 * What the bot's ONE command is called. Everything the bot can do is a button inside the panel
 * that command opens, so this screen is short on purpose — there is no list to grow.
 *
 * Saving and registering are deliberately two buttons: saving changes what this app answers to,
 * registering changes what Discord shows people, and only the second one talks to Discord.
 */
function SlashCommandPanel() {
  const toast = useToast();
  const [data, setData] = useState<CommandResp | null>(null);
  const [draft, setDraft] = useState<CommandConfig | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "register">("");
  const [registered, setRegistered] = useState("");

  function load() {
    api<CommandResp>("/discord/commands").then((d) => { setData(d); setDraft(d.config); }).catch((e) => setErr(e.message));
  }
  useEffect(load, []);

  if (err && !data) return <Panel id="commands" caps="open" title="Slash command"><ActionResult error={err} /></Panel>;
  if (!data || !draft) return <Panel id="commands" caps="open" title="Slash command"><SkeletonLines lines={3} /></Panel>;

  const patch = (p: Partial<CommandConfig>) => setDraft({ ...draft, ...p });
  // The saved config is what the bot ANSWERS to; the panel can't know what Discord currently
  // shows, so an unsaved edit is the one case where we can say for certain that Register is stale.
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.config);

  async function save() {
    if (!draft) return;
    setBusy("save"); setErr(""); setRegistered("");
    try {
      const r = await api<{ config: CommandConfig }>("/discord/commands", { method: "PUT", body: draft });
      setData((d) => (d ? { ...d, config: r.config } : d));
      setDraft(r.config);
      toast.success("Saved — press Register command to install the change in Discord.");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  }

  async function register() {
    setBusy("register"); setErr(""); setRegistered("");
    try {
      const r = await api<{ registered: string[] }>("/discord/commands/register", { method: "POST" });
      setRegistered(r.registered.length
        ? `Installed /${r.registered[0]} in every server the bot is in. Discord can take up to an hour to show a change everywhere.`
        : "The command is switched off, so Discord now has none.");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  }

  return (
    <Panel id="commands" caps="open" title="Slash command">
      <Explanation>
        The bot has <strong>one</strong> command — everything it can do is a button inside the panel it opens, shown only to people whose permissions allow it. Rename it here; nothing reaches Discord until you press <strong>Register command</strong>.
      </Explanation>
      <SettingSwitch label={`/${draft.name}`} checked={draft.enabled} onChange={(v) => patch({ enabled: v })}
        hint="Whoever runs it gets their own ephemeral panel. Off removes it from Discord on the next register — public members press the posted VIP launcher instead, so they never need a command.">
        <label className="num">name
          <input value={draft.name} maxLength={32} spellCheck={false}
            onChange={(e) => patch({ name: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })} />
        </label>
        <label className="num wide">description
          <input value={draft.description} maxLength={100} onChange={(e) => patch({ description: e.target.value })} />
        </label>
      </SettingSwitch>
      <Divider label="Who may open it" />
      <Explanation>
        The command exists in <strong>every Discord server the bot is in</strong>, and opening it is gated on your <strong>staff Discord roles</strong> — the same mapped roles that decide who may sign in here, checked with Discord on every press. Remove someone from staff in Discord and both stop: no list here to prune. There is nothing to configure on this screen; manage the roles under <strong>Sign-in &amp; roles</strong>.
      </Explanation>
      {!data.canCheckRoles && (
        <Callout variant="warn">
          Without the <strong>bot token</strong> and the <strong>staff server id</strong> (Setup &amp; status) the bot cannot ask Discord who is staff, so the only gate left is having a linked staff account.
        </Callout>
      )}
      {data.canCheckRoles && data.mappedRoles === 0 && (
        <Callout variant="warn">
          No Discord roles are mapped yet, so <strong>nobody</strong> can open the panel — the same rule that stops them signing in. Map a staff role under Sign-in &amp; roles.
        </Callout>
      )}
      <div className="actions">
        <button className="primary" disabled={busy !== "" || !dirty} onClick={save}>{busy === "save" ? "Saving…" : "Save name"}</button>
        <button disabled={busy !== "" || !data.canRegister} onClick={register}>{busy === "register" ? "Registering…" : "Register command"}</button>
      </div>
      {!data.canRegister && (
        <Callout variant="warn">Registering needs both the <strong>bot token</strong> and the <strong>application id</strong> — see the pieces above.</Callout>
      )}
      {dirty && <p className="hint">Unsaved changes — save first, then register.</p>}
      <ActionResult error={err} ok={registered} />
    </Panel>
  );
}

/* ---------------- Sign-in & roles ---------------- */

interface Role { id: string; name: string }
interface Mapping { discordRoleId: string; discordRoleName: string | null; roleId: string; scopeId: string | null }

function SignInRolesPanel({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const { servers } = useServers();
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [guildRoles, setGuildRoles] = useState<GuildRole[] | null>(null);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  // Null until the read answers: a failed one is not "sign-in isn't configured".
  const [oauthConfigured, setOauthConfigured] = useState<boolean | null>(null);
  const [botConfigured, setBotConfigured] = useState(true);
  const [note, setNote] = useState("");
  // What could not be read, said as that — each failure used to surface as a different claim:
  // "create a role first", "sign-in isn't configured", "the bot token isn't set".
  const [readErrs, setReadErrs] = useState<string[]>([]);
  const [busy, setBusy] = useState("");

  const load = () => {
    const failed = (what: string) => (e: unknown) => setReadErrs((cur) => [...cur.filter((x) => !x.startsWith(`Couldn't read ${what}:`)), `Couldn't read ${what}: ${(e as Error).message}`]);
    setReadErrs([]);
    api<{ roles: Role[] }>("/roles").then((r) => setRoles(r.roles ?? [])).catch(failed("the panel's roles"));
    api<{ mappings: Mapping[]; oauthConfigured: boolean }>("/discord/role-map")
      .then((r) => { setMappings(r.mappings ?? []); setOauthConfigured(r.oauthConfigured); })
      .catch(failed("the role mapping"));
    api<{ roles: GuildRole[]; botConfigured: boolean; error?: string }>("/discord/roles")
      .then((r) => { setGuildRoles(r.roles); setBotConfigured(r.botConfigured); if (r.error) setNote(r.error); })
      .catch((e) => { setGuildRoles([]); failed("the Discord server's roles")(e); });
  };
  useEffect(() => { load(); }, []);

  const byDiscordRole = useMemo(() => {
    const m = new Map<string, Mapping[]>();
    for (const map of mappings) m.set(map.discordRoleId, [...(m.get(map.discordRoleId) ?? []), map]);
    return m;
  }, [mappings]);

  /** The panel roles this Discord role grants, regardless of where. */
  const rolesOf = (discordRoleId: string): Set<string> =>
    new Set((byDiscordRole.get(discordRoleId) ?? []).map((m) => m.roleId));

  /** The servers it applies on — null when any assignment is community-wide. */
  const scopesOf = (discordRoleId: string): string[] | null => {
    const rows = byDiscordRole.get(discordRoleId) ?? [];
    if (!rows.length || rows.some((m) => m.scopeId === null)) return null;
    return [...new Set(rows.map((m) => m.scopeId!))];
  };

  /**
   * Save is always roles × servers. A Discord role granting two panel roles on three servers is
   * six assignments, and that cross product is what "these roles, on these servers" means — the
   * store keys on the pair, so each is its own row.
   */
  async function save(dr: GuildRole, roleIds: string[], scopes: string[] | null) {
    type Assignment = { roleId: string; scopeId: string | null };
    const assignments = roleIds.flatMap((roleId): Assignment[] =>
      scopes === null ? [{ roleId, scopeId: null }] : scopes.map((scopeId) => ({ roleId, scopeId })));
    setBusy(dr.id);
    try { await api(`/discord/role-map/${encodeURIComponent(dr.id)}`, { method: "PUT", body: { roles: assignments, discordRoleName: dr.name } }); load(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(""); }
  }
  const toggleRole = (dr: GuildRole, roleId: string) => {
    const cur = new Set(rolesOf(dr.id));
    if (cur.has(roleId)) cur.delete(roleId); else cur.add(roleId);
    void save(dr, [...cur], scopesOf(dr.id));
  };
  const setScopes = (dr: GuildRole, next: string[] | null) => void save(dr, [...rolesOf(dr.id)], next);
  const knownIds = new Set((guildRoles ?? []).map((r) => r.id));
  const orphanIds = [...byDiscordRole.keys()].filter((id) => !knownIds.has(id));

  return (
    <PanelGroup viewId="discord-signin">
      <Panel id="signin" caps="open" title="Sign-in &amp; roles">
      <Explanation>
        Let staff sign in with Discord instead of a manual login. Map each Discord role to the panel
        role(s) it should grant, and which server that applies on — permissions re-sync on every Discord
        login and periodically after, so removing someone&apos;s Discord role removes their access. Leave a
        mapping on <em>every server</em> for community-wide access, or pick one server to keep it there:
        that is how &ldquo;@Warfare Mods&rdquo; grants moderation on Warfare and nothing anywhere else.
        Members with no mapped role can&apos;t sign in.
        Manual username/password accounts keep working alongside this.
      </Explanation>

      {readErrs.map((m) => <ActionResult key={m} error={m} />)}
      {oauthConfigured === false && (
        <Callout variant="warn">
          Sign-in isn&apos;t configured yet — set the OAuth pieces in the <strong>Setup &amp; status</strong> tab. Role mapping still saves below.
        </Callout>
      )}
      {roles !== null && !roles.length && <Callout variant="info">Create at least one role first (Users &amp; roles) — Discord roles map onto panel roles.</Callout>}
      {canManage && <AskNotice capability="admin.users" />}
      <ActionResult error={note} />

      {guildRoles === null && <SkeletonRows rows={4} cols={2} />}
      {guildRoles !== null && !botConfigured && (
        <Callout variant="info">The bot token + guild id aren&apos;t set, so the guild&apos;s roles can&apos;t be listed. Sign-in still works once OAuth is configured.</Callout>
      )}

      {guildRoles && guildRoles.length > 0 && roles && roles.length > 0 && (
        <div className="drm-list">
          {guildRoles.map((dr) => {
            const granted = rolesOf(dr.id);
            return (
              <div className="drm-row" key={dr.id}>
                <span className="drm-drole" title={dr.id}>
                  <span className="drm-dot" style={{ background: dr.color ? `#${dr.color.toString(16).padStart(6, "0")}` : "var(--faint)" }} />
                  {dr.name}
                </span>
                <span className="drm-arrow" aria-hidden>→</span>
                <span className="drm-chips">
                  {roles.map((r) => (
                    <button key={r.id} className={`drm-chip${granted.has(r.id) ? " on" : ""}`} disabled={busy === dr.id || !canManage} onClick={() => toggleRole(dr, r.id)}>{r.name}</button>
                  ))}
                  {!granted.size && <span className="muted fs-xs">no access</span>}
                </span>
                {/* Which servers those roles apply on — as many as apply. Most communities run more
                    than two, so "every server or exactly one" could not express the common case of
                    a role that covers some of them. */}
                {granted.size > 0 && servers.length > 0 && (
                  <ServerScopeChips
                    servers={servers} value={scopesOf(dr.id)}
                    onChange={(next) => setScopes(dr, next)}
                    disabled={busy === dr.id || !canManage}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {orphanIds.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="muted" style={{ fontSize: "0.78rem", marginBottom: 6 }}>Mappings for roles not in the current list</div>
          <div className="drm-list">
            {orphanIds.map((id) => {
              const name = mappings.find((m) => m.discordRoleId === id)?.discordRoleName ?? id;
              // Group by panel role so a role granted on three servers is one chip, not three.
              const byRole = new Map<string, (string | null)[]>();
              for (const m of byDiscordRole.get(id) ?? []) byRole.set(m.roleId, [...(byRole.get(m.roleId) ?? []), m.scopeId]);
              const grantedNames = [...byRole.entries()].map(([roleId, scopes]) => {
                const rn = (roles ?? []).find((r) => r.id === roleId)?.name ?? roleId;
                const specific = scopes.includes(null) ? null : (scopes as string[]);
                return `${rn} ${describeScopes(specific, servers)}`;
              });
              return (
                <div className="drm-row" key={id}>
                  <span className="drm-drole">{name}</span>
                  <span className="drm-arrow" aria-hidden>→</span>
                  <span className="drm-chips">
                    {grantedNames.map((n) => <span key={n} className="drm-chip on" style={{ pointerEvents: "none" }}>{n}</span>)}
                    {canManage && <button className="mini ghost" disabled={busy === id} onClick={() => void save({ id, name, color: 0 }, [], null)}>Clear</button>}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      </Panel>
    </PanelGroup>
  );
}

