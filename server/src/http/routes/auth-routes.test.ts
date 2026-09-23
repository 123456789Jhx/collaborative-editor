import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../../db/schema.js";
import { SessionRepository } from "../../db/session-repository.js";
import { UserRepository } from "../../db/user-repository.js";
import { Router } from "../router.js";
import { API_ERRORS } from "../respond.js";
import { registerAuthRoutes, type SecureCookieDecision } from "./auth-routes.js";

const NOW = 1_700_000_000_000;

let db: Db;
let users: UserRepository;
let sessions: SessionRepository;
let server: Server | undefined;
let base: string;
let clock = NOW;

interface Setup {
  secureCookies?: SecureCookieDecision;
}

beforeEach(async () => {
  clock = NOW;
  db = openDatabase(":memory:");
  users = new UserRepository(db);
  sessions = new SessionRepository(db);
  server = undefined;
  base = "";
});

async function start(options: Setup = {}): Promise<void> {
  const router = new Router();
  registerAuthRoutes(router, {
    users,
    sessions,
    secureCookies: options.secureCookies ?? false,
    now: () => clock,
  });
  const created = createServer((req, res) => {
    void router.handle(req, res);
  });
  created.listen(0);
  await once(created, "listening");
  server = created;
  base = `http://127.0.0.1:${(created.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server === undefined) return;
  server.closeIdleConnections();
  server.close();
  await once(server, "close");
});

/** Only ever one cookie is set per response, so the raw header is enough. */
function sessionCookieOf(response: Response): string | null {
  const header = response.headers.get("set-cookie");
  return header === null ? null : header.split(";")[0] ?? null;
}

function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function register(username: string, password = "hunter2000"): Promise<string> {
  const response = await post("/api/register", { username, password });
  expect(response.status).toBe(201);
  const cookie = sessionCookieOf(response);
  if (cookie === null) throw new Error("register did not set a session cookie");
  return cookie;
}

describe("POST /api/register", () => {
  beforeEach(() => start());

  it("creates a user and signs them in", async () => {
    const response = await post("/api/register", { username: "ada", password: "hunter2000" });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      user: {
        id: expect.any(Number),
        username: "ada",
        role: "user",
        status: "active",
        createdAt: NOW,
      },
    });
    expect(users.findByUsernameWithSecret("ada")).not.toBeNull();
  });

  it("never puts the hash or salt in the response", async () => {
    const response = await post("/api/register", { username: "ada", password: "hunter2000" });
    const body = await response.text();

    expect(body).not.toContain("hash");
    expect(body).not.toContain("salt");
  });

  it("sets an httpOnly, same-site cookie", async () => {
    const response = await post("/api/register", { username: "ada", password: "hunter2000" });
    const header = response.headers.get("set-cookie") ?? "";

    // httpOnly keeps the token out of reach of any script on the page; Lax is
    // what stands in for a CSRF token, since there is no separate one.
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
  });

  it("omits Secure over plain http, where the browser would drop it", async () => {
    const response = await post("/api/register", { username: "ada", password: "hunter2000" });
    expect(response.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("rejects a username already taken, whatever the case", async () => {
    await register("ada");
    const response = await post("/api/register", { username: "ADA", password: "hunter2000" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: API_ERRORS.usernameTaken });
  });

  // The third column is `detail`, which is what a translated client branches on
  // — `BAD_REQUEST` alone does not say which of these five went wrong.
  it.each([
    ["a short username", { username: "ab", password: "hunter2000" }, "USERNAME_TOO_SHORT"],
    [
      "a long username",
      { username: "a".repeat(33), password: "hunter2000" },
      "USERNAME_TOO_LONG",
    ],
    ["a username with a space", { username: "a b", password: "hunter2000" }, "USERNAME_INVALID"],
    ["a short password", { username: "ada", password: "abc" }, "PASSWORD_TOO_SHORT"],
    [
      "a long password",
      { username: "ada", password: "x".repeat(201) },
      "PASSWORD_TOO_LONG",
    ],
    ["a missing password", { username: "ada" }, "PASSWORD_TOO_SHORT"],
    ["a non-string password", { username: "ada", password: 12345678 }, "PASSWORD_TOO_SHORT"],
  ])("rejects %s", async (_label, body, detail) => {
    const response = await post("/api/register", body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ detail });
    expect(users.list()).toHaveLength(0);
  });

  it("rejects a body that is not JSON", async () => {
    const response = await post("/api/register", "{not json");
    expect(response.status).toBe(400);
  });

  it("rejects an empty body", async () => {
    const response = await post("/api/register", "");
    expect(response.status).toBe(400);
  });

  it("refuses an oversized body instead of buffering it", async () => {
    const huge = JSON.stringify({ username: "ada", password: "x".repeat(20_000) });

    let status = -1;
    try {
      status = (await post("/api/register", huge)).status;
    } catch {
      // Destroying the socket mid-upload is the intended defence; the assertion
      // that matters is the one below.
    }

    expect(status).not.toBe(201);
    expect(users.list()).toHaveLength(0);
  });

  it("gives every browser its own session", async () => {
    const first = await register("ada");
    const second = await register("bob");
    expect(first).not.toBe(second);
  });
});

describe("POST /api/login", () => {
  beforeEach(() => start());

  it("signs in with the right password", async () => {
    await register("ada");
    const response = await post("/api/login", { username: "ada", password: "hunter2000" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { username: "ada", role: "user" } });
    expect(sessionCookieOf(response)).not.toBeNull();
  });

  it("accepts the username in any case", async () => {
    await register("ada");
    expect((await post("/api/login", { username: "ADA", password: "hunter2000" })).status).toBe(200);
  });

  it("rejects the wrong password without setting a cookie", async () => {
    await register("ada");
    const response = await post("/api/login", { username: "ada", password: "wrongwrong" });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: API_ERRORS.unauthorized });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("answers an unknown user exactly as it answers a wrong password", async () => {
    await register("ada");
    const unknown = await post("/api/login", { username: "nobody", password: "hunter2000" });
    const wrong = await post("/api/login", { username: "ada", password: "wrongwrong" });

    // Identical status *and* body: anything that differs lets an attacker
    // enumerate which usernames exist.
    expect(unknown.status).toBe(wrong.status);
    expect(await unknown.json()).toEqual(await wrong.json());
  });

  it("refuses a deleted account", async () => {
    await register("ada");
    users.setStatus(users.list()[0]?.id ?? 0, "deleted");

    const response = await post("/api/login", { username: "ada", password: "hunter2000" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "FORBIDDEN", detail: "ACCOUNT_REMOVED" });
  });

  it("still lets a readonly account sign in — it may read", async () => {
    await register("ada");
    users.setStatus(users.list()[0]?.id ?? 0, "readonly");

    expect((await post("/api/login", { username: "ada", password: "hunter2000" })).status).toBe(200);
  });

  it("asks for credentials when a field is missing", async () => {
    const response = await post("/api/login", { username: "ada" });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ detail: "CREDENTIALS_REQUIRED" });
  });

  it("throttles repeated guesses at one account", async () => {
    await register("ada");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await post("/api/login", { username: "ada", password: "wrongwrong" });
    }

    const response = await post("/api/login", { username: "ada", password: "wrongwrong" });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: API_ERRORS.tooManyRequests });
  });

  it("lets a successful login clear the throttle for that account", async () => {
    await register("ada");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await post("/api/login", { username: "ada", password: "wrongwrong" });
    }

    expect((await post("/api/login", { username: "ada", password: "hunter2000" })).status).toBe(200);
    expect((await post("/api/login", { username: "ada", password: "hunter2000" })).status).toBe(200);
  });

  it("keeps counting after the throttle trips", async () => {
    await register("ada");
    for (let attempt = 0; attempt < 11; attempt += 1) {
      await post("/api/login", { username: "ada", password: "wrongwrong" });
    }

    // The window slides rather than resetting on retry, so being blocked cannot
    // be escaped by simply waiting less than the window.
    expect((await post("/api/login", { username: "ada", password: "wrongwrong" })).status).toBe(429);
    clock += 15 * 60 * 1000 + 1;
    expect((await post("/api/login", { username: "ada", password: "wrongwrong" })).status).toBe(401);
  });
});

describe("GET /api/me", () => {
  beforeEach(() => start());

  it("returns the signed-in user", async () => {
    const cookie = await register("ada");
    const response = await fetch(`${base}/api/me`, { headers: { cookie } });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { username: "ada", role: "user" } });
  });

  it("answers 401 without a cookie", async () => {
    const response = await fetch(`${base}/api/me`);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: API_ERRORS.unauthorized });
  });

  it("answers 401 for a forged token", async () => {
    const response = await fetch(`${base}/api/me`, { headers: { cookie: "collab_session=forged" } });
    expect(response.status).toBe(401);
  });

  it("reflects a status change without a new login", async () => {
    const cookie = await register("ada");
    users.setStatus(users.list()[0]?.id ?? 0, "readonly");

    const response = await fetch(`${base}/api/me`, { headers: { cookie } });
    expect(await response.json()).toMatchObject({ user: { status: "readonly" } });
  });

  it("marks the response uncacheable", async () => {
    const cookie = await register("ada");
    const response = await fetch(`${base}/api/me`, { headers: { cookie } });

    // Without this a shared cache could hand one user's identity to another.
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("POST /api/logout", () => {
  beforeEach(() => start());

  it("revokes the session and clears the cookie", async () => {
    const cookie = await register("ada");
    const response = await post("/api/logout", {}, cookie);

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    // Revoked server-side, so a copy of the cookie taken before logout is dead
    // too — clearing it in the browser alone would not be enough.
    expect((await fetch(`${base}/api/me`, { headers: { cookie } })).status).toBe(401);
  });

  it("succeeds without a session, still clearing the cookie", async () => {
    const response = await post("/api/logout", {});
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("leaves the same user's other sessions alone", async () => {
    const first = await register("ada");
    const second = await post("/api/login", { username: "ada", password: "hunter2000" });
    const secondCookie = sessionCookieOf(second);
    if (secondCookie === null) throw new Error("login did not set a session cookie");

    await post("/api/logout", {}, first);

    expect((await fetch(`${base}/api/me`, { headers: { cookie: secondCookie } })).status).toBe(200);
  });
});

describe("behind a TLS-terminating proxy", () => {
  beforeEach(() =>
    start({ secureCookies: (req) => req.headers["x-forwarded-proto"] === "https" }),
  );

  it("marks the cookie Secure when nginx reports https", async () => {
    const response = await fetch(`${base}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ username: "ada", password: "hunter2000" }),
    });

    expect(response.headers.get("set-cookie")).toContain("Secure");
  });

  it("leaves it off for a direct http request to the same server", async () => {
    const response = await fetch(`${base}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ada", password: "hunter2000" }),
    });

    // The same build has to work on the public https site and on a developer's
    // http://localhost, and only the request knows which one this is.
    expect(response.headers.get("set-cookie")).not.toContain("Secure");
  });
});
