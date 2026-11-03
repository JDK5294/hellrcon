import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword } from "@app/access";
import { assertAsked, jsonFetch, ownerAuth, withServer } from "./harness.ts";

// Never a real cloudflared: a machine that has one installed must not start a tunnel for a test.
process.env.CLOUDFLARED_BIN = "/nonexistent/cloudflared-for-tests";

const tokenFor = (t: string) => Buffer.from(JSON.stringify({ a: "account", t, s: "the-tunnel-secret" })).toString("base64");

async function staffAuth(base: string, repo: Parameters<Parameters<typeof withServer>[0]>[1]) {
  const user = await repo.users.create({ username: `staff-${Math.random().toString(36).slice(2, 8)}`, passwordHash: await hashPassword("pw"), email: null });
  await repo.grants.create({ userId: user.id, capability: "server.view", scopeType: "global", scopeId: null, level: "read" });
  const login = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: user.username, password: "pw" }) });
  return { authorization: `Bearer ${login.body.token}` };
}

/*
 * The tunnel's token is pasted from the Cloudflare dashboard, which shows it inside a whole command,
 * and run by the API straight away. It is kept encrypted, never sent back, never filed for
 * approval, and the trail names the tunnel, not the token.
 */
test("the tunnel's token is taken from whatever the dashboard shows, run at once, and never sent back or filed", async () => {
  const saved = process.env.CLOUDFLARE_TUNNEL_TOKEN;
  delete process.env.CLOUDFLARE_TUNNEL_TOKEN;
  try {
    await withServer(async (base, repo) => {
      const auth = await ownerAuth(base);
      const put = (token: string, headers: Record<string, string> = auth) => jsonFetch(`${base}/api/online/tunnel`, { method: "PUT", headers, body: JSON.stringify({ token }) });
      const token = tokenFor("8b8a1f9e-6c1d-4f7a");
      const r = await put(`cloudflared.exe service install ${token}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.tunnel.set, true);
      assert.equal(r.body.tunnel.tunnelId, "8b8a1f9e-6c1d-4f7a", "named by the tunnel it belongs to");
      assert.equal(r.body.tunnel.state, "connecting", "started at once");
      assert.doesNotMatch(JSON.stringify(r.body), /the-tunnel-secret|eyJ/, "the token is never sent back");
      assert.equal(process.env.CLOUDFLARE_TUNNEL_TOKEN, token, "in force at once");
      assert.equal(await repo.installSettings.get("tunnel.token"), token, "kept with the install's settings");
      // Where it stands, as the start scripts read it: there is no cloudflared on this test machine.
      let state = "";
      for (let i = 0; i < 40 && state !== "missing"; i++) {
        state = (await jsonFetch(`${base}/api/setup/status`)).body.tunnel;
        if (state !== "missing") await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(state, "missing");
      assert.match(String((await jsonFetch(`${base}/api/online`, { headers: auth })).body.tunnel.detail), /not installed/, "and the panel says why");
      const trail = (await repo.audit.list({ action: "online.tunnel" }))[0];
      assert.match(String(trail?.summary), /8b8a1f9e-6c1d-4f7a/);
      assert.doesNotMatch(JSON.stringify(trail), /the-tunnel-secret|eyJ/);

      const bad = await put("not a token at all");
      assert.equal(bad.status, 400);
      assert.match(String(bad.body.error?.message), /not a tunnel token/);

      const staff = await put(tokenFor("other"), await staffAuth(base, repo));
      assert.equal(staff.status, 403, "never filed: the request would carry the token");
      assert.equal((await repo.approvals.list()).length, 0);

      const off = await put("");
      assert.deepEqual({ set: off.body.tunnel.set, state: off.body.tunnel.state }, { set: false, state: "off" });
      assert.equal("CLOUDFLARE_TUNNEL_TOKEN" in process.env, false);
    });
  } finally {
    if (saved === undefined) delete process.env.CLOUDFLARE_TUNNEL_TOKEN; else process.env.CLOUDFLARE_TUNNEL_TOKEN = saved;
  }
});

/*
 * The panel's own domain, for the HTTPS proxy a VM install runs. The proxy asks before it fetches a
 * certificate: yes for the panel's domain and the stats site's address, no for anything else.
 */
test("the panel's own domain is saved, and the HTTPS proxy's certificate check says yes only to this install's addresses", async () => {
  await withServer(async (base, repo, ctx) => {
    const auth = await ownerAuth(base);
    const ask = async (domain: string) => (await jsonFetch(`${base}/api/online/tls-ask?domain=${encodeURIComponent(domain)}`)).status;
    const put = (host: string, headers: Record<string, string> = auth) => jsonFetch(`${base}/api/online/domain`, { method: "PUT", headers, body: JSON.stringify({ host }) });
    assert.equal(await ask("panel.example.com"), 404, "nothing is this install's until it is set");

    const r = await put("Panel.Example.com");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.domain, { host: "panel.example.com", proxy: false }, "and no HTTPS proxy runs on this test machine");
    assert.equal(await ask("panel.example.com"), 200);
    assert.equal(await ask("PANEL.example.com"), 200);
    assert.equal(await ask("other.example.com"), 404, "a stranger's hostname gets no certificate");
    ctx.config.publicStatsHost = "stats.example.com";
    assert.equal(await ask("stats.example.com"), 200, "the stats site's own address is this install's too");

    assert.equal((await put("stats.example.com")).status, 400, "the stats site's address is not the panel's");
    assert.equal((await put("not a domain")).status, 400);
    const asked = await put("elsewhere.example.com", await staffAuth(base, repo));
    assertAsked(asked, "filed for someone who may change it");
    assert.equal(await ask("elsewhere.example.com"), 404, "and nothing changes until it is approved");

    assert.equal((await put("")).body.domain.host, null);
    assert.equal(await ask("panel.example.com"), 404);
    assert.deepEqual((await repo.audit.list({ action: "online.domain" })).map((a) => a.summary).reverse(),
      ["set the panel's own domain to panel.example.com", "removed the panel's own domain"]);
  });
});

/*
 * The public demo: off until someone turns it on, and while off its page answers "not found"
 * however its address is spelled. Turning it on or off is a write on Online access, filed for
 * whoever may make it, and on the trail.
 */
test("the public demo is hidden until it is turned on, however its address is spelled", async () => {
  const root = mkdtempSync(join(tmpdir(), "demo-export-"));
  writeFileSync(join(root, "index.html"), "the panel");
  mkdirSync(join(root, "demo"));
  writeFileSync(join(root, "demo", "index.html"), "the demo");
  try {
    await withServer(async (base, repo, ctx) => {
      ctx.config.webRoot = root;
      const auth = await ownerAuth(base);
      // Sent as written: fetch would tidy a path like /x/..//demo/ before it left.
      const get = (path: string) => new Promise<{ status: number; text: string }>((resolve, reject) => {
        const u = new URL(base);
        request({ host: u.hostname, port: u.port, path }, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        }).on("error", reject).end();
      });
      const put = (body: unknown, headers: Record<string, string> = auth) => jsonFetch(`${base}/api/online/demo`, { method: "PUT", headers, body: JSON.stringify(body) });
      // Each the demo's page to the export's files, whatever the address says.
      const SPELLINGS = ["/demo", "/demo/", "/demo/index.html", "/DEMO/", "/Demo/index.html", "/x/..//demo/", "/x/../demo/index.html"];
      const hidden = async (when: string) => {
        for (const path of SPELLINGS) assert.equal((await get(path)).status, 404, `${path} ${when}`);
      };

      assert.equal((await jsonFetch(`${base}/api/online`, { headers: auth })).body.demo?.on, false, "off until someone turns it on");
      await hidden("while it is off");
      assert.equal((await get("/")).text, "the panel", "the panel itself is served as ever");
      assert.equal((await get("/demonstrate/")).text, "the panel", "an address that only starts the same is not theirs");

      const on = await put({ on: true });
      assert.equal(on.status, 200, JSON.stringify(on.body));
      assert.equal(on.body.demo.on, true);
      assert.deepEqual([await get("/demo/"), await get("/demo")].map((r) => r.text), ["the demo", "the demo"], "in force at once");

      assert.equal((await put({ on: "yes" })).status, 400, "on or off, nothing else");
      assertAsked(await put({ on: false }, await staffAuth(base, repo)), "filed for someone who may change it");
      assert.equal((await get("/demo/")).status, 200, "and nothing changes until it is approved");

      assert.equal((await put({ on: true })).status, 200);
      assert.equal((await put({ on: false })).body.demo.on, false);
      await hidden("once it is off again");
      assert.deepEqual((await repo.audit.list({ action: "online.demo" })).map((a) => a.summary).reverse(),
        ["turned the public demo on", "turned the public demo off"], "on the trail when it changes, not when it is turned the way it already was");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/*
 * Nothing from the demo's page reaches the API. The demo answers every request in the browser, and
 * one from its page that got through anyway — a link, a picture's address — is refused, wherever on
 * the API it is sent and however the page's address is spelled. Nothing else is.
 */
test("a request from the public demo's page is refused, at every address the API answers on", async () => {
  await withServer(async (base) => {
    const u = new URL(base);
    const send = (path: string, headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      request({ host: u.hostname, port: u.port, path, headers }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      }).on("error", reject).end();
    });
    for (const path of ["/api/me", "/api/auth/discord/start", "/api/online", "/s/s1/api/get_status", "/stats/main/api/get_status"]) {
      const usual = await send(path, {});
      assert.notEqual(usual, 403, `${path}: refused for some other reason`);
      for (const page of ["/demo/", "/demo", "/demo/index.html", "/DEMO/", "/x/../demo/"]) {
        assert.equal(await send(path, { referer: `http://${u.host}${page}` }), 403, `${path} from ${page}`);
      }
      // Behind a proxy that names the site otherwise, the browser's word that it is the same site.
      assert.equal(await send(path, { referer: "https://panel.example.com/demo/", "sec-fetch-site": "same-origin" }), 403, `${path} through a proxy`);
      // Not the demo: the panel's own page, an address that only starts the same, another site's.
      const others: [string, Record<string, string>][] = [[`http://${u.host}/`, {}], [`http://${u.host}/demonstrate/`, {}], ["https://elsewhere.example/demo/", { "sec-fetch-site": "cross-site" }], ["not an address", {}]];
      for (const [referer, extra] of others) {
        assert.equal(await send(path, { referer, ...extra }), usual, `${path} from ${referer}: answered as ever`);
      }
    }
  });
});
