// Extension wave 10 — remaining STOREFRONT (public + signed-in account)
// data reads not covered by handlers/shop.ts, account.ts, or misc.ts.
//
// Covers the host-resolved public identity surfaces (company info,
// storefront branding), the platform marketing pricing catalog, the
// anonymous marketing lead/sign-up forms, and the signed-in patient
// billing surfaces that live under /api/me/* but weren't seeded yet
// (claims explorer, payment-methods/autopay, statement delivery
// preference) plus the patient-portal sleep coach.
//
// All fixtures are inline + fictional. The sandbox tenant is CareMetric
// Demo DME (demo.example) — a stand-in, never a real customer's brand —
// on the CareMetric Breathe platform (cmbreathe.com). Money is in cents;
// phones are 555 numbers; dates are fresh via the date helpers. No real
// PHI.

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import {
  DEMO_ASSISTANT_ADMIN_NAME,
  DEMO_ASSISTANT_STOREFRONT_NAME,
  DEMO_BASE_URL,
  DEMO_GENERAL_EMAIL,
  DEMO_LEGAL_NAME,
  DEMO_LOGO_URL,
  DEMO_STOREFRONT_NAME,
  DEMO_SUPPORT_EMAIL,
  DEMO_TAGLINE,
} from "../brand";
import { daysAgo, dateOnly } from "../fixtures/dates";

