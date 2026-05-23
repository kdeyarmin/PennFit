// Shared test types for route tests that mock
// `resolveBillingIdentity` from lib/billing/identity-resolver.
//
// The production `ResolvedBillingIdentity` type requires `submitter`
// and `usageIndicator`; the routes only read a slim subset (source,
// organization, billingProvider). Centralising the structural shape
// here keeps the two billing route tests (`billing-statements.test.ts`,
// `good-faith-estimates.test.ts`) consistent without duplicating the
// declaration in each file.

export type MockBillingIdentity = {
  source: "db" | "env" | "stub";
  organization: {
    legal_name: string;
    phone_e164: string;
    billing_email: string;
  } | null;
  billingProvider: {
    organizationName: string;
    npi: string;
    address: { line1: string; city: string; state: string; zip: string };
  };
};
