"use client";
/**
 * Game-descriptor context. The panel renders domain vocabulary (factions, roles, score buckets,
 * config fields) from the active server's game descriptor served by the API — never from
 * hardcoded per-game constants — so the UI is reusable across games. When no descriptor is
 * available everything degrades to neutral labels ("Team 3", "Role 7").
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import { useServers } from "./servers";

export interface GameSide { id: string; label: string; teamValues: number[]; parity?: "even" | "odd"; color?: "blue" | "red" | "neutral" }
export interface GameScoreField { key: string; label: string; title?: string }
export interface GameConfigField { field: string; label: string; kind: "bool" | "num" | "str"; read?: { command: string; key: string }; write?: { command: string; param: string }; min?: number; max?: number }
export interface GameDescriptor {
  id: string; label: string;
  sides: GameSide[];
  roles: Record<number, string>;
  squadLeaderRoles: number[];
  squadLabel: string;
  scoreFields: GameScoreField[];
  configFields: GameConfigField[];
  /** squad type → the roles only that type offers; absent for games without typed squads. */
  squadTypes?: Record<string, number[]>;
}

export interface GameCtx {
  descriptor: GameDescriptor | null;
  /** numeric role → label ("Role N" fallback). */
  roleName: (role?: number) => string;
  /** Does the descriptor actually name this role, or is it a number we are guessing about? */
  knowsRole: (role?: number) => boolean;
  /** resolve a raw team number to its side (teamValues first, then parity fallback). */
  sideOf: (team?: number) => GameSide | null;
  /** CSS hook for side coloring: side-blue / side-red / side-neutral. */
  sideClass: (team?: number) => string;
  /** display label for a raw team number ("Team N" fallback). */
  teamLabel: (team?: number) => string;
  /**
   * Display label for a SIDE id — the app-wide "allies"/"axis" that we persist on kill events,
   * match winners and per-round stats — in the words the ACTIVE GAME uses for it ("US"/"NVA" on
   * Hell Let Loose: Vietnam). The ids are cross-game and stay in the database; only what a human
   * reads changes, and every screen that shows a side has to ask for it or it says "Allies" over
   * a Vietnam round. Falls back to the capitalized id before a descriptor has loaded.
   */
  sideName: (sideId?: string | null) => string;
  scoreFields: GameScoreField[];
  squadLeaderRoles: number[];
  squadLabel: string;
  sides: GameSide[];
}

/** `sideName` in one given game's words, for a screen about something that need not be on the
 *  selected server — an event, a zone set — and so can be in the other game. */
export function sideNameIn(descriptor: GameDescriptor | null, sideId?: string | null): string {
  if (!sideId) return "";
  return descriptor?.sides.find((s) => s.id === sideId)?.label ?? sideId.charAt(0).toUpperCase() + sideId.slice(1);
}

function makeCtx(descriptor: GameDescriptor | null): GameCtx {
  const sides = descriptor?.sides ?? [];
  const sideOf = (team?: number): GameSide | null => {
    if (team == null) return null;
    const listed = sides.find((s) => s.teamValues.includes(team));
    if (listed) return listed;
    const parity = team % 2 === 0 ? "even" : "odd";
    return sides.find((s) => s.parity === parity) ?? null;
  };
  return {
    descriptor,
    sides,
    roleName: (role) => (role == null ? "" : descriptor?.roles[role] ?? `Role ${role}`),
    // A descriptor that names no roles at all knows nothing to compare against, so it answers yes
    // rather than declaring every role unknown — that would silently disable anything built on
    // this, which is what an unpopulated role table should never be able to do.
    knowsRole: (role) => role == null || !descriptor?.roles || !Object.keys(descriptor.roles).length || descriptor.roles[role] != null,
    sideOf,
    sideClass: (team) => `side-${sideOf(team)?.color ?? "neutral"}`,
    teamLabel: (team) => sideOf(team)?.label ?? (team == null ? "" : `Team ${team}`),
    sideName: (sideId) => sideNameIn(descriptor, sideId),
    scoreFields: descriptor?.scoreFields ?? [],
    squadLeaderRoles: descriptor?.squadLeaderRoles ?? [],
    squadLabel: descriptor?.squadLabel ?? "Squad",
  };
}

const Ctx = createContext<GameCtx>(makeCtx(null));
export function useGame() { return useContext(Ctx); }

/**
 * One game's descriptor by id, for a screen about a PLAYER rather than the selected server: their
 * game can be the other one, and role ids collide across games. Null until it loads, and for no
 * game or one the API doesn't know.
 */
export function useGameDescriptor(game: string | null | undefined): GameDescriptor | null {
  const [loaded, setLoaded] = useState<{ game: string; descriptor: GameDescriptor | null } | null>(null);
  useEffect(() => {
    if (!game) return;
    let alive = true;
    api<{ descriptor: GameDescriptor }>(`/games/${encodeURIComponent(game)}/descriptor`)
      .then((r) => { if (alive) setLoaded({ game, descriptor: r.descriptor }); })
      .catch(() => { if (alive) setLoaded({ game, descriptor: null }); });
    return () => { alive = false; };
  }, [game]);
  return loaded && loaded.game === game ? loaded.descriptor : null;
}

export function GameProvider({ children }: { children: ReactNode }) {
  const { server } = useServers();
  const game = (server as { game?: string } | undefined)?.game ?? "hll";
  const [descriptor, setDescriptor] = useState<GameDescriptor | null>(null);

  useEffect(() => {
    let alive = true;
    api<{ descriptor: GameDescriptor }>(`/games/${encodeURIComponent(game)}/descriptor`)
      .then((r) => { if (alive) setDescriptor(r.descriptor); })
      .catch(() => { if (alive) setDescriptor(null); }); // unknown game → neutral fallbacks
    return () => { alive = false; };
  }, [game]);

  return <Ctx.Provider value={makeCtx(descriptor)}>{children}</Ctx.Provider>;
}
