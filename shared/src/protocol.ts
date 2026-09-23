export type BlockId = string;
export type ClientId = string;

export interface Block {
  id: BlockId;
  text: string;
}

export interface Snapshot {
  version: number;
  blocks: Block[];
}

export type Op =
  | { kind: "insert"; blockId: BlockId; offset: number; text: string }
  | { kind: "delete"; blockId: BlockId; offset: number; length: number }
  | { kind: "split"; blockId: BlockId; offset: number; newBlockId: BlockId }
  | { kind: "merge"; blockId: BlockId };

export type OpKind = Op["kind"];

export interface TxPayload {
  seq: number;
  baseVersion: number;
  ops: Op[];
}

export interface StampedTx extends TxPayload {
  clientId: ClientId;
}

export type ClientMessage =
  | { type: "join" }
  | { type: "resync" }
  | { type: "tx"; tx: TxPayload };

export type ServerMessage =
  | { type: "welcome"; clientId: ClientId; snapshot: Snapshot }
  | { type: "tx"; tx: StampedTx; version: number }
  | { type: "resync"; snapshot: Snapshot }
  | { type: "error"; code: string; message: string };

export const LIMITS = {
  maxOpsPerTx: 200,
  maxTextLength: 10_000,
  maxBlocks: 500,
  maxMessageLength: 1_000_000,
} as const;

export const ERROR_CODES = {
  invalidMessage: "INVALID_MESSAGE",
  invalidOp: "INVALID_OP",
  blockNotFound: "BLOCK_NOT_FOUND",
  offsetOutOfRange: "OFFSET_OUT_OF_RANGE",
  textTooLong: "TEXT_TOO_LONG",
  tooManyBlocks: "TOO_MANY_BLOCKS",
  duplicateBlockId: "DUPLICATE_BLOCK_ID",
  cannotMergeFirst: "CANNOT_MERGE_FIRST",
  tooManyOps: "TOO_MANY_OPS",
  notJoined: "NOT_JOINED",
  // Authorization. These are additive: `ServerMessage.error.code` is typed as a
  // plain `string`, so nothing fails to compile when a client forgets to handle
  // them — grep for the literals when adding client-side branches.
  unauthenticated: "UNAUTHENTICATED",
  readOnly: "READ_ONLY",
  accountDisabled: "ACCOUNT_DISABLED",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

const OP_KINDS: readonly OpKind[] = ["insert", "delete", "split", "merge"];

export function isOpKind(value: unknown): value is OpKind {
  return typeof value === "string" && (OP_KINDS as readonly string[]).includes(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > LIMITS.maxMessageLength) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;

  if (parsed["type"] === "join") return { type: "join" };
  if (parsed["type"] === "resync") return { type: "resync" };

  if (parsed["type"] !== "tx") return null;

  const tx = parsed["tx"];
  if (!isRecord(tx)) return null;

  const seq = tx["seq"];
  const baseVersion = tx["baseVersion"];
  const ops = tx["ops"];

  if (!Number.isInteger(seq) || (seq as number) < 0) return null;
  if (!Number.isInteger(baseVersion) || (baseVersion as number) < 0) return null;
  if (!Array.isArray(ops)) return null;
  if (ops.length > LIMITS.maxOpsPerTx) return null;

  return {
    type: "tx",
    tx: {
      seq: seq as number,
      baseVersion: baseVersion as number,
      ops: ops as Op[],
    },
  };
}
