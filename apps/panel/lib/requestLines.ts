/**
 * How a request line reads to the person deciding it. A leaf with no imports: the queue, the
 * builder's review table and the tests all need the same words, and none of them should have to
 * pull a component in to get them.
 */
/**
 * What a filed CALL is asking for, from its own body.
 *
 * Without this an approver signs blind: "Broadcast to the server" with no sight of the message,
 * "Run a raw console command" with no sight of the command. Rendered generically rather than from
 * a per-route table, so a route added later is legible the day it is written — scalars in full
 * (the message, the map, the command, the flag), and the names of anything structured, because a
 * whole auto-settings profile cannot fit on a line but "which parts of it" can.
 *
 * WHICH one, first. Some routes name their subject in the PATH rather than the body — renaming a
 * map, re-filing its family, changing one auto-settings rule — and reading only the body left the
 * approver with "Rename a map · name: Foy Warfare" and no way to tell which map was being renamed.
 * Every path parameter but the server's own id is printed ahead of the body.
 */
export function routeDetails(payload: Record<string, unknown>): string {
  const body = (payload.body ?? {}) as Record<string, unknown>;
  if (typeof body !== "object" || body === null) return "";
  const which = subjectBits(payload);
  const scalars: string[] = [];
  const structured: string[] = [];
  // A comment someone typed for the call goes first: every VIP added carries one, and on a
  // selection's or a group's grant it is the fifth field or later — behind "+N more" otherwise.
  const entries = Object.entries(body);
  for (const [k, v] of [...entries.filter(([k]) => k === "comment"), ...entries.filter(([k]) => k !== "comment")]) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") scalars.push(`${k}: “${v.length > 70 ? `${v.slice(0, 70)}…` : v}”`);
    else if (typeof v === "number" || typeof v === "boolean") scalars.push(`${k}: ${v}`);
    else structured.push(k);
  }
  const bits = scalars.slice(0, 4);
  if (scalars.length > 4) bits.push(`+${scalars.length - 4} more`);
  if (structured.length) bits.push(`changes ${structured.slice(0, 4).join(", ")}`);
  return [...which, ...bits].join(" · ");
}

/** The subject a filed call names: the words the API wrote down when it was filed — the account,
 *  the group, the rule, never just an id — or, on a line filed before it did, every path parameter
 *  but `id`, which on those lines is the server the line already carries. The API's Discord card
 *  renders the same words from its own copy — the two apps share no code, and each has a test on
 *  the sentence it produces. */
function subjectBits(payload: Record<string, unknown>): string[] {
  if (Array.isArray(payload.subject)) return (payload.subject as unknown[]).filter((s): s is string => typeof s === "string");
  const params = (payload.params ?? {}) as Record<string, unknown>;
  if (typeof params !== "object" || params === null) return [];
  return Object.entries(params)
    .filter(([k, v]) => k !== "id" && (typeof v === "string" || typeof v === "number") && String(v) !== "")
    .map(([k, v]) => `${k}: ${v}`);
}
