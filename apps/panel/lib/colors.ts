/**
 * Semantic game colors — the single mapping from game facts to color classes, used by every
 * surface (live feed, game log, scoreboard, widgets). The classes resolve to shared CSS variables
 * in globals.css (--side-blue/--side-red, --tone-*, --lvl-*), so the palette is identical
 * everywhere and re-themes in one place.
 */

/** Event tone: which color family an event row/tag belongs to.
 *  Kills wear the KILLER's side (blue/red); team kills are always yellow regardless of side. */
export function eventTone(kind: string, data?: Record<string, unknown> | null): string {
  if (kind === "evt.teamkill") return "tk";
  if (kind === "evt.kill") {
    const side = typeof data?.actorSide === "string" ? data.actorSide : null;
    if (side === "allies") return "blue";
    if (side === "axis") return "red";
    return ""; // old rows without side data: neutral, never a guess
  }
  if (kind.startsWith("evt.chat.")) return "chat";
  if (kind === "evt.player.connected" || kind === "evt.player.disconnected" || kind === "evt.player.teamSwitched") return "conn";
  if (kind.startsWith("evt.admin.") || kind === "evt.player.kicked" || kind === "evt.player.banned") return "mod";
  if (kind.startsWith("evt.vote.")) return "vote";
  if (kind.startsWith("evt.match.")) return "match";
  return "";
}

/** Row class ("tone-blue") for a feed/log line, or "" for untinted kinds. */
export const toneClass = (kind: string, data?: Record<string, unknown> | null): string => {
  const t = eventTone(kind, data);
  return t ? `tone-${t}` : "";
};

/** Player-level color class on the CRCON-familiar scale:
 *  <20 red · <50 yellow · <200 green · <350 blue · 350+ purple. */
export function levelClass(level?: number | null): string {
  if (level == null || level <= 0) return "";
  if (level < 20) return "lvl-1";
  if (level < 50) return "lvl-2";
  if (level < 200) return "lvl-3";
  if (level < 350) return "lvl-4";
  return "lvl-5";
}
