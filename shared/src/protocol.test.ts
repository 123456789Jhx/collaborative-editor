import { describe, expect, it } from "vitest";
import { LIMITS, parseClientMessage } from "./protocol.js";

function tx(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "tx",
    tx: { seq: 0, baseVersion: 0, ops: [{ kind: "insert", blockId: "b1", offset: 0, text: "x" }], ...overrides },
  });
}

describe("parseClientMessage accepts the three client messages", () => {
  it("round-trips join", () => {
    expect(parseClientMessage('{"type":"join"}')).toEqual({ type: "join" });
  });

  it("round-trips resync", () => {
    expect(parseClientMessage('{"type":"resync"}')).toEqual({ type: "resync" });
  });

  it("round-trips a tx", () => {
    const parsed = parseClientMessage(tx());
    expect(parsed).toEqual({
      type: "tx",
      tx: {
        seq: 0,
        baseVersion: 0,
        ops: [{ kind: "insert", blockId: "b1", offset: 0, text: "x" }],
      },
    });
  });
});

describe("parsing checks shape only, never op semantics", () => {
  it("accepts an op with an unknown kind", () => {
    // Ops are cast, not inspected. validateOps owns semantic rejection, which is
    // what keeps the wire format free to grow.
    const parsed = parseClientMessage(tx({ ops: [{ kind: "bogus" }] }));
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("tx");
  });

  it("accepts an op that is not even an object", () => {
    expect(parseClientMessage(tx({ ops: [null] }))).not.toBeNull();
  });

  it("accepts an empty op list", () => {
    // Rejected later as INVALID_OP — empty transactions are a semantic problem.
    expect(parseClientMessage(tx({ ops: [] }))).not.toBeNull();
  });
});

describe("parseClientMessage rejects malformed input", () => {
  const rejected: Array<[string, string]> = [
    ["not JSON", "{nope"],
    ["a JSON array", "[]"],
    ["a JSON scalar", '"join"'],
    ["null", "null"],
    ["an unknown message type", '{"type":"nope"}'],
    ["a tx with no tx field", '{"type":"tx"}'],
    ["a tx whose tx field is not an object", '{"type":"tx","tx":"x"}'],
    ["a negative seq", tx({ seq: -1 })],
    ["a fractional seq", tx({ seq: 1.5 })],
    ["a string seq", tx({ seq: "1" })],
    ["a missing baseVersion", '{"type":"tx","tx":{"seq":0,"ops":[]}}'],
    ["a negative baseVersion", tx({ baseVersion: -1 })],
    ["ops that are not an array", tx({ ops: "x" })],
  ];

  for (const [label, raw] of rejected) {
    it(`rejects ${label}`, () => {
      expect(parseClientMessage(raw)).toBeNull();
    });
  }
});

describe("op count is bounded at the wire", () => {
  function withOps(count: number): string {
    const ops = Array.from({ length: count }, () => ({ kind: "delete", blockId: "b1", offset: 0, length: 0 }));
    return tx({ ops });
  }

  it("accepts exactly the limit", () => {
    expect(parseClientMessage(withOps(LIMITS.maxOpsPerTx))).not.toBeNull();
  });

  it("rejects one past the limit", () => {
    expect(parseClientMessage(withOps(LIMITS.maxOpsPerTx + 1))).toBeNull();
  });
});

describe("oversized frames are dropped before parsing", () => {
  it("returns null without throwing on a frame past the length limit", () => {
    const huge = `{"type":"join","pad":"${"x".repeat(LIMITS.maxMessageLength)}"}`;
    expect(huge.length).toBeGreaterThan(LIMITS.maxMessageLength);
    expect(() => parseClientMessage(huge)).not.toThrow();
    expect(parseClientMessage(huge)).toBeNull();
  });
});
