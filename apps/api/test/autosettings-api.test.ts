import { test } from "node:test";
import assert from "node:assert/strict";
import { withServer, jf, ownerAuth } from "./harness.ts";

async function makeServer(base: string, auth: Record<string, string>) {
  const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "as", host: "127.0.0.1", port: 1, password: "x" }) });
  return created.body.server.id as string;
}

test("autosettings GET returns defaults + writable fields, then round-trips a PUT", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);

    const initial = await jf(`${base}/api/servers/${id}/autosettings`, { headers: auth });
    assert.equal(initial.status, 200);
    assert.equal(initial.body.configured, false);
    assert.equal(initial.body.config.enabled, false);
    assert.deepEqual(initial.body.config.profiles, []);
    assert.ok(Array.isArray(initial.body.fields) && initial.body.fields.length > 0, "writable config fields served");
    const field = initial.body.fields.find((f: any) => f.kind === "num") ?? initial.body.fields[0];

    const put = await jf(`${base}/api/servers/${id}/autosettings`, { method: "PUT", headers: auth, body: JSON.stringify({
      enabled: true, dryRun: false, timezone: "America/New_York",
      profiles: [
        { name: "overnight", spec: { daysOfWeek: ["fri", "sat"], start: "22:00", end: "06:00", playersBelow: 40 }, settings: { [field.field]: field.kind === "num" ? 5 : field.kind === "bool" ? true : "x" } },
        { name: "default", settings: {} },
      ],
    }) });
    assert.equal(put.status, 200);
    assert.equal(put.body.config.enabled, true);
    assert.equal(put.body.config.timezone, "America/New_York");
    assert.equal(put.body.config.profiles.length, 2);
    assert.equal(put.body.config.profiles[0].name, "overnight");
    assert.deepEqual(put.body.config.profiles[0].spec.daysOfWeek, ["fri", "sat"]);

    const after = await jf(`${base}/api/servers/${id}/autosettings`, { headers: auth });
    assert.equal(after.body.configured, true);
    assert.equal(after.body.config.profiles[0].spec.playersBelow, 40);

    const audit = await jf(`${base}/api/audit`, { headers: auth });
    assert.ok((audit.body.entries as any[]).some((e) => e.action === "autosettings.config"));

    // The coverage picture: the same exact regions the map vote draws, over these profiles. The
    // windowed profile owns its stretch, the unconditional default owns the rest, and a profile
    // gated on TEAM counts is listed as undrawable rather than drawn wrong.
    await jf(`${base}/api/servers/${id}/autosettings`, { method: "PUT", headers: auth, body: JSON.stringify({
      enabled: true, dryRun: false, timezone: "UTC",
      profiles: [
        { name: "balancer", spec: { teamDiffAbove: 10 }, settings: {} },
        { name: "evenings", spec: { start: "18:00", end: "23:00" }, settings: {} },
        { name: "default", settings: {} },
      ],
    }) });
    const cov = await jf(`${base}/api/servers/${id}/autosettings/coverage`, { headers: auth });
    assert.equal(cov.status, 200);
    assert.equal(cov.body.hasGaps, false, "the unconditional default closes every gap");
    const names = new Set((cov.body.groups as any[]).flatMap((g) => g.bands.flatMap((b: any) => b.spans.map((s: any) => s.profile))));
    assert.ok(names.has("evenings") && names.has("default"), `both drawable profiles appear: ${[...names]}`);
    assert.ok(!names.has("balancer"), "a team-gated profile is never drawn on the clock");
    const aside = (cov.body.calendarOnly as any[]).find((c) => c.name === "balancer");
    assert.ok(aside && /team gap over 10/.test(aside.when), `team-gated profile listed with its condition: ${JSON.stringify(cov.body.calendarOnly)}`);
  });
});

test("autosettings coverage names a team-gated profile's sides in the server's own game", async () => {
  // Read on the Auto settings page under the weekly clock: "allies under 20" was WW2 wording on a
  // Vietnam server too, whose sides are the US and the NVA.
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const viet = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "nam", host: "127.0.0.1", port: 2, password: "x", game: "hllv", protocol: "binary-v2" }) });
    assert.equal(viet.status, 201, JSON.stringify(viet.body));
    const ww2 = await makeServer(base, auth);
    const profiles = [{ name: "lopsided", spec: { alliedBelow: 20, axisAbove: 30 }, settings: {} }, { name: "default", settings: {} }];
    const when = async (id: string) => {
      const put = await jf(`${base}/api/servers/${id}/autosettings`, { method: "PUT", headers: auth, body: JSON.stringify({ enabled: true, dryRun: true, timezone: "UTC", profiles }) });
      assert.equal(put.status, 200, JSON.stringify(put.body));
      const cov = await jf(`${base}/api/servers/${id}/autosettings/coverage`, { headers: auth });
      return (cov.body.calendarOnly as any[]).find((c) => c.name === "lopsided")?.when;
    };
    assert.equal(await when(viet.body.server.id), "US under 20 · NVA over 30");
    assert.equal(await when(ww2), "Allies under 20 · Axis over 30");
  });
});

