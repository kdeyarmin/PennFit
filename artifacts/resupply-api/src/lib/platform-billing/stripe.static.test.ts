import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "stripe.ts"), "utf8");

describe("platform billing Stripe service contract", () => {
  it("marks all Stripe objects with platform tenant metadata", () => {
    expect(SRC).toContain("billing_scope: PLATFORM_BILLING_SCOPE");
    expect(SRC).toContain("org_id: args.orgId");
    expect(SRC).toContain("plan_code: plan.code");
  });

  it("syncs catalog prices and tenant subscriptions", () => {
    expect(SRC).toContain("syncPlatformBillingCatalogToStripe");
    expect(SRC).toContain("ensureTenantStripeCustomer");
    expect(SRC).toContain("syncTenantStripeSubscription");
    expect(SRC).toContain("stripe.subscriptions.create");
    expect(SRC).toContain("stripe.subscriptions.update");
  });

  it("creates hosted Stripe setup and portal sessions for tenant billing", () => {
    expect(SRC).toContain("createTenantStripeSetupSession");
    expect(SRC).toContain("stripe.checkout.sessions.create");
    expect(SRC).toContain('mode: "setup"');
    expect(SRC).toContain("createTenantStripeBillingPortalSession");
    expect(SRC).toContain("stripe.billingPortal.sessions.create");
  });

  it("syncs tenant payment method readiness from hosted Stripe setup", () => {
    expect(SRC).toContain("syncTenantStripePaymentMethod");
    expect(SRC).toContain("retrievePaymentMethodSummary");
    expect(SRC).toContain("stripe_default_payment_method_id");
    expect(SRC).toContain('event.type !== "checkout.session.completed"');
  });

  it("handles subscription and invoice webhook events", () => {
    expect(SRC).toContain("handlePlatformTenantStripeEvent");
    expect(SRC).toContain('event.type !== "invoice.paid"');
    expect(SRC).toContain('event.type !== "invoice.payment_failed"');
    expect(SRC).toContain("last_invoice_status");
  });
});
