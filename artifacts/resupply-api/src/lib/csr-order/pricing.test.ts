import { describe, expect, it, vi } from "vitest";
import type { OrgScopedClient } from "@workspace/resupply-db";
import type { Quote } from "../pricing/contracts";
import { createReviewedOrder, orderPricingFailure } from "./pricing";

const quote = { id: "quote-fixture", revision: 3 } as Quote;
const conflictCodes = [
  "revision_conflict",
  "quote_already_bound",
  "draft_not_open",
  "quote_expired",
  "stale_dependencies",
];

describe("CSR priced order conflict responses", () => {
  it.each(conflictCodes)(
    "keeps %s actionable when the database returns PT409",
    async (message) => {
      const rpc = vi.fn().mockResolvedValue({
        data: null,
        error: { code: "PT409", message },
      });
      const db = {
        orgId: "org-fixture",
        raw: () => ({ schema: () => ({ rpc }) }),
      } as unknown as OrgScopedClient;
      const result = await createReviewedOrder(
        db,
        quote,
        { patient_id: "patient-fixture" },
        "draft-fixture",
      );
      expect(result).toMatchObject({
        ok: false,
        status: 409,
        body: { error: message, message: expect.any(String) },
      });
      expect(result).toEqual(orderPricingFailure({ code: "40001", message }));
      expect(rpc).toHaveBeenCalledExactlyOnceWith("create_csr_priced_order", {
        p_org_id: "org-fixture",
        p_quote_id: quote.id,
        p_quote_revision: quote.revision,
        p_draft_id: "draft-fixture",
        p_request: { patient_id: "patient-fixture" },
      });
    },
  );

  it("preserves validation errors and hides unknown database failures", () => {
    expect(
      orderPricingFailure({ code: "22023", message: "quote_lines_mismatch" }),
    ).toMatchObject({ status: 422, body: { error: "quote_lines_mismatch" } });
    expect(
      orderPricingFailure({ code: "PT409", message: "internal details" }),
    ).toMatchObject({ status: 503, body: { error: "pricing_unavailable" } });
  });
});
