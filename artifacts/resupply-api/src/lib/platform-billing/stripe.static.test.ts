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

  it("handles subscription and invoice webhook events", () => {
    expect(SRC).toContain("handlePlatformTenantStripeEvent");
    expect(SRC).toContain('event.type !== "invoice.paid"');
    expect(SRC).toContain('event.type !== "invoice.payment_failed"');
    expect(SRC).toContain("last_invoice_status");
  });

  it("re-locks the payment wall on failed invoice and canceled subscription", () => {
    // Clears on paid/checkout; sets billing_required back on failure/delete
    // so BILLING_PAYWALL_ENFORCED tenants cannot keep full console after
    // the first successful payment. Deletion must match THIS
    // stripe_subscription_id so a replaced plan is not locked by the
    // old subscription.deleted event.
    expect(SRC).toContain("billing_required: false");
    expect(SRC).toContain("billing_required: true");
    expect(SRC).toContain("invoice.payment_failed");
    expect(SRC).toContain("subscription.deleted");
    expect(SRC).toContain('status: "canceled"');
    expect(SRC).toContain('.eq("stripe_subscription_id", sub.id)');
    expect(SRC).toContain("updatedRows?.length");
  });

  it("guards account-scoped IDs across a Stripe account switch", () => {
    // Records which account each synced object belongs to, and refuses to
    // reuse a customer/subscription from a different account (double-billing
    // guard) while letting catalog objects recreate.
    expect(SRC).toContain("stripe_account_ref");
    expect(SRC).toContain("resolvePlatformBillingAccountId");
    expect(SRC).toContain("PlatformBillingAccountChangedError");
    expect(SRC).toContain("accountRefMatches");
  });
});
