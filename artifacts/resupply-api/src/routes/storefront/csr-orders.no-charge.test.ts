// Regression guard: the CSR order flow collects a SIGNATURE, never a payment.
//
// This flow used to end in Stripe Hosted Checkout ("sign & pay"). Patients
// are insurance-only now, so the charge leg was removed and the order is
// billed to the payer through the claims pipeline instead. The resupply
// draft-approval path funnels into this same flow, so a reintroduced charge
// here would silently put a pay wall in front of every approved resupply.
//
// Source-level assertions on purpose: the point is that no payment code
// path EXISTS to be reached, which a request-level test can't show.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string): string =>
  readFileSync(path.join(__dirname, p), "utf8");

const PUBLIC_ROUTES = read("./csr-orders.ts");
const SHARED = read("../../lib/csr-order/order.ts");
const DRAFT_APPROVE = read("../admin/resupply-order-drafts.ts");
const ADMIN_ROUTES = read("../admin/csr-order-requests.ts");

const ALL = [PUBLIC_ROUTES, SHARED, DRAFT_APPROVE, ADMIN_ROUTES];

describe("CSR order flow — signature only, never a charge", () => {
  it("exposes exactly the view + sign endpoints (no checkout)", () => {
    const routes = [...PUBLIC_ROUTES.matchAll(/router\.(get|post)\("([^"]+)"/g)]
      .map((m) => `${m[1]!.toUpperCase()} ${m[2]!}`)
      .sort();
    expect(routes).toEqual(["GET /csr-orders/view", "POST /csr-orders/sign"]);
  });

  it("no module in the flow imports Stripe", () => {
    for (const src of ALL) {
      expect(src).not.toMatch(/from "[^"]*\/stripe\//);
      expect(src).not.toMatch(/\bfrom "stripe"/);
    }
  });

  it("never creates a Checkout Session or a PaymentIntent", () => {
    for (const src of ALL) {
      expect(src).not.toContain("checkout.sessions.create");
      expect(src).not.toContain("paymentIntents.create");
    }
  });

  it("hands the patient a signing link, not a pay link", () => {
    expect(SHARED).toContain("/order-sign?token=");
    expect(SHARED).not.toContain("/order-pay");
  });

  it("does not read a mirrored payment state off shop_orders", () => {
    // The old flow derived paid/refunded from the mirrored shop_orders row
    // that the Stripe charge webhook flipped. Nothing mirrors there now.
    for (const src of ALL) {
      expect(src).not.toContain("lookupPaymentState");
      expect(src).not.toContain("stripe_session_id");
    }
  });

  it("gates resend/cancel on the signature, not on a payment", () => {
    expect(ADMIN_ROUTES).toContain("already_signed");
    expect(ADMIN_ROUTES).not.toContain("already_paid");
  });

  it("approving a resupply draft still issues a signing link", () => {
    // The draft-approval path is the reason this flow survived the cash-pay
    // removal — pin the call so a future cleanup can't quietly drop it.
    expect(DRAFT_APPROVE).toContain("buildCsrOrderSigningLink");
    expect(DRAFT_APPROVE).toContain("deliverCsrOrderInvite");
  });
});
