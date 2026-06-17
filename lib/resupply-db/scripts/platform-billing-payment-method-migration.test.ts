import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  path.resolve(
    __dirname,
    "../drizzle/0359_platform_billing_payment_method.sql",
  ),
  "utf8",
);

describe("platform billing payment method migration", () => {
  it("adds Stripe default payment method summary columns", () => {
    expect(SQL).toContain("stripe_default_payment_method_id");
    expect(SQL).toContain("stripe_payment_method_type");
    expect(SQL).toContain("stripe_payment_method_brand");
    expect(SQL).toContain("stripe_payment_method_last4");
    expect(SQL).toContain("stripe_payment_method_updated_at");
  });
});
