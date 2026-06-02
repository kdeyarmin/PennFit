// Signed-in customer account handlers: everything under
// /resupply-api/shop/me/* and the patient-billing endpoints under
// /api/me/*. Reads return seeded fixtures (some via the mutable demo
// store); writes update the store so changes stick within the session.

import { route, type DemoHandler } from "../types";
import { json, noContent } from "../respond";
import {
  demoMeResponse,
  demoDashboard,
  demoTherapySummary,
  demoMaintenance,
  demoInsights,
  demoSubscriptions,
  demoReorderSuggestions,
  demoBillingBalance,
  demoBillingStatements,
  demoPayments,
  demoInsuranceEstimate,
  DEMO_CUSTOMER,
} from "../fixtures/account";
import { demoStore } from "../fixtures/store";
import { daysAgo, NOW_ISO } from "../fixtures/dates";
import { demoSessionId } from "../ids";
import { appBaseUrl } from "../paths";

export const accountHandlers: DemoHandler[] = [
  // ── profile ──────────────────────────────────────────────────────
  route("GET", "/resupply-api/shop/me", () =>
    json(demoMeResponse(demoStore.getProfile())),
  ),
  route("PUT", "/resupply-api/shop/me", (req) => {
    const body =
      req.json<{
        displayName?: string | null;
        shippingAddress?:
          | import("@/lib/account-api").SavedShippingAddress
          | null;
      }>() ?? {};
    const profile = demoStore.updateProfile({
      ...(body.displayName !== undefined
        ? { displayName: body.displayName }
        : {}),
      ...(body.shippingAddress !== undefined
        ? { shippingAddress: body.shippingAddress }
        : {}),
    });
    return json({ profile });
  }),

  // ── clinical info ────────────────────────────────────────────────
  route("GET", "/resupply-api/shop/me/clinical-info", () =>
    json(demoStore.getClinical()),
  ),
  route("PUT", "/resupply-api/shop/me/clinical-info", (req) => {
    const body =
      req.json<
        Partial<import("@/lib/account-api").ShopClinicalInfoResponse>
      >() ?? {};
    return json(demoStore.updateClinical(body));
  }),

  // ── dashboard ────────────────────────────────────────────────────
  route("GET", "/resupply-api/shop/me/dashboard", () => json(demoDashboard())),

  // ── communication preferences ────────────────────────────────────
  route("GET", "/resupply-api/shop/me/comm-prefs", () =>
    json({ preferences: demoStore.getCommPrefs() }),
  ),
  route("PUT", "/resupply-api/shop/me/comm-prefs", (req) => {
    const body =
      req.json<
        Partial<import("@/lib/account-api").CommunicationPreferences>
      >() ?? {};
    return json({ preferences: demoStore.updateCommPrefs(body) });
  }),

  // ── messages ─────────────────────────────────────────────────────
  route("GET", "/resupply-api/shop/me/messages", () =>
    json(demoStore.getMessages()),
  ),
  route("GET", "/resupply-api/shop/me/messages/unread-count", () =>
    json({ unreadFromCsr: demoStore.getMessages().unreadFromCsr }),
  ),
  route("POST", "/resupply-api/shop/me/messages/mark-read", () => {
    demoStore.markMessagesRead();
    return json({ ok: true, threadUpdated: true });
  }),
  route("POST", "/resupply-api/shop/me/messages", (req) => {
    const body = req.json<{ body?: string }>() ?? {};
    return json(demoStore.postMessage(body.body ?? ""));
  }),

  // ── therapy + maintenance ────────────────────────────────────────
  route("GET", "/resupply-api/shop/me/therapy-summary", () =>
    json(demoTherapySummary()),
  ),
  route("GET", "/resupply-api/shop/me/maintenance", () =>
    json(demoMaintenance()),
  ),
  route(
    "POST",
    "/resupply-api/shop/me/maintenance/:taskKey/log",
    (_req, { taskKey }) =>
      json({ id: `demo-log-${taskKey}`, taskKey, completedAt: NOW_ISO() }),
  ),

  // ── insights + education ─────────────────────────────────────────
  route("GET", "/resupply-api/shop/me/insights", () =>
    json({ insights: demoInsights() }),
  ),
  route("POST", "/resupply-api/shop/me/insights/:id/dismiss", () =>
    json({ ok: true }),
  ),
  route("GET", "/resupply-api/shop/me/education-feed", () =>
    json({
      patientLinked: true,
      stage: "habituating",
      daysOnTherapy: 38,
      articles: [
        {
          slug: "mask-leaks",
          title: "Fixing mask leaks",
          summary:
            "Small adjustments that stop the hiss and keep your therapy effective.",
          category: "troubleshooting",
        },
        {
          slug: "cleaning-routine",
          title: "Your weekly cleaning routine",
          summary: "A 5-minute routine that keeps your equipment fresh.",
          category: "maintenance",
        },
        {
          slug: "traveling-with-cpap",
          title: "Traveling with CPAP",
          summary: "TSA tips and travel-friendly setups for therapy on the go.",
          category: "lifestyle",
        },
      ],
    }),
  ),
  route("GET", "/resupply-api/shop/me/substitutions", () =>
    json({ patientLinked: true, substitutions: [] }),
  ),

  // ── subscriptions ────────────────────────────────────────────────
  route("GET", "/resupply-api/shop/me/subscriptions", () =>
    json(demoSubscriptions()),
  ),
  route("POST", "/resupply-api/shop/me/subscriptions/:id/cancel", () =>
    json({ ok: true, alreadyCanceled: false }),
  ),
  route("POST", "/resupply-api/shop/me/subscriptions/:id/pause", () =>
    json({ ok: true }),
  ),
  route("POST", "/resupply-api/shop/me/subscriptions/:id/resume", () =>
    json({ ok: true }),
  ),
  route("GET", "/resupply-api/shop/me/subscriptions/:id/cadence-options", () =>
    json({
      options: [
        {
          priceId: "demo_price_2999_sub",
          intervalLabel: "1 month",
          unitAmountCents: 2999,
          currency: "usd",
          isCurrent: false,
        },
        {
          priceId: "demo_price_2999_sub3",
          intervalLabel: "3 months",
          unitAmountCents: 2999,
          currency: "usd",
          isCurrent: true,
        },
      ],
    }),
  ),
  route("POST", "/resupply-api/shop/me/subscriptions/:id/cadence", () =>
    json({ ok: true, unchanged: false }),
  ),
  route("GET", "/resupply-api/shop/me/reorder-suggestions", () =>
    json(demoReorderSuggestions()),
  ),

  // ── order history ────────────────────────────────────────────────
  route("GET", "/resupply-api/shop/me/orders", () =>
    json({ orders: demoStore.orderHistory(), nextCursor: null }),
  ),
  route("POST", "/resupply-api/shop/me/orders/:sessionId/resend-receipt", () =>
    json({ sent: true, email: DEMO_CUSTOMER.email }),
  ),
  route(
    "POST",
    "/resupply-api/shop/me/orders/:id/shipping-address",
    (req, { id }) => {
      const address = req.json<
        import("@/lib/shop-api").OrderShippingAddress
      >() ?? {
        line1: "",
        line2: null,
        city: "",
        state: "",
        postalCode: "",
        country: "US" as const,
      };
      return json({
        order: {
          id,
          shippingAddress: address,
          shippedAt: null,
          canEditAddress: true,
        },
      });
    },
  ),

  // ── returns + documents ──────────────────────────────────────────
  route("GET", "/resupply-api/shop/me/returns", () =>
    json({
      returns: [
        {
          id: "demo-return-1",
          orderId: "demo-order-2",
          sessionId: "demo_sess_1002",
          status: "refunded",
          reason: "fit",
          reasonNote: "Cushion was a touch large.",
          resolution: "Refunded to original payment method.",
          refundCents: 2999,
          returnLabelUrl: null,
          returnCarrier: "USPS",
          returnTrackingNumber: "9400100000000000000000",
          createdAt: daysAgo(50),
          updatedAt: daysAgo(44),
          approvedAt: daysAgo(49),
          rejectedAt: null,
          receivedAt: daysAgo(45),
          resolvedAt: daysAgo(44),
          closedAt: daysAgo(44),
        },
      ],
    }),
  ),
  route("GET", "/resupply-api/shop/me/documents", () =>
    json({
      documents: [
        {
          id: "demo-doc-1",
          documentType: "insurance_card",
          filename: "insurance-card.jpg",
          contentType: "image/jpeg",
          sizeBytes: 184320,
          createdAt: daysAgo(30),
          reviewedAt: daysAgo(29),
        },
      ],
    }),
  ),
  route("POST", "/resupply-api/shop/me/documents/upload-url", () =>
    json({
      uploadURL: `${appBaseUrl()}demo-upload-sink`,
      objectPath: "demo/uploads/file",
    }),
  ),
  route("POST", "/resupply-api/shop/me/documents", () =>
    json({ ok: true, id: `demo-doc-${Date.now()}` }),
  ),
  route("DELETE", "/resupply-api/shop/me/documents/:id", () =>
    json({ ok: true }),
  ),

  // ── caregiver ────────────────────────────────────────────────────
  route("GET", "/resupply-api/shop/me/caregiver", () =>
    json({ caregiver: null }),
  ),
  route("PUT", "/resupply-api/shop/me/caregiver", (req) => {
    const body = req.json<{ name?: string; email?: string }>() ?? {};
    return json({
      caregiver: {
        name: body.name ?? "Demo Caregiver",
        email: body.email ?? "caregiver@pennfit.example",
        consentAt: NOW_ISO(),
        revokedAt: null,
      },
    });
  }),
  route("DELETE", "/resupply-api/shop/me/caregiver", () =>
    json({ caregiver: null }),
  ),

  // ── my reviews (account-scoped CRUD) ─────────────────────────────
  route(
    "GET",
    "/resupply-api/shop/me/reviews/:productId",
    (_req, { productId }) => {
      const review = demoStore.getReview(productId);
      return review ? json(review) : json({ error: "not_found" }, 404);
    },
  ),
  route(
    "PATCH",
    "/resupply-api/shop/me/reviews/:productId",
    (req, { productId }) => {
      const body = req.json<{
        rating: 1 | 2 | 3 | 4 | 5;
        title: string | null;
        body: string;
      }>() ?? { rating: 5 as const, title: null, body: "" };
      return json(demoStore.upsertReview(productId, body));
    },
  ),
  route(
    "DELETE",
    "/resupply-api/shop/me/reviews/:productId",
    (_req, { productId }) => {
      demoStore.deleteReview(productId);
      return noContent();
    },
  ),

  // ── signed-in quick checkout + billing portal ────────────────────
  route("POST", "/resupply-api/shop/me/quick-checkout", () => {
    const sessionId = demoSessionId();
    return json({
      url: `${appBaseUrl()}shop/checkout-success?session_id=${sessionId}`,
      sessionId,
    });
  }),
  route("POST", "/resupply-api/shop/me/billing-portal", () =>
    json({ url: `${appBaseUrl()}account/billing` }),
  ),

  // ── patient billing (/api/me/*) ──────────────────────────────────
  route("GET", "/api/me/billing-balance", () => json(demoBillingBalance())),
  route("GET", "/api/me/billing-statements", () =>
    json(demoBillingStatements()),
  ),
  route("GET", "/api/me/payments", () => json(demoPayments())),
  route("GET", "/api/me/insurance-estimate", () =>
    json(demoInsuranceEstimate()),
  ),
  route("POST", "/api/me/payments/checkout-session", (req) => {
    const body = req.json<{ amountCents?: number }>() ?? {};
    const sessionId = demoSessionId();
    return json({
      paymentId: `demo-pay-${Date.now()}`,
      url: `${appBaseUrl()}shop/checkout-success?session_id=${sessionId}`,
      amountCents: body.amountCents ?? 4250,
    });
  }),
];
