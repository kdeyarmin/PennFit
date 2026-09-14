import { beforeEach, describe, expect, it, vi } from "vitest";
const { rpc, fanout } = vi.hoisted(() => ({ rpc: vi.fn(), fanout: vi.fn() }));
vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: () => ({ raw: () => ({ schema: () => ({ rpc }) }) }),
}));
vi.mock("../lib/for-each-active-org", () => ({ forEachActiveOrg: fanout }));
import { runPricingSchedules } from "./pricing-schedules";
beforeEach(() => {
  vi.clearAllMocks();
});
describe("scheduled price activation worker", () => {
  it("passes each tenant explicitly to the atomic activation function", async () => {
    rpc.mockResolvedValue({ error: null });
    fanout.mockImplementation(
      async (handler: (id: string) => Promise<void>) => {
        await handler("tenant-a");
        await handler("tenant-b");
        return { total: 2, succeeded: 2, failedOrgIds: [] };
      },
    );
    expect((await runPricingSchedules()).succeeded).toBe(2);
    expect(rpc.mock.calls).toEqual([
      ["pricing_apply_scheduled", { p_org_id: "tenant-a" }],
      ["pricing_apply_scheduled", { p_org_id: "tenant-b" }],
    ]);
  });
  it("requests a retry when one tenant's activation could not be checked", async () => {
    fanout.mockResolvedValue({
      total: 2,
      succeeded: 1,
      failedOrgIds: ["tenant-a"],
    });
    await expect(runPricingSchedules()).rejects.toThrow("need retry");
  });
});
