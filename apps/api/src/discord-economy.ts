/**
 * The Economy hub — the staff panel's one door to everything member-money and VIP.
 *
 * Before this, the launcher carried three doors that were all really one subject: manual
 * registration, the VIP-launcher poster, and nothing at all for the questions staff actually
 * bring to Discord ("what's their balance", "do they have VIP and where", "why did their points
 * change"). This module is the hub those become sub-panels of: pick a member — Discord's own
 * picker searches the guild as you type — and their whole economic life is one card, with the
 * actions staff take on it as buttons under it.
 *
 * What a press may DO is the presser's own grants, resolved fresh per press exactly like the web
 * panel would: the card renders read-only for a reader, and each write button re-checks its
 * capability before acting — a button drawn a minute ago proves nothing. VIP work is per-server
 * capability (`vip.grant` / `vip.revoke` on THAT server), so a moderator who may grant on #1 and
 * not #2 sees exactly that behave.
 *
 * Registration stays the `register` module and the panel poster stays `viplauncher` — both now
 * HIDDEN from the launcher and reachable by the hub's jump buttons, so their 400 lines of flow
 * keep their own tests and this file stays about the hub.
 */
import type { DiscordButton, DiscordModuleDef, DiscordModuleEvent, DiscordModuleResult, DiscordView } from "@app/plugin-sdk";
import { bankIfHeld, type Repository, type ServerRow, type VipRow } from "@app/db";
import { can, canAnywhere } from "@app/access";
import { discordLiteral as asTyped } from "@app/shared";
import { displayNameOf, resolveAccess } from "./auth.js";
import { discordTime, historyPage, vipBoughtLines } from "./discord-public.js";
import { computeGrantExpiration, connectGameClient, gameClientFor } from "./routes/kit.js";
import { TEXT_MAX } from "./http.js";
import { describeSpanMs, heldBy } from "./group-perks.js";
import { vipBought } from "./vip-bought.js";

const isDiscordId = (v: string): boolean => /^\d{5,25}$/.test(v);

/** Ledger page size: ten lines reads as a statement; Discord's 1900-char budget holds it. */
const LEDGER_PAGE = 10;
/** VIP-history entries shown — the newest chapter, not the whole book. */
const VIP_HISTORY_LIMIT = 8;
/** Cross-member activity page size. */
const ACTIVITY_PAGE = 8;

/** The comment every VIP grant asks for (kit.ts requiredVipComment), as a form field. */
const VIP_COMMENT_FIELD = { id: "comment", label: "Comment: who paid, what for, which event", placeholder: "paid $10 for 30 days", maxLength: 200 };
const VIP_COMMENT_MISSING = "⚠️ A comment is required for every VIP added — say who paid, what for, or which event. Nothing was granted.";

/**
 * Servers referenced from custom_id state by the first 8 hex of their uuid — a full uuid (36)
 * plus a Discord id (25) would blow the 100-char custom_id budget. Resolved by prefix on every
 * press and REFUSED on ambiguity, so a truncated key can never quietly address the wrong box.
 */
export function serverByKey(servers: ServerRow[], key: string): ServerRow | null {
  if (key === "all") return null;
  const hits = servers.filter((s) => s.id.replaceAll("-", "").startsWith(key));
  return hits.length === 1 ? hits[0]! : null;
}
const keyOf = (s: ServerRow): string => s.id.replaceAll("-", "").slice(0, 8);

/** `<discordId>` or `<discordId>:<rest>` — the member rides in the state on every screen. */
function splitState(state: string): { discordId: string; rest: string } {
  const sep = state.indexOf(":");
  return sep < 0 ? { discordId: state, rest: "" } : { discordId: state.slice(0, sep), rest: state.slice(sep + 1) };
}

const fmtPoints = (n: number): string => n.toLocaleString("en-US");

/** "+250" / "−100" — ledger deltas read as movements, not amounts. */
const fmtDelta = (n: number): string => (n >= 0 ? `+${fmtPoints(n)}` : `−${fmtPoints(-n)}`);

