"use client";
/**
 * Per-player actions, two presentations:
 *  - variant="row" (default): a bare "⋯" for table rows (the Live roster), holding every action.
 *    It carried shortcut icons too until they proved to be pure chrome — see the render.
 *  - variant="profile": icons are STATUS indicators only (lit when the player is watched / VIP /
 *    temp-banned / perma-banned / Discord-linked); every action — including the
 *    ones with status icons — is applied from the "⋯" overflow menu.
 * Actions needing input open a small modal. Wired to existing endpoints:
 *  - watch/VIP + comment use our db id (/players/:dbId/flags, /notes)
 *  - message/kick/punish/temp/perma/unban/switch use /servers/:serverId/actions (active mode only)
 *  - Discord links out to a linked account, or sets one
 */
import { useState } from "react";
import { api } from "../lib/api";
import { useServers } from "../lib/servers";
import { useGrants } from "../lib/grants";
import { canOnServer, hasCap } from "../lib/access";
import { useAnchoredMenu } from "../lib/anchoredMenu";
import { useRequestMode } from "../lib/requestMode";
import { useToast, useConfirm } from "../lib/feedback";
import { TemplatePicker } from "./TemplatePicker";
import { EditVip } from "./EditVip";
import { EditConsoleAdmin } from "./EditConsoleAdmin";
import { fmtRelative, wallToIso, zoneLabel } from "../lib/time";
import { isFuture } from "../lib/expiry";
import { ActionResult, Modal, Nothing, ObserveBanner, SkeletonLines, Explanation } from "./ui";
import { ServerScopePicker } from "./ServerScopePicker";
import { resolveBanScope, type BanScope } from "../lib/banScope";
import { PlaceholderHint } from "./Placeholders";

export interface ActionPlayer {
  playerId: string;          // game platform id (for server actions)
  dbId?: string | null;      // our internal id (for flags/comment/discord)
  name?: string;
  watch?: boolean;
  /** watch provenance, for the status chip's tooltip (profile variant). */
  watchReason?: string | null;
  watchBy?: string | null;
  vip?: boolean;
  /** VIP pause (a VIP timeout): set when any of their grants is paused — drives the red star. */
  vipPausedUntil?: string | null;
  vipPauseReason?: string | null;
  vipPauseMode?: "running" | "banked" | null;
  discordId?: string | null;
  /** live console-admin grant(s) — the 🎥 chip. The tooltip names where and under which group. */
  consoleAdmin?: { serverName: string; adminGroup: string }[] | null;
  /** community role badges, derived from their linked Discord account's roles (Discord → badges). */
  badges?: { emoji: string; label: string }[] | null;
  /** active moderation state (profile variant lights status icons from these) */
  tempBan?: { expiresAt: string | null; reason?: string | null } | null;
  permaBan?: { ts?: string; reason?: string | null } | null;
}

type Kind = "message" | "kick" | "punish" | "tempban" | "permaban" | "unban_temp" | "unban_perma" | "switch" | "switch_death" | "comment" | "discord" | "group" | "watch";
/**
 * Per-action metadata.
 *  - `fields`: what the modal asks for. Empty = nothing to type, so the action is CONFIRMED
 *    rather than fired on click (a mis-click used to switch a player's team mid-match).
 *  - `needsReason`: punitive actions must say why. The reason is what the player sees and what
 *    lands in the audit trail and Discord — a blank one helps nobody.
 *  - `confirm`: plain-words description of what is about to happen, shown in the confirm dialog.
 *  - `done`: past-tense success message for the toast.
 */
const META: Record<Kind, {
  title: string;
  fields: ("reason" | "hours" | "until" | "category" | "message" | "note" | "discordId")[];
  server?: boolean; danger?: boolean; needsReason?: boolean;
  confirm?: string;
  done: string;
}> = {
  message: { title: "Send message", fields: ["message"], server: true, done: "Message sent to" },
  kick: { title: "Kick player", fields: ["reason"], server: true, danger: true, needsReason: true, done: "Kicked" },
  punish: { title: "Punish player", fields: ["reason"], server: true, danger: true, needsReason: true, done: "Punished" },
  tempban: { title: "Temp ban", fields: ["reason", "hours", "until", "category"], server: true, danger: true, needsReason: true, done: "Temp banned" },
  permaban: { title: "Perma ban", fields: ["reason", "category"], server: true, danger: true, needsReason: true, done: "Perma banned" },
  unban_temp: { title: "Remove temp ban", fields: [], server: true, confirm: "They will be able to rejoin the server immediately.", done: "Temp ban removed for" },
  unban_perma: { title: "Remove perma ban", fields: [], server: true, danger: true, confirm: "This lifts a permanent ban. They will be able to rejoin the server immediately.", done: "Perma ban removed for" },
  switch: { title: "Switch team now", fields: [], server: true, confirm: "They are moved to the other team straight away, mid-match.", done: "Switched teams:" },
  switch_death: { title: "Switch team on death", fields: [], server: true, confirm: "They stay put until their next death, then move to the other team.", done: "Team switch queued for" },
  comment: { title: "Add comment", fields: ["note"], done: "Comment added to" },
  discord: { title: "Link Discord account", fields: ["discordId"], done: "Discord account linked to" },
  // Watching is a moderation record — the reason is the record. Removal stays a plain toggle.
  watch: { title: "Add to watchlist", fields: ["reason"], needsReason: true, done: "Watchlisted" },
  // Membership toggles apply immediately inside the modal, so there's no submit step.
  group: { title: "Player groups", fields: [], done: "Groups updated for" },
};

