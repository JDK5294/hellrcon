/**
 * The CRCON-database import, driven from a terminal. Three commands, in the order you run them:
 *
 *   servers     — list THIS panel's servers with their ids, so --server can be given a name.
 *   inventory   — read-only profile of the CRCON database: which servers it holds, how much of
 *                 each, over what dates, plus warnings for anything that would import wrong.
 *                 Run this FIRST and read it: it is the proof of what you are about to import.
 *   export      — one server's complete history → the archive file the panel's Apply reads
 *                 (the same file a network pull would have written, but complete and
 *                 server-attributed straight from the source columns).
 *   reconcile   — AFTER the panel Apply: count both databases and prove they agree, category by
 *                 category. COMPLETE or a named difference — nothing in between.
 *
 * Usage (from apps/workers, after a build):
 *   node dist/crcon-import/db-import-cli.js inventory --crcon postgres://rcon:PASS@127.0.0.1:5433/rcon
 *   node dist/crcon-import/db-import-cli.js export    --crcon <url> --server-number 1 --server <ourServerId>
 *   node dist/crcon-import/db-import-cli.js reconcile --crcon <url> --server-number 1 --server <ourServerId>
 *
 * export/reconcile write/read our own database via DATABASE_URL, exactly like the API does.
 * The CRCON side is always read-only; run it against a Postgres you started read-only if you
 * want belt and braces (the runbook shows how).
 */
import { Pool } from "pg";
import { createRepository } from "@app/db";
import { crconBackupFile } from "@app/shared";
import { ArchiveWriter } from "./archive.js";
import { exportServer, inventory } from "./from-database.js";
import { formatReport, reconcile } from "./reconcile.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

import { resolveServerId } from "./db-import-cli-resolve.js";

const cmd = process.argv[2];

// `servers` only reads this panel's own list — it never touches the CRCON database, so it must
// not demand --crcon before it even looks at which command was given.
if (cmd === "servers") {
  const repo = await createRepository();
  const all = await repo.servers.list();
  if (all.length === 0) { console.log("This panel has no servers yet — add them in Administration → Connections first."); }
  console.log("Servers in this panel (use the NAME with --server):");
  for (const s of all) console.log(`  ${s.name}\n      id: ${s.id}   ${s.host}:${s.port}`);
  process.exit(0);
}

const crconUrl = arg("crcon") ?? fail("--crcon <postgres url of the CRCON database> is required");
const crcon = new Pool({ connectionString: crconUrl, max: 2 });

try {
  if (cmd === "inventory") {
    const inv = await inventory(crcon);
    console.log("CRCON database inventory");
    console.log("");
    console.log("server  log lines     rounds    sessions  first log            last log");
    for (const s of inv.servers) {
      console.log(
        `${(s.key || "(none)").padEnd(7)}${String(s.logLines).padStart(10)}${String(s.rounds).padStart(11)}` +
        `${String(s.sessions).padStart(12)}  ${s.firstLog ?? "-"}  ${s.lastLog ?? "-"}`,
      );
    }
    console.log("");
    for (const [t, n] of Object.entries(inv.totals)) console.log(`${t.padEnd(20)} ${n < 0 ? "missing" : n}`);
    if (inv.warnings.length) {
      console.log("");
      console.log("WARNINGS — read these before exporting:");
      for (const w of inv.warnings) console.log(`  ! ${w}`);
      process.exitCode = 2; // scriptable: a warned inventory is not a clean one
    }
  } else if (cmd === "export") {
    const serverNumber = Number(arg("server-number") ?? fail("--server-number <CRCON server number> is required"));
    const serverArg = arg("server") ?? fail("--server <this panel's server name, or its id> is required");
    if (!Number.isInteger(serverNumber)) fail("--server-number must be an integer");
    const serverId = await resolveServerId(await createRepository(), serverArg);
    // Refuse to export a server the database does not actually contain — a typo here would
    // produce a near-empty archive that a later Apply would happily import as "no history".
    const inv = await inventory(crcon);
    const present = inv.servers.find((s) => s.key === String(serverNumber));
    if (!present || (present.logLines === 0 && present.rounds === 0)) {
      fail(`server ${serverNumber} has no data in this database — inventory sees: ${inv.servers.map((s) => s.key || "(none)").join(", ") || "nothing"}`);
    }
    const file = crconBackupFile(serverId);
    // Fresh by design: the archive must describe exactly one source, not layers of two exports.
    //
    // Dedupe is scoped to the one stage that can actually repeat a key. Every other stage pages by
    // primary key, so a key cannot come round twice and tracking it buys nothing — while tracking
    // ALL of them costs one retained string per row, which on a multi-million-line log is more heap
    // than the export has, and killed a real run before it wrote anything. `standard_message` keys
    // on the message TEXT (two templates can carry the same body), so it keeps its set.
    const archive = new ArchiveWriter(file, true, new Set(["standard_message"]));
    const lastShown = new Map<string, number>();
    const counts = await exportServer({
      pool: crcon, serverNumber, archive,
      onProgress: (p) => {
        // A progress line every 50k rows per data type — enough to see a multi-million-line log
        // stage moving without drowning the terminal.
        if (p.written - (lastShown.get(p.dataType) ?? 0) >= 50_000) {
          lastShown.set(p.dataType, p.written);
          console.log(`  ${p.dataType}: ${p.written.toLocaleString()}`);
        }
      },
    });
    await archive.close();
    console.log(`exported CRCON server ${serverNumber} → ${file}`);
    for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k.padEnd(18)} ${v.toLocaleString()}`);
    console.log("");
    console.log("next: panel → Administration → Backup → Dry run (no writes); Apply only after it reads clean.");
  } else if (cmd === "reconcile") {
    const serverNumber = Number(arg("server-number") ?? fail("--server-number is required"));
    const serverArg = arg("server") ?? fail("--server <this panel's server name, or its id> is required");
    const repo = await createRepository();
    const serverId = await resolveServerId(repo, serverArg);
    const report = await reconcile(crcon, repo, serverId, serverNumber);
    console.log(formatReport(report));
    process.exitCode = report.complete ? 0 : 2; // scriptable: non-zero until provably complete
  } else {
    fail(`unknown command "${cmd ?? ""}" — use servers | inventory | export | reconcile`);
  }
} finally {
  await crcon.end();
}
