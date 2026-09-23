import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ERROR_CODES, parseClientMessage, type Block, type ServerMessage } from "@collab/shared";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { AuthSession, AuthPolicy } from "./auth/auth-policy.js";
import { DocumentState } from "./document-state.js";

export const WS_PATH = "/ws";

/** Close code for "the handshake carried no valid session". */
export const UNAUTHORIZED_CLOSE_CODE = 4401;

/** Handles everything that is not the WebSocket upgrade. */
export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface CollabServerOptions {
  port?: number;
  initialBlocks?: readonly Block[];
  /**
   * Omitted means no authorization at all — anyone may connect and edit. The
   * protocol tests rely on that, since they exercise the collaboration core and
   * should not need a database to do it. `server.ts` always supplies one.
   */
  auth?: AuthPolicy;
  httpHandler?: HttpHandler;
}

export interface CollabServer {
  readonly wss: WebSocketServer;
  readonly httpServer: Server;
  readonly documentState: DocumentState;
  close(): Promise<void>;
}

function rawToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

export function createCollabServer(options: CollabServerOptions = {}): CollabServer {
  const documentState = new DocumentState(options.initialBlocks);
  const auth = options.auth;
  const clientIds = new Map<WebSocket, string>();

  // One port serves both the API and the socket. They have to share an origin
  // for the session cookie to ride along on the WebSocket handshake, which is
  // what lets authorization happen without a single change to the protocol.
  const httpServer = createServer((req, res) => {
    const handler = options.httpHandler;
    if (handler === undefined) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "NOT_FOUND", message: "No such endpoint" }));
      return;
    }
    // A throw here — synchronous or a rejected promise — would otherwise be an
    // uncaught exception that takes the process down with every client attached.
    void (async () => {
      try {
        await handler(req, res);
      } catch (error) {
        console.error("[http] request handler threw", req.url, error);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "INTERNAL", message: "Internal error" }));
        } else {
          res.end();
        }
      }
    })();
  });

  const wss = new WebSocketServer({ server: httpServer, path: WS_PATH });
  httpServer.listen(options.port ?? 0);

  function send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  function broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  wss.on("connection", (socket, request) => {
    // The browser sends the session cookie on the handshake automatically
    // because `/ws` is same-origin with the page.
    const session: AuthSession | null = auth === undefined ? null : auth.authenticate(request);
    if (auth !== undefined && session === null) {
      socket.close(UNAUTHORIZED_CLOSE_CODE, "UNAUTHENTICATED");
      return;
    }

    socket.on("message", (data) => {
      const message = parseClientMessage(rawToString(data));
      if (message === null) {
        send(socket, {
          type: "error",
          code: ERROR_CODES.invalidMessage,
          message: "Message could not be parsed",
        });
        return;
      }

      if (message.type === "join") {
        if (!clientIds.has(socket)) clientIds.set(socket, randomUUID());
        send(socket, {
          type: "welcome",
          clientId: clientIds.get(socket) as string,
          snapshot: documentState.snapshot(),
        });
        return;
      }

      const clientId = clientIds.get(socket);
      if (clientId === undefined) {
        send(socket, {
          type: "error",
          code: ERROR_CODES.notJoined,
          message: "Send join before any other message",
        });
        return;
      }

      if (message.type === "resync") {
        send(socket, { type: "resync", snapshot: documentState.snapshot() });
        return;
      }

      // Checked here rather than in `DocumentState`, which never reads
      // `clientId` and has no idea who authored a transaction. Opting out of
      // that knowledge is what keeps it a pure linearizer.
      if (auth !== undefined && session !== null) {
        const verdict = auth.checkEdit(session);
        if (!verdict.ok) {
          // Same error-then-resync pairing as a validation failure, so the
          // client's existing rollback path handles this unchanged.
          send(socket, { type: "error", code: verdict.code, message: verdict.message });
          send(socket, { type: "resync", snapshot: documentState.snapshot() });
          return;
        }
      }

      const tx = { ...message.tx, clientId };
      const result = documentState.applyTx(tx);
      if (!result.ok) {
        send(socket, {
          type: "error",
          code: result.code,
          message: `Transaction rejected: ${result.code}`,
        });
        send(socket, { type: "resync", snapshot: documentState.snapshot() });
        return;
      }

      broadcast({ type: "tx", tx, version: result.version });
    });

    const forget = (): void => {
      clientIds.delete(socket);
    };
    socket.on("close", forget);
    socket.on("error", forget);
  });

  return {
    wss,
    httpServer,
    documentState,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => {
          // Keep-alive sockets from `fetch` would otherwise hold the listener
          // open until the test runner's timeout.
          httpServer.closeIdleConnections();
          httpServer.close(() => resolve());
        });
      }),
  };
}
