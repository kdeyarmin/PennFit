import { describe, it, expect } from "vitest";

import {
  emptyDmeOrgBody,
  orgToBody,
  type DmeOrganization,
} from "./dme-organization-api";

describe("emptyDmeOrgBody", () => {
  it("defaults the taxonomy code and leaves required fields blank", () => {
    const b = emptyDmeOrgBody();
    expect(b.taxonomyCode).toBe("332B00000X");
    expect(b.legalName).toBe("");
    expect(b.taxId).toBe("");
    expect(b.organizationalNpi).toBe("");
    expect(b.suretyBondAmountCents).toBeNull();
  });
});

describe("orgToBody", () => {
  const base: DmeOrganization = {
    id: "00000000-0000-4000-8000-000000000001",
    legalName: "Penn Home Medical Supply",
    dbaName: null,
    taxId: "123456789",
    organizationalNpi: "1234567893",
    taxonomyCode: "332B00000X",
    medicarePtan: null,
    physical: {
      line1: "100 Market St",
      line2: null,
      city: "Philadelphia",
      state: "PA",
      zip: "19106",
    },
    mailing: null,
    payTo: null,
    phoneE164: "+12155551234",
    faxE164: null,
    billingEmail: "billing@pennpaps.com",
    generalEmail: null,
    websiteUrl: null,
    accreditation: null,
    stateLicense: null,
    liability: null,
    suretyBond: null,
    authorizedSigner: null,
    notes: null,
    updatedAt: "2026-05-30T00:00:00Z",
  };

  it("flattens required identity + physical address", () => {
    const b = orgToBody(base);
    expect(b.legalName).toBe("Penn Home Medical Supply");
    expect(b.taxId).toBe("123456789");
    expect(b.organizationalNpi).toBe("1234567893");
    expect(b.physicalAddressLine1).toBe("100 Market St");
    expect(b.physicalState).toBe("PA");
    expect(b.physicalZip).toBe("19106");
  });

  it("flattens nullable nested sections to null (no data invented)", () => {
    const b = orgToBody(base);
    expect(b.mailingAddressLine1).toBeNull();
    expect(b.payToCity).toBeNull();
    expect(b.accreditationBody).toBeNull();
    expect(b.suretyBondAmountCents).toBeNull();
    expect(b.authorizedSignerName).toBeNull();
  });

  it("round-trips populated optional sections so the upsert can't wipe them", () => {
    const b = orgToBody({
      ...base,
      mailing: {
        line1: "PO Box 9",
        line2: null,
        city: "Philadelphia",
        state: "PA",
        zip: "19107",
      },
      accreditation: { body: "achc", number: "A-123", expiresOn: "2027-01-01" },
      suretyBond: { carrier: "Acme", amountCents: 5000000, expiresOn: null },
    });
    expect(b.mailingAddressLine1).toBe("PO Box 9");
    expect(b.mailingZip).toBe("19107");
    expect(b.accreditationBody).toBe("achc");
    expect(b.accreditationNumber).toBe("A-123");
    expect(b.suretyBondAmountCents).toBe(5000000);
  });
});
