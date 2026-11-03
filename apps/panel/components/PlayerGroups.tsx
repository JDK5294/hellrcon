"use client";
/**
 * Player groups — named rosters (clan-vs-clan squads, streamers, event groups) that bulk actions
 * apply to. A group is global (membership is game player ids); the server — or all servers — is
 * chosen when an action fires. Actions go through the SAME machinery as their single-player
 * versions: bulk VIP / console admin land in the stores with the usual expiration modes and get
 * swept when they lapse; temp bans respect the caller's hour limits; team swap only touches
 * members who are online and on the wrong side. Each action button is shown only when the user
 * holds that action's own permission.
 *
 * A group can also carry a VIP PERK — membership itself as VIP: permanent VIP on the servers it
 * covers for as long as someone is listed, with any timed VIP they had frozen beneath it and given
 * back (plus a severance, if set) when they leave. The worker applies it; this page sets it up,
 * shows what it is doing, and asks — every time — whether ending it pays the severance.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { mayStillBeRunning, STILL_RUNNING_NOTE } from "../lib/unanswered";
import { preferredAdminGroup } from "../lib/adminGroups";
import { fmtRelative, wallToIso, zoneLabel } from "../lib/time";
import { useServers } from "../lib/servers";
import { useToast, useConfirm, usePrompt } from "../lib/feedback";
import { PanelGroup, Panel } from "./Panel";
import { ActionResult, AskNotice, Callout, EmptyState, Modal, NoServersNote, ObserveBanner, Pager, SkeletonLines, Toggle, type GuildRole, Explanation } from "./ui";
import { PlayerPicker } from "./PlayerPicker";
import { PlayerLink } from "./PlayerLink";
import { Time } from "./Time";
import { useClientPages } from "../lib/paged";
import { isTextOrNull, useRemembered } from "../lib/remembered";
import { useSortable, SortTh } from "../lib/sort";
import { hasCap, holdsOutright, type ClientGrant } from "../lib/access";
import { GameId } from "./GameId";
import { useGame } from "../lib/game";
import { PlaceholderHint } from "./Placeholders";
import { ServerScopePicker } from "./ServerScopePicker";
import { resolveBanScope, type BanScope } from "../lib/banScope";
import { describeMinutes, describeSpanMs, joinMinutes, splitMinutes, VIP_SPAN_MAX_MINUTES, type VipUnit } from "../lib/vipSpan";
import { stripLeadingZeros } from "../lib/formNumber";
import { fileStem, type Sheet } from "../lib/download";
import { DownloadButton } from "./Download";
import { UploadButton, type UploadResult } from "./Upload";
import { planMembers, type MemberLine, type PlanRow } from "../lib/uploadPlans";

/** A group's VIP perk — mirrors GroupVipPerk (packages/db): the game, which of its servers (a rule,
 *  like a ban's scope), and the severance paid on leaving, in minutes (0 = none). */
/** `bankRewards` false: rewards earned while listed add nothing to the frozen VIP (absent = true). */
interface VipPerk { game: string; scope: BanScope; severanceMinutes: number; bankRewards?: boolean }
interface Group { id: string; name: string; description: string | null; memberCount: number; createdByName: string; vipPerk?: VipPerk | null; discordRoleId?: string | null }
/** What the worker's last pass could not do for a perk — mirrors PerkNotes (apps/workers/src/group-perks.ts). */
interface PerkNotes { notSeen: number; otherGame: number; ownPermanent: number; ownGameVip: number; listUnreadable: number; quietServers: number }
/** GET /player-groups/:id's perkStatus: the grants this group's perk holds (only on servers whose
 *  VIP list the reader may see) and the worker's tallies. */
interface PerkStatus {
  heldPlayers: number; heldGrants: number;
  held: { serverId: string; playerId: string; bankedMs: number; since: string | null }[];
  notes: PerkNotes | null; checkedAt: string | null;
}
/** `source`: who listed them — a person, or the group's Discord role sync (which removes only its own). */
interface Member { groupId: string; playerId: string; playerName: string | null; addedByName: string; addedAt: string; source?: "panel" | "discord" }
interface DiscordRoleLink { id: string; name: string | null; problem?: string | null }
interface GroupDetail { members: Member[]; perkStatus?: PerkStatus | null; watchedByRules?: { joined: number; left: number; scheduled?: number }; discordRole?: DiscordRoleLink | null }

type BulkAction = "vip" | "vipRevoke" | "consoleAdmin" | "consoleAdminRemove" | "tempban" | "switch" | "message" | "economy";
type ExpMode = "permanent" | "until" | "duration";
interface ApplyResult { serverId: string; serverName: string; applied: { playerId: string; playerName: string | null; note?: string }[]; skipped: { playerId: string; playerName: string | null; reason: string }[] }

const ACTION_LABELS: Record<BulkAction, string> = {
  vip: "Grant VIP",
  vipRevoke: "Revoke VIP",
  consoleAdmin: "Grant console admin",
  consoleAdminRemove: "Remove console admin",
  tempban: "Temp ban",
  switch: "Move to a team",
  message: "Send message",
  economy: "Grant economy",
};

// Each bulk action's own capability — used to only OFFER servers the caller can act on (the API
// re-checks; this keeps the selector from listing a server that would always 403).
const ACTION_CAP: Record<BulkAction, string> = {
  vip: "vip.grant", vipRevoke: "vip.revoke",
  consoleAdmin: "server.admins", consoleAdminRemove: "server.admins",
  tempban: "action.tempban", switch: "action.switch", message: "action.message",
  economy: "economy.balances",
};

