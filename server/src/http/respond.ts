import type { ServerResponse } from "node:http";

/**
 * The HTTP surface's own vocabulary, kept separate from the WebSocket
 * `ERROR_CODES` in `@collab/shared`. They describe different failure domains:
 * those are "this transaction is invalid", these are "this request failed".
 */
export const API_ERRORS = {
  badRequest: "BAD_REQUEST",
  unauthorized: "UNAUTHORIZED",
  forbidden: "FORBIDDEN",
  notFound: "NOT_FOUND",
  usernameTaken: "USERNAME_TAKEN",
  tooManyRequests: "TOO_MANY_REQUESTS",
  internal: "INTERNAL",
} as const;

/**
 * Details for failures that have no dedicated `API_ERRORS` code. Validation
 * failures carry their own code from `credentials.ts` instead.
 */
export const API_DETAILS = {
  bodyNotObject: "BODY_NOT_OBJECT",
  bodyInvalid: "BODY_INVALID",
  credentialsRequired: "CREDENTIALS_REQUIRED",
  accountRemoved: "ACCOUNT_REMOVED",
} as const;

export function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  cookies: readonly string[] = [],
): void {
  const body = JSON.stringify(payload);
  const headers: Record<string, string | string[]> = {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    // Every response here is identity- or document-dependent. `no-store` keeps
    // a shared cache from handing one user's `/api/me` to another.
    "cache-control": "no-store",
  };
  if (cookies.length > 0) headers["set-cookie"] = [...cookies];

  res.writeHead(status, headers);
  res.end(body);
}

/**
 * `detail` is a finer-grained, machine-readable reason under a coarse `code`:
 * `BAD_REQUEST` covers five different validation failures, and a translated UI
 * needs to tell them apart without matching on English prose.
 */
export interface ErrorOptions {
  detail?: string;
  cookies?: readonly string[];
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  options: ErrorOptions = {},
): void {
  sendJson(
    res,
    status,
    options.detail === undefined
      ? { error: code, message }
      : { error: code, message, detail: options.detail },
    options.cookies ?? [],
  );
}

/** Distinguishes "matched no route" (404) from "matched, wrong method" (405). */
export function sendNotFound(res: ServerResponse): void {
  sendError(res, 404, API_ERRORS.notFound, "No such endpoint");
}

export function sendMethodNotAllowed(res: ServerResponse): void {
  sendError(res, 405, API_ERRORS.badRequest, "Method not allowed");
}
