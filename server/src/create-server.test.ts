import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  ERROR_CODES,
  applyOps,
  type Block,
  type Op,
  type ServerMessage,
  type Snapshot,
} from "@collab/shared";
import { DatabaseAuthPolicy, SESSION_COOKIE } from "./auth/auth-policy.js";
import { createCollabServer, type CollabServer } from "./create-server.js";
import { openDatabase, type Db } from "./db/schema.js";
import { SessionRepository } from "./db/session-repository.js";
import { UserRepository } from "./db/user-repository.js";

// The first block the default DocumentState ships with.
const FIRST_BLOCK = "block-1";

function insert(blockId: string, offset: number, text: string): Op {
  return { kind: "insert", blockId, offset, text };
}

function txFrame(seq: number, baseVersion: number, ops: Op[]): unknown {
  return { type: "tx", tx: { seq, baseVersion, ops } };
}

/**
 * A client that queues frames and lets a test await the next one. Frames can
 * arrive before the await, so a bare promise-per-send helper would be racy.
 */
class TestClient {
  private readonly frames: ServerMessage[] = [];
  private cursor = 0;
  private readonly waiters: Array<() => void> = [];

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      this.frames.push(JSON.parse(data.toString()) as ServerMessage);
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  static async connect(port: number): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await once(socket, "open");
    return new TestClient(socket);
  }

  /**
   * For a handshake that carries headers — the session cookie, in the auth
   * tests. The constructor stays private so nothing can wrap a socket before
   * the `open` event, which is where the message listener has to be attached.
   */
  static async connectWith(port: number, headers: Record<string, string>): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    await once(socket, "open");
    return new TestClient(socket);
  }

  async next(): Promise<ServerMessage> {
    while (this.cursor >= this.frames.length) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    const frame = this.frames[this.cursor];
    this.cursor += 1;
    if (frame === undefined) throw new Error("unreachable: cursor passed the queue");
    return frame;
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  sendRaw(data: string | Buffer): void {
    this.socket.send(data);
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, "close");
    this.socket.terminate();
    await closed;
  }
}

function asWelcome(frame: ServerMessage): Extract<ServerMessage, { type: "welcome" }> {
  if (frame.type !== "welcome") throw new Error(`expected welcome, got ${frame.type}`);
  return frame;
}

function asTx(frame: ServerMessage): Extract<ServerMessage, { type: "tx" }> {
  if (frame.type !== "tx") throw new Error(`expected tx, got ${frame.type}`);
  return frame;
}

function asResync(frame: ServerMessage): Extract<ServerMessage, { type: "resync" }> {
  if (frame.type !== "resync") throw new Error(`expected resync, got ${frame.type}`);
  return frame;
}

function asError(frame: ServerMessage): Extract<ServerMessage, { type: "error" }> {
  if (frame.type !== "error") throw new Error(`expected error, got ${frame.type}`);
  return frame;
}

let server: CollabServer;
let port = 0;
const clients: TestClient[] = [];

