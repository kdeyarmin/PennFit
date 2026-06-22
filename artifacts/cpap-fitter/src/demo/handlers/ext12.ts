// SHOP / patient-portal + public-shop handlers for the demo sandbox
// (batch 12).
//
// Seeds the storefront + signed-in account endpoints that would
// otherwise fall through to the interceptor's benign empty-`{}` GET
// fallback and leave a page blank or throw on a missing field:
// address validation, in-store pickup locations, Web Push device
// registration, the patient referral program, the 90-day quarterly
// therapy summary, self-reported sleep studies, and customer-initiated
// returns. Mutations return benign success in the live route's exact
// response shape.
//
// Every endpoint here was confirmed against the live route files in
// artifacts/resupply-api/src/routes/shop/* and the client callers in
// artifacts/cpap-fitter/src/lib/** so the demo response matches what
// the SPA parses.
//
// DATA RULES: fictional demo data only — fake names ("Alex Demo",
// "Jordan Sample"), demo ids, fresh relative dates via the date
// helpers, money in integer cents. Platform = CareMetric Breathe;
// tenant = Penn Home Medical Supply (pennpaps.com). Internally
// consistent with the seeded product / order fixtures. NO real PHI.
//
// SKIPPED (already handled elsewhere, or non-JSON):
//   * me.ts, me-messages.ts, me-maintenance.ts,
//     me-reorder-suggestions.ts, me-substitutions.ts,
//     me-therapy-summary.ts, my-orders.ts, my-subscriptions.ts,
//     quick-checkout.ts (POST /shop/me/quick-checkout),
//     resend-receipt.ts — all seeded in handlers/account.ts.
//   * order.ts (GET /shop/orders/:sessionId), quiz-lead.ts
//     (POST /shop/quiz-leads), product-compatibility.ts — seeded in
//     handlers/shop.ts.
//   * nps-response.ts (POST /shop/orders/nps) — seeded in handlers/misc.ts.
//   * order-pod.ts (GET /shop/orders/:sessionId/pod) — streams binary
//     image bytes; skipped.

import { route, type DemoHandler } from "../types";
import { json, noContent } from "../respond";
import { daysAgo, dateOnly, NOW_ISO } from "../fixtures/dates";

// ── Address validation (validate-address.ts) ──────────────────────────
// POST /resupply-api/shop/validate-address → AddressValidationResult
//   { ok: true } | { ok: false, reasons: string[] }
// The demo always returns a clean pass — the storefront checkout +
// account ProfileSection probe this before saving; an "ok" verdict lets
// the form proceed without inventing a correction.
const addressValidationHandlers: DemoHandler[] = [
  route("POST", "/resupply-api/shop/validate-address", () =>
    json({ ok: true }),
  ),
];

// ── In-store pickup locations (pickup-locations.ts) ───────────────────
// GET /resupply-api/shop/pickup-locations → { enabled, locations }
// Pickup is offered in the demo so the cart shows the "Pick up in
// store" choice. Locations are Penn Home Medical Supply storefronts.
const pickupLocationHandlers: DemoHandler[] = [
  route("GET", "/resupply-api/shop/pickup-locations", () =>
    json({
      enabled: true,
      locations: [
        {
          id: "demo-pickup-1",
          name: "Penn Home Medical Supply — Center City",
          addressLine1: "1200 Market Street",
          addressLine2: "Suite 100",
          city: "Philadelphia",
          state: "PA",
          postalCode: "19107",
          phoneE164: "+12155550148",
          isPrimary: true,
        },
        {
          id: "demo-pickup-2",
          name: "Penn Home Medical Supply — King of Prussia",
          addressLine1: "160 N Gulph Road",
          addressLine2: null,
          city: "King of Prussia",
          state: "PA",
          postalCode: "19406",
          phoneE164: "+16105550172",
          isPrimary: false,
        },
      ],
    }),
  ),
];

// ── Web Push device registration (me-push-subscriptions.ts) ───────────
// GET    /resupply-api/shop/me/push-subscriptions                 → { subscriptions }
// GET    /resupply-api/shop/me/push-subscriptions/vapid-public-key → 503 push_not_configured
// POST   /resupply-api/shop/me/push-subscriptions                 → 204
// DELETE /resupply-api/shop/me/push-subscriptions                 → 204
//
// Push notifications are not configured in the demo (no VAPID keys in
// the browser), so the vapid-public-key probe returns the same 503 the
// live route uses when the triple is unset — the SPA then hides the
// "Enable push" toggle. The list + register/unregister still answer
// cleanly so any code that calls them doesn't error.
const pushSubscriptionHandlers: DemoHandler[] = [
  route("GET", "/resupply-api/shop/me/push-subscriptions", () =>
    json({ subscriptions: [] }),
  ),
  route(
    "GET",
    "/resupply-api/shop/me/push-subscriptions/vapid-public-key",
    () =>
      json(
        {
          error: "push_not_configured",
          message: "Push notifications are not configured in the demo.",
        },
        503,
      ),
  ),
  route("POST", "/resupply-api/shop/me/push-subscriptions", () => noContent()),
  route("DELETE", "/resupply-api/shop/me/push-subscriptions", () =>
    noContent(),
  ),
];

