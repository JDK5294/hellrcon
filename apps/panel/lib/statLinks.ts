/**
 * "View on…" external stat-site links for a player. Third-party HLL stat trackers index players by
 * their Steam ID64 (17-digit numeric); console (Windows Store / Xbox) accounts use a GUID those
 * sites don't track, so for them we only surface what resolves. We deliberately link the confident,
 * stable destinations (a Steam ID64 profile deep-links; the community trackers open their site so
 * the operator can search) rather than fabricating per-player URLs that would 404.
 */
export interface StatLink { label: string; href: string; note?: string }

const isSteamId64 = (id: string) => /^\d{17}$/.test(id);

export function buildStatLinks(platform: string, platformId: string): StatLink[] {
  const links: StatLink[] = [];
  if (isSteamId64(platformId)) {
    links.push({ label: "Steam profile", href: `https://steamcommunity.com/profiles/${platformId}` });
    links.push({ label: "HLL Records", href: `https://hllrecords.com/players/${platformId}`, note: "opens their tracker" });
    links.push({ label: "HeLO", href: `https://helo-system.de/`, note: "search by name" });
    links.push({ label: "HLLoR", href: `https://hellor.pro/`, note: "search by name" });
  } else {
    // Console/other platform: the Steam-keyed trackers can't deep-link, so offer their search entry.
    links.push({ label: "HLL Records", href: `https://hllrecords.com/`, note: `search this ${platform} account` });
    links.push({ label: "HLLoR", href: `https://hellor.pro/`, note: "search by name" });
  }
  return links;
}
