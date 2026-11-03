/**
 * The two gate invariants the other coverage scans assume but nothing enforced.
 *
 * capability-coverage keeps the capability STRINGS honest and audit-coverage keeps the RECORDS
 * honest — but both start from a route that already has a gate. Nothing failed the build if a
 * route shipped with no gate at all, or if a mutating route asked only for `read`. Both mistakes
 * are silent in exactly the way that matters: the feature works for whoever tests it, and the
 * missing check is only discovered by the person it should have stopped.
 *
 * So, two scans, same shape as the audit one — crude on purpose, with an exemption ledger that
 * forces the next person to say WHY out loud:
 *
 *  1. Every plain `route(...)` block calls `requirePrincipal`, or the route is named in
 *     PUBLIC_ROUTES with the reason it is open to the world. (`serverRoute(...)` declarations are
 *     exempt from this one by construction — the kit gates them internally before the handler runs.)
 *  2. Every POST/PUT/PATCH/DELETE shows a write-level gate — a `serverRoute` declared at "write",
 *     or a `can(...)`/`canAnywhere(...)` asking for "write" (the dynamic-table routes pass the
 *     capability as a variable but the LEVEL is always the literal), or a same-file named predicate
 *     that does one of those — or the route is named in NO_WRITE_CAP_EXPECTED with the reason a
 *     read-level actor may perform it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "routes");

/**
 * Routes that answer without a signed-in principal, and why each one must. Everything here is an
 * entry point BEFORE identity exists (you cannot demand a session from the login form) or a caller
 * that authenticates by other means (a signature, a query-string token).
 */
const PUBLIC_ROUTES: Record<string, string> = {
  'GET "/api/health"': "liveness probe; says 'up' and nothing else",
  'GET "/api/auth/status"': "the login screen asks whether first-run setup is still needed before any session exists",
  'GET "/api/setup/status"': "the same first-run question, plus whether creating the owner takes the setup code — nothing in it helps anyone claim the install",
  'POST "/api/setup/verify"': "the first-run setup code is checked before any account exists; wrong codes share the sign-in throttle",
  'GET "/api/online/tls-ask"': "the HTTPS proxy asks before it fetches a certificate for an address; the answer is only yes or no, and only the panel's own domain and the stats site's address are yes",
  'POST "/api/auth/register"': "first-run creation is open by design; after that the handler itself demands admin.users write",
  'POST "/api/auth/login"': "the way in — there is no principal before it succeeds, and failures are rate-limited",
  'GET "/api/auth/discord/status"': "the login screen asks whether to render the Discord button",
  'GET "/api/auth/discord/start"': "OAuth begins signed out by definition; the state it mints is signed and browser-bound",
  'GET "/api/auth/discord/callback"': "Discord redirects here; the signed, browser-bound state is the credential",
  'POST "/api/discord/interactions"': "Discord's webhook, authenticated by its Ed25519 signature rather than a session",
  'GET "/api/events/stream"': "EventSource cannot send headers, so the handler authenticates itself (cookie or ?token) and gates on server.view before streaming",
  'GET "/s/:serverId/api/:command"':
    "streamer mode — the point IS to answer without a login, so streamers' existing CRCON overlay tools work unchanged. " +
    "Gated instead by: the server's own streamerMode flag (off by default, a 404 when off, indistinguishable from a " +
    "server that does not exist), a fixed whitelist of the eight endpoint names CRCON itself publishes, read-only " +
    "handlers, and CRCON's per-IP rate budgets. See docs/streamer-mode.md.",
  'GET "/stats/:slug/api/:command"':
    "the same streamer-mode surface on the public stats site's own address (one base URL serves the page and its API) — " +
    "identical gate: publish flag, whitelist, read-only handlers, per-IP budgets. See docs/public-stats.md.",
  'GET "/api/public/servers"':
    "the public stats page's manifest: which servers are PUBLISHED, their slugs/names and how to read them (descriptor " +
    "side labels + score columns). Serves only servers with streamerMode on and a slug set — an unpublished server does " +
    "not exist here — and is per-IP rate limited like the rest of the public surface.",
  'GET "/api/public/webmanifest"':
    "the public stats site's web app manifest, what a phone reads when a player saves the stats page to the home " +
    "screen: start and scope (the public hostname's root, or /stats on the panel's host), name and orientation. " +
    "Static facts and the configured community name only; no server, player or match data.",
  'GET "/api/public/:slug/report/:id"':
    "the public stats page's round report (awards, flow, duels, per-player timelines) — the charts layer over the same " +
    "scoreboard the CRCON mounts already publish, derived from the same kill stream and re-keyed to display names so no " +
    "internal id crosses the wire. Same gate as those mounts: published servers only, uniform 404, per-IP rate limited.",
  'GET "/api/public/:slug/log/:id"':
    "the public stats page's game log for one round (start and end, kills, team kills, connects, disconnects, team " +
    "switches) — read from the same event store the report folds, names only and never chat, so no id and no player's " +
    "words cross the wire. Same gate as the report: published servers only, uniform 404, per-IP rate limited.",
  'GET "/api/public/:slug/player/:platformId"':
    "a player's public career on one PUBLISHED server, addressed by platform id and answering only where the " +
    "publicPlayerIds toggle is on — a server that withholds ids has no public address for a person, and a player who " +
    "never played that server is the same uniform 404 so the route cannot probe the player directory. Per-IP rate " +
    "limited; echoes the platform id from the URL and never an internal id.",
  'GET "/api/public/:slug/stats"':
    "the public stats page's server profile: map win rates, match-quality splits, activity, single-round records and " +
    "regulars, all from the matches table and career rollups this site already publishes round by round — names only, " +
    "never an id. Same gate as the rest of the public surface: published servers only, uniform 404, per-IP rate limited, " +
    "plus an in-process cache so anonymous traffic cannot make it a table walk per visitor.",
};

