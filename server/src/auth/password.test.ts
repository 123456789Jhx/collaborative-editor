import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("hashPassword", () => {
  it("round-trips a password", () => {
    const record = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", record)).toBe(true);
  });

  it("rejects a different password", () => {
    const record = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery stapl", record)).toBe(false);
    expect(verifyPassword("", record)).toBe(false);
  });

  it("salts, so the same password hashes differently every time", () => {
    const first = hashPassword("same-password");
    const second = hashPassword("same-password");

    expect(first.salt).not.toBe(second.salt);
    expect(first.hash).not.toBe(second.hash);
    // Both remain valid against their own record — proving the difference is
    // the salt and not a broken derivation.
    expect(verifyPassword("same-password", first)).toBe(true);
    expect(verifyPassword("same-password", second)).toBe(true);
  });

  it("stores hex, not raw bytes", () => {
    const record = hashPassword("whatever");
    expect(record.hash).toMatch(/^[0-9a-f]{128}$/);
    expect(record.salt).toMatch(/^[0-9a-f]{32}$/);
  });

  it("handles unicode and long passwords", () => {
    const password = "口令-🔐-" + "x".repeat(200);
    expect(verifyPassword(password, hashPassword(password))).toBe(true);
  });
});

describe("verifyPassword against a corrupt record", () => {
  // A row damaged in storage must read as "wrong password". Throwing here would
  // turn a corrupt record into a 500 on the login route instead.
  it("returns false for an empty record", () => {
    expect(verifyPassword("anything", { hash: "", salt: "" })).toBe(false);
  });

  it("returns false for a truncated hash", () => {
    const record = hashPassword("anything");
    expect(verifyPassword("anything", { ...record, hash: record.hash.slice(0, 32) })).toBe(false);
  });

  it("returns false for a truncated salt", () => {
    const record = hashPassword("anything");
    expect(verifyPassword("anything", { ...record, salt: "ab" })).toBe(false);
  });

  it("returns false for non-hex garbage", () => {
    const record = hashPassword("anything");
    expect(verifyPassword("anything", { ...record, hash: "z".repeat(128) })).toBe(false);
  });
});
