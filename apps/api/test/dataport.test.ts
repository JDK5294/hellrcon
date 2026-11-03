/**
 * The database export/import surface, against the memory store — which cannot port data, and must
 * SAY so. The happy path (real export, real import) lives in packages/db/test/postgres.test.ts
 * against a real Postgres; what this file pins is the HTTP contract around it: the catalog, the
 * validation, the honesty about capability, and the upload plumbing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { withIsolatedServer as withServer } from "./harness.ts";

/** Everything here asserts the MEMORY store's answers (supported: false, imports refused with a
 *  reason). With DATABASE_URL set the repository IS Postgres and those assertions flip by design —
 *  the real export/import path is covered in packages/db/test/postgres.test.ts. */
const SKIP_ON_PG = process.env.DATABASE_URL
  ? "memory-store contract — the Postgres data-port path is covered in packages/db"
  : false;

async function ownerAuth(base: string): Promise<{ authorization: string }> {
  await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw" }) });
  const login = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw" }) });
  return { authorization: `Bearer ${(login.body as { token: string }).token}` };
}

async function jf(url: string, opts: RequestInit = {}) {
  const res = await fetch(url, { ...opts, headers: { "content-type": "application/json", ...(opts.headers ?? {}) } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test("data port routes: catalog served, selections validated by name, memory store answers honestly", { skip: SKIP_ON_PG }, async () => {
  /*
   * A directory of its own, like the upload test below.
   *
   * This one asserts that a download has nothing to give — and read the DEFAULT backup directory
   * to decide, which is a real path on the machine. Anything that had ever written an export
   * there (an earlier run of this very suite) made the assertion fail forever after, so the test
   * passed exactly once per machine and then reported a bug that was its own leftovers.
   */
  const dir = mkdtempSync(join(tmpdir(), "data-port-empty-"));
  process.env.BACKUP_DIR = dir;
  try {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);

    // No session, no catalog — the group list describes the whole database.
    assert.equal((await jf(`${base}/api/data/options`)).status, 401);

    const options = await jf(`${base}/api/data/options`, { headers: auth });
    assert.equal(options.status, 200);
    const body = options.body as { supported: boolean; groups: { id: string; label: string; hint: string }[] };
    assert.equal(body.supported, false, "the memory store says it cannot port data");
    assert.ok(body.groups.length >= 20, "every group is individually listed");
    for (const g of ["settings", "servers", "players", "aliases", "vip", "bans", "events"]) {
      assert.ok(body.groups.some((o) => o.id === g && o.label && o.hint), `group ${g} present with label + hint`);
    }

    // Unknown ids refused BY NAME; an empty pick refused outright — on counts and export alike.
    assert.equal((await jf(`${base}/api/data/counts`, { method: "POST", headers: auth, body: JSON.stringify({ groups: ["playerz"] }) })).status, 400);
    assert.equal((await jf(`${base}/api/data/export`, { method: "POST", headers: auth, body: JSON.stringify({ groups: [] }) })).status, 400);

    // A valid selection on a memory-backed install: a clear 400, not a fake archive.
    const counts = await jf(`${base}/api/data/counts`, { method: "POST", headers: auth, body: JSON.stringify({ groups: ["servers"] }) });
    assert.equal(counts.status, 400);
    assert.match(JSON.stringify(counts.body), /Postgres/);
    assert.equal((await jf(`${base}/api/data/export`, { method: "POST", headers: auth, body: JSON.stringify({ groups: ["servers"] }) })).status, 400);

    // Nothing has run and nothing was uploaded: status says idle, download has nothing to give.
    const status = await jf(`${base}/api/data/status`, { headers: auth });
    assert.equal(status.status, 200);
    assert.equal((status.body as { run: { status: string } }).run.status, "idle");
    assert.equal((await jf(`${base}/api/data/download`, { headers: auth })).status, 404);
  });
  } finally {
    delete process.env.BACKUP_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("data port upload: streamed to disk, audited, visible in status; import still refuses without Postgres", { skip: SKIP_ON_PG }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "data-port-api-"));
  process.env.BACKUP_DIR = dir;
  try {
    await withServer(async (base, repo) => {
      const auth = await ownerAuth(base);
      const payload = JSON.stringify({ table: "servers", row: { id: "x" } }) + "\n";
      const up = await fetch(`${base}/api/data/upload`, { method: "POST", headers: { ...auth, "content-type": "application/octet-stream" }, body: payload });
      assert.equal(up.status, 200);
      assert.equal(((await up.json()) as { bytes: number }).bytes, payload.length);
      assert.equal(readFileSync(join(dir, "data-upload.ndjson.gz"), "utf8"), payload, "the body landed on disk verbatim");

      const status = await jf(`${base}/api/data/status`, { headers: auth });
      assert.equal((status.body as { upload: { bytes: number } }).upload?.bytes, payload.length);

      // Who brought the archive in is on the record even if it is never imported.
      assert.ok((await repo.audit.list({})).some((a) => a.action === "data.upload"));

      // The archive is here, but this install still cannot import it — and says why.
      const imp = await jf(`${base}/api/data/import`, { method: "POST", headers: auth });
      assert.equal(imp.status, 400);
      assert.match(JSON.stringify(imp.body), /Postgres/);
    });
  } finally {
    delete process.env.BACKUP_DIR;
  }
});

