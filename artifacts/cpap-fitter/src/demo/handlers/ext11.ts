// Demo handlers — extension batch 11. Seeds the remaining SHOP /
// PATIENT-PORTAL ("me-*") read + prominent-mutation endpoints that the
// base account/shop handler modules don't already cover:
//
//   * /shop/me/cart-snapshot          (GET / PUT / DELETE)
//   * /shop/education-videos          (GET — public /learn/videos)
//   * /shop/me/equipment              (GET / POST)
//   * /shop/me/insurance              (GET / POST)
//   * /shop/me/orders/:id/loss-claim  (POST)
//   * /shop/me/form-acknowledgements  (GET / POST)
//   * /shop/me/chat                   (POST — SSE customer assistant)
//   * /shop/orders/mask-fit           (POST — public micro-survey)
//
// Everything here is fictional demo data for the CareMetric Demo DME
// sandbox tenant — no real PHI. Shapes mirror the live route
// handlers under artifacts/resupply-api/src/routes/shop/*. Reads return
// realistic fixtures; prominent mutations return a benign success so
// the UI advances. Dates are computed fresh via the shared date helpers
// so the demo never looks stale.
//
// Paths SKIPPED (already handled elsewhere): /shop/me profile, clinical-
// info, dashboard, comm-prefs, messages, therapy-summary, maintenance,
// insights, education-feed, substitutions, subscriptions, reorder-
// suggestions, orders, returns, documents, caregiver, reviews, billing-
// portal, quick-checkout (handlers/account.ts); products, checkout,
// back-in-stock, insurance-estimates/-leads, order summary (handlers/
// shop.ts). Binary/stream surfaces (me-export download, order-pod
// images) are intentionally not seeded.

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import { daysAgo, dateOnly } from "../fixtures/dates";

// ── /shop/me/cart-snapshot ────────────────────────────────────────────
// Server-side mirror of the signed-in cart. The demo customer's cart is
// empty server-side (their local cart drives the UI); writes succeed.
const cartSnapshotHandlers: DemoHandler[] = [
  route("GET", "/resupply-api/shop/me/cart-snapshot", () =>
    json({ items: [], subtotalCents: 0, currency: "usd", updatedAt: null }),
  ),
  route("PUT", "/resupply-api/shop/me/cart-snapshot", (req) => {
    const body =
      req.json<{ items?: unknown[]; subtotalCents?: number }>() ?? {};
    const items = Array.isArray(body.items) ? body.items : [];
    return json({
      ok: true,
      items,
      subtotalCents: body.subtotalCents ?? 0,
    });
  }),
  route("DELETE", "/resupply-api/shop/me/cart-snapshot", () =>
    json({ ok: true }),
  ),
];

// ── /shop/education-videos ────────────────────────────────────────────
// Public /learn/videos library, grouped by topic in canonical order.
// Mirrors groupActiveVideosByTopic()'s `{ groups: [{ topic, label,
// videos: [...] }] }` shape. Synthetic clips that link to the help docs.
const educationVideosHandlers: DemoHandler[] = [
  route("GET", "/resupply-api/shop/education-videos", () =>
    json({
      groups: [
        {
          topic: "getting_started",
          label: "Getting started",
          videos: [
            {
              id: "demo-vid-gs-1",
              title: "Your first night on CPAP",
              description:
                "What to expect, how to put your mask on, and a few tips for a comfortable start.",
              videoUrl: "https://www.youtube.com/watch?v=demo-first-night",
              thumbnailUrl: null,
              durationSeconds: 184,
            },
          ],
        },
        {
          topic: "mask_fitting",
          label: "Mask fitting",
          videos: [
            {
              id: "demo-vid-mf-1",
              title: "Fitting the AirFit N20 nasal mask",
              description:
                "Step-by-step seal check and headgear adjustment for the N20.",
              videoUrl: "https://www.youtube.com/watch?v=demo-n20-fit",
              thumbnailUrl: null,
              durationSeconds: 142,
            },
            {
              id: "demo-vid-mf-2",
              title: "Stopping mask leaks",
              description:
                "Quick adjustments that stop the hiss without overtightening.",
              videoUrl: "https://www.youtube.com/watch?v=demo-leaks",
              thumbnailUrl: null,
              durationSeconds: 121,
            },
          ],
        },
        {
          topic: "cleaning",
          label: "Cleaning & care",
          videos: [
            {
              id: "demo-vid-cl-1",
              title: "Your weekly cleaning routine",
              description:
                "A 5-minute routine that keeps your equipment fresh and your therapy effective.",
              videoUrl: "https://www.youtube.com/watch?v=demo-cleaning",
              thumbnailUrl: null,
              durationSeconds: 167,
            },
          ],
        },
      ],
    }),
  ),
];

// ── /shop/me/equipment ────────────────────────────────────────────────
// Patient self-service equipment registry. The demo patient is linked
// and has one device on file; POST registers a new one (201).
const equipmentHandlers: DemoHandler[] = [
  route("GET", "/resupply-api/shop/me/equipment", () =>
    json({
      patientLinked: true,
      assets: [
        {
          id: "demo-asset-1",
          deviceClass: "auto_cpap",
          manufacturer: "RESMED",
          model: "AirSense 11 AutoSet",
          serialNumber: "DEMO-22A1B2C3",
          status: "active",
          dispensedAt: dateOnly(-180),
          createdAt: daysAgo(180),
        },
      ],
    }),
  ),
  route("POST", "/resupply-api/shop/me/equipment", () =>
    json({ id: `demo-asset-${Date.now()}` }, 201),
  ),
];