beforeEach(async () => {
  server = createCollabServer({ port: 0 });
  if (server.wss.address() === null) await once(server.wss, "listening");
  port = (server.wss.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await server.close();
});

async function connect(): Promise<TestClient> {
  const client = await TestClient.connect(port);
  clients.push(client);
  return client;
}

async function connectJoined(): Promise<{
  client: TestClient;
  clientId: string;
  snapshot: Snapshot;
}> {
  const client = await connect();
  client.send({ type: "join" });
  const welcome = asWelcome(await client.next());
  return { client, clientId: welcome.clientId, snapshot: welcome.snapshot };
}

describe("join", () => {
  it("welcomes with a clientId and the current snapshot", async () => {
    const client = await connect();
    client.send({ type: "join" });
    const welcome = asWelcome(await client.next());
    expect(welcome.clientId).toEqual(expect.any(String));
    expect(welcome.clientId.length).toBeGreaterThan(0);
    expect(welcome.snapshot.version).toBe(0);
    expect(welcome.snapshot.blocks).toHaveLength(1);
  });

  it("keeps the clientId on a second join but re-reads the snapshot", async () => {
    const { client, clientId } = await connectJoined();
    const peer = await connect();
    peer.send({ type: "join" });
    await peer.next();

    client.send(txFrame(0, 0, [insert(FIRST_BLOCK, 0, "X")]));
    await client.next();

    // Identity is per socket; the snapshot is not cached.
    client.send({ type: "join" });
    const second = asWelcome(await client.next());
    expect(second.clientId).toBe(clientId);
    expect(second.snapshot.version).toBe(1);
    expect(second.snapshot.blocks[0]?.text).toBe("XOpen this page in a second tab to see live sync.");
  });

  it("rejects a transaction from a client that has not joined", async () => {
    const client = await connect();
    client.send(txFrame(0, 0, [insert(FIRST_BLOCK, 0, "X")]));
    expect(asError(await client.next()).code).toBe(ERROR_CODES.notJoined);

    // Probe rather than sleep: the next frame is the reply to a join, which proves
    // no resync was queued behind the error.
    client.send({ type: "join" });
    expect(asWelcome(await client.next()).snapshot.version).toBe(0);
  });

  it("forgets a disconnected client's identity but keeps the document", async () => {
    const { client: leaving, clientId } = await connectJoined();
    leaving.send(txFrame(0, 0, [insert(FIRST_BLOCK, 0, "X")]));
    await leaving.next();
    await leaving.close();

    const { clientId: newId, snapshot } = await connectJoined();
    expect(newId).not.toBe(clientId);
    expect(snapshot.version).toBe(1);
  });
});

describe("broadcast", () => {
  it("echoes a tx back to its sender, so the client owns the dedupe", async () => {
    const { client: author } = await connectJoined();
    const { client: peer } = await connectJoined();

    const ops = [insert(FIRST_BLOCK, 0, "X")];
    author.send(txFrame(7, 0, ops));

    const mine = asTx(await author.next());
    const theirs = asTx(await peer.next());

    expect(mine.tx.ops).toEqual(ops);
    expect(theirs.tx.ops).toEqual(ops);
    // The same stamped tx reaches everyone, including the seq and baseVersion the
    // author sent. Filtering it out is main.ts's job, not the server's.
    expect(mine.tx.clientId).toBe(theirs.tx.clientId);
    expect(mine.tx.seq).toBe(7);
    expect(mine.tx.baseVersion).toBe(0);
    expect(mine.version).toBe(1);
    expect(theirs.version).toBe(1);
  });

  it("broadcasts successive transactions in version order", async () => {
    const { client: author } = await connectJoined();
    const { client: peer } = await connectJoined();

    author.send(txFrame(0, 0, [insert(FIRST_BLOCK, 0, "A")]));
    author.send(txFrame(1, 1, [insert(FIRST_BLOCK, 1, "B")]));

    const mine = [asTx(await author.next()).version, asTx(await author.next()).version];
    const theirs = [asTx(await peer.next()).version, asTx(await peer.next()).version];
    expect(mine).toEqual([1, 2]);
    expect(theirs).toEqual([1, 2]);
  });

  it("lets any peer replay the stream to the same document", async () => {
    // The whole collaboration claim in one test: the broadcast stream is a total
    // order, so a peer that starts from the snapshot and applies the ops in order
    // lands on exactly the server's document. No DOM needed.
    const { client: author, snapshot: start } = await connectJoined();
    const { client: peer } = await connectJoined();

    author.send(txFrame(0, 0, [insert(FIRST_BLOCK, 0, "A")]));
    author.send(txFrame(1, 1, [{ kind: "split", blockId: FIRST_BLOCK, offset: 5, newBlockId: "b2" }]));
    author.send(txFrame(2, 2, [insert("b2", 0, "B")]));

    const streamOnAuthor: Op[][] = [];
    const streamOnPeer: Op[][] = [];
    for (let i = 0; i < 3; i += 1) streamOnAuthor.push(asTx(await author.next()).tx.ops);
    for (let i = 0; i < 3; i += 1) streamOnPeer.push(asTx(await peer.next()).tx.ops);

    expect(streamOnAuthor).toEqual(streamOnPeer);
    const replayed = streamOnAuthor.reduce<Block[]>((blocks, ops) => applyOps(blocks, ops), start.blocks);
    expect(server.documentState.snapshot().blocks).toEqual(replayed);
    expect(replayed).toHaveLength(2);
  });
});

describe("rejection", () => {
  it("answers an invalid op with error then resync, and does not advance", async () => {
    const { client } = await connectJoined();
    const before = server.documentState.snapshot();

    client.send(txFrame(0, 0, [insert(FIRST_BLOCK, 9999, "X")]));
    expect(asError(await client.next()).code).toBe(ERROR_CODES.offsetOutOfRange);

    // The pairing is a contract: error alone leaves a client stuck, resync alone
    // hides why.
    expect(asResync(await client.next()).snapshot).toEqual(before);
    expect(server.documentState.getVersion()).toBe(0);

    client.send({ type: "resync" });
    expect(asResync(await client.next()).snapshot).toEqual(before);
  });

  it("answers an unparseable frame with INVALID_MESSAGE only, and never resyncs", async () => {
    const { client } = await connectJoined();

    client.sendRaw("{not json");
    expect(asError(await client.next()).code).toBe(ERROR_CODES.invalidMessage);

    client.send({ type: "resync" });
    expect(asResync(await client.next()).snapshot.version).toBe(0);
  });

  it("handles a frame that arrives as a Buffer", async () => {
    const client = await connect();
    client.sendRaw(Buffer.from(JSON.stringify({ type: "join" }), "utf8"));
    expect(asWelcome(await client.next()).snapshot.version).toBe(0);
  });
});

describe("a split and a follow-up insert into the new block", () => {
  it("accepts both across separate transactions", async () => {
    // Stronger than the unit test: the server's state has to actually advance
    // between the two, or the second tx has nothing to address.
    const { client } = await connectJoined();

    client.send(txFrame(0, 0, [{ kind: "split", blockId: FIRST_BLOCK, offset: 11, newBlockId: "b2" }]));
    expect(asTx(await client.next()).version).toBe(1);

    client.send(txFrame(1, 1, [insert("b2", 0, "NEW ")]));
    expect(asTx(await client.next()).version).toBe(2);

    expect(server.documentState.snapshot().blocks).toEqual([
      { id: FIRST_BLOCK, text: "Open this p" },
      { id: "b2", text: "NEW age in a second tab to see live sync." },
    ]);
  });
});

describe("resync on request", () => {
  it("returns the current snapshot without advancing the version", async () => {
    const { client } = await connectJoined();
    client.send(txFrame(0, 0, [insert(FIRST_BLOCK, 0, "X")]));
    await client.next();

    client.send({ type: "resync" });
    const resync = asResync(await client.next());
    expect(resync.snapshot.version).toBe(1);
    expect(server.documentState.getVersion()).toBe(1);
  });
});

/**
 * The tests above deliberately run without a policy, because they test the
 * collaboration core and shouldn't need a database to do it. These wire a real
 * one exactly as `server.ts` does, so "the tests pass" cannot mean "production
 * forgot to attach the policy".
 */
describe("auth", () => {
  let db: Db;
  let users: UserRepository;
  let sessions: SessionRepository;
  let policy: DatabaseAuthPolicy;
  let adaToken: string;
  let adaId: number;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    users = new UserRepository(db);
    sessions = new SessionRepository(db);
    policy = new DatabaseAuthPolicy(sessions);

    adaId = users.create("ada", "hunter2000", "user", Date.now()).id;
    adaToken = sessions.create(adaId, Date.now()).token;

    // The shared beforeEach above builds a policy-free server for the protocol
    // tests; this block needs one wired the way production is, so the original
    // is shut down rather than left listening.
    await server.close();
    server = createCollabServer({ port: 0, auth: policy });
    if (server.wss.address() === null) await once(server.wss, "listening");
    port = (server.wss.address() as AddressInfo).port;
  });

  async function connectWith(cookie?: string): Promise<TestClient> {
    const client = await TestClient.connectWith(
      port,
      cookie === undefined ? {} : { cookie },
    );
    clients.push(client);
    return client;
  }

  function closeCodeOf(socket: WebSocket): Promise<number> {
    return new Promise((resolve) => {
      socket.on("close", (code: number) => resolve(code));
    });
  }

  it("closes an unauthenticated handshake with 4401", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const closed = closeCodeOf(socket);
    await once(socket, "open");

    // 4401 rather than an `unauthenticated` error frame: the client has to be
    // able to tell "sign in again" from "your ops were rejected", and only the
    // close code survives a server that never lets the socket speak.
    expect(await closed).toBe(4401);
  });

  it("closes a handshake carrying a forged cookie", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { cookie: `${SESSION_COOKIE}=forged` },
    });
    const closed = closeCodeOf(socket);
    await once(socket, "open");
    expect(await closed).toBe(4401);
  });

  it("accepts a handshake carrying a live session cookie", async () => {
    const client = await connectWith(`${SESSION_COOKIE}=${adaToken}`);
    client.send({ type: "join" });

    expect(asWelcome(await client.next()).snapshot.version).toBe(0);
  });

  it("lets an authenticated client join and edit", async () => {
    const { client } = await connectJoinedAuthenticated();
    client.send(txFrame(0, 0, [insert(FIRST_BLOCK, 0, "X")]));

    expect(asTx(await client.next()).version).toBe(1);
    expect(server.documentState.snapshot().blocks[0]?.text).toBe(
      "XOpen this page in a second tab to see live sync.",
    );
  });

  it("sends no welcome to a client that was never let in", async () => {
    // Every listener is attached before the first byte arrives, so the test
    // cannot miss a frame that lands in the same tick as the handshake.
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames: string[] = [];
    const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    socket.on("message", (data) => frames.push(data.toString()));
    socket.on("open", () => socket.send(JSON.stringify({ type: "join" })));
    await closed;

    // An unauthenticated socket must not be able to read the document, and
    // `join` is the only message that would hand it over.
    expect(frames).toEqual([]);
  });

  it("rejects a readonly user's transaction and does not advance the version", async () => {
    const { client } = await connectJoinedAuthenticated();
    users.setStatus(adaId, "readonly");

    client.send(txFrame(0, 0, [insert(FIRST_BLOCK, 0, "X")]));

    expect(asError(await client.next()).code).toBe(ERROR_CODES.readOnly);
    expect(asResync(await client.next()).snapshot.version).toBe(0);
    expect(server.documentState.getVersion()).toBe(0);
  });

  it("still lets a readonly user read", async () => {
    const { client } = await connectJoinedAuthenticated();
    users.setStatus(adaId, "readonly");

    client.send({ type: "resync" });
    expect(asResync(await client.next()).snapshot.version).toBe(0);
  });

  it("rejects a deleted user's transaction with ACCOUNT_DISABLED", async () => {
    const { client } = await connectJoinedAuthenticated();
    users.setStatus(adaId, "deleted");

    client.send(txFrame(0, 0, [insert(FIRST_BLOCK, 0, "X")]));

    expect(asError(await client.next()).code).toBe(ERROR_CODES.accountDisabled);
    expect(server.documentState.getVersion()).toBe(0);
  });

  it("rejects a transaction once the session has been revoked outright", async () => {
    const { client } = await connectJoinedAuthenticated();
    sessions.delete(adaToken);

    client.send(txFrame(0, 0, [insert(FIRST_BLOCK, 0, "X")]));
    expect(asError(await client.next()).code).toBe(ERROR_CODES.accountDisabled);
  });

  it("still answers reads from a revoked session", async () => {
    const { client } = await connectJoinedAuthenticated();
    sessions.delete(adaToken);

    // Only writes are gated. Closing the socket of a user who has just been
    // disabled belongs with the admin routes that do the disabling; until then
    // this socket can read but never write.
    client.send({ type: "resync" });
    expect(asResync(await client.next()).snapshot.version).toBe(0);
  });

  it("takes effect on the next transaction, with no reconnect", async () => {
    const { client } = await connectJoinedAuthenticated();

    client.send(txFrame(0, 0, [insert(FIRST_BLOCK, 0, "A")]));
    expect(asTx(await client.next()).version).toBe(1);

    users.setStatus(adaId, "readonly");
    client.send(txFrame(1, 1, [insert(FIRST_BLOCK, 1, "B")]));
    expect(asError(await client.next()).code).toBe(ERROR_CODES.readOnly);
    expect(asResync(await client.next()).snapshot.version).toBe(1);

    users.setStatus(adaId, "active");
    client.send(txFrame(2, 1, [insert(FIRST_BLOCK, 1, "C")]));
    expect(asTx(await client.next()).version).toBe(2);
  });

  it("keeps two authenticated users in sync", async () => {
    const { client: author } = await connectJoinedAuthenticated();
    const bobId = users.create("bob", "hunter2000", "user", Date.now()).id;
    const bobToken = sessions.create(bobId, Date.now()).token;
    const bob = await connectWith(`${SESSION_COOKIE}=${bobToken}`);
    bob.send({ type: "join" });
    await bob.next();

    author.send(txFrame(0, 0, [insert(FIRST_BLOCK, 0, "X")]));

    expect(asTx(await bob.next()).version).toBe(1);
  });

  it("serves the http handler and the websocket on one port", async () => {
    await server.close();
    server = createCollabServer({
      port: 0,
      auth: policy,
      httpHandler: (req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ path: req.url }));
      },
    });
    if (server.wss.address() === null) await once(server.wss, "listening");
    port = (server.wss.address() as AddressInfo).port;

    // The shared origin is the whole reason no protocol change was needed: the
    // browser sends the session cookie on the handshake because `/ws` sits on
    // the same host and port as the page that set it.
    const response = await fetch(`http://127.0.0.1:${port}/api/me`);
    expect(await response.json()).toEqual({ path: "/api/me" });

    const client = await connectWith(`${SESSION_COOKIE}=${adaToken}`);
    client.send({ type: "join" });
    expect(asWelcome(await client.next()).snapshot.version).toBe(0);
  });

  async function connectJoinedAuthenticated(): Promise<{ client: TestClient }> {
    const client = await connectWith(`${SESSION_COOKIE}=${adaToken}`);
    client.send({ type: "join" });
    await client.next();
    return { client };
  }
});
