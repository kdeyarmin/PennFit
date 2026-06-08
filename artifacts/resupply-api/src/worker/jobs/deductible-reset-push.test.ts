// Source-pinned guard for the deductible-reset active-customer batching
// (2026-06-05 performance review §2 MEDIUM). The per-customer
// recent-paid-order existence query was an N+1; it is now the
// shop_customers_last_paid_at RPC (mig 0232) returning MAX(paid_at) per
// customer, consulted via an in-memory map and compared as epoch ms.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "deductible-reset-push.ts"),
  "utf8",
);

describe("deductible-reset-push — active-customer gate is batched", () => {
  it("uses the shop_customers_last_paid_at RPC instead of a per-customer order read", () => {
    expect(SRC).toContain('.rpc("shop_customers_last_paid_at"');
    expect(SRC).toContain("lastPaidByCustomer.get(row.customer_id)");
  });

  it("removes the per-customer paid-order existence query from the loop", () => {
    expect(SRC).not.toMatch(
      /\.from\("shop_orders"\)\s*\.select\("paid_at"\)\s*\.eq\("customer_id", row\.customer_id\)/,
    );
  });

  it("compares recency as epoch ms (offset-safe), not raw timestamptz strings", () => {
    expect(SRC).toContain("new Date(lastPaid).getTime() <= activitySinceMs");
  });
});
