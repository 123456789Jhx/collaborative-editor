import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "./router.js";
import { API_ERRORS } from "./respond.js";

let router: Router;
let server: Server;
let base: string;

beforeEach(async () => {
  router = new Router();
  server = createServer((req, res) => {
    void router.handle(req, res);
  });
  server.listen(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeIdleConnections();
  server.close();
  await once(server, "close");
});

async function get(path: string): Promise<Response> {
  return fetch(`${base}${path}`);
}

describe("matching", () => {
  it("routes an exact path", async () => {
    router.get("/api/health", ({ res }) => {
      res.writeHead(200).end("ok");
    });

    expect(await (await get("/api/health")).text()).toBe("ok");
  });

  it("routes a single-segment parameter", async () => {
    router.get("/api/users/:id", ({ res, params }) => {
      res.writeHead(200, { "content-type": "text/plain" }).end(params["id"]);
    });

    expect(await (await get("/api/users/42")).text()).toBe("42");
  });

  it("decodes a percent-encoded parameter", async () => {
    router.get("/api/users/:id", ({ res, params }) => {
      res.writeHead(200, { "content-type": "text/plain" }).end(params["id"]);
    });

    expect(await (await get("/api/users/a%20b")).text()).toBe("a b");
  });

  it("does not let a parameter span a slash", async () => {
    router.get("/api/users/:id", ({ res }) => {
      res.writeHead(200).end("matched");
    });

    expect((await get("/api/users/1/extra")).status).toBe(404);
  });

  it("parses the query string without matching on it", async () => {
    router.get("/api/list", ({ res, url }) => {
      res.writeHead(200, { "content-type": "text/plain" }).end(url.searchParams.get("page") ?? "");
    });

    expect(await (await get("/api/list?page=3")).text()).toBe("3");
  });

  it("tolerates a trailing slash", async () => {
    router.get("/api/health", ({ res }) => {
      res.writeHead(200).end("ok");
    });

    expect((await get("/api/health/")).status).toBe(200);
  });
});

describe("unmatched requests", () => {
  it("answers 404 for an unknown path", async () => {
    const response = await get("/api/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: API_ERRORS.notFound });
  });

  it("answers 405 when the path exists under another method", async () => {
    router.get("/api/health", ({ res }) => {
      res.writeHead(200).end("ok");
    });

    const response = await fetch(`${base}/api/health`, { method: "DELETE" });

    // Distinguishing this from 404 is the difference between "your proxy is
    // misconfigured" and "your verb is wrong" when something breaks in the field.
    expect(response.status).toBe(405);
    expect(await response.json()).toMatchObject({ error: API_ERRORS.badRequest });
  });
});

describe("handler failures", () => {
  // The router logs the real error server-side on purpose. Silenced here so the
  // suite's own output stays readable — the assertions below are about what the
  // *client* sees, which is the part that must not leak.
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("turns a throw into a 500 without leaking the stack", async () => {
    router.get("/api/boom", () => {
      throw new Error("database on fire");
    });

    const response = await get("/api/boom");
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain(API_ERRORS.internal);
    expect(body).not.toContain("database on fire");
    expect(body).not.toContain("at ");
  });

  it("turns a rejected promise into a 500", async () => {
    router.get("/api/async-boom", async () => {
      await Promise.resolve();
      throw new Error("nope");
    });

    expect((await get("/api/async-boom")).status).toBe(500);
  });

  it("keeps serving after a handler throws", async () => {
    router.get("/api/boom", () => {
      throw new Error("once");
    });
    router.get("/api/health", ({ res }) => {
      res.writeHead(200).end("ok");
    });

    await get("/api/boom");
    expect(await (await get("/api/health")).text()).toBe("ok");
  });
});

describe("method dispatch", () => {
  it("keeps the same path distinct across methods", async () => {
    router.get("/api/thing", ({ res }) => {
      res.writeHead(200).end("read");
    });
    router.post("/api/thing", ({ res }) => {
      res.writeHead(201).end("wrote");
    });
    router.patch("/api/thing", ({ res }) => {
      res.writeHead(200).end("patched");
    });

    expect(await (await get("/api/thing")).text()).toBe("read");
    expect(await (await fetch(`${base}/api/thing`, { method: "POST" })).text()).toBe("wrote");
    expect(await (await fetch(`${base}/api/thing`, { method: "PATCH" })).text()).toBe("patched");
  });
});
