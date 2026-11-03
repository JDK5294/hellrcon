/**
 * Transform the host-side CRCON archive file into our own systems (players, VIPs, bans,
 * watchlist, notes, templates). Streams the NDJSON file line by line — it never loads the archive
 * into memory, so even a multi-hundred-MB pull transforms with a flat footprint. Reads only the
 * file (never CRCON), and every write is idempotent, so it's safe to re-run after a parser fix
 * without re-pulling. The only in-memory state is small keyed caches (list ids, seen keys).
 */
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { MIN_MATCH_MS, type Repository, type ServerRow, type CrconArchiveRecord } from "@app/db";
import { crconBackupFile, roleSecondsFromUnits } from "@app/shared";
import { cameraEntered, describeTeamSwitch, parseTeamSwitchBody, walkSwitchHistory, type SwitchHistoryColumns } from "@app/games";
import { ROUND_LOOKBACK_MS } from "@app/ingest";
import { mapVips, mapBans, inferPlatform, normExpiry, looksLikeGamePlayerId, watchInfoOf, crconTime } from "./crcon-import.js";
import { syncWatchFlag } from "./watch.js";

const str = (v: unknown): string => (v == null ? "" : String(v)).trim();

/** A typed column that grows by doubling — numbers without an object (or a boxed number) each. */
class Column<T extends Float64Array | Int32Array> {
  private n = 0;
  constructor(private a: T, private readonly make: (size: number) => T) {}
  push(v: number): void {
    if (this.n === this.a.length) { const b = this.make(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  at(i: number): number { return this.a[i]!; }
  get length(): number { return this.n; }
}

/**
 * An archive's team switches, kept as compact columns for the round-by-round reading at the end:
 * under sixty bytes a switch (measured, sort index included), where an event object per switch
 * cost over seven hundred — and a multi-year archive carries millions of them, on an apply that
 * already runs near its heap ceiling. Players and team names are interned; a line's key is kept as
 * its number when it is CRCON's plain integer id, and as text only when it is not.
 */
class SwitchColumns implements SwitchHistoryColumns {
  private readonly tsMs = new Column(new Float64Array(1024), (n) => new Float64Array(n));
  private readonly whoAt = new Column(new Int32Array(1024), (n) => new Int32Array(n));
  private readonly fromAt = new Column(new Int32Array(1024), (n) => new Int32Array(n));
  private readonly toAt = new Column(new Int32Array(1024), (n) => new Int32Array(n));
  private readonly keyNum = new Column(new Float64Array(1024), (n) => new Float64Array(n));
  private readonly keyText = new Map<number, string>();
  private readonly strings: string[] = [];
  private readonly stringAt = new Map<string, number>();
  private intern(s: string): number {
    let i = this.stringAt.get(s);
    if (i === undefined) { i = this.strings.length; this.strings.push(s); this.stringAt.set(s, i); }
    return i;
  }
  get length(): number { return this.tsMs.length; }
  push(row: { tsMs: number; who: string; from: string; to: string; dedupeKey: string }): void {
    const m = /^crcon:(0|[1-9]\d{0,14})$/.exec(row.dedupeKey);
    if (!m) this.keyText.set(this.length, row.dedupeKey);
    this.keyNum.push(m ? Number(m[1]) : -1);
    this.tsMs.push(row.tsMs);
    this.whoAt.push(this.intern(row.who));
    this.fromAt.push(this.intern(row.from));
    this.toAt.push(this.intern(row.to));
  }
  ts(i: number): number { return this.tsMs.at(i); }
  who(i: number): string { return this.strings[this.whoAt.at(i)]!; }
  from(i: number): string { return this.strings[this.fromAt.at(i)]!; }
  to(i: number): string { return this.strings[this.toAt.at(i)]!; }
  dedupeKey(i: number): string { return this.keyText.get(i) ?? `crcon:${this.keyNum.at(i)}`; }
}
function pick(o: unknown, ...keys: string[]): unknown {
  if (!o || typeof o !== "object") return undefined;
  const r = o as Record<string, unknown>;
  for (const k of keys) { const v = r[k]; if (v !== undefined && v !== null && v !== "") return v; }
  return undefined;
}
const nested = (r: unknown) => (r && typeof r === "object" ? (r as Record<string, unknown>).player : undefined);
// The game player id is the one determining key for a person. Candidates are gated so a CRCON
// internal database id (a small integer in a plain `id` field) can never be mistaken for a player
// and mint a phantom profile — a row without a real game id maps to nothing.
const playerIdOf = (r: unknown): string => {
  for (const o of [r, nested(r)]) {
    if (!o) continue;
    // Fields that explicitly claim to be the player id are trusted as-is.
    const explicit = str(pick(o, "player_id", "steam_id_64", "steam_id", "steamId", "playerId"));
    if (explicit) return explicit;
    // A bare `id` is ambiguous — CRCON puts its own database ids there — so it only counts when it
    // actually looks like a game-issued id.
    const bare = str(pick(o, "id"));
    if (bare && looksLikeGamePlayerId(bare)) return bare;
  }
  return "";
};
/** A player's real in-game name. CRCON history/profile rows keep the current gamertag inside a
 *  `names` array (name history, one entry per alias with a last_seen), NOT a flat field — so a plain
 *  `name` lookup finds nothing and VIP labels ("Bulk payout: filters", "… - CRCON Seed VIP") never
 *  get normalized. Prefer a flat field when present, else take the most-recently-seen array entry. */
function nameOf(r: unknown): string | null {
  const flat = pick(r, "name", "player_name", "playerName", "current_name", "display_name");
  if (flat) return str(flat);
  const arr = pick(r, "names", "name_history");
  if (Array.isArray(arr) && arr.length) {
    let best: unknown = arr[0];
    let bestT = Date.parse(str(pick(best, "last_seen", "last_seen_timestamp", "created")));
    for (const e of arr) {
      const t = Date.parse(str(pick(e, "last_seen", "last_seen_timestamp", "created")));
      if (Number.isFinite(t) && (!Number.isFinite(bestT) || t > bestT)) { best = e; bestT = t; }
    }
    const n = pick(best, "name", "player_name");
    if (n) return str(n);
  }
  const np = nested(r);
  if (np && np !== r) return nameOf(np);
  return null;
}

/** Stream the archive, invoking `cb` per parsed record. Bounded memory: one line at a time. */
async function forEachRecord(file: string, cb: (rec: CrconArchiveRecord) => Promise<void>): Promise<void> {
  if (!existsSync(file)) return;
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    let rec: CrconArchiveRecord;
    try { rec = JSON.parse(s) as CrconArchiveRecord; } catch { continue; }
    if (rec && rec.dataType) await cb(rec);
  }
}

/** Progress callback: `phase` distinguishes the pre-scan (counting archive LINES read) from the
 *  main apply pass (counting records processed) — the panel labels the two differently so a
 *  multi-minute pre-scan over a multi-GB archive never looks like a hang at "0 rows". */
export type TransformProgress = (processed: number, phase: "scan" | "apply") => void;

/** ONE streaming pre-scan of the archive gathering everything the main pass needs up front:
 *  the id → correct-name map from the real player DB (preferred over per-record CRCON names,
 *  which can be a mislabelled VIP note or missing on raw-id rows). A cheap prefix check means only
 *  player/player_detail lines are JSON-parsed — the millions of log lines are skipped unparsed.
 *  This used to be two separate full passes; on an 8+ GB archive that alone took several minutes. */
async function preScan(file: string, onProgress?: TransformProgress): Promise<{ nameById: Map<string, string>; serverNumber: number | null }> {
  const nameById = new Map<string, string>();
  let serverNumber: number | null = null;
  if (!existsSync(file)) return { nameById, serverNumber };
  // Names live on both the light `player` history rows and the richer `player_detail` profiles.
  // Read both; let a player_detail name win over a history-row name (it carries the full array).
  const playerPrefix = `{"dataType":"player",`;
  const detailPrefix = `{"dataType":"player_detail",`;
  // Which server of the CRCON install this archive was pulled FOR. Written by the pull's meta
  // stage; when present, the apply pass drops any row that names a different server — the log
  // store is shared across the install, and a row from the other server applied here is not extra
  // data, it is corruption. Archives from before the meta stage have no record → no filtering.
  const metaPrefix = `{"dataType":"meta",`;
  let scanned = 0;
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    scanned += 1;
    if (onProgress && scanned % 50000 === 0) onProgress(scanned, "scan");
    if (line.startsWith(metaPrefix)) {
      try {
        const raw = (JSON.parse(line) as CrconArchiveRecord).raw;
        const n = pick(raw, "server_number");
        if (typeof n === "number" && Number.isFinite(n)) serverNumber = n;
      } catch { /* skip */ }
      continue;
    }
    const isDetail = line.startsWith(detailPrefix);
    if (!isDetail && !line.startsWith(playerPrefix)) continue;
    try {
      const raw = (JSON.parse(line) as CrconArchiveRecord).raw;
      const pid = playerIdOf(raw), name = nameOf(raw);
      if (pid && name && (isDetail || !nameById.has(pid))) nameById.set(pid, name);
    } catch { /* skip */ }
  }
  return { nameById, serverNumber };
}

/**
 * Does this archive row belong to the server the archive was pulled for?
 *
 * True unless BOTH sides know better: the archive names its server (meta record) AND the row
 * names one (log rows carry `server`, map/scoreboard rows `server_number`) and they disagree. A
 * row that names no server is taken as ours — the filter exists to drop the other server's rows,
 * not to demand paperwork from formats that never carried any.
 */
function ownServerRow(raw: unknown, archiveServer: number | null): boolean {
  if (archiveServer === null) return true;
  const v = pick(raw, "server", "server_number", "server_num");
  if (v === null || v === undefined || v === "") return true;
  const n = Number(v);
  return !Number.isFinite(n) || n === archiveServer;
}

/** Is this player's profile flagged watched? CRCON's shape varies, so check a few defensively.
 *  Detail extraction (reason/by/when) is shared with the live pull — see watchInfoOf. */
function profileWatched(raw: unknown): boolean {
  const w = pick(raw, "watchlist", "is_watched", "watched");
  if (w == null) return false;
  if (typeof w === "boolean") return w;
  if (typeof w === "object") return pick(w, "is_watched", "watched") !== false; // a watch object present = watched
  return String(w).toLowerCase() === "true";
}

/**
 * An imported watch, recorded the way every watch is: as a REASON, with the words, author and time
 * the record kept (watch.ts: the reasons are the record, the flag only their cache). Written onto
 * the flag alone, as it was, the watch had no reason: the Watched tab said "no reason recorded",
 * and the first reason staff added replaced CRCON's on the flag, so its words were gone. Words
 * already on the player's record, open or closed by a curator, are not added again: applying the
 * archive twice is one watch, and a watch staff lifted stays lifted.
 */
async function importWatch(repo: Repository, playerId: string, raw: unknown, by: { userId: string | null; name: string }): Promise<void> {
  const info = watchInfoOf(raw);
  const reason = info.reason?.trim() || "on the watchlist";
  if (!(await repo.watchReasons.list(playerId)).some((r) => r.reason === reason)) {
    await repo.watchReasons.add({ playerId, reason, addedBy: info.by, ...(info.at ? { addedAt: info.at } : {}) });
  }
  await syncWatchFlag(repo, playerId, by);
}

/** Winner of a map-history round from its result scores, when the row carries them. */
function mapWinner(raw: unknown): { winner: "allies" | "axis" | null; result: string | null } {
  const res = pick(raw, "result");
  const allied = Number(pick(res, "allied", "allies", "allied_score"));
  const axis = Number(pick(res, "axis", "axis_score"));
  if (Number.isFinite(allied) && Number.isFinite(axis)) {
    return {
      winner: allied > axis ? "allies" : axis > allied ? "axis" : null,
      result: `${allied > axis ? "ALLIED" : axis > allied ? "AXIS" : "DRAW"} (${allied} - ${axis})`,
    };
  }
  return { winner: null, result: null };
}

/** The map id of a map-history row — flat on old CRCON, nested map objects on new. */
function mapIdOf(raw: unknown): string | null {
  const flat = pick(raw, "name", "map_name");
  if (typeof flat === "string" && flat) return flat;
  const m = pick(raw, "map");
  const inner = typeof m === "string" ? m : pick(m, "id") ?? pick(pick(m, "map"), "id");
  return inner ? str(inner) : null;
}

/** Weapon of a historical kill row: a flat field on new CRCON, else parsed from the raw log line
 *  ("KILL: A(Allies/765…) -> B(Axis/765…) with M1 GARAND"). */
function killWeapon(raw: unknown): string | null {
  const flat = str(pick(raw, "weapon"));
  if (flat) return flat;
  const line = str(pick(raw, "content", "raw", "message"));
  const at = line.lastIndexOf(" with ");
  return at >= 0 ? line.slice(at + 6).trim() || null : null;
}

/** Sides embedded in a historical kill line: "KILL: A(Allies/765…) -> B(Axis/765…) with X".
 *  The log line is the ONLY place CRCON records which side each player was on, and it's exactly
 *  what lets the import rebuild per-player match participation (win/loss history). */
export function killSides(raw: unknown): { actor: "allies" | "axis" | null; victim: "allies" | "axis" | null } {
  const line = str(pick(raw, "content", "raw", "message"));
  const m = line.match(/\((Allies|Axis)\/[^)]*\)\s*->\s*[^(]*\((Allies|Axis)\/[^)]*\)/i);
  if (!m) return { actor: null, victim: null };
  const norm = (x: string) => (x.toLowerCase() === "allies" ? ("allies" as const) : ("axis" as const));
  return { actor: norm(m[1]!), victim: norm(m[2]!) };
}