// ── Referral program (me-referrals.ts) ────────────────────────────────
// GET  /resupply-api/shop/me/referrals → { patientLinked, stats, referrals }
// POST /resupply-api/shop/me/referrals → { id, code } (201)
//
// A short demo referral history so the /account referral card renders
// stats + a list. Codes are URL-safe alphanumerics like the live
// generator produces.
function demoReferralCode(): string {
  return `DEMO${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

const referralHandlers: DemoHandler[] = [
  route("GET", "/resupply-api/shop/me/referrals", () =>
    json({
      patientLinked: true,
      stats: { total: 2, converted: 1, pending: 1 },
      referrals: [
        {
          id: "demo-referral-1",
          code: "BREATHE24",
          refereeEmail: "jordan.sample@pennfit.example",
          refereeName: "Jordan Sample",
          status: "converted",
          convertedAt: daysAgo(9),
          createdAt: daysAgo(21),
        },
        {
          id: "demo-referral-2",
          code: "SLEEPWELL",
          refereeEmail: "casey.demo@pennfit.example",
          refereeName: "Casey Demo",
          status: "pending",
          convertedAt: null,
          createdAt: daysAgo(4),
        },
      ],
    }),
  ),
  route("POST", "/resupply-api/shop/me/referrals", () =>
    json({ id: `demo-referral-${Date.now()}`, code: demoReferralCode() }, 201),
  ),
];

// ── Quarterly therapy summary (me-quarterly-summary.ts) ────────────────
// GET /resupply-api/shop/me/quarterly-summary           → print HTML
// GET /resupply-api/shop/me/quarterly-summary?format=json → { fields }
//
// The live route returns print-friendly HTML the patient saves to PDF,
// or a JSON `{ fields }` envelope when ?format=json. We serve a small
// HTML page (and the matching JSON) summarising a fictional 90-day
// window consistent with the demo therapy-summary fixture (~6.4 h
// usage, AHI ~2.3, high adherence).
const QUARTERLY_FIELDS = {
  patientName: "Alex Demo",
  dateOfBirth: "1968-04-12",
  practiceName: "Penn Home Medical Supply",
  windowStart: dateOnly(-90),
  windowEnd: dateOnly(0),
  nightsRecorded: 86,
  avgUsageHours: 6.4,
  avgAhi: 2.3,
  avgLeakLMin: 9.1,
  compliantNights: 80,
  complianceRate: 0.93,
};

function quarterlySummaryHtml(): string {
  const f = QUARTERLY_FIELDS;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>90-Day Therapy Summary — ${f.patientName}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; margin: 2rem; color: #1a2b3c; }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  .muted { color: #5b6b7b; font-size: 0.9rem; }
  table { border-collapse: collapse; margin-top: 1.5rem; width: 100%; max-width: 32rem; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #e2e8f0; }
  th { color: #5b6b7b; font-weight: 600; }
  .note { margin-top: 2rem; font-size: 0.8rem; color: #5b6b7b; }
</style>
</head>
<body>
  <h1>90-Day CPAP Therapy Summary</h1>
  <div class="muted">${f.practiceName} &middot; ${f.windowStart} to ${f.windowEnd}</div>
  <table>
    <tr><th>Patient</th><td>${f.patientName}</td></tr>
    <tr><th>Nights recorded</th><td>${f.nightsRecorded}</td></tr>
    <tr><th>Average nightly use</th><td>${f.avgUsageHours} hours</td></tr>
    <tr><th>Average AHI</th><td>${f.avgAhi} events/hour</td></tr>
    <tr><th>Average leak</th><td>${f.avgLeakLMin} L/min</td></tr>
    <tr><th>Compliant nights (&ge;4 h)</th><td>${f.compliantNights} of ${f.nightsRecorded}</td></tr>
    <tr><th>Adherence rate</th><td>${Math.round(f.complianceRate * 100)}%</td></tr>
  </table>
  <p class="note">This is a CareMetric Breathe demonstration. The data shown is
  simulated and does not represent a real patient.</p>
</body>
</html>`;
}

const quarterlySummaryHandlers: DemoHandler[] = [
  route("GET", "/resupply-api/shop/me/quarterly-summary", (req) => {
    if (req.query.get("format") === "json") {
      return json({ fields: QUARTERLY_FIELDS });
    }
    return new Response(quarterlySummaryHtml(), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }),
];

// ── Self-reported sleep study (me-sleep-study.ts) ─────────────────────
// POST /resupply-api/shop/me/sleep-study → { id } (201)
// Benign success so the patient's "record my sleep study" form confirms.
const sleepStudyHandlers: DemoHandler[] = [
  route("POST", "/resupply-api/shop/me/sleep-study", () =>
    json({ id: `demo-sleep-study-${Date.now()}` }, 201),
  ),
];

// ── Customer-initiated return (my-returns.ts) ─────────────────────────
// POST /resupply-api/shop/me/orders/:sessionId/returns
//   → { id, status, createdAt, approvedAt, autoApprovedBy } (201)
//
// GET /shop/me/returns is already seeded in handlers/account.ts; this
// covers only the start-a-return mutation. The demo lands the return in
// the manual `requested` queue (no auto-approval) so the SPA renders the
// standard "we'll review this" confirmation.
const returnInitiationHandlers: DemoHandler[] = [
  route("POST", "/resupply-api/shop/me/orders/:sessionId/returns", () =>
    json(
      {
        id: `demo-return-${Date.now()}`,
        status: "requested",
        createdAt: NOW_ISO(),
        approvedAt: null,
        autoApprovedBy: null,
      },
      201,
    ),
  ),
];

export const ext12Handlers: DemoHandler[] = [
  ...addressValidationHandlers,
  ...pickupLocationHandlers,
  ...pushSubscriptionHandlers,
  ...referralHandlers,
  ...quarterlySummaryHandlers,
  ...sleepStudyHandlers,
  ...returnInitiationHandlers,
];
