/**
 * Resolving `--server` lives in its own module so it can be tested: the CLI proper calls
 * process.exit on bad input, which a test runner cannot survive. Here failures throw.
 */
import type { Repository } from "@app/db";

function throwFail(msg: string): never { throw new Error(msg); }

/**
 * Resolve `--server` to one of OUR server ids. The panel does not show its internal uuid
 * anywhere, so requiring one would send people digging through the database; a name is what
 * staff actually have in front of them. Accepts the uuid too, for scripts.
 *
 * Ambiguity is an error rather than a guess: importing a whole history into the wrong server is
 * not something to recover from a coin toss.
 */
export async function resolveServerId(repo: Repository, given: string): Promise<string> {
  const all = await repo.servers.list();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(given)) {
    const byId = all.find((s) => s.id.toLowerCase() === given.toLowerCase());
    if (!byId) throwFail(`no server with id ${given} — run the \`servers\` command to see them`);
    return byId!.id;
  }
  const needle = given.trim().toLowerCase();
  const exact = all.filter((s) => s.name.trim().toLowerCase() === needle);
  const hits = exact.length ? exact : all.filter((s) => s.name.toLowerCase().includes(needle));
  if (hits.length === 0) throwFail(`no server named "${given}" — run the \`servers\` command to see them`);
  if (hits.length > 1) throwFail(`"${given}" matches ${hits.length} servers (${hits.map((s) => s.name).join(", ")}) — use the full name or the id`);
  return hits[0]!.id;
}

