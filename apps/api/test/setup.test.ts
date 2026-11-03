import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHllServer } from "./fake-hll-server.ts";
import { hashPassword } from "@app/access";
import { jsonFetch, withServer } from "./harness.ts";
import { makeSetupCode, settleSetupCode, SETUP_CODE_KEY, SETUP_STAGE_KEY, setupCodeFile, setupCodesMatch } from "../dist/setup.js";

/** A signed-in member of staff who can see the servers and nothing more. */
async function staffAuth(base: string, repo: Parameters<Parameters<typeof withServer>[0]>[1]) {
  const user = await repo.users.create({ username: `staff-${Math.random().toString(36).slice(2, 8)}`, passwordHash: await hashPassword("pw"), email: null });
  await repo.grants.create({ userId: user.id, capability: "server.view", scopeType: "global", scopeId: null, level: "read" });
  const login = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: user.username, password: "pw" }) });
  return { authorization: `Bearer ${login.body.token}` };
}

// The start scripts read the code from this file; each test run gets its own.
process.env.SETUP_CODE_FILE = join(mkdtempSync(join(tmpdir(), "setup-code-")), "code");
const codeFile = process.env.SETUP_CODE_FILE;

/*
 * A brand-new install holds a one-time code from its first boot until its owner exists: the same
 * code across restarts, written where the start scripts read it, and gone — from the database and
 * the file — once there is an account.
 */
test("the setup code: held while there are no accounts, the same across boots, written for the start scripts, and spent once the owner exists", async () => {
  await withServer(async (base, repo) => {
    const code = await settleSetupCode(repo);
    assert.match(code ?? "", /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/, "eight characters a person can read off a terminal");
    assert.equal(await settleSetupCode(repo), code, "a restart keeps the same code");
    assert.equal(readFileSync(codeFile, "utf8").trim(), code, "written where the start scripts read it");

    const reg = await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw", setupCode: code }) });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal(await repo.installSettings.get(SETUP_CODE_KEY), null, "spent in the database");
    assert.equal(existsSync(codeFile), false, "and the file is gone");
    assert.equal(await settleSetupCode(repo), null, "an install with accounts holds no code");
  });
});

test("a code left behind once accounts exist — a crash between the owner's creation and the code's spending — is dropped on the next boot", async () => {
  await withServer(async (_base, repo) => {
    assert.ok(await settleSetupCode(repo));
    await repo.users.create({ username: "owner", passwordHash: "x", email: null });
    assert.equal(await settleSetupCode(repo), null);
    assert.equal(await repo.installSettings.get(SETUP_CODE_KEY), null, "gone from the database");
    assert.equal(existsSync(codeFile), false, "and from the file the start scripts read");
  });
});

test("codes match whatever the case, spacing or dash — and nothing else matches", () => {
  const code = makeSetupCode();
  assert.ok(setupCodesMatch(code.toLowerCase().replace("-", " "), code));
  assert.ok(!setupCodesMatch("", code));
  assert.ok(!setupCodesMatch(code.slice(0, 8), code), "a prefix is not the code");
  assert.ok(!setupCodesMatch(`${code}X`, code), "nor is a longer string");
});

/*
 * Without the code, the first visitor to register became the owner — on a public VM, whoever
 * reached the port first. While a code is held, the first account takes it; a wrong one is refused
 * and counted, and five wrong codes from anywhere lock guessing out for a while.
 */
test("the first account takes the setup code: refused without it or with a wrong one, created with it; guessing is throttled", async () => {
  await withServer(async (base, repo) => {
    const code = (await settleSetupCode(repo))!;
    const register = (body: Record<string, unknown>) => jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw", ...body }) });

    let status = await jsonFetch(`${base}/api/setup/status`);
    assert.deepEqual(status.body, { needed: true, codeRequired: true, stage: null, route: "home", tunnel: "off" });

    const without = await register({});
    assert.equal(without.status, 403, "no code, no owner");
    assert.match(String(without.body.error?.message), /setup code .*running the start script again shows it/, "and says where the code is, for someone who closed that window");
    assert.equal((await register({ setupCode: "AAAA-AAAA" })).status, 403, "a wrong code is refused");
    assert.equal(await repo.users.count(), 0);

    const verifyWrong = await jsonFetch(`${base}/api/setup/verify`, { method: "POST", body: JSON.stringify({ code: "BBBB-BBBB" }) });
    assert.equal(verifyWrong.status, 403);
    const verifyRight = await jsonFetch(`${base}/api/setup/verify`, { method: "POST", body: JSON.stringify({ code: code.toLowerCase() }) });
    assert.equal(verifyRight.status, 200, "the code checks out however it is typed");

    const made = await register({ setupCode: code });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.owner, true);
    status = await jsonFetch(`${base}/api/setup/status`);
    assert.deepEqual(status.body, { needed: false, codeRequired: false, stage: "walkthrough", route: "home", tunnel: "off" }, "the owner is taken through the rest");
    assert.equal((await jsonFetch(`${base}/api/setup/verify`, { method: "POST", body: JSON.stringify({ code }) })).status, 409, "nothing left to verify");
  });
  await withServer(async (base, repo) => {
    const code = (await settleSetupCode(repo))!;
    const verify = async (c: string) => (await jsonFetch(`${base}/api/setup/verify`, { method: "POST", body: JSON.stringify({ code: c }) })).status;
    const register = async (c: string) => (await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw", setupCode: c }) })).status;
    const tries = [await verify("WRNG-2222"), await verify("WRNG-3333"), await verify("WRNG-4444"), await register("WRNG-5555"), await register("WRNG-6666"), await register("WRNG-7777"), await verify("WRNG-8888")];
    assert.deepEqual(tries, [403, 403, 403, 403, 403, 429, 429], "wrong codes count against one budget whichever way they come in, and past it both ways are refused before the code is checked");
    assert.equal(await verify(code), 429, "the right code too, until the window passes");
    const locked = await jsonFetch(`${base}/api/setup/verify`, { method: "POST", body: JSON.stringify({ code }) });
    assert.match(String(locked.body.error?.message), /try again in 15 minutes$/, "and it says how long, not \"a few minutes\"");
    assert.equal(await repo.users.count(), 0);
  });
});

