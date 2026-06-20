// office-ally-inbound-poll — multi-tenant fan-out (G2).
//
// The dispatch helpers are exercised against the Supabase mock in the
// sibling `*.test.ts` / `*.dispatch277.test.ts` suites. Here we cover the
// safety-critical control flow the fan-out introduced:
//   * the poll runs once PER active tenant, and
//   * each tenant's clearinghouse is resolved with its OWN org_id — so a
//     tenant polls its own Office Ally SFTP account, never another's, and
//   * no active tenants → a clean no-op.

import { describe, it, expect, vi, beforeEach } from "vitest";

const listActiveOrgIdsMock = vi.hoisted(() => vi.fn());
// Spread the real module so transitive importers (e.g. integration-health.ts,
// which imports resolveSeedOrgId) still find every export; override only the
// two the fan-out exercises. The per-org body builds a client but, with
// resolveClearinghouse stubbed to "no config", never calls a method on it — a
// sentinel is enough.
vi.mock("@workspace/resupply-db", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/resupply-db")>();
  return {
    ...actual,
    listActiveOrgIds: listActiveOrgIdsMock,
    getOrgScopedClient: vi.fn((orgId: string) => ({ orgId })),
  };
});

const resolveClearinghouseMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/billing/identity-resolver", () => ({
  resolveClearinghouse: resolveClearinghouseMock,
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runOfficeAllyInboundPoll } from "./office-ally-inbound-poll";

beforeEach(() => {
  listActiveOrgIdsMock.mockReset().mockResolvedValue([]);
  // Default: no tenant has Office Ally configured → each per-org body
  // short-circuits to empty stats (no SFTP, no DB writes).
  resolveClearinghouseMock
    .mockReset()
    .mockResolvedValue({ config: null, row: null, source: "none" });
});

describe("runOfficeAllyInboundPoll — per-tenant fan-out", () => {
  it("polls once per active tenant, resolving each tenant's own clearinghouse", async () => {
    listActiveOrgIdsMock.mockResolvedValue(["org-a", "org-b"]);

    const stats = await runOfficeAllyInboundPoll();

    // One clearinghouse resolution per tenant, each scoped to its own org_id.
    expect(resolveClearinghouseMock).toHaveBeenCalledTimes(2);
    expect(resolveClearinghouseMock).toHaveBeenCalledWith({ orgId: "org-a" });
    expect(resolveClearinghouseMock).toHaveBeenCalledWith({ orgId: "org-b" });
    // No tenant configured → nothing listed/dispatched, aggregate is zero.
    expect(stats.listed).toBe(0);
    expect(stats.dispatched).toBe(0);
  });

  it("no-ops cleanly when there are no active tenants", async () => {
    listActiveOrgIdsMock.mockResolvedValue([]);

    const stats = await runOfficeAllyInboundPoll();

    expect(resolveClearinghouseMock).not.toHaveBeenCalled();
    expect(stats.listed).toBe(0);
    expect(stats.dispatched).toBe(0);
  });

  it("isolates a per-tenant failure — one tenant throwing doesn't abort the rest", async () => {
    listActiveOrgIdsMock.mockResolvedValue(["org-a", "org-b"]);
    // org-a's clearinghouse resolution throws; org-b still gets polled.
    resolveClearinghouseMock.mockImplementation(
      async ({ orgId }: { orgId: string }) => {
        if (orgId === "org-a") throw new Error("boom");
        return { config: null, row: null, source: "none" };
      },
    );

    const stats = await runOfficeAllyInboundPoll();

    // Both tenants were attempted; the throw was isolated (forEachActiveOrg
    // never rejects), so the aggregate still resolves.
    expect(resolveClearinghouseMock).toHaveBeenCalledWith({ orgId: "org-a" });
    expect(resolveClearinghouseMock).toHaveBeenCalledWith({ orgId: "org-b" });
    expect(stats.dispatched).toBe(0);
  });
});
