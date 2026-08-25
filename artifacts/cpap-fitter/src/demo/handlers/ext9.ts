// Extension batch 9 demo handlers. Seeds a cluster of admin pages whose
// API calls would otherwise hit the router's empty `{}` fallback and crash
// (the pages read nested fields / map arrays). Each route returns
// fully-shaped sample data matching the live API response — see the
// corresponding artifacts/resupply-api/src/routes/admin/*.ts route file
// referenced above each block.
//
// Endpoints covered here (none duplicate handlers/therapy.ts,
// handlers/integrations-comms.ts, handlers/clinical.ts, or handlers/shop.ts):
//   shop-reviews.ts, shop-review-requests.ts, stripe-connect.ts,
//   system-integrations-status.ts, tenant-setup.ts, xps-shipping.ts,
//   webhook-delivery-retry.ts, and the two therapy-fleet.ts mutations not
//   already seeded by handlers/therapy.ts (worklist action + alert resolve).
//
// SKIPPED (already handled / not seedable):
//   - therapy-fleet GET overview/trend/alerts/worklist/clinical-insights and
//     therapy-resupply GET summary/opportunities/draft-orders → handlers/therapy.ts
//   - webhook-test-send POST /webhook-subscriptions/:id/test-send → handlers/integrations-comms.ts
//   - swo.ts (streams a PDF), *.csv reports, xps label.pdf (binary streams)
//
// DATA RULES: fictional demo data only. Platform = CareMetric Breathe; the
// active tenant is CareMetric Demo DME (demo.example). Therapy-cloud
// vendors are ResMed AirView / Philips Care Orchestrator / 3B React Health.
// Money in cents. Realistic-but-synthetic clinical values. NO real PHI.

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import { daysAgo, NOW_ISO } from "../fixtures/dates";

// ── Shop reviews moderation queue (shop-reviews.ts) ───────────────────
// GET /resupply-api/admin/shop/reviews?status=… → { items, nextCursor }
const SHOP_REVIEWS = [
  {
    id: "demo-rev-0001-0000-0000-0000-000000000001",
    productId: "prod_demo_airfit_n30i",
    rating: 5,
    title: "Best nasal mask I've tried",
    body: "Quiet, comfortable, and the cushion sealed first try. Reorder was painless.",
    authorDisplayName: "Avery S.",
    authorEmail: "avery.sample@example.com",
    status: "pending" as const,
    moderationNote: null,
    moderatedAt: null,
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
  },
  {
    id: "demo-rev-0001-0000-0000-0000-000000000002",
    productId: "prod_demo_dreamwear_pillows",
    rating: 4,
    title: "Good once I sized up",
    body: "Small leaked at the top; medium was perfect. Shipping was fast.",
    authorDisplayName: "Demo P.",
    authorEmail: "demo.patient@example.com",
    status: "pending" as const,
    moderationNote: null,
    moderatedAt: null,
    createdAt: daysAgo(2),
    updatedAt: daysAgo(2),
  },
  {
    id: "demo-rev-0001-0000-0000-0000-000000000003",
    productId: "prod_demo_airfit_f30",
    rating: 5,
    title: "Great full-face option",
    body: "Lighter than my old mask and no marks in the morning.",
    authorDisplayName: "Quinn M.",
    authorEmail: "quinn.mockton@example.com",
    status: "approved" as const,
    moderationNote: null,
    moderatedAt: daysAgo(5),
    createdAt: daysAgo(7),
    updatedAt: daysAgo(5),
  },
  {
    id: "demo-rev-0001-0000-0000-0000-000000000004",
    productId: "prod_demo_standard_tubing",
    rating: 1,
    title: "Off-topic complaint",
    body: "This review was about a billing issue, not the product.",
    authorDisplayName: "Jordan F.",
    authorEmail: "jordan.fixture@example.com",
    status: "rejected" as const,
    moderationNote: "Off-topic — routed the customer to support instead.",
    moderatedAt: daysAgo(3),
    createdAt: daysAgo(6),
    updatedAt: daysAgo(3),
  },
];

function shopReviews(status: string) {
  const items =
    status === "all"
      ? SHOP_REVIEWS
      : SHOP_REVIEWS.filter((r) => r.status === status);
  return { items, nextCursor: null };
}

// ── Stripe Connect status (stripe-connect.ts) ─────────────────────────
// GET /resupply-api/admin/billing/stripe-connect/status
//   { connected, chargesEnabled, accountId }
function stripeConnectStatus() {
  return {
    connected: true,
    chargesEnabled: true,
    // Obviously-fake demo account id — never a real acct_ key.
    accountId: "acct_DEMO000CareMetricDemo",
  };
}

