/**
 * The dedicated in-game chat filter — the pure half.
 *
 * One community-wide word list, two consumers (see ChatFilterConfig in @app/db):
 *
 *  - ENFORCEMENT rides the rules engine. This module derives the match regex and the two managed
 *    rule bodies (team chat + unit chat); the route upserts them through the same parse/validate
 *    door every hand-written rule goes through, so the filter can never express a rule the Rules
 *    page couldn't. Word-boundary matching on purpose: the enforcer tests a rule's regex against
 *    the joined event text (names included), and a bare substring filter punishes "Slurpee" for
 *    saying "gg" — \b is what makes a word list mean words.
 *
 *  - THE GAME'S CENSOR (CRCON's "profanities") is a per-server add/remove diff, planned here and
 *    executed by the route. Planned against OUR record of what was pushed (`censorApplied`)
 *    because HLL's v2 wire has no banned-words getter — there is nothing to read back, so the
 *    record is the baseline, and a failed push leaves the record alone to be retried next save.
 */
import type { ChatFilterConfig, ServerRow } from "@app/db";

/** Bounds: enough for a serious community list, small enough that the derived regex stays sane. */
export const CHAT_FILTER_MAX_WORDS = 200;
export const CHAT_FILTER_MAX_WORD_LEN = 48;

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

/**
 * Normalise a raw word-list input (textarea lines, commas, or an array) into the stored list:
 * trimmed, inner whitespace collapsed, empties dropped, case-insensitive duplicates removed
 * (first spelling wins — the regex is case-insensitive anyway, so a duplicate buys nothing).
 */
export function normalizeChatFilterWords(raw: unknown): string[] {
  const parts = Array.isArray(raw)
    ? raw.map((w) => String(w))
    : String(raw ?? "").split(/[\n,]/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const w = p.trim().replace(/\s+/g, " ");
    if (!w) continue;
    const key = w.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/**
 * The managed rules' match regex: whole words, any of the list. Each word is escaped literally
 * (a list is words, not patterns — the Rules page's Match field is where regex lives) and inner
 * spaces relax to \s+ so a two-word phrase survives double spacing. \b is ASCII-flavoured in JS,
 * so a word that starts or ends in a non-Latin letter matches a little loosely — acceptable for
 * a filter whose failure mode is firing on a fragment, and the enforcer applies the /i flag.
 */
export function buildChatFilterMatch(words: string[]): string {
  const parts = words
    .map((w) => w.replace(ESCAPE_RE, "\\$&").replace(/\s+/g, "\\s+"))
    .filter(Boolean);
  return parts.length ? `\\b(?:${parts.join("|")})\\b` : "";
}

/**
 * The player action a filter set to `action` carries out, as the permission doing it by hand takes.
 * "blacklist" is the rules' stored name for a ban: temporary with hours, permanent without.
 */
export function chatFilterActionKey(action: ChatFilterConfig["action"], hours: number | null): string {
  if (action === "blacklist") return hours ? "action.tempban" : "action.permaban";
  return `action.${action}`;
}

/** The managed fields of the two rules a saved filter maintains. Everything NOT named here is
 *  the staff's to keep — exemptions, ladders, alert routing, active hours, trial run — and the
 *  route preserves it across saves by merging over the existing row. */
export function managedRuleFields(cfg: Pick<ChatFilterConfig, "enabled" | "words" | "action" | "hours" | "reason">, which: "team" | "unit"): Record<string, unknown> {
  return {
    name: which === "team" ? "Chat filter — team chat" : "Chat filter — unit chat",
    serverId: null, // community-wide: one policy for every server, like the list itself
    eventKind: which === "team" ? "evt.chat.team" : "evt.chat.squad",
    match: buildChatFilterMatch(cfg.words),
    action: cfg.action,
    hours: cfg.hours,
    reason: cfg.reason || null,
    threshold: 1,
    windowSec: 0,
    enabled: cfg.enabled,
  };
}

export interface CensorPush { serverId: string; name: string; add: string[]; remove: string[] }

/**
 * Which words each ACTIVE server still needs added or removed to match the wanted list. Observe
 * servers are never written to (the same promise everything else keeps); a server whose record
 * already matches gets no entry. `wanted` is the full list when the censor is on, and empty when
 * it is off — turning the censor off is a removal push, not amnesia about what was pushed.
 */
export function planCensorPushes(
  servers: Pick<ServerRow, "id" | "name" | "engagementMode">[],
  wanted: string[],
  applied: Record<string, string[]>,
): CensorPush[] {
  const out: CensorPush[] = [];
  const wantKeys = new Set(wanted.map((w) => w.toLowerCase()));
  for (const s of servers) {
    if (s.engagementMode !== "active") continue;
    const have = applied[s.id] ?? [];
    const haveKeys = new Set(have.map((w) => w.toLowerCase()));
    const add = wanted.filter((w) => !haveKeys.has(w.toLowerCase()));
    const remove = have.filter((w) => !wantKeys.has(w.toLowerCase()));
    if (add.length || remove.length) out.push({ serverId: s.id, name: s.name, add, remove });
  }
  return out;
}
