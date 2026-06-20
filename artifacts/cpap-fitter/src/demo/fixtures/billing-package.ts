// Demo fixtures for the tenant billing package page (plan + add-on
// self-service). Mirrors the seeded platform-billing catalog (Launch /
// Growth / Scale / Enterprise plans + a handful of add-ons). The current
// plan and add-on quantities are held in module-level mutable state so a
// demo-mode user (or a Playwright test) sees their selection persist on
// the next GET /admin/billing/package — exactly like the real backend.

interface DemoPlan {
  code: string;
  name: string;
  description: string;
  monthlyPriceCents: number | null;
  onboardingFeeCents: number | null;
  isPublic: boolean;
  isCustom: boolean;
  allowances: Record<string, number>;
  features: string[];
  stripeProductId: string | null;
  stripePriceId: string | null;
  stripeSyncedAt: string | null;
}

interface DemoAddon {
  code: string;
  name: string;
  category: string;
  description: string;
  recurringPriceCents: number | null;
  oneTimeMinCents: number | null;
  oneTimeMaxCents: number | null;
  unitLabel: string | null;
  usageMetric: string | null;
  passThroughNote: string | null;
  stripeProductId: string | null;
  stripePriceId: string | null;
  stripeSyncedAt: string | null;
}

const PLANS: DemoPlan[] = [
  {
    code: "launch",
    name: "Launch",
    description:
      "Branded CPAP storefront and basic resupply automation for a small DME.",
    monthlyPriceCents: 79900,
    onboardingFeeCents: 250000,
    isPublic: true,
    isCustom: false,
    allowances: { seats: 5, activePatients: 500, locations: 1 },
    features: [
      "Branded CPAP storefront + mask fitter",
      "Online shop, cart, checkout, and order tracking",
      "Resupply reminders and subscription tracking",
    ],
    stripeProductId: null,
    stripePriceId: null,
    stripeSyncedAt: null,
  },
  {
    code: "growth",
    name: "Growth",
    description:
      "Full resupply operations, outreach, documents, therapy monitoring, and billing worklists.",
    monthlyPriceCents: 189900,
    onboardingFeeCents: 500000,
    isPublic: true,
    isCustom: false,
    allowances: { seats: 15, activePatients: 3000, locations: 3 },
    features: [
      "Everything in Launch",
      "Bulk campaigns, playbooks, and templates",
      "Eligibility, prior auth, CMN/DIF, and A/R worklists",
    ],
    stripeProductId: null,
    stripePriceId: null,
    stripeSyncedAt: null,
  },
  {
    code: "scale",
    name: "Scale",
    description:
      "Multi-location automation, analytics, AI controls, and higher-volume operations.",
    monthlyPriceCents: 399900,
    onboardingFeeCents: 1000000,
    isPublic: true,
    isCustom: false,
    allowances: { seats: 40, activePatients: 10000, locations: 10 },
    features: [
      "Everything in Growth",
      "Multi-location workflows",
      "Advanced analytics and KPI alerts",
    ],
    stripeProductId: null,
    stripePriceId: null,
    stripeSyncedAt: null,
  },
  {
    code: "enterprise",
    name: "Enterprise",
    description:
      "Custom package for high-volume DME operations, migration, integrations, and contracted support.",
    monthlyPriceCents: 750000,
    onboardingFeeCents: null,
    isPublic: false,
    isCustom: true,
    allowances: {},
    features: [
      "Everything in Scale",
      "Custom integration and migration plan",
      "Dedicated success manager and priority support SLA",
    ],
    stripeProductId: null,
    stripePriceId: null,
    stripeSyncedAt: null,
  },
];

