/**
 * The admin group a FRESH console-admin grant starts on.
 *
 * The game reports its groups with "owner" first, and both grant flows used to default to the
 * first entry — so every grant whose group nobody touched went out as OWNER, the level with the
 * keys to everything, when what this community actually hands out is "spectator" (the admin
 * camera and nothing else). A default nobody reads is a grant nobody meant: start on spectator
 * wherever the server offers it, and only fall back to the list's first entry on a server whose
 * custom group set has no spectator.
 */
export function preferredAdminGroup(groups: string[] | null | undefined): string {
  const list = groups ?? [];
  return list.find((g) => g.trim().toLowerCase() === "spectator") ?? list[0] ?? "";
}
