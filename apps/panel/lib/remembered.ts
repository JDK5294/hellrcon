"use client";
/**
 * Screen state that outlives the screen.
 *
 * A screen's filters were plain component state, so they went when the screen did: set the game
 * log to Team kills with Live on, open a player from it, come back — by the browser's back, the
 * panel's own back, or the sidebar — and it was on All with Live off again. Opening a profile
 * unmounts the screen you came from, so nothing held inside that screen can survive the trip, and
 * neither can anything on a hub tab you switch away from.
 *
 * This keeps a value per signed-in user (the key convention of lib/sort.tsx and lib/panelPrefs.ts,
 * so staff sharing a browser keep their own), in one of two places:
 *
 * - "local": how someone likes the screen (Team kills, Live on). Kept until they change it, like
 *   a remembered sort order.
 * - "session": what they were looking into (a search, one player, the statistic a board ranks by,
 *   the dates a report covers, the page they were on). Kept for this tab's sitting, so it is there
 *   when they come back from a profile or another tab, but tomorrow's screens do not open filtered
 *   to yesterday's search.
 *
 * Every screen remembers the same way: the screen's own name, then the field — "leaderboard.sort",
 * "bans.search" — so one screen's search never lands in another's box.
 *
 * Read as the screen mounts, not in an effect afterwards, so a screen that fetches by its filters
 * asks once, with the remembered ones, instead of fetching the defaults first.
 */
import { useCallback, useMemo, useState } from "react";

export type Keep = "local" | "session";

const keyFor = (name: string) => {
  let user = "";
  try { user = localStorage.getItem("panel.username") ?? ""; } catch { /* ignore */ }
  return `panel.screen.${user || "_"}.${name}`;
};

const storage = (keep: Keep): Storage | null => {
  try { return keep === "local" ? window.localStorage : window.sessionStorage; } catch { return null; }
};

function read<T>(name: string | null, initial: T, accept: (v: unknown) => v is T, keep: Keep): T {
  if (!name) return initial;
  try {
    const raw = storage(keep)?.getItem(keyFor(name));
    if (raw == null) return initial;
    const parsed: unknown = JSON.parse(raw);
    return accept(parsed) ? parsed : initial;
  } catch { return initial; }
}

function write(name: string | null, keep: Keep, value: unknown) {
  if (!name) return;
  try { storage(keep)?.setItem(keyFor(name), JSON.stringify(value)); } catch { /* best-effort, like every preference */ }
}

/**
 * useState, remembered. `accept` vets what comes back: storage can hold anything (an older build's
 * value, a hand edit), and a value the screen no longer understands falls back to `initial`
 * instead of reaching it.
 *
 * A `name` of null keeps nothing — plain state, for a hook that remembers only when its caller
 * asks (the pager). A new name reads that name's value: one profile's filters are not the next
 * profile's. The setter takes a value or an update from the current one, like useState's; a value
 * is written at once, so a press that also navigates away is still remembered.
 */
export function useRemembered<T>(name: string | null, initial: T, accept: (v: unknown) => v is T, keep: Keep = "local"): [T, (next: T | ((cur: T) => T)) => void] {
  const [state, setState] = useState(() => ({ name, value: read(name, initial, accept, keep) }));
  if (state.name !== name) setState({ name, value: read(name, initial, accept, keep) });
  const value = state.name === name ? state.value : read(name, initial, accept, keep);
  const set = useCallback((next: T | ((cur: T) => T)) => {
    if (typeof next !== "function") {
      write(name, keep, next);
      setState({ name, value: next });
      return;
    }
    setState((cur) => {
      const updated = (next as (cur: T) => T)(cur.value);
      write(name, keep, updated);
      return { name, value: updated };
    });
  }, [name, keep]);
  return [value, set];
}

/** What storage hands back is checked against one of these before a screen sees it. */
export const isText = (v: unknown): v is string => typeof v === "string";
export const isFlag = (v: unknown): v is boolean => typeof v === "boolean";
/** A page index, a count: a whole number from zero. */
export const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
/** One of a screen's fixed choices — a tab, a statistic, a mode. A choice a newer build dropped falls back. */
export function oneOf<T extends string>(choices: readonly T[]): (v: unknown) => v is T {
  return (v: unknown): v is T => typeof v === "string" && (choices as readonly string[]).includes(v);
}
/** Rows opened, by id. */
export const isFlagMap = (v: unknown): v is Record<string, boolean> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "boolean");
/** A list of ids or names — roles ticked, kinds of entry shown. */
export const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
/** An id or nothing — a side picked, a line lit, a scope not yet chosen. */
export const isTextOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
/** A player chosen with the player picker, or nobody. */
export const isPickedPlayer = (v: unknown): v is { playerId: string; name: string } | null =>
  v === null || (typeof v === "object" && typeof (v as { playerId?: unknown }).playerId === "string" && typeof (v as { name?: unknown }).name === "string");

/**
 * A remembered set of ids — the roles ticked in a filter — with the two things done to one: tick or
 * untick an id, and clear them all. Kept as a list, which storage can hold; read as a set.
 */
export function useRememberedSet(name: string, keep: Keep = "session"): [Set<string>, (id: string) => void, () => void] {
  const [ids, setIds] = useRemembered<string[]>(name, [], isTextList, keep);
  const set = useMemo(() => new Set(ids), [ids]);
  const toggle = useCallback((id: string) => setIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])), [setIds]);
  const clear = useCallback(() => setIds([]), [setIds]);
  return [set, toggle, clear];
}
