import type { IncomingMessage, ServerResponse } from "node:http";
import { isRecord } from "@collab/shared";
import { SESSION_COOKIE, sessionFromRequest } from "../../auth/auth-policy.js";
import { validatePassword, validateUsername } from "../../auth/credentials.js";
import { hashPassword, verifyPassword, type PasswordRecord } from "../../auth/password.js";
import type { SessionRepository } from "../../db/session-repository.js";
import { UsernameTakenError, type User, type UserRepository } from "../../db/user-repository.js";
import { readJsonBody } from "../body.js";
import { clearCookie, serializeCookie } from "../cookies.js";
import { clientIp, RateLimiter } from "../rate-limit.js";
import { API_DETAILS, API_ERRORS, sendError, sendJson } from "../respond.js";
import type { Router } from "../router.js";

/**
 * Whether to mark the cookie `Secure`, decided per request rather than at
 * startup. A boolean would have to be configured correctly for both the public
 * https site and a local http one, and getting it wrong is silent: the browser
 * drops a Secure cookie on http, so login appears to succeed and never sticks.
 * Reading the scheme the client actually used removes the setting entirely.
 */
export type SecureCookieDecision = boolean | ((req: IncomingMessage) => boolean);

export interface AuthRoutesDeps {
  users: UserRepository;
  sessions: SessionRepository;
  secureCookies: SecureCookieDecision;
  now?: () => number;
}

/** Never let `password_hash` or `salt` reach a response body. */
function publicUser(user: User): User {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
  };
}

/**
 * A throwaway record used to spend the same scrypt time when the username does
 * not exist. Without it, "unknown user" returns in microseconds while "wrong
 * password" takes ~58 ms, and that difference is a username oracle.
 */
const DUMMY_RECORD: PasswordRecord = hashPassword("not-a-real-password");

const FIFTEEN_MINUTES = 15 * 60 * 1000;

export function registerAuthRoutes(router: Router, deps: AuthRoutesDeps): void {
  const now = deps.now ?? Date.now;

  // Two windows: one billing the source address, one billing the account. The
  // address window stops a spray across many usernames; the account window
  // stops a focused guess at one account from a rotating set of addresses.
  const byAddress = new RateLimiter({ limit: 30, windowMs: FIFTEEN_MINUTES });
  const byAccount = new RateLimiter({ limit: 10, windowMs: FIFTEEN_MINUTES });
  const registrations = new RateLimiter({ limit: 10, windowMs: 60 * 60 * 1000 });

  const isSecure = (req: IncomingMessage): boolean =>
    typeof deps.secureCookies === "function" ? deps.secureCookies(req) : deps.secureCookies;

  const issueSession = (
    req: IncomingMessage,
    res: ServerResponse,
    userId: number,
    at: number,
  ): void => {
    const session = deps.sessions.create(userId, at);
    const cookie = serializeCookie(SESSION_COOKIE, session.token, {
      secure: isSecure(req),
      maxAgeSeconds: 30 * 24 * 60 * 60,
    });
    res.setHeader("set-cookie", cookie);
  };

  router.post("/api/register", async ({ req, res }) => {
    const ip = clientIp(req);
    if (!registrations.check(ip, now())) {
      sendError(res, 429, API_ERRORS.tooManyRequests, "Too many registrations from this address");
      return;
    }

    const body = await readJsonBody(req);
    if (!body.ok || !isRecord(body.value)) {
      sendError(res, 400, API_ERRORS.badRequest, body.ok ? "Body must be an object" : body.message, {
        detail: body.ok ? API_DETAILS.bodyNotObject : API_DETAILS.bodyInvalid,
      });
      return;
    }

    const username = validateUsername(body.value["username"]);
    if (!username.ok) {
      sendError(res, 400, API_ERRORS.badRequest, username.message, { detail: username.code });
      return;
    }
    const password = validatePassword(body.value["password"]);
    if (!password.ok) {
      sendError(res, 400, API_ERRORS.badRequest, password.message, { detail: password.code });
      return;
    }

    const at = now();
    let user: User;
    try {
      // Registration is open, so every account starts as an ordinary `user`
      // with `active` status; only `seed-admin.ts` can mint an administrator.
      user = deps.users.create(username.value, password.value, "user", at);
    } catch (error) {
      if (error instanceof UsernameTakenError) {
        sendError(res, 409, API_ERRORS.usernameTaken, "That username is already taken");
        return;
      }
      throw error;
    }

    issueSession(req, res, user.id, at);
    sendJson(res, 201, { user: publicUser(user) });
  });

  router.post("/api/login", async ({ req, res }) => {
    const ip = clientIp(req);
    const body = await readJsonBody(req);
    if (!body.ok || !isRecord(body.value)) {
      sendError(res, 400, API_ERRORS.badRequest, body.ok ? "Body must be an object" : body.message, {
        detail: body.ok ? API_DETAILS.bodyNotObject : API_DETAILS.bodyInvalid,
      });
      return;
    }

    const rawUsername = body.value["username"];
    const rawPassword = body.value["password"];
    const accountKey = `${ip}|${typeof rawUsername === "string" ? rawUsername.toLowerCase() : ""}`;
    const at = now();

    if (!byAddress.check(ip, at) || !byAccount.check(accountKey, at)) {
      sendError(res, 429, API_ERRORS.tooManyRequests, "Too many attempts — try again later");
      return;
    }

    if (typeof rawUsername !== "string" || typeof rawPassword !== "string") {
      sendError(res, 400, API_ERRORS.badRequest, "Username and password are required", {
        detail: API_DETAILS.credentialsRequired,
      });
      return;
    }

    const candidate = deps.users.findByUsernameWithSecret(rawUsername);
    if (candidate === null) {
      verifyPassword(rawPassword, DUMMY_RECORD); // equalize timing, see above
      sendError(res, 401, API_ERRORS.unauthorized, "Incorrect username or password");
      return;
    }
    if (!verifyPassword(rawPassword, candidate)) {
      sendError(res, 401, API_ERRORS.unauthorized, "Incorrect username or password");
      return;
    }
    if (candidate.status === "deleted") {
      sendError(res, 403, API_ERRORS.forbidden, "This account has been removed", {
        detail: API_DETAILS.accountRemoved,
      });
      return;
    }

    const { hash: _hash, salt: _salt, ...user } = candidate;
    byAccount.reset(accountKey);
    // Opportunistic housekeeping: logins are rare enough to be a fine moment,
    // and it keeps the table from growing without a scheduled job.
    deps.sessions.purgeExpired(at);
    issueSession(req, res, user.id, at);
    sendJson(res, 200, { user: publicUser(user) });
  });

  router.post("/api/logout", ({ req, res }) => {
    const session = sessionFromRequest(req, deps.sessions, now());
    if (session !== null) deps.sessions.delete(session.token);
    // Cleared unconditionally: logging out with a stale cookie should still
    // leave the browser without one.
    res.setHeader("set-cookie", clearCookie(SESSION_COOKIE, { secure: isSecure(req) }));
    sendJson(res, 200, { ok: true });
  });

  router.get("/api/me", ({ req, res }) => {
    const session = sessionFromRequest(req, deps.sessions, now());
    if (session === null) {
      sendError(res, 401, API_ERRORS.unauthorized, "Not signed in");
      return;
    }
    sendJson(res, 200, { user: publicUser(session.user) });
  });
}
