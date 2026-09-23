import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Op, ServerMessage, Snapshot, StampedTx } from "@collab/shared";
import { Connection, type ConnectionCallbacks, type ConnectionStatus } from "./connection.js";

type Listener = (event: { data?: string; code?: number }) => void;

/**
 * The slice of the WebSocket interface connection.ts actually touches. Note the
 * static OPEN: the code compares against `WebSocket.OPEN`, not `socket.OPEN`.
 */
class FakeSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static readonly instances: FakeSocket[] = [];

  readonly sent: string[] = [];
  readyState = 0;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const registered = this.listeners.get(type) ?? [];
    registered.push(listener);
    this.listeners.set(type, registered);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  /** Test-side controls, not part of the WebSocket interface. */
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.emit("open");
  }

  deliver(message: ServerMessage | string): void {
    this.emit("message", { data: typeof message === "string" ? message : JSON.stringify(message) });
  }

  serverClose(code?: number): void {
    this.readyState = FakeSocket.CLOSED;
    this.emit("close", code === undefined ? {} : { code });
  }

  /** Client-side close, i.e. `disconnect()`. */
  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.emit("close", { code: 1000 });
  }

  frames(): unknown[] {
    return this.sent.map((raw) => JSON.parse(raw));
  }

  private emit(type: string, event: { data?: string; code?: number } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const OPS: Op[] = [{ kind: "insert", blockId: "b1", offset: 0, text: "x" }];

function snapshot(version: number): Snapshot {
  return { version, blocks: [{ id: "b1", text: "hello" }] };
}

function stamped(seq: number, clientId = "peer"): StampedTx {
  return { clientId, seq, baseVersion: seq - 1, ops: OPS };
}

interface Recorded {
  statuses: ConnectionStatus[];
  welcomes: Array<{ clientId: string; snapshot: Snapshot }>;
  txs: Array<{ tx: StampedTx; version: number }>;
  resyncs: Snapshot[];
  unauthorized: number;
}

function harness(): { connection: Connection; recorded: Recorded } {
  const recorded: Recorded = { statuses: [], welcomes: [], txs: [], resyncs: [], unauthorized: 0 };
  const callbacks: ConnectionCallbacks = {
    onWelcome: (clientId, snapshot) => recorded.welcomes.push({ clientId, snapshot }),
    onTx: (tx, version) => recorded.txs.push({ tx, version }),
    onResync: (snapshot) => recorded.resyncs.push(snapshot),
    onStatus: (status) => recorded.statuses.push(status),
    onUnauthorized: () => {
      recorded.unauthorized += 1;
    },
  };
  return { connection: new Connection(callbacks), recorded };
}

function socketAt(index: number): FakeSocket {
  const instance = FakeSocket.instances[index];
  if (instance === undefined) throw new Error(`no socket created at index ${index}`);
  return instance;
}

function framesAt(index: number): unknown[] {
  return socketAt(index).frames();
}

/** Connects, opens, and completes a welcome at the given version. */
function connected(version = 0): { connection: Connection; recorded: Recorded; socket: FakeSocket } {
  const { connection, recorded } = harness();
  connection.connect();
  const socket = socketAt(0);
  socket.open();
  socket.deliver({ type: "welcome", clientId: "me", snapshot: snapshot(version) });
  return { connection, recorded, socket };
}

beforeEach(() => {
  FakeSocket.instances.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal("window", {
    location: { protocol: "http:", host: "localhost:3000" },
    // Late-bound on purpose: assigning globalThis.setTimeout directly would capture
    // the real function, so advanceTimersByTime would never fire the reconnect.
    setTimeout: (handler: () => void, ms: number) => globalThis.setTimeout(handler, ms),
  });
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  // Every close schedules a reconnect, so timers must not leak between tests.
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("connect", () => {
  it("derives the url from the page location and joins", () => {
    const { connection, recorded } = harness();
    connection.connect();

    expect(FakeSocket.instances).toHaveLength(1);
    expect(socketAt(0).url).toBe("ws://localhost:3000/ws");
    expect(recorded.statuses).toEqual(["connecting"]);

    socketAt(0).open();
    expect(recorded.statuses).toEqual(["connecting", "open"]);
    expect(framesAt(0)).toEqual([{ type: "join" }]);
  });

  it("uses wss on an https page", () => {
    vi.stubGlobal("window", {
      location: { protocol: "https:", host: "example.test" },
      setTimeout: (handler: () => void, ms: number) => globalThis.setTimeout(handler, ms),
    });
    const { connection } = harness();
    connection.connect();
    expect(socketAt(0).url).toBe("wss://example.test/ws");
  });

  it("adopts the version the server reports in its welcome", () => {
    const { connection, recorded } = connected(7);
    expect(recorded.welcomes).toEqual([{ clientId: "me", snapshot: snapshot(7) }]);
    expect(connection.getVersion()).toBe(7);
  });
});

describe("sendTx", () => {
  it("sends the envelope the server expects", () => {
    // Pinned as a literal because the server's integration test feeds the same
    // shape in. Two suites, one format, no cross-workspace import.
    const { connection, socket } = connected(0);
    connection.sendTx(OPS);
    expect(socket.frames()).toEqual([{ type: "join" }, { type: "tx", tx: { seq: 0, baseVersion: 0, ops: OPS } }]);
  });

  it("increments seq per call while baseVersion only moves on server messages", () => {
    // Two keystrokes in a row therefore carry the same baseVersion. Harmless only
    // because the server ignores the field today — see the README.
    const { connection, socket } = connected(0);
    connection.sendTx(OPS);
    connection.sendTx(OPS);
    expect(socket.frames().slice(1)).toEqual([
      { type: "tx", tx: { seq: 0, baseVersion: 0, ops: OPS } },
      { type: "tx", tx: { seq: 1, baseVersion: 0, ops: OPS } },
    ]);

    socket.deliver({ type: "tx", tx: stamped(1), version: 1 });
    connection.sendTx(OPS);
    expect(socket.frames().at(-1)).toEqual({ type: "tx", tx: { seq: 2, baseVersion: 1, ops: OPS } });
  });

  it("sends nothing for an empty op list", () => {
    const { connection, socket } = connected(0);
    connection.sendTx([]);
    expect(socket.frames()).toEqual([{ type: "join" }]);
  });

  it("drops the ops but still consumes a seq when the socket is not open", () => {
    // A Phase 1 defect, pinned on purpose: the seq increments before the
    // readyState check, so typing during the reconnect window is lost silently and
    // leaves a hole in the sequence.
    const { connection } = harness();
    connection.connect();
    const socket = socketAt(0);

    connection.sendTx(OPS);
    expect(socket.frames()).toEqual([]);

    socket.open();
    connection.sendTx(OPS);
    expect(socket.frames()).toEqual([
      { type: "join" },
      { type: "tx", tx: { seq: 1, baseVersion: 0, ops: OPS } },
    ]);
  });
});

describe("incoming transactions", () => {
  it("applies a tx that follows the current version", () => {
    const { recorded, socket } = connected(0);
    socket.deliver({ type: "tx", tx: stamped(0), version: 1 });
    expect(recorded.txs).toEqual([{ tx: stamped(0), version: 1 }]);
  });

  it("asks for a snapshot instead of guessing when a version is skipped", () => {
    const { connection, recorded, socket } = connected(0);
    socket.deliver({ type: "tx", tx: stamped(2), version: 2 });

    expect(recorded.txs).toEqual([]);
    expect(connection.getVersion()).toBe(0);
    expect(socket.frames()).toEqual([{ type: "join" }, { type: "resync" }]);
  });

  it("treats a repeated version as at-least-once delivery, not a second edit", () => {
    const { connection, recorded, socket } = connected(0);
    socket.deliver({ type: "tx", tx: stamped(0), version: 1 });
    expect(recorded.txs).toHaveLength(1);

    socket.deliver({ type: "tx", tx: stamped(0), version: 1 });
    expect(recorded.txs).toHaveLength(1);
    expect(connection.getVersion()).toBe(1);
    expect(socket.frames()).toEqual([{ type: "join" }, { type: "resync" }]);
  });

  it("passes its own echoed tx through — filtering belongs to the caller", () => {
    // main.ts drops frames whose clientId matches its own. Connection must not
    // guess, because it is also the layer that would deliver an ACK.
    const { recorded, socket } = connected(0);
    socket.deliver({ type: "tx", tx: stamped(0, "me"), version: 1 });
    expect(recorded.txs).toHaveLength(1);
    expect(recorded.txs[0]?.tx.clientId).toBe("me");
  });

  it("recovers from a skipped version once the snapshot arrives", () => {
    const { connection, recorded, socket } = connected(0);
    socket.deliver({ type: "tx", tx: stamped(2), version: 2 });

    socket.deliver({ type: "resync", snapshot: snapshot(5) });
    expect(recorded.resyncs).toEqual([snapshot(5)]);
    expect(connection.getVersion()).toBe(5);

    socket.deliver({ type: "tx", tx: stamped(5), version: 6 });
    expect(recorded.txs).toHaveLength(1);
    expect(connection.getVersion()).toBe(6);
  });

  it("ignores a frame that is not JSON", () => {
    const { connection, recorded, socket } = connected(3);
    socket.deliver("not json");
    expect(recorded.txs).toEqual([]);
    expect(connection.getVersion()).toBe(3);
  });
});

describe("server errors", () => {
  it("warns, keeps local state, and sends no resync of its own", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { connection, socket } = connected(3);

    socket.deliver({ type: "error", code: "OFFSET_OUT_OF_RANGE", message: "rejected" });

    expect(warn).toHaveBeenCalledOnce();
    expect(connection.getVersion()).toBe(3);
    expect(socket.frames()).toEqual([{ type: "join" }]);
  });
});

describe("reconnect", () => {
  it("retries once after the fixed delay, with no backoff and no cap", () => {
    const { recorded } = connected(0);
    socketAt(0).serverClose();
    expect(recorded.statuses.at(-1)).toBe("closed");
    expect(FakeSocket.instances).toHaveLength(1);

    // RECONNECT_DELAY_MS is not exported, so this literal tracks the source.
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(recorded.statuses.at(-1)).toBe("connecting");

    // The fresh socket is not opened, so nothing else fires.
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("re-joins on the new socket so it can adopt a fresh snapshot", () => {
    connected(0);
    socketAt(0).serverClose();
    vi.advanceTimersByTime(1000);

    socketAt(1).open();
    expect(framesAt(1)).toEqual([{ type: "join" }]);
  });
});

describe("a rejected handshake", () => {
  it("reports 4401 and stops, instead of retrying forever", () => {
    const { recorded } = connected(0);
    socketAt(0).serverClose(4401);

    expect(recorded.unauthorized).toBe(1);
    expect(recorded.statuses.at(-1)).toBe("closed");

    // The cookie will not become valid by waiting, so a retry loop here would
    // be one request per second against a server that already said no.
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("still retries an ordinary close", () => {
    const { recorded } = connected(0);
    socketAt(0).serverClose(1006);

    expect(recorded.unauthorized).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);
  });
});

describe("disconnect", () => {
  it("closes the live socket and never reconnects", () => {
    const { connection, recorded } = connected(0);
    const socket = socketAt(0);
    socket.open();

    connection.disconnect();
    expect(socket.readyState).toBe(FakeSocket.CLOSED);

    // The close that `disconnect()` causes must not arm a retry of its own.
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(recorded.statuses.at(-1)).toBe("closed");
  });

  it("is a no-op when there is no socket yet", () => {
    const { connection } = harness();
    expect(() => connection.disconnect()).not.toThrow();
  });

  it("stops a reconnect that a close had already scheduled", () => {
    const { connection } = connected(0);
    socketAt(0).serverClose(1006);

    // Signing out during the one-second reconnect window is the real case. The
    // timer is already armed, so the flag has to be read when it fires.
    connection.disconnect();
    vi.advanceTimersByTime(10_000);

    expect(FakeSocket.instances).toHaveLength(1);
  });
});
