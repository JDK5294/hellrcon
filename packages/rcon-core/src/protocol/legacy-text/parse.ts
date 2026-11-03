/**
 * Parsers for the legacy text protocol's tab/newline-delimited responses.
 */

export interface LegacyPlayer {
  name: string;
  /** UID; `iD` matches the field name the panel's live roster reads (parity with v2). */
  iD: string;
}

/**
 * `Get PlayerIds` → `"2\t(ABC) Kestrel : 76561198000000042\tAnotherName : 12345678901234567\t"`.
 * A leading numeric count token is dropped; each remaining token is `name : uid`.
 */
export function parsePlayerIds(resp: string): { players: LegacyPlayer[] } {
  const parts = resp
    .split("\t")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length && /^\d+$/.test(parts[0]!)) parts.shift(); // leading count
  const players = parts.map((p) => {
    const idx = p.lastIndexOf(" : "); // UID is the last ` : `-separated field (names may contain colons)
    return idx === -1 ? { name: p, iD: "" } : { name: p.slice(0, idx).trim(), iD: p.slice(idx + 3).trim() };
  });
  return { players };
}

/** `ShowLog <minutes>` → newline-delimited raw log lines, or the literal `EMPTY`. */
export function parseShowLog(resp: string): string[] {
  const t = resp.trim();
  if (!t || t.toUpperCase() === "EMPTY") return [];
  return t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}
