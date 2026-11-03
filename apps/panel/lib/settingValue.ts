/**
 * A game setting's on/off answer, or null when it does not plainly say.
 *
 * Read with `Boolean(value)`, every non-empty string was ON — "off", "false", "disabled" included —
 * so a server that answers in words showed a switch that was off as on. This takes the same words
 * the command tables and the Auto settings drift check do; anything else is unknown, and the page
 * says so rather than showing it as off.
 */
export function boolSetting(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === 0) return v === 1;
  if (typeof v === "string") {
    const w = v.trim().toLowerCase();
    if (["true", "on", "enabled", "yes", "1"].includes(w)) return true;
    if (["false", "off", "disabled", "no", "0"].includes(w)) return false;
  }
  return null;
}
