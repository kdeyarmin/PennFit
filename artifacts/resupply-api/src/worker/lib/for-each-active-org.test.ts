// forEachActiveOrg: fan a cron sweep across active tenants, isolating
// per-tenant failures so one bad tenant can't crash a shared tick.

import { describe, it, expect, vi } from "vitest";

import { forEachActiveOrg } from "./for-each-active-org";

describe("forEachActiveOrg", () => {
  it("runs the handler once per active tenant, in order", async () => {
    const seen: string[] = [];
    const result = await forEachActiveOrg(
      async (orgId) => {
        seen.push(orgId);
      },
      { listOrgIds: async () => ["org-a", "org-b", "org-c"] },
    );
    expect(seen).toEqual(["org-a", "org-b", "org-c"]);
    expect(result).toEqual({ total: 3, succeeded: 3, failedOrgIds: [] });
  });

  it("isolates a failing tenant and still runs the rest", async () => {
    const seen: string[] = [];
    const result = await forEachActiveOrg(
      async (orgId) => {
        seen.push(orgId);
        if (orgId === "org-b") throw new Error("boom");
      },
      { listOrgIds: async () => ["org-a", "org-b", "org-c"], jobName: "test" },
    );
    // All three ran even though the middle one threw.
    expect(seen).toEqual(["org-a", "org-b", "org-c"]);
    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failedOrgIds).toEqual(["org-b"]);
  });

  it("is a no-op when there are no active tenants (never throws)", async () => {
    const handler = vi.fn(async () => {});
    const result = await forEachActiveOrg(handler, {
      listOrgIds: async () => [],
    });
    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({ total: 0, succeeded: 0, failedOrgIds: [] });
  });
});
