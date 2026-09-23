import {
  applyOps,
  cloneBlocks,
  createBlock,
  validateOps,
  type Block,
  type Snapshot,
  type StampedTx,
} from "@collab/shared";

export type ApplyResult =
  | { ok: true; version: number }
  | { ok: false; code: string };

export class DocumentState {
  private blocks: Block[];
  private version = 0;

  constructor(initial?: readonly Block[]) {
    this.blocks = initial
      ? cloneBlocks(initial)
      : [createBlock("block-1", "Open this page in a second tab to see live sync.")];
  }

  getVersion(): number {
    return this.version;
  }

  snapshot(): Snapshot {
    return { version: this.version, blocks: cloneBlocks(this.blocks) };
  }

  applyTx(tx: StampedTx): ApplyResult {
    const error = validateOps(this.blocks, tx.ops);
    if (error !== null) return { ok: false, code: error };

    this.blocks = applyOps(this.blocks, tx.ops);
    this.version += 1;
    return { ok: true, version: this.version };
  }
}
