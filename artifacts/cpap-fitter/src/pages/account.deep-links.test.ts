// Static regression checks for /account hash-tab deep links used by
// push notification payloads and legacy route aliases.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "account.tsx"), "utf8");

describe("account hash deep links", () => {
  it("maps #insights to the overview tab where InsightsSection renders", () => {
    expect(SRC).toContain('if (h === "insights") return "overview"');
    expect(SRC).toContain("<InsightsSection />");
  });

  it("maps #orders to the orders tab while keeping #autoship compatibility", () => {
    expect(SRC).toContain('if (h === "autoship" || h === "orders")');
    expect(SRC).toContain("<OrdersSection");
    expect(SRC).toContain("<SubscriptionsSection");
  });
});
