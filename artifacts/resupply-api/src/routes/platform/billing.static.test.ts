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
    expect(SRC).toContain('"/platform/billing/tenants"');
    expect(SRC).toContain('"/platform/billing/tenants/:id/subscription"');
    expect(SRC).toContain('"/platform/billing/tenants/:id/addons"');
    expect(SRC).toContain('"/platform/billing/usage-events"');
    expect(SRC).toContain('"/platform/billing/catalog/stripe/sync"');
    expect(SRC).toContain('"/platform/billing/tenants/:id/stripe/customer"');
    expect(SRC).toContain(
      '"/platform/billing/tenants/:id/stripe/subscription"',
    );
    expect(SRC).toContain(
      '"/platform/billing/tenants/:id/stripe/setup-session"',
    );
    expect(SRC).toContain('"/platform/billing/tenants/:id/stripe/portal"');
    expect(SRC).toContain('"/admin/billing/stripe/portal"');
    expect(SRC).toContain(
      '"/platform/billing/tenants/:id/stripe/payment-method/sync"',
    );
    expect(SRC).toContain("requirePlatformAdmin");
  });

  it("persists usage and emits auditable subscription changes", () => {
    expect(SRC).toContain("tenant_usage_events");
    expect(SRC).toContain("platform.billing.subscription.updated");
    expect(SRC).toContain("platform.billing.addon.updated");
    expect(SRC).toContain("platform.billing.stripe.catalog.synced");
  });
});
