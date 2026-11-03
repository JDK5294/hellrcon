/**
 * Every staff action has to leave a trace, and nothing enforced that.
 *
 * The trail is the answer to "who did this?" — the question that gets asked when something has
 * already gone wrong, which is exactly when finding out we never recorded it is worst. It went
 * unnoticed for a whole feature: adding a player to a group wrote no entry for months, and the
 * gap was only found because someone went looking for their own team's work and it wasn't there.
 *
 * A scan, not a convention. Each mutating route either writes an audit entry or is named below
 * with the reason it doesn't — so the next person adding a POST has to make that call explicitly
 * rather than by forgetting.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "routes");

/**
 * Mutating routes that legitimately record nothing, and why. Three kinds only:
 *   - it is the SIGNED-IN USER acting on their own account or their own view state, not staff
 *     acting on the community (marking a notice read is not a moderation action);
 *   - it is an unauthenticated entry point, where there is no actor to name;
 *   - the handler audits per ITEM further down rather than once per request, so the scan's
 *     per-route view cannot see it.
 */
const NO_AUDIT_EXPECTED: Record<string, string> = {
  // --- Audited inside a shared helper this scan cannot see into ---
  'POST "/api/requests/:id/lines/:lineId/approve"': "audits request.approve inside the shared approveLine helper, plus the executed action's own player.*/vip.* row",
  'POST "/api/requests/:id/lines/:lineId/deny"': "audits request.deny inside the shared denyLine helper (the Discord relay presses the same code)",
  'POST "/api/requests/:id/approve-all"': "the same approveLine helper as the single-line route — one request.approve row per line signed",
  'POST "/api/requests/draft"': "opens (or resumes) the user's own private scratch draft — the request is audited when SUBMITTED, which is when it first means anything",
  'POST "/api/requests/draft/park"': "Save draft: parks the user's OWN scratch (kept for later, no view elevation) — a private bookmark, not a staff action",
  'DELETE "/api/requests/draft"': "throws away the user's OWN unfiled scratch — nothing was executed, nothing had entered the record",
  'DELETE "/api/requests/draft/lines/:lineId"': "drops a row from the user's OWN unfiled scratch, same as never adding it",
  'POST "/api/servers/:id/maps/next"': "audits map.next inside the shared setNextMapNow core (map-actions.ts — the Discord panel runs the same code)",
  'POST "/api/servers/:id/maps/change"': "audits map.change inside the shared changeMapNow core (map-actions.ts)",
  'POST "/api/servers/:id/maps/objectives"': "audits map.objectives inside the shared applyObjectives core (map-actions.ts)",
  'POST "/api/servers/:id/maps/objectives/clear"': "audits map.objectives inside the shared clearStoredLayout core (map-actions.ts)",

  // --- Your own session, your own account, your own view state ---
  'POST "/api/auth/login"': "signing in is not a staff action; failed attempts are rate-limited elsewhere",
  'POST "/api/auth/register"': "first-run account creation, before there is anyone to attribute it to",
  'POST "/api/setup/verify"': "checks the first-run setup code before any account exists — there is no actor, nothing changes, and wrong codes are throttled and logged",
  'POST "/api/setup/finish"': "ends the owner's own first-run walk-through — a step of their own setup screens; the settings it walked them through audit themselves",
  'PUT "/api/me/prefs"': "your own theme, density and landing view",
  'PUT "/api/me/push"': "your own phone notifications on a device of yours — a personal setting, like the theme",
  'POST "/api/me/push/off"': "your own phone notifications off on a device of yours",
  'POST "/api/me/push/test"': "a test notification to your own device; nothing changes",
  'POST "/api/me/announcements-seen"': "dismisses your own unread badge",
  'POST "/api/community/announcements/read"': "marking notices read for yourself — reading a board is not moderating it",
  'POST "/api/community/announcements/:id/ack"': "acknowledging a notice you were shown",
  'DELETE "/api/layout/:surface"': "forgets your OWN saved arrangement only (the row keyed by p.user.id); the shared instance default is only ever replaced via PUT, which audits",

  // --- Reads wearing a POST, because they take a body ---
  'POST "/api/trim/preview"': "counts what a trim WOULD delete and changes nothing; the trim itself is audited",
  'POST "/api/data/counts"': "counts what an export WOULD carry and changes nothing; export, upload and import are each audited",
  'POST "/api/servers/:id/maps/poll/preview"': "renders a sample ballot; nothing is written and no poll is started",
  'POST "/api/servers/:id/discord/test"': "posts a 'can you hear me' line to a channel to prove the webhook works",
  'POST "/api/setup/test-server"': "tries a game server's address and RCON password and saves nothing; adding the server is audited",
  'POST "/api/payouts/preview"': "resolves who a payout WOULD reach and changes nothing; the run itself is audited",
  'POST "/api/payouts"': "the run is a background job — the audit row is written by the job driver (payouts.ts runJob) when the run finishes, with the real counts, which this per-route scan cannot see",

  // --- Owner-private by design ---

  // --- A plugin's own routes ---
  'POST "/api/plugins/:id/*rest"': "a plugin records its staff actions itself, through the host's audit capability (filed as <plugin id>.<action>), which this per-route scan cannot see",
  'PUT "/api/plugins/:id/*rest"': "a plugin records its staff actions itself, through the host's audit capability (filed as <plugin id>.<action>), which this per-route scan cannot see",
  'DELETE "/api/plugins/:id/*rest"': "a plugin records its staff actions itself, through the host's audit capability (filed as <plugin id>.<action>), which this per-route scan cannot see",

  // --- No panel actor to name ---
  'POST "/api/discord/interactions"': "Discord's own signed webhook, carrying every kind of press at once. The staff panel's presses are recorded by the HOST (handleInteraction's recordPanelUse, tested in discord-modules.test.ts) rather than by this route, and public presses write their own domain rows — a claim to the ledger, a purchase to vip.grant",
};

