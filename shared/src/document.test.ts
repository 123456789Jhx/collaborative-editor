import { describe, expect, it } from "vitest";
import { ERROR_CODES, LIMITS, type Block, type Op } from "./protocol.js";
import { applyOp, applyOps, cloneBlocks, validateOp, validateOps } from "./document.js";

function blocks(...pairs: Array<[string, string]>): Block[] {
  return pairs.map(([id, text]) => ({ id, text }));
}

function one(text: string): Block[] {
  return blocks(["b1", text]);
}

function insert(blockId: string, offset: number, text: string): Op {
  return { kind: "insert", blockId, offset, text };
}

function remove(blockId: string, offset: number, length: number): Op {
  return { kind: "delete", blockId, offset, length };
}

function split(blockId: string, offset: number, newBlockId: string): Op {
  return { kind: "split", blockId, offset, newBlockId };
}

function merge(blockId: string): Op {
  return { kind: "merge", blockId };
}

describe("validateOps folds a working state", () => {
  it("accepts a split followed by an insert into the block it created", () => {
    // The insert names a block that does not exist yet in the *input* state. This
    // only passes because each op is validated against the result of the ones
    // before it, which is the whole reason validateOps clones and folds.
    const ops = [split("b1", 5, "b2"), insert("b2", 0, "new ")];
    expect(validateOps(one("hello world"), ops)).toBeNull();
  });

  it("rejects the same two ops in the reverse order", () => {
    // Order is semantic, not cosmetic: an insert into b2 before b2 exists has
    // nothing to attach to.
    const ops = [insert("b2", 0, "new "), split("b1", 5, "b2")];
    expect(validateOps(one("hello world"), ops)).toBe(ERROR_CODES.blockNotFound);
  });

  it("rejects a transaction where a later op is invalid, applying none of it", () => {
    const state = one("hello world");
    const before = cloneBlocks(state);
    const ops = [insert("b1", 0, "x"), remove("b1", 99, 1)];
    expect(validateOps(state, ops)).toBe(ERROR_CODES.offsetOutOfRange);
    expect(state).toEqual(before);
  });

  it("rejects an empty transaction", () => {
    expect(validateOps(one("hello"), [])).toBe(ERROR_CODES.invalidOp);
  });

  it("rejects more ops than the limit allows", () => {
    const ops = Array.from({ length: LIMITS.maxOpsPerTx + 1 }, () => insert("b1", 0, "x"));
    expect(validateOps(one("hello"), ops)).toBe(ERROR_CODES.tooManyOps);
  });
});

describe("op ordering", () => {
  it("applies delete-then-insert as a replacement", () => {
    const ops = [remove("b1", 5, 5), insert("b1", 5, "there")];
    expect(validateOps(one("hello world"), ops)).toBeNull();
    expect(applyOps(one("hello world"), ops)).toEqual(one("hellothered"));
  });

  it("deletes text the other order just inserted", () => {
    // diffToOps emits delete before insert for exactly this reason.
    const ops = [insert("b1", 5, "there"), remove("b1", 5, 5)];
    expect(applyOps(one("hello world"), ops)).toEqual(one("hello world"));
  });
});

describe("applyOps trusts its caller", () => {
  it("leaves the document unchanged for an unknown block id", () => {
    // The server only reaches applyOps through validateOps, which rejects this
    // first. Pinned so the split of responsibility is deliberate, not accidental.
    expect(applyOps(one("hello"), [insert("nope", 0, "x")])).toEqual(one("hello"));
  });

  it("leaves the document unchanged for an out-of-range delete, without throwing", () => {
    expect(applyOps(one("hello world"), [remove("b1", 99, 1)])).toEqual(one("hello world"));
  });

  it("throws on an invalid op where applyOps does not", () => {
    // The only behavioural difference between the two entry points.
    expect(() => applyOp(one("hello"), insert("b1", 99, "x"))).toThrow(/OFFSET_OUT_OF_RANGE/);
  });
});

