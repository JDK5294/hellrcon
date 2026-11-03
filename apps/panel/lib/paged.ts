"use client";
/**
 * One way to read a list that is longer than one page.
 *
 * This began as "Load more" — append the next page under the current one — and that shape earned
 * its retirement: the only way to reach last month was to click through everything between, the
 * page grew without bound, and there was no way BACK. What replaced it is real pagination: the
 * screen holds exactly one page, you move between pages, and you choose how big a page is. The
 * page-size choice is one preference shared by every list in the panel, because "I like reading
 * 100 rows at a time" is about the reader, not about which table they happen to be on.
 *
 * The snapshot semantics survived the rewrite because they matter more with page jumps, not less.
 * These lists move underneath the reader — the game log gains rows every few seconds — and offset
 * paging against a moving list repeats and skips rows. Endpoints that support it hand back an
 * anchor (the instant page one was read) and every later page is answered from that same snapshot,
 * whatever offset it asks for. Endpoints that don't simply omit it and get plain offsets.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isCount, useRemembered } from "./remembered";

/** What one page looks like, whatever the endpoint calls its rows. */
export interface Page<T> {
  /**
   * The rows. Typed as an array and normalised to one on arrival — every caller here writes
   * `items: r.events` straight off the response, and a response that came back thinner than the
   * type promised (an endpoint whose feature has no data yet, a permission-shaped `{}`) makes that
   * `undefined`. Normalising once, here, is the difference between a screen that says "nothing
   * yet" and a React tree that comes down entirely.
   */
  items: T[];
  total: number | null;
  /** The snapshot this read was answered from, replayed to every later page. Omit = plain offsets. */
  cursor?: string;
}

export interface PagedList<T> {
  /** The CURRENT page's rows — null until the first page of this query lands. */
  items: T[] | null;
  /** How many match the query in total, or null if the endpoint didn't say. */
  total: number | null;
  error: string;
  /** True while a page change is in flight (the first load of a query shows a skeleton instead). */
  loading: boolean;
  /** 0-based current page. */
  page: number;
  /** Total pages when the total is known. */
  pages: number | null;
  limit: number;
  hasPrev: boolean;
  hasNext: boolean;
  setPage: (p: number) => void;
  /** Changing the size re-reads from page one — offsets under the old size mean nothing. */
  setLimit: (n: number) => void;
  /** Re-fetch the current query from page one against a fresh snapshot. */
  reload: () => void;
  /** Read the page on screen again as the list stands now, keeping the reader's place: a change
   *  made to a row on page three is seen on page three, not by going back to page one. */
  refresh: () => void;
}

/** The page sizes every list offers. One list's dropdown is every list's dropdown. */
export const PAGE_SIZES = [25, 50, 100, 200] as const;
const SIZE_KEY = "panel.pageSize";

/** The reader's one page-size preference, shared across every paged list. */
export function preferredPageSize(): number {
  try {
    const n = Number(localStorage.getItem(SIZE_KEY));
    if (PAGE_SIZES.includes(n as (typeof PAGE_SIZES)[number])) return n;
  } catch { /* no storage — the default is fine */ }
  return 50;
}

const rows = <T,>(page: Page<T>): T[] => (Array.isArray(page.items) ? page.items : []);

/** A page kept for the sitting, with the server the list was read on when it was left there. */
interface KeptPage { page: number; on: string }
const isKeptPage = (v: unknown): v is KeptPage =>
  typeof v === "object" && v !== null && isCount((v as KeptPage).page) && typeof (v as KeptPage).on === "string";

/**
 * The page a list is on, kept under `remember` with the server it was read `on`. A page kept on
 * another server reads as page one and stays kept for that server until this list's page is set,
 * so switching back finds it again: only a filter changes what a page means, and a filter changes
 * in front of the list, which sets its page.
 */
function useKeptPage(remember: string | undefined, on: string): [number, (next: number | ((cur: number) => number)) => void] {
  const [kept, setKept] = useRemembered<KeptPage>(remember ? `${remember}.page` : null, { page: 0, on }, isKeptPage, "session");
  const page = kept.on === on ? kept.page : 0;
  const setPage = useCallback((next: number | ((cur: number) => number)) => {
    if (typeof next === "number") setKept({ page: next, on });
    else setKept((cur) => ({ page: next(cur.on === on ? cur.page : 0), on }));
  }, [setKept, on]);
  return [page, setPage];
}

