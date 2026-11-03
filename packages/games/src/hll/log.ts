/**
 * HLL log normalizer — turns raw HLL admin-log lines into canonical `evt.*` events (part of the
 * HLL game module; other games ship their own).
 *
 * Everything downstream (stats, enforcer, alerts, plugins) consumes `evt.*` — never raw
 * log strings — so the system is independent of any one game/version's log format. In
 * later phases these matchers become editable registry data (per game+version) with
 * "golden examples"; Phase 1 hard-codes the common HLL patterns to prove the pipeline.
 */
import { describeTeamSwitch, parseTeamSwitchBody } from "../team-switch.js";
import type { Evt, KillEvt, PlayerEvt, BaseEvt, ModerationEvt, VoteEvt } from "@app/events";
import { sideFromTeam } from "./match.js";

export interface NormalizeContext {
  serverId: string;
  /** ISO timestamp for the event; defaults to now if the log line has none. */
  ts?: string;
}

type Matcher = (line: string, ctx: Required<NormalizeContext>) => Evt | null;

/**
 * HLL prefixes every admin-log entry with a relative age + an absolute unix timestamp:
 *
 *   "[3 ms (1784761685)] KILL: …"        "[13.8 sec (1784761672)] KILL: …"
 *   "[1:03 min (1784761672)] CAMERA…"    "[1:02:33 hours (1784761672)] MATCH ENDED …"
 *
 * The relative part changes every poll for the SAME event; the unix timestamp in parens and the
 * message body are stable — so those form the identity/dedup key, and the timestamp is the
 * event's real time.
 *
 * The age is `\d[\d.:]*`, NOT `[\d.]+`, and the colon is the whole point. Past sixty seconds the
 * game stops counting in decimals and starts writing clock time — `1:03 min`, `1:02:33 hours` —
 * and a pattern without the colon simply does not match those. That failed silently and
 * completely: an unmatched prefix is not stripped, so the body still begins with "[1:03 min …",
 * every matcher below is anchored with `^`, and the line parses as nothing at all.
 *
 * High-frequency events survived that (a kill is read while it is still seconds old, and the
 * older copies of it are duplicates we already had), which is exactly why it went unnoticed —
 * but a one-off line that is not read inside its first minute was dropped for good. Admin camera
 * is the clearest case: a staff member enters spectator once, and if that single line aged past
 * a minute before it was read, no record of the visit existed anywhere.
 */
const PREFIX_RE = /^\[\s*\d[\d.:]*\s*(?:ms|sec|secs|min|mins|hour|hours|hr|hrs|day|days)\s*\((\d+)\)\]\s*/i;

/**
 * The longest line this parser will look at.
 *
 * The player patterns are `(.+?)\(...\)` — a lazy run followed by a bracket — and on a line full
 * of brackets that never completes a match, the engine retries from every position. It is
 * quadratic, and measurably so: 8,000 characters takes a quarter of a second, 32,000 takes four
 * seconds, 200,000 would take minutes. `exec` is synchronous, and the worker that calls it holds
 * every server's RCON connection, the auto-mod, the map vote and the heartbeat on one event loop —
 * so one absurd line does not slow ingestion down, it stops the whole process for as long as the
 * match takes, and the System view reports the worker dead while it happens.
 *
 * A real line is a name, a name, and a weapon, or a name and a chat message: hundreds of
 * characters. Four thousand is far above anything the game emits and caps the worst case at
 * about a tenth of a second. Longer input is TRUNCATED rather than dropped, because the part that
 * says what the event is sits at the front — a clipped chat line is still worth storing.
 *
 * This is not hypothetical input. The CRCON importer runs the same parser over an archive file
 * from somebody else's install, and #158 is a standing reminder that the live log carries
 * corrupted content of its own.
 */
const MAX_LINE_LEN = 4_000;

/** Split the "[<rel> (<unix>)]" prefix off a raw line. Returns the body, event ts, and a
 *  stable dedup key (unix timestamp + body, with the volatile relative time removed). */