/**
 * The actions that can name more than one server — the API's FANOUT_ACTIONS, client side.
 *
 * Bans only. A ban is a standing decision about the community that the game happens to store per
 * server; a kick or a punish happens to whoever is connected right now, and "kick them from a
 * server they are not on" is not a stronger action, it is no action.
 */
const FANOUT_KINDS = new Set<Kind>(["tempban", "permaban", "unban_temp", "unban_perma"]);
/**
 * Which permission each server action needs. The fan-out kinds use it to keep the scope picker
 * from listing a server that would only 403; EVERY server action uses it to label the confirm
 * honestly — "Send for approval" when the user lacks the write (the API files it as a request),
 * "Add to request" while the cart is open. Every kind asks — the groups modal too, whose toggles
 * the API files (or captures) one by one.
 */
const CAP_FOR: Partial<Record<Kind, string>> = {
  tempban: "action.tempban", permaban: "action.permaban",
  unban_temp: "action.unban", unban_perma: "action.unban",
  message: "action.message", kick: "action.kick", punish: "action.punish",
  switch: "action.switch", switch_death: "action.switch_death",
  // A watch is a moderation decision about a person, so it asks and captures like the rest. It sat
  // out of this list at first, on the reading that a profile record is not an action — which made
  // it the one menu item that fired mid-build while the bar overhead read "nothing executed", and
  // the one a moderator without the permission could only be refused rather than ask for.
  watch: "player.watchlist",
  // A comment and a linked account are asked for like the rest: everything a role can see, it can
  // request (the owner's rule), so lacking the permission files them rather than hiding them.
  comment: "player.notes",
  discord: "player.links",
};
/** Capabilities a server never narrows: the watchlist, notes and linked accounts are facts about a
 *  PERSON, so the API tests them "anywhere" and so must the labels. */
const UNSCOPED_CAPS = new Set(["player.watchlist", "player.notes", "player.links"]);

/** The overflow glyph: three dots on the box's own centre line, independent of font metrics.
 *  Exported so the roster's bulk menu wears the same mark as the per-player one below it. */
export const DOTS = (
  <svg viewBox="0 0 24 24" width="1.15em" height="1.15em" fill="currentColor" aria-hidden>
    <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
  </svg>
);

