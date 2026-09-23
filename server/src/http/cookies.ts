/**
 * Minimal cookie parsing and serialization.
 *
 * Hand-rolled rather than pulling in the `cookie` package: the whole surface the
 * server needs is one name/value pair, and the runtime dependency list staying
 * at `ws` alone is worth more than the twenty lines saved.
 */

/** Returns the decoded value, or null when the cookie is absent or malformed. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;

    const raw = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      // A stray "%" makes decodeURIComponent throw; treat it as "no cookie"
      // rather than surfacing a 500 for a header the client controls.
      return null;
    }
  }
  return null;
}

export interface CookieOptions {
  /** Seconds until expiry, as the `Max-Age` attribute. */
  maxAgeSeconds?: number;
  /**
   * Adds `Secure`. Off only for local http development, where a Secure cookie
   * would be silently dropped by the browser and login would appear to succeed
   * but never stick.
   */
  secure?: boolean;
  path?: string;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? "/"}`);
  // Lax, not Strict: Strict would drop the cookie on a top-level navigation
  // into the site from an external link, logging the user out on arrival.
  // SameSite is what blocks cross-site POSTs here, since there is no separate
  // CSRF token.
  parts.push("SameSite=Lax");
  parts.push("HttpOnly");
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${options.maxAgeSeconds}`);
  if (options.secure === true) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(name: string, options: CookieOptions = {}): string {
  return serializeCookie(name, "", { ...options, maxAgeSeconds: 0 });
}
