import type { Op, ServerMessage, Snapshot, StampedTx, TxPayload } from "@collab/shared";

export type ConnectionStatus = "connecting" | "open" | "closed";

export interface ConnectionCallbacks {
  onWelcome(clientId: string, snapshot: Snapshot): void;
  onTx(tx: StampedTx, version: number): void;
  onResync(snapshot: Snapshot): void;
  onStatus(status: ConnectionStatus): void;
  /**
   * The server refused the handshake because the session cookie was missing,
   * expired or revoked. Retrying can only produce the same answer, so the
   * connection stops instead.
   */
  onUnauthorized?(): void;
}

const RECONNECT_DELAY_MS = 1000;
const WS_PATH = "/ws";

/** Mirrors `UNAUTHORIZED_CLOSE_CODE` in the server's create-server.ts. */
const UNAUTHORIZED_CLOSE_CODE = 4401;

export class Connection {
  private readonly callbacks: ConnectionCallbacks;
  private socket: WebSocket | null = null;
  private seq = 0;
  private version = 0;
  private shouldReconnect = true;

  constructor(callbacks: ConnectionCallbacks) {
    this.callbacks = callbacks;
  }

  connect(): void {
    this.callbacks.onStatus("connecting");

    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${scheme}//${window.location.host}${WS_PATH}`);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.callbacks.onStatus("open");
      this.send({ type: "join" });
    });

    socket.addEventListener("message", (event) => {
      this.handleMessage(typeof event.data === "string" ? event.data : "");
    });

    socket.addEventListener("close", (event) => {
      this.callbacks.onStatus("closed");

      if (event.code === UNAUTHORIZED_CLOSE_CODE) {
        // 4401 is the one close that retrying cannot fix. Without this branch
        // the unconditional retry below would hammer the server once a second,
        // forever, with a cookie that will never be accepted.
        this.shouldReconnect = false;
        this.callbacks.onUnauthorized?.();
        return;
      }

      if (!this.shouldReconnect) return;
      // Otherwise retry unconditionally: closing the tab is still the only way
      // to stop us. Backoff arrives with the reconnect semantics, deferred.
      // The flag is re-read when the timer fires, not when it is armed, so a
      // `disconnect()` in the meantime still wins.
      window.setTimeout(() => {
        if (this.shouldReconnect) this.connect();
      }, RECONNECT_DELAY_MS);
    });
  }

  /**
   * Terminal. Closes the socket and never reconnects, because the version and
   * seq counters below belong to the session that is ending — signing back in
   * must build a fresh `Connection`, not revive this one.
   */
  disconnect(): void {
    this.shouldReconnect = false;
    const socket = this.socket;
    this.socket = null;
    if (socket !== null && socket.readyState !== WebSocket.CLOSED) socket.close();
  }

  sendTx(ops: Op[]): void {
    if (ops.length === 0) return;
    const tx: TxPayload = { seq: this.seq, baseVersion: this.version, ops };
    this.seq += 1;
    this.send({ type: "tx", tx });
  }

  requestResync(): void {
    this.send({ type: "resync" });
  }

  getVersion(): number {
    return this.version;
  }

  private send(message: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  private handleMessage(raw: string): void {
    let parsed: ServerMessage;
    try {
      parsed = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }

    switch (parsed.type) {
      case "welcome": {
        this.version = parsed.snapshot.version;
        this.callbacks.onWelcome(parsed.clientId, parsed.snapshot);
        return;
      }
      case "tx": {
        // Phase 1 assumes an ordered, lossless stream. If a version is skipped we
        // cannot apply this tx on top of what we hold, so we ask for a snapshot
        // instead of guessing.
        if (parsed.version !== this.version + 1) {
          this.requestResync();
          return;
        }
        this.version = parsed.version;
        this.callbacks.onTx(parsed.tx, parsed.version);
        return;
      }
      case "resync": {
        this.version = parsed.snapshot.version;
        this.callbacks.onResync(parsed.snapshot);
        return;
      }
      case "error": {
        console.warn(`[collab] server rejected message: ${parsed.code} — ${parsed.message}`);
        return;
      }
    }
  }
}
