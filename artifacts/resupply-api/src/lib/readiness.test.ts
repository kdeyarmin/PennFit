import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the SHARED pool exported from `@workspace/resupply-db` so we
// never hit a real database from this unit test, AND so this test
// doubles as a guard that readiness.ts goes through the shared pool
// (not its own private one — see Task #7). Every other resupply-db
// export is preserved so unrelated imports keep working.
const queryMock = vi.fn();
vi.mock("@workspace/resupply-db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/resupply-db")>(
      "@workspace/resupply-db",
    );
  return {
    ...actual,
    getDbPool: () => ({ query: queryMock }),
  };
});

import { checkReadiness } from "./readiness";

describe("checkReadiness()", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  // The queue-check SQL also contains "SELECT 1" (inside its
  // `SELECT EXISTS (SELECT 1 FROM information_schema...)`), so we
  // distinguish the two checks by looking for `information_schema`
  // — only the queue check probes that catalog.
  const isQueueCheck = (sql: string): boolean =>
    sql.includes("information_schema");

  it("returns status=ready when both checks succeed", async () => {
    queryMock.mockImplementation((sql: string) => {
      if (isQueueCheck(sql)) return Promise.resolve({ rows: [{ exists: true }] });
      return Promise.resolve({ rows: [{}] });
    });
    const result = await checkReadiness();
    expect(result.status).toBe("ready");
    expect(result.checks).toEqual({ db: "ok", queue: "ok" });
    expect(result.errors).toBeUndefined();
  });

  it("returns status=not_ready with categorized db error when SELECT 1 fails with ECONNREFUSED", async () => {
    queryMock.mockImplementation((sql: string) => {
      if (isQueueCheck(sql)) return Promise.resolve({ rows: [{ exists: true }] });
      const err = Object.assign(
        new Error("connect ECONNREFUSED 127.0.0.1:5432"),
        { code: "ECONNREFUSED" },
      );
      return Promise.reject(err);
    });
    const result = await checkReadiness();
    expect(result.status).toBe("not_ready");
    expect(result.checks.db).toBe("failed");
    expect(result.checks.queue).toBe("ok");
    expect(result.errors).toEqual({ db: "connection_refused" });
  });

  it("flags queue as schema_not_initialized when the pg-boss schema is absent", async () => {
    queryMock.mockImplementation((sql: string) => {
      if (isQueueCheck(sql)) return Promise.resolve({ rows: [{ exists: false }] });
      return Promise.resolve({ rows: [{}] });
    });
    const result = await checkReadiness();
    expect(result.status).toBe("not_ready");
    expect(result.checks.queue).toBe("failed");
    expect(result.errors?.queue).toBe("schema_not_initialized");
    // db is still ok in this scenario, so it must NOT appear in errors.
    expect(result.errors?.db).toBeUndefined();
  });

  it("collapses unknown errors to the safe 'unavailable' bucket", async () => {
    queryMock.mockImplementation(() =>
      Promise.reject(new Error("some unexpected driver string")),
    );
    const result = await checkReadiness();
    expect(result.status).toBe("not_ready");
    expect(result.errors?.db).toBe("unavailable");
    expect(result.errors?.queue).toBe("unavailable");
  });
});