const ADDONS: DemoAddon[] = [
  {
    code: "additional_seat",
    name: "Additional staff seat",
    category: "capacity",
    description: "Extra admin/staff user beyond the plan allowance.",
    recurringPriceCents: 4900,
    oneTimeMinCents: null,
    oneTimeMaxCents: null,
    unitLabel: "user/month",
    usageMetric: "seats",
    passThroughNote: null,
    stripeProductId: null,
    stripePriceId: null,
    stripeSyncedAt: null,
  },
  {
    code: "message_bundle",
    name: "Extra SMS/email message bundle",
    category: "usage",
    description: "Adds 1,000 outbound SMS/email messages.",
    recurringPriceCents: 5000,
    oneTimeMinCents: null,
    oneTimeMaxCents: null,
    unitLabel: "1,000 messages",
    usageMetric: "outboundMessagesPerMonth",
    passThroughNote:
      "Carrier fees and unusually high MMS/voice costs may pass through.",
    stripeProductId: null,
    stripePriceId: null,
    stripeSyncedAt: null,
  },
  {
    code: "ai_voice_agent",
    name: "AI voice agent / IVR",
    category: "premium",
    description: "AI voice agent and IVR automation.",
    recurringPriceCents: 49900,
    oneTimeMinCents: null,
    oneTimeMaxCents: null,
    unitLabel: "month",
    usageMetric: "aiVoiceEvents",
    passThroughNote: "Usage billed separately.",
    stripeProductId: null,
    stripePriceId: null,
    stripeSyncedAt: null,
  },
  {
    code: "data_migration",
    name: "Data migration package",
    category: "one_time",
    description:
      "One-time migration package. Price depends on source system and data quality.",
    recurringPriceCents: null,
    oneTimeMinCents: 250000,
    oneTimeMaxCents: 1500000,
    unitLabel: "project",
    usageMetric: null,
    passThroughNote: null,
    stripeProductId: null,
    stripePriceId: null,
    stripeSyncedAt: null,
  },
];

// ── mutable demo state ──────────────────────────────────────────────
let currentPlanCode = "launch";
const currentAddonQty = new Map<string, number>();

function planByCode(code: string): DemoPlan {
  return PLANS.find((p) => p.code === code) ?? PLANS[0];
}

function buildTenantBilling() {
  const plan = planByCode(currentPlanCode);
  const addons = [...currentAddonQty.entries()]
    .filter(([, qty]) => qty > 0)
    .map(([code, quantity]) => {
      const addon = ADDONS.find((a) => a.code === code) ?? ADDONS[0];
      return {
        id: `demo-addon-${code}`,
        quantity,
        customRecurringPriceCents: null,
        notes: "",
        addon,
      };
    });
  return {
    tenantId: "demo-tenant-1",
    subscription: {
      id: "demo-sub-1",
      status: "active",
      effectiveAt: new Date().toISOString(),
      customMonthlyPriceCents: null,
      customOnboardingFeeCents: null,
      customAllowances: {},
      notes: "",
      stripeCustomerId: "cus_demo",
      stripeSubscriptionId: "sub_demo",
      stripeStatus: "active",
      stripeLastSyncedAt: new Date().toISOString(),
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      lastInvoiceId: "in_demo",
      lastInvoiceStatus: "paid",
      plan,
    },
    addons,
    usage: {
      month: new Date().toISOString().slice(0, 7),
      metrics: {
        seats: 4,
        activePatients: 312,
        locations: 1,
        ordersPerMonth: 96,
        activeSubscriptions: 180,
        outboundMessagesPerMonth: 740,
        aiTextInteractionsPerMonth: 410,
        billingTransactionsPerMonth: 0,
        faxEvents: 0,
        aiVoiceEvents: 0,
      },
    },
  };
}

/** GET /admin/billing/package */
export function demoTenantBilling() {
  return buildTenantBilling();
}

/** GET /admin/billing/plans — public plans + custom (contact-us) tiers. */
export function demoSelectablePlans() {
  return { plans: PLANS.filter((p) => p.isPublic || p.isCustom) };
}

/** GET /admin/billing/addons */
export function demoSelectableAddons() {
  return { addons: ADDONS };
}

/** POST /admin/billing/subscription — records the chosen plan. */
export function demoSelectPlan(planCode: string | undefined) {
  const plan = PLANS.find(
    (p) => p.code === planCode && p.isPublic && !p.isCustom,
  );
  if (plan) currentPlanCode = plan.code;
  return buildTenantBilling();
}

/** PUT /admin/billing/addons — sets a recurring add-on's quantity. */
export function demoUpdateAddon(
  addonCode: string | undefined,
  quantity: number | undefined,
) {
  const addon = ADDONS.find(
    (a) => a.code === addonCode && a.recurringPriceCents != null,
  );
  if (addon) {
    const qty = Math.max(0, Math.trunc(quantity ?? 0));
    if (qty === 0) currentAddonQty.delete(addon.code);
    else currentAddonQty.set(addon.code, qty);
  }
  return buildTenantBilling();
}