/**
 * Mutating routes a read-level (or no-level) actor may hit, and why. Three kinds only: the
 * unauthenticated entry points above; the signed-in user writing to their OWN account or view
 * state (which no capability governs); and a read wearing a POST because its input needs a body.
 */
const NO_WRITE_CAP_EXPECTED: Record<string, string> = {
  // --- Approvals: gated per LINE by approvalRefusal, which demands write on the line's own
  //     capability on its own server AND refuses the requester — a plain can() at the top of the
  //     route cannot know the line yet, and one request may mix capabilities per line ---
  'POST "/api/requests/:id/lines/:lineId/approve"': "approvalRefusal: write on the line's capability/server, never the requester",
  'POST "/api/requests/:id/lines/:lineId/deny"': "approvalRefusal, same as approve — denying is exercising the same authority",
  'POST "/api/requests/:id/approve-all"': "approvalRefusal per line inside approveLine; lines outside this signer's write are skipped, not signed",
  'POST "/api/requests/:id/withdraw"': "requester-identity gate: only the user who FILED the request may pull it back — no capability names one person",
  'POST "/api/requests/draft"': "creates the user's OWN empty scratch draft; adding a line to it goes through the action routes, which run their own gates per capability",
  'POST "/api/requests/draft/park"': "parks the user's OWN draft (the store matches on requester id + draft status) — Save draft narrows access, never widens it",
  'POST "/api/requests/draft/submit"': "gates per LINE inside executesAsOwn: lines the user holds at write (within their caps) execute, every other line is FILED for a signature — nothing executes without the write",
  'DELETE "/api/requests/draft"': "throws away the user's OWN unfiled scratch — nothing was ever executed, nothing else is touched",
  'DELETE "/api/requests/draft/lines/:lineId"': "removes a line from the user's OWN draft (the store checks ownership + draft status) — reviewing means being able to drop a row",

  // --- Server lifecycle stages 2-3: gated by IDENTITY, deliberately not by capability ---
  //     Whoever holds decommission holds the road to the final delete, and capabilities can be
  //     handed out — so these ask WHO you are: the install's first created login (the setup
  //     account), refused for everyone else whatever grants they carry.
  'POST "/api/servers/:id/decommission"': "setup-account identity gate (users.firstUserId): stage 2 belongs to the install's first login alone — a grant must never hold this key",
  'POST "/api/servers/:id/recommission"': "setup-account identity gate, same as decommission — undoing stage 2 is exercising the same key",
  'DELETE "/api/servers/:id"': "setup-account identity gate: the final delete answers to who you are, not what you hold, and requires stage 2 first — which only the same account could have taken",

  // --- Entry points: gated above, not by capability ---
  'POST "/api/auth/login"': "signing in needs no capability; it is how you come to hold any",
  'POST "/api/setup/verify"': "checks the first-run setup code before any account exists — nothing changes, and there is no session to hold a capability",
  'POST "/api/discord/interactions"': "no session to hold a capability — each press is gated inside (staffGuildAccess plus the module's own capability check)",

  // --- Your own account, your own view state ---
  'PUT "/api/me/password"': "your own credential — the gate is proving the CURRENT password, throttled by the login budget; a capability would let an admin role change it without knowing it, which is the reset route's job",
  'PUT "/api/me/prefs"': "your own theme, density and landing view",
  'PUT "/api/me/push"': "turns on phone notifications for the caller's own device — what each notification may say is decided when it is sent, against the reader's grants then",
  'POST "/api/me/push/off"': "turns off one of the caller's own devices — the repo row must carry p.user.id",
  'POST "/api/me/push/test"': "a test notification to one of the caller's own devices, nothing else",
  'POST "/api/me/announcements-seen"': "dismisses your own unread badge",
  'DELETE "/api/tokens/:id"': "removal is scoped to your own tokens — the repo call carries p.user.id",
  'DELETE "/api/layout/:surface"': "removal is scoped to your own layout row — the repo call carries p.user.id; the shared instance default is untouched",
  'POST "/api/community/announcements/read"': "marks notices read for yourself",
  'POST "/api/community/announcements/:id/ack"': "acknowledges a notice you were shown",

  // --- A plugin's own routes ---
  'POST "/api/plugins/:id/*rest"': "the host signs the caller in; the plugin's handler asks its own permissions (viewer.holds) at the level it means",
  'PUT "/api/plugins/:id/*rest"': "the host signs the caller in; the plugin's handler asks its own permissions (viewer.holds) at the level it means",
  'DELETE "/api/plugins/:id/*rest"': "the host signs the caller in; the plugin's handler asks its own permissions (viewer.holds) at the level it means",

  // --- Reads wearing a POST ---
  'POST "/api/servers/:id/maps/poll/preview"': "renders a sample ballot from a body too big for a query string; nothing is written, so it is declared at read",
  'POST "/api/data/counts"': "counts rows an export would carry (a group list in the body); nothing is written — export, upload and import all gate at write",
  'POST "/api/trim/preview"': "counts rows a trim would remove (categories and a cutoff in the body); nothing is written — whoever can see Data trim sees the counts, and the trim itself gates at write",
  'POST "/api/payouts/preview"': "resolves who a payout WOULD reach from a body too big for a query string; nothing is written, and running one gates at write",
};

