"use client";
/**
 * Code fetched the first time it is shown — every screen, and the few heavy pieces inside one.
 *
 * next/dynamic did this through React's Suspense, and Suspense keeps a placeholder on screen for at
 * least 300ms once it has shown one (its reveal throttle, there so placeholders do not flicker). So
 * a screen whose code arrived in 30ms still showed ~300ms later — and only then asked for its data,
 * which it asks for once shown. Every screen's first opening in a visit paid it, and a phone's
 * home-screen app starts a new visit often. Here the placeholder is ordinary state: the code
 * arrives and the screen shows, at once.
 *
 * Fetched once, the code is kept for the rest of the visit, so the screen shows at once next time.
 * Code that could not be fetched (the panel updated under an open tab) is thrown where it would
 * show, for ScreenBoundary to offer the reload, as next/dynamic's was.
 */
import { useEffect, useState, type ComponentType } from "react";

/**
 * `load` is the import (`() => import("./Players")`), `name` the export it shows ("default" for a
 * default export), and `Loading` what shows until it has arrived — nothing if not given. What comes
 * back is used as the export itself would be.
 */
export function onDemand<M extends Record<K, ComponentType<never>>, K extends keyof M>(
  load: () => Promise<M>, name: K, Loading?: ComponentType,
): M[K] {
  let shown: ComponentType<object> | null = null;
  let failed: { error: unknown } | null = null;
  let asked: Promise<void> | null = null;
  const fetchCode = () => (asked ??= load().then(
    (m) => { shown = m[name] as unknown as ComponentType<object>; },
    (error: unknown) => { failed = { error }; },
  ));

  function OnDemand(props: object) {
    const [, arrived] = useState(0);
    useEffect(() => {
      if (shown) return;
      let mounted = true;
      void fetchCode().then(() => { if (mounted) arrived((n) => n + 1); });
      return () => { mounted = false; };
    }, []);
    if (failed) throw failed.error;
    if (!shown) return Loading ? <Loading /> : null;
    const Shown = shown;
    return <Shown {...props} />;
  }
  return OnDemand as unknown as M[K];
}