// ── System integrations status (system-integrations-status.ts) ────────
// GET /resupply-api/admin/system/integrations-status
function systemIntegrationsStatus() {
  return {
    dmeIdentity: {
      source: "db",
      organizationName: "CareMetric Demo DME",
      configured: true,
    },
    clearinghouseOfficeAlly: {
      source: "db",
      configured: true,
      usageIndicator: "P",
      lastPolledAt: daysAgo(0),
    },
    stripe: {
      configured: true,
      webhookSigningConfigured: true,
    },
    openai: {
      configured: true,
      note: "Powers AI scrub, denial analysis, sleep coach, patient explainer.",
    },
    sendgrid: { configured: true },
    twilio: { configured: true },
    telnyx: {
      configured: true,
      faxConfigured: true,
      webhookSigningConfigured: true,
    },
    davinciPas: { configured: false },
    webhooks: {
      queuedDeliveries: 2,
      exhaustedDeliveries24h: 0,
      healthy: true,
    },
    generatedAt: NOW_ISO(),
  };
}

// ── Tenant setup checklist (tenant-setup.ts) ──────────────────────────
// GET /resupply-api/admin/organization/setup-checklist
//   { generatedAt, items, summary }
type SetupStatus = "complete" | "incomplete" | "action";
interface SetupItem {
  id: string;
  group: string;
  title: string;
  description: string;
  status: SetupStatus;
  detail: string | null;
  href: string | null;
  required: boolean;
}

function tenantSetupChecklist() {
  const items: SetupItem[] = [
    {
      id: "branding",
      group: "Branding & domain",
      title: "Set your storefront name & logo",
      description:
        "Name, tagline, and logo shown on your storefront, documents, and patient messages.",
      status: "complete",
      detail: "Storefront name set · logo uploaded.",
      href: "/admin/storefront-branding",
      required: true,
    },
    {
      id: "custom-domain",
      group: "Branding & domain",
      title: "Connect your custom domain",
      description:
        "Serve your storefront on your own domain instead of the platform subdomain. Verify by adding a DNS record.",
      status: "complete",
      detail: "Verified: demo.example.",
      href: "/admin/storefront-branding",
      required: false,
    },
    {
      id: "sms-number",
      group: "Phone, SMS & fax",
      title: "Get an SMS number",
      description:
        "Your own number for resupply texts and inbound replies, so messages come from you — not a shared platform number.",
      status: "complete",
      detail: "SMS number: +1 (215) 555-0142.",
      href: "/admin/phone-settings",
      required: true,
    },
    {
      id: "voice-number",
      group: "Phone, SMS & fax",
      title: "Get a phone number for voice calls",
      description:
        "Your own caller ID for the automated voice agent's outbound calls and inbound call routing.",
      status: "complete",
      detail: "Voice number: +1 (215) 555-0188.",
      href: "/admin/phone-settings",
      required: false,
    },
    {
      id: "fax-number",
      group: "Phone, SMS & fax",
      title: "Get a fax number",
      description:
        "Your own fax line for inbound documents (sleep studies, signed Rx) and outbound physician outreach.",
      status: "incomplete",
      detail: "Not set — faxes fall back to the platform default.",
      href: "/admin/fax-settings",
      required: false,
    },
    {
      id: "email-sender",
      group: "Email",
      title: "Set your email From address",
      description:
        "Send patient email from your own address. Requires authenticating your sending domain (SPF/DKIM) in SendGrid so mail isn't flagged as spam.",
      status: "complete",
      detail: "Sending as info@demo.example.",
      href: "/admin/email-settings",
      required: true,
    },
    {
      id: "payments",
      group: "Payments",
      title: "Connect payments (Stripe)",
      description:
        "Connect your Stripe account so storefront checkout deposits to you. Required before opening the cash-pay shop.",
      status: "complete",
      detail: "Stripe connected and charges enabled.",
      href: "/admin/billing/config/organization",
      required: true,
    },
  ];
  const requiredItems = items.filter((i) => i.required);
  const requiredDone = requiredItems.filter(
    (i) => i.status === "complete",
  ).length;
  return {
    generatedAt: NOW_ISO(),
    items,
    summary: {
      requiredTotal: requiredItems.length,
      requiredDone,
      allRequiredDone:
        requiredItems.length > 0 && requiredDone === requiredItems.length,
    },
  };
}

