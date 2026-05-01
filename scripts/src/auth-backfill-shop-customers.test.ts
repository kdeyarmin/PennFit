import { describe, expect, it } from "vitest";

import {
  normalizeRows,
  parseCsv,
} from "./auth-backfill-shop-customers";

describe("parseCsv", () => {
  it("parses a minimal Clerk-shaped header + row", () => {
    const text =
      `id,first_name,last_name,username,primary_email_address,primary_phone_number,verified_email_addresses,unverified_email_addresses,verified_phone_numbers,unverified_phone_numbers,totp_secret,password_digest,password_hasher\n` +
      `user_abc,Alice,Smith,,alice@example.com,,alice@example.com,,,,,$2b$10$abc,bcrypt\n`;
    const grid = parseCsv(text);
    expect(grid).toHaveLength(2);
    expect(grid[0]![0]).toBe("id");
    expect(grid[1]![0]).toBe("user_abc");
    expect(grid[1]![11]).toBe("$2b$10$abc");
    expect(grid[1]![12]).toBe("bcrypt");
  });

  it("handles quoted cells with commas + doubled-quote escapes", () => {
    const text = `a,b,c\n"hello, world","she said ""hi""",x\n`;
    const grid = parseCsv(text);
    expect(grid[1]).toEqual(["hello, world", 'she said "hi"', "x"]);
  });

  it("handles CRLF line endings", () => {
    const text = `a,b\r\n1,2\r\n3,4\r\n`;
    const grid = parseCsv(text);
    expect(grid).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("flushes the final row even without a trailing newline", () => {
    const text = `a,b\n1,2`;
    const grid = parseCsv(text);
    expect(grid).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("normalizeRows", () => {
  function build(rows: Record<string, string>[]): string[][] {
    if (rows.length === 0) return [];
    const header = Object.keys(rows[0]!);
    return [header, ...rows.map((r) => header.map((h) => r[h] ?? ""))];
  }

  it("flags primaryEmailVerified=true when the email appears in verified_email_addresses", () => {
    const grid = build([
      {
        id: "user_1",
        first_name: "Alice",
        last_name: "Smith",
        primary_email_address: "alice@example.com",
        verified_email_addresses: "alice@example.com",
        password_digest: "$2b$10$abc",
        password_hasher: "bcrypt",
      },
    ]);
    const rows = normalizeRows(grid);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.primaryEmailVerified).toBe(true);
    expect(rows[0]!.passwordDigest).toBe("$2b$10$abc");
    expect(rows[0]!.passwordHasher).toBe("bcrypt");
  });

  it("flags primaryEmailVerified=false when the email is unverified", () => {
    const grid = build([
      {
        id: "user_2",
        primary_email_address: "bob@example.com",
        verified_email_addresses: "",
        password_digest: "",
        password_hasher: "",
      },
    ]);
    const rows = normalizeRows(grid);
    expect(rows[0]!.primaryEmailVerified).toBe(false);
    expect(rows[0]!.passwordDigest).toBeNull();
    expect(rows[0]!.passwordHasher).toBeNull();
  });

  it("treats an empty password_digest as null (passwordless / OAuth-only Clerk user)", () => {
    const grid = build([
      {
        id: "user_3",
        primary_email_address: "c@example.com",
        verified_email_addresses: "c@example.com",
        password_digest: "",
        password_hasher: "",
      },
    ]);
    const rows = normalizeRows(grid);
    expect(rows[0]!.passwordDigest).toBeNull();
    expect(rows[0]!.passwordHasher).toBeNull();
  });

  it("verified_email_addresses with multiple comma-separated values matches case-insensitively", () => {
    const grid = build([
      {
        id: "user_4",
        primary_email_address: "Alice@Example.com",
        verified_email_addresses: "old@example.com, alice@example.com",
        password_digest: "",
        password_hasher: "",
      },
    ]);
    const rows = normalizeRows(grid);
    expect(rows[0]!.primaryEmailVerified).toBe(true);
  });

  it("skips entirely-empty rows", () => {
    const grid = [
      ["id", "primary_email_address"],
      ["", ""],
      ["user_x", "x@example.com"],
    ];
    const rows = normalizeRows(grid);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.clerkUserId).toBe("user_x");
  });

  it("returns [] for an empty header", () => {
    expect(normalizeRows([])).toEqual([]);
  });
});
