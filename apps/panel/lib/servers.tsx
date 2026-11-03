"use client";
/**
 * Global active-server context. One selected server drives every per-server view (config, VIPs,
 * bans, console, events) instead of each panel carrying its own picker — matching CRCON's pinned
 * server selector. The choice persists in localStorage and falls back to the first server.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";

/** `no` is the community-wide display ordinal the API attaches — see `numberOf` for why it cannot
 *  be this list's own index. `name` arrives ALREADY resolved to the staff nickname when one is
 *  set — the repository does that for every read — with the game's own name in `gameName`. */
export interface ServerLite { id: string; name: string; gameName?: string; nickname?: string | null; engagementMode: "observe" | "active"; protocol: string; game?: string; no?: number }

interface ServerCtx {
  servers: ServerLite[];
  serverId: string;
  server: ServerLite | undefined;
  /**
   * The active server's number, or null with none selected.
   *
   * Server names are the ones the game shows players, which means they are long and mostly
   * identical — "[ABC] Example Community #1 | MICS ON | LVL 50+ SL | LVL 100+ CMD | FRIENDLY
   * ADMINS" differs from #2 by one character, in the middle. Nothing that has to fit
   * in a header or a chip can print one. A short number staff can learn is what fits.
   */
  serverNo: number | null;
  /** Any server's number, for lists that name servers other than the active one. */
  numberOf: (id: string) => number | null;
  setServerId: (id: string) => void;
  refresh: () => void;
  loading: boolean;
  /**
   * Why the list couldn't be read, or "". An unread list is empty too, and every screen that
   * guards on "no servers" said "No game servers connected yet" over it — to the owner of a panel
   * with servers, who might well go and add them again.
   */
  error: string;
}

const Ctx = createContext<ServerCtx>({ servers: [], serverId: "", server: undefined, serverNo: null, numberOf: () => null, setServerId: () => {}, refresh: () => {}, loading: true, error: "" });
export function useServers() { return useContext(Ctx); }

/**
 * Run `reset` whenever the active server changes — but not on first render.
 *
 * A screen that acts on ONE server usually holds the outcome of that action in state: "Broadcast
 * sent.", "Sent to all 42 players.", a console transcript. None of that is true of the next server,
 * and leaving it on screen does not read as stale — it reads as a statement about the server now
 * named in the picker. Someone messages Main, switches to Seed, and the panel says everyone got it.
 *
 * Skipping the first render matters: firing on mount would clear whatever the screen legitimately
 * loaded for the server it opened on.
 *
 * Data a screen FETCHES per server does not need this — refetching replaces it. This is for the
 * things nothing refetches, because they are records of something that already happened.
 */
export function useResetOnServerChange(reset: () => void): void {
  const { serverId } = useServers();
  const seen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (seen.current === undefined) { seen.current = serverId; return; }
    if (seen.current === serverId) return;
    seen.current = serverId;
    reset();
    // `reset` is deliberately not a dependency: callers pass an inline closure, and depending on it
    // would fire this on every render instead of on every server change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);
}

const KEY = "panel.serverId";

/** `reloadKey`: read the list again when it changes — a role preview starting or ending, which
 *  changes whose list it is without anyone signing in again. */
export function ServerProvider({ children, reloadKey = "" }: { children: ReactNode; reloadKey?: string }) {
  const [servers, setServers] = useState<ServerLite[]>([]);
  const [serverId, setId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ servers: ServerLite[] }>("/servers");
      // Normalise once. This context feeds every server-scoped screen in the panel, so a response
      // without the field would not break one view — the throw propagates and the whole app
      // white-screens with "Application error", which says nothing about what went wrong.
      const list = r.servers ?? [];
      setServers(list);
      setId((cur) => {
        if (cur && list.some((s) => s.id === cur)) return cur;
        const stored = typeof window !== "undefined" ? localStorage.getItem(KEY) : null;
        if (stored && list.some((s) => s.id === stored)) return stored;
        return list[0]?.id ?? "";
      });
      setError("");
    } catch (e) {
      // Not fatal — views handle an empty list — but kept, so the "no servers" notices can say the
      // list couldn't be read rather than that nothing is connected.
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh, reloadKey]);

  const setServerId = useCallback((id: string) => {
    setId(id);
    try { localStorage.setItem(KEY, id); } catch { /* ignore */ }
  }, []);

  const server = servers.find((s) => s.id === serverId);
  /*
   * The number comes from the API, which counts over EVERY server before filtering the list to
   * what this reader may see. It used to be this list's own index+1, which is the same answer
   * only for somebody who can see all of them: a staff member granted one server received a
   * one-server list and was told it was "Server 1" no matter which one it actually was — so two
   * people looking at the same server called it by different numbers.
   *
   * The remaining trade-off is unchanged and intended: deleting a server renumbers the ones after
   * it. That is the honest reading of an ordinal, and the number is a label for humans — never an
   * identifier. Everything that stores or routes uses the id. If the numbers must outlive a
   * deletion, that is a stored column, not a tweak.
   */
  const numberOf = useCallback((id: string) => {
    return servers.find((s) => s.id === id)?.no ?? null;
  }, [servers]);
  const serverNo = numberOf(serverId);
  return <Ctx.Provider value={{ servers, serverId, server, serverNo, numberOf, setServerId, refresh, loading, error }}>{children}</Ctx.Provider>;
}
