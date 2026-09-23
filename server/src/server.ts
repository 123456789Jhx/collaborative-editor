import { DatabaseAuthPolicy } from "./auth/auth-policy.js";
import { MissingAdminCredentialsError, seedAdmin } from "./auth/seed-admin.js";
import { createCollabServer, WS_PATH } from "./create-server.js";
import { openDatabase } from "./db/schema.js";
import { SessionRepository } from "./db/session-repository.js";
import { UserRepository } from "./db/user-repository.js";
import { registerAuthRoutes } from "./http/routes/auth-routes.js";
import { Router } from "./http/router.js";

export const DB_PATH_ENV = "COLLAB_DB_PATH";

/** Relative, so the same default lands on `/app/data` in the image's WORKDIR. */
const DEFAULT_DB_PATH = "data/collab.db";

const port = Number(process.env["PORT"] ?? 3000);
const dbPath = process.env[DB_PATH_ENV] ?? DEFAULT_DB_PATH;

const db = openDatabase(dbPath);
const users = new UserRepository(db);
const sessions = new SessionRepository(db);

// Before the listener opens: a deployment with no administrator and no
// credentials to create one must fail loudly at startup rather than come up
// serving a login page nobody can get past.
try {
  const seeded = seedAdmin(users, process.env, Date.now());
  if (seeded !== null) console.log(`[auth] created administrator "${seeded.username}"`);
} catch (error) {
  if (error instanceof MissingAdminCredentialsError) {
    console.error(`[auth] ${error.message}`);
    process.exit(1);
  }
  throw error;
}

const router = new Router();
registerAuthRoutes(router, {
  users,
  sessions,
  // The proxy terminates TLS, so the request's own socket is always plain http.
  // nginx sets this header; see nginx.conf.
  secureCookies: (req) => req.headers["x-forwarded-proto"] === "https",
});

const server = createCollabServer({
  port,
  auth: new DatabaseAuthPolicy(sessions),
  httpHandler: async (req, res) => {
    await router.handle(req, res);
  },
});

function shutdown(): void {
  void server.close().then(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`collab server listening on http://localhost:${port} (websocket ${WS_PATH})`);
console.log(`[auth] database: ${dbPath}`);