// ── XPS shipping (xps-shipping.ts) ────────────────────────────────────
// GET /resupply-api/admin/shipping/xps/status → { availability }
function xpsStatus() {
  return { availability: { status: "configured" as const } };
}

// GET /resupply-api/admin/shipping/xps/queue → { orders }
function xpsQueue() {
  return {
    orders: [
      {
        id: "a1b2c3d4-0001-4001-8001-000000000001",
        createdAt: daysAgo(1),
        amountTotalCents: 4995,
        labelStatus: null as "staged" | "booked" | "voided" | null,
        shipTo: "Philadelphia, PA 19103",
        hasAddress: true,
        addressValid: true,
      },
      {
        id: "a1b2c3d4-0002-4002-8002-000000000002",
        createdAt: daysAgo(2),
        amountTotalCents: 12900,
        labelStatus: "staged" as "staged" | "booked" | "voided" | null,
        shipTo: "Pittsburgh, PA 15213",
        hasAddress: true,
        addressValid: true,
      },
      {
        id: "a1b2c3d4-0003-4003-8003-000000000003",
        createdAt: daysAgo(3),
        amountTotalCents: 3250,
        labelStatus: null as "staged" | "booked" | "voided" | null,
        shipTo: null,
        hasAddress: false,
        addressValid: false,
      },
    ],
  };
}

// GET /resupply-api/admin/shipping/xps/product-specs
//   { specs, unconfiguredProductIds }
function xpsProductSpecs() {
  return {
    specs: [
      {
        productId: "prod_demo_airfit_n30i",
        weightOz: 6,
        lengthIn: 9,
        widthIn: 6,
        heightIn: 3,
        label: "Nasal mask (boxed)",
      },
      {
        productId: "prod_demo_standard_tubing",
        weightOz: 4,
        lengthIn: 8,
        widthIn: 5,
        heightIn: 3,
        label: "Standard 6ft tubing",
      },
    ],
    unconfiguredProductIds: ["prod_demo_dreamwear_pillows"],
  };
}

// GET /resupply-api/admin/shop/orders/:orderId/shipping/suggested-parcel
function xpsSuggestedParcel() {
  return {
    weightOz: 10,
    lengthIn: 9,
    widthIn: 6,
    heightIn: 4,
    fromPresets: true,
    missingProductIds: [],
  };
}

