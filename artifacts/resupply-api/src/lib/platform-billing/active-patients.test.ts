import { describe, it, expect, vi, beforeEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: { rpcResult: { data: null as unknown, error: null as unknown } },
}));

vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: () => ({
    raw: () => ({
      schema: () => ({ rpc: async () => state.rpcResult }),
    }),
  }),
}));
vi.mock("../logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { countActivePatientsForBilling } from "./active-patients";

beforeEach(() => {
  state.rpcResult = { data: null, error: null };
});

describe("countActivePatientsForBilling", () => {
  it("returns the RPC count", async () => {
    state.rpcResult = { data: 42, error: null };
    expect(await countActivePatientsForBilling("org-1")).toBe(42);
  });

  it("floors a fractional count and clamps negatives to 0", async () => {
    state.rpcResult = { data: 3.9, error: null };
    expect(await countActivePatientsForBilling("org-1")).toBe(3);
    state.rpcResult = { data: -5, error: null };
    expect(await countActivePatientsForBilling("org-1")).toBe(0);
  });

  it("THROWS on a query error so the caller skips (never zeroes the count)", async () => {
    state.rpcResult = { data: null, error: new Error("boom") };
    await expect(countActivePatientsForBilling("org-1")).rejects.toThrow(
      "boom",
    );
  });

  it("returns 0 for a non-numeric result", async () => {
    state.rpcResult = { data: "nope", error: null };
    expect(await countActivePatientsForBilling("org-1")).toBe(0);
  });
});
