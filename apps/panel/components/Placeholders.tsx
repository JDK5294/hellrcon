"use client";
/**
 * Message placeholders — the list staff pick from, and the reference that explains them.
 *
 * Every player-facing text the app sends is rendered by one engine (MESSAGE_PLACEHOLDERS in
 * @app/db) before it reaches the game. The panel does not import server packages, so the shared
 * list is mirrored here — keep the two in step. Some features fill a few tokens of their own on
 * top ({violation} on a seeding warning, {reward} on the seed reward); those are listed per
 * feature so the reference is the whole truth, not just the shared half.
 *
 * Under a message box the list is a row of chips: click one and it is typed into the box at the
 * cursor (or appended, if the box was never focused). Hover text does not exist on a phone, so the
 * meanings are one click away in a fold-out rather than hidden in tooltips.
 */
import { useRef, type ReactNode } from "react";
import { useAppNav } from "../lib/nav";
import { useServers } from "../lib/servers";

export interface Placeholder { token: string; label: string; example: string; scope: "player" | "server" }

/** The shared vocabulary — works in every player-facing message. */
export const PLACEHOLDERS: Placeholder[] = [
  { token: "player_name", label: "The player's in-game name.", example: "Kreitz", scope: "player" },
  { token: "player_id", label: "The player's game id.", example: "76561198000000001", scope: "player" },
  { token: "vip_until", label: "When their VIP on this server ends, in the auto-settings timezone. “permanent” for permanent VIP, “no VIP” when they have none.", example: "Oct 3, 7:45 PM EDT", scope: "player" },
  { token: "vip_remaining", label: "How long their VIP on this server has left.", example: "2d 4h", scope: "player" },
  { token: "balance", label: "Their points balance. Only fills for a player with a linked Discord — otherwise it is left as typed.", example: "420", scope: "player" },
  { token: "currency", label: "What the community calls its points (Economy settings).", example: "Points", scope: "server" },
  { token: "server_name", label: "This server's name.", example: "[ABC] WW2 #1", scope: "server" },
  { token: "map_name", label: "The map being played right now.", example: "Carentan", scope: "server" },
  { token: "player_count", label: "How many players are on right now.", example: "64", scope: "server" },
  { token: "seed_count", label: "How many seed rounds they've been rewarded for on this server (in a reward message, this round counts).", example: "12", scope: "player" },
  { token: "playtime", label: "Their total time played on this server.", example: "312h", scope: "player" },
  { token: "players_needed", label: "How many more players until the server reaches its seed target (Seeding settings); 0 once it's live.", example: "14", scope: "server" },
  { token: "next_map", label: "The next map: a staff pick if there is one, else the leading option of the open vote, else the game's own rotation.", example: "Carentan — Warfare", scope: "server" },
];

/** Tokens one feature fills on top of the shared ones, with where they work. */
const FEATURE_LABELS: Record<string, string> = {
  violation: "What was detected — the broken rule, in a sentence.",
  received_warnings: "How many warnings this player has had.",
  max_warnings: "How many warnings are allowed before a punish.",
  received_punishes: "How many punishes this player has had.",
  max_punishes: "How many punishes are allowed before the kick.",
  window: "How long a paid seeder waits before seeding pays them again — “1 hour”.",
  reward: "Whatever the reward was — “1d of VIP”, “500 Points”, or both.",
  reward_hours: "The VIP hours granted, as a plain number.",
  reward_points: "The points granted.",
  disallowed_roles: "The roles not allowed while seeding.",
  disallowed_weapons: "The weapons not allowed while seeding.",
  disallowed_commander_abilities: "The commander abilities not allowed while seeding.",
  attacker_name: "Who did the killing.",
  victim_name: "Who was killed.",
  weapon: "The weapon used.",
  player: "The admin's in-game name.",
  category: "The top-stats category they placed in (kills, support…).",
  rank: "Their place in that category (1, 2, 3…).",
  value: "Their score in that category.",
  streak: "How many kills without dying.",
  days: "How many days in a row.",
  kills: "Their kills this match.",
  deaths: "Their deaths this match.",
  kd: "Their K/D this match (two decimals).",
  kpm: "Their kills per minute this match.",
  combat: "Their combat score this match.",
  offense: "Their offense score this match.",
  defense: "Their defense score this match.",
  support: "Their support score this match.",
  teamplay: "Their combat + support this match.",
  vehicles: "Vehicles they destroyed this match.",
  minutes: "Minutes they played this match.",
  map: "The map that match was on.",
  minutes_today: "Minutes they have played today.",
  match_minutes: "How long the match that just ended ran, in minutes.",
};