/**
 * `fetchPage` must be stable: wrap it in `useCallback`/`useMemo` keyed on the query. When its
 * identity changes the query has changed, so the list resets to page one — you are looking at a
 * different result set. Pass null when there is nothing to load yet (no server, no permission).
 *
 * `remember` names the list (see lib/remembered.ts) to keep its page for the sitting: a screen
 * that remembers its filters comes back on the page it was left on, not on page one of them. A
 * new name is another list — another player's, another group's — and opens on its own page.
 *
 * `on` is the server the list is read on, when that is the sidebar's (or a scope that follows
 * it), which can change while the screen is away: page five of one server's matches is not where
 * another server's open. The page is kept with the server it was read on, one per list, so
 * another server opens on its first page and the first comes back to page five, as long as the
 * other was not paged meanwhile. Switched in front of the list it is the same: another server's
 * list is another list, not a new filter of this one.
 */
export function usePagedList<T>(
  fetchPage: ((offset: number, limit: number, cursor?: string) => Promise<Page<T>>) | null,
  remember?: string,
  on = "",
): PagedList<T> {
  const [items, setItems] = useState<T[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [page, setPageState] = useKeptPage(remember, on);
  const [limit, setLimitState] = useState(preferredPageSize);
  // Which list the rows and total were read for. Another list's go the moment it changes, before
  // they are drawn under the new one or the page kept for it is clamped against their length —
  // page five of a long list cut to the last page of the short one shown a moment before.
  const list = `${remember ?? ""}\n${on}`;
  const [readFor, setReadFor] = useState(list);
  if (readFor !== list) { setReadFor(list); setItems(null); setTotal(null); setError(""); }
  const lastList = useRef(list);
  const [nonce, setNonce] = useState(0);
  // If the query changed while a page was in flight, that page belongs to the previous result set.
  const generation = useRef(0);
  // The snapshot page one was taken against, replayed to every later page. A ref, not state:
  // changing it must not re-render, and page fetches read the current value at call time.
  const cursor = useRef<string | undefined>(undefined);
  // Which query the cursor (and page position) belong to. Tracked inside the fetch effect rather
  // than in a second effect, so "new query → clear the snapshot, go to page one" happens BEFORE
  // the first fetch of that query instead of racing it. The first query a list is handed is not
  // a change of query: it is the one the remembered page belongs to — and so is the first query
  // of another list (another name, another server), which opens on its own page.
  const lastQuery = useRef<typeof fetchPage>(null);

  useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    const moved = lastList.current !== list;
    lastList.current = list;
    const isNewQuery = !moved && lastQuery.current !== null && lastQuery.current !== fetchPage;
    lastQuery.current = fetchPage;
    if (moved) cursor.current = undefined; // another list, another snapshot
    if (isNewQuery) {
      cursor.current = undefined; // a new query is a new snapshot
      setItems(null); setTotal(null); setError("");
      // Kept as this server's page one even when the page already reads as one: a page kept on
      // another server was read under the old query too, and must not come back with this one.
      setPageState(0);
      if (page !== 0) return; // this effect refires at page one
    }
    if (!fetchPage) { setLoading(false); return; }
    setLoading(true);
    let alive = true;
    fetchPage(page * limit, limit, cursor.current)
      .then((p) => {
        if (!alive || mine !== generation.current) return;
        cursor.current = p.cursor ?? cursor.current;
        setItems(rows(p));
        setTotal(p.total ?? null);
        setError("");
      })
      .catch((e: unknown) => { if (alive && mine === generation.current) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive && mine === generation.current) setLoading(false); });
    return () => { alive = false; };
  }, [fetchPage, page, limit, nonce, setPageState, list]);

  const pages = total !== null ? Math.max(1, Math.ceil(total / limit)) : null;
  // A list that came back shorter than the page it was left on (rows went, or a remembered page
  // outlived them) moves to its last page rather than showing an empty one past the end.
  useEffect(() => {
    if (pages !== null && page > pages - 1) setPageState(pages - 1);
  }, [pages, page, setPageState]);
  const setPage = useCallback((p: number) => {
    setPageState((cur) => {
      const next = Math.max(0, pages !== null ? Math.min(p, pages - 1) : p);
      return next === cur ? cur : next;
    });
  }, [pages, setPageState]);
  const setLimit = useCallback((n: number) => {
    if (!PAGE_SIZES.includes(n as (typeof PAGE_SIZES)[number])) return;
    try { localStorage.setItem(SIZE_KEY, String(n)); } catch { /* best-effort preference */ }
    setLimitState(n);
    setPageState(0);
  }, [setPageState]);
  const reload = useCallback(() => {
    cursor.current = undefined;
    setPageState(0);
    setNonce((n) => n + 1);
  }, [setPageState]);
  const refresh = useCallback(() => {
    cursor.current = undefined; // as it stands now, not as it stood when page one was read
    setNonce((n) => n + 1);
  }, []);

  // Without a total we can still infer "there is a next page": a full page probably isn't the last.
  const hasNext = pages !== null ? page < pages - 1 : (items?.length ?? 0) === limit;

  return {
    items, total, error, loading, page, pages, limit,
    hasPrev: page > 0, hasNext, setPage, setLimit, reload, refresh,
  };
}

