import { ERROR_CODES, LIMITS, isOpKind, isRecord, type Block, type Op } from "./protocol.js";

export function createBlock(id: string, text = ""): Block {
  return { id, text };
}

export function indexOfBlock(blocks: readonly Block[], id: string): number {
  return blocks.findIndex((block) => block.id === id);
}

export function findBlock(blocks: readonly Block[], id: string): Block | undefined {
  return blocks.find((block) => block.id === id);
}

export function cloneBlocks(blocks: readonly Block[]): Block[] {
  return blocks.map((block) => ({ id: block.id, text: block.text }));
}

export function validateOp(blocks: readonly Block[], op: unknown): string | null {
  if (!isRecord(op)) return ERROR_CODES.invalidOp;
  const kind = op["kind"];
  if (!isOpKind(kind)) return ERROR_CODES.invalidOp;

  const blockId = op["blockId"];
  if (typeof blockId !== "string" || blockId.length === 0) return ERROR_CODES.invalidOp;

  const index = indexOfBlock(blocks, blockId);
  if (index < 0) return ERROR_CODES.blockNotFound;

  const block = blocks[index];
  if (!block) return ERROR_CODES.blockNotFound;

  const offset = op["offset"];

  switch (kind) {
    case "insert": {
      const text = op["text"];
      if (typeof text !== "string") return ERROR_CODES.invalidOp;
      if (!Number.isInteger(offset)) return ERROR_CODES.invalidOp;
      const at = offset as number;
      if (at < 0 || at > block.text.length) return ERROR_CODES.offsetOutOfRange;
      if (block.text.length + text.length > LIMITS.maxTextLength) return ERROR_CODES.textTooLong;
      return null;
    }
    case "delete": {
      const length = op["length"];
      if (!Number.isInteger(offset) || !Number.isInteger(length)) return ERROR_CODES.invalidOp;
      const at = offset as number;
      const count = length as number;
      if (count < 0) return ERROR_CODES.invalidOp;
      if (at < 0 || at + count > block.text.length) return ERROR_CODES.offsetOutOfRange;
      return null;
    }
    case "split": {
      if (!Number.isInteger(offset)) return ERROR_CODES.invalidOp;
      const at = offset as number;
      if (at < 0 || at > block.text.length) return ERROR_CODES.offsetOutOfRange;

      const newBlockId = op["newBlockId"];
      if (typeof newBlockId !== "string" || newBlockId.length === 0) return ERROR_CODES.invalidOp;
      if (newBlockId === blockId) return ERROR_CODES.invalidOp;
      if (indexOfBlock(blocks, newBlockId) >= 0) return ERROR_CODES.duplicateBlockId;
      if (blocks.length >= LIMITS.maxBlocks) return ERROR_CODES.tooManyBlocks;
      return null;
    }
    case "merge": {
      if (index <= 0) return ERROR_CODES.cannotMergeFirst;
      const previous = blocks[index - 1];
      if (!previous) return ERROR_CODES.blockNotFound;
      if (previous.text.length + block.text.length > LIMITS.maxTextLength) {
        return ERROR_CODES.textTooLong;
      }
      return null;
    }
  }
}

export function validateOps(blocks: readonly Block[], ops: readonly unknown[]): string | null {
  if (ops.length === 0) return ERROR_CODES.invalidOp;
  if (ops.length > LIMITS.maxOpsPerTx) return ERROR_CODES.tooManyOps;

  let working = cloneBlocks(blocks);
  for (const op of ops) {
    const error = validateOp(working, op);
    if (error !== null) return error;
    working = applyOpUnchecked(working, op as Op);
  }
  return null;
}

export function applyOp(blocks: readonly Block[], op: Op): Block[] {
  const error = validateOp(blocks, op);
  if (error !== null) {
    throw new Error(`invalid op ${op.kind}: ${error}`);
  }
  return applyOpUnchecked(blocks, op);
}

export function applyOps(blocks: readonly Block[], ops: readonly Op[]): Block[] {
  let current = cloneBlocks(blocks);
  for (const op of ops) {
    current = applyOpUnchecked(current, op);
  }
  return current;
}

function applyOpUnchecked(blocks: readonly Block[], op: Op): Block[] {
  const next = cloneBlocks(blocks);
  const index = indexOfBlock(next, op.blockId);
  const block = next[index];
  if (index < 0 || !block) return next;

  switch (op.kind) {
    case "insert": {
      next[index] = { id: block.id, text: block.text.slice(0, op.offset) + op.text + block.text.slice(op.offset) };
      return next;
    }
    case "delete": {
      next[index] = { id: block.id, text: block.text.slice(0, op.offset) + block.text.slice(op.offset + op.length) };
      return next;
    }
    case "split": {
      next[index] = { id: block.id, text: block.text.slice(0, op.offset) };
      next.splice(index + 1, 0, createBlock(op.newBlockId, block.text.slice(op.offset)));
      return next;
    }
    case "merge": {
      const previous = next[index - 1];
      if (!previous) return next;
      next[index - 1] = { id: previous.id, text: previous.text + block.text };
      next.splice(index, 1);
      return next;
    }
  }
}

export function documentLength(blocks: readonly Block[]): number {
  return blocks.reduce((total, block) => total + block.text.length, 0);
}

export function serializeBlocks(blocks: readonly Block[]): string {
  return blocks.map((block) => block.text).join("\n");
}
