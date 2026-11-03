"use client";
/**
 * One way to load something from the API.
 *
 * Nearly thirty screens had each written their own version of the same eight lines: a nullable
 * state, an error string, a `useCallback` fetcher, and a `useEffect` that calls it. Three of those
 * thirty guarded against a stale response; the rest did not, which is a real bug and not a tidiness
 * complaint — pick a different server while its VIP list is still in flight and the old request can
 * land second and paint the wrong server's data over the right one, with nothing on screen to say
 * so.
 *
 * `useResource` is that pattern written once, with the guard always on.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { onRefreshAll } from "./refresh";

export interface Resource<T> {
  /** The loaded value, or null while it is still coming (or when there is nothing to load). */
  data: T | null;
  /** The failure message, or "" — ready to hand straight to <ActionResult error={…} />. */
  error: string;
  /** True while the first value for the current request is outstanding: what a skeleton keys off. */
  loading: boolean;
  /** Fetch again, keeping what's on screen until the new value arrives. */
  reload: () => void;
}

/**
 * `load` must be stable — wrap it in `useCallback` with whatever it depends on, exactly as the
 * hand-written versions already did. Pass null when there is nothing to load yet (no server
 * selected, no permission) and the resource stays empty instead of fetching.
 *
 * The two ways of re-fetching are deliberately different:
 *   - `load` changes identity (its deps changed) — you are now looking at a DIFFERENT thing, so the
 *     old value is wrong and is cleared; the screen shows its skeleton.
 *   - `reload()` — same thing, fetched again. The current value stays put so a refresh doesn't
 *     blink the table away and back.
 */
export function useResource<T>(
  load: (() => Promise<T>) | null,
  options: {
    /**
     * Re-fetch every N ms — for screens that must stay current on their own (the live roster, a
     * running import, seeding status). Six screens each wrote this loop by hand with their own
     * interval, and the ones that also guarded against a stale response were the minority. A poll
     * never clears what is on screen: the list stays put and is replaced when the new one lands.
     */
    refreshMs?: number;
  } = {},
): Resource<T> {
  const { refreshMs } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);
  // Which fetcher produced what's on screen, so the effect can tell "different resource" from
  // "same resource again".
  const shown = useRef<typeof load>(null);
  // Callers waiting to be told this resource has finished a refresh they asked for. Held in a ref
  // because the fetch that resolves them lives inside the effect below, which re-runs.
  const settle = useRef<(() => void)[]>([]);
  const done = () => { for (const resolve of settle.current.splice(0)) resolve(); };

  useEffect(() => {
    const isDifferent = shown.current !== load;
    shown.current = load;
    if (!load) {
      setData(null);
      setError("");
      return;
    }
    // Only an actual change of subject clears the screen; a reload leaves it alone.
    if (isDifferent) setData(null);
    setError("");

    // The guard: a response is only allowed to paint if this effect is still the current one.
    // React runs the cleanup before re-running the effect, so an outrun request finds alive=false.
    // One flag covers the first fetch and every poll after it.
    let alive = true;
    // One request at a time. setInterval keeps firing whether or not the last answer has come
    // back, so a response slower than the interval (a wedged API, a dead game server holding the
    // connect for its full timeout) used to stack request on request — a 15s poll against a 60s
    // hang is four in flight, all to be thrown away — which is load on the exact backend that is
    // already struggling.
    let inFlight = false;
    const run = () => {
      inFlight = true;
      load()
        .then((value) => { if (alive) { setData(value); setError(""); } })
        .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); })
        .finally(() => { inFlight = false; done(); });
    };
    run();
    // A hidden tab skips its polls — a phone with the panel backgrounded was re-reading the live
    // roster every 15s all day — and notes that it did, so coming back shows fresh data at once
    // instead of waiting out the rest of the interval.
    let missedWhileHidden = false;
    const tick = () => {
      if (inFlight) return;
      if (typeof document !== "undefined" && document.hidden) { missedWhileHidden = true; return; }
      run();
    };
    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden && missedWhileHidden) {
        missedWhileHidden = false;
        tick();
      }
    };
    const timer = refreshMs && refreshMs > 0 ? setInterval(tick, refreshMs) : null;
    if (timer && typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      if (timer) {
        clearInterval(timer);
        if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
      }
    };
  }, [load, nonce, refreshMs]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  /**
   * Pull-to-refresh reaches every resource through here, so no screen has to wire it up.
   *
   * The promise is the contract: it resolves when THIS resource's next fetch has landed, which is
   * what keeps the gesture's spinner honest. A resource with nothing to load (`load` is null — no
   * server picked, no permission) reports done immediately rather than hanging the others.
   */
  useEffect(() => onRefreshAll(() => {
    if (!load) return;
    return new Promise<void>((resolve) => { settle.current.push(resolve); reload(); });
  }), [load, reload]);

  // Unmounting mid-refresh (the gesture ran, then the view changed) must not leave a caller waiting
  // on a fetch that will never report back.
  useEffect(() => () => done(), []);

  return { data, error, loading: data === null && error === "", reload };
}

/**
 * The stale-response guard on its own, for the loads `useResource` cannot own.
 *
 * `useResource` holds the value it fetched, which is the right shape for a screen that only
 * DISPLAYS what came back. A screen whose load seeds state it then edits — a settings form, a map
 * rotation you reorder, a control panel whose buttons read what is on screen — has to keep that
 * state itself, so it writes its own fetch, and those were written without the guard. Pick a
 * different server while the first request is in flight and the old server's answer can land
 * second and paint over the new one's, with nothing on screen to say so. On a form that is saved
 * back, the next Save then writes the WRONG server's settings to the right server.
 *
 * Claim the load as it starts and check the returned test before touching state:
 *
 *     const claim = useLatestLoad();
 *     const load = useCallback(async () => {
 *       const fresh = claim();
 *       const r = await api(`/servers/${serverId}/thing`);
 *       if (!fresh()) return;          // a newer load has started — this answer is for the old one
 *       setThing(r);
 *     }, [serverId, claim]);
 *
 * It covers a repeating poll for free: each tick claims its own turn, so a slow response cannot
 * overwrite the newer one that overtook it.
 */
export function useLatestLoad(): () => () => boolean {
  const seq = useRef(0);
  return useCallback(() => {
    const mine = ++seq.current;
    return () => mine === seq.current;
  }, []);
}
