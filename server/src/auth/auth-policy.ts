import type { IncomingMessage } from "node:http";
import { ERROR_CODES } from "@collab/shared";
import { readCookie } from "../http/cookies.js";
import type { SessionRepository } from "../db/session-repository.js";
import type { User } from "../db/user-repository.js";

export const SESSION_COOKIE = "collab_session";

/** What `authenticate` hands back and every later check is made against. */
export interface AuthSession {
  token: string;
  user: User;
}

export type EditVerdict = { ok: true } | { ok: false; code: string; message: string };

/**
 * The seam that keeps authorization out of the collaboration core.
 *
 * `createCollabServer` takes this as an optional dependency. When it is omitted
 * the server behaves exactly as it did before auth existed — anyone may connect
 * and edit — which is what lets the existing WebSocket integration tests keep
 * testing the protocol without carrying a database around. Production always
 * supplies `DatabaseAuthPolicy`; `server.ts` is the only place that decides which.
 */
export interface AuthPolicy {
  /** Once per WebSocket handshake, where the browser has already sent the cookie. */
  authenticate(request: IncomingMessage): AuthSession | null;
  /**
   * Before every transaction. Takes the session rather than the `User` so the
   * implementation can re-read the row: an admin demoting someone to read-only
   * must take effect on that person's next keystroke, not their next reconnect.
   */
  checkEdit(session: AuthSession): EditVerdict;
}

/**
 * Shared by the WebSocket handshake and the HTTP routes, so "who is this
 * request" is answered in exactly one place.
 */
export function sessionFromRequest(
  request: IncomingMessage,
  sessions: SessionRepository,
  now: number,
): AuthSession | null {
  const token = readCookie(request.headers.cookie, SESSION_COOKIE);
  if (token === null) return null;

  const user = sessions.resolveUser(token, now);
  return user === null ? null : { token, user };
}

export class DatabaseAuthPolicy implements AuthPolicy {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly now: () => number = Date.now,
  ) {}

  authenticate(request: IncomingMessage): AuthSession | null {
    return sessionFromRequest(request, this.sessions, this.now());
  }

  checkEdit(session: AuthSession): EditVerdict {
    // Re-resolved on every transaction. This one indexed lookup is what makes
    // `readonly` and `deleted` take effect without tracking live sockets.
    const current = this.sessions.resolveUser(session.token, this.now());
    if (current === null) {
      // The session was revoked — most likely because an admin deleted the user.
      return {
        ok: false,
        code: ERROR_CODES.accountDisabled,
        message: "Session is no longer valid",
      };
    }

    if (current.status === "deleted") {
      return { ok: false, code: ERROR_CODES.accountDisabled, message: "Account is disabled" };
    }
    if (current.status === "readonly") {
      return { ok: false, code: ERROR_CODES.readOnly, message: "Account is read-only" };
    }
    return { ok: true };
  }
}
