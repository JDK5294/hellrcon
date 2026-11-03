/**
 * Phase 1 dev harness — connect to a real server in OBSERVE mode and prove the read path:
 * fetch players + session, tail the admin log through the normalizer, and confirm that a
 * write command is refused (read-only). Never issues a state-changing command.
 *
 * Usage (from the repo root, after `pnpm build`):
 *   RCON_HOST=... RCON_PORT=... RCON_PASSWORD=... \
 *     node packages/rcon-core/dist/dev/observe.js
 *
 * A live server already running CRCON is safe to point at — observe mode cannot write.
 */
import { HLL_BINARY_V2 } from "../hll/commands.js";
import { createServerClient, ObserveModeViolation } from "@app/rcon-core";
import { normalizeLine } from "../hll/log.js";

async function main(): Promise<void> {
  const host = process.env.RCON_HOST;
  const port = Number(process.env.RCON_PORT);
  const password = process.env.RCON_PASSWORD;
  const headerMode = (process.env.RCON_HEADER_MODE as "magic" | "legacy" | undefined) ?? "magic";
  const serverId = process.env.RCON_SERVER_ID ?? "dev-server";

  if (!host || !port || !password) {
    console.error("Set RCON_HOST, RCON_PORT and RCON_PASSWORD. This connects READ-ONLY (observe mode).");
    process.exit(1);
  }

  // observe mode is the default — spelled out here for clarity.
  const client = createServerClient({ protocol: "binary-v2", engagementMode: "observe", commands: HLL_BINARY_V2 });

  console.log(`[observe] connecting to ${host}:${port} (header=${headerMode}) …`);
  await client.connect({ host, port, password, headerMode });
  console.log("[observe] connected. canWrite =", client.canWrite, "(expected: false)");

  const session = await client.readState("session");
  console.log("\n--- RAW session shape (for tuning; share this) ---\n" + JSON.stringify(session, null, 2).slice(0, 1200));

  const players = await client.readState("players");
  const count = Array.isArray((players as any)?.players) ? (players as any).players.length : "unknown";
  console.log(`\n[observe] players: ${count}`);
  console.log("--- RAW players shape (first entry) ---\n" + JSON.stringify((players as any)?.players?.[0] ?? players, null, 2).slice(0, 800));

  // The #1 unknown: the exact GetAdminLog payload shape. Dump it raw so parsing can be
  // tuned to the real server before relying on the normalizer.
  try {
    const rawLog = await client.execute("getAdminLog", { seconds: 300 });
    console.log("\n--- RAW GetAdminLog response (share this to tune parsing) ---\n" + JSON.stringify(rawLog, null, 2).slice(0, 2000));
  } catch (err) {
    console.log("[observe] getAdminLog raw read failed:", (err as Error).message);
  }

  // Prove observe mode blocks writes — this must throw, not reach the wire.
  try {
    await client.execute("messagePlayer", { playerId: "0", message: "test" });
    console.error("[observe] !! write was NOT blocked — this is a bug");
  } catch (err) {
    if (err instanceof ObserveModeViolation) console.log("[observe] write correctly refused:", err.message);
    else throw err;
  }

  console.log("[observe] tailing admin log (Ctrl+C to stop) …");
  const stop = client.streamLogs((raw) => {
    const evt = normalizeLine(raw, { serverId });
    if (evt) console.log("[evt]", evt.kind, JSON.stringify(evt));
    else console.log("[raw]", raw);
  });

  process.on("SIGINT", () => {
    stop();
    void client.disconnect().then(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("[observe] fatal:", err);
  process.exit(1);
});
