/**
 * Run a route handler with no HTTP around it, and hand back what it would have answered.
 *
 * An approved request for a server-scoped write IS the call that was refused, so applying it means
 * calling the same handler again — but there is no socket this time, and nobody to send a status
 * line to. So the request is a readable stream over the stored body (which is all `readJsonBody`
 * wants) and the response is a bucket that remembers the status and the payload.
 *
 * The handler's own refusals are the point of catching them: "that map is not in the rotation any
 * more" is exactly what an approver needs to read on the line, hours after somebody asked. Only
 * the message survives, because that is what the line has room for and what the panel prints.
 */
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerRow } from "@app/db";
import type { AppContext } from "./context.js";
import type { Principal } from "./auth.js";
import type { Handler, ServerRouteHandler } from "./routes/kit.js";
import { requestScope, type RequestScope } from "./request-scope.js";

/** A response that goes nowhere, and remembers what was written to it. */
class Collected {
  statusCode = 200;
  headersSent = false;
  body = "";
  writeHead(status: number): this { this.statusCode = status; this.headersSent = true; return this; }
  setHeader(): this { return this; }
  getHeader(): undefined { return undefined; }
  end(chunk?: unknown): this { if (typeof chunk === "string") this.body += chunk; return this; }
  write(chunk?: unknown): boolean { if (typeof chunk === "string") this.body += chunk; return true; }
  on(): this { return this; }
  once(): this { return this; }
  destroy(): this { return this; }
}

/**
 * The provenance a replayed call carries into whatever it records.
 *
 * The handler writes its OWN audit row, under the name it is handed — so without this, an approved
 * map-vote skip would read on the requester's profile as something they simply did, with no trace
 * of the request it came through or the person who signed it. Player actions thread exactly this
 * through (`data.requestId`, `data.approvedBy`, "(approved by X)" on the summary); intercepting
 * `audit.create` for the length of the replay is how the same record reaches rows this executor
 * does not write itself.
 */
export interface ReplayProvenance { suffix: string; data: Record<string, unknown> }

/** `ctx` with every audit row the replay writes stamped with where it came from. */
function withProvenance(ctx: AppContext, prov: ReplayProvenance | null): AppContext {
  if (!prov) return ctx;
  const audit = ctx.repo.audit;
  return {
    ...ctx,
    repo: {
      ...ctx.repo,
      audit: {
        ...audit,
        create: (input) => audit.create({
          ...input,
          summary: `${input.summary}${prov.suffix}`,
          data: { ...(input.data ?? {}), ...prov.data },
        }),
      },
    },
  };
}

/**
 * What a replay came to. `error` is null when the handler did the thing, else the sentence for the
 * line. `refused` is set when it stopped at a write permission the signer lacks — the request
 * builder asks for that permission instead of recording a failure.
 */
export interface ReplayOutcome { error: string | null; refused?: { capability: string; serverId: string | null } }

interface ReplayCall {
  ctx: AppContext; p: Principal; params: Record<string, string>; url: string; method: string; body: unknown;
  /** The route pattern the call was filed from (`/api/servers/:id/...`). */
  path: string;
  provenance?: ReplayProvenance | null;
}

/**
 * The request a handler is handed, and the scope it runs in: the principal handed in (so the
 * handler's own requirePrincipal returns it, with no session to look up), and `replay` set, so a
 * refusal refuses rather than filing the call all over again.
 */
async function replay(what: ReplayCall, run: (req: IncomingMessage, res: ServerResponse, ctx: AppContext) => Promise<void> | void): Promise<ReplayOutcome> {
  // A BUFFER, not a string: `readJsonBody` concatenates the chunks, and Buffer.concat refuses a
  // string outright — a body that arrived over a socket is always bytes.
  const req = Readable.from([Buffer.from(JSON.stringify(what.body ?? {}), "utf8")]) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> };
  req.url = what.url;
  req.method = what.method;
  req.headers = { "content-type": "application/json" };
  const res = new Collected();
  const ctx = withProvenance(what.ctx, what.provenance ?? null);
  const scope: RequestScope = { ask: { method: what.method, path: what.path, params: what.params, req, ctx }, principal: what.p, replay: true };
  try {
    await requestScope.run(scope, () => run(req, res as unknown as ServerResponse, ctx));
  } catch (err) {
    return { error: (err as Error).message || "the action failed" };
  }
  if (res.statusCode < 400) return { error: null };
  const parsed = (() => { try { return JSON.parse(res.body) as { error?: { message?: string } }; } catch { return null; } })();
  return { error: parsed?.error?.message || `the action was refused (${res.statusCode})`, ...(scope.refused ? { refused: scope.refused } : {}) };
}

/** Replay a call filed through the server wrapper: its handler takes the server already resolved. */
export function replayHandler(
  handler: ServerRouteHandler,
  what: ReplayCall & { server: ServerRow; id: string },
): Promise<ReplayOutcome> {
  return replay(what, (req, res, ctx) => handler({ req, res, ctx, params: what.params, p: what.p, id: what.id, server: what.server }));
}

/** Replay a call filed from inside a plain route: the handler resolves everything itself. */
export function replayPlainHandler(handler: Handler, what: ReplayCall): Promise<ReplayOutcome> {
  return replay(what, (req, res, ctx) => handler(req, res, ctx, what.params));
}