/**
 * The same contract over rows already in memory — the profile panels and summary tables whose
 * endpoints return everything at once. Slicing locally keeps the Pager identical on screen, and a
 * caller that sorts should sort BEFORE handing the rows in, so ordering spans the whole list
 * rather than one page of it. `remember` and `on` keep the page as usePagedList's do; a caller
 * that remembers hands in null while its rows load — from the render its list changes in, not an
 * effect later — so an empty list, or the last list's rows, cannot move it in the meantime.
 *
 * `query` is what the rows were picked and ordered by — the search typed, the column sorted on.
 * Another one is another set of rows, and it opens on its first page, as a new query does for a
 * list read from the server: page four of the whole list is not where a search's answer starts.
 * The query the rows arrive under is the one a remembered page belongs to — a remembered column is
 * put back once the screen is first drawn, before its rows are in — so coming back finds the page
 * it was left on.
 */
export function useClientPages<T>(all: T[] | null, remember?: string, on = "", query = ""): PagedList<T> {
  const [kept, setPageState] = useKeptPage(remember, on);
  const [pagedFor, setPagedFor] = useState(query);
  // Whether rows have come in since the screen opened: a query that changes before they have is
  // the screen putting its remembered order back, and one that changes after is the reader's.
  const [settled, setSettled] = useState(all !== null);
  useEffect(() => { if (all !== null && !settled) setSettled(true); }, [all, settled]);
  // Page one from the render a new query is drawn in; the reset is kept once that render is.
  const page = !settled || pagedFor === query ? kept : 0;
  useEffect(() => {
    if (pagedFor === query) return;
    setPagedFor(query);
    if (settled) setPageState(0);
  }, [pagedFor, query, settled, setPageState]);
  const [limit, setLimitState] = useState(preferredPageSize);
  const total = all?.length ?? null;
  const pages = total !== null ? Math.max(1, Math.ceil(total / limit)) : null;
  // A shrinking list (a filter, a deletion) must not leave the reader on a page past the end.
  useEffect(() => {
    if (pages !== null && page > pages - 1) setPageState(Math.max(0, pages - 1));
  }, [pages, page, setPageState]);
  const items = useMemo(() => (all ? all.slice(page * limit, page * limit + limit) : null), [all, page, limit]);
  const setPage = useCallback((p: number) => setPageState(Math.max(0, p)), [setPageState]);
  const setLimit = useCallback((n: number) => {
    if (!PAGE_SIZES.includes(n as (typeof PAGE_SIZES)[number])) return;
    try { localStorage.setItem(SIZE_KEY, String(n)); } catch { /* best-effort preference */ }
    setLimitState(n);
    setPageState(0);
  }, [setPageState]);
  return {
    items, total, error: "", loading: false, page, pages, limit,
    hasPrev: page > 0, hasNext: pages !== null && page < pages - 1,
    setPage, setLimit, reload: () => {}, refresh: () => {},
  };
}
