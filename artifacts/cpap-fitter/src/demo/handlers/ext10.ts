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
// All fixtures are inline + fictional. The storefront tenant is Penn
// Home Medical Supply (storefront brand "PennPaps", pennpaps.com,
// info@pennpaps.com); the platform/parent product is CareMetric Breathe
// (cmbreathe.com). Money is in cents; phones are 555 numbers; dates are
// fresh via the date helpers. No real PHI.

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import { daysAgo, dateOnly } from "../fixtures/dates";

export const ext10Handlers: DemoHandler[] = [
  // ── Public identity: company info (footer / "call us" / chat) ──────
  // GET /api/company-info — see routes/storefront/company-info.ts.
  // Tenant-branded to Penn Home Medical Supply / PennPaps.
  route("GET", "/api/company-info", () =>
    json({
      name: "PennPaps",
      legalName: "Penn Home Medical Supply",
      phoneE164: "+12155550123",
      phoneDisplay: "(215) 555-0123",
      supportEmail: "support@pennpaps.com",
      generalEmail: "info@pennpaps.com",
      supportHours: "Mon–Fri 8am–7pm ET · Sat 9am–2pm ET",
      websiteUrl: "https://pennpaps.com",
      address: {
        line1: "2400 Chestnut Street",
        line2: "Suite 110",
        city: "Philadelphia",
        state: "PA",
        postalCode: "19103",
        country: "US",
      },
      assistantStorefrontName: "PennBot",
      assistantAdminName: "PennPilot",
    }),
  ),

  // ── Public identity: host-resolved storefront branding ────────────
  // GET /api/storefront-branding — see routes/storefront/storefront-branding.ts.
  route("GET", "/api/storefront-branding", () =>
    json({
      storefrontName: "PennPaps",
      legalName: "Penn Home Medical Supply",
      tagline: "Your CPAP, made simple. Fit. Shop. Resupply.",
      logoUrl: null,
      resolved: true,
    }),
  ),

  // ── Platform marketing pricing catalog (cmbreathe.com) ────────────
  // GET /api/platform/pricing — see routes/storefront/platform-pricing.ts.
  // Public SaaS plan + add-on catalog for the Breathe marketing page.
  // Never exposes Stripe ids or tenant data.
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
      email: "alex.demo@pennpaps.example",
      linked: true,
    }),
  ),
  route("PUT", "/api/me/statement-preferences", (req) => {
    const body =
      req.json<{ statementDeliveryMethod?: "email" | "mail" }>() ?? {};
    return json({
      statementDeliveryMethod: body.statementDeliveryMethod ?? "email",
      email: "alex.demo@pennpaps.example",
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
