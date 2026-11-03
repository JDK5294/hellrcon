import { test } from "node:test";
import assert from "node:assert/strict";
import { createUpdateCheck, LOOK_BACK } from "../dist/updates.js";
import { withIsolatedServer as withServer, jsonFetch, ownerAuth } from "./harness.ts";

// GitHub's commit list for a branch, newest first: what the check reads.
const branchCommits = (shas: string[]) => shas.map((sha, i) => ({ sha, commit: { message: `Change ${i}\n\nThe body is not shown.`, committer: { date: `2026-10-2${i}T12:00:00Z` } } }));

function github(answer: { status: number; body?: unknown } | Error) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let next = answer;
  const fetch = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    if (next instanceof Error) throw next;
    const a = next;
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
  };
  return { fetch, calls, answer: (a: typeof answer) => { next = a; } };
}

test("an install behind its branch is told how far, and what changed, newest first", async () => {
  const gh = github({ status: 200, body: branchCommits(["cccccccc11", "bbbbbbbb22", "abc1234f33", "9999999944"]) });
  const s = await createUpdateCheck({ commit: "abc1234", branch: "claude/session-x", repo: "JDK5294/hellrcon", fetch: gh.fetch }).status();
  assert.equal(s.state, "available");
  assert.equal(s.behindBy, 2);
  assert.deepEqual(s.changes?.map((c) => [c.sha, c.title, c.date]), [["cccccccc", "Change 0", "2026-10-20T12:00:00Z"], ["bbbbbbbb", "Change 1", "2026-10-21T12:00:00Z"]], "first lines only, newest first");
  assert.equal(gh.calls[0]!.url, `https://api.github.com/repos/JDK5294/hellrcon/commits?sha=claude%2Fsession-x&per_page=${LOOK_BACK}`);
  assert.equal(gh.calls[0]!.headers["user-agent"], "hellrcon-update-check", "GitHub refuses a request without one");
});

test("the branch's newest commit is this build: up to date", async () => {
  const gh = github({ status: 200, body: branchCommits(["abc1234f33", "9999999944"]) });
  const s = await createUpdateCheck({ commit: "abc1234", branch: "main", repo: "o/r", fetch: gh.fetch }).status();
  assert.equal(s.state, "current");
  assert.equal(s.behindBy, undefined);
});

test("a private repository, a build not on the branch, or no answer says so instead of guessing", async () => {
  const privateRepo = await createUpdateCheck({ commit: "abc1234", branch: "main", repo: "o/r", fetch: github({ status: 404 }).fetch }).status();
  assert.equal(privateRepo.state, "unknown");
  assert.match(privateRepo.reason!, /private/);
  const elsewhere = await createUpdateCheck({ commit: "abc1234", branch: "main", repo: "o/r", fetch: github({ status: 200, body: branchCommits(["cccccccc11", "bbbbbbbb22"]) }).fetch }).status();
  assert.equal(elsewhere.state, "unknown", "not among the newest: it cannot tell how far behind");
  assert.match(elsewhere.reason!, new RegExp(`newest ${LOOK_BACK} on main`));
  const offline = await createUpdateCheck({ commit: "abc1234", branch: "main", repo: "o/r", fetch: github(new Error("getaddrinfo ENOTFOUND")).fetch }).status();
  assert.equal(offline.state, "unknown");
  assert.match(offline.reason!, /did not answer/);
});

test("without its commit, its branch or a GitHub repository, GitHub is not asked, and the reason is given", async () => {
  const gh = github({ status: 200, body: [] });
  for (const [where, why] of [
    [{ commit: "", branch: "main", repo: "o/r" }, /not started by start\.bat or start\.sh/],
    [{ commit: "abc1234", branch: null, repo: "o/r" }, /follows no branch/],
    [{ commit: "abc1234", branch: "main", repo: undefined }, /did not come from GitHub/],
  ] as const) {
    const s = await createUpdateCheck({ ...where, fetch: gh.fetch }).status();
    assert.equal(s.state, "unknown");
    assert.match(s.reason!, why);
  }
  assert.equal(gh.calls.length, 0);
});

test("GitHub is asked at most once an hour, and a failed ask keeps the last answer", async () => {
  let clock = Date.parse("2026-10-22T12:00:00Z");
  const gh = github({ status: 200, body: branchCommits(["cccccccc11", "abc1234f33"]) });
  const check = createUpdateCheck({ commit: "abc1234", branch: "main", repo: "o/r", fetch: gh.fetch, now: () => clock });
  const first = await check.status();
  clock += 30 * 60_000;
  assert.equal((await check.status()).behindBy, 1);
  assert.equal(gh.calls.length, 1, "half an hour later: the same answer, GitHub not asked again");
  clock += 31 * 60_000;
  gh.answer(new Error("network down"));
  const later = await check.status();
  assert.equal(gh.calls.length, 2, "past the hour, asked again");
  assert.equal(later.state, "available", "the failed ask keeps what was known");
  assert.equal(later.checkedAt, first.checkedAt, "and says when that was");
});

/*
 * Only the account made at setup: the person who installed the panel and runs its start script.
 * Another owner, with every permission there is, is told there is nothing for them.
 */
test("updates are shown to the account made at setup, and to no other owner", async () => {
  await withServer(async (base, _repo, ctx) => {
    const gh = github({ status: 200, body: branchCommits(["cccccccc11", "abc1234f33"]) });
    ctx.updates = createUpdateCheck({ commit: "abc1234", branch: "main", repo: "JDK5294/hellrcon", fetch: gh.fetch });
    const first = await ownerAuth(base);
    const role = await jsonFetch(`${base}/api/roles`, { method: "POST", headers: first, body: JSON.stringify({ name: "Owners", grants: [{ capability: "*", level: "write" }] }) });
    const co = await jsonFetch(`${base}/api/users`, { method: "POST", headers: first, body: JSON.stringify({ username: "co", password: "pw" }) });
    await jsonFetch(`${base}/api/users/${co.body.user.id}/roles`, { method: "PUT", headers: first, body: JSON.stringify({ roleIds: [role.body.role.id] }) });
    const coLogin = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "co", password: "pw" }) });
    const coAuth = { authorization: `Bearer ${coLogin.body.token as string}` };

    const mine = await jsonFetch(`${base}/api/updates`, { headers: first });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.shown, true);
    assert.equal(mine.body.state, "available");
    assert.deepEqual(mine.body.changes.map((c: { title: string }) => c.title), ["Change 0"]);

    const theirs = await jsonFetch(`${base}/api/updates`, { headers: coAuth });
    assert.equal(theirs.status, 200);
    assert.deepEqual(theirs.body, { shown: false }, "an owner by role, not the setup account: nothing");
    assert.equal((await jsonFetch(`${base}/api/updates`)).status, 401);
  });
});
