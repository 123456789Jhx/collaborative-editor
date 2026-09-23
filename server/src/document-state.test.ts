import { describe, expect, it } from "vitest";
import { ERROR_CODES, type Block, type Op, type StampedTx } from "@collab/shared";
import { DocumentState } from "./document-state.js";

function stamped(ops: Op[], overrides: Partial<StampedTx> = {}): StampedTx {
  return { clientId: "client-a", seq: 0, baseVersion: 0, ops, ...overrides };
}

const INSERT: Op = { kind: "insert", blockId: "b1", offset: 5, text: "X" };

function initial(): Block[] {
  return [{ id: "b1", text: "hello world" }];
}

describe("construction", () => {
  it("starts with a placeholder document so the first peer has something to edit", () => {
    const state = new DocumentState();
    const snapshot = state.snapshot();
    expect(snapshot.version).toBe(0);
    expect(snapshot.blocks).toHaveLength(1);
    expect(snapshot.blocks[0]?.text.length).toBeGreaterThan(0);
  });

  it("clones the caller's blocks instead of aliasing them", () => {
    const blocks = initial();
    const state = new DocumentState(blocks);
    blocks[0] = { id: "b1", text: "clobbered" };
    expect(state.snapshot().blocks).toEqual(initial());
  });
});

describe("snapshot", () => {
  it("is a deep copy, so a caller cannot write through to server state", () => {
    // The client holds this object directly (main.ts hands it to setBlocks), so a
    // shared array would let a browser mutate the server's document.
    const state = new DocumentState(initial());
    const snapshot = state.snapshot();
    snapshot.blocks[0]!.text = "clobbered";
    snapshot.blocks.push({ id: "injected", text: "!" });
    expect(state.snapshot().blocks).toEqual(initial());
  });

  it("reports the version the state is at", () => {
    const state = new DocumentState(initial());
    state.applyTx(stamped([INSERT]));
    expect(state.snapshot().version).toBe(state.getVersion());
  });
});

describe("applyTx", () => {
  it("applies the ops and returns the new version", () => {
    const state = new DocumentState(initial());
    expect(state.applyTx(stamped([INSERT]))).toEqual({ ok: true, version: 1 });
    expect(state.snapshot().blocks).toEqual([{ id: "b1", text: "helloX world" }]);
  });

  it("increments the version by exactly one per accepted tx", () => {
    // Cross-module contract: connection.ts decides a gap occurred with
    // `parsed.version !== this.version + 1`. That test is only sound if the server
    // never skips or repeats a version.
    const state = new DocumentState(initial());
    for (let expected = 1; expected <= 5; expected += 1) {
      expect(state.applyTx(stamped([INSERT])).ok).toBe(true);
      expect(state.getVersion()).toBe(expected);
    }
  });

  it("rejects an invalid transaction without touching the document", () => {
    const state = new DocumentState(initial());
    const before = state.snapshot();
    const result = state.applyTx(stamped([{ kind: "insert", blockId: "b1", offset: 99, text: "X" }]));
    expect(result).toEqual({ ok: false, code: ERROR_CODES.offsetOutOfRange });
    expect(state.snapshot()).toEqual(before);
  });

  it("rejects the whole transaction when one op is invalid", () => {
    const state = new DocumentState(initial());
    const ops: Op[] = [INSERT, { kind: "delete", blockId: "b1", offset: 99, length: 1 }];
    expect(state.applyTx(stamped(ops)).ok).toBe(false);
    expect(state.snapshot().blocks).toEqual(initial());
  });
});

describe("documented Phase 1 limitations", () => {
  it("ignores baseVersion — stale-tx detection is Phase 2", () => {
    // The field is on the wire and validated for shape, but never compared against
    // the current version. This is the brief's "how do you stop a stale edit"
    // question, answered honestly: not yet.
    const state = new DocumentState(initial());
    expect(state.applyTx(stamped([INSERT], { baseVersion: 999 }))).toEqual({ ok: true, version: 1 });
  });

  it("applies a replayed transaction twice — (clientId, seq) dedupe is Phase 2", () => {
    // Pinned deliberately, not endorsed. At-least-once delivery from the client
    // therefore duplicates the edit rather than being absorbed. See the README for
    // the high-water-mark design that fixes it.
    const state = new DocumentState(initial());
    const tx = stamped([INSERT], { seq: 0 });
    state.applyTx(tx);
    state.applyTx(tx);
    expect(state.snapshot().blocks).toEqual([{ id: "b1", text: "helloXX world" }]);
    expect(state.getVersion()).toBe(2);
  });
});
