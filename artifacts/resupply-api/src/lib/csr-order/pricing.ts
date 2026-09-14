import type { Json, OrgScopedClient } from "@workspace/resupply-db";
import {
  getPricingState,
  prepareCsrPricing,
  PricingError,
} from "../pricing/service";
import type { Quote } from "../pricing/contracts";
import type { CsrOrderItem } from "./order";

export interface OrderPricingInput {
  patientId?: string;
  quoteId?: string;
  quoteRevision?: number;
  items: CsrOrderItem[];
}
type Failure = {
  ok: false;
  status: number;
  body: { error: string; message: string };
};
const MESSAGES: Record<string, string> = {
  insurance_patient_quote_required:
    "Use an insurance review for the selected patient.",
  quote_not_found:
    "This pricing review is unavailable. Select a current review.",
  approved_quote_required:
    "Review and approve this order's pricing before sending it for signature.",
  approved_insurance_quote_required:
    "Use an approved insurance pricing review for this patient's order.",
  quote_lines_mismatch:
    "The items changed after pricing review. Review the updated items again.",
  quote_items_changed:
    "The items changed after pricing review. Review the updated items again.",
  quote_already_bound:
    "This pricing review is already attached to a different order commitment.",
  stale_dependencies:
    "A cost, delivery rate or pricing policy changed or expired. Refresh the review.",
  revision_conflict:
    "This review changed in another session. Refresh it before continuing.",
  draft_not_open:
    "This resupply draft has already been handled. Refresh the draft queue.",
  draft_patient_mismatch:
    "The pricing review must belong to the patient on this resupply draft.",
  order_line_bounds:
    "The reviewed quantities or amounts exceed this order workflow's limits.",
  quote_expired: "This pricing review expired. Refresh it before continuing.",
};

export function orderPricingFailure(error: unknown): Failure {
  if (error instanceof PricingError)
    return {
      ok: false,
      status: error.status,
      body: {
        error: error.code,
        message:
          MESSAGES[error.code] ??
          "The pricing review could not be validated. Refresh it and try again.",
      },
    };
  const db = error as { code?: string; message?: string } | null;
  const code = Object.keys(MESSAGES).find((candidate) =>
    db?.message?.includes(candidate),
  );
  if (code)
    return {
      ok: false,
      status: db?.code === "40001" ? 409 : 422,
      body: { error: code, message: MESSAGES[code] },
    };
  return {
    ok: false,
    status: 503,
    body: {
      error: "pricing_unavailable",
      message:
        "Pricing information is temporarily unavailable. Your order has not been sent; try again after it is restored.",
    },
  };
}

export async function reviewOrderPricing(
  db: OrgScopedClient,
  input: OrderPricingInput,
): Promise<{ ok: true; quote: Quote | null } | Failure> {
  try {
    if (!input.quoteId) {
      const state = await getPricingState(db);
      if (state.enforceQuotes)
        throw new PricingError("approved_quote_required");
      return { ok: true, quote: null };
    }
    if (!input.patientId || !input.quoteRevision)
      throw new PricingError("approved_insurance_quote_required");
    const quote = await prepareCsrPricing(db, {
      quoteId: input.quoteId,
      quoteRevision: input.quoteRevision,
      patientId: input.patientId,
      items: input.items,
    });
    return { ok: true, quote };
  } catch (error) {
    return orderPricingFailure(error);
  }
}

export async function createReviewedOrder(
  db: OrgScopedClient,
  quote: Quote,
  request: Json,
  draftId: string | null = null,
): Promise<
  | {
      ok: true;
      order: {
        id: string;
        order_reference: string;
        link_version: number;
        replayed: boolean;
      };
    }
  | Failure
> {
  try {
    const { data, error } = await db
      .raw()
      .schema("resupply")
      .rpc("create_csr_priced_order", {
        p_org_id: db.orgId,
        p_quote_id: quote.id,
        p_quote_revision: quote.revision,
        p_draft_id: draftId,
        p_request: request,
      });
    if (error) throw error;
    if (!data?.id) throw new Error("missing_commit_result");
    return { ok: true, order: data };
  } catch (error) {
    return orderPricingFailure(error);
  }
}