/** Map a historical non-kill log row onto our normalized event vocabulary. Driven by the row's own
 *  action string (the archive dataType only chose which pull stage it came from), so one stage that
 *  covers a family ("ADMIN…", "VOTE…", "TK…") still lands each row on the right kind. Returns null
 *  for rows we have no vocabulary for. */
export function logEvtKind(raw: unknown): { kind: string; data: Record<string, unknown> | null } | null {
  const action = str(pick(raw, "type", "action")).toUpperCase();
  const content = str(pick(raw, "content", "message"));
  const msg = str(pick(raw, "sub_content")) || content;
  if (action.startsWith("CHAT")) {
    return { kind: /\[(unit|squad)\]/i.test(action) ? "evt.chat.squad" : "evt.chat.team", data: { message: msg } };
  }
  switch (action) {
    case "CONNECTED": return { kind: "evt.player.connected", data: null };
    case "DISCONNECTED": return { kind: "evt.player.disconnected", data: null };
    // The teams, as the live parser keeps them ("TEAMSWITCH Name (Allies > None)"). Described on
    // its own here; the import reads the side swaps once the whole archive has been seen (see
    // SwitchColumns), since a swap is a leave and the join after it, and the archive is not in order.
    case "TEAMSWITCH": {
      const sw = parseTeamSwitchBody(content);
      return { kind: "evt.player.teamSwitched", data: sw ? describeTeamSwitch(sw).data : null };
    }
    case "MATCH START": return { kind: "evt.match.started", data: { map: content.replace(/^MATCH START\s*/i, "").trim() || null } };
    case "MATCH ENDED": return { kind: "evt.match.ended", data: { result: content.replace(/^MATCH ENDED\s*/i, "").trim() || null } };
    case "MESSAGE": return { kind: "evt.admin.message", data: { message: msg } };
    // `entered` decided here, exactly as the live parser decides it (same helper), because the
    // Admin camera page is built from PAIRS and a camera event without a direction can never be
    // paired. Every historical camera line imported before this carried only its text, so the
    // whole archive landed in the game log and produced no sessions at all.
    case "CAMERA": return { kind: "evt.admin.camera", data: { entered: cameraEntered(msg || content), message: msg } };
    case "VOTE STARTED": return { kind: "evt.vote.started", data: { content: msg } };
    case "VOTE": return { kind: "evt.vote.cast", data: { content: msg } };
    case "ADMIN KICKED": case "TK AUTO KICKED": return { kind: "evt.player.kicked", data: { reason: msg } };
    case "ADMIN BANNED": case "ADMIN PERMA BANNED": case "TK AUTO BANNED": return { kind: "evt.player.banned", data: { reason: msg } };
    default:
      // Every other VOTE outcome is a completion. CRCON's VOTESYS writes the verdict INTO the
      // action string — "VOTE COMPLETED", "VOTE PASSED", "VOTE EXPIRED" — and enumerating them
      // one by one is how PASSED and EXPIRED spent months landing in the unrecognized bucket
      // (a vote-kick that actually removed someone, skipped as unparseable). Family-match like
      // ADMIN*/TK* below, and keep the verdict as data instead of pretending it's a new kind.
      if (action.startsWith("VOTE")) {
        return { kind: "evt.vote.completed", data: { result: msg, outcome: action.slice(4).trim().toLowerCase() || null } };
      }
      // remaining ADMIN*/TK AUTO/etc lines are still admin activity worth keeping in the log
      if (action.startsWith("ADMIN") || action.startsWith("TK")) return { kind: "evt.admin.message", data: { message: msg } };
      return null;
  }
}

