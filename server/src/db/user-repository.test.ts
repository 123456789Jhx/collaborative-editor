import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "./schema.js";
import { UsernameTakenError, UserRepository } from "./user-repository.js";

const NOW = 1_700_000_000_000;

let db: Db;
let users: UserRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  users = new UserRepository(db);
});

describe("create", () => {
  it("stores a user and returns it without the secret material", () => {
    const user = users.create("ada", "hunter2000", "user", NOW);

    expect(user).toEqual({
      id: expect.any(Number),
      username: "ada",
      role: "user",
      status: "active",
      createdAt: NOW,
    });
    expect(user).not.toHaveProperty("hash");
    expect(user).not.toHaveProperty("salt");
  });

  it("never writes the plaintext password", () => {
    users.create("ada", "hunter2000", "user", NOW);
    const row = db.prepare("SELECT password_hash, salt FROM users WHERE username = 'ada'").get();

    expect(row?.["password_hash"]).not.toContain("hunter2000");
    expect(String(row?.["password_hash"])).toMatch(/^[0-9a-f]{128}$/);
  });

  it("rejects a duplicate username, case-insensitively", () => {
    users.create("ada", "hunter2000", "user", NOW);

    // COLLATE NOCASE on the column, not a lower-cased application value: without
    // it "Ada" and "ada" would be two accounts, and the audit log could not tell
    // which one it was recording.
    expect(() => users.create("Ada", "different1", "user", NOW)).toThrow(UsernameTakenError);
    expect(() => users.create("ADA", "different1", "user", NOW)).toThrow(UsernameTakenError);
    expect(users.list()).toHaveLength(1);
  });

  it("ignores an attempted duplicate that only differs by case in the input", () => {
    users.create("ada", "hunter2000", "user", NOW);
    expect(users.findByUsernameWithSecret("aDa")?.username).toBe("ada");
  });
});

describe("findByUsernameWithSecret", () => {
  it("returns the record needed to verify a password", () => {
    users.create("ada", "hunter2000", "user", NOW);
    const found = users.findByUsernameWithSecret("ada");

    expect(found?.hash).toMatch(/^[0-9a-f]{128}$/);
    expect(found?.salt).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns null for an unknown user", () => {
    expect(users.findByUsernameWithSecret("nobody")).toBeNull();
  });
});

describe("setStatus", () => {
  it("flips a user to readonly", () => {
    const user = users.create("ada", "hunter2000", "user", NOW);
    expect(users.setStatus(user.id, "readonly")).toBe(true);
    expect(users.findById(user.id)?.status).toBe("readonly");
  });

  it("returns false for an unknown id", () => {
    expect(users.setStatus(9999, "deleted")).toBe(false);
  });

  it("keeps a deleted user's row so the audit trail still resolves", () => {
    const user = users.create("ada", "hunter2000", "user", NOW);
    users.setStatus(user.id, "deleted");

    // Soft delete: the row survives, so `audit_log.user_id` still points at a
    // real username and the name stays taken.
    expect(users.findById(user.id)?.status).toBe("deleted");
    expect(users.findById(user.id)?.username).toBe("ada");
    expect(() => users.create("ada", "hunter2000", "user", NOW)).toThrow(UsernameTakenError);
  });

  it("can restore a readonly user to active", () => {
    const user = users.create("ada", "hunter2000", "user", NOW);
    users.setStatus(user.id, "readonly");
    users.setStatus(user.id, "active");
    expect(users.findById(user.id)?.status).toBe("active");
  });
});

describe("countAdmins", () => {
  it("is zero on an empty database", () => {
    expect(users.countAdmins()).toBe(0);
  });

  it("counts only administrators", () => {
    users.create("ada", "hunter2000", "admin", NOW);
    users.create("bob", "hunter2000", "user", NOW);
    expect(users.countAdmins()).toBe(1);
  });

  it("stops counting an administrator who has been deleted", () => {
    const admin = users.create("ada", "hunter2000", "admin", NOW);
    users.setStatus(admin.id, "deleted");

    // This is what lets `seedAdmin` decide to mint a fresh administrator rather
    // than leaving the deployment with nobody able to reach the audit log.
    expect(users.countAdmins()).toBe(0);
  });
});

describe("list", () => {
  it("returns users in creation order without secrets", () => {
    users.create("ada", "hunter2000", "admin", NOW);
    users.create("bob", "hunter2000", "user", NOW + 1);

    const listed = users.list();
    expect(listed.map((user) => user.username)).toEqual(["ada", "bob"]);
    expect(listed[0]).not.toHaveProperty("hash");
  });
});
