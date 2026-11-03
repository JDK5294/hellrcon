"use client";
/**
 * A page a plugin adds to the panel, drawn in place like a built-in screen.
 *
 * Its code is not in the panel's bundle: it is fetched from the API when the page is opened, and
 * the API sends it only to a viewer who may open the page (/api/plugin-pages/<plugin>/<page>) —
 * to anyone else it is an address that does not exist. The module is then imported from memory
 * and its default export rendered with the panel's own React, after the kit it builds against is
 * in place (lib/pluginKit).
 *
 * A plugin page is code running in the panel, with the viewer's session: installing a plugin is
 * trusting it, which is the operator's call (the plugins folder is theirs).
 */
import { useEffect, useState, type ComponentType } from "react";
import { ApiError, api, getToken } from "../lib/api";
import { installPageKit } from "../lib/pluginKit";
import { APP_NAME } from "../lib/brand";
import { ActionResult, EmptyState } from "./ui";

interface Loaded { Page: ComponentType; style: string }

/**
 * One import per page per session, shared by every visit. Keyed by the session too: another
 * account signing in on this tab never reuses what the last one was sent.
 */
const loaded = new Map<string, Promise<Loaded>>();

function loadPage(plugin: string, page: string): Promise<Loaded> {
  const key = `${getToken()}|${plugin}/${page}`;
  let p = loaded.get(key);
  if (!p) {
    p = (async () => {
      installPageKit();
      const { script, style } = await api<{ script: string; style?: string }>(`/plugin-pages/${encodeURIComponent(plugin)}/${encodeURIComponent(page)}`);
      const url = URL.createObjectURL(new Blob([script], { type: "text/javascript" }));
      try {
        const mod = (await import(/* webpackIgnore: true */ url)) as { default?: unknown };
        if (typeof mod.default !== "function") throw new Error("this plugin's page has nothing to show");
        return { Page: mod.default as ComponentType, style: style ?? "" };
      } finally {
        URL.revokeObjectURL(url);
      }
    })();
    loaded.set(key, p);
    // A failure is not remembered: the next visit asks again.
    p.catch(() => loaded.delete(key));
  }
  return p;
}

export function PluginPage({ plugin, page, title }: { plugin: string; page: string; title: string }) {
  const [state, setState] = useState<Loaded | { error: string; missing: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    setState(null);
    loadPage(plugin, page).then(
      (l) => { if (alive) setState(l); },
      (e: unknown) => { if (alive) setState({ error: (e as Error).message, missing: e instanceof ApiError && e.status === 404 }); },
    );
    return () => { alive = false; };
  }, [plugin, page]);
  // The page names the browser tab, as a built-in screen's title does.
  useEffect(() => { document.title = `${title} · ${APP_NAME}`; }, [title]);

  if (!state) return null;
  if ("error" in state) {
    // Not theirs to open (or gone since the list was read): what any unknown address shows.
    return state.missing ? <EmptyState title="There's nothing here." /> : <ActionResult error={`This page could not load: ${state.error}`} />;
  }
  const { Page, style } = state;
  return (
    <>
      {style && <style>{style}</style>}
      <Page />
    </>
  );
}
