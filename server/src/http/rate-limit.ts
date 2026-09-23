import type { IncomingMessage } from "node:http";

/**
 * Who to bill a rate limit to.
 *
 * `req.socket.remoteAddress` is useless here: the server only ever sees nginx
 * (and, on the deployed setup, cloudflared before it), so every request would
 * share one bucket and one attacker could lock out everybody.
 *
 * `CF-Connecting-IP` is set by Cloudflare's edge and is the end user's address.
 * Cloudflare overwrites it on the way in, so it cannot be spoofed from outside
 * — but it can be forged by anything that can reach nginx directly, which is
 * why these headers are only trustworthy because nginx is the sole ingress.
 */
export function clientIp(req: IncomingMessage): string {
  const cloudflare = req.headers["cf-connecting-ip"];
  if (typeof cloudflare === "string" && cloudflare !== "") return cloudflare;

  // `proxy_add_x_forwarded_for` appends to whatever the client sent, so the
  // left-most entry is the least trustworthy one — but it is the only value
  // available when the request did not come through Cloudflare.
  const forwarded = req.headers["x-forwarded-for"];
  const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof header === "string" && header !== "") {
    const first = header.split(",")[0]?.trim();
    if (first !== undefined && first !== "") return first;
  }

  return req.socket.remoteAddress ?? "unknown";
}

export interface RateLimitOptions {
  /** Attempts permitted per window. */
  limit: number;
  windowMs: number;
  /** Above this many distinct keys, expired entries are swept on the next check. */
  maxKeys?: number;
}

/**
 * A fixed-size sliding window, in memory.
 *
 * In-memory is a deliberate match for the process: `compose.yaml` pins the
 * server to a single replica, so there is no second instance to share state
 * with. If that ever changes this has to move into the database, and the
 * comment is here so that change is not forgotten.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(options: RateLimitOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  /** Records an attempt. Returns false when the caller is over the limit. */
  check(key: string, now: number): boolean {
    if (this.hits.size > this.maxKeys) this.sweep(now);

    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > cutoff);

    if (recent.length >= this.limit) {
      // Kept (not deleted) so the caller stays blocked rather than resetting
      // the window by being retried.
      this.hits.set(key, recent);
      return false;
    }

    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /** Only for tests, and for clearing a key after a successful login. */
  reset(key?: string): void {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }

  private sweep(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [key, times] of this.hits) {
      if (times.every((at) => at <= cutoff)) this.hits.delete(key);
    }
  }
}
