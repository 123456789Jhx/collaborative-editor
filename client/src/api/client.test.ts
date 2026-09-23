import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  NETWORK_ERROR_STATUS,
  fetchCurrentUser,
  login,
  logout,
  register,
  type ApiUser,
} from "./client.js";

const USER: ApiUser = {
  id: 1,
  username: "ada",
  role: "user",
  status: "active",
  createdAt: 1_700_000_000_000,
};

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(response: Response | (() => Promise<Response>)): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return typeof response === "function" ? response() : Promise.resolve(response);
  });
  return calls;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchCurrentUser", () => {
  it("returns the user the server reports", async () => {
    stubFetch(json(200, { user: USER }));
    await expect(fetchCurrentUser()).resolves.toEqual(USER);
  });

  it("returns null for 401 instead of throwing", async () => {
    // Being signed out is the ordinary state on a first visit, not an error,
    // and the boot flow should not have to catch to find that out.
    stubFetch(json(401, { error: "UNAUTHORIZED", message: "Not signed in" }));
    await expect(fetchCurrentUser()).resolves.toBeNull();
  });

  it("sends the session cookie", async () => {
    const calls = stubFetch(json(200, { user: USER }));
    await fetchCurrentUser();

    // httpOnly, so the browser can only attach it for us — and only if asked.
    expect(calls[0]?.init?.credentials).toBe("same-origin");
    expect(calls[0]?.url).toBe("/api/me");
  });

  it("throws for a 500", async () => {
    stubFetch(json(500, { error: "INTERNAL", message: "Internal error" }));
    await expect(fetchCurrentUser()).rejects.toBeInstanceOf(ApiError);
  });

  it("throws when the payload has no user", async () => {
    stubFetch(json(200, { ok: true }));
    await expect(fetchCurrentUser()).rejects.toMatchObject({ code: "MALFORMED" });
  });
});

describe("login", () => {
  it("returns the user and posts the credentials as JSON", async () => {
    const calls = stubFetch(json(200, { user: USER }));
    await expect(login("ada", "hunter2000")).resolves.toEqual(USER);

    expect(calls[0]?.url).toBe("/api/login");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ username: "ada", password: "hunter2000" }));
    expect(calls[0]?.init?.headers).toMatchObject({ "content-type": "application/json" });
  });

  it("surfaces the server's error code", async () => {
    stubFetch(json(401, { error: "UNAUTHORIZED", message: "Incorrect username or password" }));

    await expect(login("ada", "nope")).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Incorrect username or password",
    });
  });

  it("reports a 429 as its own code so the view can say 'wait'", async () => {
    stubFetch(json(429, { error: "TOO_MANY_REQUESTS", message: "Too many attempts" }));
    await expect(login("ada", "nope")).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});

describe("register", () => {
  it("returns the new user", async () => {
    stubFetch(json(201, { user: USER }));
    await expect(register("ada", "hunter2000")).resolves.toEqual(USER);
  });

  it("reports a taken username as USERNAME_TAKEN", async () => {
    stubFetch(json(409, { error: "USERNAME_TAKEN", message: "That username is already taken" }));
    await expect(register("ada", "hunter2000")).rejects.toMatchObject({
      status: 409,
      code: "USERNAME_TAKEN",
    });
  });

  it("passes the server's validation message through", async () => {
    stubFetch(json(400, { error: "BAD_REQUEST", message: "Password must be at least 8 characters" }));
    await expect(register("ada", "short")).rejects.toMatchObject({
      message: "Password must be at least 8 characters",
    });
  });

  it("carries the server's detail, which is what the UI translates", async () => {
    stubFetch(
      json(400, {
        error: "BAD_REQUEST",
        message: "Password must be at least 4 characters",
        detail: "PASSWORD_TOO_SHORT",
      }),
    );

    await expect(register("ada", "abc")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      detail: "PASSWORD_TOO_SHORT",
    });
  });

  it("leaves detail undefined when the server sends none", async () => {
    stubFetch(json(409, { error: "USERNAME_TAKEN", message: "That username is already taken" }));

    await expect(register("ada", "hunter2000")).rejects.toMatchObject({ detail: undefined });
  });
});

describe("logout", () => {
  it("posts and resolves", async () => {
    const calls = stubFetch(json(200, { ok: true }));
    await expect(logout()).resolves.toBeUndefined();
    expect(calls[0]?.url).toBe("/api/logout");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("throws when the server refuses", async () => {
    stubFetch(json(500, { error: "INTERNAL", message: "Internal error" }));
    await expect(logout()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("failures that never reach the server", () => {
  it("reports a rejected fetch as a network error", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));

    const error = await login("ada", "hunter2000").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: NETWORK_ERROR_STATUS, code: "NETWORK" });
  });

  it("falls back to the status when the error body is not JSON", async () => {
    // What a misrouted request looks like: nginx serving index.html with a 200
    // body, or a proxy's own HTML error page.
    stubFetch(new Response("<html>502 Bad Gateway</html>", { status: 502 }));

    await expect(login("ada", "hunter2000")).rejects.toMatchObject({
      status: 502,
      code: "UNKNOWN",
      message: "Request failed (502)",
    });
  });
});