export const FEATURE_PLACEHOLDERS: { where: string; scope: "player" | "server"; tokens: string[] }[] = [
  { where: "Seeding — announcement", scope: "player", tokens: ["disallowed_roles", "disallowed_weapons", "disallowed_commander_abilities"] },
  { where: "Seeding — warn message", scope: "player", tokens: ["violation", "received_warnings", "max_warnings"] },
  { where: "Seeding — punish message", scope: "player", tokens: ["violation", "received_punishes", "max_punishes"] },
  { where: "Seeding — kick message", scope: "player", tokens: ["violation"] },
  { where: "Seeding — reward message", scope: "player", tokens: ["reward", "reward_hours", "reward_points"] },
  { where: "Seeding — already-paid message", scope: "player", tokens: ["window"] },
  { where: "Enforcer rules", scope: "player", tokens: ["attacker_name", "victim_name", "weapon", "violation"] },
  { where: "Player triggers — kill, death and team-kill events", scope: "player", tokens: ["attacker_name", "victim_name", "weapon"] },
  { where: "Game rewards — top stats (the winner's own match)", scope: "player", tokens: ["category", "rank", "value", "reward", "kills", "deaths", "kd", "kpm", "combat", "offense", "defense", "support", "teamplay", "vehicles", "minutes", "map"] },
  { where: "Game rewards — kill streaks (the kill that reached the tier)", scope: "player", tokens: ["streak", "reward", "weapon", "victim_name"] },
  { where: "Game rewards — days played in a row", scope: "player", tokens: ["days", "reward", "minutes_today"] },
  { where: "Game rewards — days seeding in a row", scope: "player", tokens: ["days", "reward"] },
  { where: "Game rewards — everyone at match end", scope: "player", tokens: ["reward", "match_minutes", "minutes", "map"] },
  { where: "Admin camera notice", scope: "server", tokens: ["player"] },
];

/** Where each scope of the shared list works — the reference's "where can I use this". */
const WHERE_PLAYER = [
  "Player actions — message, and kick / punish / ban reasons (also when sent for approval)",
  "Groups — message and temp-ban reason, filled per member",
  "Moderation → Messages — message everyone, filled per player",
  "Player triggers and enforcer rules",
  "Map vote reminders",
  "Auto settings — timed match messages",
  "Seeding — announcement, warn, punish, kick, reward and already-paid",
];
const WHERE_SERVER = [
  "Broadcasts — send now and the rotating list",
  "The live welcome message (Broadcast page) — the game's own welcome text, kept filled in",
  "The admin camera notice",
];

const labelOf = (token: string) => {
  const [base, server] = token.split(":");
  if (server) return base === "vip_until" ? `When their VIP on ${server} ends — works across games through their Discord link.` : `How long their VIP on ${server} has left.`;
  return PLACEHOLDERS.find((p) => p.token === token)?.label ?? FEATURE_LABELS[token] ?? "";
};

/**
 * "{vip_until:<server>}" and "{vip_remaining:<server>}" for each server — a WW2 message can tell a
 * player their Vietnam VIP. Picked from the chips, never typed.
 * Only offered when there is more than one server; with one, plain {vip_until} already says it all.
 */
function useServerVipTokens(): string[] {
  const { servers } = useServers();
  if (!servers || servers.length < 2) return [];
  return servers.flatMap((sv) => {
    // The first of its names that can sit inside a placeholder: the shortest readable one staff
    // use, and never one with a colon or brace in it (an in-game name carrying a URL would end
    // the placeholder early). The server matches on any of its names, so any of these works.
    const name = [sv.nickname, sv.name, sv.gameName].find((n) => n && n.trim() && n.length <= 120 && !/[{}:]/.test(n))?.trim();
    return name ? [`vip_until:${name}`, `vip_remaining:${name}`] : [];
  });
}

/**
 * Type `text` into a React-controlled input at its cursor. Setting `.value` directly is invisible
 * to React, so the native setter is used and an `input` event dispatched — onChange then fires
 * exactly as if the person had typed it.
 */
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const before = el.value.slice(0, start);
  const pad = before && !/\s$/.test(before) ? " " : "";
  const next = before + pad + text + el.value.slice(end);
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, next);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  const caret = start + pad.length + text.length;
  el.focus();
  el.setSelectionRange(caret, caret);
}

/**
 * A box a chip may type into: a text input or textarea that is not marked `data-no-placeholders`
 * (a preset's NAME box sits between a message and its chips — a placeholder there is never meant).
 */
const isTextField = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement =>
  (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && (el.type === "text" || el.type === "")))
  && !el.hasAttribute("data-no-placeholders");

/**
 * The placeholder list under a message box. `scope="server"` is for texts sent to the whole server
 * at once (broadcasts, the admin-camera notice) — there is no one player to fill {player_name} for.
 * `extra` names the feature's own tokens, listed first.
 */
