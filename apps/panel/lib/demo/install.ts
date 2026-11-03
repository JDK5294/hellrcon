/**
 * The public demo's world (app/demo), put in place before any of the panel's own code runs: the
 * page imports this first.
 *
 *  - The API: every request the panel makes to it — at /api, or at a server's public addresses
 *    (/s/…/api, /stats/…/api) — is answered in the page by lib/demo/server, and none leaves it. The
 *    live stream is an EventSource of the demo's own, fed the same way. Should anything from the
 *    page reach the API all the same, the API refuses it (apps/api app.ts, fromDemoPage).
 *  - Storage: the panel keeps its sign-in, settings and arrangements in localStorage, which the
 *    demo shares with the real panel on this address. The demo gets a store of its own in memory,
 *    gone on reload, so the real panel's sign-in and settings stay as they were; it starts with the
 *    dark look every visitor gets (lib/demo/theme). What a tab keeps (sessionStorage) is kept apart
 *    under keys of the demo's own.
 *  - Phone notifications: off, with the service worker out of reach, so signing out of the demo
 *    cannot turn off the notifications the real panel set up on this device.
 *  - Links to the panel's other pages are not followed: they would leave the demo.
 */
import { MODE_KEY } from "../theme.ts";
import { DEMO_NOTE } from "./flag.ts";
import type { DemoServer } from "./server.ts";

/** The page that is the demo. */
const DEMO_PAGE = /^\/demo\/?$/;
/** The sign-in the demo's panel holds: the demo's own API takes it, and nothing else would. */
const DEMO_TOKEN = "demo";
/** What a tab keeps for the demo, apart from the real panel's. */
const SESSION_PREFIX = "panel.demo:";

/** A Storage held in memory, `seed` in it to start with. */
function memoryStorage(seed: Record<string, string>): Storage {
  const items = new Map(Object.entries(seed));
  const methods = {
    get length() { return items.size; },
    key: (i: number) => [...items.keys()][i] ?? null,
    getItem: (k: string) => items.get(String(k)) ?? null,
    setItem: (k: string, v: unknown) => { items.set(String(k), String(v)); },
    removeItem: (k: string) => { items.delete(String(k)); },
    clear: () => items.clear(),
  };
  return storageProxy(methods, {
    get: (k) => items.get(k),
    set: (k, v) => { items.set(k, v); },
    remove: (k) => { items.delete(k); },
    keys: () => [...items.keys()],
  });
}

/** The tab's own storage, with the demo's keys kept under a prefix of their own. */
function prefixedStorage(real: Storage): Storage {
  const keys = () => {
    const out: string[] = [];
    for (let i = 0; i < real.length; i++) {
      const k = real.key(i);
      if (k?.startsWith(SESSION_PREFIX)) out.push(k.slice(SESSION_PREFIX.length));
    }
    return out;
  };
  const methods = {
    get length() { return keys().length; },
    key: (i: number) => keys()[i] ?? null,
    getItem: (k: string) => real.getItem(SESSION_PREFIX + String(k)),
    setItem: (k: string, v: unknown) => real.setItem(SESSION_PREFIX + String(k), String(v)),
    removeItem: (k: string) => real.removeItem(SESSION_PREFIX + String(k)),
    clear: () => { for (const k of keys()) real.removeItem(SESSION_PREFIX + k); },
  };
  return storageProxy(methods, {
    get: (k) => real.getItem(SESSION_PREFIX + k) ?? undefined,
    set: (k, v) => real.setItem(SESSION_PREFIX + k, v),
    remove: (k) => real.removeItem(SESSION_PREFIX + k),
    keys,
  });
}

/** Storage's methods, and its items as properties too (`storage.key`, `Object.keys(storage)`), as the browser's own has them. */
function storageProxy(methods: object, items: { get: (k: string) => string | undefined; set: (k: string, v: string) => void; remove: (k: string) => void; keys: () => string[] }): Storage {
  const own = (p: PropertyKey): p is string => typeof p === "string" && !(p in methods);
  return new Proxy(methods, {
    get: (t, p) => (own(p) ? items.get(p) : Reflect.get(t, p)),
    set: (t, p, v) => { if (own(p)) items.set(p, String(v)); return true; },
    deleteProperty: (_t, p) => { if (own(p)) items.remove(p); return true; },
    has: (t, p) => (own(p) ? items.get(p) !== undefined : p in t),
    ownKeys: () => items.keys(),
    getOwnPropertyDescriptor: (_t, p) => {
      const v = own(p) ? items.get(p) : undefined;
      return v === undefined ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
    },
  }) as unknown as Storage;
}