export function PlayerActions({ player, serverId, canActions, canGroups, canVip, canVipPause, onChanged, variant = "row" }: {
  player: ActionPlayer; serverId?: string; canActions?: boolean; canGroups?: boolean; canVip?: boolean; canVipPause?: boolean; onChanged?: () => void;
  variant?: "row" | "profile";
}) {
  const { serverId: activeServer, server, servers } = useServers();
  const grants = useGrants();
  const requestMode = useRequestMode();
  const sid = serverId ?? activeServer;
  const toast = useToast();
  const confirm = useConfirm();
  const who = player.name || player.playerId;
  const [menu, setMenu] = useState(false);
  // Fixed-positioned, so the roster's scroll container cannot clip it — see useAnchoredMenu.
  const { ref: menuRef, menuRef: dropRef, style: menuStyle } = useAnchoredMenu(menu, () => setMenu(false));
  const [editVip, setEditVip] = useState(false);
  const [editAdmin, setEditAdmin] = useState(false);
  /**
   * Console admin is read straight off the grants rather than passed in like the others.
   *
   * Every caller of this menu would otherwise need a new prop threaded through it, and the answer
   * is the same one `eligible()` already computes below — whether this staff member may manage the
   * game's admin list ON THIS SERVER. Scoped, so someone who administers one server does not get
   * the option on another.
   */
  const canAdmins = Boolean(sid) && canOnServer(grants, "server.admins", sid!);
  // Same pattern for taking VIP time back: it is the revoke power in smaller units, so it reads
  // vip.revoke off the grants directly — global like canVip is at its call sites, because the
  // popup's all-servers option reaches beyond the pinned server anyway.
  const canVipRemove = hasCap(grants, "vip.revoke", "write");
  const [pending, setPending] = useState<Kind | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [groupRows, setGroupRows] = useState<{ id: string; name: string; memberCount: number; member: boolean }[] | null>(null);
  const [f, setF] = useState({ reason: "", hours: "24", until: "", category: "", message: "", note: "", discordId: "" });
  /**
   * The servers a ban or unban reaches. Defaults to the one the panel is pinned to, so the
   * ordinary single-server case is unchanged and nothing widens by accident — reaching further is
   * always a deliberate tick.
   */
  const [scope, setScope] = useState<BanScope>({ mode: "servers", serverIds: [] });
  // The game the acting server runs bounds where a ban can reach: player ids do not cross games,
  // so only servers of the SAME game are eligible fan-out targets (mirrors the API's check).
  const actingGame = servers.find((sv) => sv.id === sid)?.game;
  const eligible = (kind: Kind) => servers.filter((sv) => sv.game === actingGame && canOnServer(grants, CAP_FOR[kind] ?? "", sv.id));
  /** No write on the pinned server: the same dialog, but the confirm FILES a request instead of
   *  firing — lacking the permission IS the ask, and the button says which one it is.
   *
   *  A watch is community-wide (the API gates it on "anywhere", because a watch follows the player
   *  to every server), so asking whether it needs approval HERE is the wrong question: an admin
   *  who watchlists on the server they run would have been told their own action needed a
   *  signature whenever the panel was pinned somewhere else. */
  const askMode = (kind: Kind) => {
    const cap = CAP_FOR[kind];
    if (!cap) return false;
    if (UNSCOPED_CAPS.has(cap)) return !hasCap(grants, cap, "write");
    return Boolean(sid && !canOnServer(grants, cap, sid, "write"));
  };

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  /** The watchlist is the only player FLAG left — VIP is a grant, and its star is read-only. */
  async function toggleFlag(which: "watchlist") {
    if (!player.dbId) return;
    const current = player.watch;
    // Never on a stray click — removal takes them off the active list (the reason is kept
    // forever in their watch history on the profile).
    if (current) {
      // Curation is its own permission, and lacking it now means ASKING rather than being refused —
      // so the confirm says which of the two this click is before it happens.
      const mayCurate = hasCap(grants, "player.watchlist.curate", "write");
      const ok = await confirm({
        title: `Remove ${who} from the watchlist?`,
        body: `This closes EVERY watch reason on them — ${player.watchReason ? `"${player.watchReason}"${player.watchBy ? ` (by ${player.watchBy})` : ""} and any others` : "however many staff have recorded"}. All of it stays on the profile for repeat-offender checks; to drop just one reason, use the Watchlist panel on their profile.${mayCurate ? "" : " You don't hold this permission, so it is sent for approval instead of happening now."}`,
        confirmLabel: mayCurate ? "Remove" : "Send for approval",
        danger: mayCurate,
      });
      if (!ok) return;
    }
    try {
      const r = await api<{ captured?: boolean; lines?: number; requested?: boolean }>(
        `/players/${player.dbId}/flags`,
        { method: "PATCH", raw202: true, body: { [which]: !current, ...(requestMode.building ? { draft: true } : {}) } },
      );
      if (r.captured) {
        requestMode.captured(r.lines ?? requestMode.count + 1);
        toast.success(`Added to request — ${current ? "take off" : "add to"} the watchlist (${r.lines ?? "?"} captured)`);
        return;
      }
      if (r.requested) {
        toast.success(`Sent for approval — ${current ? "taking" : "adding"} ${who} ${current ? "off" : "to"} the watchlist waits for a signature`);
        onChanged?.();
        return;
      }
      toast.success(current ? `Removed ${who} from the watchlist` : `Added ${who} to the watchlist`);
      onChanged?.();
    } catch (e) { toast.error((e as Error).message); }
  }

  // The groups modal: every group, with this player's membership togglable in place. Each toggle is
  // its own write — done, sent for approval, or captured into the request being built — so the
  // modal has no submit, only Close.
  function openGroups() {
    setMenu(false); setErr(""); setGroupRows(null); setPending("group");
    Promise.all([
      api<{ groups: { id: string; name: string; memberCount: number }[] }>("/player-groups"),
      api<{ groups: { id: string }[] }>(`/player-groups/for/${encodeURIComponent(player.playerId)}`),
    ]).then(([all, mine]) => {
      const memberOf = new Set(mine.groups.map((g) => g.id));
      setGroupRows(all.groups.map((g) => ({ ...g, member: memberOf.has(g.id) })));
    }).catch((e) => setErr((e as Error).message));
  }

  async function toggleGroup(g: { id: string; name: string; member: boolean }) {
    try {
      if (g.member) await api(`/player-groups/${g.id}/members/${encodeURIComponent(player.playerId)}`, { method: "DELETE" });
      else await api(`/player-groups/${g.id}/members`, { method: "POST", body: { playerId: player.playerId, playerName: player.name } });
      toast.success(g.member ? `${who} removed from “${g.name}”` : `${who} added to “${g.name}”`);
      setGroupRows((rows) => rows?.map((r) => (r.id === g.id ? { ...r, member: !g.member, memberCount: r.memberCount + (g.member ? -1 : 1) } : r)) ?? null);
      onChanged?.();
    } catch (e) { toast.error((e as Error).message); }
  }

  function openDiscord() {
    if (player.discordId) { window.open(`https://discord.com/users/${player.discordId}`, "_blank", "noopener"); return; }
    setMenu(false); setErr("");
    setF((s) => ({ ...s, discordId: "" }));
    setPending("discord");
  }

  async function open(kind: Kind) {
    setMenu(false); setErr("");
    // The watch dialog's expiry shares the `until` slot with tempban's date; a leftover ban date
    // must not silently become a watch expiry.
    setF((s) => ({ ...s, reason: "", message: "", note: "", ...(kind === "watch" ? { until: "" } : {}) }));
    // Nothing to type still means something happens to a real player — ask first rather than
    // firing on the click that opened the menu item.
    // An action with nothing to type is normally a straight confirm. A ban verb in a community
    // with more than one server has something to say after all — which servers — so it earns the
    // modal, and the confirm stays for the single-server case where there is no choice to make.
    const choosable = FANOUT_KINDS.has(kind) && eligible(kind).length > 1;
    if (META[kind].fields.length === 0 && !choosable) {
      // The confirm must say what the click actually does: while the cart is open it captures,
      // and without the write it files for approval — claiming "they are moved straight away"
      // on either path would be the exact lie the button labels exist to avoid.
      const capturing = requestMode.building && CAP_FOR[kind];
      const ok = await confirm({
        title: `${META[kind].title} — ${who}?`,
        body: capturing ? "Added to your request — nothing happens until you review and submit."
          : askMode(kind) ? "You don't hold this permission here, so this is sent for approval instead of happening now."
          : META[kind].confirm,
        confirmLabel: capturing ? "Add to request" : askMode(kind) ? "Send for approval" : META[kind].title,
        danger: !capturing && !askMode(kind) && META[kind].danger,
      });
      // The pinned-server scope is passed EXPLICITLY: this path never opens the modal, so the
      // `scope` state was never seeded — a single-server unban resolved to no servers at all and
      // threw "pick at least one server" into a modal that was not open. Setting the state and
      // then calling run() would not fix it either: run() closes over the pre-set value.
      if (ok) void run(kind, { mode: "servers", serverIds: sid ? [sid] : [] });
      return;
    }
    if (FANOUT_KINDS.has(kind)) setScope({ mode: "servers", serverIds: sid ? [sid] : [] });
    setPending(kind);
  }

  async function run(kind: Kind, runScope: BanScope = scope) {
    setBusy(true); setErr("");
    // Anything the action paid on the way, said in the success toast (a first Discord link pays
    // the registration welcome).
    let paid = "";
    try {
      if (kind === "discord") {
        if (!player.dbId) throw new Error("no profile for this player yet");
        const r = await api<{ welcome?: string[] }>(`/players/${player.dbId}/links`, { method: "PATCH", body: { provider: "discord", externalId: f.discordId.trim() } });
        if (r.welcome?.length) paid = ` — welcome bonus paid: ${r.welcome.join(" and ")}`;
      } else if (kind === "watch") {
        if (!player.dbId) throw new Error("no profile for this player yet");
        // A reason ROW, not a flag flip: on a watched player it lands beside the existing
        // reasons; on an unwatched one it arms the watch. The optional date makes it lapse on
        // its own — the expiry sweep lifts the 👁 when the last reason runs out.
        const r = await api<{ captured?: boolean; lines?: number; requested?: boolean }>(
          `/players/${player.dbId}/watch/reasons`,
          { method: "POST", raw202: true, body: { reason: f.reason.trim(), ...(f.until ? { expiresAt: wallToIso(f.until) } : {}), ...(requestMode.building ? { draft: true } : {}) } },
        );
        if (r.captured) {
          setPending(null);
          requestMode.captured(r.lines ?? requestMode.count + 1);
          toast.success(`Added to request — watch ${who} (${r.lines ?? "?"} captured)`);
          return;
        }
        if (r.requested) {
          setPending(null);
          toast.success(`Sent for approval — watching ${who} waits for a signature (Moderation → Requests)`);
          onChanged?.();
          return;
        }
      } else if (kind === "comment") {
        if (!player.dbId) throw new Error("no profile for this player yet");
        await api(`/players/${player.dbId}/notes`, { method: "POST", body: { body: f.note.trim() } });
      } else {
        if (!sid) throw new Error("no server selected");
        const fanout = FANOUT_KINDS.has(kind);
        // Request mode captures ONE server per line, so the scope machinery stands down entirely.
        const capturing = requestMode.building;
        const reach = fanout && !capturing ? resolveBanScope(runScope, eligible(kind)) : [];
        // No write anywhere but ask HERE: fall through to the pinned server unscoped — the API
        // files it as an approval request for this one server (requests are per-server for now).
        const asking = fanout && !capturing && !reach.length && askMode(kind);
        if (fanout && !capturing && !reach.length && !asking) throw new Error("pick at least one server");
        // Sent whenever it is more than the pinned server OR it is a standing rule, because
        // "everywhere" has to reach the API as "everywhere" even when that is one server today —
        // collapsing it to a single id would throw away the part that covers server two tomorrow.
        const sendScope = fanout && !asking && !capturing && (runScope.mode !== "servers" || reach.length > 1);
        const r = await api<{ results?: { serverName: string; ok: boolean; error?: string }[]; applied?: number; requested?: boolean; captured?: boolean; lines?: number; split?: { appliedHours: number; requestedHours: number } }>(
          `/servers/${sid}/actions`,
          // "Until a date" is the sentence staff mean; hours is the number the game takes. The
          // date wins when both are set, converted at click time. Sent ONLY when this action's
          // form offers the field: the state is shared across every modal, so its "24" default
          // otherwise rides along on a message or a kick and ends up recorded — the profile then
          // shows "Duration: 24 hours" on an action that has no duration.
          // playerName rides along because a REQUEST outlives the roster it was made from: an
          // approver reading the queue tomorrow, or the requester reading their own record, gets
          // a name rather than a raw platform id. Executed actions resolve names from the
          // directory; a filed line has only what was captured with it.
          { method: "POST", raw202: true, body: { action: kind, playerId: player.playerId, playerName: player.name, reason: f.reason.trim(), message: f.message.trim(),
            ...(META[kind].fields.includes("hours")
              ? { hours: f.until && kind === "tempban" ? Math.max(1, Math.ceil((Date.parse(wallToIso(f.until) ?? "") - Date.now()) / 3_600_000)) : Number(f.hours) || 0 }
              : {}),
            ...(f.category.trim() ? { category: f.category.trim() } : {}), ...(sendScope ? { scope: runScope } : {}), ...(capturing ? { draft: true } : {}) } },
        );
        // Captured, not executed: the cart's whole promise. The bar count is the receipt.
        if (r.captured) {
          setPending(null);
          requestMode.captured(r.lines ?? requestMode.count + 1);
          toast.success(`Added to request — ${META[kind].title.toLowerCase()} on ${who} (${r.lines ?? "?"} captured)`);
          return;
        }
        // The over-cap split: what was theirs to give landed; the rest went for a signature.
        // Saying only "banned" would hide half of what just happened.
        if (r.split) {
          setPending(null);
          toast.success(`Banned ${r.split.appliedHours}h now (your limit) — the rest of the ${r.split.requestedHours}h asked went for approval (Moderation → Requests)`);
          onChanged?.();
          return;
        }
        // 202: nothing happened yet — the action is FILED, and saying "done" here would be the
        // lie the whole approvals feature exists to avoid.
        if (r.requested) {
          setPending(null);
          toast.success(`Sent for approval — ${META[kind].title.toLowerCase()} on ${who} waits for a signature (Moderation → Requests)`);
          onChanged?.();
          return;
        }
        // More than one server means more than one outcome. A ban that landed on two of three is
        // not a success to announce and walk away from — name the one that refused and why.
        const refused = (r.results ?? []).filter((x) => !x.ok);
        if (fanout && reach.length > 1 && refused.length) {
          throw new Error(`${r.applied ?? 0} of ${r.results?.length ?? 0} servers — ${refused.map((x) => `${x.serverName}: ${x.error}`).join("; ")}`);
        }
      }
      setPending(null);
      toast.success(`${META[kind].done} ${who}${paid}`);
      onChanged?.();
    } catch (e) {
      // Confirm-path actions (single-server unbans, team switches) have no modal open, so the
      // inline error slot renders nowhere — a refusal was completely silent, which staff read as
      // the button doing nothing. The toast is the surface that always exists.
      const msg = (e as Error).message;
      setErr(msg);
      if (!pending) toast.error(msg);
    }
    finally { setBusy(false); }
  }

  /** The watch dialog's one dynamic label: on an already-watched player the same action reads as
   *  what it now does — contribute a reason — rather than as re-adding them. */
  const actionTitle = (k: Kind) => (k === "watch" && player.watch ? "Add watch reason" : META[k].title);

  const iconBtn = (title: string, glyph: React.ReactNode, onClick: () => void, cls = "", ref?: React.Ref<HTMLButtonElement>) =>
    <button ref={ref} type="button" className={`ico-btn ${cls}`} title={title} aria-label={title} onClick={onClick}>{glyph}</button>;

  // Status chips (profile variant): shown only when the state is ACTIVE — a lit icon means
  // "this player currently has this". They display state; the ⋯ menu changes it.
  const chip = (title: string, glyph: React.ReactNode, cls: string, onClick?: () => void) =>
    onClick
      ? <button type="button" className={`status-chip ${cls}`} title={title} aria-label={title} onClick={onClick}>{glyph}</button>
      : <span className={`status-chip ${cls}`} title={title} aria-label={title}>{glyph}</span>;

  const vipPausedNow = isFuture(player.vipPausedUntil);

  // Why the submit button is disabled, said out loud. A greyed-out button with no explanation
  // is the single most common "it's broken" report from non-technical staff.
  const meta = pending ? META[pending] : null;
  const blockedWhy = !meta ? ""
    // A ban with no server ticked would silently do nothing; say so on the button, like every
    // other blocked submit here, rather than failing after the click. Not while capturing or
    // asking, though: both paths ignore the scope entirely (one server per line / the pinned
    // server), and a user with no write ANYWHERE has an empty picker — blocking them here made
    // sending a ban for approval impossible.
    : pending && FANOUT_KINDS.has(pending) && !requestMode.building && !askMode(pending) && !resolveBanScope(scope, eligible(pending)).length ? "Pick at least one server."
    : meta.server && !sid ? "Pick a server first (top of the page)."
    : pending === "watch" && !f.reason.trim() ? "Type a reason — it's the watch record other staff read later."
    : meta.needsReason && !f.reason.trim() ? "Type a reason — the player sees it, and it goes in the log."
    : pending === "message" && !f.message.trim() ? "Type a message to send."
    : pending === "comment" && !f.note.trim() ? "Type a comment."
    : pending === "discord" && !/^\d{5,}$/.test(f.discordId.trim()) ? "Paste the numeric Discord user id (digits only)."
    : "";
  const blocked = blockedWhy !== "";

  const menuItems = (
    <div ref={dropRef} className="pa-dropdown" style={menuStyle} onMouseLeave={() => setMenu(false)}>
      {/* Watching is additive now: an already-watched player takes MORE reasons — the add option
          used to vanish the moment anyone else had watched them first, so a second staff
          member's concern had nowhere to go. Removal (which closes EVERY reason, other staff's
          included) is curation, its own permission.
          BOTH are offered to everyone this menu is offered to, permission or not: they file as
          approval requests now, and the confirm says which it is. Hiding them from whoever lacks
          the write — which is what `canFlags` did — took the one action a newer moderator most
          often needs to ask for and made it the one thing they could not ask for. The menu is the
          same for everyone; the button says what the click will do. */}
      {player.dbId && <button className="pa-mi" onClick={() => open("watch")}>👁 {player.watch ? "Add watch reason" : "Add to watchlist"}</button>}
      {player.dbId && player.watch && <button className="pa-mi" onClick={() => { setMenu(false); void toggleFlag("watchlist"); }}>👁 Remove from watchlist</button>}
      {/* One popup for everything VIP: Add (vip.grant), Remove time (vip.revoke) and Pause
          (vip.pause) as separate tabs. Offered to everyone the action menus are offered to —
          the Add tab needs no grant (lacking vip.grant files the grant as an approval request
          instead of applying it), and only the personal lockout (`canActions` false) hides it,
          like every other action here. Remove is read straight off the grants like console
          admin above — every caller gets it without a new prop threaded through. */}
      {(canActions || canVip || canVipPause || canVipRemove) && <button className="pa-mi" onClick={() => { setMenu(false); setEditVip(true); }}>★ Edit VIP…</button>}
      {/* The GAME's admin list — admin camera and in-game powers. It sits next to VIP because it is
          the same kind of decision (a grant on a player, on one server or all, with an expiry), and
          because reaching it used to mean building a player group and running a bulk action. */}
      {canAdmins && <button className="pa-mi" onClick={() => { setMenu(false); setEditAdmin(true); }}>🎥 Console admin…</button>}
      {canActions && <button className="pa-mi" onClick={() => open("message")}>💬 Send message</button>}
      {/* Plain text, like every other item. Colouring the routine actions amber read as a warning
          on the three a moderator uses most, and left nothing louder for the ones that are. */}
      {canActions && <button className="pa-mi" onClick={() => open("punish")}>⚠️ Punish</button>}
      {canActions && <button className="pa-mi" onClick={() => open("kick")}>🥾 Kick</button>}
      {canActions && <button className="pa-mi" onClick={() => open("tempban")}>⏱ Temp ban</button>}
      {canActions && <button className="pa-mi err" onClick={() => open("permaban")}>⛔ Perma ban</button>}
      {canActions && player.tempBan && <button className="pa-mi" onClick={() => open("unban_temp")}>♻️ Remove temp ban</button>}
      {canActions && player.permaBan && <button className="pa-mi" onClick={() => open("unban_perma")}>♻️ Remove perma ban</button>}
      {canActions && <button className="pa-mi" onClick={() => open("switch")}>🔄 Switch team</button>}
      {canActions && <button className="pa-mi" onClick={() => open("switch_death")}>🔄 Switch on death</button>}
      {/* Its OWN permission, read off the grants. It was gated on the watchlist write — so somebody
          who may write notes and not watch players never saw it, and somebody who may watch and
          not write notes saw it and got a 403 for their trouble. Whoever can read notes sees it:
          without the write, the comment is sent for approval like any other action. */}
      {hasCap(grants, "player.notes") && player.dbId && <button className="pa-mi" onClick={() => open("comment")}>📝 Add comment</button>}
      {canGroups && <button className="pa-mi" onClick={openGroups}>👥 Groups…</button>}
      {player.dbId && <button className="pa-mi" onClick={openDiscord}>🎮 {player.discordId ? "Open Discord profile" : "Link Discord…"}</button>}
    </div>
  );

  return (
    <span className={`player-actions ${variant === "profile" ? "pa-profile" : ""}`} onClick={(e) => e.stopPropagation()}>
      {variant === "profile" ? (
        <>
          {player.watch && chip(`On the watchlist${player.watchBy ? ` — by ${player.watchBy}` : ""}${player.watchReason ? `\n${player.watchReason}` : ""}`, "👁", "on")}
          {/* Paused VIP = the punishment star: red, crossed out, and the tooltip says why and
              how long is left. A normal VIP keeps the plain star. */}
          {vipPausedNow
            ? chip(`VIP paused ${fmtRelative(player.vipPausedUntil!)}${player.vipPauseMode === "banked" ? " · hours banked" : " · time keeps running"}${player.vipPauseReason ? ` — ${player.vipPauseReason}` : ""}`, "★", "vip-paused")
            : player.vip && chip("VIP", "★", "vip")}
          {/* Console admin — the admin camera. Same standing as the star: a live grant, per
              server, and the tooltip says where and under which admin group. */}
          {(player.consoleAdmin?.length ?? 0) > 0 &&
            chip(`Console admin (admin camera) — ${player.consoleAdmin!.map((a) => `${a.serverName}: ${a.adminGroup}`).join(", ")}`, "🎥", "on")}
          {player.tempBan && chip(`Temp banned${player.tempBan.expiresAt ? ` until ${fmtRelative(player.tempBan.expiresAt)}` : ""}${player.tempBan.reason ? ` — ${player.tempBan.reason}` : ""}`, "⏱", "warn")}
          {player.permaBan && chip(`Perma banned${player.permaBan.reason ? ` — ${player.permaBan.reason}` : ""}`, "⛔", "err")}
          {player.discordId && chip("Discord linked — open profile", "🎮", "on", openDiscord)}
          {/* Community role badges — an emoji per matched badge, in the order staff defined them.
              Plain (untinted) chips: the emoji IS the colour, and every badge tinted accent-blue
              read as one long smear instead of distinct marks. */}
          {(player.badges ?? []).map((b, i) => (
            <span key={i} className="status-chip plain" title={b.label} aria-label={b.label}>{b.emoji}</span>
          ))}
        </>
      ) : null /* A row gets the ⋯ and nothing else.
        There used to be six shortcut buttons here — watch, VIP, temp ban, perma ban, blacklist,
        Discord — repeated down a hundred-player roster, which is six hundred icons of chrome for
        actions that all exist in the ⋯ menu anyway. Worse, they were the far right of a table wide
        enough to need horizontal scrolling, so on a phone reaching them meant dragging the roster
        sideways and losing the name of the player you were acting on. The marks column already
        shows VIP and watched where you can see them, beside the name. */}
      <span className="pa-menu">
        {/* Drawn, not typed. The "⋯" character sits on whatever baseline the fallback font gives
            it, which on the profile put the dots visibly below the middle of their box while the
            buttons beside them centred correctly. Three circles in a centred viewBox cannot drift. */}
        {iconBtn(variant === "profile" ? "Actions" : "More", DOTS, () => setMenu((v) => !v), variant === "profile" ? "pa-more" : "", menuRef)}
        {menu && menuItems}
      </span>

      {editVip && (
        <EditVip player={player} serverId={sid} canAdd={Boolean(canVip)} canRemove={canVipRemove} canPause={Boolean(canVipPause)}
          onClose={() => setEditVip(false)} onChanged={onChanged} />
      )}

      {editAdmin && (
        <EditConsoleAdmin player={player} serverId={sid}
          onClose={() => setEditAdmin(false)} onChanged={onChanged} />
      )}

      {pending && (
        <Modal title={<>{actionTitle(pending)} <span className="muted">· {player.name || player.playerId}</span></>} onClose={() => setPending(null)} busy={busy}>
          <ObserveBanner server={server} />
          {pending === "group" && (
            <div className="pa-fields">
              {!groupRows && !err && <SkeletonLines lines={2} />}
              {groupRows && groupRows.length === 0 && <Nothing>No player groups yet — create one under Players → Groups.</Nothing>}
              {groupRows && groupRows.length > 0 && (
                <div>
                  {groupRows.map((g) => (
                    <div key={g.id} className="row" style={{ justifyContent: "space-between", alignItems: "center", padding: "4px 0" }}>
                      <span>{g.member ? "✓ " : ""}{g.name} <span className="muted">· {g.memberCount} member{g.memberCount === 1 ? "" : "s"}</span></span>
                      <button className={`mini ${g.member ? "ghost" : ""}`} onClick={() => toggleGroup(g)}>{g.member ? "Remove" : "Add"}</button>
                    </div>
                  ))}
                  <Explanation>Groups are bulk-action rosters — grant VIP or console admin, temp ban, or team-swap everyone in one go from Players → Groups.</Explanation>
                </div>
              )}
            </div>
          )}
          {/* The scope picker only where scope means something: capture takes one server per
              line, and an ask covers the pinned server — in both, ticks would do nothing. */}
          {pending !== "group" && FANOUT_KINDS.has(pending) && !requestMode.building && !askMode(pending) && (
            <ServerScopePicker capability={CAP_FOR[pending] ?? "action.permaban"} game={actingGame} value={scope} onChange={setScope} />
          )}
          {pending !== "group" && !requestMode.building && askMode(pending) && (
            <p className="hint notice">You don't hold this permission on this server — confirming sends the action for approval ({server?.name ?? "this server"}), and it happens only once someone signs it.</p>
          )}
          {pending !== "group" && <div className="pa-fields">
            {META[pending].fields.includes("message") && (
              <label>Message<textarea value={f.message} onChange={set("message")} rows={3} autoFocus />
                <TemplatePicker kind="message" onPick={(m) => setF((s) => ({ ...s, message: m }))} />
                <PlaceholderHint />
              </label>
            )}
            {META[pending].fields.includes("note") && <label>Note<textarea value={f.note} onChange={set("note")} rows={3} autoFocus /></label>}
            {/* Before the reason on purpose. The reason carries a preset list that grows with the
                library, and on a phone a long one pushed the duration field (and the submit
                button under it) off the bottom of the sheet, behind the keyboard. */}
            {META[pending].fields.includes("hours") && (
              <label>Hours
                <input type="number" min="1" value={f.hours} onChange={set("hours")} disabled={!!f.until} />
              </label>
            )}
            {META[pending].fields.includes("until") && (
              <label>…or until a date ({zoneLabel()})
                <input type="datetime-local" value={f.until} onChange={set("until")} />
                {f.until && <span className="hint">The date wins — hours are computed from it when you submit.</span>}
              </label>
            )}
            {/* The required field before the optional one — the reason is what the player sees
                and what unblocks the submit; the category is filing. */}
            {META[pending].fields.includes("reason") && (
              <label>Reason<input value={f.reason} onChange={set("reason")} autoFocus />
                <TemplatePicker kind="reason" onPick={(r) => setF((s) => ({ ...s, reason: r }))} />
                <PlaceholderHint />
              </label>
            )}
            {META[pending].fields.includes("category") && (
              <label>Category <span className="muted">(optional)</span>
                <input value={f.category} onChange={set("category")} placeholder="e.g. cheating, racism, ban evasion" />
                <span className="hint">A label for the ban record, so &ldquo;who is banned for cheating&rdquo; is a search, not a memory.</span>
              </label>
            )}
            {META[pending].fields.includes("discordId") && (
              <label>Discord user id
                <input value={f.discordId} onChange={set("discordId")} autoFocus placeholder="e.g. 123456789012345678" inputMode="numeric" />
                <span className="hint">In Discord: right-click the person → Copy User ID. (Needs Developer Mode on, under Settings → Advanced.)</span>
              </label>
            )}
            {pending === "watch" && (
              <label>Expires <span className="muted">(optional, {zoneLabel()})</span>
                <input type="datetime-local" value={f.until} onChange={set("until")} />
                <span className="hint">Blank watches until removed. With a date, this reason lapses on its own — and when the last one does, the watch lifts itself.</span>
              </label>
            )}
          </div>}
          <ActionResult error={err} />
          {/* Its own class: field hints are also `.hint`, and "the reason the submit is blocked"
              must stay addressable on its own (the e2e reads it). */}
          {blocked && <p className="hint pa-blocked">{blockedWhy}</p>}
          {/* The groups modal has no confirm button to carry the word, so it says what a toggle
              does when that is not "it happens now". */}
          {pending === "group" && (requestMode.building || !hasCap(grants, "player.groups", "write")) && (
            <p className="hint">{requestMode.building ? "Each change you toggle is added to your request — nothing happens until you submit." : "You don't hold the groups permission, so each change you toggle is sent for approval."}</p>
          )}
          <div className="pa-actions">
            <button className="ghost" onClick={() => setPending(null)} disabled={busy}>{pending === "group" ? "Close" : "Cancel"}</button>
            {pending !== "group" && <button className={META[pending].danger ? "danger" : ""} onClick={() => run(pending)} disabled={busy || blocked}>{busy ? "Working…" : requestMode.building && CAP_FOR[pending] ? "Add to request" : askMode(pending) ? "Send for approval" : actionTitle(pending)}</button>}
          </div>
        </Modal>
      )}
    </span>
  );
}