export function parseLogPrefix(line: string): { body: string; ts?: string; key: string } {
  const trimmed = (line.length > MAX_LINE_LEN ? line.slice(0, MAX_LINE_LEN) : line).trim();
  const m = PREFIX_RE.exec(trimmed);
  if (!m) return { body: trimmed, key: trimmed };
  const unix = Number(m[1]);
  const body = trimmed.slice(m[0].length).trim();
  const ts = Number.isFinite(unix) ? new Date(unix * 1000).toISOString() : undefined;
  return { body, ts, key: `${m[1]}|${body}` };
}

/** Stable identity for a raw log line, used to dedup across polls (the relative time in the
 *  prefix changes every poll, so the raw string can't be used directly). */
export function logLineKey(line: string): string {
  return parseLogPrefix(line).key;
}

// Player token like: Name(Allies/76561198...)  or  Name(SOV/hashedid)  or  Name(76561198...).
// The faction token is ANY text before the slash — never a hardcoded list. The game keeps adding
// factions (SOV, CW, B8A, DAK, …), and an unlisted token used to be swallowed INTO the player id
// ("SOV/7656…"), minting phantom players and losing every kill on servers running newer versions.
const PLAYER = String.raw`(.+?)\((?:[^/)]+/)?([^)]*)\)`;
// Same, but the faction token is captured (kills need the side for match scoreboards): name, team, id.
const KILL_PLAYER = String.raw`(.+?)\((?:([^/)]+)/)?([^)]*)\)`;

const KILL_RE = new RegExp(String.raw`^KILL:\s*${KILL_PLAYER}\s*->\s*${KILL_PLAYER}\s*with\s*(.+)$`, "i");
const TEAMKILL_RE = new RegExp(String.raw`^TEAM KILL:\s*${KILL_PLAYER}\s*->\s*${KILL_PLAYER}\s*with\s*(.+)$`, "i");
const CONNECT_RE = /^CONNECTED\s+(.+?)\s*\(([^)]*)\)\s*$/i;
const DISCONNECT_RE = /^DISCONNECTED\s+(.+?)\s*\(([^)]*)\)\s*$/i;
// Patterns aligned with CRCON's proven parse_log_line (the same HLL admin-log text, whether
// read via legacy `showlog` or v2 `GetAdminLog`). Kept as our own data-driven table.
const CHAT_RE = new RegExp(String.raw`^CHAT\[(Team|Unit|Squad)\]\[${PLAYER}\]:\s*(.*)$`, "i");
const MATCH_START_RE = /^MATCH START\s+(.+)$/i;
const MATCH_END_RE = /^MATCH ENDED\s+(.+)$/i;
// KICK/BAN: "KICK: [Name] HAS BEEN KICKED. [reason]"  /  "BAN: [Name] HAS BEEN PERMANENTLY BANNED. [reason]"
const KICK_BAN_RE = /^(KICK|BAN):\s*\[(.+?)\]\s*(.*)$/i;
// VOTESYS lines (real HLL vote format; not the earlier "Vote started:" guess).
const VOTE_STARTED_RE = /^VOTESYS:\s*Player\s*\[(.+?)\]\s*Started a vote of type\s*\((.+?)\)\s*against\s*\[(.+?)\]\.\s*VoteID:\s*\[\d+\]/i;
const VOTE_COMPLETED_RE = /^VOTESYS:\s*Vote\s*\[\d+\]\s*completed\.\s*Result:\s*(.+)$/i;
// One player's BALLOT in a vote-kick: "VOTESYS: Player [Dingbat252] voted [PV_Favour] for VoteID[2]".
// The choice token is kept as data rather than folded to a boolean here, because the game has three
// of them — PV_Favour, PV_Against and PV_Ignored (the popup dismissed) — and flattening the third
// into "no" would inflate every against-count. The public scoreboard's nb_voted_yes/nb_voted_no
// read the token; nothing else in the app does.
const VOTE_CAST_RE = /^VOTESYS:\s*Player\s*\[(.+?)\]\s*voted\s*\[(.+?)\]\s*for\s*VoteID\s*\[?\d+\]?/i;
// MESSAGE: player [Name(id)], content [message]
const MESSAGE_RE = /^MESSAGE:\s*player\s*\[(.+?)\((.*?)\)\],\s*content\s*\[([\s\S]+)\]$/i;
// CAMERA: "CAMERA [Name (id)] Entered Admin Camera" / "… Left Admin Camera".
//
// Deliberately loose about the punctuation — the colon, the brackets and the space before the id
// all vary between the legacy `showlog` text and v2 `GetAdminLog`, and this line is the ONLY
// record that a staff member was in spectator. A pattern that insists on one spelling would go
// quiet on the other with nothing to say it had.
const CAMERA_RE = /^CAMERA(?:\s*:)?\s*\[?\s*(.+?)\s*\(([^)]*)\)\s*\]?\s*(.*)$/i;

