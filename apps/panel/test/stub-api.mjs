// Test fixture: serves the REAL built panel (out/) plus a stubbed /api, so browser tests
// exercise the actual shipped bundle against controlled data. `overrides` lets a test force
// specific responses (e.g. a 403 with a `missing` permission payload).
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HLL_DESCRIPTOR, OWNER_GRANTS, stageAnswers, withSetupSeen } from "./stage-answers.mjs";

export { HLL_DESCRIPTOR, OWNER_GRANTS };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2", ".png": "image/png", ".webp": "image/webp" };

/** The staff command's screens for Help's Discord walkthrough, drawn by the bot's own code
 *  (apps/api's discord-preview) over the walkthrough stage's records: its two servers, Alice and
 *  Bob, Points, and a map vote open on Server #1. test/walkthroughs.test.mjs holds every button in
 *  it to the bot's own buttons. */
export const STAFF_PANEL = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "staff-panel-sample.json"), "utf8"));

/** Start the stub. Returns { base, close, requests } — `requests` records every /api path hit. */
export async function startStub({ grants = OWNER_GRANTS, overrides = {} } = {}) {
  // A malformed override used to be the WORST kind of test bug: a fixture object written without
  // the { body } wrapper served `{}` with a 200 (`forced.body ?? {}`), and the test then failed
  // somewhere else entirely — a screen quietly rendering its empty state, a locator timing out on
  // a panel that never drew. Refuse it here, at startup, naming the path. Functions are exempt
  // (they resolve per request and may legitimately answer undefined to fall through).
  for (const [path, entry] of Object.entries(overrides)) {
    if (typeof entry === "function" || entry == null) continue;
    if (entry.body === undefined && entry.status === undefined && entry.raw === undefined) {
      throw new Error(`stub override for ${path} has no body, raw or status — wrap the fixture: { body: {...} }`);
    }
  }
  const api = stageAnswers(grants, STAFF_PANEL);
  const requests = [];
  const calls = []; // like `requests`, with the method, parsed body and previewed role — for asserting writes
  // What no override or fixture answered: each gets {} — see unansweredReads, in test/coverage-kit.
  const unanswered = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    // The public stats page's data lives on two mounts: /api/public/* and the CRCON-shaped
    // /stats/<slug>/api/* commands. Both are stubbed the same way, keyed by full path.
    if (p.startsWith("/api") || /^\/stats\/[^/]+\/api\//.test(p)) {
      requests.push(p);
      let reqBody = null;
      if (req.method !== "GET" && req.method !== "HEAD") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        try { reqBody = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ }
      }
      // `preview`: the role a "View as" read named — its header, or the live stream's address.
      calls.push({ method: req.method, path: p, body: reqBody, preview: req.headers["x-preview-role"] ?? url.searchParams.get("previewRole") ?? null });
      if (p === "/api/events/stream") {
        // A stream override answers instead of the stream — a refusal, say — or falls through to it.
        const refusal = typeof overrides[p] === "function" ? overrides[p](url) : overrides[p];
        if (refusal) {
          res.writeHead(refusal.status ?? 200, { "content-type": "application/json" });
          res.end(JSON.stringify(refusal.body ?? {}));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        res.write(": open\n\n");
        return; // held open; closed with the server
      }
      // An override may be a function of the request URL (and the request), not just a fixed body.
      // Matching on the pathname alone could not express "this filter is slow and that one is fast",
      // which is the only way to actually race two responses for the same screen.
      const entry = overrides[p];
      const forced = typeof entry === "function" ? entry(url, req) : entry;
      if (forced) {
        // `delayMs` lets a test make one response deliberately slow, so it can check that an
        // outrun request never paints over a newer one.
        if (forced.delayMs) await new Promise((r) => setTimeout(r, forced.delayMs));
        // `raw` is the reply's exact text, for a test about bytes JSON.stringify would rewrite, or a
        // reply that is not JSON at all (a picture), with its `type`.
        res.writeHead(forced.status ?? 200, { "content-type": forced.type ?? "application/json" });
        res.end(typeof forced.raw === "string" ? forced.raw : JSON.stringify(withSetupSeen(p, forced.body ?? {})));
        return;
      }
      const fixture = api[p];
      if (fixture === undefined && !/\/descriptor$/.test(p)) unanswered.push(`${req.method} ${p}`);
      const body = (typeof fixture === "function" ? fixture(url) : fixture) ?? (/\/descriptor$/.test(p) ? { descriptor: HLL_DESCRIPTOR } : {});
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(withSetupSeen(p, body)));
      return;
    }
    // static panel with SPA fallback
    let file = join(ROOT, p === "/" ? "index.html" : p.replace(/\/$/, "/index.html"));
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      // Mirror the API's static handler: /stats/* deep links get the public stats entry, never
      // the panel's sign-in shell — browser tests open the public pages through this.
      const fallback = p === "/stats" || p.startsWith("/stats/") ? join(ROOT, "stats", "index.html") : join(ROOT, "index.html");
      const data = await readFile(fallback).catch(() => readFile(join(ROOT, "index.html")));
      res.writeHead(200, { "content-type": "text/html" });
      res.end(data);
    }
  });
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, requests, calls, unanswered, close: () => new Promise((r) => server.close(r)) };
}
