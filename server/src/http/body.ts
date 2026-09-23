import type { IncomingMessage } from "node:http";

export const MAX_BODY_BYTES = 16 * 1024;

export type BodyResult = { ok: true; value: unknown } | { ok: false; message: string };

/**
 * Reads and parses a JSON request body, refusing anything oversized.
 *
 * The cap is enforced while streaming, by destroying the socket once the
 * running total passes it — not by checking `content-length`. A client that
 * omits or lies about the header would otherwise be able to make the server
 * buffer without bound.
 */
export async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      total += buffer.length;
      if (total > maxBytes) {
        req.destroy();
        return { ok: false, message: "Request body is too large" };
      }
      chunks.push(buffer);
    }
  } catch {
    return { ok: false, message: "Request body could not be read" };
  }

  if (total === 0) return { ok: false, message: "Request body is empty" };

  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, message: "Request body is not valid JSON" };
  }
}