/** One VIP grant as a card line: where, until when, and any pause standing on it. */
function vipLine(v: VipRow, serverName: string): string {
  // A group perk's hold reads as the web profile reads it: the group's permanent, and the VIP of
  // their own frozen beneath it — what the card's Revoke takes, and what comes back when they leave.
  const until = v.groupHold
    ? `**permanent** — group ${v.groupHold.groups.map((g) => `“${g.name}”`).join(", ")}${v.groupHold.bankedMs > 0 ? `, ${describeSpanMs(v.groupHold.bankedMs)} frozen for when they leave` : ""}`
    : v.expiration === null ? "**permanent**" : `until ${discordTime(v.expiration)} (${discordTime(v.expiration, "R")})`;
  const paused = v.pausedUntil && Date.parse(v.pausedUntil) > Date.now()
    ? ` · ⏸ paused ${discordTime(v.pausedUntil, "R")}` : "";
  return `· **${serverName}** — ${until}${paused}`;
}

export function economyModule(repo: Repository): DiscordModuleDef {
  /** The presser's effective grants — per press, never cached: the card and its buttons must
   *  tell the same story the web panel would at this same moment. */
  const grantsOf = async (ev: DiscordModuleEvent) =>
    ev.staffUserId ? (await resolveAccess(repo, ev.staffUserId)).grants : [];

  /** The name every write is recorded under — the PANEL account's display name, exactly what the
   *  web routes and the other modules stamp, so one person's trail reads as one name whichever
   *  surface they pressed. The Discord nick stands in only when the account row is gone. */
  const actorNameOf = async (ev: DiscordModuleEvent): Promise<string> => {
    const account = ev.staffUserId ? await repo.users.findById(ev.staffUserId).catch(() => null) : null;
    return account ? displayNameOf(account) : ev.staffName ?? ev.discordUserName;
  };

  const hub = async (): Promise<DiscordView> => {
    const [cfg, top, total] = await Promise.all([
      repo.economy.config(),
      repo.economy.members({ limit: 5 }),
      repo.economy.membersCount(),
    ]);
    const board = top.length
      ? top.map((m, i) => `${i + 1}. **${asTyped(m.discordName || m.discordId)}** — ${fmtPoints(m.balance)} ${cfg.currencyName}`).join("\n")
      : "_Nobody holds a balance yet._";
    return {
      content: [
        `**Economy** — ${total.toLocaleString("en-US")} member(s) · currency: **${cfg.currencyName}**`,
        "Pick a member below (the picker searches as you type) to see their balance, VIP and history — and act on them.",
        "",
        `**Top balances**`,
        board,
      ].join("\n"),
      userSelect: { customId: "member", placeholder: "Pick a member to open their card" },
      rows: [[
        { label: "By Discord id", customId: "memberm" },
        { label: "Recent activity", customId: "act:0" },
      ], [
        // The absorbed sub-panels: their modules still own their flows, this is just the door.
        { label: "Register / link accounts", customId: "", moduleId: "register", style: "primary" },
        { label: "Post the public VIP panel", customId: "", moduleId: "viplauncher" },
      ]],
    };
  };

  /** The member card — the screen everything else returns to. */
  const card = async (ev: DiscordModuleEvent, discordId: string, note = ""): Promise<DiscordView> => {
    if (!isDiscordId(discordId)) return { content: `\`${discordId}\` is not a Discord user id.`, rows: [[{ label: "Start over", customId: "" }]] };
    const [cfg, member, players, servers, grants] = await Promise.all([
      repo.economy.config(),
      repo.economy.member(discordId),
      repo.externalLinks.findPlayers("discord", discordId),
      repo.servers.list(),
      grantsOf(ev),
    ]);
    const serverName = new Map(servers.map((s) => [s.id, s.name]));
    const vipRows: { row: VipRow; server: string }[] = [];
    for (const pl of players) {
      for (const v of await repo.vips.listByPlayer(pl.platformId)) {
        // Not on the list means a retired server's (a deleted one takes its grants with it): kept
        // for the server's return, but not VIP the member has now, as the public panel and the
        // web profile already show it.
        const server = serverName.get(v.serverId);
        if (server !== undefined) vipRows.push({ row: v, server });
      }
    }
    const live = vipRows.filter(({ row }) => row.expiration === null || Date.parse(row.expiration) > Date.now());

    const lines = [
      `**Member** — <@${discordId}>${member?.discordName ? ` (**${asTyped(member.discordName)}**)` : ""}${note ? `\n${note}` : ""}`,
      "",
      `**${cfg.currencyName}:** ${member ? fmtPoints(member.balance) : "0 (no wallet yet)"}`,
      players.length
        ? `**Game accounts:** ${players.map((p) => `${asTyped(p.name || p.platformId)} (${p.game})`).join(" · ")}`
        : "**Game accounts:** none linked — use *Register / link* from the hub.",
      live.length
        ? `**VIP:**\n${live.map(({ row, server }) => vipLine(row, server)).join("\n")}`
        : "**VIP:** none active",
    ];

    const actions: DiscordButton[] = [];
    // Each write wears its own gate, mirrored from the web routes it stands beside.
    if (canAnywhere(grants, "economy.balances", "write")) actions.push({ label: `± ${cfg.currencyName}`, customId: `adjm:${discordId}`, style: "primary" });
    if (players.length && servers.some((s) => can(grants, "vip.grant", "write", { serverId: s.id }))) {
      actions.push({ label: "Grant VIP", customId: `vips:${discordId}`, style: "success" });
    }
    if (live.length && servers.some((s) => can(grants, "vip.revoke", "write", { serverId: s.id }))) {
      actions.push({ label: "Revoke VIP", customId: `vipr:${discordId}`, style: "danger" });
    }
    return {
      content: lines.join("\n"),
      rows: [actions, [
        { label: `${cfg.currencyName} history`, customId: `hist:${discordId}:0` },
        { label: "VIP history", customId: `viph:${discordId}` },
        { label: "Refresh", customId: `member:${discordId}` },
      ]].filter((r) => r.length),
    };
  };

  /** One member's ledger, paged — every balance stays explainable as the sum of these. Under a
   *  VIP purchase, on each server, when its days start and when that VIP now ends. */
  const history = async (discordId: string, page: number): Promise<DiscordView> => {
    const cfg = await repo.economy.config();
    const [entries, total] = await Promise.all([
      repo.economy.ledger(discordId, { limit: LEDGER_PAGE, offset: page * LEDGER_PAGE }),
      repo.economy.ledgerCount(discordId),
    ]);
    const pages = Math.max(1, Math.ceil(total / LEDGER_PAGE));
    const p = Math.min(page, pages - 1);
    const bought = await vipBought(repo, entries);
    const lines = entries.map((e) => ({
      line: `${fmtDelta(e.delta)} — ${asTyped(e.reason)}${e.actorName ? ` · by ${asTyped(e.actorName)}` : ""} · ${discordTime(e.createdAt, "R")}`,
      dates: vipBoughtLines(e.ref ? bought.get(e.ref) : undefined),
    }));
    const nav: DiscordButton[] = [];
    if (p > 0) nav.push({ label: "‹ Newer", customId: `hist:${discordId}:${p - 1}` });
    if (p < pages - 1) nav.push({ label: "Older ›", customId: `hist:${discordId}:${p + 1}` });
    nav.push({ label: "‹ Member card", customId: `member:${discordId}` });
    const head = `**${cfg.currencyName} history** — <@${discordId}> · ${total.toLocaleString("en-US")} entr${total === 1 ? "y" : "ies"} · page ${p + 1}/${pages}`;
    return {
      content: lines.length ? historyPage(head, lines) : `${head}\n_No entries._`,
      rows: [nav],
    };
  };

  /** The member's VIP story: grants, revokes and reductions, across every linked account —
   *  the same audit read the web profile's VIP-history tab renders. */
  const vipHistory = async (discordId: string): Promise<DiscordView> => {
    const players = await repo.externalLinks.findPlayers("discord", discordId);
    // History names a retired server too, as the web profile's VIP history does.
    const servers = await repo.servers.list({ includeRetired: true });
    const serverName = new Map(servers.map((s) => [s.id, s.name]));
    const entries = (await Promise.all(players.map((pl) =>
      repo.audit.list({ targetId: pl.platformId, actions: ["vip.grant", "vip.revoke", "vip.reduce"], limit: 50 }),
    ))).flat().sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, VIP_HISTORY_LIMIT);
    const lines = entries.map((e) => {
      const where = e.serverId ? serverName.get(e.serverId) ?? "?" : "";
      // Taken from beneath a group perk's hold: their own VIP went, the group's stayed.
      const underHold = (e.data as { groupHeld?: unknown } | null)?.groupHeld === true;
      const what = e.action === "vip.grant" ? "🟢 granted"
        : e.action === "vip.revoke" ? (underHold ? "🟠 own VIP revoked (group VIP kept)" : "🔴 revoked")
        : underHold ? "🟠 own VIP reduced (group VIP kept)" : "🟠 reduced";
      return `${what}${where ? ` on **${where}**` : ""} · by ${asTyped(e.actorName)} · ${discordTime(e.ts, "R")}`;
    });
    return {
      content: [
        `**VIP history** — <@${discordId}>${players.length ? "" : "\n_No linked game accounts, so no VIP can be on record._"}`,
        lines.length ? lines.join("\n") : "_Nothing on record._",
      ].join("\n"),
      rows: [[{ label: "‹ Member card", customId: `member:${discordId}` }]],
    };
  };

  /** The cross-member activity feed — who moved money lately, one page at a time. */
  const activity = async (page: number): Promise<DiscordView> => {
    const cfg = await repo.economy.config();
    const { entries, total } = await repo.economy.activity({ limit: ACTIVITY_PAGE, offset: page * ACTIVITY_PAGE });
    const pages = Math.max(1, Math.ceil(total / ACTIVITY_PAGE));
    const p = Math.min(page, pages - 1);
    const lines = entries.map((e) =>
      `${fmtDelta(e.delta)} **${asTyped(e.discordName || e.discordId)}** — ${asTyped(e.reason)} · ${discordTime(e.createdAt, "R")}`);
    const nav: DiscordButton[] = [];
    if (p > 0) nav.push({ label: "‹ Newer", customId: `act:${p - 1}` });
    if (p < pages - 1) nav.push({ label: "Older ›", customId: `act:${p + 1}` });
    nav.push({ label: "‹ Economy", customId: "" });
    return {
      content: [
        `**${cfg.currencyName} activity** — every member, newest first · page ${p + 1}/${pages}`,
        lines.length ? lines.join("\n") : "_Nothing yet._",
      ].join("\n"),
      rows: [nav],
    };
  };

  /** Where a VIP change applies: one server, or every server the presser holds the write on. */
  const vipServerPick = async (ev: DiscordModuleEvent, discordId: string, verb: "grant" | "revoke"): Promise<DiscordView> => {
    const [servers, grants] = await Promise.all([repo.servers.list(), grantsOf(ev)]);
    const cap = verb === "grant" ? "vip.grant" : "vip.revoke";
    const allowed = servers.filter((s) => can(grants, cap, "write", { serverId: s.id }));
    if (!allowed.length) return card(ev, discordId, `⚠️ You don't hold ${cap} on any server.`);
    const action = verb === "grant" ? "vipd" : "viprc";
    return {
      content: `**${verb === "grant" ? "Grant" : "Revoke"} VIP** — <@${discordId}>\nPick where. "All my servers" covers every server your permissions reach (${allowed.length}).`,
      select: {
        customId: `${action}:${discordId}`,
        placeholder: "Pick the server",
        options: [
          { label: `All my servers (${allowed.length})`, value: "all" },
          ...allowed.slice(0, 24).map((s) => ({ label: s.name.slice(0, 100), value: keyOf(s) })),
        ],
      },
      rows: [[{ label: "‹ Member card", customId: `member:${discordId}` }]],
    };
  };

  /** Duration choice for a grant: the community's own presets, permanent, or a typed number. */
  const vipDuration = async (discordId: string, serverKey: string): Promise<DiscordView> => {
    // Deduped by TOTAL HOURS: the custom_id encodes the duration, and two presets that mean the
    // same length would render two components with one id — which Discord refuses wholesale.
    const byHours = new Map<number, string>();
    for (const p of (await repo.vipPresets.list()).filter((x) => x.kind === "add")) {
      const h = p.days * 24 + p.hours;
      if (h > 0 && !byHours.has(h)) byHours.set(h, p.label);
    }
    const rows: DiscordButton[][] = [];
    // Each opens the comment form (vipn): every VIP added carries one (kit.ts requiredVipComment).
    const buttons = [...byHours.entries()].slice(0, 8).map(([h, label]): DiscordButton => ({
      label: `+ ${label}`, customId: `vipn:${discordId}:${serverKey}:h${h}`,
    }));
    for (let i = 0; i < buttons.length; i += 4) rows.push(buttons.slice(i, i + 4));
    rows.push([
      { label: "Permanent", customId: `vipn:${discordId}:${serverKey}:perm`, style: "success" },
      { label: "Custom days…", customId: `vipm:${discordId}:${serverKey}` },
      { label: "‹ Member card", customId: `member:${discordId}` },
    ]);
    return {
      content: `**Grant VIP** — <@${discordId}> · ${serverKey === "all" ? "all your servers" : "one server"}\nTime STACKS onto whatever they already have (permanent stays permanent). Every grant asks for a comment: who paid, what for, or which event.`,
      rows,
    };
  };

  /**
   * Apply the grant (or revoke) — the deferred half, one server at a time, each reporting its own
   * outcome. The game is told first and the row recorded after, exactly like the web route; a
   * server that refuses (observe mode, connection down) is a line in the summary, never a reason
   * the others miss out.
   */
  const vipApply = async (ev: DiscordModuleEvent, discordId: string, serverKey: string, spec: string, comment: string): Promise<DiscordView> => {
    const [servers, grants, players] = await Promise.all([
      repo.servers.list(), grantsOf(ev), repo.externalLinks.findPlayers("discord", discordId),
    ]);
    const targets = serverKey === "all"
      ? servers.filter((s) => can(grants, "vip.grant", "write", { serverId: s.id }))
      : [serverByKey(servers, serverKey)].filter((s): s is ServerRow => s !== null);
    if (!targets.length) return card(ev, discordId, "⚠️ That server is gone or ambiguous — nothing was granted.");

    const permanent = spec === "perm";
    const hours = permanent ? 0 : Number(spec.replace(/^h/, ""));
    if (!permanent && (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 36_500)) {
      return card(ev, discordId, "⚠️ That duration makes no sense — nothing was granted.");
    }
    const actorName = await actorNameOf(ev);
    const results: string[] = [];
    for (const server of targets) {
      // The per-server gate again at APPLY time — the select was drawn from a moment ago's grants.
      if (!can(grants, "vip.grant", "write", { serverId: server.id })) { results.push(`⛔ **${server.name}** — no vip.grant here`); continue; }
      const player = players.find((pl) => pl.game === server.game);
      if (!player) { results.push(`⚠️ **${server.name}** — no linked ${server.game} account`); continue; }
      try {
        // Permanent VIP from a group perk: hours join the VIP they get back on leaving the group;
        // granting permanent outright makes it this staff member's grant, no longer the group's.
        const banked = async (row: VipRow) => {
          await repo.audit.create({
            actorUserId: ev.staffUserId ?? null, actorName, action: "vip.grant",
            targetType: "player", targetId: player.platformId, targetName: player.name, serverId: server.id,
            summary: `granted ${hours}h of VIP to ${player.name || player.platformId} on ${server.name} — via Discord panel; they hold permanent VIP from a group perk, so it waits for them when they leave it`,
            data: { playerId: player.platformId, groupHeld: true, bankedMs: row.groupHold!.bankedMs, hours, comment, discordUserId: ev.discordUserId, via: "discord" },
          });
          results.push(`✅ **${server.name}** — holds permanent VIP from a group; ${hours}h added to what they get back on leaving it`);
        };
        let existing: VipRow | null;
        if (!permanent) {
          const basis = await bankIfHeld(repo, server.id, player.platformId, { addMs: hours * 3_600_000 });
          if (basis.banked) { await banked(basis.banked); continue; }
          existing = basis.existing;
        } else {
          existing = await repo.vips.get(server.id, player.platformId);
        }
        if (existing?.groupHold && permanent) {
          await repo.vips.upsert({ serverId: server.id, playerId: player.platformId, playerName: player.name, comment, expiration: null, createdByUserId: ev.staffUserId ?? null, createdByName: actorName, endsGroupHold: true });
          await repo.audit.create({
            actorUserId: ev.staffUserId ?? null, actorName, action: "vip.grant",
            targetType: "player", targetId: player.platformId, targetName: player.name, serverId: server.id,
            summary: `granted permanent VIP to ${player.name || player.platformId} on ${server.name} — via Discord panel; it was permanent VIP from a group perk, and is theirs now (leaving the group no longer ends it)`,
            data: { playerId: player.platformId, expiration: null, endedGroupHold: true, comment, discordUserId: ev.discordUserId, via: "discord" },
          });
          results.push(`✅ **${server.name}** — permanent (theirs now, not the group's)`);
          continue;
        }
        // Permanent absorbs the grant — the shop's grantDays skips the write for the same reason:
        // an upsert here would only restamp the comment and the granter over a record this press
        // did not make, a "paid" marker included. Nothing to add, nothing touched.
        if (existing && existing.expiration === null) {
          results.push(`— **${server.name}** — already permanent; left untouched`);
          continue;
        }
        const expiration = computeGrantExpiration(
          permanent ? { mode: "permanent" } : { mode: "duration", days: 0, hours, cumulative: true },
          existing,
        );
        // A VIP timeout keeps them off the game until it ends (the time still lands on the row and
        // the timeout's end puts them back) — like every other grant path.
        const paused = Boolean(existing?.pausedUntil && Date.parse(existing.pausedUntil) > Date.now());
        if (server.engagementMode === "active" && !paused) {
          const client = gameClientFor(server);
          try {
            await connectGameClient(client, server);
            await client.execute("addVip", { playerId: player.platformId, description: player.name || "VIP" });
          } finally {
            await client.disconnect().catch(() => {});
          }
        }
        // Permanent takes over a hold that began after the read; a dated grant meeting one is banked.
        const row = await repo.vips.upsert({
          serverId: server.id, playerId: player.platformId, playerName: player.name,
          comment, expiration,
          createdByUserId: ev.staffUserId ?? null, createdByName: actorName,
          ...(permanent ? { endsGroupHold: true } : {}),
        });
        if (row.groupHold) { await banked(row); continue; }
        // Permanent VIP granted meanwhile absorbed the hours (the store's floor kept it permanent).
        if (!permanent && row.expiration === null) { results.push(`— **${server.name}** — already permanent; left untouched`); continue; }
        await repo.audit.create({
          actorUserId: ev.staffUserId ?? null, actorName, action: "vip.grant",
          targetType: "player", targetId: player.platformId, targetName: player.name, serverId: server.id,
          // What landed: the store keeps the later of the grant's date and this one.
          summary: `granted VIP to ${player.name || player.platformId} on ${server.name} (${row.expiration ? `until ${row.expiration}` : "permanent"}) — via Discord panel${row.endedHold ? "; it was permanent VIP from a group perk, and is theirs now (leaving the group no longer ends it)" : ""}`,
          data: { playerId: player.platformId, expiration: row.expiration, hours: permanent ? undefined : hours, comment, discordUserId: ev.discordUserId, via: "discord", ...(row.endedHold ? { endedGroupHold: true } : {}) },
        });
        results.push(`✅ **${server.name}** — ${row.expiration ? `until ${discordTime(row.expiration)}` : row.endedHold ? "permanent (theirs now, not the group's)" : "permanent"}${server.engagementMode !== "active" ? " (observe mode: recorded, not sent to the game)" : paused ? " (in a VIP timeout: back on the game when it ends)" : ""}`);
      } catch (err) {
        results.push(`❌ **${server.name}** — ${(err as Error).message}`);
      }
    }
    return card(ev, discordId, `**VIP grant:**\n${results.join("\n")}`);
  };

  /** The revoke half — same shape, dangerous side: the whole grant goes, permanent included (one a
   *  group perk holds gives up only the VIP of their own beneath it — the group's stays). */
  const vipRevoke = async (ev: DiscordModuleEvent, discordId: string, serverKey: string): Promise<DiscordView> => {
    const [servers, grants, players] = await Promise.all([
      repo.servers.list(), grantsOf(ev), repo.externalLinks.findPlayers("discord", discordId),
    ]);
    const targets = serverKey === "all"
      ? servers.filter((s) => can(grants, "vip.revoke", "write", { serverId: s.id }))
      : [serverByKey(servers, serverKey)].filter((s): s is ServerRow => s !== null);
    if (!targets.length) return card(ev, discordId, "⚠️ That server is gone or ambiguous — nothing was revoked.");
    const actorName = await actorNameOf(ev);
    const results: string[] = [];
    for (const server of targets) {
      if (!can(grants, "vip.revoke", "write", { serverId: server.id })) { results.push(`⛔ **${server.name}** — no vip.revoke here`); continue; }
      const player = players.find((pl) => pl.game === server.game);
      const row = player ? await repo.vips.get(server.id, player.platformId) : null;
      if (!player || !row) { results.push(`— **${server.name}** — no grant to revoke`); continue; }
      // A group perk's hold: the group's VIP stands while they are listed; the revoke takes the VIP
      // of their own frozen beneath it, as it does on the panel's VIP page.
      if (row.groupHold) {
        const cut = await repo.vips.cutGroupHold(server.id, player.platformId, { all: true });
        if (!cut) { results.push(`— **${server.name}** — their VIP changed while this ran; look again`); continue; }
        if (cut.removedMs <= 0) { results.push(`— **${server.name}** — ${heldBy(cut.row.groupHold ?? row.groupHold)}, nothing of their own beneath it; remove them from the group to end it`); continue; }
        await repo.audit.create({
          actorUserId: ev.staffUserId ?? null, actorName, action: "vip.revoke",
          targetType: "player", targetId: player.platformId, targetName: player.name, serverId: server.id,
          summary: `revoked ${player.name || player.platformId}'s own VIP on ${server.name} — ${Math.round(cut.removedMs / 3_600_000)}h that would have come back on leaving their group; they keep ${heldBy(cut.row.groupHold ?? row.groupHold)} while listed — via Discord panel`,
          data: { playerId: player.platformId, groupHeld: true, removedMs: cut.removedMs, bankedMs: 0, discordUserId: ev.discordUserId, via: "discord" },
        });
        results.push(`✅ **${server.name}** — their own VIP removed (${Math.round(cut.removedMs / 3_600_000)}h); the group's VIP stays while they're listed`);
        continue;
      }
      try {
        if (server.engagementMode === "active") {
          const client = gameClientFor(server);
          try {
            await connectGameClient(client, server);
            await client.execute("removeVip", { playerId: player.platformId });
          } finally {
            await client.disconnect().catch(() => {});
          }
        }
        await repo.vips.remove(server.id, player.platformId);
        await repo.audit.create({
          actorUserId: ev.staffUserId ?? null, actorName, action: "vip.revoke",
          targetType: "player", targetId: player.platformId, targetName: player.name, serverId: server.id,
          summary: `revoked ${player.name || player.platformId}'s VIP on ${server.name} — via Discord panel`,
          data: { playerId: player.platformId, discordUserId: ev.discordUserId, via: "discord" },
        });
        results.push(`✅ **${server.name}** — revoked${server.engagementMode !== "active" ? " (observe mode: taken off the record, not off the game)" : ""}`);
      } catch (err) {
        results.push(`❌ **${server.name}** — ${(err as Error).message}`);
      }
    }
    return card(ev, discordId, `**VIP revoke:**\n${results.join("\n")}`);
  };

  return {
    id: "economy",
    label: "Economy",
    description: "Balances, VIP, history — everything on one member card",
    capability: "economy.balances",
    // The RCON-touching steps get the deferred path; everything else is DB reads and stays snappy.
    deferActions: ["vipa", "vipc", "viprc"],
    open: hub,
    action: async (ev: DiscordModuleEvent): Promise<DiscordModuleResult> => {
      const { action } = ev;

      // Member selection: the user picker, the typed-id modal, and every "back to card" button.
      if (action === "member") {
        const picked = ev.selected?.[0] ?? splitState(ev.state).discordId;
        return card(ev, picked);
      }
      if (action === "memberm") {
        return { modal: { title: "Open a member by Discord id", action: "memberid", fields: [
          { id: "discordId", label: "Their Discord user id", placeholder: "123456789012345678", maxLength: 25 },
        ] } };
      }
      if (action === "memberid") return card(ev, (ev.values?.discordId ?? "").trim());

      // Pages ride the custom_id, so they are attacker-influenceable: a forged "-3" reached
      // the ledger query as a negative OFFSET, which Postgres refuses — a failure banner from
      // a button we never drew. Garbage and negatives both mean page 0.
      const pageOf = (raw: string): number => Math.max(0, Math.trunc(Number(raw) || 0));
      if (action === "act") return activity(pageOf(ev.state));
      if (action === "hist") {
        const { discordId, rest } = splitState(ev.state);
        return history(discordId, pageOf(rest));
      }
      if (action === "viph") return vipHistory(splitState(ev.state).discordId);

      // Points adjustment — gate, form, write. The write mirrors the web route: bounded reason,
      // cap-clamped apply, an audit row that says who and why.
      if (action === "adjm") {
        const { discordId } = splitState(ev.state);
        const grants = await grantsOf(ev);
        if (!canAnywhere(grants, "economy.balances", "write")) return card(ev, discordId, "⛔ You don't hold economy.balances write.");
        const cfg = await repo.economy.config();
        return { modal: { title: `Adjust ${cfg.currencyName}`.slice(0, 45), action: "adj", state: discordId, fields: [
          { id: "delta", label: "Amount (e.g. 250 or -100)", placeholder: "250", maxLength: 9 },
          { id: "reason", label: "Reason (the member can see this)", placeholder: "event prize", maxLength: 200 },
        ] } };
      }
      if (action === "adj") {
        const { discordId } = splitState(ev.state);
        const grants = await grantsOf(ev);
        if (!canAnywhere(grants, "economy.balances", "write")) return card(ev, discordId, "⛔ You don't hold economy.balances write.");
        const delta = Math.trunc(Number((ev.values?.delta ?? "").trim()));
        const reason = (ev.values?.reason ?? "").trim();
        if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 1_000_000) return card(ev, discordId, "⚠️ The amount must be a whole non-zero number within ±1,000,000.");
        if (!reason) return card(ev, discordId, "⚠️ A reason is required — it is the ledger row other staff read.");
        const cfg = await repo.economy.config();
        const actorName = await actorNameOf(ev);
        try {
          const applied = await repo.economy.apply(
            { discordId, delta, reason, actorName },
            { maxBalance: cfg.balanceCap },
          );
          await repo.audit.create({
            actorUserId: ev.staffUserId ?? null, actorName, action: "economy.adjust",
            targetType: "member", targetId: discordId, targetName: applied.member.discordName,
            summary: `adjusted a member's ${cfg.currencyName} by ${fmtDelta(applied.entry.delta)}: ${reason} — via Discord panel`,
            data: { requested: delta, applied: applied.entry.delta, balance: applied.member.balance, discordUserId: ev.discordUserId, via: "discord" },
          });
          return card(ev, discordId, `✅ ${fmtDelta(applied.entry.delta)} ${cfg.currencyName} — new balance **${fmtPoints(applied.member.balance)}**${applied.entry.delta !== delta ? " (clamped by the balance cap)" : ""}`);
        } catch (err) {
          return card(ev, discordId, `❌ ${(err as Error).message}`);
        }
      }

      // VIP: server pick → duration → apply; revoke goes pick → apply (the select IS the confirm,
      // and the card names exactly what stands before anyone reaches it).
      if (action === "vips") return vipServerPick(ev, splitState(ev.state).discordId, "grant");
      if (action === "vipr") return vipServerPick(ev, splitState(ev.state).discordId, "revoke");
      if (action === "vipd") {
        const { discordId } = splitState(ev.state);
        const key = ev.selected?.[0] ?? "";
        return vipDuration(discordId, key);
      }
      // Every VIP added carries a comment (kit.ts requiredVipComment): each duration opens a form
      // asking for it, and the custom one asks beside the days. A form is only accepted as the first
      // answer, so the openers (vipn, vipm) stay undeferred and the submits (vipa, vipc) are the
      // deferred half that dials the game.
      if (action === "vipn") {
        const { discordId, rest } = splitState(ev.state);
        return { modal: { title: "VIP comment", action: "vipa", state: `${discordId}:${rest}`, fields: [VIP_COMMENT_FIELD] } };
      }
      if (action === "vipm") {
        const { discordId, rest } = splitState(ev.state);
        return { modal: { title: "Custom VIP duration", action: "vipc", state: `${discordId}:${rest}`, fields: [
          { id: "days", label: "Days to add", placeholder: "30", maxLength: 5 },
          VIP_COMMENT_FIELD,
        ] } };
      }
      if (action === "vipc") {
        const { discordId, rest } = splitState(ev.state);
        const days = Math.trunc(Number((ev.values?.days ?? "").trim()));
        if (!Number.isFinite(days) || days <= 0 || days > 36_500) return card(ev, discordId, "⚠️ Days must be a positive whole number.");
        const comment = (ev.values?.comment ?? "").trim();
        if (!comment) return card(ev, discordId, VIP_COMMENT_MISSING);
        return vipApply(ev, discordId, rest, `h${days * 24}`, comment.slice(0, TEXT_MAX.note));
      }
      if (action === "vipa") {
        const { discordId, rest } = splitState(ev.state);
        // Only the comment form submits this now; a duration button drawn before it (no form,
        // so no comment) lands here too, and grants nothing.
        const comment = (ev.values?.comment ?? "").trim();
        if (!comment) return card(ev, discordId, VIP_COMMENT_MISSING);
        const sep = rest.indexOf(":");
        return vipApply(ev, discordId, rest.slice(0, sep), rest.slice(sep + 1), comment.slice(0, TEXT_MAX.note));
      }
      if (action === "viprc") {
        const { discordId } = splitState(ev.state);
        return vipRevoke(ev, discordId, ev.selected?.[0] ?? "");
      }

      return hub();
    },
  };
}
