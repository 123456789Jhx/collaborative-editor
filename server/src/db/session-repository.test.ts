import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "./schema.js";
import { SESSION_TTL_MS, SessionRepository } from "./session-repository.js";
import { UserRepository } from "./user-repository.js";

const NOW = 1_700_000_000_000;

let db: Db;
let users: UserRepository;
let sessions: SessionRepository;
let userId: number;

beforeEach(() => {
  db = openDatabase(":memory:");
  users = new UserRepository(db);
  sessions = new SessionRepository(db);
  userId = users.create("ada", "hunter2000", "user", NOW).id;
});

describe("create", () => {
  it("issues an opaque token and stores it server-side", () => {
    const session = sessions.create(userId, NOW);

    // 43 base64url characters is exactly 32 random bytes, and the alphabet is
    // shared with the id: nothing here is a payload, a claim, or a signature.
    // Opacity is the whole design — it is what makes revocation a DELETE rather
    // than a denylist, and what stops anyone reading a user id out of a token.
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.expiresAt).toBe(NOW + SESSION_TTL_MS);
  });

  it("issues a distinct token per call", () => {
    expect(sessions.create(userId, NOW).token).not.toBe(sessions.create(userId, NOW).token);
  });
});

describe("resolveUser", () => {
  it("resolves a live token to the current user row", () => {
    const { token } = sessions.create(userId, NOW);
    const user = sessions.resolveUser(token, NOW + 1000);

    expect(user?.id).toBe(userId);
    expect(user?.username).toBe("ada");
    expect(user).not.toHaveProperty("hash");
  });

  it("returns null for an unknown token", () => {
    expect(sessions.resolveUser("not-a-token", NOW)).toBeNull();
  });

  it("returns null once expired, and not one millisecond before", () => {
    const { token } = sessions.create(userId, NOW, 60_000);

    expect(sessions.resolveUser(token, NOW + 59_999)?.id).toBe(userId);
    expect(sessions.resolveUser(token, NOW + 60_000)).toBeNull();
  });

  it("reflects a status change immediately, with no second lookup", () => {
    const { token } = sessions.create(userId, NOW);
    expect(sessions.resolveUser(token, NOW)?.status).toBe("active");

    users.setStatus(userId, "readonly");

    // The join is the whole mechanism behind "an admin flip takes effect on the
    // next transaction": nothing is cached on the socket.
    expect(sessions.resolveUser(token, NOW)?.status).toBe("readonly");
  });
});

describe("delete", () => {
  it("revokes exactly one session", () => {
    const first = sessions.create(userId, NOW);
    const second = sessions.create(userId, NOW);

    sessions.delete(first.token);
    expect(sessions.resolveUser(first.token, NOW)).toBeNull();
    expect(sessions.resolveUser(second.token, NOW)?.id).toBe(userId);
  });
});

describe("deleteForUser", () => {
  it("revokes every session the user holds", () => {
    sessions.create(userId, NOW);
    sessions.create(userId, NOW);
    const other = users.create("bob", "hunter2000", "user", NOW).id;
    const kept = sessions.create(other, NOW);

    expect(sessions.deleteForUser(userId)).toBe(2);
    expect(sessions.resolveUser(kept.token, NOW)?.id).toBe(other);
  });
});

describe("purgeExpired", () => {
  it("removes only the expired rows", () => {
    const stale = sessions.create(userId, NOW, 1000);
    const live = sessions.create(userId, NOW, 60_000);

    expect(sessions.purgeExpired(NOW + 5000)).toBe(1);
    expect(sessions.resolveUser(stale.token, NOW + 5000)).toBeNull();
    expect(sessions.resolveUser(live.token, NOW + 5000)?.id).toBe(userId);
  });
});

describe("foreign keys", () => {
  it("cascades a hard user delete into sessions", () => {
    // Production never hard-deletes a user — this asserts the schema's own
    // invariant, which is what keeps a stray row from outliving its owner.
    sessions.create(userId, NOW);
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);

    const row = db.prepare("SELECT COUNT(*) AS n FROM sessions").get();
    expect(row?.["n"]).toBe(0);
  });
});
