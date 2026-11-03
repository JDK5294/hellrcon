/**
 * Manual registration — the staff-panel module that links a Discord member to a game account by
 * hand, without the in-game code.
 *
 * The self-service flow (discord-public.ts) proves identity with a code sent to the player in game.
 * That proof is exactly what a member cannot produce when they are the case staff have to fix: not
 * in game right now, on a console that ate the message, already linked to the wrong account, or
 * migrating from the old bot. The old bot had this screen and it is used constantly; without it the answer
 * to every one of those was "go and open the web panel".
 *
 * The flow, in the order a person thinks about it:
 *
 *   pick the member (Discord's own member picker, or a typed id) → see what they already have →
 *   pick the game account (live roster, or a typed player id) → linked, with the same welcome
 *   bonus the self-service path pays
 *
 * Staff authority replaces the code, so the two things a code protects against are handled openly:
 * neither side is silently overwritten. An identity conflict stops and asks, and the override is
 * its own button whose press is its own audit row.
 */
import type { DiscordButton, DiscordModuleDef, DiscordModuleEvent, DiscordModuleResult, DiscordView } from "@app/plugin-sdk";
import type { Repository } from "@app/db";
import { discordLiteral as asTyped } from "@app/shared";
import { syncGameRoles } from "./discord-game-roles.js";
import { flagBanEvasion } from "./evasion.js";
import { applyWelcomeBonus, discordTime, readRoster } from "./discord-public.js";

/** Discord's hard ceiling on select options — the roster page size everywhere in the bot. */
const PLAYERS_PER_PAGE = 25;

/** A game account as the module passes it around: what the roster gives, or what staff typed. */
/**
 * The one game this community runs, or null when it runs more than one.
 *
 * The fallback for paths that have no server behind them — a typed player id, mostly. A single-game
 * install has no ambiguity to resolve; a two-game one has no honest guess, and guessing files the
 * account under a game whose servers cannot address it.
 */
async function soleGame(repo: Repository): Promise<string | null> {
  const games = new Set((await repo.servers.list()).map((s) => s.game));
  return games.size === 1 ? [...games][0]! : null;
}

interface PickedPlayer {
  /** the game this account belongs to — from the server whose roster it was picked off, or from the
   *  row we already hold. Never guessed: the two games issue different ids, so a row filed under the
   *  wrong one is a VIP grant that reaches nobody. */
  game: string;
  platform: string;
  platformId: string;
  name: string;
}

/** `<discordId>:<rest>` — the member being registered rides in the custom_id state throughout,
 *  because the panel is stateless between presses and the member is the one thing every screen
 *  after the first needs. */
function splitState(state: string): { discordId: string; rest: string } {
  const sep = state.indexOf(":");
  return sep < 0 ? { discordId: state, rest: "" } : { discordId: state.slice(0, sep), rest: state.slice(sep + 1) };
}

const isDiscordId = (v: string): boolean => /^\d{5,25}$/.test(v);

