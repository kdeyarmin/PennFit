import { describe, expect, it, vi } from "vitest";
import { dispenseSignedCsrOrder } from "./dispense-on-sign";
function fixture() {
  const rpc = vi.fn();
  return {
    rpc,
    client: {
      orgId: "tenant-one",
      raw: () => ({ schema: () => ({ rpc }) }),
    } as never,
  };
}
describe("signed order fulfillment handoff", () => {
  it("returns every approved line without a legacy fallback", async () => {
    const f = fixture();
    f.rpc.mockResolvedValue({
      data: { status: "queued", fulfillmentIds: ["mask", "filter"] },
      error: null,
    });
    expect(await dispenseSignedCsrOrder(f.client, "order")).toEqual({
      fulfillmentIds: ["mask", "filter"],
      skipped: null,
    });
    expect(f.rpc.mock.calls).toEqual([
      [
        "dispense_csr_priced_order",
        { p_org_id: "tenant-one", p_order_id: "order" },
      ],
    ]);
  });
  it("uses the atomic legacy handoff only for an explicitly unpriced order", async () => {
    const f = fixture();
    f.rpc
      .mockResolvedValueOnce({
        data: { status: "no_pricing_quote" },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { status: "queued", fulfillmentIds: ["legacy-line"] },
        error: null,
      });
    expect(
      (await dispenseSignedCsrOrder(f.client, "order")).fulfillmentIds,
    ).toEqual(["legacy-line"]);
    expect(f.rpc.mock.calls[1]).toEqual([
      "dispense_csr_legacy_order",
      { p_org_id: "tenant-one", p_order_id: "order" },
    ]);
  });
  it.each(["needs_prescription", "address_hold", "not_signed", "not_found"])(
    "keeps %s visible without bypassing the reviewed path",
    async (status) => {
      const f = fixture();
      f.rpc.mockResolvedValue({ data: { status }, error: null });
      expect((await dispenseSignedCsrOrder(f.client, "order")).skipped).toBe(
        status,
      );
      expect(f.rpc).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["no_draft", "no_sku", "no_patient"])(
    "keeps legacy %s unresolved instead of inventing a patient or SKU",
    async (status) => {
      const f = fixture();
      f.rpc
        .mockResolvedValueOnce({
          data: { status: "no_pricing_quote" },
          error: null,
        })
        .mockResolvedValueOnce({ data: { status }, error: null });
      expect((await dispenseSignedCsrOrder(f.client, "order")).skipped).toBe(
        status,
      );
    },
  );
  it("retains a completed signature when the database handoff fails", async () => {
    const f = fixture();
    f.rpc.mockRejectedValue(new Error("Fixture failure"));
    expect(await dispenseSignedCsrOrder(f.client, "order")).toEqual({
      fulfillmentIds: [],
      skipped: "error",
    });
  });
  it("does not report malformed database output as a successful dispense", async () => {
    const f = fixture();
    f.rpc.mockResolvedValue({ data: null, error: null });
    expect((await dispenseSignedCsrOrder(f.client, "order")).skipped).toBe(
      "error",
    );
  });
});
