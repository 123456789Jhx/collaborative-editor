import type { IncomingMessage, ServerResponse } from "node:http";
import { API_ERRORS, sendError, sendJson, sendMethodNotAllowed, sendNotFound } from "./respond.js";

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Readonly<Record<string, string>>;
}

export type Handler = (ctx: RequestContext) => Promise<void> | void;

interface Route {
  method: string;
  segments: readonly string[];
  handler: Handler;
}

function splitPath(pathname: string): string[] {
  return pathname.split("/").filter((segment) => segment !== "");
}

/**
 * A method-and-path table, which is the whole of what this API needs.
 *
 * No Express: the surface is a handful of JSON endpoints under one prefix, and
 * the framework would contribute routing we can write in forty lines plus a
 * dependency tree we would then have to keep patched.
 *
 * Patterns use `:name` for one segment. There is no wildcard or regex support
 * on purpose — nothing here needs it, and it keeps matching trivially auditable.
 */
export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method: method.toUpperCase(), segments: splitPath(pattern), handler });
  }

  get(pattern: string, handler: Handler): void {
    this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: Handler): void {
    this.add("POST", pattern, handler);
  }

  patch(pattern: string, handler: Handler): void {
    this.add("PATCH", pattern, handler);
  }

  /** Returns true when a route handled the request. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://internal");
    const segments = splitPath(url.pathname);
    const method = (req.method ?? "GET").toUpperCase();

    let pathMatched = false;

    for (const route of this.routes) {
      const params = matchSegments(route.segments, segments);
      if (params === null) continue;
      pathMatched = true;
      if (route.method !== method) continue;

      try {
        await route.handler({ req, res, url, params });
      } catch (error) {
        // A handler that throws must not take the process down, and must not
        // leak the stack to the client.
        console.error("[http] unhandled error in route", url.pathname, error);
        if (!res.headersSent) {
          sendError(res, 500, API_ERRORS.internal, "Internal error");
        } else {
          res.end();
        }
      }
      return true;
    }

    // Distinguishing these matters when debugging: a 404 means the nginx or the
    // route table is wrong, a 405 means only the verb is.
    if (pathMatched) sendMethodNotAllowed(res);
    else sendNotFound(res);
    return false;
  }
}

function matchSegments(
  pattern: readonly string[],
  actual: readonly string[],
): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const expected = pattern[i];
    const value = actual[i];
    if (expected === undefined || value === undefined) return null;

    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(value);
      continue;
    }
    if (expected !== value) return null;
  }
  return params;
}

/** Shared by the routes: 401 with the shape the client already understands. */
export function sendUnauthorized(res: ServerResponse): void {
  sendError(res, 401, API_ERRORS.unauthorized, "Not signed in");
}

export function sendOk(res: ServerResponse, payload: unknown): void {
  sendJson(res, 200, payload);
}