test("autosettings PUT validation", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const put = (body: unknown) => jf(`${base}/api/servers/${id}/autosettings`, { method: "PUT", headers: auth, body: JSON.stringify(body) });

    assert.equal((await put({ timezone: "Not/AZone" })).status, 400);
    assert.equal((await put({ profiles: "nope" })).status, 400);
    assert.equal((await put({ profiles: [{ settings: {} }] })).status, 400); // missing name
    assert.equal((await put({ profiles: [{ name: "a", settings: {} }, { name: "A", settings: {} }] })).status, 400); // dup name (case-insensitive)
    assert.equal((await put({ profiles: [{ name: "a", settings: { notARealField: 1 } }] })).status, 400); // unknown setting
    assert.equal((await put({ profiles: [{ name: "a", spec: { daysOfWeek: ["funday"] }, settings: {} }] })).status, 400); // bad weekday
    assert.equal((await put({ profiles: [{ name: "a", spec: { start: "9am" }, settings: {} }] })).status, 400); // bad time
    assert.equal((await jf(`${base}/api/servers/does-not-exist/autosettings`, { method: "PUT", headers: auth, body: JSON.stringify({ enabled: true }) })).status, 404);
  });
});

test("autosettings config gated by server.config; unauthenticated is 401", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plain", password: "pw" }) });
    const plain = { authorization: `Bearer ${l.body.token as string}` };

    assert.equal((await jf(`${base}/api/servers/${id}/autosettings`, { headers: plain })).status, 403);
    // A server-scoped WRITE without the permission is filed for approval now (202), not
    // refused — the read half beside it still is. See docs/approvals.md.
    assert.equal((await jf(`${base}/api/servers/${id}/autosettings`, { method: "PUT", headers: plain, body: JSON.stringify({ enabled: true }) })).status, 202);
    assert.equal((await jf(`${base}/api/servers/${id}/autosettings`)).status, 401);
  });
});

test("autosettings: timed match messages and match-time conditions save, validate and resolve", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const put = (body: unknown) => jf(`${base}/api/servers/${id}/autosettings`, { method: "PUT", headers: auth, body: JSON.stringify(body) });

    const ok = await put({
      enabled: true, dryRun: true,
      profiles: [
        { name: "late game", spec: { matchMinutesAtLeast: 30, matchMinutesBelow: 60 }, settings: {} },
        { name: "default", settings: {} },
      ],
      matchMessages: [{ minutes: 20, message: "  Join our Discord!  ", minPlayers: 10 }, { minutes: 45, message: "Halfway", enabled: false }],
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const read = await jf(`${base}/api/servers/${id}/autosettings`, { headers: auth });
    assert.deepEqual(read.body.config.matchMessages, [
      { minutes: 20, message: "Join our Discord!", minPlayers: 10, enabled: true },
      { minutes: 45, message: "Halfway", minPlayers: 0, enabled: false },
    ]);
    assert.equal(read.body.config.profiles[0].spec.matchMinutesAtLeast, 30);
    assert.equal(read.body.config.profiles[0].spec.matchMinutesBelow, 60);

    // Validation: blank text, out-of-range minutes, a band that can never match.
    assert.equal((await put({ matchMessages: [{ minutes: 5, message: "   " }] })).status, 400);
    assert.equal((await put({ matchMessages: [{ minutes: -1, message: "x" }] })).status, 400);
    assert.equal((await put({ matchMessages: [{ minutes: 5, message: "x".repeat(1001) }] })).status, 400);
    assert.equal((await put({ matchMessages: Array.from({ length: 21 }, () => ({ minutes: 1, message: "x" })) })).status, 400);
    const never = await put({ profiles: [{ name: "never", spec: { matchMinutesAtLeast: 40, matchMinutesBelow: 30 }, settings: {} }] });
    assert.equal(never.status, 400);
    assert.match((never.body.error as { message: string }).message, /can never match/);

    // Status: no open match → match-time conditions can't match, so the default wins.
    const idle = await jf(`${base}/api/servers/${id}/autosettings/status`, { headers: auth });
    assert.equal(idle.body.matchMinutes, null);
    assert.equal(idle.body.active, "default");
    // A match that started 35 minutes ago → "late game" wins, and the clock is reported.
    await repo.matches.open({ serverId: id, map: "Foy", startedAt: new Date(Date.now() - 35 * 60_000).toISOString() });
    const late = await jf(`${base}/api/servers/${id}/autosettings/status`, { headers: auth });
    assert.equal(late.body.matchMinutes, 35);
    assert.equal(late.body.active, "late game");
  });
});
