/**
 * The cutover import of an earlier bot's bot.db (docs/vip-module.md's last section, decision 4): the in-app upload terminal's
 * engine. Takes that bot's VIP-module `users` rows and imports what carries over:
 *
 *   - Discord↔game links, with provenance ("v4-import") — REFUSING conflicts, never overwriting:
 *     an identity already held by someone else is a line in the report for staff, not a stolen link.
 *   - the old bot's points balances as OPENING-BALANCE ledger rows, ref `v4:opening:<discordId>` — the
 *     unique ref makes a re-run pay nobody twice, so day one is explainable like every day after.
 *   - Registration state: the once-ever welcome marker, so a player that bot already welcomed cannot
 *     collect a second bonus here; and the member row with their Discord name.
 *
 * Player sightings are recorded AT THAT BOT'S TIME, not the import clock — an import is not a
 * sighting (the CRCON import learned this the hard way, #266).
 *
 * Converging by design: run it twice and the second run reports "already" for everything.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Repository } from "@app/db";
import { errors } from "@app/shared";
import { dayBonusKey, REGISTRATION_KV_NS } from "./economy.js";
import { syncGameRoles } from "./discord-game-roles.js";

const execFileAsync = promisify(execFile);

export interface BotDbUser {
  discord_id?: unknown;
  discord_username?: unknown;
  discord_display_name?: unknown;
  discord_global_name?: unknown;
  discord_nick?: unknown;
  discord_name?: unknown;
  player_guid?: unknown;
  last_ingame_name?: unknown;
  last_seen_ingame_name?: unknown;
  balance?: unknown;
  registered_at?: unknown;
  registration_vip_granted_once?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

export interface BotDbReport {
  usersSeen: number;
  links: { imported: number; already: number; conflicts: string[] };
  /** Registration roles reconciled for the members this run linked (see syncGameRoles). */
  roles: { applied: number; removed: number; absent: number; refused: number };
  balances: { imported: number; already: number; totalPoints: number };
  members: number;
  welcomeMarkers: number;
}

/** Run the flag-gated child (node:sqlite) against an uploaded file and hand back the rows. */
export async function extractBotDb(dbPath: string): Promise<BotDbUser[]> {
  const script = fileURLToPath(new URL("./botdb-extract.js", import.meta.url));
  let stdout: string;
  try {
    try {
      ({ stdout } = await execFileAsync(process.execPath, ["--experimental-sqlite", script, dbPath], { maxBuffer: 64 * 1024 * 1024 }));
    } catch (err) {
      // Node 22 gates node:sqlite behind this flag; newer Nodes ship it unflagged and a future one
      // may refuse the stale flag outright ("bad option"). Retry unflagged so the upload keeps
      // working across the runtime's own lifecycle — a real read failure recurs and lands below.
      if (!/bad option/i.test((err as { stderr?: string }).stderr ?? "")) throw err;
      ({ stdout } = await execFileAsync(process.execPath, [script, dbPath], { maxBuffer: 64 * 1024 * 1024 }));
    }
  } catch (err) {
    // The child prints { error } on stdout before exiting non-zero — surface ITS message.
    const out = (err as { stdout?: string }).stdout ?? "";
    try { throw errors.badRequest(`could not read the database: ${(JSON.parse(out) as { error?: string }).error ?? (err as Error).message}`); }
    catch (e) { if ((e as { status?: number }).status === 400) throw e; throw errors.badRequest(`could not read the database: ${(err as Error).message}`); }
  }
  const parsed = JSON.parse(stdout) as { users?: BotDbUser[]; error?: string };
  if (parsed.error || !Array.isArray(parsed.users)) throw errors.badRequest(`could not read the database: ${parsed.error ?? "no users table"}`);
  return parsed.users;
}

const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const iso = (v: unknown): string | undefined => {
  const t = Date.parse(s(v));
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
};

const REGISTRATION_NS = REGISTRATION_KV_NS;