/*
 * An upload cut off part-way (a phone changing networks) left half an archive in the upload slot,
 * and the status read it as an archive ready to import: the Import button offered it by size. It
 * had also taken the place of the last complete upload. Nothing reaches the slot until all of it
 * has arrived.
 */
test("data port upload: one cut off part-way leaves nothing to import, and the last complete one in place", async () => {
  const dir = mkdtempSync(join(tmpdir(), "data-port-cut-"));
  process.env.BACKUP_DIR = dir;
  try {
    await withServer(async (base) => {
      const auth = await ownerAuth(base);
      const { hostname, port } = new URL(base);
      const cutOff = () => new Promise<void>((resolve) => {
        const req = httpRequest({ host: hostname, port: Number(port), path: "/api/data/upload", method: "POST", headers: { ...auth, "content-type": "application/octet-stream", "content-length": "100000" } });
        req.on("error", () => resolve());
        req.write("x".repeat(30_000));
        setTimeout(() => { req.destroy(); setTimeout(resolve, 300); }, 300);
      });
      const upload = async () => ((await jf(`${base}/api/data/status`, { headers: auth })).body as { upload: { bytes: number } | null }).upload;
      // The server learns of the cut when its socket closes and clears the half-written file after
      // that — moments later on a busy machine, so this waits for it rather than a fixed time.
      const leftBehind = async () => {
        for (let i = 0; i < 50 && readdirSync(dir).length; i++) await new Promise((r) => setTimeout(r, 100));
        return readdirSync(dir);
      };

      await cutOff();
      assert.equal(await upload(), null, "half an archive is not an upload");
      assert.deepEqual(await leftBehind(), [], "and nothing of it is left behind");

      const payload = JSON.stringify({ table: "servers", row: { id: "x" } }) + "\n";
      assert.equal((await fetch(`${base}/api/data/upload`, { method: "POST", headers: { ...auth, "content-type": "application/octet-stream" }, body: payload })).status, 200);
      await cutOff();
      assert.equal((await upload())?.bytes, payload.length, "the complete upload is still the one waiting");
      assert.equal(readFileSync(join(dir, "data-upload.ndjson.gz"), "utf8"), payload);
    });
  } finally {
    delete process.env.BACKUP_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("data port lock: one thing at a time — a running job or a streaming upload blocks everything else", { skip: SKIP_ON_PG }, async () => {
  await withServer(async (base, _repo, ctx) => {
    const auth = await ownerAuth(base);

    // A running export holds the lock: no second export, no import, no upload — and no download
    // of the very file it is still writing.
    ctx.dataPortRun.current = { kind: "export", status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), rows: 0 };
    assert.equal((await jf(`${base}/api/data/export`, { method: "POST", headers: auth, body: JSON.stringify({ groups: ["servers"] }) })).status, 409);
    assert.equal((await jf(`${base}/api/data/import`, { method: "POST", headers: auth })).status, 409);
    assert.equal((await fetch(`${base}/api/data/upload`, { method: "POST", headers: auth, body: "x" })).status, 409);
    assert.equal((await jf(`${base}/api/data/download`, { headers: auth })).status, 409, "a half-written archive is never streamed out");

    // An upload still streaming onto disk blocks a run from reading it mid-write.
    ctx.dataPortRun.current = null;
    ctx.dataPortRun.uploading = true;
    assert.equal((await jf(`${base}/api/data/export`, { method: "POST", headers: auth, body: JSON.stringify({ groups: ["servers"] }) })).status, 409);
    assert.equal((await jf(`${base}/api/data/import`, { method: "POST", headers: auth })).status, 409);
    assert.equal((await fetch(`${base}/api/data/upload`, { method: "POST", headers: auth, body: "x" })).status, 409);

    // Released: requests reach the store's own answer again (400 on memory, not 409).
    ctx.dataPortRun.uploading = false;
    assert.equal((await jf(`${base}/api/data/export`, { method: "POST", headers: auth, body: JSON.stringify({ groups: ["servers"] }) })).status, 400);
  });
});

/*
 * The full-backup surface: the name IS the validation, the memory store is honest, and the list
 * answers even when the folder is empty. The real backup/restore round trip — including the proof
 * that restore beats a fresh install's seeds where import cannot — lives in
 * packages/db/test/postgres.test.ts against a real Postgres.
 */
test("full backup routes: name-validated, honest without Postgres, list answers empty", { skip: SKIP_ON_PG }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "backup-routes-"));
  process.env.BACKUP_DIR = dir;
  try {
    await withServer(async (base) => {
      const auth = await ownerAuth(base);

      // No Postgres, no backup — said plainly, not pretended.
      const started = await jf(`${base}/api/data/backup`, { method: "POST", headers: auth });
      assert.equal(started.status, 400);
      assert.match((started.body as any).error.message, /Postgres/);
      const restore = await jf(`${base}/api/data/restore`, { method: "POST", headers: auth, body: JSON.stringify({ file: "full-backup-20260101-000000.ndjson.gz" }) });
      assert.equal(restore.status, 400);
      assert.match((restore.body as any).error.message, /Postgres/);

      // The list is a plain directory read — it answers on any store, and an empty folder is [].
      const list = await jf(`${base}/api/data/backups`, { headers: auth });
      assert.equal(list.status, 200);
      assert.deepEqual((list.body as any).backups, []);

      // Only the timestamped shape is a backup name. Anything else — traversal attempts
      // included — is refused by the pattern before any path is built from it.
      for (const evil of ["..%2F..%2Fetc%2Fpasswd", "notaname.gz", "full-backup-1-1.ndjson.gz", "full-backup-20260101-000000.ndjson.gz.bak"]) {
        assert.equal((await jf(`${base}/api/data/backups/${evil}`, { headers: auth })).status, 400, `download must refuse "${evil}"`);
        assert.equal((await jf(`${base}/api/data/backups/${evil}`, { method: "DELETE", headers: auth })).status, 400, `delete must refuse "${evil}"`);
      }
      // A well-formed name that simply is not there is a 404, not an error page.
      assert.equal((await jf(`${base}/api/data/backups/full-backup-20260101-000000.ndjson.gz`, { headers: auth })).status, 404);
      assert.equal((await jf(`${base}/api/data/backups/full-backup-20260101-000000.ndjson.gz`, { method: "DELETE", headers: auth })).status, 404);

      // The worker's nightly archives (auto-backup-*) are first-class here: listed, downloadable,
      // restorable, deletable by the same routes. 404 (name accepted, file absent) — a 400 would
      // mean the pattern still only knows the manual prefix and every nightly archive is invisible.
      assert.equal((await jf(`${base}/api/data/backups/auto-backup-20260101-040000.ndjson.gz`, { headers: auth })).status, 404, "an auto archive's name must be accepted");
      assert.equal((await jf(`${base}/api/data/backups/auto-backup-20260101-040000.ndjson.gz`, { method: "DELETE", headers: auth })).status, 404);
      assert.equal((await jf(`${base}/api/data/backups/auto-backup-.ndjson.gz`, { headers: auth })).status, 400, "but not a malformed one");

      // All of it gated: no session, no answer.
      assert.equal((await jf(`${base}/api/data/backup`, { method: "POST" })).status, 401);
      assert.equal((await jf(`${base}/api/data/backups`)).status, 401);
      assert.equal((await jf(`${base}/api/data/restore`, { method: "POST", body: JSON.stringify({ file: "x" }) })).status, 401);
    });
  } finally {
    delete process.env.BACKUP_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a double-click on Restore runs ONE restore — the second is refused while the first holds the slot", { skip: SKIP_ON_PG }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-race-"));
  process.env.BACKUP_DIR = dir;
  const file = "full-backup-20260929-120000.ndjson.gz";
  writeFileSync(join(dir, file), "");
  try {
    await withServer(async (base, repo) => {
      const auth = await ownerAuth(base);
      // A Postgres-shaped data port whose restore holds until released: the first restore owns the
      // slot for as long as a real one would (minutes, on a real database).
      let restores = 0;
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const port = repo.dataPort as unknown as { supported: boolean; restore: (...a: unknown[]) => Promise<Record<string, never>> };
      port.supported = true;
      port.restore = async () => { restores++; await held; return {}; };
      // The body arrives a beat after the headers, as it does over a tunnel from a phone — the
      // window two clicks used to slip through, one each side of the busy check.
      const post = () => new Promise<{ status: number }>((resolve, reject) => {
        const u = new URL(`${base}/api/data/restore`);
        const req = httpRequest({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json", ...auth } }, (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        });
        req.on("error", reject);
        req.flushHeaders();
        setTimeout(() => req.end(JSON.stringify({ file })), 40);
      });
      const [a, b] = await Promise.all([post(), post()]);
      assert.deepEqual([a.status, b.status].sort(), [202, 409], "one restore starts; the other is told one is in progress");
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(restores, 1, "two restores at once would each wipe and refill every table under the other");
      release();
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a restore and a real CRCON Apply never run over each other — both directions refuse", { skip: SKIP_ON_PG }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-crcon-"));
  process.env.BACKUP_DIR = dir;
  const file = "full-backup-20260929-130000.ndjson.gz";
  writeFileSync(join(dir, file), "");
  try {
    await withServer(async (base, repo, ctx) => {
      const auth = await ownerAuth(base);
      (repo.dataPort as unknown as { supported: boolean }).supported = true;
      const server = await repo.servers.create({ name: "Import target", host: "10.9.9.60", port: 60, password: "x" });

      // A real Apply is writing: the restore waits.
      ctx.crconTransforms.set(server.id, { status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), processed: 0, phase: "scan" } as never);
      const restore = await jf(`${base}/api/data/restore`, { method: "POST", headers: auth, body: JSON.stringify({ file }) });
      assert.equal(restore.status, 409);
      assert.match(String((restore.body as any).error?.message ?? ""), /CRCON import is being applied/);
      ctx.crconTransforms.delete(server.id);

      // A restore is replacing the tables: a real Apply waits — a dry run (throwaway store) may go.
      ctx.dataPortRun.current = { kind: "restore", status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), rows: 0, file } as never;
      const apply = await jf(`${base}/api/servers/${server.id}/import/crcon/transform`, { method: "POST", headers: auth });
      assert.equal(apply.status, 409);
      assert.match(String((apply.body as any).error?.message ?? ""), /data restore is running/);
      ctx.dataPortRun.current = null;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
