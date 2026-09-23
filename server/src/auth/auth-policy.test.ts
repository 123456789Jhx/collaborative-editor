import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";
import { ERROR_CODES } from "@collab/shared";
import { openDatabase, type Db } from "../db/schema.js";
import { SessionRepository } from "../db/session-repository.js";
import { UserRepository, type UserStatus } from "../db/user-repository.js";
import { DatabaseAuthPolicy, SESSION_COOKIE } from "./auth-policy.js";

const NOW = 1_700_000_000_000;

let db: Db;
let users: UserRepository;
let sessions: SessionRepository;
let policy: DatabaseAuthPolicy;

beforeEach(() => {
  db = openDatabase(":memory:");
  users = new UserRepository(db);
  sessions = new SessionRepository(db);
  policy = new DatabaseAuthPolicy(sessions, () => NOW);
});

/** A handshake-shaped request carrying a cookie header. */
function requestWith(cookie?: string): IncomingMessage {
  return { headers: cookie === undefined ? {} : { cookie } } as IncomingMessage;
}

function signUp(username: string): { id: number; token: string } {
  const user = users.create(username, "hunter2000", "user", NOW);
  return { id: user.id, token: sessions.create(user.id, NOW).token };
}

function setStatus(id: number, status: UserStatus): void {
  users.setStatus(id, status);
}

describe("authenticate", () => {
  it("resolves a valid session cookie", () => {
    const { id, token } = signUp("ada");
    const session = policy.authenticate(requestWith(`${SESSION_COOKIE}=${token}`));

    expect(session?.user.id).toBe(id);
    expect(session?.token).toBe(token);
  });

  it("returns null when no cookie header is present", () => {
    expect(policy.authenticate(requestWith())).toBeNull();
  });

  it("returns null for an unknown token", () => {
    expect(policy.authenticate(requestWith(`${SESSION_COOKIE}=forged`))).toBeNull();
  });

  it("returns null for a different cookie under the same header", () => {
    const { token } = signUp("ada");
    expect(policy.authenticate(requestWith(`theme=dark; other=${token}`))).toBeNull();
  });

  it("finds the session cookie alongside others", () => {
    const { token } = signUp("ada");
    const session = policy.authenticate(
      requestWith(`theme=dark; ${SESSION_COOKIE}=${token}; locale=zh`),
    );
    expect(session?.user.username).toBe("ada");
  });

  it("returns null once the session has expired", () => {
    const { token } = signUp("ada");
    const later = new DatabaseAuthPolicy(sessions, () => NOW + 40 * 24 * 60 * 60 * 1000);
    expect(later.authenticate(requestWith(`${SESSION_COOKIE}=${token}`))).toBeNull();
  });
});

describe("checkEdit", () => {
  it("allows an active user", () => {
    const { token } = signUp("ada");
    const session = policy.authenticate(requestWith(`${SESSION_COOKIE}=${token}`));
    if (session === null) throw new Error("expected a session");

    expect(policy.checkEdit(session)).toEqual({ ok: true });
  });

  it("refuses a readonly user with READ_ONLY", () => {
    const { id, token } = signUp("ada");
    const session = policy.authenticate(requestWith(`${SESSION_COOKIE}=${token}`));
    if (session === null) throw new Error("expected a session");

    setStatus(id, "readonly");

    // Re-read per call rather than trusting the `status` captured at handshake
    // time, which is what makes the demotion take effect mid-session.
    expect(policy.checkEdit(session)).toEqual({
      ok: false,
      code: ERROR_CODES.readOnly,
      message: expect.any(String),
    });
  });

  it("refuses a deleted user with ACCOUNT_DISABLED", () => {
    const { id, token } = signUp("ada");
    const session = policy.authenticate(requestWith(`${SESSION_COOKIE}=${token}`));
    if (session === null) throw new Error("expected a session");

    setStatus(id, "deleted");
    expect(policy.checkEdit(session)).toEqual({
      ok: false,
      code: ERROR_CODES.accountDisabled,
      message: expect.any(String),
    });
  });

  it("refuses a revoked session", () => {
    const { token } = signUp("ada");
    const session = policy.authenticate(requestWith(`${SESSION_COOKIE}=${token}`));
    if (session === null) throw new Error("expected a session");

    sessions.delete(token);

    // `resolveUser` returns null both for "no such session" and "no such user",
    // and the caller does not need to tell them apart — either way the socket
    // may no longer write.
    expect(policy.checkEdit(session)).toMatchObject({ ok: false, code: ERROR_CODES.accountDisabled });
  });

  it("allows editing again once a readonly user is reactivated", () => {
    const { id, token } = signUp("ada");
    const session = policy.authenticate(requestWith(`${SESSION_COOKIE}=${token}`));
    if (session === null) throw new Error("expected a session");

    setStatus(id, "readonly");
    expect(policy.checkEdit(session).ok).toBe(false);

    setStatus(id, "active");
    expect(policy.checkEdit(session)).toEqual({ ok: true });
  });
});