/**
 * Does this camera line mean the admin went IN, or came OUT?
 *
 * Exported because two readers need the same answer and must not each invent one: the live log
 * parser below, and the CRCON archive importer, which replays the same sentences out of a
 * historical database rather than off the wire. A ban that half-imports is visible; a camera
 * session imported with the wrong direction is a silent lie about who was watching and when.
 *
 * `null` means the wording is neither — a line we do not recognise. Callers must skip it rather
 * than guess, because guessing opens a session that swallows the next real one.
 */
export function cameraEntered(text: string | null | undefined): boolean | null {
  const upper = (text ?? "").toUpperCase();
  if (/\bENTER(?:ED|ING)?\b/.test(upper)) return true;
  if (/\b(?:LEFT|LEAV|EXIT)/.test(upper)) return false;
  return null;
}

/**
 * The player id exactly as the game wrote it, or undefined when the line didn't really carry one.
 *
 * The character set stays deliberately wide open — that is what task #158 fixed, and narrowing it
 * would re-break every server running a faction the game added after we shipped. This only removes
 * the two shapes that are not ids at all:
 *
 *   - blank or whitespace-only, from a line like `KILL: A(Allies/) -> B(Axis/) with MP40`. The
 *     empty string was already dropped downstream, but "   " is truthy, so it became a REAL player
 *     row — one shared phantom that every malformed line on the server collapsed into, wearing
 *     whichever name was parsed alongside it and accumulating everyone's kills. That is the same
 *     failure #157 and #158 were about, arriving through a different door.
 *   - absurdly long, which only happens when the line was mis-split. Real ids are short: steam64
 *     is 17 characters, a UUID is 36, a T17 hex id is 32. Past 128 it is not an id.
 *
 * Dropping the id keeps the event — the kill still counts toward the match, it just isn't
 * attributed to a player we can't name. Inventing a player is the worse of the two outcomes.
 */
const MAX_PLAYER_ID_LEN = 128;
function cleanPlayerId(raw: string | undefined): string | undefined {
  const id = raw?.trim();
  if (!id || id.length > MAX_PLAYER_ID_LEN) return undefined;
  return id;
}

/**
 * A display name, bounded. Unlike the id, an over-long name is CLIPPED rather than dropped: the
 * name is what a human reads the event by, and half of it beats none of it.
 *
 * The id had a cap and the name did not, so a mis-split line minted an event carrying a name
 * thousands of characters long — into the event store, the game log, the kill feed and the Discord
 * relay, all of which assume something a person could have typed. The game's own limit is around
 * twenty characters; this leaves a wide margin and still bounds the field.
 */
const MAX_NAME_LEN = 128;
function cleanName(raw: string | undefined): string | undefined {
  const name = raw?.trim();
  if (!name) return undefined;
  return name.length > MAX_NAME_LEN ? name.slice(0, MAX_NAME_LEN) : name;
}

function base(kind: BaseEvt["kind"], ctx: Required<NormalizeContext>): BaseEvt {
  return { kind, serverId: ctx.serverId, ts: ctx.ts };
}

