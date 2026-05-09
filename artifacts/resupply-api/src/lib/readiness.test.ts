import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Supabase service-role client so the db check never hits a
// real database. The queue check is in-memory now (`isWorkerReady()`),
// so we mock the worker module too.
const builderMock = vi.fn();
vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return {
    ...actual,
    getSupabaseServiceRoleClient: () => ({
      schema: () => ({
        from: () => ({
          select: () => ({
            limit: () => builderMock(),
          }),
        }),
      }),
    }),
  };
});

const isWorkerReadyMock = vi.fn();
vi.mock("../worker/index.js", () => ({
  isWorkerReady: () => isWorkerReadyMock(),
}));

import { checkReadiness } from "./readiness";

describe("checkReadiness()", () => {
  beforeEach(() => {
    builderMock.mockReset();
    isWorkerReadyMock.mockReset();
  });

  it("returns status=ready when both checks succeed", async () => {
    builderMock.mockResolvedValue({ error: null });
    isWorkerReadyMock.mockReturnValue(true);
    const result = await checkReadiness();
    expect(result.status).toBe("ready");
    expect(result.checks).toEqual({ db: "ok", queue: "ok" });
    expect(result.errors).toBeUndefined();
  });

  it("returns status=not_ready with categorized db error when the PostgREST request fails with ECONNREFUSED", async () => {
    isWorkerReadyMock.mockReturnValue(true);
    builderMock.mockRejectedValue(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
        code: "ECONNREFUSED",
      }),
    );
    const result = await checkReadiness();
    expect(result.status).toBe("not_ready");
    expect(result.checks.db).toBe("failed");
    expect(result.checks.queue).toBe("ok");
    expect(result.errors).toEqual({ db: "connection_refused" });
  });

  it("flags queue as schema_not_initialized when the worker has not booted yet", async () => {
    builderMock.mockResolvedValue({ error: null });
    isWorkerReadyMock.mockReturnValue(false);
    const result = await checkReadiness();
    expect(result.status).toBe("not_ready");
    expect(result.checks.queue).toBe("failed");
    expect(result.errors?.queue).toBe("schema_not_initialized");
    // db is still ok in this scenario, so it must NOT appear in errors.
    expect(result.errors?.db).toBeUndefined();
  });

  it("collapses unknown db errors to the safe 'unavailable' bucket", async () => {
    isWorkerReadyMock.mockReturnValue(true);
    builderMock.mockRejectedValue(new Error("some unexpected driver string"));
    const result = await checkReadiness();
    expect(result.status).toBe("not_ready");
    expect(result.errors?.db).toBe("unavailable");
    // queue is up in this scenario.
    expect(result.errors?.queue).toBeUndefined();
  });
});