interface RouteDecl {
  key: string;
  method: string;
  file: string;
  /** declared via serverRoute (kit gates it internally) rather than plain route */
  server: boolean;
  /** serverRoute's declared level, when the declaration line carries one */
  level: string | null;
  body: string;
}

/**
 * Walk each route file and pair every declaration with the body up to the next one. The same crude
 * line scan as audit-coverage, and for the same reason: a gate a scan cannot see from the route's
 * own block is a gate the next reader cannot see either. serverRoute declarations are expected to
 * carry their capability and level on the declaration line — every one does, and one that wraps
 * will be flagged here, which is the correct outcome for a declaration the scan cannot read.
 */
function allRoutes(): RouteDecl[] {
  const decl = /^\s*(server)?[Rr]oute\(\s*"(GET|POST|PUT|PATCH|DELETE)"\s*,\s*"([^"]+)"(?:\s*,\s*"[\w.*-]+"\s*,\s*"(read|write)")?/;
  const out: RouteDecl[] = [];
  for (const file of readdirSync(ROUTES_DIR)) {
    if (!file.endsWith(".ts") || file === "kit.ts") continue;
    let current: RouteDecl | null = null;
    const lines: string[] = [];
    const close = () => {
      if (current) out.push({ ...current, body: lines.join("\n") });
      lines.length = 0;
    };
    for (const line of readFileSync(join(ROUTES_DIR, file), "utf8").split("\n")) {
      const m = decl.exec(line);
      if (m) {
        close();
        current = { key: `${m[2]} "${m[3]}"`, method: m[2]!, file, server: Boolean(m[1]), level: m[4] ?? null, body: "" };
      } else if (current) {
        lines.push(line);
      }
    }
    close();
  }
  return out;
}

