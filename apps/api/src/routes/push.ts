/**
 * Settings → Phone notifications: turning them on and off for a device, and the test button.
 *
 * Your own devices, so no capability, like your own preferences: what each notification may say is
 * decided when it is sent (phone-alerts.ts), against what the panel would show you then. A device
 * is identified by the address its push service gave its browser (the subscription's endpoint) —
 * the browser keeps it, so turning one off, or testing it, names that address.
 */
import { readJsonBody, sendError, sendJson, str } from "../http.js";
import { validKeys, vapidKeys } from "../web-push.js";
import { requirePrincipal, route, type Route } from "./kit.js";

/**
 * The push services browsers come with — Apple's, Google's (Chrome, Edge on Android, Samsung
 * Internet, Opera), Mozilla's and Microsoft's. The API posts to a subscription's address, so an
 * address anywhere else is refused rather than letting a signed-in account point the API at a
 * machine on its own network. `PUSH_TEST_ORIGIN` is the test suites' stand-in push service.
 */
const PUSH_SERVICES = ["push.apple.com", "googleapis.com", "push.services.mozilla.com", "notify.windows.com"];
function pushServiceAddress(endpoint: string): boolean {
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  if (process.env.PUSH_TEST_ORIGIN && u.origin === process.env.PUSH_TEST_ORIGIN) return true;
  return u.protocol === "https:" && PUSH_SERVICES.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
}

/** Where the panel was open, as the browser said: the contact a push names (web-push.ts). */
function panelOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

export const pushRoutes: Route[] = [
  /** The install's public key (what a browser subscribes with) and which of your devices are on. */
  route("GET", "/api/me/push", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const devices = (await ctx.repo.pushSubscriptions.listByUser(p.user.id)).filter((d) => d.epoch === p.user.sessionEpoch);
    sendJson(res, 200, {
      key: (await vapidKeys(ctx.repo)).publicKey,
      devices: devices.map((d) => ({ endpoint: d.endpoint, device: d.device, createdAt: d.createdAt })),
    });
  }),

  /** Turn a device on (or keep it on: the panel says so again each time it opens, lib/push). */
  route("PUT", "/api/me/push", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const body = await readJsonBody(req);
    const endpoint = str(body.endpoint);
    const keys = (body.keys ?? {}) as Record<string, unknown>;
    const p256dh = str(keys.p256dh), auth = str(keys.auth);
    if (!endpoint || endpoint.length > 2_000 || !pushServiceAddress(endpoint)) return sendError(res, 400, "this browser's notification service is not one the panel can send to");
    if (!validKeys(p256dh, auth)) return sendError(res, 400, "the browser's notification keys could not be read");
    const origin = panelOrigin(str(body.origin));
    if (!origin) return sendError(res, 400, "origin: the panel's own address");
    // A shared computer: whoever turned it on last is who it notifies.
    await ctx.repo.pushSubscriptions.upsert({
      endpoint, userId: p.user.id, p256dh, auth, origin, epoch: p.user.sessionEpoch,
      device: str(body.device).slice(0, 60),
    });
    sendJson(res, 200, { ok: true });
  }),

  /** Turn a device off — in Settings, and when someone signs out on it. */
  route("POST", "/api/me/push/off", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const endpoint = str((await readJsonBody(req)).endpoint);
    const row = endpoint ? await ctx.repo.pushSubscriptions.get(endpoint) : null;
    if (row && row.userId === p.user.id) await ctx.repo.pushSubscriptions.remove(endpoint);
    sendJson(res, 200, { ok: true });
  }),

  /** "Send a test": one notification to this device, now. */
  route("POST", "/api/me/push/test", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const endpoint = str((await readJsonBody(req)).endpoint);
    const row = endpoint ? await ctx.repo.pushSubscriptions.get(endpoint) : null;
    if (!row || row.userId !== p.user.id || row.epoch !== p.user.sessionEpoch) return sendError(res, 404, "notifications are not on for this device");
    const out = await ctx.phoneAlerts.test(row);
    if (!out.ok) return sendError(res, 502, out.error);
    sendJson(res, 200, { ok: true });
  }),
];
