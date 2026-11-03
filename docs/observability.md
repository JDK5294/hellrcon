# Observability, Errors & Traceability

The system is getting complex, so failures must be **identifiable and isolatable fast**. This is the
convention every component follows. Two primitives live in `@app/shared`: a **structured logger**
and a **typed error taxonomy**.

## Request correlation (the key to "find it fast")
Every API request gets a **`requestId`** (UUID). It is:
- returned on **every** response as the `x-request-id` header,
- included in **every error body** (`error.requestId`),
- bound to the request's logger, so it appears on every log line for that request,
- surfaced in the web UI's error messages as `(ref <id>)`.

So when someone reports "it failed with ref `abc123`", you grep the logs for `abc123` and see the exact
request, component, params, and stack. That is the whole point.

## Errors: `@app/shared` taxonomy
Throw a typed error; the API's central handler maps it to a response and logs it.

```ts
import { errors } from "@app/shared";
throw errors.notFound("server not found");
throw errors.forbidden();
throw errors.badRequest("olderThanDays must be >= 0");
throw errors.upstream("RCON connect timed out", { serverId, host, port }); // 502, message shown
throw errors.internal("unexpected", { where: "trim" }, cause);            // 500, message NOT leaked
```

| Factory | Code | HTTP | Message exposed to client? |
|---|---|---|---|
| `badRequest` | `BAD_REQUEST` | 400 | yes |
| `unauthorized` | `UNAUTHORIZED` | 401 | yes |
| `forbidden` | `FORBIDDEN` | 403 | yes |
| `notFound` | `NOT_FOUND` | 404 | yes |
| `conflict` | `CONFLICT` | 409 | yes |
| `upstream` | `UPSTREAM_ERROR` | 502 | yes (helps operators) |
| `internal` | `INTERNAL` | 500 | **no** (generic; detail logged) |
| *(anything not an AppError)* | `INTERNAL` | 500 | **no** (never leak raw errors) |

Error body shape (always): `{ "error": { "code", "message", "requestId" } }`.

The central handler logs **5xx at `error` with the full stack**, **4xx at `warn`** (expected client
errors), so noise stays low but real failures are loud.

## Logging: `createLogger(component)`
```ts
import { createLogger } from "@app/shared";
const log = createLogger("worker");
const slog = log.child({ serverId, server: name });   // bind context once
slog.info("ingesting server");
slog.error("connection error, will reconnect", { err, reconnectMs });
```
- Components tag every line (`api`, `worker`, …) so you can filter by subsystem.
- `child(fields)` binds context (requestId, serverId, …) carried on every subsequent line.
- Pass `err` (an `Error`) and its name/message/**stack** are recorded.
- **Env:** `LOG_LEVEL` = debug|info|warn|error (default info); `LOG_FORMAT=json` for aggregators,
  otherwise a readable dev line.

## Conventions when adding code
1. **Handlers:** `throw errors.*` for expected failures; let unexpected throws bubble — the central
   handler turns them into a logged `500 INTERNAL` with a requestId. Don't `catch` just to hide.
2. **Never leak internals:** only `AppError` messages reach clients; everything else becomes
   "internal error" + a requestId (the detail is in the logs).
3. **Long-running services (workers):** use a `child` logger bound to the entity (serverId) and log
   lifecycle + errors with `{ err }`.
4. **No bare `console.log`** in app/service code — use the logger (tests may stub console).

## Audit (recheck of existing code)
- ✅ API: every request now carries a requestId + `x-request-id`; central handler logs 5xx with stack.
- ✅ **Bug fixed:** malformed JSON body returned `500` before → now `400 BAD_REQUEST`.
- ✅ RCON/upstream failures (live view, ingest) now throw `UPSTREAM_ERROR` (502) with `{serverId,host,port}`
  context and are logged, instead of an opaque message.
- ✅ Worker: structured logging with per-server `child` loggers; connection errors logged with stack +
  reconnect interval.
- ✅ rcon-core: typed `RconConnectionError` / `RconCommandError`; poll loop surfaces dead connections to
  the worker for logged reconnect.
- ⚠️ Known minor gap: `users.create` on a duplicate username currently surfaces as a logged `500`
  (traceable, but ideally a `409 CONFLICT`). Low impact (registration is rare/gated); tighten later.
- ▢ Later: rate-limit responses (`429 RATE_LIMITED`) when the API is opened up; per-request access logs
  behind `LOG_LEVEL=debug`.
