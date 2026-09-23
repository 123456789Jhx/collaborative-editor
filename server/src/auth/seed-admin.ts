import type { UserRepository } from "../db/user-repository.js";
import { validatePassword, validateUsername } from "./credentials.js";

export const ROOT_USERNAME_ENV = "ROOT_USERNAME";
export const ROOT_PASSWORD_ENV = "ROOT_PASSWORD";

export class MissingAdminCredentialsError extends Error {
  constructor(detail: string) {
    super(
      `Cannot create the first administrator: ${detail}\n` +
        `Set ${ROOT_USERNAME_ENV} and ${ROOT_PASSWORD_ENV} — for docker compose, put them in .env ` +
        `(see .env.example).`,
    );
    this.name = "MissingAdminCredentialsError";
  }
}

export interface SeedResult {
  username: string;
}

/**
 * Creates the first administrator from the environment, once.
 *
 * There is no fallback credential. A public deployment whose admin login
 * defaults to `root`/`root` has no admin login at all — the whole point of the
 * audit log is that only the operator can read it. So a missing or too-weak
 * environment value stops the server instead of quietly starting an open door.
 *
 * Returns null when an administrator already exists, which is the steady state
 * on every restart after the first.
 */
export function seedAdmin(
  users: UserRepository,
  env: NodeJS.ProcessEnv,
  now: number,
): SeedResult | null {
  if (users.countAdmins() > 0) return null;

  const rawUsername = env[ROOT_USERNAME_ENV];
  const rawPassword = env[ROOT_PASSWORD_ENV];
  if (rawUsername === undefined || rawUsername === "") {
    throw new MissingAdminCredentialsError(`${ROOT_USERNAME_ENV} is not set`);
  }
  if (rawPassword === undefined || rawPassword === "") {
    throw new MissingAdminCredentialsError(`${ROOT_PASSWORD_ENV} is not set`);
  }

  const username = validateUsername(rawUsername);
  if (!username.ok) {
    throw new MissingAdminCredentialsError(`${ROOT_USERNAME_ENV} is invalid: ${username.message}`);
  }
  const password = validatePassword(rawPassword);
  if (!password.ok) {
    throw new MissingAdminCredentialsError(`${ROOT_PASSWORD_ENV} is invalid: ${password.message}`);
  }

  users.create(username.value, password.value, "admin", now);
  return { username: username.value };
}