export function manualRegistrationModule(repo: Repository): DiscordModuleDef {
  /** Root: pick who to register. Discord's user select searches the whole server as you type, so
   *  there is no name-search screen to build — the old bot needed one because its picker was a list of the
   *  channel's members. The typed-id path stays for someone who is not in this server. */
  const root = (): DiscordView => ({
    content: [
      "**Manual registration** — link a member's Discord to their game account.",
      "Use this when the member can't do it themselves from the VIP panel (not in game, console chat, wrong account already linked).",
      "Pick them below, or use their Discord id if they aren't in this server.",
    ].join("\n"),
    userSelect: { customId: "member", placeholder: "Pick the Discord member" },
    rows: [[{ label: "Enter a Discord id", customId: "memberm" }]],
  });

  /** What this member already has: their links, their balance, and the ways forward. Shown before
   *  anything is written, because "they're already linked to someone else" is the single most
   *  common reason staff opened this screen and it should not be a surprise at the end. */
  const member = async (discordId: string, note = ""): Promise<DiscordView> => {
    if (!isDiscordId(discordId)) return { content: `\`${discordId}\` is not a Discord user id.`, rows: [[{ label: "Start again", customId: "" }]] };
    const [players, economy, servers] = await Promise.all([
      repo.externalLinks.findPlayers("discord", discordId),
      repo.economy.member(discordId),
      repo.servers.list(),
    ]);
    const cfg = await repo.economy.config();
    const lines = [
      `**Manual registration** — <@${discordId}>`,
      players.length
        ? `Linked to **${players.map((p) => asTyped(p.name)).join("**, **")}**.`
        : "**Not linked** to any game account yet.",
      `Balance: **${economy?.balance ?? 0} ${cfg.currencyName}**.`,
    ];
    if (note) lines.push("", note);

    const rows: DiscordButton[][] = [];
    // One button per server: staff pick where the member is standing, exactly like the member's
    // own flow. Five per row, and the id stays short because only the server id and the member ride.
    const pick: DiscordButton[] = servers.slice(0, 4).map((s, i) => ({
      label: `Roster: ${s.name}`.slice(0, 80),
      customId: `roster:${discordId}:${s.id}:0`,
      style: (i === 0 ? "primary" : "secondary") as DiscordButton["style"],
    }));
    if (pick.length) rows.push(pick);
    const manual: DiscordButton[] = [{ label: "Enter a player id", customId: `idm:${discordId}` }];
    if (players.length) manual.push({ label: "Unlink", customId: `unlinkc:${discordId}`, style: "danger" });
    manual.push({ label: "Someone else", customId: "" });
    rows.push(manual);
    return { content: lines.join("\n"), rows };
  };

  /** The live roster as a dropdown, paged, with find-by-name — the same shape the member sees, so
   *  staff walking someone through it are looking at the same screen. */
  const rosterView = async (discordId: string, serverId: string, page: number, filter: string): Promise<DiscordView> => {
    const server = await repo.servers.findById(serverId);
    if (!server) return member(discordId, "⚠ That server no longer exists.");
    const all = await readRoster(repo, server);
    const matches = filter ? all.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase())) : all;
    // Every custom_id in a message must differ: Discord refuses the whole message otherwise, and
    // the screen simply never appears. Refresh therefore means "this page" and only the button
    // that drops a search means page 0 — see the note in discord-public.ts, where the same shape
    // stranded players on page 1 of the roster.
    const tools = (p: number): DiscordButton[] => [
      { label: "Find by name", customId: `findm:${discordId}:${serverId}`, style: "primary" },
      filter
        ? { label: "Show everyone", customId: `roster:${discordId}:${serverId}:0` }
        : { label: "Refresh", customId: `roster:${discordId}:${serverId}:${p}` },
      { label: "‹ Member", customId: `member:${discordId}` },
    ];
    if (!matches.length) {
      return {
        content: filter
          ? `Nobody on **${server.name}** matches "${asTyped(filter)}".`
          : `Nobody is on **${server.name}** right now. They have to be connected to appear here — or use **Enter a player id**.`,
        rows: [tools(0)],
      };
    }
    const pages = Math.max(1, Math.ceil(matches.length / PLAYERS_PER_PAGE));
    const p = Math.min(Math.max(page, 0), pages - 1);
    const slice = matches.slice(p * PLAYERS_PER_PAGE, (p + 1) * PLAYERS_PER_PAGE);
    // Paging is for the whole roster — a search has no page in its id, so paging one would drop the
    // search rather than move through it.
    const nav: DiscordButton[] = [];
    if (pages > 1 && !filter) {
      nav.push({ label: "‹ Previous", customId: `roster:${discordId}:${serverId}:${p - 1}`, disabled: p === 0 });
      nav.push({ label: "Next ›", customId: `roster:${discordId}:${serverId}:${p + 1}`, disabled: p === pages - 1 });
    }
    return {
      content: [
        `**Which player is <@${discordId}>?** — **${server.name}**, ${matches.length} online${filter ? ` matching "${asTyped(filter)}"` : ""}${filter ? "." : `, page ${p + 1}/${pages}.`}`,
        filter && pages > 1 ? `Showing the first ${PLAYERS_PER_PAGE} — type more of the name to narrow it.` : "",
        "Whoever you choose gets the link. There is no code to confirm it, so make sure it is them.",
      ].filter(Boolean).join("\n"),
      select: {
        customId: `pick:${discordId}:${serverId}`,
        placeholder: "Choose the in-game name",
        options: slice.map((pl) => ({ label: pl.name, value: `${pl.platform}|${pl.platformId}`, description: pl.platformId })),
      },
      rows: [tools(p), ...(nav.length ? [nav] : [])],
    };
  };

  /**
   * Write the link.
   *
   * Both conflicts refuse rather than overwrite, and say what is in the way. `force` is the same
   * write with the existing links cleared first — a separate press, so the audit trail records
   * that somebody chose to take a link off one account and put it on another.
   */
  /**
   * The member's Discord display name, when this press knows it.
   *
   * Only the member PICKER carries it — Discord resolves the users it offered in the same payload —
   * and the panel is stateless between presses, so every later screen passes `undefined`, which
   * `ensureMember` reads as "keep what is stored". What it must never do is write a placeholder:
   * this name is what the economy roster shows and what its search matches on, and an earlier cut
   * wrote `discord:<id>` here, which buried real names under junk nobody could search for.
   */
  const nameOf = (ev: DiscordModuleEvent, discordId: string): string | undefined => ev.selectedNames?.[discordId];

  const link = async (ev: DiscordModuleEvent, discordId: string, picked: PickedPlayer, force: boolean): Promise<DiscordView> => {
    const player = await repo.players.upsert({ game: picked.game, platform: picked.platform, platformId: picked.platformId, name: picked.name });
    const held = await repo.externalLinks.findPlayers("discord", discordId);
    // A conflict is another account for the SAME game. The games issue different ids, so one member
    // properly holds one account per game — a WW2 link must not block adding their Vietnam account,
    // or a Discord purchase can never reach both.
    const otherPlayer = held.find((h) => h.game === player.game && h.id !== player.id);
    const existing = (await repo.externalLinks.list(player.id)).find((l) => l.provider === "discord");
    const otherDiscord = existing && existing.externalId !== discordId ? existing.externalId : null;

    if (!force && (otherPlayer || otherDiscord)) {
      const why = [
        otherPlayer ? `<@${discordId}> is already linked to **${asTyped(otherPlayer.name)}**.` : "",
        otherDiscord ? `**${asTyped(player.name)}** is already linked to <@${otherDiscord}>.` : "",
      ].filter(Boolean);
      return {
        content: [`**Already linked.**`, ...why, "", "Replacing moves the link. Points stay with each Discord account — they are never attached to a game account."].join("\n"),
        rows: [[
          { label: "Replace the link", customId: `force:${discordId}:${picked.platform}|${picked.platformId}`, style: "danger" },
          { label: "Cancel", customId: `member:${discordId}` },
        ]],
      };
    }

    // Clearing first — but only the SAME GAME's links: replacing a member's WW2 account must leave
    // their Vietnam link standing, or fixing one game silently unregisters them from the other.
    if (force) {
      for (const h of held) if (h.game === player.game && h.id !== player.id) await repo.externalLinks.set(h.id, "discord", null, "manual");
      if (otherDiscord) await repo.externalLinks.set(player.id, "discord", null, "manual");
    }
    await repo.externalLinks.set(player.id, "discord", discordId, "manual");
    // The evasion tripwire, against the PRE-CLEAR account list: replacing a link is exactly how a
    // banned member's "lost my old account" story reaches staff, and the account the link is
    // being moved OFF is the one whose ban must follow the new one onto the watchlist.
    await flagBanEvasion(repo, player, discordId, { via: "staff registration", others: held }).catch(() => {});
    await repo.economy.ensureMember(discordId, nameOf(ev, discordId));
    await repo.audit.create({
      actorUserId: ev.staffUserId ?? null, actorName: ev.staffName ?? ev.discordUserName, action: "player.link",
      targetType: "player", targetId: player.id, targetName: player.name,
      summary: `manually registered ${player.name} to a Discord account from the staff panel${force ? " (replacing an existing link)" : ""}`,
      data: {
        discordId, playerId: player.id, platform: player.platform, platformId: player.platformId,
        via: "discord-manual", replaced: force,
        // The SAME game's account — the only kind a replace clears. A member's link in the other
        // game stands, and naming it here would tell the trail the wrong account lost its link.
        replacedPlayerId: force ? (held.find((h) => h.game === player.game && h.id !== player.id)?.id ?? null) : null,
        replacedDiscordId: force ? otherDiscord : null,
        channelId: ev.channelId ?? null, channelName: ev.channelName ?? null,
      },
    }).catch(() => {});

    // Per-game registration roles, both directions: the member gains their game's role, and a
    // displaced Discord account (force over `otherDiscord`) no longer holds this game, so the
    // reconcile takes its role back. Best-effort — a role is furniture, the link is the record.
    await syncGameRoles(repo, discordId);
    if (force && otherDiscord) await syncGameRoles(repo, otherDiscord);

    // Same welcome as self-service, sharing its ledger ref: a member who later links a second game
    // account, or who staff registered after they had already tried themselves, is paid once.
    const bonus = await applyWelcomeBonus(repo, discordId, player);
    const vip: string[] = [];
    // Only this account's OWN game: VIP rows are keyed by the id the game issues, and asking the
    // other game's servers about a WW2 id is a question with no answer — an empty line where the
    // member's real Vietnam VIP should be.
    for (const s of (await repo.servers.list()).filter((s) => s.game === player.game)) {
      const v = await repo.vips.get(s.id, player.platformId);
      if (v) vip.push(`• **${s.name}** — ${v.expiration ? `until ${discordTime(v.expiration, "D")}` : "permanent"}`);
    }
    return {
      content: [
        `✅ **${asTyped(player.name)}** is now linked to <@${discordId}>.`,
        bonus.length ? `Welcome bonus: ${bonus.join(" and ")}.` : "",
        vip.length ? `Existing VIP:\n${vip.join("\n")}` : "",
      ].filter(Boolean).join("\n"),
      rows: [[{ label: "Register someone else", customId: "" }, { label: "Back to the member", customId: `member:${discordId}` }]],
    };
  };

  const unlink = async (ev: DiscordModuleEvent, discordId: string): Promise<DiscordView> => {
    const players = await repo.externalLinks.findPlayers("discord", discordId);
    if (!players.length) return member(discordId, "⚠ They weren't linked to anything.");
    for (const p of players) {
      await repo.externalLinks.set(p.id, "discord", null, "manual");
      await repo.audit.create({
        actorUserId: ev.staffUserId ?? null, actorName: ev.staffName ?? ev.discordUserName, action: "player.unlink",
        targetType: "player", targetId: p.id, targetName: p.name,
        summary: `unlinked ${p.name} from their Discord account from the staff panel`,
        data: { discordId, playerId: p.id, via: "discord-manual", channelId: ev.channelId ?? null, channelName: ev.channelName ?? null },
      }).catch(() => {});
    }
    // No links left, so every configured game role comes off — unlinking is what re-opens a
    // game's self-service registration, and the role should say the same thing the flow does.
    await syncGameRoles(repo, discordId);
    return member(discordId, `🔓 Unlinked from **${players.map((p) => asTyped(p.name)).join("**, **")}**. Their points are untouched.`);
  };

  return {
    id: "register",
    label: "Manual registration",
    description: "Link a member's Discord to their game account by hand",
    /*
     * The same capability the web panel's manual link asks for — `player.links`, not the watchlist.
     *
     * This screen rewrites WHO a player is: it points a Discord identity at a game account, and
     * overriding an existing link moves that person's VIP, points and ban history with it. The
     * catalogue says to grant that sparingly, and the Moderator preset leaves it out on purpose.
     * It used to ask for `player.watchlist` — correct back when one bundled flags permission
     * covered links too, and quietly wrong ever since links were split off: every moderator holds
     * watchlist at write, so Discord was handing out the one thing the web panel withholds.
     */
    capability: "player.links",
    capabilityLevel: "write",
    // Only the roster steps talk to a game server. Everything else answers from the database, and
    // the modal-openers must stay undeferred — a modal can only be the first response.
    deferActions: ["roster", "find", "pick", "id", "force"],
    open: root,
    action: async (ev): Promise<DiscordModuleResult> => {
      const { discordId, rest } = splitState(ev.state);
      switch (ev.action) {
        // The user picker hands back the id in `selected`, not in the custom_id — and, uniquely in
        // this flow, the display name too. Spend it on the member row that already exists: the old bot's
        // imported names go stale, and this is the one press that can freshen them without asking
        // Discord anything. A member who has no row yet does not get one from being looked at.
        case "member": {
          const picked = ev.selected?.[0] ?? discordId;
          const name = nameOf(ev, picked);
          if (name && (await repo.economy.member(picked))) await repo.economy.ensureMember(picked, name);
          return member(picked);
        }
        case "memberm":
          return { modal: { title: "Register by Discord id", action: "memberid", fields: [{ id: "discordId", label: "Their Discord user id", placeholder: "123456789012345678", maxLength: 25 }] } };
        case "memberid":
          return member((ev.values?.discordId ?? "").trim());

        case "roster": {
          // state: <discordId>:<serverId>:<page>
          const cut = rest.lastIndexOf(":");
          return rosterView(discordId, rest.slice(0, cut), Number(rest.slice(cut + 1)) || 0, "");
        }
        case "findm":
          return { modal: { title: "Find a player by name", action: "find", state: ev.state, fields: [{ id: "q", label: "Part of the in-game name", maxLength: 40 }] } };
        case "find":
          return rosterView(discordId, rest, 0, (ev.values?.q ?? "").trim());
        case "pick": {
          const chosen = ev.selected?.[0];
          if (!chosen) return rosterView(discordId, rest, 0, "");
          const [platform, platformId] = chosen.split("|");
          const server = await repo.servers.findById(rest);
          const name = server ? (await readRoster(repo, server)).find((p) => p.platformId === platformId)?.name : "";
          if (!name) return rosterView(discordId, rest, 0, "");
          return link(ev, discordId, { game: server!.game, platform: platform!, platformId: platformId!, name }, false);
        }

        // The typed-id path: for a player who is not online, or has never been seen here at all.
        case "idm":
          return { modal: {
            title: "Link a player id",
            action: "id",
            state: discordId,
            fields: [
              { id: "playerId", label: "Player id (Steam64 / EOS)", maxLength: 64 },
              { id: "name", label: "Their in-game name (if we don't know it)", maxLength: 60 },
            ],
          } };
        case "id": {
          const platformId = (ev.values?.playerId ?? "").trim();
          if (!platformId) return member(discordId, "⚠ No player id given.");
          const known = await repo.players.findByPlatformId(platformId);
          const typedName = (ev.values?.name ?? "").trim();
          if (!known && !typedName) return member(discordId, `⚠ \`${platformId}\` isn't a player this app has seen. Add their in-game name and try again.`);
          // A typed id has no server behind it, so the game comes from the row we already hold — and
          // when there is none, from the community's only game. With more than one configured there
          // is no honest answer, and picking wrong files the account under a game whose servers can
          // never address it, so it asks for the roster picker instead.
          const typedGame = known?.game ?? (await soleGame(repo));
          if (!typedGame) return member(discordId, "⚠ This app runs more than one game, so a typed id cannot say which one this account belongs to. Pick them off a server's roster instead.");
          return link(ev, discordId, {
            game: typedGame,
            platform: known?.platform ?? (/^\d{17}$/.test(platformId) ? "steam" : "epic"),
            platformId,
            name: known?.name ?? typedName,
          }, false);
        }
        case "force": {
          const [platform, platformId] = rest.split("|");
          const known = await repo.players.findByPlatformId(platformId ?? "");
          const forceGame = known?.game ?? (await soleGame(repo));
          if (!forceGame) return member(discordId, "⚠ This app runs more than one game, so a typed id cannot say which one this account belongs to. Pick them off a server's roster instead.");
          return link(ev, discordId, { game: forceGame, platform: platform!, platformId: platformId!, name: known?.name ?? platformId! }, true);
        }

        case "unlinkc":
          return {
            content: `**Unlink <@${discordId}> from their game account?**\nTheir points stay on the Discord account. VIP already granted stays on the game account, but future purchases won't reach it.`,
            rows: [[{ label: "Unlink", customId: `unlink:${discordId}`, style: "danger" }, { label: "Cancel", customId: `member:${discordId}` }]],
          };
        case "unlink":
          return unlink(ev, discordId);

        default:
          return root();
      }
    },
  };
}
