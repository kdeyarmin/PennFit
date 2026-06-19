import { describe, expect, it } from "vitest";

import {
  buildTenantSetupItems,
  type TenantSetupSnapshot,
} from "./tenant-setup";

const EMPTY: TenantSetupSnapshot = {
  storefrontName: null,
  logoUrl: null,
  customDomain: null,
  customDomainStatus: null,
  voiceFromNumber: null,
  smsFromNumber: null,
  messagingServiceSid: null,
  faxFromNumber: null,
  fromEmail: null,
  stripeAccountId: null,
  stripeChargesEnabled: false,
  catalogProductCount: null,
  activeAdminCount: 1,
};

function byId(items: ReturnType<typeof buildTenantSetupItems>, id: string) {
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error(`no item ${id}`);
  return item;
}

describe("buildTenantSetupItems", () => {
  it("marks everything incomplete for a brand-new tenant", () => {
    const items = buildTenantSetupItems(EMPTY);
    expect(byId(items, "branding").status).toBe("incomplete");
    expect(byId(items, "sms-number").status).toBe("incomplete");
    expect(byId(items, "voice-number").status).toBe("incomplete");
    expect(byId(items, "email-sender").status).toBe("incomplete");
    expect(byId(items, "payments").status).toBe("incomplete");
    // catalog is an action item until the tenant has products of their own.
    expect(byId(items, "catalog").status).toBe("action");
  });

  it("completes the catalog item once the tenant has products of their own", () => {
    const seeded = buildTenantSetupItems({ ...EMPTY, catalogProductCount: 27 });
    expect(byId(seeded, "catalog").status).toBe("complete");
    expect(byId(seeded, "catalog").detail).toContain("27 products");

    // A zero count (own account, but empty) stays an action item.
    const empty = buildTenantSetupItems({ ...EMPTY, catalogProductCount: 0 });
    expect(byId(empty, "catalog").status).toBe("action");

    // 100+ is rendered with a "+" so a capped probe doesn't read as exactly 100.
    const big = buildTenantSetupItems({ ...EMPTY, catalogProductCount: 100 });
    expect(byId(big, "catalog").detail).toContain("100+ products");
  });

  it("completes branding when a storefront name is set", () => {
    const items = buildTenantSetupItems({ ...EMPTY, storefrontName: "Acme" });
    expect(byId(items, "branding").status).toBe("complete");
  });

  it("treats a Messaging Service SID as a complete SMS channel", () => {
    const items = buildTenantSetupItems({
      ...EMPTY,
      messagingServiceSid: "MG0123456789abcdef0123456789abcdef",
    });
    expect(byId(items, "sms-number").status).toBe("complete");
  });

  it("only completes the domain when status is verified", () => {
    const pending = buildTenantSetupItems({
      ...EMPTY,
      customDomain: "shop.acme.com",
      customDomainStatus: "pending",
    });
    expect(byId(pending, "custom-domain").status).toBe("incomplete");

    const verified = buildTenantSetupItems({
      ...EMPTY,
      customDomain: "shop.acme.com",
      customDomainStatus: "verified",
    });
    expect(byId(verified, "custom-domain").status).toBe("complete");
  });

  it("requires BOTH an account id and charges enabled for payments", () => {
    const linkedOnly = buildTenantSetupItems({
      ...EMPTY,
      stripeAccountId: "acct_1",
      stripeChargesEnabled: false,
    });
    expect(byId(linkedOnly, "payments").status).toBe("incomplete");

    const ready = buildTenantSetupItems({
      ...EMPTY,
      stripeAccountId: "acct_1",
      stripeChargesEnabled: true,
    });
    expect(byId(ready, "payments").status).toBe("complete");
  });

  it("completes the team item once more than one admin is active", () => {
    expect(byId(buildTenantSetupItems(EMPTY), "team").status).toBe(
      "incomplete",
    );
    expect(
      byId(buildTenantSetupItems({ ...EMPTY, activeAdminCount: 3 }), "team")
        .status,
    ).toBe("complete");
  });

  it("classifies the required vs recommended items as expected", () => {
    const items = buildTenantSetupItems(EMPTY);
    const required = items
      .filter((i) => i.required)
      .map((i) => i.id)
      .sort();
    expect(required).toEqual(
      ["branding", "email-sender", "payments", "sms-number"].sort(),
    );
  });

  it("gives every item a configuration href", () => {
    for (const item of buildTenantSetupItems(EMPTY)) {
      expect(item.href, item.id).toBeTruthy();
    }
  });
});
