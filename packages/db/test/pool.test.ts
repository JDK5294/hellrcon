/**
 * The connection pool every process uses (createPostgresRepository). A connection is kept between
 * the app's polls instead of being closed after node-postgres's 10 idle seconds and reopened, and
 * one that drops while idle is let go without taking the process with it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const DB = process.env.DATABASE_URL;

test("postgres pool: a connection idle between polls is kept, and one dropped while idle does not end the process", { skip: !DB }, async () => {
  const { createPostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const repo = await createPostgresRepository(DB!);
  const pool = (repo as unknown as { pool: { query(sql: string): Promise<{ rows: { pid: number }[] }> } }).pool;
  const admin = new pg.Client({ connectionString: DB });
  await admin.connect();
  try {
    const pid = async () => (await pool.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const first = await pid();
    // Past node-postgres's own 10 seconds: a poll every 15 found its connection closed.
    await new Promise((r) => setTimeout(r, 11_000));
    assert.equal(await pid(), first, "the same connection serves the next poll");
    // Postgres ends that connection while it sits idle in the pool (a restart, a dropped link).
    await admin.query("SELECT pg_terminate_backend($1)", [first]);
    await new Promise((r) => setTimeout(r, 300));
    assert.notEqual(await pid(), first, "the next query runs on a fresh connection, in a process still running");
  } finally {
    await admin.end();
    await repo.close();
  }
});

/*
 * Postgres compiles a query it costs as expensive into machine code before running it (JIT), and
 * for this app's reads the compiling took longer than the query did: the players search took
 * 460-600ms with it and 170ms without. Every connection the pool opens runs without it.
 */
test("postgres pool: every connection it opens runs without JIT", { skip: !DB }, async () => {
  const { createPostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const repo = await createPostgresRepository(DB!);
  const pool = (repo as unknown as { pool: { connect(): Promise<{ query(sql: string): Promise<{ rows: { jit: string; pid: number }[] }>; release(): void }> } }).pool;
  const plain = new pg.Client({ connectionString: DB });
  await plain.connect();
  try {
    // Two connections at once, so both the first and a later one are asked.
    const [a, b] = await Promise.all([pool.connect(), pool.connect()]);
    try {
      const seen = await Promise.all([a, b].map(async (c) => (await c.query("SELECT current_setting('jit') AS jit, pg_backend_pid() AS pid")).rows[0]!));
      assert.notEqual(seen[0]!.pid, seen[1]!.pid, "two separate connections");
      assert.deepEqual(seen.map((s) => s.jit), ["off", "off"]);
    } finally {
      a.release(); b.release();
    }
    // The server's own default is left as it is: only the app's connections change.
    const { rows } = await plain.query("SELECT current_setting('jit') AS jit, pg_jit_available() AS available");
    if (rows[0].available) assert.equal(rows[0].jit, "on", "the server default (this test proves the pool's own setting only while it is on)");
  } finally {
    await plain.end();
    await repo.close();
  }
});