export function PlayerGroups({ canManage, grants = [] }: { canManage: boolean; grants?: ClientGrant[] }) {
  const { serverId, servers } = useServers();
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [groups, setGroups] = useState<Group[] | null>(null);
  // The group on screen and the page of its members, kept for the sitting: a member's profile
  // opened from the list comes back to the same group, not the first one. A remembered group that
  // has since been deleted falls to the first, as on a first visit.
  const [selected, setSelected] = useRemembered<string | null>("groups.selected", null, isTextOrNull, "session");
  // The group on screen now, for answers that arrive after someone clicked to another one.
  const shownRef = useRef<string | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  // Another group picked: the last one's members go in that same render, not in the load effect
  // below — handed to the pager under the new group's name, they cut the page it was left on to
  // their length.
  const [membersOf, setMembersOf] = useState(selected);
  if (membersOf !== selected) { setMembersOf(selected); setMembers(null); }
  const memberSort = useSortable<Member>({
    player: (m) => m.playerName ?? m.playerId, by: (m) => m.addedByName, added: (m) => m.addedAt,
  }, "added", "desc", "group-members");
  const sortedMembers = useMemo(() => memberSort.sorted(members ?? []), [memberSort, members]);
  const memberPages = useClientPages(members ? sortedMembers : null, selected ? `groups.${selected}.members` : undefined, "", `${memberSort.key}:${memberSort.dir}`);
  const [err, setErr] = useState("");
  const [pick, setPick] = useState<{ playerId: string; name: string } | null>(null);
  const [perkStatus, setPerkStatus] = useState<PerkStatus | null>(null);
  // How many live rules fire on this group's membership — see the note under the group picker.
  const [watched, setWatched] = useState<{ joined: number; left: number; scheduled?: number } | null>(null);
  // The community Discord role that keeps this group listed, with its name when Discord can say,
  // and why the last sync left the group as it was, if it did.
  const [discordRole, setDiscordRole] = useState<DiscordRoleLink | null>(null);
  const [linkingRole, setLinkingRole] = useState(false);
  // Ending a perk — switching it off, or deleting the group that carries it — asks about the
  // severance in its own dialog; this says which of the two is being asked.
  const [ending, setEnding] = useState<"off" | "delete" | null>(null);

  // bulk action form
  // Every action is offered (the ones not held are asked for), but the form opens on one this
  // viewer HOLDS — a staffer with only the economy key starts on the form they can use outright.
  const [action, setAction] = useState<BulkAction>(() => (Object.keys(ACTION_LABELS) as BulkAction[]).find((a) => hasCap(grants, ACTION_CAP[a], "write")) ?? "vip");
  const isEconomy = action === "economy";
  const [mode, setMode] = useState<ExpMode>("until");
  const [until, setUntil] = useState("");
  const [days, setDays] = useState("1");
  const [hours, setHours] = useState("0");
  // Stacking by default, like every other VIP grant in the app.
  const [cumulative, setCumulative] = useState(true);
  const [adminGroup, setAdminGroup] = useState("");
  const [adminGroups, setAdminGroups] = useState<string[]>([]);
  const [banHours, setBanHours] = useState("24");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  // Required on every VIP added (the API refuses a grant without one).
  const [vipComment, setVipComment] = useState("");
  // The VALUE stays the cross-game side id the API expects; only the label follows the game.
  const game = useGame();
  const [side, setSide] = useState("allies");
  // Where the bulk action lands: "" = the pinned server, "all" = every server the caller can
  // manage, anything else = a specific server id. A selector rather than an all-or-nothing
  // checkbox, so staff pinned to an observe-mode server can still aim at an active one.
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ApplyResult[] | null>(null);
  // group economy grant — balances live on Discord accounts, so this action aims at no server.
  const [ecoDelta, setEcoDelta] = useState("100");
  const [ecoReason, setEcoReason] = useState("");
  const [ecoBusy, setEcoBusy] = useState(false);
  const [ecoResult, setEcoResult] = useState<{ currency: string; applied: { playerId: string; playerName: string | null; applied: number; balance: number }[]; skipped: { playerId: string; playerName: string | null; reason: string }[] } | null>(null);

  // Every action, on every server this viewer can see: everything a role can see, it can ask for,
  // so an action the viewer does not hold — or holds only on another server — is sent for approval
  // on the server it was aimed at (the notice above the button says so), never left off the list.
  const group = groups?.find((g) => g.id === selected) ?? null;
  const applyAll = target === "all";
  const allowedServers = servers;
  const picked = applyAll ? null : target || serverId;
  const actionServerId = picked && allowedServers.some((s) => s.id === picked) ? picked : allowedServers[0]?.id ?? null;
  const targetServer = applyAll ? null : servers.find((s) => s.id === actionServerId) ?? null;

  const loadGroups = useCallback(() => {
    api<{ groups: Group[] }>("/player-groups")
      .then((r) => {
        // No groups yet is the normal state on a fresh install, and it arrives as a thin response.
        const list = r.groups ?? [];
        setGroups(list);
        setSelected((s) => (s && list.some((g) => g.id === s) ? s : list[0]?.id ?? null));
      })
      .catch((e) => setErr((e as Error).message));
  }, [setSelected]);
  useEffect(() => { loadGroups(); }, [loadGroups]);

  useEffect(() => {
    shownRef.current = selected;
    // One group's results and errors never read as another's.
    setResults(null);
    setEcoResult(null);
    setErr("");
    if (!selected) { setMembers(null); setPerkStatus(null); setWatched(null); setDiscordRole(null); return; }
    setMembers(null);
    setPerkStatus(null);
    setWatched(null);
    setDiscordRole(null);
    setLinkingRole(false);
    // Clicking down a list of groups: the members shown must belong to the one now selected.
    let live = true;
    api<GroupDetail>(`/player-groups/${selected}`)
      .then((r) => { if (live) { setMembers(r.members); setPerkStatus(r.perkStatus ?? null); setWatched(r.watchedByRules ?? null); setDiscordRole(r.discordRole ?? null); } })
      .catch((e) => { if (live) setErr((e as Error).message); });
    return () => { live = false; };
  }, [selected]);

  /** The selected group again — after a member or perk change, its list and perk status moved. */
  const reloadGroup = useCallback(async (id: string) => {
    const r = await api<GroupDetail>(`/player-groups/${id}`);
    // Clicked to another group while this was loading: that group's own load fills the page.
    if (shownRef.current !== id) return;
    setMembers(r.members);
    setPerkStatus(r.perkStatus ?? null);
    setWatched(r.watchedByRules ?? null);
    setDiscordRole(r.discordRole ?? null);
  }, []);

  /** Link the group to a Discord role, or with null unlink it. */
  async function saveDiscordRole(roleId: string | null) {
    if (!group) return;
    try {
      await api(`/player-groups/${group.id}/discord-role`, { method: "PUT", body: { roleId } });
      toast.success(roleId ? `“${group.name}” linked — it follows the role from the next sync (every few minutes)` : `“${group.name}” unlinked — every member stays listed`);
      // Clicked to another group meanwhile: its own picker is not this answer's to close.
      if (shownRef.current === group.id) setLinkingRole(false);
      await reloadGroup(group.id);
      loadGroups();
    } catch (e) { toast.error(`“${group.name}”: ${(e as Error).message}`); }
  }

  // Console-admin groups for the bulk grant, from the selected server (stock fallback comes with it).
  useEffect(() => {
    if (!actionServerId || action !== "consoleAdmin") return;
    // The grant targets whichever server the action is AIMED at — a stale list would offer group
    // names that don't exist on it, and the grant would fail at the game.
    let live = true;
    api<{ groups: string[] }>(`/servers/${actionServerId}/admins`)
      // The `?? []` was already here for the list; the default pick read the raw field and threw.
      .then((r) => { if (!live) return; const gs = r.groups ?? []; setAdminGroups(gs); setAdminGroup((g) => g || preferredAdminGroup(gs)); })
      .catch(() => { if (live) setAdminGroups(["owner", "senior", "junior", "spectator"]); });
    return () => { live = false; };
  }, [actionServerId, action]);

  async function createGroup() {
    const name = await prompt({
      title: "New player group",
      label: "Group name",
      placeholder: "e.g. Clan match — Axis roster, Streamers",
      hint: "A named set of players you act on together. Membership is by game player id, so the group works on every server.",
      confirmLabel: "Create group",
    });
    if (!name) return;
    try {
      const r = await api<{ group: Group }>("/player-groups", { method: "POST", body: { name } });
      toast.success(`Group “${name}” created`);
      setSelected(r.group.id);
      loadGroups();
    } catch (e) { toast.error((e as Error).message); }
  }

  async function renameGroup() {
    if (!group) return;
    const name = await prompt({ title: `Rename “${group.name}”`, label: "New name", confirmLabel: "Rename" });
    if (!name) return;
    try { await api(`/player-groups/${group.id}`, { method: "PUT", body: { name } }); loadGroups(); }
    catch (e) { toast.error((e as Error).message); }
  }

  async function deleteGroup() {
    if (!group) return;
    // A perk group takes its members' permanent VIP with it, so deleting one asks the perk's own
    // question — severance or not — instead of this one.
    if (group.vipPerk) { setEnding("delete"); return; }
    const ok = await confirm({
      title: `Delete group “${group.name}”?`,
      body: `The group and its member list go away (${group.memberCount} member${group.memberCount === 1 ? "" : "s"}). Grants made through it with a group action are not revoked — VIP and console admin keep their own expirations.`,
      confirmLabel: "Delete group",
      danger: true,
    });
    if (!ok) return;
    try { await api(`/player-groups/${group.id}`, { method: "DELETE" }); setSelected(null); loadGroups(); }
    catch (e) { toast.error((e as Error).message); }
  }

  /** Switch the perk off or delete its group, with the severance answer the dialog collected. */
  async function endPerk(severance: boolean) {
    if (!group || !ending) return;
    const q = `?severance=${severance ? 1 : 0}`;
    try {
      if (ending === "delete") {
        await api(`/player-groups/${group.id}${q}`, { method: "DELETE" });
        toast.success(`Group “${group.name}” deleted — its members' permanent VIP ends within a minute or so`);
        setSelected(null);
      } else {
        await api(`/player-groups/${group.id}/perk${q}`, { method: "DELETE" });
        toast.success(`VIP perk switched off — members' permanent VIP ends within a minute or so`);
        await reloadGroup(group.id);
      }
      setEnding(null);
      loadGroups();
    } catch (e) { toast.error((e as Error).message); }
  }

  async function addMember() {
    if (!group || !pick?.playerId) return;
    try {
      await api(`/player-groups/${group.id}/members`, { method: "POST", body: { playerId: pick.playerId, playerName: pick.name } });
      setPick(null);
      if (shownRef.current === group.id) setMembers(null);
      await reloadGroup(group.id);
      loadGroups();
    } catch (e) { toast.error((e as Error).message); }
  }

  async function removeMember(m: Member) {
    // Listed by the Discord role: the next sync lists them again while they hold it.
    if (m.source === "discord" && group?.discordRoleId && group.id === m.groupId) {
      const ok = await confirm({
        title: `Remove ${m.playerName || m.playerId} from “${group.name}”?`,
        body: "The group's Discord role sync listed them. While they hold the role, the next sync (every few minutes) lists them again — take the role away in Discord to remove them for good.",
        confirmLabel: "Remove anyway",
      });
      if (!ok) return;
    }
    // On a perk group, leaving ends a permanent VIP — the one removal worth a second look.
    if (group?.vipPerk && group.id === m.groupId) {
      const sev = group.vipPerk.severanceMinutes;
      const ok = await confirm({
        title: `Remove ${m.playerName || m.playerId} from “${group.name}”?`,
        body: `Their permanent VIP from this group ends within a minute or so; the timed VIP frozen under it comes back${sev ? `, plus ${describeMinutes(sev)} severance` : ""}.`,
        confirmLabel: "Remove",
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await api(`/player-groups/${m.groupId}/members/${encodeURIComponent(m.playerId)}`, { method: "DELETE" });
      if (shownRef.current === m.groupId) setMembers((rows) => rows?.filter((r) => r.playerId !== m.playerId) ?? null);
      loadGroups();
    } catch (e) { toast.error((e as Error).message); }
  }

  function expirationBody(): Record<string, unknown> {
    if (mode === "until") return { mode, expiresAt: until ? wallToIso(until) ?? undefined : undefined };
    if (mode === "duration") return { mode, days: Number(days || 0), hours: Number(hours || 0), cumulative };
    return { mode };
  }

  async function apply() {
    if (isEconomy) { await grantEconomy(); return; }
    if (!group || !actionServerId) return;
    const n = group.memberCount;
    const where = applyAll ? "ALL servers you can manage" : targetServer?.name ?? "this server";
    const what: Record<BulkAction, string> = {
      vip: `grant VIP (${mode === "permanent" ? "permanent" : mode === "until" ? `until ${until || "…"}` : `${days}d ${hours}h`})`,
      vipRevoke: "revoke VIP (members without one are skipped, not failed)",
      consoleAdminRemove: "remove console admin (members without it are skipped, not failed)",
      consoleAdmin: `grant console admin “${adminGroup}” (${mode === "permanent" ? "permanent" : mode === "until" ? `until ${until || "…"}` : `${days}d ${hours}h`})`,
      tempban: `temp-ban for ${banHours}h — ${reason || "…"}`,
      switch: `move everyone to ${side}`,
      message: `message: “${message.slice(0, 60)}${message.length > 60 ? "…" : ""}”`,
      economy: "",
    };
    const ok = await confirm({
      title: `${ACTION_LABELS[action]} — group “${group.name}”?`,
      body: `This will ${what[action]} for ${n} member${n === 1 ? "" : "s"} on ${where}. Members the server can't act on (offline for team moves, unreachable servers) come back as skipped, not errors.`,
      confirmLabel: ACTION_LABELS[action],
      danger: action === "tempban" || action === "vipRevoke" || action === "consoleAdminRemove",
    });
    if (!ok) return;
    setBusy(true); setResults(null); setErr("");
    const forGroup = group;
    const body: Record<string, unknown> = { action, serverId: actionServerId, allServers: applyAll };
    if (action === "vip") Object.assign(body, expirationBody(), { comment: vipComment.trim() });
    else if (action === "consoleAdmin") Object.assign(body, expirationBody(), { group: adminGroup });
    else if (action === "tempban") Object.assign(body, { hours: Number(banHours), reason: reason.trim() });
    else if (action === "switch") Object.assign(body, { side });
    else if (action === "message") Object.assign(body, { message: message.trim() });
    try {
      // Every member on every chosen server, one at a time — it can outrun the default wait.
      const r = await api<{ results: ApplyResult[] }>(`/player-groups/${forGroup.id}/apply`, { method: "POST", body, timeoutMs: 0 });
      // The per-server list belongs under the group it was run on; another one on screen now
      // gets only the toast, which names it.
      const here = shownRef.current === forGroup.id;
      if (here) setResults(r.results);
      const applied = r.results.reduce((s, x) => s + x.applied.length, 0);
      const skipped = r.results.reduce((s, x) => s + x.skipped.length, 0);
      toast.success(`${ACTION_LABELS[action]} — “${forGroup.name}”: ${applied} applied${skipped ? `, ${skipped} skipped` : ""}`);
      // A grant's comment says what that grant was for, so the next one asks again, as every other
      // VIP form does — unless a new one was typed while this ran.
      if (action === "vip") setVipComment((c) => (c.trim() === body.comment ? "" : c));
    } catch (e) {
      const msg = action === "vip" && mayStillBeRunning(e) ? `${(e as Error).message} ${STILL_RUNNING_NOTE}` : (e as Error).message;
      if (shownRef.current === forGroup.id) setErr(msg); else toast.error(`“${forGroup.name}”: ${msg}`);
    } finally { setBusy(false); }
  }

  async function grantEconomy() {
    if (!group) return;
    const d = Number(ecoDelta);
    const ok = await confirm({
      title: `${d >= 0 ? "Grant" : "Dock"} ${Math.abs(d)} per member — “${group.name}”?`,
      body: `Every linked member's balance changes by ${d >= 0 ? "+" : ""}${d}. Members without a Discord link are skipped and listed — balances live on Discord accounts.`,
      confirmLabel: d >= 0 ? "Grant to group" : "Dock the group",
      danger: d < 0,
    });
    if (!ok) return;
    setEcoBusy(true); setEcoResult(null); setErr("");
    const forGroup = group;
    try {
      const r = await api<NonNullable<typeof ecoResult>>(`/economy/groups/${forGroup.id}/adjust`, { method: "POST", body: { delta: d, reason: ecoReason.trim() } });
      if (shownRef.current === forGroup.id) setEcoResult(r);
      toast.success(`${r.currency} — “${forGroup.name}”: ${r.applied.length} member${r.applied.length === 1 ? "" : "s"} adjusted${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}`);
    } catch (e) { toast.error(`“${forGroup.name}”: ${(e as Error).message}`); } finally { setEcoBusy(false); }
  }

  const applyBlockedWhy =
    isEconomy ? (!group ? "Pick a group." : !Number(ecoDelta) ? "Enter an amount per member (negative docks)." : !ecoReason.trim() ? "Type a reason — it is the ledger row other staff read." : "")
    : !actionServerId ? "Pick a server first (top of the page)."
    : !group ? "Pick a group."
    : (members?.length ?? group.memberCount) === 0 ? "The group has no members yet — add some below, or from any player profile (⋯ → Groups)."
    : action === "consoleAdmin" && !adminGroup ? "Pick an admin group."
    : (action === "vip" || action === "consoleAdmin") && mode === "until" && !until ? "Pick an expiry date."
    : (action === "vip" || action === "consoleAdmin") && mode === "duration" && !(Number(days || 0) * 24 + Number(hours || 0) > 0) ? "Give the grant a duration."
    : action === "vip" && !vipComment.trim() ? "Type a comment — every VIP added needs one: who paid, what for, or which event."
    : action === "tempban" && !(Number(banHours) > 0) ? "Give the ban a length in hours."
    : action === "tempban" && !reason.trim() ? "Type a reason — the players see it, and it goes in the log."
    : action === "message" && !message.trim() ? "Type the message to send."
    : "";

  return (
    <PanelGroup viewId="player-groups">
      <Panel id="groups" caps="open" title="Player groups" subtitle="named rosters for bulk actions"
        actions={canManage ? <button className="mini" onClick={createGroup}>+ New group</button> : undefined}>
        <Explanation>
          A group is a saved set of players — a clan-match roster, your streamers, an event squad. Pick one,
          then grant VIP or console admin (with an expiration), temp-ban, team-move, or message <em>everyone
          in it</em> at once. Players can also be added from any profile: ⋯ → Groups.
        </Explanation>
        {canManage && <AskNotice capability="player.groups" />}
        <ActionResult error={err} />
        {!groups && !err && <SkeletonLines lines={2} />}
        {groups && groups.length === 0 && (
          <EmptyState icon="👪" title="No player groups yet">
            A group is a saved list of players you act on together — grant VIP to your donators, temp-ban a
            clan that keeps team-killing, or message a squad. {canManage ? "Create one above, then add players from any roster or profile." : "Someone with permission to manage groups can create one."}
          </EmptyState>
        )}
        {groups && groups.length > 0 && (
          <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <select aria-label="Group" value={selected ?? ""} onChange={(e) => { setSelected(e.target.value); setResults(null); setEcoResult(null); }} style={{ minWidth: 220 }}>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.memberCount})</option>)}
            </select>
            {canManage && group && <button className="mini ghost" onClick={renameGroup}>Rename</button>}
            {canManage && group && <button className="mini danger" onClick={deleteGroup}>Delete</button>}
            {group && <DownloadButton file={fileStem("group", group.name)} title={`Download the members of ${group.name}`}
              count={members?.length ?? 0} noun="member" scope="every one in the group, in the list's order"
              sheet={() => memberSheet(sortedMembers, group.name)} />}
            {group && canManage && members && (
              <UploadButton title={`Upload members into ${group.name}`} onDone={() => { loadGroups(); void reloadGroup(group.id).catch(() => {}); }}
                intro={group.vipPerk ? "Players not yet in the group are added — and its VIP perk gives each one VIP while they are listed." : "Players not yet in the group are added. Nobody is taken out."}
                plan={(t) => planMembers(t, members)}
                apply={(rows, progress) => uploadMembers(group.id, rows, progress)} />
            )}
            {group?.description && <span className="muted">{group.description}</span>}
          </div>
        )}
        {/* Said to everyone who can see the group, keys or not: membership here moves VIP, which is
            why adding or removing someone may ask for a VIP key they don't hold. */}
        {group?.vipPerk && (
          <p className="hint notice">
            <span className="badge active">VIP perk</span> Members hold permanent VIP while they&apos;re
            listed — adding or removing someone also takes VIP grant or VIP revoke on its servers.
          </p>
        )}
        {group && (discordRole || canManage) && (
          <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
            {discordRole
              ? <span className="hint"><span className="badge">Discord</span> Kept in step with the role <strong>{discordRole.name ? `@${discordRole.name}` : `role ${discordRole.id}`}</strong> — whoever holds it (with a linked game account) is listed; whoever the sync listed and loses it is not. Members added here stay.</span>
              : <span className="hint">Not linked to a Discord role.</span>}
            {canManage && !linkingRole && <button className="mini ghost" onClick={() => setLinkingRole(true)}>{discordRole ? "Change role" : "Sync from a Discord role…"}</button>}
            {canManage && discordRole && !linkingRole && <button className="mini ghost" onClick={() => void saveDiscordRole(null)}>Unlink</button>}
          </div>
        )}
        {group && discordRole?.problem && (
          <p className="hint" style={{ marginTop: 4 }}><span className="badge warn-badge">Not in step</span> {discordRole.problem}</p>
        )}
        {group && canManage && linkingRole && <DiscordRolePicker current={discordRole?.id ?? null} onSave={(id) => void saveDiscordRole(id)} onCancel={() => setLinkingRole(false)} />}
        {group && watched && watched.joined + watched.left + (watched.scheduled ?? 0) > 0 && (
          <p className="hint" style={{ marginTop: 6 }}>
            <span className="badge">Rules</span>{" "}
            {[
              watched.joined ? `${watched.joined} rule${watched.joined === 1 ? " fires" : "s fire"} when someone is added` : "",
              watched.left ? `${watched.left} when someone is removed` : "",
              watched.scheduled ? `${watched.scheduled} schedule${watched.scheduled === 1 ? " acts" : "s act"} on everyone listed` : "",
            ].filter(Boolean).join(", ")}
            {" "}— changing the members also takes the keys {watched.joined + watched.left + (watched.scheduled ?? 0) === 1 ? "that rule uses" : "those rules use"} (VIP grant or revoke for VIP, the payout key for points, the tag key for tags).
          </p>
        )}

        {group && (
          <div style={{ marginTop: 12 }}>
            {!members && <SkeletonLines lines={3} />}
            {members && members.length === 0 && (
              <EmptyState icon="👤" title="This group has no members yet">
                Add players to it from any roster or from a player&apos;s profile. Once it has
                members you can act on all of them at once — VIP, temp-ban, message, team swap.
              </EmptyState>
            )}
            {members && members.length > 0 && (
              <div className="scroll-x">
                <table className="table">
                  {/* Action column right after the name — reachable without scrolling the wide table. */}
                  <thead><tr>
                    <SortTh s={memberSort} k="player">Player</SortTh><th />
                    <th>Player id</th>
                    <SortTh s={memberSort} k="by">Added by</SortTh>
                    <SortTh s={memberSort} k="added">Added</SortTh>
                  </tr></thead>
                  <tbody>
                    {(memberPages.items ?? []).map((m) => (
                      <tr key={m.playerId}>
                        <td><PlayerLink playerId={m.playerId} name={m.playerName || <span className="muted">{m.playerId.slice(0, 14)}…</span>} />{m.source === "discord" && <span className="badge" style={{ marginLeft: 6 }} title="Listed by the group's Discord role sync">via Discord</span>}</td>
                        <td>{canManage && <button className="mini ghost" onClick={() => removeMember(m)}>Remove</button>}</td>
                        <td className="hint"><GameId id={m.playerId} truncate={20} /></td>
                        <td>{m.addedByName}</td>
                        <td className="hint"><Time iso={m.addedAt} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {members && members.length > 0 && <Pager list={memberPages} noun="member" />}
            {canManage && (
              <div className="row" style={{ gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
                <div style={{ minWidth: 260, flex: "0 1 320px" }}>
                  <PlayerPicker value={pick} onChange={setPick} placeholder="Add a member — search by name or paste an id…" />
                </div>
                <button className="mini" onClick={addMember} disabled={!pick?.playerId}>Add to group</button>
              </div>
            )}
          </div>
        )}
      </Panel>

      {group && (
        <Panel id="perk" caps={["vip.grant", "vip.revoke"]} title="VIP perk" subtitle={group.vipPerk ? "on — permanent VIP while listed" : "off"}>
          {canManage && <AskNotice capability={["player.groups", "vip.grant", "vip.revoke"]} />}
          <VipPerkPanel key={group.id} group={group} status={perkStatus} members={members} grants={grants}
            canEdit={canManage}
            onSaved={() => { loadGroups(); void reloadGroup(group.id).catch(() => {}); }}
            onSwitchOff={() => setEnding("off")} />
        </Panel>
      )}
      {group && ending && (
        <EndPerkDialog kind={ending} group={group} heldPlayers={perkStatus?.heldPlayers ?? null}
          onCancel={() => setEnding(null)} onConfirm={endPerk} />
      )}

      {group && (
        <Panel id="bulk" caps="open" title="Apply to the whole group" subtitle={`${group.name} · ${group.memberCount} member${group.memberCount === 1 ? "" : "s"}`}>
          {!applyAll && !isEconomy && <ObserveBanner server={targetServer}>Or aim the action at an active server (or “All servers”) with the Apply-on selector below.</ObserveBanner>}
          <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div className="seg" role="group" aria-label="What to do">
              {(Object.keys(ACTION_LABELS) as BulkAction[]).map((a) => (
                <button key={a} type="button" className={`seg-btn ${action === a ? "active" : ""}`} onClick={() => { setAction(a); setResults(null); setEcoResult(null); }}>{ACTION_LABELS[a]}</button>
              ))}
            </div>
          </div>

          {(action === "vip" || action === "consoleAdmin") && (
            <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
              {action === "consoleAdmin" && (
                <label className="inline">Admin group
                  <select value={adminGroup} onChange={(e) => setAdminGroup(e.target.value)} style={{ marginLeft: 6 }}>
                    {adminGroups.length === 0 && <option value="">no groups reported</option>}
                    {adminGroups.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                </label>
              )}
              <div className="seg" role="group" aria-label="How long">
                {([["permanent", "Permanent"], ["until", "Until date"], ["duration", "For a duration"]] as [ExpMode, string][]).map(([m, label]) => (
                  <button key={m} type="button" className={`seg-btn ${mode === m ? "active" : ""}`} onClick={() => setMode(m)}>{label}</button>
                ))}
              </div>
              {mode === "until" && <label className="inline" style={{ flexWrap: "wrap" }}>Expires at ({zoneLabel()})<input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} style={{ marginLeft: 6 }} /></label>}
              {mode === "duration" && (
                <>
                  <label className="inline">Days<input type="number" min="0" value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 70, marginLeft: 6 }} /></label>
                  <label className="inline">Hours<input type="number" min="0" value={hours} onChange={(e) => setHours(e.target.value)} style={{ width: 70, marginLeft: 6 }} /></label>
                  <Toggle checked={cumulative} onChange={setCumulative} label={cumulative ? "Stack onto existing time" : "At least this long from now"} />
                </>
              )}
              {action === "vip" && (
                <label className="inline" style={{ flexWrap: "wrap", maxWidth: "100%" }}>Comment (required)
                  {/* The box keeps its 220px, on a line of its own where the row has no room: held
                      beside its words on a phone, it ran past the panel's edge. And the whole is
                      no wider than the row: the box's natural width grows with the text size, and
                      at the larger sizes it still ran off a phone's screen (the date's label above
                      wraps for the same reason). */}
                  <input value={vipComment} onChange={(e) => setVipComment(e.target.value)} placeholder="who paid, what for, or which event" style={{ marginLeft: 6, minWidth: 220 }} />
                </label>
              )}
            </div>
          )}
          {action === "vip" && <Explanation>Exactly like a single VIP grant, once per member: the game gets the VIP, the panel tracks the expiration, and lapsed grants are removed automatically. A group grant never cuts anyone&apos;s time — a member who already has more keeps it, permanent VIP is never touched, and members holding permanent VIP from a group perk are skipped. The comment is the note on each new VIP; members who already have VIP keep their own note, and the comment goes in their VIP history.</Explanation>}
          {action === "consoleAdmin" && <Explanation>In-game admin powers (admin camera, console commands) for everyone in the group — e.g. cam access for casters during a clan match. Expires automatically, exactly like VIP.</Explanation>}
          {action === "vipRevoke" && <p className="hint notice" style={{ marginTop: 6 }}>Removes each member&apos;s VIP from the game and from the tracked list — e.g. clearing the caster VIPs after a clan match. Members with no VIP on the target server come back as skipped, and so do members holding permanent VIP from a group perk — that lasts until they leave the group.</p>}
          {action === "consoleAdminRemove" && <Explanation>Takes the in-game admin powers back from everyone in the group — the counterpart to the bulk grant. Members who aren&apos;t console admins on the target server come back as skipped.</Explanation>}

          {action === "tempban" && (
            <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
              <label className="inline">Hours<input type="number" min="1" value={banHours} onChange={(e) => setBanHours(e.target.value)} style={{ width: 80, marginLeft: 6 }} /></label>
              <label className="inline" style={{ flex: "1 1 260px" }}>Reason<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="shown to the players + logged" style={{ marginLeft: 6, width: "100%" }} /></label>
              <PlaceholderHint>— filled per member.</PlaceholderHint>
            </div>
          )}
          {action === "switch" && (
            <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
              <label className="inline">Move everyone to
                <select value={side} onChange={(e) => setSide(e.target.value)} style={{ marginLeft: 6 }}>
                  <option value="allies">{game.sideName("allies")}</option>
                  <option value="axis">{game.sideName("axis")}</option>
                </select>
              </label>
              <span className="hint">Only members who are online and on the other team get switched; everyone else is reported as skipped.</span>
            </div>
          )}
          {action === "message" && (
            <div style={{ marginTop: 10 }}>
              <textarea aria-label="Message" value={message} onChange={(e) => setMessage(e.target.value)} rows={2} placeholder="e.g. Scrim lobby is up — swap to your team now" style={{ width: "100%" }} />
              <PlaceholderHint>— filled per member, so {"{player_name}"} and {"{vip_until}"} are each player&apos;s own.</PlaceholderHint>
            </div>
          )}

          {isEconomy && (
            <>
              <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
                <label className="inline">Amount per member (negative docks)
                  <input type="number" value={ecoDelta} onChange={(e) => setEcoDelta(e.target.value)} style={{ width: 120, marginLeft: 6 }} />
                </label>
                <label className="inline" style={{ flex: "1 1 260px" }}>Reason
                  <input value={ecoReason} onChange={(e) => setEcoReason(e.target.value)} placeholder="the ledger row other staff read" style={{ marginLeft: 6, width: "100%" }} />
                </label>
              </div>
              <Explanation>
                Credits every member&apos;s balance at once — event prizes, seeding thanks. Balances live on
                <strong> Discord accounts</strong>, so members without a link come back as skipped with the
                reason, and two game accounts on one Discord are one person, paid once. Not tied to a server.
              </Explanation>
            </>
          )}

          <div className="row" style={{ gap: 10, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
            {!isEconomy && <label className="inline">Apply on
              <select value={applyAll ? "all" : actionServerId ?? ""} onChange={(e) => { setTarget(e.target.value === serverId ? "" : e.target.value); setResults(null); }} style={{ marginLeft: 6 }}>
                {allowedServers.map((s) => <option key={s.id} value={s.id}>{s.name}{s.engagementMode === "observe" ? " (observe — read-only)" : ""}</option>)}
                <option value="all">All servers I can manage</option>
              </select>
            </label>}
            <button className="apply-whole-group" onClick={apply} disabled={busy || ecoBusy || applyBlockedWhy !== ""}>{busy || ecoBusy ? "Applying…" : `${ACTION_LABELS[action]} — whole group`}</button>
          </div>
          {applyBlockedWhy && <p className="hint" style={{ marginTop: 4 }}>{applyBlockedWhy}</p>}
          <AskNotice capability={ACTION_CAP[action]} serverId={applyAll || isEconomy ? null : actionServerId} />
          <ActionResult error={err} />

          {isEconomy && ecoResult && (
            <div style={{ marginTop: 12 }}>
              <span className="badge active">{ecoResult.applied.length} adjusted</span>{" "}
              {ecoResult.skipped.length > 0 && <span className="badge observe">{ecoResult.skipped.length} skipped</span>}
              {ecoResult.skipped.length > 0 && (
                <ul className="hint" style={{ margin: "4px 0 0 18px" }}>
                  {ecoResult.skipped.map((x) => <li key={x.playerId}>{x.playerName || x.playerId} — {x.reason}</li>)}
                </ul>
              )}
            </div>
          )}
          {!isEconomy && results && (
            <div style={{ marginTop: 12 }}>
              {results.map((r) => (
                <div key={r.serverId} style={{ marginBottom: 8 }}>
                  <strong>{r.serverName}</strong>: <span className="badge active">{r.applied.length} applied</span>{" "}
                  {r.skipped.length > 0 && <span className="badge observe">{r.skipped.length} skipped</span>}
                  {r.skipped.length > 0 && (
                    <ul className="hint" style={{ margin: "4px 0 0 18px" }}>
                      {r.skipped.map((s) => <li key={s.playerId}>{s.playerName || s.playerId} — {s.reason}</li>)}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}

      {!servers.length && <NoServersNote>Groups can still be built and edited; the actions that apply them need a server.</NoServersNote>}
    </PanelGroup>
  );
}

/** "every WW2 server, and any added later", "WW2 servers #1, #3" — a perk's reach, by server number. */
/** An uploaded member list's new members, added one at a time as "Add to group" adds one. */
async function uploadMembers(groupId: string, rows: PlanRow<MemberLine>[], progress: (done: number) => void): Promise<UploadResult[]> {
  const out: UploadResult[] = [];
  for (const [i, row] of rows.entries()) {
    try {
      await api(`/player-groups/${groupId}/members`, { method: "POST", body: { playerId: row.payload!.playerId, playerName: row.payload!.playerName } });
      out.push({ line: row.line, who: row.who, ok: true, detail: "added" });
    } catch (e) {
      out.push({ line: row.line, who: row.who, ok: false, detail: (e as Error).message });
    }
    progress(i + 1);
  }
  return out;
}

/** A group's members as a file, in the list's order. */
function memberSheet(rows: Member[], groupName: string): Sheet {
  return {
    name: groupName,
    columns: [
      { key: "player", label: "Player" },
      { key: "playerId", label: "Player ID" },
      { key: "addedBy", label: "Added by" },
      { key: "added", label: "Added", time: true },
      { key: "listedBy", label: "Listed by" },
    ],
    rows: rows.map((m) => [m.playerName, m.playerId, m.addedByName, m.addedAt, m.source === "discord" ? "Discord role sync" : "panel"]),
  };
}

function perkReach(perk: VipPerk, label: string, numberOf: (id: string) => number | null): string {
  const list = (ids: string[]) => ids.map((id) => { const n = numberOf(id); return n ? `#${n}` : "a server not listed for you"; }).join(", ");
  if (perk.scope.mode === "all" || (perk.scope.mode === "except" && !perk.scope.serverIds.length)) return `every ${label} server, and any added later`;
  if (perk.scope.mode === "except") return `every ${label} server except ${list(perk.scope.serverIds)}, and any added later`;
  return `${label} server${perk.scope.serverIds.length === 1 ? "" : "s"} ${list(perk.scope.serverIds)}`;
}

/** The worker's tallies, as sentences — only the ones that are not zero are shown. "Member" counts
 *  are people; "grant" counts are (server, player) pairs. */
const PERK_NOTE_LINES: [keyof PerkNotes, (n: number) => string][] = [
  ["notSeen", (n) => `${n} member${n === 1 ? " hasn't" : "s haven't"} been seen on a server yet — a console id could belong to either game, so their VIP starts once they've joined one.`],
  ["otherGame", (n) => `${n} member${n === 1 ? " plays" : "s play"} the other game — that id can't hold VIP on these servers.`],
  ["ownPermanent", (n) => `${n} grant${n === 1 ? " was" : "s were"} already permanent VIP of their own — left exactly as ${n === 1 ? "it is" : "they are"}.`],
  ["ownGameVip", (n) => `${n} grant${n === 1 ? "" : "s"} left alone — VIP on the game's own list that the panel didn't grant.`],
  ["listUnreadable", (n) => `${n} grant${n === 1 ? "" : "s"} waiting — a server's VIP list couldn't be read; the next pass tries again.`],
  ["quietServers", (n) => `${n} grant${n === 1 ? "" : "s"} not made — the server is in observe mode, or its VIP expiry is switched off in automation.`],
];

/**
 * The group's VIP perk: what it gives, what it is doing, and — for someone holding the VIP keys
 * as well as group management — the editor. Setting one up takes VIP grant and VIP revoke on every
 * server it covers (it does both); the API checks, this only keeps the offer honest.
 */
function VipPerkPanel({ group, status, members, canEdit, grants, onSaved, onSwitchOff }: {
  group: Group;
  status: PerkStatus | null;
  members: Member[] | null;
  canEdit: boolean;
  grants: ClientGrant[];
  onSaved: () => void;
  onSwitchOff: () => void;
}) {
  const { servers, serverId, numberOf } = useServers();
  const toast = useToast();
  const [labels, setLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    api<{ games?: { id: string; label: string }[] }>("/games")
      .then((r) => setLabels(Object.fromEntries((r.games ?? []).map((g) => [g.id, g.label]))))
      .catch(() => {});
  }, []);
  const label = (game: string) => labels[game] ?? game.toUpperCase();
  const games = [...new Set(servers.map((s) => s.game).filter((g): g is string => Boolean(g)))];

  const perk = group.vipPerk ?? null;
  const [editing, setEditing] = useState(false);
  const [game, setGame] = useState("");
  const [scope, setScope] = useState<BanScope>({ mode: "all" });
  const [sevRaw, setSevRaw] = useState("0");
  const [sevUnit, setSevUnit] = useState<VipUnit>("days");
  const [bankRewards, setBankRewards] = useState(true);
  const [busy, setBusy] = useState(false);
  // A different group is a different perk: the panel is keyed by group, so a half-made edit, a
  // busy save and its answer all stay with the group they were made on.

  /** Servers of `g` a perk can be pointed at: every one listed here. Where this person lacks
   *  either VIP key, the save is sent for approval to someone who holds them, like the API does. */
  const allowedOf = (g: string) => servers.filter((s) => s.game === g);
  // "Every server" also reaches servers added later — and any this person cannot see, which the
  // list here does not show — so a FRESH perk starts there only for someone holding both keys
  // everywhere. Choosing it is still theirs; the API checks the servers it covers, and asks for
  // the keys this person lacks.
  const everywhere = holdsOutright(grants, "vip.grant", "write") && holdsOutright(grants, "vip.revoke", "write");
  /** A fresh perk's reach: every server of the game when this person covers them all, else the
   *  pinned server (or the first they may use) — widening is a deliberate choice in the picker. */
  const defaultScope = (g: string): BanScope => {
    const allowed = allowedOf(g);
    if (everywhere && allowed.length && allowed.length === servers.filter((s) => s.game === g).length) return { mode: "all" };
    const first = allowed.find((s) => s.id === serverId) ?? allowed[0];
    return { mode: "servers", serverIds: first ? [first.id] : [] };
  };

  function startEdit() {
    const pinnedGame = servers.find((s) => s.id === serverId)?.game;
    const g = perk?.game ?? (pinnedGame && games.includes(pinnedGame) ? pinnedGame : games[0] ?? "");
    setGame(g);
    setScope(perk ? perk.scope : defaultScope(g));
    const sev = splitMinutes(perk?.severanceMinutes ?? 0);
    setSevRaw(String(sev.value));
    setSevUnit(perk?.severanceMinutes ? sev.unit : "days");
    setBankRewards(perk?.bankRewards !== false);
    setEditing(true);
  }

  const severanceMinutes = sevRaw.trim() === "" ? 0 : joinMinutes(sevRaw, sevUnit);
  const allowed = game ? allowedOf(game) : [];
  const covered = game ? resolveBanScope(scope, allowed, game) : [];
  /*
   * Reach beyond this list: "every server" (or every but some) covers servers it may not show and
   * any added later, and an "only these" perk can name a server not listed for this person. The
   * API wants the keys there too — VIP grant and VIP revoke where the perk will reach, VIP revoke
   * where it reaches now — and asks for them when they are missing, so say so before the save.
   * Someone holding them outright needs no word about it.
   */
  const listedIds = new Set(servers.map((s) => s.id));
  const beyondList = (sc: BanScope) => sc.mode !== "servers" || sc.serverIds.some((id) => !listedIds.has(id));
  const choiceBeyond = !everywhere && beyondList(scope);
  const heldBeyond = !!perk && !holdsOutright(grants, "vip.revoke", "write") && beyondList(perk.scope);
  const sameReach = !!perk && perk.game === game && JSON.stringify(perk.scope) === JSON.stringify(scope);
  const reachNotes: string[] = [];
  if (sameReach) {
    if (choiceBeyond || heldBeyond) reachNotes.push(`This perk reaches ${perkReach(perk!, label(perk!.game), numberOf)} — servers you can't see here included: unless you hold VIP grant and VIP revoke on all of them, saving it is sent for approval to someone who does.`);
  } else {
    if (heldBeyond) reachNotes.push(`This perk now reaches ${perkReach(perk!, label(perk!.game), numberOf)} — servers you can't see here included: unless you hold VIP revoke on all of them, changing it is sent for approval to someone who does.`);
    if (choiceBeyond) {
      reachNotes.push(scope.mode !== "servers"
        ? `That choice also covers ${label(game)} servers you can't see here, and any added later: unless you hold VIP grant and VIP revoke on all of them, the save is sent for approval to someone who does${allowed.length >= 2 ? " — pick the servers instead to keep it to these" : ""}.`
        : "That choice includes a server not listed for you: unless you hold VIP grant and VIP revoke there, the save is sent for approval to someone who does.");
    }
  }
  const blockedWhy = !game ? "Pick the game whose servers the perk covers."
    : !allowed.length ? `There is no ${label(game)} server here yet.`
    : scope.mode === "servers" && !scope.serverIds.length ? "Pick at least one server."
    : !covered.length ? `That choice covers none of the ${label(game)} servers listed here.`
    : !Number.isFinite(severanceMinutes) || severanceMinutes < 0 ? "The severance must be a number — 0 for none."
    : severanceMinutes > VIP_SPAN_MAX_MINUTES ? "A year is the longest severance — give a grant instead."
    : "";

  async function save() {
    setBusy(true);
    try {
      await api(`/player-groups/${group.id}/perk`, { method: "PUT", body: { game, scope, severanceMinutes, bankRewards } });
      toast.success(`VIP perk ${perk ? "changed" : "set up"} on “${group.name}” — the worker applies it within a minute or so`);
      setEditing(false);
      onSaved();
    } catch (e) { toast.error(`“${group.name}”: ${(e as Error).message}`); } finally { setBusy(false); }
  }

  const nameOf = new Map((members ?? []).map((m) => [m.playerId, m.playerName]));
  const notes = status?.notes ?? null;
  const noteLines = notes ? PERK_NOTE_LINES.filter(([k]) => (notes[k] ?? 0) > 0).map(([k, say]) => say(notes[k])) : [];

  return (
    <>
      {!perk && !editing && (
        <>
          <Explanation>
            Make membership itself the VIP: everyone in this group holds <strong>permanent VIP</strong> on
            the servers you choose for as long as they&apos;re in it — a clan team, streamers, event
            staff. Timed VIP they already have isn&apos;t lost: it&apos;s frozen beneath the permanent
            one and comes back when they leave the group (or the perk is switched off), plus a
            severance if you set one.
          </Explanation>
          {canEdit
            ? <button className="mini" onClick={startEdit} disabled={!games.length}>Set up a VIP perk</button>
            : <p className="hint">Setting one up needs VIP grant and VIP revoke on the servers it covers, as well as group management.</p>}
        </>
      )}

      {perk && !editing && (
        <>
          <p className="mt-0">
            Members hold <strong>permanent VIP on {perkReach(perk, label(perk.game), numberOf)}</strong> while
            they&apos;re listed. On leaving, the timed VIP frozen under it comes back
            {perk.severanceMinutes ? <>, plus <strong>{describeMinutes(perk.severanceMinutes)}</strong> severance</> : <> — no severance</>}.
            {perk.bankRewards === false
              ? <> Rewards <strong>don&apos;t add</strong> to the frozen VIP while they&apos;re listed.</>
              : <> Rewards earned while listed add to the frozen VIP.</>}
          </p>
          {status && (
            <p className="hint">
              {status.checkedAt
                ? <>Holding permanent VIP for {status.heldPlayers} player{status.heldPlayers === 1 ? "" : "s"}{status.heldGrants !== status.heldPlayers ? ` (${status.heldGrants} grants)` : ""} · last checked {fmtRelative(status.checkedAt)}.</>
                : <>Waiting for the worker&apos;s first pass — it applies the perk within a minute or so.</>}
            </p>
          )}
          {noteLines.length > 0 && <ul className="hint" style={{ margin: "4px 0 0 18px" }}>{noteLines.map((l) => <li key={l}>{l}</li>)}</ul>}
          {status && status.held.length > 0 && (
            <div className="scroll-x" style={{ marginTop: 8 }}>
              <table className="table">
                <thead><tr><th>Player</th><th>Server</th><th>Timed VIP frozen</th><th>Held since</th></tr></thead>
                <tbody>
                  {status.held.map((h) => (
                    <tr key={`${h.serverId}|${h.playerId}`}>
                      <td><PlayerLink playerId={h.playerId} name={nameOf.get(h.playerId) || <span className="muted">{h.playerId.slice(0, 14)}…</span>} /></td>
                      <td>{numberOf(h.serverId) ? `#${numberOf(h.serverId)}` : "—"}</td>
                      <td>{describeSpanMs(h.bankedMs)}</td>
                      <td className="hint">{h.since ? <Time iso={h.since} /> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Explanation>
            A held member&apos;s permanent VIP is the group&apos;s and lasts until they leave —
            group-wide grants and revokes skip it. VIP staff grant them meanwhile is added to the frozen
            time they get back, and so are rewards unless this perk says they don&apos;t. Staff can
            still revoke or cut that frozen time for one member (VIPs
            tab or their profile); the group&apos;s VIP stays while they are listed. Adding or removing
            members of this group takes VIP grant or VIP revoke on these servers too.
          </Explanation>
          {canEdit && (
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button className="mini" onClick={startEdit}>Change</button>
              <button className="mini danger" onClick={onSwitchOff}>Switch off…</button>
            </div>
          )}
        </>
      )}

      {editing && (
        <div className="pa-fields">
          {games.length > 1 && (
            <label className="inline">Game
              <select value={game} onChange={(e) => { setGame(e.target.value); setScope(defaultScope(e.target.value)); }} style={{ marginLeft: 6 }}>
                {games.map((g) => <option key={g} value={g}>{label(g)}</option>)}
              </select>
            </label>
          )}
          {game && <ServerScopePicker capability="vip.grant" game={game} value={scope} onChange={setScope} label="Permanent VIP on" />}
          {/* The picker hides itself with fewer than two servers to choose from; the rule still
              needs saying, from the rule itself rather than from what this person can act on. */}
          {game && allowed.length < 2 && <p className="hint mt-0">Covers {perkReach({ game, scope, severanceMinutes: 0 }, label(game), numberOf)}.</p>}
          <label className="inline">Severance on leaving
            <span className="control-row" style={{ marginLeft: 6 }}>
              <input type="number" min={0} step="any" style={{ width: 90 }} value={sevRaw} onChange={(e) => setSevRaw(stripLeadingZeros(e.target.value))} />
              <select value={sevUnit} onChange={(e) => setSevUnit(e.target.value as VipUnit)}>
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
            </span>
          </label>
          <p className="hint mt-0">
            Timed VIP added on top of the frozen time when someone leaves the group — 0 for none.
            Switching the perk off or deleting the group asks each time whether to pay it.
            {perk && " Narrowing the servers ends the permanent VIP on the ones dropped, the same way."}
          </p>
          <Toggle checked={bankRewards} onChange={setBankRewards}
            label={bankRewards ? "Rewards add to their frozen VIP" : "Rewards don't add to their frozen VIP"} />
          <Explanation>
            <p className="mt-0">
              Rewards are seed rewards (and the bridge), game rewards, player triggers, VIP shop
              purchases and gifts, payouts and the registration welcome.
            </p>
            <p>
              On, a member keeps earning while listed: the time waits beneath the group&apos;s VIP and
              comes back with the rest when they leave. Off, the group&apos;s VIP takes a reward the way
              a permanent VIP of their own does — nothing is added, and the VIP shop refunds instead of
              charging. A grant staff make by hand still adds to the frozen time. Switching it off keeps
              the time already frozen; rewards earned while it is off are not saved for later.
            </p>
          </Explanation>
          <div className="row" style={{ gap: 8 }}>
            <button onClick={save} disabled={busy || blockedWhy !== ""}>{busy ? "Saving…" : perk ? "Save perk" : "Switch the perk on"}</button>
            <button className="ghost" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
          </div>
          {blockedWhy && <p className="hint" style={{ marginTop: 4 }}>{blockedWhy}</p>}
          {/* Not a block — the API decides, from servers this list may not show. */}
          {!blockedWhy && reachNotes.map((n) => <p key={n} className="hint" style={{ marginTop: 4 }}>{n}</p>)}
        </div>
      )}
    </>
  );
}

/**
 * Ending a perk — switching it off, or deleting the group carrying it — and the one question it
 * cannot answer by default: does the severance get paid? With a severance set, nothing is
 * preselected; the button waits for an answer. The frozen timed VIP comes back either way.
 */
function EndPerkDialog({ kind, group, heldPlayers, onCancel, onConfirm }: {
  kind: "off" | "delete";
  group: Group;
  heldPlayers: number | null;
  onCancel: () => void;
  onConfirm: (severance: boolean) => Promise<void>;
}) {
  const sev = group.vipPerk?.severanceMinutes ?? 0;
  const [choice, setChoice] = useState<"yes" | "no" | null>(sev ? null : "no");
  const [busy, setBusy] = useState(false);
  const ends = heldPlayers === 0
    ? "Nobody holds permanent VIP through it right now, so no VIP changes."
    : `${heldPlayers === null ? "Every member's" : `${heldPlayers} player${heldPlayers === 1 ? "'s" : "s'"}`} permanent VIP from this group ends within a minute or so. The timed VIP frozen under it comes back either way.`;
  return (
    <Modal title={kind === "delete" ? `Delete group “${group.name}”?` : `Switch off the VIP perk on “${group.name}”?`} onClose={onCancel} busy={busy} className="confirm-modal">
      <div className="confirm-body">
        {kind === "delete" && <p className="mt-0">The group and its member list go away ({group.memberCount} member{group.memberCount === 1 ? "" : "s"}).</p>}
        <p className={kind === "delete" ? "" : "mt-0"}>{ends}</p>
        {sev > 0 && (
          <div className="pa-fields" role="radiogroup" aria-label="Severance">
            <label className="inline"><input type="radio" name="sev" checked={choice === "yes"} onChange={() => setChoice("yes")} /> Pay the severance — {describeMinutes(sev)} on top</label>
            <label className="inline"><input type="radio" name="sev" checked={choice === "no"} onChange={() => setChoice("no")} /> No severance — only the frozen time comes back</label>
          </div>
        )}
      </div>
      <div className="pa-actions">
        <button className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="danger" disabled={busy || choice === null}
          onClick={async () => { setBusy(true); try { await onConfirm(choice === "yes"); } finally { setBusy(false); } }}>
          {busy ? "Working…" : kind === "delete" ? "Delete group" : "Switch off"}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Pick the community Discord role a group follows. The role list takes the Users or Economy
 * permission to read; without it, the role's id can be pasted instead — the API checks it either
 * way, and refuses a role the server does not have.
 */
function DiscordRolePicker({ current, onSave, onCancel }: { current: string | null; onSave: (roleId: string) => void; onCancel: () => void }) {
  const [roles, setRoles] = useState<GuildRole[] | null>(null);
  const [failed, setFailed] = useState("");
  // No community server is set, so the STAFF server stands in: right for a one-server community,
  // the wrong people entirely for a two-server one (see Economy's claim gates).
  const [fellBack, setFellBack] = useState(false);
  const [pick, setPick] = useState(current ?? "");
  useEffect(() => {
    let alive = true;
    api<{ roles?: GuildRole[]; error?: string; fellBack?: boolean }>("/discord/roles?guild=community")
      .then((r) => { if (!alive) return; setRoles(r.roles ?? []); setFellBack(r.fellBack === true); if (r.error && !(r.roles ?? []).length) setFailed(r.error); })
      .catch((e) => { if (alive) { setRoles([]); setFailed((e as Error).message); } });
    return () => { alive = false; };
  }, []);
  const listed = roles && roles.length > 0;
  return (
    <div className="pa-fields" style={{ marginTop: 6 }}>
      {fellBack && (
        <Callout variant="warn">
          These are your <strong>staff</strong> Discord server&apos;s roles — no community server is set. If your
          players are in a separate public Discord, set that server&apos;s id under Administration → Discord first:
          a role from this list would sync your staff into the group. If you run one Discord for everything, this
          is fine.
        </Callout>
      )}
      {listed
        ? <label className="inline">Discord role
            <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ marginLeft: 6 }}>
              <option value="">— pick a role —</option>
              {roles!.map((r) => <option key={r.id} value={r.id}>@{r.name}</option>)}
            </select>
          </label>
        : <label className="inline">Discord role id
            <input value={pick} onChange={(e) => setPick(e.target.value.trim())} placeholder="e.g. 123456789012345678" style={{ marginLeft: 6, width: 220 }} />
          </label>}
      {!listed && roles !== null && (
        <p className="hint mt-0">The roles couldn&apos;t be listed{failed ? ` (${failed})` : ""} — listing them takes the Users or Economy permission. Paste the role&apos;s id instead: in Discord, Server Settings → Roles → right-click the role → Copy Role ID.</p>
      )}
      <Explanation>
        Every few minutes the group is brought in step with the role in your community Discord: holders with a
        linked game account are added (each linked game), and members the sync added are removed once they lose
        it. Anyone added here by hand stays. If Discord can&apos;t be read, nothing changes until it can. Linking
        takes the keys the group&apos;s VIP perk and rules use for adding and removing members.
      </Explanation>
      <div className="row" style={{ gap: 8 }}>
        <button className="mini" disabled={!pick} onClick={() => onSave(pick)}>Link role</button>
        <button className="mini ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