export interface TransformSummary {
  vips: number; vipsKept: number; bans: number;
  watchlist: number; players: number; notes: number; messages: number; sessions: number; ips: number;
  matches: number; kills: number; teamkills: number; tags: number;
  events: number; visits: number; matchStats: number;
  /** rounds whose CRCON scoreboard (final score + per-player buckets/playtime) was applied. */
  scoreboards: number;
  /** admin-camera visits rebuilt by pairing the archive's CAMERA lines (see the pairing pass). */
  cameraSessions: number;
  /** historical names folded into "Also known as" from CRCON's name-history arrays. */
  aliases: number;
  /** seconds of pre-cutoff session time folded into career playtime (newly imported sessions only). */
  playtimeSec: number;
  /** players whose rollup the legacy reconciliation raised (sessions imported before folding existed). */
  playtimeSettled: number;
  /** players whose last_seen was lowered back to the evidence (an earlier import wrongly bumped it). */
  lastSeenRepaired: number;
  /** The overlap-cutoff instant: archive rows AT/AFTER it are skipped because the panel's own live
   *  record owns that era (null = the panel has never locally observed this server, nothing skipped). */
  cutoff: string | null;
  /** Why archived log rows did NOT apply — the backfill's equivalent of the live INGEST_DEBUG. */
  skipped: { afterCutoff: number; noTimestamp: number; unrecognized: number;
    /** rows naming ANOTHER server of the CRCON install — dropped, because applying them here is
     *  cross-server contamination, not extra data. Nonzero = the archive was pulled without a
     *  server filter (or CRCON ignored it); the archive itself holds both servers' rows. */
    otherServer: number };
  /** First few raw rows the transform could not classify (trimmed), so field-name drift in a
   *  different CRCON version is visible in the panel instead of silently dropping data. */
  unrecognizedSamples: string[];
  errors: string[];
}

/** Pull the session list out of a CRCON profile and normalize each to (connectedAt, disconnectedAt,
 *  durationSec). CRCON's keys drift across versions, so try a few. Sessions with no usable start are
 *  skipped; a missing end falls back to the start (a zero-length record still preserves the visit). */
// An IP with optional :port, standing alone — used both on profile fields and inside old-era
// CONNECTED log lines ("CONNECTED SomeName (1.2.3.4:64015)"), which embedded the address before
// the game switched those lines to player ids.
const IPV4_RE = /\b((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})(?::\d{1,5})?\b/;
/** Every plausible IP on a CRCON profile: flat fields, list fields, and per-session addresses. */
function profileIps(raw: unknown): { ip: string; ts: string | null }[] {
  const out: { ip: string; ts: string | null }[] = [];
  const addIp = (v: unknown, ts: string | null) => {
    const m = IPV4_RE.exec(str(v));
    if (m && m[1] !== "0.0.0.0" && m[1] !== "127.0.0.1") out.push({ ip: m[1]!, ts });
  };
  for (const o of [raw, nested(raw)]) {
    if (!o || typeof o !== "object") continue;
    addIp(pick(o, "ip", "last_ip", "ip_address"), null);
    const lists = pick(o, "ips", "ip_addresses", "known_ips");
    // crconTime on the sighting stamps too — a zone-less stamp passed through raw would land in
    // the store meaning whatever zone the database session happens to run in.
    if (Array.isArray(lists)) for (const e of lists) addIp(typeof e === "string" ? e : pick(e, "ip", "address", "value"), crconTime(pick(e, "created", "last_seen")));
    const sessions = pick(o, "sessions", "recent_sessions");
    if (Array.isArray(sessions)) for (const e of sessions) addIp(pick(e, "ip", "ip_address"), crconTime(pick(e, "start", "created", "connected_at")));
  }
  return out;
}

function sessionsOf(raw: unknown): { connectedAt: string; disconnectedAt: string; durationSec: number }[] {
  const arr = pick(raw, "sessions", "recent_sessions");
  if (!Array.isArray(arr)) return [];
  const out: { connectedAt: string; disconnectedAt: string; durationSec: number }[] = [];
  for (const s of arr) {
    // crconTime, never bare Date.parse: CRCON's session stamps are zone-less and mean UTC, but
    // Date.parse reads a zone-less string in the HOST's local zone — on a non-UTC host that
    // silently shifts every imported session (and the playtime and first-seen derived from it).
    const start = crconTime(pick(s, "start", "connected_at", "created", "created_at"));
    if (!start) continue;
    const startT = Date.parse(start);
    const end = crconTime(pick(s, "end", "disconnected_at", "last_seen", "ended_at"));
    const endT = end ? Date.parse(end) : NaN;
    out.push({
      connectedAt: start,
      disconnectedAt: Number.isFinite(endT) ? end! : start,
      durationSec: Math.max(0, Math.round(((Number.isFinite(endT) ? Math.max(startT, endT) : startT) - startT) / 1000)),
    });
  }
  return out;
}

/**
 * The record's own testimony of when the player was LAST seen: flat last-seen fields, the name
 * history's stamps, session ends, and finally `created`. An import must never mint a sighting —
 * "I processed your record today" is not "you were on the server today" — so every upsert in the
 * transform passes a timestamp from HERE, and a record that carries none moves no clocks at all.
 * (That is precisely how re-running an import stamped a 2025 veteran as seen minutes ago.)
 */
function seenAt(r: unknown): string | null {
  let best: number | null = null;
  const take = (v: unknown) => {
    const iso = crconTime(v);
    const t = iso ? Date.parse(iso) : NaN;
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  };
  for (const o of [r, nested(r)]) {
    if (!o || typeof o !== "object") continue;
    take(pick(o, "last_seen", "last_seen_timestamp", "updated"));
    const names = pick(o, "names", "name_history");
    if (Array.isArray(names)) for (const n of names) take(pick(n, "last_seen", "last_seen_timestamp"));
  }
  for (const s of sessionsOf(r)) take(s.disconnectedAt);
  take(pick(r, "created", "created_at"));
  return best === null ? null : new Date(best).toISOString();
}

/**
 * Which side owns a VIP expiry when the archive and the panel both have one.
 *
 * "archive" is the DEFAULT because that is what an import IS: you are migrating off CRCON, so
 * CRCON is the system of record and its expirations are the newer, truer ones — the panel's are
 * placeholders or leftovers from an earlier pass. Writing them is the whole point of importing.
 *
 * "live" is for the opposite situation, which is a top-up rather than a migration: the panel has
 * been the book of record for a while and the backup predates grants staff have made since. There
 * the archive's expiry is stale and must not push a lapsed VIP forward or cut an extended one
 * short. Neither policy touches the pause fields — a VIP timeout is panel-only state CRCON has no
 * concept of, and it survives both.
 */
export type VipPolicy = "archive" | "live";

