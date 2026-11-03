/**
 * A REPOSITORY THAT CANNOT SEE ANOTHER ONE'S DATA.
 *
 * `createRepository()` hands back the in-memory store when no DATABASE_URL is set, and that store
 * gives every caller its own private world. Point the same code at Postgres and the assumption
 * quietly inverts: everyone shares one database. For the app that is the point; for a suite of
 * tests written against the in-memory store it is fatal in a way that looks like broken product
 * code — a fixed username collides, a fixed id becomes one row each test edits in turn,
 * "everywhere" reaches servers somebody else made, and any assertion over a whole table is really
 * asserting the file's history rather than its own behaviour.
 *
 * This gives each caller its own SCHEMA instead. Postgres puts unqualified `CREATE TABLE` into the
 * first entry of `search_path`, and a connection string can set that per connection
 * (`options=-csearch_path=…`), so a fresh schema plus the ordinary migration run produces a
 * complete, empty copy of the database that only this repository can see. `public` stays on the
 * path behind it, so anything the migrations expect to find there still resolves.
 *
 * With no DATABASE_URL this is exactly `createRepository()`, unchanged.
 */
import { Pool } from "pg";
import { createRepository } from "./index.js";
import type { Repository } from "./types.js";

let seq = 0;

export interface IsolatedRepository {
  repo: Repository;
  /** Drop the schema this repository owns. Safe when there is nothing to drop. */
  cleanup: () => Promise<void>;
}

export async function createIsolatedRepository(env: NodeJS.ProcessEnv = process.env): Promise<IsolatedRepository> {
  const url = env.DATABASE_URL;
  if (!url) return { repo: await createRepository(env), cleanup: async () => {} };

  // Unique per call AND per process: separate test files run as separate processes against one
  // database, so a counter on its own would have them land on the same names.
  const schema = `iso_${process.pid}_${++seq}`;
  const admin = new Pool({ connectionString: url });
  try {
    await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  } finally {
    await admin.end();
  }

  const sep = url.includes("?") ? "&" : "?";
  const scoped = `${url}${sep}options=${encodeURIComponent(`-csearch_path=${schema},public`)}`;
  const repo = await createRepository({ ...env, DATABASE_URL: scoped });

  return {
    repo,
    cleanup: async () => {
      await repo.close?.().catch(() => {});
      const drop = new Pool({ connectionString: url });
      try {
        await drop.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await drop.end();
      }
    },
  };
}
