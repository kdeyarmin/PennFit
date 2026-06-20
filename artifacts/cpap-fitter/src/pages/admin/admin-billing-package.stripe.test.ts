import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-billing-package.tsx"),
  "utf8",
);
const ADDON_DETAILS_SRC = readFileSync(
  path.join(__dirname, "../../lib/admin/addon-details.tsx"),
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

  it("explains each add-on in a collapsible dropdown", () => {
    // The page imports the shared explainer and renders it per add-on card.
    expect(SRC).toContain("AddonExplainer");
    expect(SRC).toContain("@/lib/admin/addon-details");
    expect(SRC).toContain("<AddonExplainer addon={addon} />");
  });

  it("sources add-on explainer copy from the shared map", () => {
    expect(ADDON_DETAILS_SRC).toContain("export const ADDON_DETAILS");
    expect(ADDON_DETAILS_SRC).toContain("export function AddonExplainer");
    expect(ADDON_DETAILS_SRC).toContain("addon-explainer-");
    expect(ADDON_DETAILS_SRC).toContain("What this does");
    expect(ADDON_DETAILS_SRC).toContain("whatItDoes");
    expect(ADDON_DETAILS_SRC).toContain("whyItMatters");
  });
});
