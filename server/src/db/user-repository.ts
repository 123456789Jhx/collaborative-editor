import { hashPassword, type PasswordRecord } from "../auth/password.js";
import { int, text } from "./row.js";
import type { Db } from "./schema.js";

export type UserRole = "admin" | "user";

/**
 * `readonly` is enforced per transaction rather than at connection time, so an
 * admin flipping this value takes effect on the user's next keystroke without
 * needing to bounce their socket.
 *
 * `deleted` is a soft delete on purpose: a hard `DELETE` would leave the audit
 * log pointing at nothing, and the username would become re-registrable, which
 * is exactly how someone inherits another person's history.
 */
export type UserStatus = "active" | "readonly" | "deleted";

export interface User {
  id: number;
  username: string;
  role: UserRole;
  status: UserStatus;
  createdAt: number;
}

/** A user row together with the material needed to verify a password. */
export interface UserWithSecret extends User, PasswordRecord {}

export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`username already taken: ${username}`);
    this.name = "UsernameTakenError";
  }
}

function toRole(value: string): UserRole {
  return value === "admin" ? "admin" : "user";
}

function toStatus(value: string): UserStatus {
  if (value === "readonly" || value === "deleted") return value;
  return "active";
}

/** Exported so the session repository can map its `users` JOIN with the same rules. */
export function userFromRow(row: Record<string, unknown>): User {
  return {
    id: int(row["id"]),
    username: text(row["username"]),
    role: toRole(text(row["role"])),
    status: toStatus(text(row["status"])),
    createdAt: int(row["created_at"]),
  };
}

const USER_COLUMNS = "id, username, role, status, created_at";

export class UserRepository {
  constructor(private readonly db: Db) {}

  /**
   * `now` is injected so tests can place rows at known times without fake timers.
   */
  create(username: string, password: string, role: UserRole, now: number): User {
    const { hash, salt } = hashPassword(password);
    try {
      const result = this.db
        .prepare(
          "INSERT INTO users (username, password_hash, salt, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
        )
        .run(username, hash, salt, role, now);
      const id = int(result.lastInsertRowid);
      return { id, username, role, status: "active", createdAt: now };
    } catch (error) {
      // Relies on the UNIQUE COLLATE NOCASE index rather than a prior SELECT:
      // a check-then-insert would race against a concurrent registration.
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw new UsernameTakenError(username);
      }
      throw error;
    }
  }

  /** Case-insensitive, matching the column's COLLATE NOCASE. */
  findByUsernameWithSecret(username: string): UserWithSecret | null {
    const row = this.db
      .prepare(
        `SELECT ${USER_COLUMNS}, password_hash, salt FROM users WHERE username = ? COLLATE NOCASE`,
      )
      .get(username);
    if (row === undefined) return null;
    return {
      ...userFromRow(row),
      hash: text(row["password_hash"]),
      salt: text(row["salt"]),
    };
  }

  findById(id: number): User | null {
    const row = this.db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id);
    return row === undefined ? null : userFromRow(row);
  }

  list(): User[] {
    return this.db
      .prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY id`)
      .all()
      .map((row) => userFromRow(row));
  }

  /** Returns false when no such user exists. */
  setStatus(id: number, status: UserStatus): boolean {
    const result = this.db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, id);
    return int(result.changes) > 0;
  }

  countAdmins(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status != 'deleted'")
      .get();
    return row === undefined ? 0 : int(row["n"]);
  }
}
