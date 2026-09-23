import { describe, expect, it } from "vitest";
import { applyOps, type Block } from "@collab/shared";
import { diffText, diffToOps } from "./text-diff.js";

describe("diffText trims the common prefix and suffix", () => {
  it("reports a pure deletion as a deletion", () => {
    expect(diffText("hello world", "hello")).toEqual({ offset: 5, remove: 6, insert: "" });
  });

  it("reports a pure insertion at the end", () => {
    expect(diffText("hello", "hello world")).toEqual({ offset: 5, remove: 0, insert: " world" });
  });

  it("trims maximally, so inserting a word is one insert and no delete", () => {
    // The 'w' of "world" is common to both, so it is folded into the suffix and the
    // diff never has to touch it.
    expect(diffText("hello world", "hello brave world")).toEqual({
      offset: 6,
      remove: 0,
      insert: "brave ",
    });
  });

  it("collapses a swapped character into one replacement", () => {
    expect(diffText("abc", "axc")).toEqual({ offset: 1, remove: 1, insert: "x" });
  });

  it("returns null when nothing changed", () => {
    expect(diffText("same", "same")).toBeNull();
  });
});

describe("diffText keeps surrogate pairs intact", () => {
  it("removes both halves of a deleted emoji", () => {
    expect(diffText("a😀b", "ab")).toEqual({ offset: 1, remove: 2, insert: "" });
  });

  it("never leaves a lone low surrogate when two emoji share a high surrogate", () => {
    // 😀 is D83D DE00 and 😁 is D83D DE01, so the common prefix scan stops between
    // the two halves. Without the guard in diffText this would report
    // { offset: 1, remove: 1, insert: "\uDE01" } — a half character on the wire.
    expect(diffText("😀", "😁")).toEqual({ offset: 0, remove: 2, insert: "😁" });
  });

  it("widens the window when both boundaries land mid-pair", () => {
    expect(diffText("😀x", "😁😀x")).toEqual({ offset: 0, remove: 2, insert: "😁😀" });
  });

  it("produces only whole characters", () => {
    // Asserts the shape, not the round-trip: JS slicing is index-based and lossless
    // at any index, so replaying the ops would still yield "😁" even when the op
    // itself contains a half character. The round-trip table below cannot catch
    // this bug; only the exact offsets can.
    for (const [prev, next] of [
      ["😀", "😁"],
      ["😀x", "😁😀x"],
      ["a😀b", "ab"],
    ] as Array<[string, string]>) {
      const diff = diffText(prev, next);
      expect(diff).not.toBeNull();
      const text = diff?.insert ?? "";
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        const isLow = code >= 0xdc00 && code <= 0xdfff;
        const precededByHigh = i > 0 && text.charCodeAt(i - 1) >= 0xd800 && text.charCodeAt(i - 1) <= 0xdbff;
        expect(!isLow || precededByHigh).toBe(true);
      }
    }
  });
});

describe("diffToOps", () => {
  it("emits delete before insert, because the ops are applied in order", () => {
    // Reversing them would delete the text the insert just added.
    expect(diffToOps("b1", "abc", "axc")).toEqual([
      { kind: "delete", blockId: "b1", offset: 1, length: 1 },
      { kind: "insert", blockId: "b1", offset: 1, text: "x" },
    ]);
  });

  it("emits a single op for a single-character edit", () => {
    expect(diffToOps("b1", "hello", "hello!")).toEqual([
      { kind: "insert", blockId: "b1", offset: 5, text: "!" },
    ]);
  });

  it("emits nothing when the text is unchanged", () => {
    expect(diffToOps("b1", "same", "same")).toEqual([]);
  });

  it("names the block in every op", () => {
    for (const op of diffToOps("block-42", "abc", "axc")) {
      expect(op.blockId).toBe("block-42");
    }
  });
});

describe("replaying the diff reproduces the edit", () => {
  const cases: Array<[string, string]> = [
    ["", "x"],
    ["", "😀"],
    ["abc", ""],
    ["hello world", "hello brave world"],
    ["😀😀", "😀"],
    ["a😀b", "ab"],
    ["abc", "axc"],
    ["one two three", "one three"],
    ["no change", "no change"],
  ];

  for (const [prev, next] of cases) {
    it(`${JSON.stringify(prev)} -> ${JSON.stringify(next)}`, () => {
      const blocks: Block[] = [{ id: "b1", text: prev }];
      const result = applyOps(blocks, diffToOps("b1", prev, next));
      expect(result).toEqual([{ id: "b1", text: next }]);
    });
  }
});
