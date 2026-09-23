import { randomBytes } from "node:crypto";
import { int } from "./row.js";
import type { Db } from "./schema.js";
import { userFromRow, type User } from "./user-repository.js";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface Session {
  token: string;
  userId: number;
  createdAt: number;
  expiresAt: number;
}

/**
 * Sessions are opaque 256-bit random tokens stored server-side. Nothing is
 * signed and nothing is self-describing, so revoking one is a `DELETE` rather
 * than a revocation list — which is what admin-driven logout needs.
 */
export class SessionRepository {
  constructor(private readonly db: Db) {}

  create(userId: number, now: number, ttlMs: number = SESSION_TTL_MS): Session {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + ttlMs;
    this.db
      .prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(token, userId, now, expiresAt);
    return { token, userId, createdAt: now, expiresAt };
  }

  /**
   * Resolves a token to the **current** user row, joining rather than caching.
   *
   * This is the mechanism behind immediate revocation: an admin flipping someone
   * to `readonly` or `deleted` changes what the next call returns, with no need
   * to track live sockets. On SQLite it is a primary-key lookup, so paying it
   * per transaction is cheaper than the bookkeeping an in-memory cache needs.
   */
  resolveUser(token: string, now: number): User | null {
    const row = this.db
      .prepare(
        `SELECT u.id, u.username, u.role, u.status, u.created_at
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token = ? AND s.expires_at > ?`,
      )
      .get(token, now);
    return row === undefined ? null : userFromRow(row);
  }

  delete(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  }

  /** Revokes every session a user holds — used when an admin disables them. */
  deleteForUser(userId: number): number {
    const result = this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    return int(result.changes);
  }

  purgeExpired(now: number): number {
    const result = this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    return int(result.changes);
  }
}
