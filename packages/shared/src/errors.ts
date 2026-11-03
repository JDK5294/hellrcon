/**
 * Typed error taxonomy. Every error carries a stable `code` (for identification), an HTTP
 * status, optional structured `context` (for tracing), and an `expose` flag controlling
 * whether the message is safe to return to a client. This is what makes failures
 * identifiable and isolatable instead of anonymous 500s.
 */

export interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}

export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly context: Record<string, unknown> | undefined;
  /** whether `message` is safe to show a client (false → generic message returned). */
  readonly expose: boolean;

  constructor(
    code: string,
    message: string,
    httpStatus = 500,
    context?: Record<string, unknown>,
    expose = true,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.context = context;
    this.expose = expose;
  }
}

export const errors = {
  badRequest: (message: string, context?: Record<string, unknown>) => new AppError("BAD_REQUEST", message, 400, context),
  unauthorized: (message = "unauthorized", context?: Record<string, unknown>) => new AppError("UNAUTHORIZED", message, 401, context),
  forbidden: (message = "forbidden", context?: Record<string, unknown>) => new AppError("FORBIDDEN", message, 403, context),
  notFound: (message = "not found", context?: Record<string, unknown>) => new AppError("NOT_FOUND", message, 404, context),
  conflict: (message: string, context?: Record<string, unknown>) => new AppError("CONFLICT", message, 409, context),
  /** an upstream/game-server failure (RCON, CRCON, etc.) — message is exposed to help operators. */
  upstream: (message: string, context?: Record<string, unknown>) => new AppError("UPSTREAM_ERROR", message, 502, context),
  /**
   * One of OUR reads failed (the database), and the reason is safe to show an admin. A 500 on
   * purpose, not a 502: a proxy in front (Cloudflare) replaces an origin 502 with its own page,
   * which drops the message this exists to deliver.
   */
  readFailed: (message: string, context?: Record<string, unknown>) => new AppError("READ_FAILED", message, 500, context),
  /** an unexpected internal failure — detail is logged but NOT exposed. */
  internal: (message = "internal error", context?: Record<string, unknown>, cause?: unknown) => new AppError("INTERNAL", message, 500, context, false, { cause }),
};

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/** Map any thrown value to a safe client response body + status. */
export function toErrorResponse(err: unknown, requestId?: string): { status: number; body: ErrorResponseBody } {
  if (isAppError(err)) {
    return { status: err.httpStatus, body: { error: { code: err.code, message: err.expose ? err.message : "internal error", requestId } } };
  }
  return { status: 500, body: { error: { code: "INTERNAL", message: "internal error", requestId } } };
}

/** Derive a stable error code from an HTTP status (for ad-hoc responses). */
export function codeForStatus(status: number): string {
  return (
    { 400: "BAD_REQUEST", 401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT", 429: "RATE_LIMITED", 502: "UPSTREAM_ERROR", 503: "UNAVAILABLE" }[status] ??
    (status >= 500 ? "INTERNAL" : "ERROR")
  );
}