export async function importBotDb(repo: Repository, users: BotDbUser[], actorName: string): Promise<BotDbReport> {
  // The balance cap applies to imported credits like every other credit. Reading it here is the
  // whole fix for imported balances landing over the ceiling: `apply` clamps only when it is TOLD the
  // cap, and this one caller — alone among the claim, purchase, gift and staff-adjust paths —
  // omitted the argument, so `opts.maxBalance` was undefined and the clamp never ran.
  const cap = (await repo.economy.config()).balanceCap;
  // Discord ids this run actually linked. The registration role is reconciled AFTER the walk, not
  // inside it: every other link path calls syncGameRoles per write, but those paths link one person
  // at a time, and doing a Discord round trip per row mid-import would put the upload's fate in the
  // hands of a rate limiter. Reconciling the set at the end keeps the same contract at bulk scale.
  const linked = new Set<string>();
  const report: BotDbReport = {
    usersSeen: 0,
    links: { imported: 0, already: 0, conflicts: [] },
    roles: { applied: 0, removed: 0, absent: 0, refused: 0 },
    balances: { imported: 0, already: 0, totalPoints: 0 },
    members: 0,
    welcomeMarkers: 0,
  };

  for (const u of users) {
    const discordId = s(u.discord_id);
    if (!/^\d{5,25}$/.test(discordId)) continue;
    report.usersSeen += 1;
    const discordName = s(u.discord_display_name) || s(u.discord_global_name) || s(u.discord_nick) || s(u.discord_username) || s(u.discord_name) || null;

    // The link, when that bot had one. Sighting stamped with that bot's OWN clock; conflicts refused loudly.
    const guid = s(u.player_guid);
    if (guid) {
      const name = s(u.last_ingame_name) || s(u.last_seen_ingame_name) || discordName || guid;
      const ts = iso(u.updated_at) ?? iso(u.registered_at) ?? iso(u.created_at);
      const platform = /^765\d{14}$/.test(guid) ? "steam" : "unknown";
      // That bot's database predates HLL: Vietnam entirely — every id in it is a WW2 account.
      const [player] = await repo.players.upsertMany([{ game: "hll", platform, platformId: guid, name, ...(ts ? { ts } : {}) }]);
      if (player) {
        const holders = await repo.externalLinks.findPlayers("discord", discordId);
        const existing = (await repo.externalLinks.list(player.id)).find((l) => l.provider === "discord");
        // A conflict is another account FOR THE SAME GAME. Every id in that bot's database is a WW2
        // account, and members who registered on the Vietnam server since the cutover began hold a
        // Vietnam row already — treating that as a conflict would refuse to import the WW2 link of
        // everybody who was quickest to register on the new server, which is the wrong half of the
        // community to lose.
        if (holders.some((h) => h.game === player.game && h.id !== player.id)) {
          const clash = holders.find((h) => h.game === player.game && h.id !== player.id)!;
          report.links.conflicts.push(`${discordId} already linked to ${clash.name} — ${name} not linked`);
        } else if (existing && existing.externalId !== discordId) {
          report.links.conflicts.push(`${name} already linked to another Discord — ${discordId} not linked`);
        } else if (existing) {
          report.links.already += 1;
        } else {
          await repo.externalLinks.set(player.id, "discord", discordId, "v4-import");
          linked.add(discordId);
          report.links.imported += 1;
        }
      }
    }

    // The member + the opening balance. The ref is the convergence: a second run finds it taken.
    await repo.economy.ensureMember(discordId, discordName);
    report.members += 1;
    const balance = Math.trunc(Number(u.balance ?? 0));
    if (Number.isFinite(balance) && balance > 0) {
      const r = await repo.economy.apply({
        discordId, delta: balance, reason: "v4 import: opening balance", ref: `v4:opening:${discordId}`, actorName, discordName,
      }, { maxBalance: cap });
      // totalPoints counts what LANDED, not what that bot held — entry.delta is the trimmed amount, so a
      // capped import reports the truth rather than the wish.
      if (r.applied) { report.balances.imported += 1; report.balances.totalPoints += r.entry.delta; }
      else report.balances.already += 1;
    }

    // That bot already paid this person their registration welcome — the new flow must not pay again.
    //
    // BOTH halves of it. The days ride a kv flag and the currency rides a ledger ref, so marking
    // only the flag left the currency bonus unclaimed: an imported member who then registered a
    // SECOND game's account (Vietnam, for everyone who plays both) collected a welcome that bot had
    // already paid. A zero-delta row is how a ref is spent without moving anything — the ledger
    // then carries the reason, which is also the answer when somebody asks why they got nothing.
    if (Number(u.registration_vip_granted_once ?? 0) === 1) {
      if (!(await repo.pluginKv.get(REGISTRATION_NS, dayBonusKey(discordId)))) {
        await repo.pluginKv.set(REGISTRATION_NS, dayBonusKey(discordId), true);
        report.welcomeMarkers += 1;
      }
      await repo.economy.apply({
        discordId, delta: 0, reason: "v4 import: registration welcome already paid",
        ref: `bonus:${discordId}`, actorName, discordName,
      }).catch(() => {});
    }
  }

  // The role every other link path grants at the moment it writes the link.
  for (const discordId of linked) {
    const r = await syncGameRoles(repo, discordId);
    report.roles.applied += r.applied; report.roles.removed += r.removed;
    report.roles.absent += r.absent; report.roles.refused += r.refused;
  }
  return report;
}