export async function transformCrconArchive(repo: Repository, server: ServerRow, by: { userId: string | null; name: string }, onProgress?: TransformProgress, opts?: { vipPolicy?: VipPolicy }): Promise<TransformSummary> {
  const vipPolicy: VipPolicy = opts?.vipPolicy ?? "archive";
  const file = crconBackupFile(server.id);
  const s: TransformSummary = { vips: 0, vipsKept: 0, bans: 0, watchlist: 0, players: 0, notes: 0, messages: 0, sessions: 0, ips: 0, matches: 0, kills: 0, teamkills: 0, tags: 0, events: 0, visits: 0, matchStats: 0, scoreboards: 0, cameraSessions: 0, aliases: 0, playtimeSec: 0, playtimeSettled: 0, lastSeenRepaired: 0, cutoff: null, skipped: { afterCutoff: 0, noTimestamp: 0, unrecognized: 0, otherServer: 0 }, unrecognizedSamples: [], errors: [] };
  const noteSkip = (bucket: "noTimestamp" | "unrecognized", raw: unknown) => {
    s.skipped[bucket] += 1;
    if (s.unrecognizedSamples.length < 5) s.unrecognizedSamples.push(JSON.stringify(raw).slice(0, 300));
  };
  if (!existsSync(file)) { s.errors.push("no archive file — run a backup pull first"); return s; }

  // Pass 1: a single prefix-filtered scan for correct player names. Reported as the "scan"
  // phase — on a multi-GB archive this takes real minutes even skipping the log lines.
  const { nameById, serverNumber: archiveServer } = await preScan(file, onProgress);

  // REFUSE an archive that cannot be told apart per server, on an install that has more than one.
  //
  // Only the database export writes the meta record naming which server it was pulled for. The
  // older network-API pull did not, and CRCON's log store is shared across the whole install — so
  // applying a meta-less archive here imports the OTHER servers' history into this one. It does
  // not fail; it succeeds, quietly, and the wrong rows are indistinguishable from the right ones
  // afterwards. That is how a quarter-million foreign events landed on one server before the
  // integrity check found them, hours into a run that also had no business being that slow.
  //
  // A single-server install is exempt: with nothing else in the panel there is no other server's
  // history to mix in, which is exactly why the old format got away with carrying no server field.
  if (archiveServer === null && (await repo.servers.list()).length > 1) {
    s.errors.push(
      "this archive predates the database export and does not say which server it came from. " +
      "CRCON's logs are shared across the whole install, so applying it here would import the " +
      "other servers' history onto this one. Delete this archive and run the database export " +
      "for this server (docs/crcon-db-import.md), then apply again.",
    );
    return s;
  }

  const goodName = (pid: string, fallback: string | null): string | null => nameById.get(pid) ?? fallback;

  // Bans already imported for this server (playerId|type), so re-applying counts only new ones.
  const seenBans = new Set((await repo.crconBans.list({ serverId: server.id })).map((b) => `${b.playerId}|${b.type}`));
  const templateBodies = new Set((await repo.templates.list()).map((t) => `${t.kind} ${t.body}`));
  // THE OVERLAP CUTOFF. From the moment the panel's own ingest first saw this server, every log
  // line exists in BOTH systems under different dedupe keys — importing CRCON's copy of that
  // period would double-count kills, visits, everything. So the historical import takes strictly
  // the era BEFORE local observation began; the panel's own record owns everything after.
  const localCutoff = await repo.events.firstLocalTs(server.id);
  const beforeCutoff = (ts: string) => !localCutoff || ts < localCutoff;
  s.cutoff = localCutoff;

  // Imported-match window index, built lazily on the first kill (map_history stages precede the
  // log stages in the archive, so by then every importable match row exists). Attributes each
  // historical kill/death to the round it happened in → player_match_stats → win/loss history.
  let matchIndex: { id: string; start: number; end: number }[] | null = null;
  const matchFor = async (ts: string): Promise<string | null> => {
    if (!matchIndex) {
      matchIndex = (await repo.matches.list(server.id, 100000))
        .filter((m) => m.endedAt)
        .map((m) => ({ id: m.id, start: Date.parse(m.startedAt), end: Date.parse(m.endedAt!) }))
        .sort((a, b) => a.start - b.start);
    }
    const t = Date.parse(ts);
    let lo = 0, hi = matchIndex.length - 1, hit = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (matchIndex[mid]!.start <= t) { hit = mid; lo = mid + 1; } else hi = mid - 1; }
    const m = hit >= 0 ? matchIndex[hit]! : null;
    return m && t <= m.end ? m.id : null;
  };

  // Kill-history import: platform id → internal player row id. Resolved via findByPlatformId (NOT
  // upsert) so a historical name can never overwrite a player's current one; only players unseen by
  // any other stage get created, stamped with the kill's own timestamp.
  const uuidByPid = new Map<string, string | null>();
  const resolvePid = async (pid: string, name: string | null, ts: string): Promise<string | null> => {
    if (!pid) return null;
    let id = uuidByPid.get(pid);
    if (id !== undefined) return id;
    const existing = await repo.players.findByPlatformId(pid);
    id = existing?.id ?? (await repo.players.upsert({ game: server.game, platform: inferPlatform(pid), platformId: pid, name: name ?? "", ts })).id;
    uuidByPid.set(pid, id);
    return id;
  };
  // Log events are batched: events.insert dedupes on (server, dedupeKey) and returns ONLY the
  // newly inserted rows, and every follow-on write (career stats, visits, per-match lines) happens
  // for exactly those — so a re-run of the transform can never double-count anything.
  interface BufEntry {
    evt: Parameters<Repository["events"]["insert"]>[0][number];
    kind: "kill" | "teamkill" | "connect" | "other";
    actorSide?: "allies" | "axis" | null;
    victimSide?: "allies" | "axis" | null;
  }
  const killBuf: BufEntry[] = [];
  // Every pre-cutoff connect/disconnect seen in the archive (NOT just newly-inserted ones, so a
  // re-apply can still rebuild sessions for a database that imported the events before this
  // existed). Paired into sessions after the streaming pass.
  const presence: { playerId: string; ts: string; c: boolean }[] = [];
  /**
   * Every pre-cutoff CAMERA line in the archive, paired into sessions after the streaming pass.
   *
   * Collected on the same terms as `presence` — ALL rows seen, not only newly-inserted events —
   * because the archive was already imported once by a build that wrote the camera events and
   * nothing else. Those instances have years of camera lines sitting in the game log with no
   * sessions to show for them, and a re-apply is the only thing that can rebuild them.
   *
   * Buffered rather than paired inline because the archive is streamed in whatever order its
   * files happen to sit in, and an enter/leave pair is only meaningful in time order.
   */
  const cameraRows: { playerId: string | null; playerName: string; ts: string; entered: boolean }[] = [];
  /**
   * Every team switch the archive carries, with its round edges (MATCH START / MATCH ENDED). A side
   * swap is a leave and the join after it in the same round, and the archive arrives in file order,
   * not time order — so the swaps can only be named once the whole archive has been seen. Each
   * switch is STORED as it streams, described on its own like every other event; these compact
   * columns are what the round-by-round reading at the end walks (walkSwitchHistory, the reading
   * live ingest gives each poll), and its results go back onto the stored rows in batches.
   */
  const switches = new SwitchColumns();
  const roundEdges: number[] = [];
  const flushKills = async () => {
    if (!killBuf.length) return;
    const batch = killBuf.splice(0);
    const inserted = await repo.events.insert(batch.map((b) => b.evt));
    const insertedKeys = new Set(inserted.map((e) => e.dedupeKey));
    // Collected, not awaited: this loop used to make up to four single-row round trips PER KILL
    // (actor bump, victim bump, two match-line folds), sequentially — on a multi-million-kill
    // archive those round trips, not parsing, were the whole apply time. The batch writers the
    // live ingest already runs on (stats.bumpMany / matches.bumpStatMany) take the identical
    // deltas as one statement each per flush; both merge duplicate keys internally and lock in
    // sorted order, so counts, name/side precedence and concurrent-apply safety are unchanged.
    const statDeltas: { playerId: string; serverId: string; delta: { kills?: number; deaths?: number; teamkills?: number; visits?: number } }[] = [];
    const matchDeltas: Parameters<Repository["matches"]["bumpStatMany"]>[0] = [];
    for (const b of batch) {
      if (!b.evt.dedupeKey || !insertedKeys.has(b.evt.dedupeKey)) continue;
      if (b.kind === "kill" || b.kind === "teamkill") {
        if (b.kind === "kill") {
          if (b.evt.actorPlayerId) statDeltas.push({ playerId: b.evt.actorPlayerId, serverId: server.id, delta: { kills: 1 } });
          s.kills += 1;
        } else {
          if (b.evt.actorPlayerId) statDeltas.push({ playerId: b.evt.actorPlayerId, serverId: server.id, delta: { teamkills: 1 } });
          s.teamkills += 1;
        }
        if (b.evt.victimPlayerId) statDeltas.push({ playerId: b.evt.victimPlayerId, serverId: server.id, delta: { deaths: 1 } });
        // Rebuild match participation: the kill line carries each player's side, and the imported
        // match windows say which round it fell in — together, retroactive win/loss history.
        const matchId = await matchFor(b.evt.ts); // in-memory binary search after first load
        if (matchId) {
          if (b.evt.actorPlayerId) {
            matchDeltas.push({
              matchId, playerId: b.evt.actorPlayerId, serverId: server.id, playerName: b.evt.actorName ?? null,
              side: b.actorSide ?? null, kills: b.kind === "kill" ? 1 : 0, teamkills: b.kind === "teamkill" ? 1 : 0,
            });
            s.matchStats += 1;
          }
          if (b.evt.victimPlayerId) {
            matchDeltas.push({
              matchId, playerId: b.evt.victimPlayerId, serverId: server.id, playerName: b.evt.victimName ?? null,
              side: b.victimSide ?? null, deaths: 1,
            });
            s.matchStats += 1;
          }
        }
      } else if (b.kind === "connect") {
        // A historical connect is a real visit — same rule the live ingest applies.
        if (b.evt.actorPlayerId) statDeltas.push({ playerId: b.evt.actorPlayerId, serverId: server.id, delta: { visits: 1 } });
        s.visits += 1;
        s.events += 1;
      } else {
        s.events += 1;
      }
    }
    if (statDeltas.length) await repo.stats.bumpMany(statDeltas);
    if (matchDeltas.length) await repo.matches.bumpStatMany(matchDeltas);
  };
  // CRCON's name-history array → the alias record, each name at ITS OWN sightings — so "Also
  // known as" reaches back through the CRCON era instead of starting the day this panel met them.
  // record() widens in place, so re-runs never duplicate.
  const recordNameHistory = async (playerId: string, raw: unknown): Promise<void> => {
    const names = pick(raw, "names", "name_history");
    if (!Array.isArray(names)) return;
    // One statement per player rather than up to two per NAME: a profile carries every alias the
    // person ever used, so the old loop paid a round trip each for a row the batch writer folds
    // in place. recordMany merges duplicates and sums their counts, so the widening is identical.
    const batch: { playerId: string; kind: "name"; value: string; ts: string }[] = [];
    for (const n of names) {
      const value = str(pick(n, "name"));
      if (!value) continue;
      const last = crconTime(pick(n, "last_seen", "last_seen_timestamp"));
      const first = crconTime(pick(n, "created", "first_seen"));
      if (!last && !first) continue;
      if (last) batch.push({ playerId, kind: "name", value, ts: last });
      if (first && first !== last) batch.push({ playerId, kind: "name", value, ts: first });
      s.aliases += 1;
    }
    if (batch.length) await repo.playerAliases.recordMany(batch);
  };
  const tagLabels = new Map<string, Set<string>>(); // internal playerId → existing tag labels
  const noteBodies = new Map<string, Map<string, { id: string; createdAt: string }>>(); // internal playerId → note body → stored row
  const kindMap: Record<string, string> = { broadcast: "broadcast", welcome: "message", punishment: "reason" };

  // Pass 2 (streaming): map each record into our systems as it arrives.
  let processed = 0;
  onProgress?.(0, "apply"); // flip the panel from "Scanning…" the moment the real pass starts
  const tick = () => { processed += 1; if (onProgress && processed % 5000 === 0) onProgress(processed, "apply"); };
  await forEachRecord(file, async (rec) => {
    tick();
    try {
      // Rows the main pass never handles step over the guard so they aren't counted twice:
      // meta is the archive's own bookkeeping (read in the pre-scan), and map_scoreboard is
      // applied — guard, counters and all — by the dedicated second pass after the kills flush.
      if (rec.dataType === "meta" || rec.dataType === "map_scoreboard") return;
      // Cross-server guard, before anything counts: on a multi-server CRCON install the log store
      // is shared, and a row naming the OTHER server applied here is contamination — the other
      // server's kills in these careers, its connects paired into phantom sessions here, its
      // whistle closing this server's rounds. Only rows that name a server are judged (players,
      // VIPs, bans and the like are install-wide or read per-server at the source).
      if (!ownServerRow(rec.raw, archiveServer)) { s.skipped.otherServer += 1; return; }
      switch (rec.dataType) {
        case "player": {
          const pid = playerIdOf(rec.raw);
          if (!pid) return;
          // The sighting time is the record's, never the import's. A row with no usable stamp
          // keeps the player's stored lastSeen so neither clock moves.
          const ts = seenAt(rec.raw) ?? (await repo.players.findByPlatformId(pid))?.lastSeen;
          const row = await repo.players.upsert({ game: server.game, platform: inferPlatform(pid), platformId: pid, name: nameOf(rec.raw) ?? "", ...(ts ? { ts } : {}) });
          await recordNameHistory(row.id, rec.raw);
          s.players += 1;
          return;
        }
        case "vip": {
          const v = mapVips([rec.raw])[0];
          if (!v) return;
          // The CRCON VIP name is often a label ("Bulk payout: filters", "… - Seed VIP"), so keep the
          // original as the comment and show the real player name (looked up by id) instead.
          const real = goodName(v.playerId, null);
          const row = {
            serverId: server.id, playerId: v.playerId, playerName: real ?? v.playerName,
            comment: v.playerName && real && v.playerName !== real ? `CRCON VIP: ${v.playerName}` : "Imported from CRCON",
            expiration: v.expiration, createdByUserId: by.userId, createdByName: by.name,
          };
          // See VipPolicy: on a migration the archive holds the newer expirations and writing them
          // is the job; on a top-up the panel's are newer and must stand.
          // replacePermanent: "archive" is the migration policy the user picked by name — the
          // archive's expirations are the truth here, a panel permanent row included.
          if (vipPolicy === "archive") { await repo.vips.upsert({ ...row, replacePermanent: true }); s.vips += 1; }
          else { const { inserted } = await repo.vips.importOne(row); if (inserted) s.vips += 1; else s.vipsKept += 1; }
          return;
        }
        case "watchlist": {
          const pid = playerIdOf(rec.raw);
          if (!pid) return;
          const wts = seenAt(rec.raw) ?? (await repo.players.findByPlatformId(pid))?.lastSeen;
          const player = await repo.players.upsert({ game: server.game, platform: inferPlatform(pid), platformId: pid, name: goodName(pid, nameOf(rec.raw)) ?? "", ...(wts ? { ts: wts } : {}) });
          await importWatch(repo, player.id, rec.raw, by);
          s.watchlist += 1;
          return;
        }
        case "ban": {
          // Game bans land in the crcon_ban import archive — history, not the live ban record
          // (adopting the game's live lists is the seed's job). Both temp and perma are kept;
          // upsert is keyed by (server, player, type) so re-applying never duplicates a ban.
          const b = mapBans([rec.raw])[0];
          if (!b) return;
          const type = str(pick(rec.raw, "type", "ban_type")).toLowerCase().startsWith("perma") ? "perma" : "temp";
          await repo.crconBans.upsert({
            serverId: server.id, playerId: b.playerId, playerName: goodName(b.playerId, b.playerName),
            type, reason: b.reason, expiresAt: b.expiresAt, author: b.author,
            // The ban's own moment (CRCON's stamp). The store keeps the earliest known instant,
            // which also repairs rows an older import stamped with the import clock.
            bannedAt: b.at,
          });
          const k = `${b.playerId}|${type}`;
          if (!seenBans.has(k)) { seenBans.add(k); s.bans += 1; }
          return;
        }
        case "blacklist_record": {
          // Deliberately NOT imported. In this community every blacklisted player carried a real
          // permanent ban alongside, so these records are duplicates of bans the seed reads
          // straight off the game servers — and the blacklist itself is retired (docs/ban-model.md).
          return;
        }
        case "player_detail": {
          const pid = playerIdOf(rec.raw);
          if (!pid) return;
          // The profile's own "first seen": CRCON stamps `created` when it first meets a player,
          // and the session list can reach back further still. Handing the earliest of those to
          // the upsert lets the store backdate first_seen (LEAST) — without it, a 2021 regular
          // reads as having joined the day this panel was installed. last_seen cannot regress:
          // the store only ever widens it forward.
          const sessions = sessionsOf(rec.raw);
          const createdAt = crconTime(pick(rec.raw, "created", "created_at", "first_seen", "first_seen_timestamp"));
          const earliest = [createdAt, ...sessions.map((x) => x.connectedAt)].filter((x): x is string => !!x).sort()[0];
          const player = await repo.players.upsert({
            game: server.game, platform: inferPlatform(pid), platformId: pid, name: goodName(pid, nameOf(rec.raw)) ?? "",
            ...(earliest ? { ts: earliest } : {}),
          });
          // Two honest sightings, not one: the earliest reaches first_seen back, and the profile's
          // own last sighting brings last_seen up to when CRCON truly saw them last — which for an
          // imported-era player is their final pre-cutoff session, never "now".
          const latest = seenAt(rec.raw);
          if (latest && latest !== earliest) {
            await repo.players.upsert({ game: server.game, platform: inferPlatform(pid), platformId: pid, name: "", ts: latest });
          }

          // Watchlist, derived from the profile (robust regardless of the is_watched pull) —
          // with the original reason/author/timestamp when the profile's watch object kept them.
          if (profileWatched(rec.raw)) {
            await importWatch(repo, player.id, rec.raw, by);
            s.watchlist += 1;
          }

          // IP sightings from the profile (flat fields, lists, per-session) — read-gated later by
          // the player.ips capability. record() is an idempotent widen, so re-runs are safe.
          for (const hit of profileIps(rec.raw)) {
            await repo.playerIps.record(player.id, hit.ip, hit.ts ?? new Date().toISOString(), "crcon-profile");
            s.ips += 1;
          }

          // Session history → the profile timeline AND career playtime, under the same overlap
          // cutoff the log import lives by. Only a session that ENDED strictly before local
          // observation began is folded into the rollup: from the cutoff on, the live tracker
          // measures the same presence itself, and a straddling session's tail would be counted
          // twice. importOne dedupes on the connect instant and reports "newly inserted", so
          // re-running the transform (or re-pulling the archive) can never re-add seconds.
          // Visits deliberately stay with the connect-log import — a profile session and its
          // connect line describe the same join, and one of them must own the +1.
          let playSec = 0;
          // One statement for the profile's whole session list. importMany returns the subset it
          // actually inserted, which is the same "exactly once" guarantee importOne's boolean gave.
          const freshSessions = await repo.sessions.importMany(sessions.map((sess) => ({ playerId: player.id, serverId: server.id, ...sess })));
          for (const sess of freshSessions) {
            s.sessions += 1;
            if (sess.durationSec > 0 && beforeCutoff(sess.disconnectedAt)) playSec += sess.durationSec;
          }
          if (playSec > 0) {
            await repo.stats.bump(player.id, server.id, { playtimeSec: playSec });
            s.playtimeSec += playSec;
          }

          // CRCON profile flags (the emoji labels admins pin on players) → our player tags.
          const flags = pick(rec.raw, "flags");
          if (Array.isArray(flags) && flags.length > 0) {
            let labels = tagLabels.get(player.id);
            if (!labels) { labels = new Set((await repo.playerTags.list(player.id)).map((t) => t.label)); tagLabels.set(player.id, labels); }
            for (const f of flags) {
              const label = [str(pick(f, "flag", "emoji")), str(pick(f, "comment", "note"))].filter(Boolean).join(" ").trim();
              if (!label || labels.has(label)) continue;
              await repo.playerTags.add({ playerId: player.id, label, note: null, createdByName: "CRCON" });
              labels.add(label);
              s.tags += 1;
            }
          }

          const comments = pick(rec.raw, "comments", "received_comments");
          if (Array.isArray(comments) && comments.length > 0) {
            // Body → existing row, so the dedupe can also hand an already-imported note its true
            // CRCON time (an earlier import stamped them all at the moment it ran).
            let known = noteBodies.get(player.id);
            if (!known) { known = new Map((await repo.playerNotes.list(player.id, 500)).map((n) => [n.body, { id: n.id, createdAt: n.createdAt }])); noteBodies.set(player.id, known); }
            for (const c of comments) {
              const content = str(pick(c, "content", "comment", "text"));
              if (!content) continue;
              const body = `[CRCON] ${content}`;
              const when = crconTime(pick(c, "creation_time", "created", "created_at", "timestamp"));
              const prior = known.get(body);
              if (prior) {
                if (when && when < prior.createdAt) { await repo.playerNotes.backdate(prior.id, when); prior.createdAt = when; }
                continue;
              }
              const author = str(pick(c, "by", "author", "admin_name")) || "CRCON";
              const row = await repo.playerNotes.create({ playerId: player.id, authorUserId: by.userId, authorName: author, body, createdAt: when });
              known.set(body, { id: row.id, createdAt: row.createdAt });
              s.notes += 1;
            }
          }

          await recordNameHistory(player.id, rec.raw);

          // The profile's received_actions ARE the player's moderation history on CRCON —
          // PUNISH / KICK / TEMPBAN / PERMABAN / MESSAGE with reason, admin and time. They become
          // moderation events (same vocabulary the admin-log import uses), so the profile's
          // Moderation history reaches back through the CRCON era. Content-addressed dedupe keys
          // keep re-runs idempotent; the cutoff keeps the live era with the live record.
          const received = pick(rec.raw, "received_actions", "actions");
          if (Array.isArray(received)) {
            for (const a of received) {
              const t = str(pick(a, "action_type", "type")).toUpperCase();
              const when = crconTime(pick(a, "time", "timestamp", "created", "creation_time"));
              if (!t || !when || !beforeCutoff(when)) continue;
              const kind = t.includes("KICK") ? "evt.player.kicked"
                : t.includes("BAN") ? "evt.player.banned"
                : t.includes("PUNISH") ? "evt.player.punished"
                : t.includes("MESSAGE") ? "evt.admin.message" : null;
              if (!kind) continue;
              // A MESSAGE's text may arrive under its own key rather than as a "reason"; store it
              // under the name it is, so the profile can label it correctly.
              const reason = str(pick(a, "reason")) || null;
              const messageText = kind === "evt.admin.message" ? (str(pick(a, "message", "content", "text")) || reason) : null;
              const adminName = str(pick(a, "by", "author", "admin_name")) || null;
              killBuf.push({
                kind: "other",
                evt: {
                  serverId: server.id, ts: when, kind,
                  actorPlayerId: player.id, actorName: player.name || null,
                  victimPlayerId: null, victimName: null, weapon: null,
                  data: {
                    ...(messageText ? { message: messageText } : reason ? { reason } : {}),
                    ...(adminName ? { by: adminName } : {}),
                    ...(kind === "evt.player.banned" ? { banType: t.includes("TEMP") ? "temp" : "perma" } : {}),
                  },
                  dedupeKey: `crcon:ra:${pid}:${when}:${t}`,
                },
              });
            }
            if (killBuf.length >= 500) await flushKills();
          }
          return;
        }
        case "map_history": {
          const mapId = mapIdOf(rec.raw);
          const startedAt = crconTime(pick(rec.raw, "start", "start_time", "started_at", "creation_time"));
          if (!startedAt || !beforeCutoff(startedAt)) return; // the panel's own tracker owns rounds after the cutoff
          const endedAt = crconTime(pick(rec.raw, "end", "end_time", "ended_at"));
          // Same rule as the scoreboard pass: a round with no end is a torn snapshot, and
          // importing it would plant an OPEN match in history — squatting on the one-open-round
          // arbiter that belongs to the live tracker. Never import an open round.
          if (!endedAt) return;
          // Nor a round too short to be a game (MIN_MATCH_MS) — the live tracker drops those too.
          if (Date.parse(endedAt) - Date.parse(startedAt) < MIN_MATCH_MS) return;
          const { winner, result } = mapWinner(rec.raw);
          if (await repo.matches.importOne({ serverId: server.id, map: mapId, startedAt, endedAt, winner, result })) s.matches += 1;
          return;
        }
        case "map_scoreboard":
          // Applied in a dedicated SECOND pass after the kill logs (see below): its per-player
          // totals reconcile by GREATEST against what the kill lines built, which only works once
          // kill counting is finished — and in the archive this stage sits BEFORE the log stages,
          // so applying in file order would let the later kill bumps ADD onto totals CRCON
          // already included and double-count every one of them.
          return;
        case "log_kill":
        case "log_teamkill": {
          const ts = crconTime(pick(rec.raw, "event_time", "creation_time", "timestamp_ms"));
          if (!ts) return noteSkip("noTimestamp", rec.raw);
          if (!beforeCutoff(ts)) { s.skipped.afterCutoff += 1; return; } // the overlap era is already counted by live ingest
          const actorPid = str(pick(rec.raw, "player1_id", "steam_id_64_1", "player_id"));
          const victimPid = str(pick(rec.raw, "player2_id", "steam_id_64_2"));
          if (!actorPid && !victimPid) return noteSkip("unrecognized", rec.raw); // field-name drift — nobody to credit
          const actorName = str(pick(rec.raw, "player1_name", "player_name", "player")) || null;
          const victimName = str(pick(rec.raw, "player2_name", "player2")) || null;
          const kind = rec.dataType === "log_kill" ? "kill" : "teamkill";
          const sides = killSides(rec.raw);
          killBuf.push({
            kind,
            actorSide: sides.actor,
            victimSide: sides.victim,
            evt: {
              serverId: server.id, ts, kind: `evt.${kind}`,
              actorPlayerId: await resolvePid(actorPid, actorName, ts),
              actorName, victimPlayerId: await resolvePid(victimPid, victimName, ts),
              victimName, weapon: killWeapon(rec.raw),
              // The sides the kill line itself declares — the profile's faction habit reads these
              // when no sided match rows exist for the player (the usual case for imported eras).
              data: sides.actor || sides.victim
                ? { ...(sides.actor ? { actorSide: sides.actor } : {}), ...(sides.victim ? { victimSide: sides.victim } : {}) }
                : null,
              // Prefer CRCON's own row id; content-hash rows fall back to the archive entityKey,
              // which is already content-addressed — both stable across re-pulls AND re-transforms.
              dedupeKey: `crcon:${str(pick(rec.raw, "id")) || rec.entityKey}`,
            },
          });
          if (killBuf.length >= 500) await flushKills();
          return;
        }
        case "log_match":
        case "log_connect":
        case "log_disconnect":
        case "log_teamswitch":
        case "log_admin":
        case "log_message":
        case "log_vote":
        case "log_tkauto":
        case "log_camera":
        case "log_chat": {
          const ts = crconTime(pick(rec.raw, "event_time", "creation_time", "timestamp_ms"));
          if (!ts) return noteSkip("noTimestamp", rec.raw);
          if (!beforeCutoff(ts)) { s.skipped.afterCutoff += 1; return; }
          const mapped = logEvtKind(rec.raw);
          if (!mapped) return noteSkip("unrecognized", rec.raw);
          const actorPid = str(pick(rec.raw, "player1_id", "steam_id_64_1", "player_id"));
          const victimPid = str(pick(rec.raw, "player2_id", "steam_id_64_2"));
          const actorName = str(pick(rec.raw, "player1_name", "player_name", "player")) || null;
          const victimName = str(pick(rec.raw, "player2_name", "player2")) || null;
          const actorId = await resolvePid(actorPid, actorName, ts);
          // IP in a connect line is recorded ONLY when the same row carries the player's id.
          // Old-era lines had "name (ip:port)" with no id — matching those by name would be
          // guessing which IP belongs to which player, so they are deliberately ignored.
          if (mapped.kind === "evt.player.connected" && actorId) {
            const line = str(pick(rec.raw, "content", "raw", "message"));
            const m = IPV4_RE.exec(line);
            if (m && m[1] !== "0.0.0.0" && m[1] !== "127.0.0.1") {
              await repo.playerIps.record(actorId, m[1]!, ts, "crcon-log");
              s.ips += 1;
            }
          }
          if ((mapped.kind === "evt.player.connected" || mapped.kind === "evt.player.disconnected") && actorId) {
            presence.push({ playerId: actorId, ts, c: mapped.kind === "evt.player.connected" });
          }
          if (mapped.kind === "evt.admin.camera") {
            // A wording we cannot read is skipped rather than guessed: an enter invented from an
            // ambiguous line opens a session the real exit never closes, and it then reads as
            // "still in the camera" forever.
            const entered = (mapped.data as { entered?: boolean | null } | null)?.entered;
            if (typeof entered === "boolean") cameraRows.push({ playerId: actorId, playerName: actorName ?? "unknown", ts, entered });
          }
          const entry: BufEntry = {
            kind: mapped.kind === "evt.player.connected" ? "connect" : "other",
            evt: {
              serverId: server.id, ts, kind: mapped.kind,
              actorPlayerId: actorId,
              actorName, victimPlayerId: await resolvePid(victimPid, victimName, ts),
              victimName, weapon: null, data: mapped.data,
              dedupeKey: `crcon:${str(pick(rec.raw, "id")) || rec.entityKey}`,
            },
          };
          if (mapped.kind === "evt.player.teamSwitched") {
            const d = mapped.data as { from?: unknown; to?: unknown } | null;
            if (typeof d?.from === "string" && typeof d?.to === "string") {
              switches.push({ tsMs: Date.parse(ts), who: actorId ? `id:${actorId}` : `name:${(actorName ?? "").trim()}`, from: d.from, to: d.to, dedupeKey: entry.evt.dedupeKey! });
            }
          }
          if (mapped.kind === "evt.match.started" || mapped.kind === "evt.match.ended") roundEdges.push(Date.parse(ts));
          killBuf.push(entry);
          if (killBuf.length >= 500) await flushKills();
          return;
        }
        case "standard_message": {
          const body = str(pick(rec.raw, "message", "text", "content"));
          if (!body) return;
          const kind = kindMap[str(pick(rec.raw, "kind")).toLowerCase()] ?? "broadcast";
          const key = `${kind} ${body}`;
          if (templateBodies.has(key)) return;
          await repo.templates.create({ kind, body });
          templateBodies.add(key);
          s.messages += 1;
          return;
        }
      }
    } catch (err) {
      if (s.errors.length < 20) s.errors.push(`${rec.dataType}: ${(err as Error).message}`);
    }
  });
  await flushKills(); // whatever the last partial batch held

  // The team switches, read through their rounds now the whole archive has been seen. The rows are
  // already stored, each described on its own; the reading names the swaps, and fills in the teams
  // of rows an earlier import stored without them (an insert never rewrites a stored row). Written
  // a thousand at a time as the reading goes — never held as one list.
  if (switches.length) {
    let batch: { dedupeKey: string; ts: string; data: Record<string, unknown> }[] = [];
    for (const [i, data] of walkSwitchHistory(switches.length, switches, roundEdges, ROUND_LOOKBACK_MS)) {
      batch.push({ dedupeKey: switches.dedupeKey(i), ts: new Date(switches.ts(i)).toISOString(), data: data as Record<string, unknown> });
      if (batch.length >= 1000) { await repo.events.fillImportedTeamSwitches(server.id, batch); batch = []; }
    }
    if (batch.length) await repo.events.fillImportedTeamSwitches(server.id, batch);
  }

  // Round scoreboards, SECOND PASS — deliberately after every kill line has been counted. The
  // scoreboard's per-player totals reconcile by GREATEST against what the kill logs built, which
  // only holds once kill counting is FINISHED; in the archive this stage sits before the log
  // stages, so applying in file order would let the later kill bumps ADD onto totals CRCON had
  // already included. A prefix check keeps the re-read cheap: the millions of log lines are
  // skipped unparsed, the same trick as the pre-scan.
  {
    const sbPrefix = `{"dataType":"map_scoreboard",`;
    const intOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null);
    const int = (v: unknown): number => intOrNull(v) ?? 0;
    // The early "no archive file" guard already returned if the file is missing.
    const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.startsWith(sbPrefix)) continue;
      tick();
      try {
        const rec = JSON.parse(line) as CrconArchiveRecord;
        // Same cross-server guard as the main pass — a scoreboard row carries server_number.
        if (!ownServerRow(rec.raw, archiveServer)) { s.skipped.otherServer += 1; continue; }
        // Same ownership rule as map_history: rounds after the cutoff belong to the live tracker.
        const startedAt = crconTime(pick(rec.raw, "start", "start_time", "creation_time"));
        if (!startedAt || !beforeCutoff(startedAt)) continue;
        const endedAt = crconTime(pick(rec.raw, "end", "end_time"));
        if (!endedAt) continue; // an unfinished round in a backup is a torn snapshot — never import an OPEN round
        if (Date.parse(endedAt) - Date.parse(startedAt) < MIN_MATCH_MS) continue; // not a game (MIN_MATCH_MS)
        const res = pick(rec.raw, "result") as Record<string, unknown> | null | undefined;
        const rows = pick(rec.raw, "player_stats");
        const stats: Parameters<Repository["matches"]["importScoreboard"]>[0]["stats"] = [];
        for (const p of Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []) {
          const pid = str(pick(p, "player_id", "steam_id_64"));
          const name = str(pick(p, "player", "name")) || null;
          const playerId = pid ? await resolvePid(pid, name, startedAt) : null;
          if (!playerId) continue; // no public identity — nobody to credit
          const rawSide = str(pick(pick(p, "team"), "side")).toLowerCase();
          stats.push({
            playerId, playerName: name,
            side: rawSide === "allied" || rawSide === "allies" ? "allies" : rawSide === "axis" ? "axis" : null,
            kills: int(pick(p, "kills")), deaths: int(pick(p, "deaths")), teamkills: int(pick(p, "teamkills")),
            combat: int(pick(p, "combat")), offense: int(pick(p, "offense")),
            defense: int(pick(p, "defense")), support: int(pick(p, "support")),
            vehicleKills: int(pick(p, "vehicle_kills")), vehiclesDestroyed: int(pick(p, "vehicles_destroyed")),
            timeSeconds: intOrNull(pick(p, "time_seconds")),
            // The unit history is the round's real role record (game role int → seconds). When
            // the archive carries it — database exports do — the line lands with true role
            // clocks instead of the "-1 unknown role" sentinel.
            roleSeconds: roleSecondsFromUnits(pick(p, "units"), intOrNull(pick(p, "time_seconds")) ?? 0),
          });
        }
        const applied = await repo.matches.importScoreboard({
          serverId: server.id, map: mapIdOf(rec.raw), startedAt, endedAt,
          alliedScore: intOrNull(pick(res, "allied")), axisScore: intOrNull(pick(res, "axis")),
          stats,
        });
        if (applied.created) s.matches += 1;
        s.matchStats += applied.statsApplied;
        s.scoreboards += 1;
      } catch (err) {
        if (s.errors.length < 20) s.errors.push(`map_scoreboard: ${(err as Error).message}`);
      }
    }
  }

  // Sessions rebuilt from the connect/disconnect pairs in the game log. CRCON profiles carry a
  // sessions array only when that instance kept one — plenty don't, which left profiles with
  // hundreds of visits, no sessions, and no playtime (so no kills/min either). The log lines ARE
  // the presence record, so pair them: a connect followed by that player's next disconnect is a
  // session. All presence rows are pre-cutoff by construction, so every derived session folds
  // into career playtime. Guards: a pair longer than 12h means a missed disconnect (dropped, not
  // guessed at); an interval overlapping a stored session belongs to whichever import made it
  // (which is also what makes re-runs no-ops); importOne dedupes exactly.
  {
    presence.sort((a, b) => a.playerId.localeCompare(b.playerId) || a.ts.localeCompare(b.ts));
    const MAX_SESSION_MS = 12 * 3600_000;
    let i = 0;
    while (i < presence.length) {
      const pid = presence[i]!.playerId;
      let j = i;
      while (j < presence.length && presence[j]!.playerId === pid) j += 1;
      const rows = presence.slice(i, j);
      i = j;
      // Sorted once, so the overlap test is a binary search into the interval list rather than a
      // scan of it. A veteran on a years-old install has thousands of stored sessions and this ran
      // per candidate pair — O(n²) per player, on top of a round trip per accepted pair.
      const existing = (await repo.sessions.list(pid, 1000))
        .map((x) => ({ a: x.connectedAt, b: x.disconnectedAt ?? "9999" }))
        .sort((p, q) => (p.a < q.a ? -1 : p.a > q.a ? 1 : 0));
      const overlaps = (a: string, b: string) => {
        // The last interval starting at or before `b`; intervals are disjoint, so only it and the
        // one before it can overlap [a, b).
        let lo = 0, hi = existing.length - 1, hit = -1;
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (existing[mid]!.a < b) { hit = mid; lo = mid + 1; } else hi = mid - 1; }
        for (let k = hit; k >= 0 && k >= hit - 1; k--) { const e = existing[k]!; if (a < e.b && e.a < b) return true; }
        return false;
      };
      const insertAt = (a: string, b: string) => {
        let lo = 0, hi = existing.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (existing[mid]!.a < a) lo = mid + 1; else hi = mid; }
        existing.splice(lo, 0, { a, b });
      };
      let open: string | null = null;
      const candidates: { connectedAt: string; disconnectedAt: string; durationSec: number }[] = [];
      for (const r of rows) {
        if (r.c) { open = r.ts; continue; } // a second connect replaces a dangling one
        if (!open || r.ts <= open) { open = null; continue; }
        const a = open;
        open = null;
        const durMs = Date.parse(r.ts) - Date.parse(a);
        if (durMs > MAX_SESSION_MS || overlaps(a, r.ts)) continue;
        // Kept in the local interval list immediately so later pairs in this same player's run are
        // tested against it, exactly as the old push-after-insert did.
        insertAt(a, r.ts);
        candidates.push({ connectedAt: a, disconnectedAt: r.ts, durationSec: Math.round(durMs / 1000) });
      }
      let playSec = 0;
      for (const sess of await repo.sessions.importMany(candidates.map((c) => ({ playerId: pid, serverId: server.id, ...c })))) {
        s.sessions += 1;
        playSec += sess.durationSec;
      }
      if (playSec > 0) {
        await repo.stats.bump(pid, server.id, { playtimeSec: playSec });
        s.playtimeSec += playSec;
      }
    }
  }

  /*
   * Admin camera visits rebuilt from the CAMERA lines, exactly as sessions are rebuilt from
   * connect/disconnect above.
   *
   * The import wrote camera EVENTS and stopped there. But the Admin camera page is not a list of
   * events — it is a list of visits, each an enter paired with its exit, and that pairing only
   * ever happened in the live ingest path. So an instance that imported its whole CRCON archive
   * got every camera line into the game log and an Admin camera page that said nobody had ever
   * been in the camera. Both statements came from the same rows.
   *
   * Replayed in time order per person, through the same repo calls the live path uses, so the
   * open/close semantics (and their idempotence) are the ones already proven there rather than a
   * second implementation of the same idea.
   */
  {
    // Name is the fallback identity: CAMERA lines from older CRCON eras often carry no id, and
    // `open`/`close` already agree to match on the name when there is none.
    const who = (r: { playerId: string | null; playerName: string }) => r.playerId ?? `name:${r.playerName}`;
    cameraRows.sort((a, b) => who(a).localeCompare(who(b)) || a.ts.localeCompare(b.ts));
    // A visit longer than this is a missed exit, not a twelve-hour stint in spectator. Dropped
    // rather than guessed at, the same rule (and the same reason) as the session pairing above.
    const MAX_CAM_MS = 12 * 3600_000;
    let open: { playerId: string | null; playerName: string; ts: string } | null = null;
    let prevWho: string | null = null;
    for (const r of cameraRows) {
      const key = who(r);
      // A person whose last visit never closed does not leave it hanging into the next person.
      if (key !== prevWho) { open = null; prevWho = key; }
      if (r.entered) {
        // Two enters in a row means the exit was never logged. The first is unclosable, so the
        // later one replaces it rather than both waiting for a single exit.
        open = { playerId: r.playerId, playerName: r.playerName, ts: r.ts };
        continue;
      }
      // An exit with no enter is the tail of a visit that began before this archive's window —
      // there is no start to record, so there is no visit to write.
      if (!open || r.ts <= open.ts) { open = null; continue; }
      const durMs = Date.parse(r.ts) - Date.parse(open.ts);
      const start = open;
      open = null;
      if (durMs > MAX_CAM_MS) continue;
      if (await repo.adminCam.importOne({
        serverId: server.id, playerId: start.playerId, playerName: start.playerName,
        enteredAt: start.ts, exitedAt: r.ts, durationSec: Math.round(durMs / 1000),
      })) s.cameraSessions += 1;
    }
  }

  // Repair for the imports that DID mint sightings: any player whose stored last_seen postdates
  // every piece of evidence (latest session end, latest event, first_seen) is lowered back to the
  // evidence. A player online right now can be briefly lowered to their last event; the roster
  // capture re-raises them within a snapshot. Idempotent, raise-free.
  try { s.lastSeenRepaired = await repo.players.settleLastSeenFromEvidence(); }
  catch (err) { s.errors.push(`last-seen repair: ${(err as Error).message}`); }

  // Legacy reconciliation: sessions imported by an EARLIER version of this transform sit on the
  // profile timeline with nothing in the rollup, and the dedupe (rightly) refuses to import them
  // again — so folding-on-insert alone can never reach them. Raise every rollup to at least its
  // recorded pre-cutoff session total. Raise-only keeps re-runs idempotent and never lowers a
  // figure; the one trade is that a player raised here loses live-era seconds accrued before the
  // raise — bounded, one-time, and small next to the years of history being recovered.
  try { s.playtimeSettled = await repo.stats.settlePlaytimeFromSessions(server.id, localCutoff); }
  catch (err) { s.errors.push(`playtime settle: ${(err as Error).message}`); }

  return s;
}

export { normExpiry, crconTime };