export function PlaceholderHint({ scope = "player", extra, children }: {
  scope?: "player" | "server";
  extra?: string[];
  children?: ReactNode;
}) {
  const nav = useAppNav();
  const box = useRef<HTMLDivElement>(null);
  // The box that had focus when a chip was pressed — used only if it is one this list serves.
  const focused = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const shared = PLACEHOLDERS.filter((p) => scope === "player" || p.scope === "server");
  const serverVip = useServerVipTokens();
  const tokens = [...(extra ?? []), ...shared.map((p) => p.token), ...(scope === "player" ? serverVip : [])];

  /**
   * The box a chip types into. Walk up from the list to the first container holding a text box
   * above it — that container is what this list serves. The box being edited wins if it is in
   * there (the rotating broadcast list: whichever line you are on); otherwise the nearest box
   * above. A box being edited ELSEWHERE on the page (Seeding's announcement, while clicking the
   * warn message's chips) is never the target — that is a different message.
   */
  function target(): HTMLInputElement | HTMLTextAreaElement | null {
    const self = box.current;
    let node: HTMLElement | null = self?.parentElement ?? null;
    for (let i = 0; self && node && i < 4; i++, node = node.parentElement) {
      const fields = [...node.querySelectorAll("textarea, input")].filter(isTextField);
      const above = fields.filter((el) => el.compareDocumentPosition(self) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (!above.length) continue;
      const f = focused.current;
      return f && f.isConnected && fields.includes(f) ? f : above[above.length - 1]!;
    }
    return null;
  }

  function insert(token: string) {
    const el = target();
    if (el && !el.disabled && !el.readOnly) typeInto(el, `{${token}}`);
    else void navigator.clipboard?.writeText(`{${token}}`).catch(() => {});
  }

  return (
    <div ref={box} className="placeholder-hint hint">
      <div className="placeholder-chips">
        <span>Placeholders:</span>
        {tokens.map((t) => (
          <button key={t} type="button" className="placeholder-chip" title={labelOf(t)}
            // Keep focus (and the cursor position) in the message box while clicking.
            onMouseDown={(e) => { e.preventDefault(); const a = document.activeElement; focused.current = isTextField(a) ? a : null; }}
            onClick={() => insert(t)}>
            {`{${t}}`}
          </button>
        ))}
        {children && <span>{children}</span>}
      </div>
      <details className="placeholder-meanings">
        <summary>What each one fills</summary>
        <dl>
          {tokens.map((t) => (
            <div key={t}><dt><code>{`{${t}}`}</code></dt><dd>{labelOf(t)}</dd></div>
          ))}
        </dl>
        <button type="button" className="linklike" onClick={() => nav.go("help", undefined, "placeholders")}>The full placeholder list</button>
      </details>
    </div>
  );
}

/** Help → Placeholders: every token, what it fills, an example, and where it works. */
export function PlaceholderReference() {
  const serverVip = useServerVipTokens();
  return (
    <div className="placeholder-reference">
      <p>
        Type any of these into a message and it is filled in when the message is sent — each player
        reads their own. A placeholder that is misspelled, or can&apos;t be filled where it is used
        (a player placeholder in a broadcast, which goes to everyone at once), is sent exactly as
        typed, so a mistake shows up instead of leaving a gap in the sentence.
      </p>
      <h4>Works in every message</h4>
      <table className="table placeholder-table">
        <thead><tr><th>Placeholder</th><th>Fills with</th><th>Example</th><th>Where</th></tr></thead>
        <tbody>
          {PLACEHOLDERS.map((p) => (
            <tr key={p.token}>
              <td><code>{`{${p.token}}`}</code></td>
              <td>{p.label}</td>
              <td className="muted">{p.example}</td>
              <td className="muted">{p.scope === "server" ? "Everywhere" : "Messages to one player"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid">
        <div>
          <h4>Messages to one player — every placeholder</h4>
          <ul>{WHERE_PLAYER.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
        <div>
          <h4>Whole-server messages — server placeholders only</h4>
          <ul>{WHERE_SERVER.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      </div>
      <h4>VIP on a particular server</h4>
      <p>
        Add a server&apos;s name after a colon to read a player&apos;s VIP on <em>that</em> server —
        from a WW2 message you can tell someone when their Vietnam VIP ends, the same way seed
        rewards bridge between the games. Across games the player needs their Discord linked (that
        is how their two game accounts are joined); without it the placeholder reads &ldquo;not
        linked&rdquo;. Pick these from the chips under a message box rather than typing
        them. Renaming a server later does not break a message that already uses its old name —
        the server remembers what it used to be called. A name that matches no server is left as typed.
      </p>
      {serverVip.length > 0 && (
        <table className="table placeholder-table">
          <thead><tr><th>Placeholder</th><th>Fills with</th></tr></thead>
          <tbody>
            {serverVip.map((t) => (
              <tr key={t}><td><code>{`{${t}}`}</code></td><td>{labelOf(t)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      <h4>Extra placeholders for particular features</h4>
      <table className="table placeholder-table">
        <thead><tr><th>Where</th><th>Placeholder</th><th>Fills with</th></tr></thead>
        <tbody>
          {FEATURE_PLACEHOLDERS.flatMap((f) => f.tokens.map((t, i) => (
            <tr key={`${f.where}-${t}`}>
              <td>{i === 0 ? f.where : ""}</td>
              <td><code>{`{${t}}`}</code></td>
              <td>{labelOf(t)}</td>
            </tr>
          )))}
        </tbody>
      </table>
    </div>
  );
}
