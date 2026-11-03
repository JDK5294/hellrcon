/**
 * Which parameters does each half of a command actually reach for?
 *
 * Both game tables carry the same hazard: a command has a legacy-text wire and a binary-v2 wire,
 * each correct read on its own, and the defect lives only in the gap between them. Two real bugs
 * came from that gap — unbanProfanity's legacy half took `word` where every caller sends `words`,
 * so the censor's removals went out empty while the app recorded them as applied; and the rotation
 * port passed only the index v2 wants, which the legacy `rotdel <map>` cannot use.
 *
 * A Proxy stands in for the params and records every key read, so the check asks the COMPILED
 * command rather than parsing source, and cannot drift from what actually ships. Every value reads
 * back as undefined, so both halves take the same branches and a key inside an untaken branch is
 * still recorded (the condition reads it).
 */

export interface WireDef {
  legacyText?: { build: (p: Record<string, unknown>) => string };
  binaryV2?: { content: (p: Record<string, unknown>) => Record<string, unknown> | string };
}

function keysRead(fn: (p: Record<string, unknown>) => unknown): string[] {
  const seen = new Set<string>();
  const probe = new Proxy({}, { get: (_t, k) => { if (typeof k === "string") seen.add(k); return undefined; } });
  fn(probe as Record<string, unknown>);
  return [...seen].sort();
}

/**
 * Commands whose two wires read different parameters, as "name: legacy reads […], v2 reads […]".
 * Only commands carrying BOTH wires are examined — one wire cannot disagree with itself.
 *
 * `allowed` names the commands that legitimately differ; each must still differ, so an entry that
 * has been made consistent is reported too rather than sitting in the list forever.
 */
export function wireMismatches(table: Record<string, WireDef>, allowed: Record<string, string>): { offenders: string[]; staleAllowances: string[] } {
  const offenders: string[] = [];
  const staleAllowances: string[] = [];
  for (const [name, def] of Object.entries(table)) {
    if (!def.legacyText || !def.binaryV2) continue;
    const legacyKeys = keysRead(def.legacyText.build);
    const v2Keys = keysRead(def.binaryV2.content);
    if (legacyKeys.join(",") === v2Keys.join(",")) {
      if (allowed[name]) staleAllowances.push(name);
      continue;
    }
    if (allowed[name]) continue;
    offenders.push(`${name}: legacy reads [${legacyKeys}], v2 reads [${v2Keys}]`);
  }
  return { offenders, staleAllowances };
}

/**
 * The reasons a rotation verb and the admin log legitimately differ. Shared because both game
 * tables inherit these exact three from HLL's Commands.xml wires.
 */
export const SHARED_WIRE_ALLOWANCES: Record<string, string> = {
  // The wires address a rotation entry differently and cannot be reconciled: v2 by Index, legacy
  // by a named predecessor (and legacy cannot express "first" at all). Callers pass both.
  addMapToRotation: "v2 places by Index; legacy places after a named entry",
  removeMapFromRotation: "v2 removes by Index; legacy removes by name",
  // `ShowLog N` has no filter argument. No caller passes one, so nothing diverges in practice —
  // but if one ever does, it will apply on v2 and be silently ignored on legacy.
  getAdminLog: "v2 takes a Filters string; the legacy ShowLog has no such argument",
};
