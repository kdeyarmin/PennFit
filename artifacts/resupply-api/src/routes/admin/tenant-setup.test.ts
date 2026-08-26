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
  activeAdminCount: 1,
  patientCount: 0,
  resupplyRemindersEnabled: false,
  activePrescriptionCount: 0,
  activeFrequencyRuleCount: 0,
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

  it("surfaces the patient import item, completing once the tenant has patients", () => {
    // Brand-new tenant: a recommended action pointing at the PacWare import.
    const empty = buildTenantSetupItems(EMPTY);
    expect(byId(empty, "patients").status).toBe("action");
    expect(byId(empty, "patients").required).toBe(false);
    expect(byId(empty, "patients").href).toBe("/admin/pacware");

    // Once patients exist, it flips to complete with a count.
    const seeded = buildTenantSetupItems({ ...EMPTY, patientCount: 42 });
    expect(byId(seeded, "patients").status).toBe("complete");
    expect(byId(seeded, "patients").detail).toContain("42 patients");

    // 1000+ renders with a "+" so a capped count doesn't read as exactly 1000.
    const big = buildTenantSetupItems({ ...EMPTY, patientCount: 1000 });
    expect(byId(big, "patients").detail).toContain("1000+ patients");
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
    // SMS number is RECOMMENDED, not required: outbound SMS already works on
    // the shared platform number, so a tenant isn't blocked from "set up"
    // until they provision their own (they do that as they grow).
    expect(required).toEqual(["branding", "email-sender"].sort());
    expect(byId(items, "sms-number").required).toBe(false);
  });

  it("surfaces resupply automation items with live status", () => {
    const off = buildTenantSetupItems(EMPTY);
    expect(byId(off, "resupply-automation").status).toBe("action");
    expect(byId(off, "resupply-cadences").status).toBe("action");
    expect(byId(off, "resupply-prescriptions").status).toBe("action");

    const ready = buildTenantSetupItems({
      ...EMPTY,
      resupplyRemindersEnabled: true,
      activeFrequencyRuleCount: 12,
      activePrescriptionCount: 48,
    });
    expect(byId(ready, "resupply-automation").status).toBe("complete");
    expect(byId(ready, "resupply-cadences").status).toBe("complete");
    expect(byId(ready, "resupply-prescriptions").status).toBe("complete");
  });

  it("nudges prescriptions when patients exist but no Rx lines yet", () => {
    const items = buildTenantSetupItems({
      ...EMPTY,
      patientCount: 5,
      activePrescriptionCount: 0,
    });
    expect(byId(items, "resupply-prescriptions").detail).toContain(
      "no active prescriptions",
    );
    expect(byId(items, "resupply-prescriptions").href).toBe("/admin/pacware");
  });

  it("gives every item a configuration href", () => {
    for (const item of buildTenantSetupItems(EMPTY)) {
      expect(item.href, item.id).toBeTruthy();
    }
  });
});
