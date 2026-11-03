/**
 * Editing an existing server's connection — the way out of a rotated RCON password.
 *
 * Before this route a password could be set once, at add time. When a host rotated the credential
 * the panel kept dialling with the old one, every write to that server failed authentication, and
 * the environment was no escape: discovery treats it as a seed and will not overwrite a server it
 * already knows. These tests hold the shape of the fix — in particular that a blank password means
 * "keep the current one" rather than "store nothing", because the second reading turns an unrelated
 * port change into a silent credential wipe.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRepository } from "@app/db";
import { withIsolatedServer as withServer } from "./harness.ts";

async function jsonFetch(url: string, opts: RequestInit = {}) {
  const res = await fetch(url, { ...opts, headers: { "content-type": "application/json", ...(opts.headers ?? {}) } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/**
 * Servers are seeded through the repository rather than POST /api/servers on purpose: creating one
 * over HTTP dials the game to read its name, and a test host that does not exist costs the connect
 * timeout every time. Nothing here is testing creation.
 */
async function seedServer(repo: Awaited<ReturnType<typeof createRepository>>, input: Parameters<typeof repo.servers.create>[0]): Promise<string> {
  return (await repo.servers.create(input)).id;
}

async function ownerAuth(base: string): Promise<Record<string, string>> {
  await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw-owner-1234" }) });
  const login = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw-owner-1234" }) });
  return { authorization: `Bearer ${(login.body as { token: string }).token}`, "content-type": "application/json" };
}

test("a rotated RCON password can be set on a server that already exists", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const id = await seedServer(repo, { name: "Second", host: "10.0.0.2", port: 28865, password: "old-secret" });

    const saved = await jsonFetch(`${base}/api/servers/${id}/connection`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ host: "10.0.0.9", port: 28866, password: "new-secret" }),
    });
    assert.equal(saved.status, 200);
    const back = (saved.body as { server: Record<string, unknown> }).server;
    assert.equal(back.host, "10.0.0.9");
    assert.equal(back.port, 28866);
    assert.equal(back.password, undefined, "the secret is never sent back to the browser");

    const row = await repo.servers.findById(id);
    assert.equal(row?.password, "new-secret", "the stored credential is the new one");
    assert.equal(row?.name, "Second", "editing the connection leaves everything else alone");

    // The trail says WHICH fields moved and where the server now lives — never the credential.
    const entry = (await repo.audit.list({ limit: 20 })).find((a) => a.action === "server.connection");
    assert.ok(entry, "the edit is recorded");
    assert.match(entry.summary, /password/, "it says the password was changed");
    assert.doesNotMatch(JSON.stringify(entry), /new-secret|old-secret/, "no credential in the trail");
    assert.deepEqual((entry.data as { changed: string[] }).changed, ["host", "port", "password"]);
  });
});

test("a blank password keeps the current one; an explicitly empty one is refused", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const id = await seedServer(repo, { name: "Keeper", host: "10.0.0.3", port: 28865, password: "keep-me" });

    // Omitted: the editor never receives the stored secret, so an unrelated port change must not
    // be able to wipe it.
    const portOnly = await jsonFetch(`${base}/api/servers/${id}/connection`, { method: "PUT", headers: auth, body: JSON.stringify({ port: 28870 }) });
    assert.equal(portOnly.status, 200);
    assert.equal((await repo.servers.findById(id))?.password, "keep-me");
    assert.equal((await repo.servers.findById(id))?.port, 28870);

    // Sent as "": a blank credential authenticates against nothing, and storing it would look like
    // a rotation that worked right up until the next ban failed.
    const blank = await jsonFetch(`${base}/api/servers/${id}/connection`, { method: "PUT", headers: auth, body: JSON.stringify({ password: "" }) });
    assert.equal(blank.status, 400);
    assert.match(JSON.stringify(blank.body), /omit the field/);
    assert.equal((await repo.servers.findById(id))?.password, "keep-me");
  });
});

test("the connection editor refuses input that would leave the server unreachable", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const id = await seedServer(repo, { name: "Picky", host: "10.0.0.4", port: 28865, password: "x" });
    const put = (body: unknown) => jsonFetch(`${base}/api/servers/${id}/connection`, { method: "PUT", headers: auth, body: JSON.stringify(body) });

    assert.equal((await put({ host: "   " })).status, 400, "an empty host");
    assert.equal((await put({ port: 0 })).status, 400, "port 0");
    assert.equal((await put({ port: 70000 })).status, 400, "a port past 65535");
    assert.equal((await put({ port: "28865x" })).status, 400, "a port that is not a number");
    assert.equal((await put({ protocol: "smoke-signals" })).status, 400, "a protocol this game does not speak");
    assert.equal((await put({ protocol: "crcon-bridge" })).status, 400, "the bridge with nowhere to bridge to");
    assert.equal((await put({})).status, 400, "an empty edit");

    // None of it landed.
    const row = await repo.servers.findById(id);
    assert.equal(row?.host, "10.0.0.4");
    assert.equal(row?.port, 28865);
    assert.equal(row?.protocol, "binary-v2");
    assert.equal((await repo.audit.list({ limit: 20 })).some((a) => a.action === "server.connection"), false, "a refused edit records nothing");
  });
});