// ---- invariant 1: no route answers strangers unless it says so ----

test("every plain route requires a principal, or is declared public with a reason", () => {
  const open = allRoutes()
    .filter((r) => !r.server && !r.body.includes("requirePrincipal") && !(r.key in PUBLIC_ROUTES))
    .map((r) => `${r.key} (${r.file})`);
  assert.deepEqual(open, [],
    "these routes answer without any sign-in. Call requirePrincipal, or name the route in PUBLIC_ROUTES with the reason it is open:\n" + open.join("\n"));
});

test("the public-routes ledger does not outlive the routes it excuses", () => {
  // Stale means EITHER the route is gone OR it has since gained a requirePrincipal — an excuse
  // must die with the reason for it, or it silently exempts the next route that reuses the path.
  const openNow = new Set(allRoutes().filter((r) => !r.server && !r.body.includes("requirePrincipal")).map((r) => r.key));
  const stale = Object.keys(PUBLIC_ROUTES).filter((k) => !openNow.has(k));
  assert.deepEqual(stale, [], "PUBLIC_ROUTES names routes that are no longer open: " + stale.join(", "));
});

// ---- invariant 2: changing something demands the capability at write ----

/**
 * Some gates are a NAMED PREDICATE rather than an inline `can(...)` — a route that accepts either
 * of two capabilities reads better as `if (!canWriteEvents(p.grants))` than as the disjunction
 * spelled out at four call sites. The scan has to be able to follow one hop, or the tidier spelling
 * of a gate silently reads as no gate at all, which is precisely backwards.
 *
 * One hop, same file, and the helper's own body is what gets read — so a predicate that only ever
 * asks for "read" still fails a mutating route, which is the case this invariant exists for.
 */
function localPredicates(file: string): Map<string, string> {
  const src = readFileSync(join(ROUTES_DIR, file), "utf8");
  const out = new Map<string, string>();
  for (const m of src.matchAll(/function\s+(\w+)\s*\([^)]*\)\s*:\s*boolean\s*\{([\s\S]*?)\n\}/g)) {
    out.set(m[1]!, m[2]!);
  }
  return out;
}

/** A write-level ask: `can`, `canAnywhere`, or `holdsOutright` (global, own grants only) at "write". */
const WRITE_GATE = /(?:can(?:Anywhere)?|holdsOutright)\([^)]*"write"/;

/** Does this route ask for write level — inline, or through a same-file predicate it calls? */
function gatesAtWrite(r: RouteDecl, predicates: Map<string, string>): boolean {
  if (WRITE_GATE.test(r.body)) return true;
  for (const [name, body] of predicates) {
    if (r.body.includes(`${name}(`) && WRITE_GATE.test(body)) return true;
  }
  return false;
}

test("every mutating route gates at write level, or says why read may perform it", () => {
  const byFile = new Map<string, Map<string, string>>();
  const soft = allRoutes()
    .filter((r) => r.method !== "GET")
    .filter((r) => !(r.server && r.level === "write"))
    .filter((r) => {
      let preds = byFile.get(r.file);
      if (!preds) { preds = localPredicates(r.file); byFile.set(r.file, preds); }
      return !gatesAtWrite(r, preds);
    })
    .filter((r) => !(r.key in NO_WRITE_CAP_EXPECTED))
    .map((r) => `${r.key} (${r.file})`);
  assert.deepEqual(soft, [],
    "these change something but never ask for write-level permission — a read-only role could perform them. Gate at \"write\", or name the route in NO_WRITE_CAP_EXPECTED with the reason:\n" + soft.join("\n"));
});

test("the write-exemption ledger does not outlive the routes it excuses", () => {
  const byFile = new Map<string, Map<string, string>>();
  const softNow = new Set(
    allRoutes()
      .filter((r) => r.method !== "GET")
      .filter((r) => !(r.server && r.level === "write"))
      .filter((r) => {
        let preds = byFile.get(r.file);
        if (!preds) { preds = localPredicates(r.file); byFile.set(r.file, preds); }
        return !gatesAtWrite(r, preds);
      })
      .map((r) => r.key),
  );
  const stale = Object.keys(NO_WRITE_CAP_EXPECTED).filter((k) => !softNow.has(k));
  assert.deepEqual(stale, [], "NO_WRITE_CAP_EXPECTED names routes that now gate at write (or are gone): " + stale.join(", "));
});

