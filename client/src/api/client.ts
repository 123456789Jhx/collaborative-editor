import { isRecord } from "@collab/shared";

export type UserRole = "admin" | "user";
export type UserStatus = "active" | "readonly" | "deleted";

/** The user shape the server returns; never carries a hash or salt. */
export interface ApiUser {
  id: number;
  username: string;
  role: UserRole;
  status: UserStatus;
  createdAt: number;
}

/**
 * A failed request, carrying the server's own error code so callers can branch
 * on `USERNAME_TAKEN` rather than on a status number or a message string.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /**
     * A finer-grained reason under `code`, and the thing the UI branches on for
     * translated copy. `message` is the server's English prose, which the UI
     * shows only as a last resort.
     */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Status 0 is reserved for "the request never reached the server". */
export const NETWORK_ERROR_STATUS = 0;

async function toApiError(response: Response): Promise<ApiError> {
  let code = "UNKNOWN";
  let message = `Request failed (${response.status})`;
  let detail: string | undefined;

  try {
    const body: unknown = await response.json();
    if (isRecord(body)) {
      if (typeof body["error"] === "string") code = body["error"];
      if (typeof body["message"] === "string") message = body["message"];
      if (typeof body["detail"] === "string") detail = body["detail"];
    }
  } catch {
    // A proxy or a crash can answer with HTML. The status still tells the user
    // something useful, so fall back to the defaults rather than throwing here.
  }

  return new ApiError(response.status, code, message, detail);
}

async function send(path: string, method: string, body?: unknown): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      // The session is an httpOnly cookie, so it has to be sent explicitly and
      // is unreadable from JavaScript — which is the point.
      credentials: "same-origin",
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(NETWORK_ERROR_STATUS, "NETWORK", "Could not reach the server.");
  }

  if (!response.ok) throw await toApiError(response);
  return response;
}

function userOf(payload: unknown): ApiUser {
  if (!isRecord(payload) || !isRecord(payload["user"])) {
    throw new ApiError(200, "MALFORMED", "The server returned an unexpected response.");
  }
  return payload["user"] as unknown as ApiUser;
}

/**
 * Returns null for "not signed in" rather than throwing.
 *
 * This runs on every page load, where being signed out is the ordinary case and
 * not an error — making the caller catch a 401 to find that out would be noise.
 */
export async function fetchCurrentUser(): Promise<ApiUser | null> {
  const response = await fetch("/api/me", { credentials: "same-origin" });
  if (response.status === 401) return null;
  if (!response.ok) throw await toApiError(response);
  return userOf(await response.json());
}

export async function login(username: string, password: string): Promise<ApiUser> {
  const response = await send("/api/login", "POST", { username, password });
  return userOf(await response.json());
}

export async function register(username: string, password: string): Promise<ApiUser> {
  const response = await send("/api/register", "POST", { username, password });
  return userOf(await response.json());
}

export async function logout(): Promise<void> {
  await send("/api/logout", "POST", {});
}