/** A request's body as the demo's API takes it: JSON read, a file marked as one. */
async function bodyOf(body: BodyInit | null | undefined): Promise<unknown> {
  if (body == null) return null;
  if (typeof body === "string") {
    try { return JSON.parse(body); } catch { return body; }
  }
  return { file: true };
}

function install(): void {
  (window as { __panelDemo?: boolean }).__panelDemo = true;
  const note = (words: string) => window.dispatchEvent(new CustomEvent(DEMO_NOTE, { detail: words }));

  // Its own store, seeded with its sign-in and its dark look.
  const local = memoryStorage({ "panel.token": DEMO_TOKEN, [MODE_KEY]: "dark" });
  let session: Storage;
  try { session = prefixedStorage(window.sessionStorage); } catch { session = memoryStorage({}); }
  Object.defineProperty(window, "localStorage", { value: local, configurable: true });
  Object.defineProperty(window, "sessionStorage", { value: session, configurable: true });

  // No notifications, and the device's own registration (the real panel's) out of reach.
  delete (window as { PushManager?: unknown }).PushManager;
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      controller: null,
      ready: new Promise(() => {}),
      getRegistration: async () => undefined,
      getRegistrations: async () => [],
      register: async () => { throw new Error("The demo takes no notifications."); },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });

  // The API, answered here. Its records load beside the panel rather than before it.
  const server: Promise<DemoServer> = Promise.all([import("./server.ts"), import("../../test/staff-panel-sample.json")])
    .then(([m, staffPanel]) => m.createDemoServer(staffPanel.default));
  const realFetch = window.fetch.bind(window);
  /** Every address the API answers at: its own, and a server's public ones. */
  const isApi = (url: URL) => url.origin === location.origin && /^\/(?:api(?:\/|$)|(?:s|stats)\/[^/]+\/api\/)/.test(url.pathname);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (!isApi(url)) return realFetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = await bodyOf(init?.body);
    const answer = (await server).answer({ method, url, body });
    // A moment, as an answer over the network takes one: screens show what they show while waiting.
    await new Promise((r) => setTimeout(r, 30));
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const text = answer.raw ?? JSON.stringify(answer.body ?? {});
    return new Response(text, { status: answer.status, headers: { "content-type": answer.type ?? "application/json" } });
  };

  // The live stream, fed by the demo's API.
  class DemoEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readonly url: string;
    readonly withCredentials = false;
    readyState = 0;
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    private stop: (() => void) | null = null;
    constructor(url: string | URL) {
      super();
      this.url = new URL(String(url), location.href).href;
      this.addEventListener("open", (e) => this.onopen?.(e));
      this.addEventListener("message", (e) => this.onmessage?.(e as MessageEvent));
      this.addEventListener("error", (e) => this.onerror?.(e));
      void server.then((s) => {
        if (this.readyState === this.CLOSED) return;
        this.readyState = this.OPEN;
        this.dispatchEvent(new Event("open"));
        this.stop = s.stream(new URL(this.url), (data) => {
          if (this.readyState === this.OPEN) this.dispatchEvent(new MessageEvent("message", { data }));
        });
      });
    }
    close(): void {
      this.readyState = this.CLOSED;
      this.stop?.();
      this.stop = null;
    }
  }
  Object.defineProperty(window, "EventSource", { value: DemoEventSource, configurable: true, writable: true });

  // The panel's other pages would leave the demo, and its API by an address would reach the real
  // one; other sites open as they would anywhere, and a file made in the page (blob:) downloads.
  const leaves = (href: string) => {
    const to = new URL(href, location.href);
    if (to.protocol !== "http:" && to.protocol !== "https:") return false;
    return to.origin === location.origin && to.pathname !== location.pathname && !DEMO_PAGE.test(to.pathname);
  };
  document.addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!a || !leaves((a as HTMLAnchorElement).href)) return;
    e.preventDefault();
    note("That link leads out of the demo.");
  }, true);
  const realOpen = window.open.bind(window);
  window.open = (url?: string | URL, ...rest: [string?, string?]) => {
    if (url !== undefined && leaves(String(url))) { note("That link leads out of the demo."); return null; }
    return realOpen(url, ...rest);
  };
}

if (typeof window !== "undefined" && !(window as { __panelDemo?: boolean }).__panelDemo) install();

export {};
