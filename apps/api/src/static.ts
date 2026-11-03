import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import { acceptedEncoding, compress, COMPRESS_FROM, sendFile, type Encoding } from "./http.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  // The panel's web app manifest (app/manifest.ts): a phone reads it when the panel is added to
  // its home screen — named for what it is, not handed over as an anonymous download.
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** Serve the exported panel (Next.js static export). SPA-style: unknown paths fall back to
 *  index.html; real files (incl. nested routes like /community/ and /_next/… assets) are served
 *  directly. /stats/* falls back to the PUBLIC page's own entry instead — /stats/<slug>/games is
 *  a route of the stats app, and handing it the panel's login shell would show a sign-in box to
 *  someone who followed a public link. */
export async function serveStatic(req: IncomingMessage, res: ServerResponse, webRoot: string | null, path: string): Promise<void> {
  if (!webRoot) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("web panel not configured (set WEB_ROOT)");
    return;
  }
  const rel = staticRel(path);
  let file = join(webRoot, rel || "index.html");
  try {
    const s = await stat(file);
    if (s.isDirectory()) file = join(file, "index.html");
    await stat(file);
  } catch {
    // Deep links into the stats app get the stats entry; a build without one (older export)
    // falls through to the panel shell rather than 404ing.
    if (rel === "stats" || rel.startsWith("stats/")) {
      const statsEntry = join(webRoot, "stats", "index.html");
      file = await stat(statsEntry).then(() => statsEntry).catch(() => join(webRoot, "index.html"));
    } else {
      file = join(webRoot, "index.html"); // SPA fallback
    }
  }
  const headers = {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": cachePolicy(rel, file),
  };
  const encoding = PACKED_TYPES.has(extname(file)) ? acceptedEncoding(req) : null;
  const packed = encoding ? await packedFile(file, encoding) : null;
  if (packed) {
    res.writeHead(200, { ...headers, "content-encoding": encoding!, vary: "accept-encoding", "content-length": String(packed.length) });
    res.end(packed);
    return;
  }
  // sendFile owns the failure: the stream opens lazily, so a `try` around it here caught nothing
  // and a missing index.html (a partial export, a WEB_ROOT pointing one directory too high) took
  // the process down on the first page request instead of answering 404.
  sendFile(res, file, headers);
}

/** The file a request's path names, relative to the export, as `serveStatic` looks it up: never a way
 *  out of the export (path traversal), and no leading slash. */
export function staticRel(path: string): string {
  return normalize(path).replace(/^(\.\.[/\\])+/, "").replace(/^\/+/, "");
}

/** The panel's text files (its code, styles and page) go packed; pictures and fonts are packed already. */
const PACKED_TYPES = new Set([".html", ".js", ".css", ".json", ".webmanifest", ".txt", ".svg", ".map"]);
/** Larger than this, a file is streamed as it is rather than read whole to be packed. */
const PACK_UP_TO = 4 * 1024 * 1024;
/** The packed copies, kept in memory only — the panel's text comes to about 1 MB packed. */
const PACKED_KEEP = 32 * 1024 * 1024;
const packedCache = new Map<string, Buffer>();
let packedBytes = 0;
const pack = promisify((body: Buffer, encoding: Encoding, done: (err: Error | null, packed: Buffer) => void) => compress(body, encoding, done));

/**
 * The file packed for `encoding`, packed once and kept — under its size and the time it was written
 * as well as its name, so a new build's files are packed afresh. Null when it is not worth it (too
 * small, too large, unreadable): the file then goes as it is.
 */
async function packedFile(file: string, encoding: Encoding): Promise<Buffer | null> {
  try {
    const s = await stat(file);
    if (s.size < COMPRESS_FROM || s.size > PACK_UP_TO) return null;
    const key = `${encoding}:${s.size}:${s.mtimeMs}:${file}`;
    const kept = packedCache.get(key);
    if (kept) return kept;
    const packed = await pack(await readFile(file), encoding);
    packedCache.set(key, packed);
    packedBytes += packed.length;
    // Oldest first: what an earlier build left behind goes before anything still being asked for.
    for (const [k, v] of packedCache) {
      if (packedBytes <= PACKED_KEEP) break;
      packedCache.delete(k);
      packedBytes -= v.length;
    }
    return packed;
  } catch {
    return null;
  }
}

/**
 * How long a browser may keep each kind of panel file. Before this, no file carried a
 * Cache-Control at all, so browsers cached heuristically — and after an update, index.html (with
 * its references to the OLD content-hashed bundles) could be replayed for ten-plus minutes,
 * serving a stale app against a new API.
 *
 *  - /_next/static/…  bytes never change under a given name (the hash IS the name) → cache forever.
 *  - HTML             the entry points that name those hashes → never reuse without asking.
 *  - everything else  unhashed assets (icons, fonts) → a modest hour; stale is cosmetic here.
 */
function cachePolicy(rel: string, file: string): string {
  if (rel.startsWith("_next/static/")) return "public, max-age=31536000, immutable";
  // The service worker (phone notifications): a browser checks it for updates, and an hour-old
  // copy would keep showing them the old way after an update.
  if (rel === "sw.js") return "no-cache";
  if (extname(file) === ".html") return "no-cache";
  return "public, max-age=3600";
}
