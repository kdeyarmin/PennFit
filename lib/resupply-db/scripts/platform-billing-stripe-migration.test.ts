import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  path.join(__dirname, "../drizzle/0363_platform_billing_stripe.sql"),
  "utf8",
);

describe("0363 platform billing Stripe migration", () => {
  it("adds Stripe catalog and tenant subscription linkage columns", () => {
    expect(SQL).toContain('"stripe_product_id"');
    expect(SQL).toContain('"stripe_price_id"');
    expect(SQL).toContain('"stripe_customer_id"');
    expect(SQL).toContain('"stripe_subscription_id"');
    expect(SQL).toContain('"last_invoice_status"');
  });

  it("indexes Stripe subscription and customer lookup fields", () => {
    expect(SQL).toContain(
      "tenant_billing_subscriptions_stripe_subscription_uidx",
    );
    expect(SQL).toContain("tenant_billing_subscriptions_stripe_customer_idx");
  });
});