test("clearing the CRCON base URL while bridged through it is refused", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const id = await seedServer(repo, { name: "Bridged", host: "10.0.0.5", port: 28865, password: "x", protocol: "crcon-bridge", crconBaseUrl: "https://crcon.example.com" });

    // The broken end state reached from the other direction: same server, same rule.
    const cleared = await jsonFetch(`${base}/api/servers/${id}/connection`, { method: "PUT", headers: auth, body: JSON.stringify({ crconBaseUrl: "" }) });
    assert.equal(cleared.status, 400);
    assert.match(JSON.stringify(cleared.body), /crconBaseUrl/);

    // Moving off the bridge and dropping the URL together is fine — nothing needs it any more.
    const off = await jsonFetch(`${base}/api/servers/${id}/connection`, { method: "PUT", headers: auth, body: JSON.stringify({ protocol: "binary-v2", crconBaseUrl: "" }) });
    assert.equal(off.status, 200);
    assert.equal((off.body as { server: { protocol: string } }).server.protocol, "binary-v2");
  });
});

test("editing a connection needs server.manage write, not merely a login", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const id = await seedServer(repo, { name: "Guarded", host: "10.0.0.6", port: 28865, password: "untouchable" });

    await jsonFetch(`${base}/api/auth/register`, { method: "POST", headers: auth, body: JSON.stringify({ username: "viewer-conn", password: "pw-viewer-1234" }) });
    const login = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "viewer-conn", password: "pw-viewer-1234" }) });
    const viewerAuth = { authorization: `Bearer ${(login.body as { token: string }).token}`, "content-type": "application/json" };

    const denied = await jsonFetch(`${base}/api/servers/${id}/connection`, { method: "PUT", headers: viewerAuth, body: JSON.stringify({ password: "mine-now" }) });
    assert.equal(denied.status, 403);
    assert.match(JSON.stringify(denied.body), /server\.manage/);
    assert.equal((await repo.servers.findById(id))?.password, "untouchable");
  });
});

/*
 * The staff nickname. Game server names are written for the browser list — long and one
 * character apart between siblings — so the panel lets staff alias them. The alias must ride the
 * ordinary servers list (that is what every picker reads), must clear back to nothing, and must
 * never touch `name`, which is the real name players see and the public surfaces keep.
 */
test("server nickname: set, shown on the list, cleared by blank — the real name untouched", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const id = await seedServer(repo, { name: "The [LYNX] Division #1 | MICS MANDATORY", host: "10.0.0.9", port: 28871, password: "x" });

    const set = await jsonFetch(`${base}/api/servers/${id}/nickname`, { method: "POST", headers: auth, body: JSON.stringify({ nickname: "  WW2 Main  " }) });
    assert.equal(set.status, 200);
    const setRow = set.body.server as { name: string; gameName: string; nickname: string | null };
    assert.equal(setRow.nickname, "WW2 Main", "stored trimmed");
    // The repository resolves the display name at the read boundary: `name` IS the nickname
    // everywhere now, and the game's own identity stays readable in `gameName`.
    assert.equal(setRow.name, "WW2 Main", "the display name becomes the nickname");
    assert.equal(setRow.gameName, "The [LYNX] Division #1 | MICS MANDATORY", "the game's own name survives untouched");

    const list = await jsonFetch(`${base}/api/servers`, { headers: auth });
    const row = (list.body.servers as { id: string; name: string; nickname?: string | null }[]).find((r) => r.id === id);
    assert.equal(row?.name, "WW2 Main", "every picker's data source shows the alias");

    const cleared = await jsonFetch(`${base}/api/servers/${id}/nickname`, { method: "POST", headers: auth, body: JSON.stringify({ nickname: "" }) });
    assert.equal(cleared.status, 200);
    const clearedRow = cleared.body.server as { name: string; nickname: string | null };
    assert.equal(clearedRow.nickname, null, "blank clears, not stores an empty string");
    assert.equal(clearedRow.name, "The [LYNX] Division #1 | MICS MANDATORY", "and the real name shows again");
  });
});
