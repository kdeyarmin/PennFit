import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  PgcryptoNotInstalledError,
  assertPgcryptoEnabled,
  ensurePgcryptoEnabled,
  isPgcryptoEnabled,
} from "./preflight";

// We mock at the Pool granularity here (not the module) because the
// preflight helpers take a pool argument explicitly. That keeps these
// tests pool-agnostic — they exercise the SQL+error contract, not the
// pool singleton.

function fakePool(query: ReturnType<typeof vi.fn>): Pool {
  return { query } as unknown as Pool;
}

describe("@workspace/resupply-db preflight (pgcrypto)", () => {
  let queryMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queryMock = vi.fn();
  });

  afterEach(() => {
    queryMock.mockReset();
  });

  describe("isPgcryptoEnabled", () => {
    it("returns true when pg_extension contains pgcrypto", async () => {
      queryMock.mockResolvedValue({ rows: [{ exists: true }] });
      await expect(isPgcryptoEnabled(fakePool(queryMock))).resolves.toBe(true);
      // The query MUST be parameterized — pgcrypto bound as a value, not
      // string-concatenated into the SQL. This guards against a future
      // contributor "simplifying" it into a vulnerable form.
      expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("$1"), [
        "pgcrypto",
      ]);
    });

    it("returns false when pg_extension does not contain pgcrypto", async () => {
      queryMock.mockResolvedValue({ rows: [{ exists: false }] });
      await expect(isPgcryptoEnabled(fakePool(queryMock))).resolves.toBe(false);
    });

    it("returns false on an empty result set", async () => {
      queryMock.mockResolvedValue({ rows: [] });
      await expect(isPgcryptoEnabled(fakePool(queryMock))).resolves.toBe(false);
    });

    it("propagates underlying connection / auth errors verbatim", async () => {
      // Network or auth failures must surface as the original pg error
      // (not as a misleading PgcryptoNotInstalledError) so on-call can
      // diagnose connectivity vs missing-extension separately. This test
      // locks that contract.
      const dbErr = Object.assign(
        new Error("FATAL: password authentication failed"),
        { code: "28P01" },
      );
      queryMock.mockRejectedValue(dbErr);
      await expect(isPgcryptoEnabled(fakePool(queryMock))).rejects.toBe(dbErr);
    });
  });

  describe("assertPgcryptoEnabled", () => {
    it("resolves quietly when pgcrypto is installed", async () => {
      queryMock.mockResolvedValue({ rows: [{ exists: true }] });
      await expect(
        assertPgcryptoEnabled(fakePool(queryMock)),
      ).resolves.toBeUndefined();
    });

    it("throws PgcryptoNotInstalledError with an actionable message when missing", async () => {
      queryMock.mockResolvedValue({ rows: [{ exists: false }] });
      await expect(
        assertPgcryptoEnabled(fakePool(queryMock)),
      ).rejects.toBeInstanceOf(PgcryptoNotInstalledError);

      // Re-run to inspect the message text — the wording is a contract
      // because operators grep for it in logs.
      queryMock.mockResolvedValue({ rows: [{ exists: false }] });
      try {
        await assertPgcryptoEnabled(fakePool(queryMock));
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(PgcryptoNotInstalledError);
        const message = (err as Error).message;
        expect(message).toMatch(/pgcrypto extension is not installed/i);
        expect(message).toMatch(/CREATE EXTENSION IF NOT EXISTS pgcrypto/);
        // Must not echo the connection string or any DATABASE_URL fragment
        // back through the error — the same rule the readiness probe
        // follows.
        expect(message).not.toMatch(/postgres:\/\//i);
      }
    });
  });

  describe("ensurePgcryptoEnabled", () => {
    it("issues exactly one CREATE EXTENSION IF NOT EXISTS pgcrypto", async () => {
      queryMock.mockResolvedValue({ rowCount: 0, rows: [] });
      await ensurePgcryptoEnabled(fakePool(queryMock));
      expect(queryMock).toHaveBeenCalledTimes(1);
      const sql = queryMock.mock.calls[0]?.[0] as string;
      expect(sql).toMatch(/CREATE EXTENSION IF NOT EXISTS pgcrypto/i);
    });
  });
});
