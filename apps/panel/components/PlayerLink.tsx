"use client";
/**
 * A clickable player name that jumps to that player's profile. Works with either our internal
 * player id or the game platform id (the /players/:id endpoint resolves both), so it can be dropped
 * anywhere a name appears — the live scoreboard, killfeed, moderation log, leaderboard, bans, etc.
 * With no id it renders the name as plain text (nothing to link to).
 */
import { useAppNav } from "../lib/nav";

export function PlayerLink({ playerId, name, className }: { playerId?: string | null; name?: React.ReactNode; className?: string }) {
  const { go } = useAppNav();
  const label = name ?? (playerId || "");
  if (!playerId) return <>{label}</>;
  return (
    <button
      type="button"
      className={`player-link${className ? ` ${className}` : ""}`}
      onClick={(e) => { e.stopPropagation(); go("players", { playerId }); }}
      title="Open profile"
    >
      {label}
    </button>
  );
}
