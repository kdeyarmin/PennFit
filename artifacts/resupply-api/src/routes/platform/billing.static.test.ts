import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "billing.ts"), "utf8");

describe("platform billing route wiring", () => {
  it("keeps tenant-admin package and usage endpoints", () => {
    expect(SRC).toContain('"/admin/billing/package"');
    expect(SRC).toContain('"/admin/billing/usage-events"');
    expect(SRC).toContain("requireAdmin");
  });

  it("keeps super-admin catalog, tenant, subscription, add-on, and usage endpoints", () => {
    expect(SRC).toContain('"/platform/billing/catalog"');
    expect(SRC).toContain('"/platform/billing/summary"');
    expect(SRC).toContain('"/platform/billing/tenants"');
    expect(SRC).toContain('"/platform/billing/tenants/:id/subscription"');
    expect(SRC).toContain('"/platform/billing/tenants/:id/addons"');
    expect(SRC).toContain('"/platform/billing/usage-events"');
    expect(SRC).toContain('"/platform/billing/catalog/stripe/sync"');
    // Catalog price-edit endpoints (populate to tenants + marketing + Stripe).
    expect(SRC).toContain('"/platform/billing/catalog/plans/:code"');
    expect(SRC).toContain('"/platform/billing/catalog/addons/:code"');
    // Deliberate roll-out of new catalog pricing to live tenant subscriptions.
    expect(SRC).toContain('"/platform/billing/tenants/resync-stripe"');
    expect(SRC).toContain('"/platform/billing/tenants/:id/stripe/customer"');
    expect(SRC).toContain(
      '"/platform/billing/tenants/:id/stripe/subscription"',
    );
    expect(SRC).toContain("requirePlatformAdmin");
  });

  it("exposes tenant self-service plan listing and selection", () => {
    expect(SRC).toContain('"/admin/billing/plans"');
    expect(SRC).toContain('"/admin/billing/subscription"');
    // Selection is an owner-level action gated by system.config.manage.
    expect(SRC).toContain('requirePermission("system.config.manage")');
    // A tenant may only self-select a public, non-custom plan.
    expect(SRC).toContain("plan_not_self_selectable");
    // The choice is recorded and synced to Stripe (customer + subscription).
    expect(SRC).toContain("ensureTenantStripeCustomer");
    expect(SRC).toContain("syncTenantStripeSubscription");
    // Auditable so the super-admin portal can see who chose what.
    expect(SRC).toContain("tenant.billing.subscription.selected");
    // Switching plans must carry the live Stripe linkage forward so the
    // sync UPDATES the existing subscription rather than creating a second
    // one (which would double-bill the tenant).
    expect(SRC).toContain("Preserve the live Stripe linkage");
    expect(SRC).toContain(
      "stripe_subscription_id: prior?.stripe_subscription_id",
    );
  });

  it("exposes tenant self-service add-on listing and selection", () => {
    expect(SRC).toContain('"/admin/billing/addons"');
    // Owner-gated, like plan selection.
    expect(SRC).toContain("tenant.billing.addon.updated");
    // Only active, recurring add-ons are self-selectable; one-time/project
    // add-ons stay platform-admin-assigned.
    expect(SRC).toContain("addon_not_self_selectable");
    // Tenants pay the catalog rate — no custom pricing accepted here.
    expect(SRC).toContain("custom_recurring_price_cents: null");
  });

  it("carries Stripe linkage forward on the platform plan-change route too", () => {
    // The platform-admin PUT shares the cancel-then-insert pattern; without
    // carrying the Stripe IDs forward a later sync would create a duplicate
    // subscription and double-bill the tenant.
    expect(SRC).toContain(
      "stripe_subscription_id: priorSub?.stripe_subscription_id",
    );
  });

  it("moves (nulls) the Stripe subscription id off the canceled row", () => {
    // tenant_billing_subscriptions has a partial UNIQUE index on
    // stripe_subscription_id (migration 0363). Both plan-change routes carry
    // the id onto the new active row, so the canceled row MUST release it —
    // otherwise the carry-forward insert violates the index and the plan
    // change fails for any Stripe-synced tenant. Asserted on both routes.
    const nulls = SRC.match(/stripe_subscription_id: null/g) ?? [];
    expect(nulls.length).toBeGreaterThanOrEqual(2);
  });

  it("counts active locations by is_active, not a nonexistent status column", () => {
    // resupply.locations has `is_active` (boolean), no `status` column —
    // filtering on `status` 400s in PostgREST and 500s the whole tenant
    // billing list (column locations.status does not exist).
    expect(SRC).toContain('countTable(orgId, "locations"');
    expect(SRC).toContain('["is_active", "true"]');
    expect(SRC).not.toMatch(/"locations"[^)]*\[\["status"/);
  });

  it("persists usage and emits auditable subscription changes", () => {
    expect(SRC).toContain("tenant_usage_events");
    expect(SRC).toContain("platform.billing.subscription.updated");
    expect(SRC).toContain("platform.billing.addon.updated");
    expect(SRC).toContain("platform.billing.stripe.catalog.synced");
  });

  it("computes the fleet MRR summary through the pure aggregator", () => {
    expect(SRC).toContain("summarizeFleetBilling");
    expect(SRC).toContain("billing_summary_failed");
  });
});