const MATCHERS: Matcher[] = [
  (line, ctx) => {
    const m = KILL_RE.exec(line);
    if (!m) return null;
    // groups: 1 name, 2 team, 3 id, 4 vname, 5 vteam, 6 vid, 7 weapon. Teams feed match scoreboards;
    // the RESOLVED sides ride along so game-agnostic consumers (feed coloring) never see raw tokens.
    return { ...base("evt.kill", ctx), playerName: cleanName(m[1]), playerId: cleanPlayerId(m[3]), victimName: cleanName(m[4]), victimId: cleanPlayerId(m[6]), weapon: m[7]?.trim(), data: { playerTeam: m[2] || null, victimTeam: m[5] || null, actorSide: sideFromTeam(m[2]), victimSide: sideFromTeam(m[5]) } } as KillEvt;
  },
  (line, ctx) => {
    const m = TEAMKILL_RE.exec(line);
    if (!m) return null;
    return { ...base("evt.teamkill", ctx), playerName: cleanName(m[1]), playerId: cleanPlayerId(m[3]), victimName: cleanName(m[4]), victimId: cleanPlayerId(m[6]), weapon: m[7]?.trim(), data: { playerTeam: m[2] || null, victimTeam: m[5] || null, actorSide: sideFromTeam(m[2]), victimSide: sideFromTeam(m[5]) } } as KillEvt;
  },
  (line, ctx) => {
    const m = CONNECT_RE.exec(line);
    if (!m) return null;
    return { ...base("evt.player.connected", ctx), playerName: cleanName(m[1]), playerId: cleanPlayerId(m[2]) } as PlayerEvt;
  },
  (line, ctx) => {
    const m = DISCONNECT_RE.exec(line);
    if (!m) return null;
    return { ...base("evt.player.disconnected", ctx), playerName: cleanName(m[1]), playerId: cleanPlayerId(m[2]) } as PlayerEvt;
  },
  (line, ctx) => {
    const m = CHAT_RE.exec(line);
    if (!m) return null;
    const scope = (m[1] ?? "").toLowerCase();
    const kind = scope === "team" ? "evt.chat.team" : "evt.chat.squad";
    // Keep the message body so chat surfaces (Discord relay, word-filter rules) have the text.
    return { ...base(kind, ctx), playerName: cleanName(m[2]), playerId: cleanPlayerId(m[3]), data: { message: m[4]?.trim() ?? "" } } as PlayerEvt;
  },
  (line, ctx) => {
    // "TEAMSWITCH Name (Allies > None)". The line carries no player id, so ingest links it by name;
    // the two teams are kept, described on their own here and against the round's earlier lines
    // by ingest (team-switch.ts says why one line alone never shows a side swap).
    const m = parseTeamSwitchBody(line);
    if (!m) return null;
    return { ...base("evt.player.teamSwitched", ctx), playerName: cleanName(m.name), data: describeTeamSwitch(m).data } as PlayerEvt;
  },
  (line, ctx) => {
    const m = MATCH_START_RE.exec(line);
    if (!m) return null;
    // "MATCH START Carentan Warfare" → keep the map so match history can show what was played.
    return { ...base("evt.match.started", ctx), data: { map: m[1]?.trim() ?? "" } };
  },
  (line, ctx) => {
    const m = MATCH_END_RE.exec(line);
    if (!m) return null;
    // "MATCH ENDED `Kharkov Warfare` ALLIED (2 - 3) AXIS" — the exact shape varies, so keep the
    // whole tail as the result and pull the score out of the LAST "(a - b)" parens when present.
    // Not end-anchored: the modern line puts the second side label AFTER the parens, and an end
    // anchor made every modern round's score invisible to the parser.
    const tail = (m[1] ?? "").trim();
    let score: string | undefined;
    for (const s of tail.matchAll(/\((\s*\d+\s*[-–]\s*\d+\s*)\)/g)) score = s[1]?.trim();
    return { ...base("evt.match.ended", ctx), data: { result: tail, ...(score ? { score } : {}) } };
  },
  // Moderation: kicks and bans (including server-side auto team-kill enforcement).
  (line, ctx) => {
    const m = KICK_BAN_RE.exec(line);
    if (!m) return null;
    const isBan = (m[1] ?? "").toUpperCase() === "BAN";
    const tail = (m[3] ?? "").trim();
    // The game formats the actual reason in a trailing bracket, after boilerplate:
    //   "HAS BEEN KICKED. [YOU WERE KICKED FOR BEING IDLE]" → reason "YOU WERE KICKED FOR BEING IDLE".
    // Fall back to the whole tail if there's no bracketed segment.
    const bracket = tail.match(/\[([\s\S]+)\]\s*$/);
    const detail = (bracket?.[1] ?? tail).trim();
    const upper = line.toUpperCase();
    const evt = {
      ...base(isBan ? "evt.player.banned" : "evt.player.kicked", ctx),
      playerName: cleanName(m[2]),
      reason: detail || undefined,
      auto: upper.includes("FOR TEAM KILLING") || upper.includes("ANTI-CHEAT") || undefined,
      data: { reason: detail },
    } as ModerationEvt;
    if (isBan) evt.banType = upper.includes("PERMANENTLY") ? "perma" : "temp";
    return evt;
  },
  (line, ctx) => {
    const m = VOTE_STARTED_RE.exec(line);
    if (!m) return null;
    return { ...base("evt.vote.started", ctx), playerName: cleanName(m[1]), voteType: m[2]?.trim(), target: m[3]?.trim(), data: { voteType: m[2]?.trim(), target: m[3]?.trim() } } as VoteEvt;
  },
  (line, ctx) => {
    const m = VOTE_COMPLETED_RE.exec(line);
    if (!m) return null;
    return { ...base("evt.vote.completed", ctx), result: m[1]?.trim(), data: { result: m[1]?.trim() } } as VoteEvt;
  },
  // Must be tried AFTER "Started a vote", whose sentence also begins "VOTESYS: Player [name]".
  (line, ctx) => {
    const m = VOTE_CAST_RE.exec(line);
    if (!m) return null;
    const choice = m[2]?.trim() ?? null;
    return { ...base("evt.vote.cast", ctx), playerName: cleanName(m[1]), data: { choice, content: line } } as VoteEvt;
  },
  // Admin message to a player.
  (line, ctx) => {
    const m = MESSAGE_RE.exec(line);
    if (!m) return null;
    return { ...base("evt.admin.message", ctx), playerName: cleanName(m[1]), playerId: cleanPlayerId(m[2]), data: { message: m[3]?.trim() } } as PlayerEvt;
  },
  /**
   * Admin camera (spectator) enter/leave.
   *
   * `entered` is decided HERE rather than left to whoever reads the event, because the wording is
   * the game's and belongs to the parser: everything downstream — the session pairing, the in-game
   * announcement, the history table — turns on that one boolean, and three copies of "does this
   * sentence mean entered" would be three chances to disagree. A line that says neither is stored
   * with `entered: null`, which the pairing skips: an unrecognised camera line is a gap in the
   * record, not a half-open session that swallows the next real one.
   */
  (line, ctx) => {
    const m = CAMERA_RE.exec(line);
    if (!m) return null;
    const tail = (m[3] ?? "").trim();
    const entered = cameraEntered(tail);
    return {
      ...base("evt.admin.camera", ctx),
      playerName: cleanName(m[1]),
      playerId: cleanPlayerId(m[2]),
      data: { entered, message: tail },
    } as PlayerEvt;
  },
];

/** Parse a single raw log line into a canonical event, or `null` if unrecognized. */
export function normalizeLine(line: string, ctx: NormalizeContext): Evt | null {
  const { body, ts } = parseLogPrefix(line);
  if (!body) return null;
  // Prefer an explicit ctx.ts, else the log line's own timestamp, else now.
  const full: Required<NormalizeContext> = { serverId: ctx.serverId, ts: ctx.ts ?? ts ?? new Date().toISOString() };
  for (const m of MATCHERS) {
    const evt = m(body, full);
    if (evt) return evt;
  }
  return null;
}

/** Parse many lines, dropping unrecognized ones. */
export function normalizeLines(lines: string[], ctx: NormalizeContext): Evt[] {
  const out: Evt[] = [];
  for (const line of lines) {
    const evt = normalizeLine(line, ctx);
    if (evt) out.push(evt);
  }
  return out;
}
