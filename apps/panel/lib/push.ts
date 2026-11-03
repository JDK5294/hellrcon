"use client";
/**
 * Phone notifications on THIS device — the browser's half (Settings → Phone notifications).
 *
 * A device is on when its browser holds a push subscription made with the install's key and the
 * API has it (apps/api routes/push.ts). Turning on asks the browser's permission — only ever from a
 * tap, the one time browsers allow asking — registers the service worker that shows them
 * (public/sw.js), subscribes, and hands the subscription over. Every time the panel opens it says
 * so again (syncPush): a browser renews its subscription when it likes, and a password change
 * starts a new sign-in the API checks each device against.
 *
 * Who turned it on is remembered with it. A shared computer never starts notifying the next person
 * who signs in there — their notifications are theirs to turn on — and signing out turns it off.
 */
import { api } from "./api";

export type PushState =
  | "unsupported"  // no notifications in this browser
  | "insecure"     // the panel was opened on a plain http:// address
  | "home-screen"  // an iPhone or iPad: only the panel added to the Home Screen may have them
  | "blocked"      // the person, or the browser, said no
  | "off"
  | "on";

const OWNER_KEY = "panel.push.owner";

/** The account signed in here, from boot (syncPush) — who a device is turned on for. */
let owner = "";

function appleTouch(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function fromHomeScreen(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** What stands in the way on this device, before anything is asked — or null when nothing does. */
export function pushBlocker(): "unsupported" | "insecure" | "home-screen" | null {
  if (typeof window === "undefined") return "unsupported";
  if (!window.isSecureContext) return "insecure";
  if (appleTouch() && !fromHomeScreen()) return "home-screen";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  return null;
}

/** What the person would call this device in a list of theirs. */
function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  if (/Windows/.test(ua)) return "Windows computer";
  if (/Macintosh/.test(ua)) return "Mac";
  return "Computer";
}

const keyBytes = (b64url: string): Uint8Array => {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

/** Was this subscription made with the install's current key? A restored or moved install has a new one. */
function madeWith(sub: PushSubscription, key: string): boolean {
  const given = sub.options?.applicationServerKey;
  if (!given) return true;
  const want = keyBytes(key);
  const have = new Uint8Array(given);
  return have.length === want.length && have.every((b, i) => b === want[i]);
}

async function current(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

async function subscribe(key: string): Promise<PushSubscription> {
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && !madeWith(sub, key)) { await sub.unsubscribe(); sub = null; }
  return sub ?? reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) as BufferSource });
}

async function hand(sub: PushSubscription): Promise<void> {
  const json = sub.toJSON();
  await api("/me/push", { method: "PUT", body: { endpoint: json.endpoint, keys: json.keys, origin: location.origin, device: deviceName() } });
}

/** Is this device on, for the person signed in? */
export async function pushState(): Promise<PushState> {
  const blocker = pushBlocker();
  if (blocker) return blocker;
  if (Notification.permission === "denied") return "blocked";
  const sub = await current().catch(() => null);
  return sub && Notification.permission === "granted" && readOwner() === owner ? "on" : "off";
}

function readOwner(): string {
  try { return localStorage.getItem(OWNER_KEY) ?? ""; } catch { return ""; }
}

/** Turn this device on — from a tap. Throws what to tell the person when it can't. */
export async function turnOnPush(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(permission === "denied"
      ? "Notifications are blocked for the panel. Allow them in this browser's or phone's settings, then try again."
      : "Notifications weren't allowed. Tap the switch again and choose Allow.");
  }
  const { key } = await api<{ key: string }>("/me/push");
  await hand(await subscribe(key));
  try { localStorage.setItem(OWNER_KEY, owner); } catch { /* remembered for this visit only */ }
}

/** Turn this device off — from Settings, and on signing out. */
export async function turnOffPush(): Promise<void> {
  const sub = await current().catch(() => null);
  if (sub) {
    await api("/me/push/off", { method: "POST", body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe().catch(() => false);
  }
  try { localStorage.removeItem(OWNER_KEY); } catch { /* nothing remembered */ }
}

/** Signing out: this device stops taking notifications first, while the sign-in can still say so.
 *  A server that does not answer in a few seconds is not waited for — the sign-out is. */
export async function signOutPush(): Promise<void> {
  await Promise.race([turnOffPush().catch(() => {}), new Promise((r) => setTimeout(r, 3_000))]);
}

/** "Send a test" — to this device. */
export async function testPush(): Promise<void> {
  const sub = await current();
  if (!sub) throw new Error("Notifications aren't on for this device.");
  await api("/me/push/test", { method: "POST", body: { endpoint: sub.endpoint } });
}

/**
 * On every sign-in and open: who is signed in, and — when this device is on for them — say so
 * again, renewed if the install's key changed. A subscription someone else turned on is taken off.
 * A tapped notification's screen arrives from the service worker as a message.
 */
export async function syncPush(userId: string): Promise<void> {
  owner = userId;
  if (pushBlocker()) return;
  navigator.serviceWorker.onmessage = (e: MessageEvent) => {
    const data = e.data as { type?: string; url?: string } | null;
    if (data?.type === "open" && data.url) {
      const to = new URL(data.url, location.origin);
      if (to.origin === location.origin && to.hash) location.hash = to.hash;
    }
  };
  const sub = await current();
  if (!sub) return;
  if (readOwner() !== userId || Notification.permission !== "granted") {
    await sub.unsubscribe().catch(() => false);
    return;
  }
  const { key } = await api<{ key: string }>("/me/push");
  await hand(madeWith(sub, key) ? sub : await subscribe(key));
}