// ── /shop/me/insurance ────────────────────────────────────────────────
// Patient-facing primary coverage view + self-update. The demo patient
// has a verified primary plan; a patient update returns created:false
// (the existing row was updated) and clears verification server-side.
const insuranceHandlers: DemoHandler[] = [
  route("GET", "/resupply-api/shop/me/insurance", () =>
    json({
      patientLinked: true,
      coverage: {
        id: "demo-coverage-1",
        rank: "primary",
        payerName: "Independence Blue Cross",
        planName: "Personal Choice PPO",
        memberId: "IBX-DEMO-884201",
        groupNumber: "GRP-77310",
        effectiveDate: dateOnly(-400),
        terminationDate: null,
        verifiedAt: daysAgo(20),
        updatedAt: daysAgo(20),
      },
    }),
  ),
  route("POST", "/resupply-api/shop/me/insurance", () =>
    json({ id: "demo-coverage-1", created: false }),
  ),
];

// ── /shop/me/orders/:orderId/loss-claim ───────────────────────────────
// Patient self-reports a paid+shipped order never arrived. Opens a
// claim row for the CSR queue (201). Mirrors the live route's `{ id }`.
const lossClaimHandlers: DemoHandler[] = [
  route("POST", "/resupply-api/shop/me/orders/:orderId/loss-claim", () =>
    json({ id: `demo-loss-claim-${Date.now()}` }, 201),
  ),
];

// ── /shop/me/form-acknowledgements ────────────────────────────────────
// Intake-form e-sign. Lists the form catalog with the patient's most
// recent acknowledgement per form so the UI can flag "needs re-sign".
// POST records an acknowledgement at the current version (201).
const FORM_ACK_FIXTURE = [
  {
    kind: "hipaa_npp",
    title: "Notice of Privacy Practices",
    body: "CareMetric Demo DME respects the privacy of your health information. This notice describes how your information may be used and disclosed and how you can access it. (Demo copy.)",
    currentVersion: "2026-01-01",
    lastSignedVersion: "2026-01-01",
    lastSignedAt: daysAgo(30),
    upToDate: true,
  },
  {
    kind: "aob",
    title: "Assignment of Benefits",
    body: "I authorize my insurance benefits to be paid directly to CareMetric Demo DME for equipment and supplies furnished to me. (Demo copy.)",
    currentVersion: "2026-01-01",
    lastSignedVersion: "2026-01-01",
    lastSignedAt: daysAgo(30),
    upToDate: true,
  },
  {
    kind: "abn",
    title: "Advance Beneficiary Notice",
    body: "This notice gives you information about items or services that Medicare may not pay for. (Demo copy.)",
    currentVersion: "2026-03-01",
    lastSignedVersion: null,
    lastSignedAt: null,
    upToDate: false,
  },
  {
    kind: "financial_responsibility",
    title: "Financial Responsibility Agreement",
    body: "I understand I am financially responsible for any amounts not covered by my insurance. (Demo copy.)",
    currentVersion: "2026-01-01",
    lastSignedVersion: "2026-01-01",
    lastSignedAt: daysAgo(30),
    upToDate: true,
  },
  {
    kind: "supplier_standards",
    title: "Medicare DMEPOS Supplier Standards",
    body: "CareMetric Demo DME meets the Medicare DMEPOS supplier standards. A copy is available on request. (Demo copy.)",
    currentVersion: "2026-01-01",
    lastSignedVersion: "2026-01-01",
    lastSignedAt: daysAgo(30),
    upToDate: true,
  },
];

const formAcknowledgementHandlers: DemoHandler[] = [
  route("GET", "/resupply-api/shop/me/form-acknowledgements", () =>
    json({ patientLinked: true, forms: FORM_ACK_FIXTURE }),
  ),
  route("POST", "/resupply-api/shop/me/form-acknowledgements", () =>
    json({ id: `demo-form-ack-${Date.now()}`, created: true }, 201),
  ),
];

// NOTE: POST /resupply-api/shop/me/chat (signed-in customer assistant) is
// already seeded by handlers/misc.ts, which registers earlier and wins the
// first-match router. Intentionally NOT duplicated here.

// ── /shop/orders/mask-fit ─────────────────────────────────────────────
// Public post-delivery mask-fit micro-survey capture. Token-bound in
// production; the demo just acknowledges any submission.
const maskFitHandlers: DemoHandler[] = [
  route("POST", "/resupply-api/shop/orders/mask-fit", () => json({ ok: true })),
];

export const ext11Handlers: DemoHandler[] = [
  ...cartSnapshotHandlers,
  ...educationVideosHandlers,
  ...equipmentHandlers,
  ...insuranceHandlers,
  ...lossClaimHandlers,
  ...formAcknowledgementHandlers,
  ...maskFitHandlers,
];
