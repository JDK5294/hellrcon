/**
 * The one copy of the HTTP-test plumbing every API suite used to carry for itself: boot the real
 * handler on an ephemeral port, hand the test its base URL (plus the repo and app context for
 * seeding and inspection), and tear it all down. A suite only defines its own wrapper now when it
 * genuinely boots differently (a pre-issued token, custom context options); extra plugins are an
 * argument here.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRepository, createIsolatedRepository } from "@app/db";
import type { Repository } from "@app/db";
import type { PluginModule } from "@app/plugin-sdk";
import { createHandler, createAppContext } from "../dist/app.js";

type AppContext = Awaited<ReturnType<typeof createAppContext>>;
type ServerFn = (base: string, repo: Repository, ctx: AppContext) => Promise<void>;

async function serve(repo: Repository, fn: ServerFn, cleanup: () => Promise<void>, plugins?: PluginModule[]): Promise<void> {
  const ctx = await createAppContext(repo, { port: 0, sessionSecret: "test", webRoot: null }, plugins);
  const handler = createHandler(ctx);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  // The phone notifications listen to the store's audit trail: stopped with the app, or a suite
  // sharing one store would gather a listener per test.
  try { await fn(`http://127.0.0.1:${port}`, repo, ctx); } finally { server.close(); ctx.phoneAlerts.stop(); await ctx.tunnel.stop(); await cleanup(); }
}

/** Boot the app on the process-shared repository (what createRepository returns for this env). */
export async function withServer(fn: ServerFn, plugins?: PluginModule[]): Promise<void> {
  const repo = await createRepository();
  await serve(repo, fn, async () => {}, plugins);
}

/** Boot the app on its own repository — its own schema against Postgres, its own store in
 *  memory — for suites whose assertions assume no other suite's rows exist. */
export async function withIsolatedServer(fn: ServerFn, plugins?: PluginModule[]): Promise<void> {
  const { repo, cleanup } = await createIsolatedRepository();
  await serve(repo, fn, cleanup, plugins);
}

/** fetch() that speaks the API's dialect: JSON in, `{ status, body }` out, non-JSON bodies as {}. */
export async function jsonFetch(url: string, opts: RequestInit = {}) {
  const res = await fetch(url, { ...opts, headers: { "content-type": "application/json", ...(opts.headers ?? {}) } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}
export const jf = jsonFetch;

/**
 * A write by someone who lacks the permission: not refused, not done — FILED for whoever holds it
 * (everything a role can be granted can be asked for). The 202 and the request it names are the
 * proof that the handler stopped at its permission check; each caller also checks that whatever the
 * write would have changed did not change.
 */
export function assertAsked(res: { status: number; body: Record<string, any> }, message?: string): void {
  if (res.status !== 202 || res.body.requested !== true || typeof res.body.requestId !== "string") {
    throw new Error(`${message ? `${message}: ` : ""}expected the write to be filed for approval (202, requested), got ${res.status} ${JSON.stringify(res.body)}`);
  }
}

/** What a filed write asks for — the permission and the server it was refused at — read back from
 *  its request as `auth` (someone who may see it: the owner sees every request). */
export async function askedFor(base: string, auth: Record<string, string>, res: { status: number; body: Record<string, any> }): Promise<{ capability: string; serverId: string | null }> {
  assertAsked(res);
  const r = await jsonFetch(`${base}/api/requests/${res.body.requestId as string}`, { headers: auth });
  const line = r.body.request?.lines?.[0];
  return { capability: line?.capability, serverId: line?.serverId ?? null };
}

/** First registration wins the owner seat; log in as them and return ready-to-spread auth headers. */
export async function ownerAuth(base: string) {
  await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  return { authorization: `Bearer ${l.body.token as string}` };
}
