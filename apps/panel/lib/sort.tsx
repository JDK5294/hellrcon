"use client";
/**
 * Table sorting, adoptable in three lines.
 *
 * Only two of the panel's eighteen tables could be sorted; everywhere else you got whatever order
 * the API happened to return, which is the difference between scanning a list and reading all of
 * it. Rewriting sixteen tables into one generic DataTable would have been a large, risky diff, so
 * this is deliberately a hook plus a header cell that drop into the markup a table already has:
 *
 *   const s = useSortable<BanRow>({ player: (b) => b.playerName ?? "", at: (b) => b.createdAt }, "at", "desc");
 *   <thead><tr><SortTh s={s} k="player">Player</SortTh>…</tr></thead>
 *   <tbody>{s.sorted(rows).map(…)}</tbody>
 *
 * The chosen column and direction are remembered per user per table, so the order you work in is
 * the order you come back to.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";

export type SortDir = "asc" | "desc";
/** Per column: pull the value to compare. Strings sort case-insensitively, everything else natural. */
export type Accessors<T> = Record<string, (row: T) => string | number | boolean | null | undefined>;

export interface Sortable<T> {
  key: string;
  dir: SortDir;
  toggle: (key: string) => void;
  sorted: (rows: T[]) => T[];
}

const prefsKey = (table: string) => {
  let user = "";
  try { user = localStorage.getItem("panel.username") ?? ""; } catch { /* ignore */ }
  return `panel.sort.${user || "_"}.${table}`;
};

export function useSortable<T>(
  accessors: Accessors<T>,
  defaultKey: string,
  defaultDir: SortDir = "asc",
  /** stable table name; omit to skip remembering the choice. */
  persistAs?: string,
): Sortable<T> {
  const [key, setKey] = useState(defaultKey);
  const [dir, setDir] = useState<SortDir>(defaultDir);

  useEffect(() => {
    if (!persistAs) return;
    try {
      const raw = localStorage.getItem(prefsKey(persistAs));
      if (!raw) return;
      const p = JSON.parse(raw) as { key?: string; dir?: SortDir };
      // Only restore a column this table still has — a saved sort on a removed column is ignored
      // rather than leaving the table unsorted.
      if (p.key && accessors[p.key]) { setKey(p.key); setDir(p.dir === "desc" ? "desc" : "asc"); }
    } catch { /* preference is best-effort */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore once per table
  }, [persistAs]);

  const toggle = useCallback((k: string) => {
    setKey((curKey) => {
      setDir((curDir) => {
        // Same column flips direction; a new column starts in the direction that's useful for its
        // type — text A→Z, numbers and dates biggest/newest first, which is what you almost always
        // want from "sort by kills" or "sort by when".
        const next: SortDir = curKey === k ? (curDir === "asc" ? "desc" : "asc") : "asc";
        if (persistAs) { try { localStorage.setItem(prefsKey(persistAs), JSON.stringify({ key: k, dir: next })); } catch { /* ignore */ } }
        return next;
      });
      return k;
    });
  }, [persistAs]);

  const sorted = useCallback((rows: T[]): T[] => {
    const get = accessors[key];
    if (!get) return rows;
    const mul = dir === "asc" ? 1 : -1;
    // Copy first: callers pass arrays straight from state, and sorting in place mutates it.
    return rows.slice().sort((a, b) => {
      const av = get(a), bv = get(b);
      // Blanks sink to the bottom in both directions — an empty cell is never "the top result".
      const aEmpty = av === null || av === undefined || av === "";
      const bEmpty = bv === null || bv === undefined || bv === "";
      if (aEmpty || bEmpty) return aEmpty && bEmpty ? 0 : aEmpty ? 1 : -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * mul;
      if (typeof av === "boolean" && typeof bv === "boolean") return (Number(av) - Number(bv)) * mul;
      return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" }) * mul;
    });
  }, [accessors, key, dir]);

  return { key, dir, toggle, sorted };
}

/**
 * The same contract for a table the SERVER sorts.
 *
 * A paginated list cannot be sorted in the browser: you would only be reordering the rows already
 * fetched, so "sort by kills" would mean "the highest kills on this page" — quietly wrong, and
 * wrongest exactly when the list is long enough to care. This keeps the identical header
 * interaction and remembers the choice the same way, but sorts nothing itself: the caller reads
 * `key`/`dir` into its query and the database does the ordering across the whole result.
 */
export function useServerSort<T>(
  keys: readonly string[],
  defaultKey: string,
  defaultDir: SortDir = "desc",
  persistAs?: string,
): Sortable<T> {
  const [key, setKey] = useState(defaultKey);
  const [dir, setDir] = useState<SortDir>(defaultDir);

  useEffect(() => {
    if (!persistAs) return;
    try {
      const raw = localStorage.getItem(prefsKey(persistAs));
      if (!raw) return;
      const p = JSON.parse(raw) as { key?: string; dir?: SortDir };
      if (p.key && keys.includes(p.key)) { setKey(p.key); setDir(p.dir === "asc" ? "asc" : "desc"); }
    } catch { /* preference is best-effort */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore once per table
  }, [persistAs]);

  const toggle = useCallback((k: string) => {
    if (!keys.includes(k)) return;
    setKey((curKey) => {
      setDir((curDir) => {
        const next: SortDir = curKey === k ? (curDir === "asc" ? "desc" : "asc") : "desc";
        if (persistAs) { try { localStorage.setItem(prefsKey(persistAs), JSON.stringify({ key: k, dir: next })); } catch { /* ignore */ } }
        return next;
      });
      return k;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `keys` is a literal list, stable per table
  }, [persistAs]);

  // Already ordered by the database — reordering here would fight it.
  const sorted = useCallback((rows: T[]) => rows, []);
  return { key, dir, toggle, sorted };
}

/** A sortable column header. Renders as a plain <th> when the table isn't sortable by that column. */
export function SortTh<T>({ s, k, children, numeric, title }: {
  s: Sortable<T>; k: string; children: ReactNode; numeric?: boolean; title?: string;
}) {
  const active = s.key === k;
  return (
    <th
      className={`sortable${numeric ? " num" : ""}${active ? " sorted" : ""}`}
      onClick={() => s.toggle(k)}
      title={title ?? "Sort by this column"}
      aria-sort={active ? (s.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      {children}
      <span className="sort-caret" aria-hidden>{active ? (s.dir === "asc" ? " ▴" : " ▾") : ""}</span>
    </th>
  );
}