// ---- invariant 3: a scoped capability is authority over ONE server, not the community ----

/**
 * Routes that write while gating only with `canAnywhere` on a SCOPED capability, and why each is
 * community-wide anyway. The pattern is always the same: the record is a shared library entry, and
 * pointing a server at it happens in that server's own gated route.
 *
 * Anything not on this list must narrow to the server it acts on — `can(grants, cap, "write",
 * { serverId })` — because a scoped grant means "on this server" and nothing more. Two routes
 * shipped without that narrowing (a ban seed that read every server in the community, and a
 * template that copied any server's settings), which is what this scan exists to catch.
 */
const COMMUNITY_WIDE_BY_DESIGN: Record<string, string> = {
  'DELETE "/api/autosettings/templates/:templateId"': "a shared template, not a server: applying one to a server is that server's own gated route",
  'POST "/api/mapvote/sets"': "the map-set library is community-wide; a set only reaches a server when that server's own gated config links it",
  'PUT "/api/mapvote/sets/:id"': "same library record — and a relabel that would break a server pointing at it is refused by serversUsing",
  'DELETE "/api/mapvote/sets/:id"': "same library record; deletion is refused outright while any server still points at it",
  'POST "/api/mapvote/schedules"': "the schedule library is community-wide; a schedule fires on a server only once that server's config links it",
  'PUT "/api/mapvote/schedules/:id"': "same library record",
  'DELETE "/api/mapvote/schedules/:id"': "same library record; refused while a server still points at it",
  'POST "/api/mapvote/versions/:id/restore"': "puts a library set or schedule back as an earlier save had it — the same community-wide records as the edits above, through the same edit path (a game change a server would break on is still refused)",
};

/** Capability key → is it declared server-scoped in the catalog? */
function scopedCapabilities(): Map<string, boolean> {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "access", "src", "capabilities.ts"), "utf8");
  const out = new Map<string, boolean>();
  for (const m of src.matchAll(/key:\s*"([\w.*-]+)"[^}]*?scoped:\s*(true|false)/g)) out.set(m[1]!, m[2] === "true");
  return out;
}

/** Which scoped capabilities does this route check only community-wide? */
function anywhereOnlyScoped(r: RouteDecl, scoped: Map<string, boolean>): string[] {
  const out: string[] = [];
  for (const m of r.body.matchAll(/canAnywhere\(\s*p\.grants,\s*"([\w.*-]+)",\s*"write"/g)) {
    const cap = m[1]!;
    if (scoped.get(cap) !== true) continue;
    // A per-server check on the SAME capability means the anywhere call was only a cheap pre-filter.
    if (new RegExp(`can\\(\\s*p\\.grants,\\s*"${cap.replace(/\./g, "\\.")}"`).test(r.body)) continue;
    out.push(cap);
  }
  return out;
}

test("a scoped capability is never the whole community's, unless the route says why", () => {
  const scoped = scopedCapabilities();
  assert.ok([...scoped.values()].filter(Boolean).length > 10, "the capability catalog must actually be readable");
  const wide = allRoutes()
    .filter((r) => r.method !== "GET" && !(r.key in COMMUNITY_WIDE_BY_DESIGN))
    .flatMap((r) => anywhereOnlyScoped(r, scoped).map((cap) => `${r.key} (${r.file}) — ${cap} is scoped`));
  assert.deepEqual(wide, [],
    "these write using a SERVER-SCOPED capability but only ask whether the account holds it somewhere. "
    + "Narrow to the server being acted on with can(..., { serverId }), or name the route in "
    + "COMMUNITY_WIDE_BY_DESIGN with the reason it is not one server's:\n" + wide.join("\n"));
});

test("the community-wide ledger does not outlive the routes it excuses", () => {
  const scoped = scopedCapabilities();
  const wideNow = new Set(allRoutes().filter((r) => anywhereOnlyScoped(r, scoped).length > 0).map((r) => r.key));
  const stale = Object.keys(COMMUNITY_WIDE_BY_DESIGN).filter((k) => !wideNow.has(k));
  assert.deepEqual(stale, [], "COMMUNITY_WIDE_BY_DESIGN names routes that now narrow by server (or are gone): " + stale.join(", "));
});
