import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-billing-package.tsx"),
  "utf8",
);

describe("AdminBillingPackagePage Stripe status", () => {
  it("renders Stripe subscription, invoice, and period status", () => {
    expect(SRC).toContain("Tenant billing status");
    expect(SRC).toContain("Stripe status");
    expect(SRC).toContain("Invoice status");
    expect(SRC).toContain("Billing period ends");
  });

  it("offers tenant self-service plan selection", () => {
    expect(SRC).toContain("PlanSelector");
    expect(SRC).toContain("Choose your plan");
    expect(SRC).toContain("fetchSelectablePlans");
    expect(SRC).toContain("selectTenantPlan");
    // Custom/Enterprise tiers are a contact-us state, not self-selectable.
    expect(SRC).toContain("Contact us");
  });

  it("offers tenant self-service add-on selection", () => {
    expect(SRC).toContain("AddonSelector");
    expect(SRC).toContain("fetchSelectableAddons");
    expect(SRC).toContain("updateOwnAddon");
    // Recurring add-ons get a quantity stepper; one-time ones are contact-us.
    expect(SRC).toContain("addon-qty-");
  });
});
