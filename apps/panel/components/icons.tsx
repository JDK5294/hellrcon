"use client";
/**
 * Line-icon set for the nav (and anywhere else). Stroke-based, inherit `currentColor`, sized by
 * font-size via width/height 1em — so they tint with the active/hover colour automatically.
 * Replaces the emoji glyphs for a consistent, modern line-icon look.
 */
import type { ReactNode } from "react";

function svg(children: ReactNode) {
  return (
    <svg viewBox="0 0 24 24" width="1.15em" height="1.15em" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export const ICON: Record<string, ReactNode> = {
  help: svg(<><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.4v.6" /><path d="M12 17h.01" /></>),
  dashboard: svg(<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>),
  servers: svg(<><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>),
  live: svg(<><circle cx="12" cy="12" r="3" /><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4M3.5 3.5a12 12 0 0 0 0 17M20.5 3.5a12 12 0 0 1 0 17" /></>),
  players: svg(<><circle cx="9" cy="8" r="3" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><path d="M16 5.2a3 3 0 0 1 0 5.6M17.5 20a5.5 5.5 0 0 0-3-4.9" /></>),
  leaderboard: svg(<><path d="M8 21h8M12 17v4" /><path d="M7 4h10v4a5 5 0 0 1-10 0V4Z" /><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" /></>),
  events: svg(<><path d="M3 12h4l2 6 4-14 2 8h6" /></>),
  activity: svg(<><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>),
  logs: svg(<><path d="M4 5h16M4 10h10M4 15h16M4 20h8" /></>),
  matches: svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M9 4v16" /></>),
  templates: svg(<><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h4" /><path d="M14.5 15.5l2 2 3-3.5" /></>),
  discord: svg(<><path d="M8 12h.01M16 12h.01" /><path d="M7.5 7.5C9 7 10.5 6.8 12 6.8s3 .2 4.5.7c2 3 2.8 6.2 2.5 9.5-1.4 1-2.9 1.7-4.5 2l-1-1.6M7.5 7.5c-2 3-2.8 6.2-2.5 9.5 1.4 1 2.9 1.7 4.5 2l1-1.6" /></>),
  autosettings: svg(<><path d="M12 3 5 6v5c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></>),
  seeding: svg(<><path d="M12 22V11" /><path d="M12 11C12 7 9 5 4 5c0 4 3 6 8 6Z" /><path d="M12 13c0-3.5 2.5-5.5 7-5.5 0 3.5-2.5 5.5-7 5.5Z" /></>),
  maps: svg(<><path d="m9 4 6 2 5-2v14l-5 2-6-2-5 2V6l5-2Z" /><path d="M9 4v14M15 6v14" /></>),
  bans: svg(<><circle cx="12" cy="12" r="9" /><path d="m6 6 12 12" /></>),
  vips: svg(<><path d="m12 3 2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 22l-5.3-2.8 1-5.8-4.2-4.1 5.9-.9L12 3Z" /></>),
  config: svg(<><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h7M15 18h5" /><circle cx="16" cy="6" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="13" cy="18" r="2" /></>),
  console: svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></>),
  broadcast: svg(<><path d="M3 11v2a1 1 0 0 0 1 1h2l6 4V6L6 10H4a1 1 0 0 0-1 1Z" /><path d="M16 8a5 5 0 0 1 0 8M18.5 5.5a9 9 0 0 1 0 13" /></>),
  users: svg(<><path d="M12 3 5 6v5c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z" /><circle cx="12" cy="10" r="2" /><path d="M8.5 15.5a3.5 3.5 0 0 1 7 0" /></>),
  community: svg(<><path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1Z" /><path d="M15 8.5a4 4 0 0 1 0 7" /></>),
  trim: svg(<><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13" /></>),
  settings: svg(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 13.6H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6V4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-1.2 2.9h.6a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.3.9Z" /></>),
  killfeed: svg(<><circle cx="12" cy="12" r="8" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M12 12h.01" /></>),
  system: svg(<><rect x="4" y="4" width="16" height="12" rx="2" /><path d="M8 20h8M12 16v4" /><path d="M7.5 9.5 10 12l-2.5 2.5M13 14.5h3.5" /></>),
};

/** Hub nav ids borrow the icon of the surface they absorbed — History was Logs, Moderation was
 *  Bans, Administration was Users — so consolidating those views didn't cost them their glyph. */
const ALIAS: Record<string, string> = { history: "logs", moderation: "bans", admin: "users" };

/** Is there a glyph of its own for this name (or the surface it borrows one from)? */
export const hasIcon = (name: string): boolean => Boolean(ICON[name] ?? ICON[ALIAS[name]]);

export function Icon({ name }: { name: string }) {
  return <>{ICON[name] ?? ICON[ALIAS[name]] ?? svg(<circle cx="12" cy="12" r="3.5" />)}</>;
}
