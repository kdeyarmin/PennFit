// Tests for test-helpers/billing-mocks.ts
//
// billing-mocks.ts exports a single shared type — `MockBillingIdentity` —
// used by billing-statements.test.ts and good-faith-estimates.test.ts to
// provide a typed mock for `resolveBillingIdentity`.
//
// Because `MockBillingIdentity` is a pure TypeScript structural type (no
// runtime value is exported), these tests use object literals that are
// explicitly typed as `MockBillingIdentity` to:
//   1. Confirm each union variant of `source` is accepted.
//   2. Confirm `organization: null` is accepted (stub / unconfigured state).
//   3. Confirm the full `billingProvider.address` shape is required.
//   4. Validate that the shape used inside the two billing route tests
//      actually satisfies the type (regression guard against drift).
//
// All assertions are runtime structural checks; TypeScript will additionally
// flag any type mismatch at compile time.

import { describe, it, expect } from "vitest";
import { type MockBillingIdentity } from "./billing-mocks";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFullIdentity(
  overrides: Partial<MockBillingIdentity> = {},
): MockBillingIdentity {
  return {
    source: "db",
    organization: {
      legal_name: "Test DME",
      phone_e164: "+15550001234",
      billing_email: "billing@testdme.com",
    },
    billingProvider: {
      organizationName: "Test DME",
      npi: "1234567890",
      address: {
        line1: "123 Main St",
        city: "Springfield",
        state: "IL",
        zip: "62701",
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// source union: "db" | "env" | "stub"
// ---------------------------------------------------------------------------

describe("MockBillingIdentity — source field", () => {
  it('accepts source "db"', () => {
    const identity = makeFullIdentity({ source: "db" });
    expect(identity.source).toBe("db");
  });

  it('accepts source "env"', () => {
    const identity = makeFullIdentity({ source: "env" });
    expect(identity.source).toBe("env");
  });

  it('accepts source "stub"', () => {
    const identity = makeFullIdentity({ source: "stub" });
    expect(identity.source).toBe("stub");
  });
});

// ---------------------------------------------------------------------------
// organization: nullable
// ---------------------------------------------------------------------------

describe("MockBillingIdentity — organization field", () => {
  it("accepts organization: null (stub / unconfigured DME)", () => {
    const identity = makeFullIdentity({ organization: null });
    expect(identity.organization).toBeNull();
  });

  it("accepts a fully-populated organization object", () => {
    const org = {
      legal_name: "Acme DME LLC",
      phone_e164: "+12125550001",
      billing_email: "ar@acme.example",
    };
    const identity = makeFullIdentity({ organization: org });
    expect(identity.organization).toEqual(org);
  });

  it("organization object contains legal_name, phone_e164, and billing_email", () => {
    const identity = makeFullIdentity();
    expect(identity.organization).not.toBeNull();
    const org = identity.organization!;
    expect(typeof org.legal_name).toBe("string");
    expect(typeof org.phone_e164).toBe("string");
    expect(typeof org.billing_email).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// billingProvider shape
// ---------------------------------------------------------------------------

describe("MockBillingIdentity — billingProvider field", () => {
  it("billingProvider has organizationName, npi, and address", () => {
    const identity = makeFullIdentity();
    const bp = identity.billingProvider;
    expect(typeof bp.organizationName).toBe("string");
    expect(typeof bp.npi).toBe("string");
    expect(typeof bp.address).toBe("object");
  });

  it("billingProvider.address has line1, city, state, and zip", () => {
    const identity = makeFullIdentity();
    const addr = identity.billingProvider.address;
    expect(typeof addr.line1).toBe("string");
    expect(typeof addr.city).toBe("string");
    expect(typeof addr.state).toBe("string");
    expect(typeof addr.zip).toBe("string");
  });

  it("accepts an empty-string address (stub sentinel values)", () => {
    const identity = makeFullIdentity({
      billingProvider: {
        organizationName: "Stub",
        npi: "0000000000",
        address: { line1: "", city: "", state: "", zip: "" },
      },
    });
    const addr = identity.billingProvider.address;
    expect(addr.line1).toBe("");
    expect(addr.city).toBe("");
    expect(addr.state).toBe("");
    expect(addr.zip).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Regression: shape matches what billing-statements.test.ts passes to the mock
// ---------------------------------------------------------------------------

describe("MockBillingIdentity — billing-statements.test.ts fixture shape", () => {
  it("the default identity used in billing-statements satisfies MockBillingIdentity", () => {
    // This is the exact object the mock returns in billing-statements.test.ts.
    const fixture: MockBillingIdentity = {
      source: "db",
      organization: {
        legal_name: "Test DME",
        phone_e164: "+15550001234",
        billing_email: "billing@testdme.com",
      },
      billingProvider: {
        organizationName: "Test DME",
        npi: "1234567890",
        address: {
          line1: "123 Main St",
          city: "Springfield",
          state: "IL",
          zip: "62701",
        },
      },
    };
    expect(fixture.source).toBe("db");
    expect(fixture.organization?.legal_name).toBe("Test DME");
    expect(fixture.billingProvider.npi).toBe("1234567890");
  });

  it("the stub override used in billing-statements (null org) satisfies MockBillingIdentity", () => {
    // This is the object passed to mockResolvedValueOnce in the
    // 'no_dme_organization' test case in billing-statements.test.ts.
    const stubOverride: MockBillingIdentity = {
      source: "stub",
      organization: null,
      billingProvider: {
        organizationName: "Stub",
        npi: "0000000000",
        address: { line1: "", city: "", state: "", zip: "" },
      },
    };
    expect(stubOverride.source).toBe("stub");
    expect(stubOverride.organization).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Regression: shape matches what good-faith-estimates.test.ts passes to the mock
// ---------------------------------------------------------------------------

describe("MockBillingIdentity — good-faith-estimates.test.ts fixture shape", () => {
  it("the default identity used in good-faith-estimates satisfies MockBillingIdentity", () => {
    const fixture: MockBillingIdentity = {
      source: "db",
      organization: {
        legal_name: "Test DME LLC",
        phone_e164: "+15550001234",
        billing_email: "billing@testdme.com",
      },
      billingProvider: {
        organizationName: "Test DME LLC",
        npi: "1234567890",
        address: {
          line1: "123 Main St",
          city: "Springfield",
          state: "IL",
          zip: "62701",
        },
      },
    };
    expect(fixture.source).toBe("db");
    expect(fixture.organization?.legal_name).toBe("Test DME LLC");
    expect(fixture.billingProvider.organizationName).toBe("Test DME LLC");
  });

  it("the stub override used in good-faith-estimates (null org) satisfies MockBillingIdentity", () => {
    const stubOverride: MockBillingIdentity = {
      source: "stub",
      organization: null,
      billingProvider: {
        organizationName: "Stub",
        npi: "0000000000",
        address: { line1: "", city: "", state: "", zip: "" },
      },
    };
    expect(stubOverride.organization).toBeNull();
    expect(stubOverride.billingProvider.npi).toBe("0000000000");
  });
});

// ---------------------------------------------------------------------------
// Boundary: NPI string is stored as a string, not coerced to a number
// ---------------------------------------------------------------------------

describe("MockBillingIdentity — NPI string type", () => {
  it("npi is a string type (10-digit NPI not coerced to number)", () => {
    // NPI can have a leading zero; storing as string preserves it.
    const identity = makeFullIdentity({
      billingProvider: {
        ...makeFullIdentity().billingProvider,
        npi: "0123456789",
      },
    });
    expect(typeof identity.billingProvider.npi).toBe("string");
    expect(identity.billingProvider.npi).toBe("0123456789");
  });
});
