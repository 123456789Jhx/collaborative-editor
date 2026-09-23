import type { Op } from "@collab/shared";

export interface TextDiff {
  offset: number;
  remove: number;
  insert: string;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function diffText(prev: string, next: string): TextDiff | null {
  if (prev === next) return null;

  const shortest = Math.min(prev.length, next.length);
  let start = 0;
  while (start < shortest && prev.charCodeAt(start) === next.charCodeAt(start)) {
    start += 1;
  }

  let prevEnd = prev.length;
  let nextEnd = next.length;
  while (
    prevEnd > start &&
    nextEnd > start &&
    prev.charCodeAt(prevEnd - 1) === next.charCodeAt(nextEnd - 1)
  ) {
    prevEnd -= 1;
    nextEnd -= 1;
  }

  // Keep surrogate pairs intact: a boundary landing on a low surrogate would
  // otherwise split an emoji into two invalid halves.
  if (start > 0 && isLowSurrogate(prev.charCodeAt(start))) {
    start -= 1;
  }
  if (prevEnd < prev.length && isLowSurrogate(prev.charCodeAt(prevEnd))) {
    prevEnd += 1;
    nextEnd += 1;
  }

  return { offset: start, remove: prevEnd - start, insert: next.slice(start, nextEnd) };
}

export function diffToOps(blockId: string, prev: string, next: string): Op[] {
  const diff = diffText(prev, next);
  if (diff === null) return [];

  const ops: Op[] = [];
  if (diff.remove > 0) {
    ops.push({ kind: "delete", blockId, offset: diff.offset, length: diff.remove });
  }
  if (diff.insert.length > 0) {
    ops.push({ kind: "insert", blockId, offset: diff.offset, text: diff.insert });
  }
  return ops;
}
