import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-platform-billing.tsx"),
  "utf8",
);

describe("AdminPlatformBillingPage Stripe controls", () => {
  it("surfaces catalog and tenant subscription sync actions", () => {
    expect(SRC).toContain("Sync catalog to Stripe");
    expect(SRC).toContain("Create Stripe customer");
    expect(SRC).toContain("Sync subscription");
    expect(SRC).toContain("Payment setup link");
    expect(SRC).toContain("Open billing portal");
    expect(SRC).toContain("Refresh payment method");
  });

  it("shows tenant Stripe status and invoice state", () => {
    expect(SRC).toContain("Stripe billing");
    expect(SRC).toContain("stripeStatus");
    expect(SRC).toContain("lastInvoiceStatus");
    expect(SRC).toContain("currentPeriodEnd");
    expect(SRC).toContain("stripePaymentMethodLast4");
  });
});