describe("no function mutates its input", () => {
  const state = (): Block[] => blocks(["b1", "hello"], ["b2", "world"]);

  it("leaves applyOp's input untouched", () => {
    const before = state();
    applyOp(before, insert("b1", 5, "!"));
    expect(before).toEqual(state());
  });

  it("leaves applyOps's input untouched", () => {
    const before = state();
    applyOps(before, [insert("b1", 5, "!"), merge("b2")]);
    expect(before).toEqual(state());
  });

  it("leaves split and merge inputs untouched", () => {
    const before = state();
    applyOps(before, [split("b1", 2, "b3"), merge("b2")]);
    expect(before).toEqual(state());
  });
});

describe("validateOp boundaries", () => {
  const state = one("hello");

  it("allows an insert at the end of the text", () => {
    expect(validateOp(state, insert("b1", 5, "!"))).toBeNull();
  });

  it("rejects an insert one past the end", () => {
    expect(validateOp(state, insert("b1", 6, "!"))).toBe(ERROR_CODES.offsetOutOfRange);
  });

  it("rejects a non-integer offset", () => {
    expect(validateOp(state, insert("b1", 1.5, "!"))).toBe(ERROR_CODES.invalidOp);
  });

  it("rejects an unknown op kind", () => {
    expect(validateOp(state, { kind: "replace", blockId: "b1" })).toBe(ERROR_CODES.invalidOp);
  });

  it("rejects an op naming a block that does not exist", () => {
    expect(validateOp(state, insert("b2", 0, "!"))).toBe(ERROR_CODES.blockNotFound);
  });

  it("allows a zero-length delete", () => {
    expect(validateOp(state, remove("b1", 2, 0))).toBeNull();
  });

  it("rejects a delete running past the end", () => {
    expect(validateOp(state, remove("b1", 2, 4))).toBe(ERROR_CODES.offsetOutOfRange);
  });

  it("allows a split at either end of the text", () => {
    expect(validateOp(state, split("b1", 0, "b2"))).toBeNull();
    expect(validateOp(state, split("b1", 5, "b3"))).toBeNull();
  });

  it("rejects a split reusing its own block id", () => {
    expect(validateOp(state, split("b1", 2, "b1"))).toBe(ERROR_CODES.invalidOp);
  });

  it("rejects a split reusing an existing block id", () => {
    const two = blocks(["b1", "hello"], ["b2", "world"]);
    expect(validateOp(two, split("b1", 2, "b2"))).toBe(ERROR_CODES.duplicateBlockId);
  });

  it("rejects a split once the block limit is reached", () => {
    const many = blocks(
      ...Array.from({ length: LIMITS.maxBlocks }, (_, i) => [`b${i}`, "x"] as [string, string]),
    );
    expect(validateOp(many, split("b0", 1, "fresh"))).toBe(ERROR_CODES.tooManyBlocks);
  });

  it("rejects an insert that would make a block too long", () => {
    const long = one("x".repeat(LIMITS.maxTextLength));
    expect(validateOp(long, insert("b1", 0, "x"))).toBe(ERROR_CODES.textTooLong);
  });

  it("refuses to merge the first block", () => {
    const two = blocks(["b1", "hello"], ["b2", "world"]);
    expect(validateOp(two, merge("b1"))).toBe(ERROR_CODES.cannotMergeFirst);
  });

  it("rejects a merge that would make the previous block too long", () => {
    const two = blocks(["b1", "x".repeat(LIMITS.maxTextLength)], ["b2", "y"]);
    expect(validateOp(two, merge("b2"))).toBe(ERROR_CODES.textTooLong);
  });
});

describe("merge", () => {
  it("joins a block onto the previous one and drops it", () => {
    const two = blocks(["b1", "hello"], ["b2", "world"]);
    expect(applyOps(two, [merge("b2")])).toEqual(blocks(["b1", "helloworld"]));
  });

  it("keeps the previous block's id, so peers can still name it", () => {
    const result = applyOps(blocks(["a", "one"], ["b", "two"]), [merge("b")]);
    expect(result.map((block) => block.id)).toEqual(["a"]);
  });
});

describe("split", () => {
  it("moves the tail into a new block", () => {
    const result = applyOps(one("hello world"), [split("b1", 5, "b2")]);
    expect(result).toEqual(blocks(["b1", "hello"], ["b2", " world"]));
  });
});