export const ext9Handlers: DemoHandler[] = [
  // ── Shop reviews moderation (shop-reviews.ts) ───────────────────────
  route("GET", "/resupply-api/admin/shop/reviews", (req) =>
    json(shopReviews(req.query.get("status") ?? "pending")),
  ),
  route(
    "POST",
    "/resupply-api/admin/shop/reviews/:id/approve",
    (_req, { id }) => json({ id, status: "approved", moderatedAt: NOW_ISO() }),
  ),
  route("POST", "/resupply-api/admin/shop/reviews/:id/reject", (_req, { id }) =>
    json({ id, status: "rejected", moderatedAt: NOW_ISO() }),
  ),
  route(
    "POST",
    "/resupply-api/admin/shop/reviews/:id/unreject",
    (_req, { id }) => json({ id, status: "pending", moderatedAt: null }),
  ),
  route("PATCH", "/resupply-api/admin/shop/reviews/:id/note", (req, { id }) => {
    const body = req.json<{ note?: string | null }>();
    const note =
      typeof body?.note === "string" && body.note.trim() !== ""
        ? body.note.trim()
        : null;
    return json({
      id,
      status: "rejected",
      moderationNote: note,
      moderatedAt: daysAgo(3),
    });
  }),

  // ── Shop review-request dispatcher (shop-review-requests.ts) ─────────
  route("POST", "/resupply-api/admin/shop/review-requests/send-due", () =>
    json({
      scanned: 5,
      sent: 4,
      skippedNoConfig: 0,
      skippedFailed: 0,
      skippedOptOut: 1,
    }),
  ),

  // ── Stripe Connect (stripe-connect.ts) ──────────────────────────────
  route("GET", "/resupply-api/admin/billing/stripe-connect/status", () =>
    json(stripeConnectStatus()),
  ),
  route("POST", "/resupply-api/admin/billing/stripe-connect/start", () =>
    json({
      url: "https://connect.stripe.com/setup/e/demo_onboarding_link",
      accountId: "acct_DEMO000CareMetricDemo",
    }),
  ),
  route("POST", "/resupply-api/admin/billing/stripe-connect/refresh", () =>
    json({
      connected: true,
      chargesEnabled: true,
      accountId: "acct_DEMO000CareMetricDemo",
    }),
  ),
  route("POST", "/resupply-api/admin/billing/stripe-connect/disconnect", () =>
    json({ connected: false, chargesEnabled: false, accountId: null }),
  ),

  // ── System integrations status (system-integrations-status.ts) ──────
  route("GET", "/resupply-api/admin/system/integrations-status", () =>
    json(systemIntegrationsStatus()),
  ),

  // ── Tenant setup checklist (tenant-setup.ts) ────────────────────────
  route("GET", "/resupply-api/admin/organization/setup-checklist", () =>
    json(tenantSetupChecklist()),
  ),

  // ── XPS shipping (xps-shipping.ts) ──────────────────────────────────
  route("GET", "/resupply-api/admin/shipping/xps/status", () =>
    json(xpsStatus()),
  ),
  route("GET", "/resupply-api/admin/shipping/xps/queue", () =>
    json(xpsQueue()),
  ),
  route("GET", "/resupply-api/admin/shipping/xps/product-specs", () =>
    json(xpsProductSpecs()),
  ),
  route("PUT", "/resupply-api/admin/shipping/xps/product-specs", (req) => {
    const body = req.json<{ specs?: unknown[] }>();
    return json({ ok: true, count: body?.specs?.length ?? 0 });
  }),
  route(
    "GET",
    "/resupply-api/admin/shop/orders/:orderId/shipping/suggested-parcel",
    () => json(xpsSuggestedParcel()),
  ),
  route("POST", "/resupply-api/admin/shop/orders/:orderId/shipping/rates", () =>
    json({
      rates: [
        {
          carrier: "USPS",
          service: "Priority Mail",
          serviceCode: "usps_priority",
          totalCents: 895,
          estimatedDays: 2,
        },
        {
          carrier: "UPS",
          service: "Ground",
          serviceCode: "ups_ground",
          totalCents: 1120,
          estimatedDays: 3,
        },
      ],
    }),
  ),
  route("POST", "/resupply-api/admin/shop/orders/:orderId/shipping/label", () =>
    json({
      status: "booked",
      carrier: "USPS",
      trackingNumber: "9400100000000000000000",
      bookNumber: "DEMO-BOOK-77100",
    }),
  ),
  route("POST", "/resupply-api/admin/shop/orders/:orderId/shipping/sync", () =>
    json({
      status: "booked",
      carrier: "USPS",
      trackingNumber: "9400100000000000000000",
      bookNumber: "DEMO-BOOK-77100",
    }),
  ),
  route("POST", "/resupply-api/admin/shop/orders/:orderId/shipping/void", () =>
    json({ status: "voided" }),
  ),
  route("POST", "/resupply-api/admin/shipping/xps/batch-label", (req) => {
    const body = req.json<{ orderIds?: string[] }>();
    const ids = body?.orderIds ?? [];
    const results = ids.map((orderId) => ({
      orderId,
      status: "booked" as const,
      trackingNumber: "9400100000000000000000",
      carrier: "USPS",
    }));
    return json({
      results,
      summary: { booked: results.length, staged: 0, errored: 0 },
    });
  }),

  // ── Webhook delivery retry (webhook-delivery-retry.ts) ──────────────
  // (test-send is already seeded in handlers/integrations-comms.ts)
  route("POST", "/resupply-api/admin/webhook-deliveries/:id/retry-now", () =>
    json(
      {
        ok: true,
        note: "requeued; dispatcher will attempt within ~60 seconds",
      },
      202,
    ),
  ),

  // ── Therapy-fleet mutations NOT covered by handlers/therapy.ts ──────
  // (therapy-fleet.ts GETs overview/trend/alerts/worklist/clinical-insights
  //  are already seeded there; only these two mutations remain.)
  route(
    "POST",
    "/resupply-api/admin/therapy-fleet/worklist/:patientId/action",
    (req, { patientId }) => {
      const body = req.json<{
        action?: string;
        snoozeUntil?: string;
        note?: string;
      }>();
      const action = body?.action ?? "acknowledged";
      return json({
        patientId,
        action: {
          status: action,
          snoozeUntil:
            action === "snoozed" ? (body?.snoozeUntil ?? null) : null,
          note: body?.note ?? null,
          updatedByEmail: "demo.csr@caremetric.example",
          updatedAt: NOW_ISO(),
        },
      });
    },
  ),
  route(
    "POST",
    "/resupply-api/admin/therapy-fleet/alerts/:id/resolve",
    (_req, { id }) => json({ id, status: "resolved" }),
  ),
];
