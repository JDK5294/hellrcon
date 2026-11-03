/**
 * Friendly names for the platform tokens the game reports on player rows. Field evidence (a live
 * crossplay server's analytics) shows the wire value is an unreal enum name — EPlatformFamily::
 * XboxSeries / PS5 / Steam / WinGDK / EGS — while the official RCON client's own vocabulary is the
 * bare steam / epic / winstore. Both spellings are folded here: the enum prefix is stripped, then
 * the token mapped. Consoles report their own families (XboxSeries, PS5), so the Windows tokens
 * (WinGDK / winstore) are the Microsoft Store PC build, not console. An unrecognised token shows
 * as itself rather than being folded into "Unknown" — the raw string is the truth about what the
 * server said.
 */
const PLATFORM_LABEL: Record<string, string> = {
  steam: "Steam (PC)",
  epic: "Epic (PC)",
  egs: "Epic (PC)",
  win: "MS Store (PC)",
  winstore: "MS Store (PC)",
  wingdk: "MS Store (PC)",
  xbox: "Xbox",
  xboxone: "Xbox",
  xboxseries: "Xbox",
  xsx: "Xbox",
  xbl: "Xbox",
  ps4: "PlayStation",
  ps5: "PlayStation",
  psn: "PlayStation",
  unknown: "Unknown",
  other: "Other",
};

/** The lookup key for a reported token: lowercased, unreal enum prefix stripped. */
const keyOf = (id: string) => id.toLowerCase().replace(/^eplatformfamily::/, "");

export const platformLabel = (id: string | null | undefined): string =>
  id ? PLATFORM_LABEL[keyOf(id)] ?? id : "";

/** True when the token resolved to a known platform (used to decide chart series folding). */
export const platformKnown = (id: string): boolean => PLATFORM_LABEL[keyOf(id)] !== undefined;