test("an install that never held a code — every account made before this — creates its first account as before", async () => {
  await withServer(async (base) => {
    assert.deepEqual((await jsonFetch(`${base}/api/setup/status`)).body, { needed: true, codeRequired: false, stage: null, route: "home", tunnel: "off" });
    const made = await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    assert.equal(made.status, 201, JSON.stringify(made.body));
  });
});

/*
 * The walk-through's "Test connection": the details are tried — connect, read the name — and
 * nothing is saved. The owner only; a refusal comes back as the game's answer, not a crash.
 */
test("test a game server's details before saving them: the name when they work, the reason when they don't, nothing stored", async () => {
  await withServer(async (base, repo) => {
    const made = await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    assert.equal(made.status, 201);
    const login = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const auth = { authorization: `Bearer ${login.body.token}` };
    const fake = new FakeHllServer("rcon-pw");
    const port = await fake.listen();
    try {
      const probe = (body: Record<string, unknown>, headers: Record<string, string> = auth) =>
        jsonFetch(`${base}/api/setup/test-server`, { method: "POST", headers, body: JSON.stringify(body) });
      assert.equal((await probe({ host: "127.0.0.1", port, password: "rcon-pw" }, {})).status, 401, "signed in only");
      assert.equal((await probe({ host: "127.0.0.1", port, password: "rcon-pw" }, await staffAuth(base, repo))).status, 403, "and only by someone who may add servers");
      const ok = await probe({ game: "hll", host: "127.0.0.1", port, password: "rcon-pw" });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
      assert.ok("name" in ok.body, "the server's own name, when it reports one");
      const wrong = await probe({ game: "hll", host: "127.0.0.1", port, password: "not-it" });
      assert.equal(wrong.body.ok, false, "a wrong password is an answer, not an error");
      assert.ok(String(wrong.body.error).length > 0);
      assert.equal((await probe({ host: "127.0.0.1", port: 99999, password: "x" })).status, 400);
      assert.equal((await repo.servers.list()).length, 0, "nothing was saved");
    } finally {
      fake.close();
    }
  });
});

test("finishing the walk-through takes the owner and ends it for good", async () => {
  await withServer(async (base, repo) => {
    await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    assert.equal(await repo.installSettings.get(SETUP_STAGE_KEY), "walkthrough");
    assert.equal((await jsonFetch(`${base}/api/setup/finish`, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await jsonFetch(`${base}/api/setup/finish`, { method: "POST", headers: await staffAuth(base, repo), body: "{}" })).status, 403, "staff cannot end the owner's walk-through");
    assert.equal(await repo.installSettings.get(SETUP_STAGE_KEY), "walkthrough");
    const login = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const done = await jsonFetch(`${base}/api/setup/finish`, { method: "POST", headers: { authorization: `Bearer ${login.body.token}` }, body: "{}" });
    assert.equal(done.status, 200);
    assert.equal((await jsonFetch(`${base}/api/setup/status`)).body.stage, null);
  });
});

/*
 * The start scripts hand the code over in the link they open, reading it from the file inside the
 * api container: the path they read is the one the panel writes.
 */
test("both start scripts read the code from the file the panel writes, and open setup with it", () => {
  const saved = process.env.SETUP_CODE_FILE;
  delete process.env.SETUP_CODE_FILE;
  const written = setupCodeFile();
  process.env.SETUP_CODE_FILE = saved;
  for (const name of ["start.sh", "start.bat"]) {
    const script = readFileSync(fileURLToPath(new URL(`../../../${name}`, import.meta.url)), "utf8");
    assert.ok(script.includes(`exec -T api cat ${written}`), `${name} reads ${written}`);
    assert.match(script, /\/#\/setup\?code=/, `${name} opens the setup page with the code`);
    assert.match(script, /\/api\/setup\/status/, `${name} asks whether the install needs setup first`);
  }
});
