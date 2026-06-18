// Platform super-admin console handlers (/platform/*). Covers the
// platform-admin identity gate and the billing console reads (catalog,
// fleet directory, MRR summary, and the billing activity feed) so the
// super-admin surfaces render with fictional demo data. Other platform
// endpoints fall through to the router's benign default.

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import {
  demoPlatformBillingActivity,
  demoPlatformBillingCatalog,
  demoPlatformBillingSummary,
  demoPlatformMe,
  demoPlatformTenantBilling,
} from "../fixtures/platform-billing";

export const platformHandlers: DemoHandler[] = [
  // Platform-admin identity gate (PlatformConsole).
  route("GET", "/resupply-api/platform/me", () => json(demoPlatformMe())),

  // Billing console reads.
  route("GET", "/resupply-api/platform/billing/summary", () =>
    json(demoPlatformBillingSummary()),
  ),
  route("GET", "/resupply-api/platform/billing/catalog", () =>
    json(demoPlatformBillingCatalog()),
  ),
  route("GET", "/resupply-api/platform/billing/tenants", () =>
    json(demoPlatformTenantBilling()),
  ),
  route("GET", "/resupply-api/platform/billing/activity", () =>
    json(demoPlatformBillingActivity()),
  ),
];
