/**
 * SQLite hands back `Record<string, SQLOutputValue>`, and `noUncheckedIndexedAccess`
 * makes every column read `| undefined` on top of that. These narrow once, in one
 * place, so the repositories read as ordinary code.
 *
 * They take `unknown` rather than `SQLOutputValue` so that a `undefined` from an
 * index access passes without a cast at every call site.
 */

export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function int(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
}
