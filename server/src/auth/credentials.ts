import { MIN_PASSWORD_LENGTH } from "./password.js";

export const MIN_USERNAME_LENGTH = 3;
export const MAX_USERNAME_LENGTH = 32;
export const MAX_PASSWORD_LENGTH = 200;

/**
 * Deliberately narrow. The username is echoed into the audit log and into the
 * admin list, so restricting it to an unambiguous character set avoids a whole
 * class of confusion (homoglyphs, leading/trailing whitespace, control chars)
 * for no real loss — nobody needs an exotic handle on this site.
 */
const USERNAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * A stable, machine-readable reason for a rejected value.
 *
 * The `message` beside it is English prose meant for logs and for anyone
 * calling the API by hand. The UI is translated, so it switches on *this*
 * instead — otherwise every reworded sentence would silently break a
 * translation, and the client would have to match on English text.
 */
export type ValidationCode =
  | "USERNAME_TOO_SHORT"
  | "USERNAME_TOO_LONG"
  | "USERNAME_INVALID"
  | "PASSWORD_TOO_SHORT"
  | "PASSWORD_TOO_LONG";

export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; code: ValidationCode; message: string };

export function validateUsername(input: unknown): Validated<string> {
  if (typeof input !== "string") {
    return { ok: false, code: "USERNAME_INVALID", message: "Username must be a string" };
  }

  const value = input.trim();
  if (value.length < MIN_USERNAME_LENGTH) {
    return {
      ok: false,
      code: "USERNAME_TOO_SHORT",
      message: `Username must be at least ${MIN_USERNAME_LENGTH} characters`,
    };
  }
  if (value.length > MAX_USERNAME_LENGTH) {
    return {
      ok: false,
      code: "USERNAME_TOO_LONG",
      message: `Username must be at most ${MAX_USERNAME_LENGTH} characters`,
    };
  }
  if (!USERNAME_PATTERN.test(value)) {
    return {
      ok: false,
      code: "USERNAME_INVALID",
      message: "Username may only contain letters, digits, dot, dash and underscore",
    };
  }
  return { ok: true, value };
}

/**
 * No composition rules (no "must contain a symbol"). Length is the only lever
 * that reliably helps, and the upper bound exists because scrypt cost scales
 * with input size — an unbounded password is a cheap way to burn server CPU.
 */
export function validatePassword(input: unknown): Validated<string> {
  if (typeof input !== "string") {
    return { ok: false, code: "PASSWORD_TOO_SHORT", message: "Password must be a string" };
  }
  if (input.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      code: "PASSWORD_TOO_SHORT",
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    };
  }
  if (input.length > MAX_PASSWORD_LENGTH) {
    return {
      ok: false,
      code: "PASSWORD_TOO_LONG",
      message: `Password must be at most ${MAX_PASSWORD_LENGTH} characters`,
    };
  }
  return { ok: true, value: input };
}
