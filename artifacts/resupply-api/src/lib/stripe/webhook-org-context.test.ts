// Per-webhook tenant context (G5).

import { describe, expect, it, vi } from "vitest";

const SEED_ORG = "00000000-0000-4000-8000-000000000000";

vi.mock("@workspace/resupply-db", () => ({
  resolveSeedOrgId: async () => SEED_ORG,
}));

import { enterWebhookOrg, resolveWebhookOrgId } from "./webhook-org-context";

describe("resolveWebhookOrgId", () => {
  it("falls back to the seed org when no webhook context is entered", async () => {
    // A fresh async context (no enterWebhookOrg) → seed, matching pre-G5
    // behavior for any non-dispatcher caller.
    expect(await resolveWebhookOrgId()).toBe(SEED_ORG);
  });

  it("returns the entered org within the webhook context", async () => {
    await new Promise<void>((resolve) => {
      void (async () => {
        enterWebhookOrg("org-connected-tenant");
        expect(await resolveWebhookOrgId()).toBe("org-connected-tenant");
        resolve();
      })();
    });
  });
});