interface RouteHit { key: string; file: string; audited: boolean }

/**
 * Walk each route file and pair every mutating route declaration with whether an `audit.create`
 * appears before the next declaration. Crude on purpose: the point is to notice a route with no
 * entry anywhere near it, and a handler that audits somewhere unexpected still has to say so.
 */
function mutatingRoutes(): RouteHit[] {
  const decl = /^\s*(?:server)?[Rr]oute\(\s*"(POST|PUT|PATCH|DELETE)"\s*,\s*"([^"]+)"/;
  const out: RouteHit[] = [];
  for (const file of readdirSync(ROUTES_DIR)) {
    if (!file.endsWith(".ts") || file === "kit.ts") continue;
    let current: RouteHit | null = null;
    for (const line of readFileSync(join(ROUTES_DIR, file), "utf8").split("\n")) {
      const m = decl.exec(line);
      if (m) {
        if (current) out.push(current);
        current = { key: `${m[1]} "${m[2]}"`, file, audited: false };
      } else if (current && line.includes("audit.create")) {
        current.audited = true;
      }
    }
    if (current) out.push(current);
  }
  return out;
}

test("every mutating route records a staff action, or says why it does not", () => {
  const silent = mutatingRoutes()
    .filter((r) => !r.audited && !(r.key in NO_AUDIT_EXPECTED))
    .map((r) => `${r.key} (${r.file})`);
  assert.deepEqual(silent, [],
    "these change something and leave no trace of who did it. Add an audit.create, or list the route in NO_AUDIT_EXPECTED with the reason:\n" + silent.join("\n"));
});

test("the exemption list does not outlive the routes it excuses", () => {
  const live = new Set(mutatingRoutes().map((r) => r.key));
  const stale = Object.keys(NO_AUDIT_EXPECTED).filter((k) => !live.has(k));
  assert.deepEqual(stale, [],
    "NO_AUDIT_EXPECTED names routes that no longer exist — a stale excuse silently exempts the next route that reuses the path: " + stale.join(", "));
});

/**
 * `user.username` is the account KEY — unique, and deliberately never renamed, so a Discord-linked
 * account keeps the @handle it was provisioned from forever. It is not a name to show anyone.
 *
 * Recording it is worse than showing it, because a recorded name is a STRING: written into an audit
 * summary, a `createdByName`, or the `adminName` on a ban the game itself keeps, it is frozen at
 * that moment and nothing resolves it later. Every one of the 100-odd staff actions in these routes
 * did exactly that, so a staff member who linked Discord read as "pepper.2988" in every sentence
 * they had ever generated while the column beside it said "PEPPER [LYNX]".
 *
 * `p.name` (displayNameOf, resolved once per request) is the answer. This scan keeps it that way.
 */
test("routes record the display name, never the account key", () => {
  const offenders: string[] = [];
  for (const file of readdirSync(ROUTES_DIR)) {
    if (!file.endsWith(".ts")) continue;
    readFileSync(join(ROUTES_DIR, file), "utf8").split("\n").forEach((line, i) => {
      // The one sanctioned use: the login throttle KEYS on the account name, because its budget
      // must be the same bucket the login route charges (which throttles the name the visitor
      // TYPED, before any principal exists). That is an identity key, not a recorded name — the
      // exemption matches the call, not the file, so a summary in the same file is still caught.
      if (line.includes("loginThrottle.")) return;
      if (line.includes("p.user.username")) offenders.push(`${file}:${i + 1} — use p.name`);
    });
  }
  assert.deepEqual(offenders, [],
    "the principal's account key is being recorded as a name:\n" + offenders.join("\n"));
});

/**
 * The Staff column already says who acted. A summary that opens with the actor repeats it — and,
 * being frozen prose, repeats the version that was right at write time and wrong ever after.
 * Summaries are verb-first fragments: "added Necrosis85 to group \"LYNX CVC\"".
 */
test("audit summaries do not open with the actor", () => {
  const offenders: string[] = [];
  for (const file of readdirSync(ROUTES_DIR)) {
    if (!file.endsWith(".ts")) continue;
    readFileSync(join(ROUTES_DIR, file), "utf8").split("\n").forEach((line, i) => {
      // A summary template whose first thing is an interpolation naming a person.
      if (/summary:[^`]*`\$\{(p\.name|[a-z]\w*\.username|displayNameOf\()/.test(line)) {
        offenders.push(`${file}:${i + 1} — ${line.trim().slice(0, 100)}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    "these summaries lead with the actor's name; drop it — the Staff column names them:\n" + offenders.join("\n"));
});