export const ext10Handlers: DemoHandler[] = [
  // ── Public identity: company info (footer / "call us" / chat) ──────
  // GET /api/company-info (+ /api/storefront-company-info) — see
  // routes/storefront/company-info.ts.
  // The demo represents the CareMetric **platform** (an unconfigured
  // tenant), NOT the Penn tenant, so it must read the CareMetric platform
  // identity — including the platform-default assistant names
  // ("CareMetric Assistant" / "CareMetric Copilot"), so the storefront
  // chatbot and the admin assistant widget never flash "PennBot"/"PennPilot."
  // (Mirrors company-info.ts DEFAULTS + DEFAULT_*_ASSISTANT_NAME.)
  route("GET", "/api/company-info", () =>
    json({
      // Same operating company the storefront-branding endpoint names. These
      // two feed different surfaces — branding drives the header/footer,
      // company-info drives checkout, contact, order and provider pages — so
      // when they disagreed a demo visitor saw two different businesses
      // fulfilling one order.
      name: DEMO_STOREFRONT_NAME,
      legalName: DEMO_LEGAL_NAME,
      phoneE164: "+18005550100",
      phoneDisplay: "(800) 555-0100",
      supportEmail: DEMO_SUPPORT_EMAIL,
      generalEmail: DEMO_GENERAL_EMAIL,
      supportHours: "Mon–Fri 8am–7pm ET · Sat 9am–2pm ET",
      websiteUrl: DEMO_BASE_URL,
      address: {
        line1: "100 Innovation Way",
        line2: "Suite 200",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
      },
      assistantStorefrontName: DEMO_ASSISTANT_STOREFRONT_NAME,
      assistantAdminName: DEMO_ASSISTANT_ADMIN_NAME,
    }),
  ),
  route("GET", "/api/storefront-company-info", () =>
    json({
      name: DEMO_STOREFRONT_NAME,
      legalName: DEMO_LEGAL_NAME,
      phoneE164: "+18005550100",
      phoneDisplay: "(800) 555-0100",
      supportEmail: DEMO_SUPPORT_EMAIL,
      generalEmail: DEMO_GENERAL_EMAIL,
      supportHours: "Mon–Fri 8am–7pm ET · Sat 9am–2pm ET",
      websiteUrl: DEMO_BASE_URL,
      address: {
        line1: "100 Innovation Way",
        line2: "Suite 200",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
      },
      assistantStorefrontName: DEMO_ASSISTANT_STOREFRONT_NAME,
      assistantAdminName: DEMO_ASSISTANT_ADMIN_NAME,
    }),
  ),

  // ── Public identity: host-resolved storefront branding ────────────
  // GET /api/storefront-branding — see routes/storefront/storefront-branding.ts.
  // NOTE: this is shadowed by miscHandlers' earlier (first-match-wins)
  // /api/storefront-branding. Both read ../brand, so the two cannot
  // disagree if the ordering ever changes.
  route("GET", "/api/storefront-branding", () =>
    json({
      storefrontName: DEMO_STOREFRONT_NAME,
      legalName: DEMO_LEGAL_NAME,
      tagline: DEMO_TAGLINE,
      logoUrl: DEMO_LOGO_URL,
      resolved: true,
    }),
  ),

  // ── Platform marketing pricing catalog (cmbreathe.com) ────────────
  // GET /api/platform/pricing — see routes/storefront/platform-pricing.ts.
  // Public SaaS plan + add-on catalog for the Breathe marketing page.
  // Never exposes Stripe ids or tenant data.
  // ── Platform mask-catalog coverage (cmbreathe.com) ────────────────
  // GET /api/platform/mask-catalog — see
  // routes/storefront/platform-mask-catalog.ts. Aggregate-only coverage
  // stats for the /breathe/mask-fitting roster. Product facts, no tenant
  // data; these mirror the seeded platform catalog (migrations 0486 +
  // 0493 + 0494) so the sandbox shows the same shape production does.
  route("GET", "/api/platform/mask-catalog", () =>
    json({
      manufacturers: [
        { name: "ResMed", models: 25, currentModels: 20 },
        { name: "Philips Respironics", models: 17, currentModels: 16 },
        { name: "Fisher & Paykel", models: 13, currentModels: 10 },
        { name: "React Health", models: 8, currentModels: 8 },
        { name: "Rain8", models: 5, currentModels: 5 },
        { name: "Sleepnet", models: 5, currentModels: 5 },
        { name: "Circadiance", models: 4, currentModels: 4 },
        { name: "Inogen", models: 3, currentModels: 3 },
        { name: "Bleep Sleep", models: 2, currentModels: 2 },
        { name: "Hans Rudolph", models: 1, currentModels: 1 },
      ],
      interfaceTypes: [
        { type: "nasal", models: 32 },
        { type: "full_face", models: 28 },
        { type: "nasal_pillow", models: 18 },
        { type: "hybrid", models: 4 },
        { type: "total_face", models: 1 },
      ],
      totals: {
        manufacturers: 10,
        models: 83,
        currentModels: 74,
        discontinuedModels: 9,
        sizeVariants: 248,
        components: 244,
      },
      lastUpdatedAt: daysAgo(2),
    }),
  ),

  route("GET", "/api/platform/pricing", () =>
    json({
      plans: [
        {
          code: "launch",
          name: "Launch",
          description: "For practices getting started with digital resupply.",
          monthlyPriceCents: 49900,
          onboardingFeeCents: 0,
          isCustom: false,
          allowances: { activePatients: 1500, staffSeats: 5 },
          features: [
            "Storefront + resupply engine",
            "AI storefront chatbot",
            "Automated resupply reminders",
            "Email support",
          ],
          productScope: "full",
          perActivePatientCents: null,
          regularMonthlyPriceCents: null,
          founderRateLockedMonths: null,
        },
        {
          code: "scale",
          name: "Scale",
          description: "For growing DMEs that need automation across billing.",
          monthlyPriceCents: 99900,
          onboardingFeeCents: 0,
          isCustom: false,
          allowances: { activePatients: 6000, staffSeats: 20 },
          features: [
            "Everything in Launch",
            "AI claim scrubbing + denials worklist",
            "24/7 voice agent",
            "Therapy-cloud integrations",
            "Priority support",
          ],
          productScope: "full",
          perActivePatientCents: null,
          regularMonthlyPriceCents: 129900,
          founderRateLockedMonths: 12,
        },
        {
          code: "enterprise",
          name: "Enterprise",
          description: "Custom-built for multi-location DME networks.",
          monthlyPriceCents: null,
          onboardingFeeCents: null,
          isCustom: true,
          allowances: {},
          features: [
            "Everything in Scale",
            "Custom integration + migration plan",
            "Advanced security and account controls",
            "Dedicated success manager + priority SLA",
          ],
          productScope: "full",
          perActivePatientCents: null,
          regularMonthlyPriceCents: null,
          founderRateLockedMonths: null,
        },
      ],
      addons: [
        {
          code: "ai_overage",
          name: "AI interaction overage",
          category: "ai",
          description:
            "Keeps the assistants answering once you pass your plan's included interactions.",
          recurringPriceCents: null,
          oneTimeMinCents: null,
          oneTimeMaxCents: null,
          unitLabel: "per 1,000 interactions",
        },
        {
          code: "extra_seat",
          name: "Additional staff seat",
          category: "seats",
          description: "Add a teammate beyond your plan's included seats.",
          recurringPriceCents: 2900,
          oneTimeMinCents: null,
          oneTimeMaxCents: null,
          unitLabel: "per seat / month",
        },
      ],
    }),
  ),

  // ── Anonymous marketing lead capture (Breathe demo gate) ──────────
  // POST /api/demo-lead — see routes/storefront/demo-lead.ts.
  route("POST", "/api/demo-lead", () => json({ ok: true })),

  // ── Anonymous ROI estimate email capture ──────────────────────────
  // POST /api/roi-estimate — see routes/storefront/roi-estimate.ts.
  // The real route recomputes + best-effort emails; demo just confirms
  // capture without "sending".
  route("POST", "/api/roi-estimate", () => json({ ok: true, emailed: false })),

  // ── Anonymous self-serve tenant sign-up ───────────────────────────
  // POST /api/tenant-signup — see routes/storefront/tenant-signup.ts.
  // Benign success: returns the sign-in URL the marketing page links to.
  route("POST", "/api/tenant-signup", (req) => {
    const body = req.json<{ slug?: string }>() ?? {};
    const slug = body.slug ?? "demo-clinic";
    return json(
      {
        ok: true,
        slug,
        signInUrl: "/admin/sign-in",
      },
      201,
    );
  }),

  // ── Signed-in patient: claims explorer ────────────────────────────
  // GET /api/me/claims — see routes/storefront/me-claims.ts.
  route("GET", "/api/me/claims", () =>
    json({
      claims: [
        {
          id: "demo-claim-1",
          payerName: "Independence Blue Cross",
          dateOfService: dateOnly(-40),
          status: "partially_paid",
          totalBilledCents: 18900,
          totalPaidCents: 14650,
          patientResponsibilityCents: 4250,
          submittedAt: daysAgo(38),
          decisionAt: daysAgo(20),
          paidAt: daysAgo(18),
        },
        {
          id: "demo-claim-2",
          payerName: "Independence Blue Cross",
          dateOfService: dateOnly(-130),
          status: "paid",
          totalBilledCents: 13900,
          totalPaidCents: 13900,
          patientResponsibilityCents: 0,
          submittedAt: daysAgo(128),
          decisionAt: daysAgo(112),
          paidAt: daysAgo(110),
        },
      ],
    }),
  ),

  // GET /api/me/claims/:claimId — claim detail (lines + events).
  route("GET", "/api/me/claims/:claimId", (_req, { claimId }) =>
    json({
      claim: {
        id: claimId,
        payerName: "Independence Blue Cross",
        dateOfService: dateOnly(-40),
        status: "partially_paid",
        totalBilledCents: 18900,
        totalPaidCents: 14650,
        patientResponsibilityCents: 4250,
        submittedAt: daysAgo(38),
        decisionAt: daysAgo(20),
        paidAt: daysAgo(18),
        denialReason: null,
      },
      lineItems: [
        {
          hcpcsCode: "A7034",
          modifier: "NU",
          description: "Nasal CPAP mask interface",
          quantity: 1,
          billedCents: 13900,
          allowedCents: 11200,
          paidCents: 8960,
          status: "paid",
        },
        {
          hcpcsCode: "A7035",
          modifier: "NU",
          description: "CPAP headgear",
          quantity: 1,
          billedCents: 5000,
          allowedCents: 4100,
          paidCents: 3280,
          status: "paid",
        },
      ],
      events: [
        {
          eventType: "payer_payment",
          amountCents: 12240,
          payerRef: "EFT-DEMO-88210",
          note: "Primary payer remittance applied.",
          occurredAt: daysAgo(18),
        },
        {
          eventType: "patient_responsibility_set",
          amountCents: 4250,
          payerRef: null,
          note: "Coinsurance after deductible.",
          occurredAt: daysAgo(18),
        },
        {
          eventType: "submitted",
          amountCents: null,
          payerRef: "CLM-DEMO-44120",
          note: "Claim submitted to clearinghouse.",
          occurredAt: daysAgo(38),
        },
      ],
    }),
  ),

  // ── Signed-in patient: payment methods + autopay ──────────────────
  // GET /api/me/payment-methods — see routes/storefront/me-payment-methods.ts.
  route("GET", "/api/me/payment-methods", () =>
    json({
      hasCard: true,
      autopayEnabled: false,
      card: { brand: "visa", last4: "4242", expMonth: 8, expYear: 2029 },
      authorizedAt: daysAgo(60),
    }),
  ),
  // POST setup-session — benign Stripe-less success.
  route("POST", "/api/me/payment-methods/setup-session", () =>
    json({ url: "/account/billing?card_added=1" }, 201),
  ),
  // PATCH autopay toggle — echo the requested state.
  route("PATCH", "/api/me/payment-methods/autopay", (req) => {
    const body = req.json<{ enabled?: boolean }>() ?? {};
    return json({ ok: true, autopayEnabled: body.enabled ?? false });
  }),
  // DELETE saved card.
  route("DELETE", "/api/me/payment-methods", () => json({ ok: true })),

  // ── Signed-in patient: statement delivery preference ──────────────
  // GET/PUT /api/me/statement-preferences — see routes/storefront/me-billing.ts.
  route("GET", "/api/me/statement-preferences", () =>
    json({
      statementDeliveryMethod: "email",
      email: "alex.demo@demo.example",
      linked: true,
    }),
  ),
  route("PUT", "/api/me/statement-preferences", (req) => {
    const body =
      req.json<{ statementDeliveryMethod?: "email" | "mail" }>() ?? {};
    return json({
      statementDeliveryMethod: body.statementDeliveryMethod ?? "email",
      email: "alex.demo@demo.example",
    });
  }),

  // ── Signed-in patient: AI sleep coach ─────────────────────────────
  // POST /api/me/sleep-coach — see routes/storefront/sleep-coach.ts.
  route("POST", "/api/me/sleep-coach", () =>
    json({
      reply:
        "Great question! In your first few weeks, consistency matters more than perfection — even short nights count toward building the habit. Try putting your mask on a few minutes before lights-out while you read or watch TV, so it feels routine by the time you fall asleep. Your recent nights look strong, so keep it up. (You're exploring the CareMetric Breathe demo, so this is a sample answer.)",
      latencyMs: 640,
    }),
  ),
];
