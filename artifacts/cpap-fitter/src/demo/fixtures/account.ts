// Seed data for the signed-in customer account surface. Shapes mirror
// src/lib/account-api.ts and src/lib/me-billing-api.ts.

import type {
  CommunicationPreferences,
  ShopClinicalInfoResponse,
  ShopMeDashboardResponse,
  ShopMeProfile,
  ShopMeResponse,
  MaintenanceSummary,
  TherapySummary,
  CustomerInsight,
  ShopSubscriptionsResponse,
  ReorderSuggestion,
} from "@/lib/account-api";
import type {
  BillingBalanceResponse,
  PatientStatementsResponse,
  PatientPaymentsResponse,
  PersonalEstimateResponse,
} from "@/lib/me-billing-api";
import { daysAgo, daysFromNow, dateOnly } from "./dates";

export const DEMO_CUSTOMER = {
  id: "demo-customer-1",
  email: "alex.demo@pennfit.example",
  displayName: "Alex Demo",
  role: "customer" as const,
  emailVerified: true,
  mustChangePassword: false,
};

export function demoProfile(): ShopMeProfile {
  return {
    customerId: DEMO_CUSTOMER.id,
    email: DEMO_CUSTOMER.email,
    displayName: DEMO_CUSTOMER.displayName,
    shippingAddress: {
      line1: "1200 Market Street",
      line2: "Apt 4B",
      city: "Philadelphia",
      state: "PA",
      postalCode: "19107",
      country: "US",
    },
    cpapDevice: {
      manufacturer: "ResMed",
      model: "AirSense 11 AutoSet",
      serialNumber: "DEMO-22A1B2C3",
      pressureSetting: "Auto 7–15 cmH2O",
      humidifierSetting: "Climate Control Auto",
      notes: null,
    },
    physicianInfo: {
      name: "Dr. Priya Nair, MD",
      practice: "Penn Sleep Center",
      phone: "(215) 555-0148",
      fax: "(215) 555-0149",
      email: null,
      addressLine1: "3624 Market St",
      addressLine2: null,
      city: "Philadelphia",
      state: "PA",
      postalCode: "19104",
      npi: "1538291746",
    },
  };
}

export function demoMeResponse(profile: ShopMeProfile): ShopMeResponse {
  return {
    signedIn: true,
    profile,
    savedCard: {
      brand: "visa",
      last4: "4242",
      expMonth: 8,
      expYear: 2029,
    },
    recentOrders: [
      {
        id: "demo-order-1",
        sessionId: "demo_sess_1001",
        status: "paid",
        amountTotalCents: 8900,
        currency: "usd",
        createdAt: daysAgo(12),
      },
      {
        id: "demo-order-2",
        sessionId: "demo_sess_1002",
        status: "paid",
        amountTotalCents: 2999,
        currency: "usd",
        createdAt: daysAgo(74),
      },
    ],
  };
}

export function demoClinicalInfo(): ShopClinicalInfoResponse {
  const p = demoProfile();
  return {
    cpapDevice: p.cpapDevice,
    physicianInfo: p.physicianInfo,
    facialMeasurements: {
      noseWidth: 36.2,
      noseHeight: 48.5,
      noseToChin: 118.4,
      mouthWidth: 51.0,
      faceWidthAtCheekbones: 139.7,
      calibrationMethod: "iris",
      capturedAt: daysAgo(12),
    },
  };
}

export function demoDashboard(): ShopMeDashboardResponse {
  return {
    nextShipment: {
      subscriptionId: "demo-sub-1",
      date: daysFromNow(18),
      daysUntil: 18,
      firstItemName: "AirFit N20 Nasal Cushion",
      cancelAtPeriodEnd: false,
    },
    eligibility: {
      eligibleNow: [],
      soonest: { firstItemName: "AirFit N20 Nasal Cushion", daysUntil: 18 },
    },
    latestOrder: {
      id: "demo-order-1",
      sessionId: "demo_sess_1001",
      paidAt: daysAgo(12),
      shippedAt: daysAgo(10),
      deliveredAt: daysAgo(8),
      trackingCarrier: "UPS",
      trackingNumber: "1Z999AA10123456784",
    },
    activeSubscriptions: 1,
    pendingOrders: 0,
    abandonedCart: null,
  };
}

export function demoCommPrefs(): CommunicationPreferences {
  return {
    emailMarketing: true,
    emailResupplyReminders: true,
    emailAbandonedCart: true,
    emailReviewRequests: true,
    emailInAppReplyNotifications: true,
    smsMarketing: false,
    smsTransactional: true,
    preferredChannel: "email",
    dndStartHour: 21,
    dndEndHour: 7,
    timezone: "America/New_York",
  };
}

export function demoTherapySummary(): TherapySummary {
  const nights = Array.from({ length: 30 }, (_, i) => {
    const usage = 6 + Math.sin(i / 3) * 1.4;
    return {
      date: dateOnly(-(30 - i)),
      usageHours: Math.max(0, Math.round(usage * 10) / 10),
      ahi: Math.round((2 + Math.cos(i / 4) * 1.3) * 10) / 10,
      leakLMin: Math.round((8 + Math.sin(i / 5) * 4) * 10) / 10,
      pressureP95Cmh2o: Math.round((11 + Math.sin(i / 6)) * 10) / 10,
      source: "demo",
    };
  });
  const withData = nights.filter((n) => (n.usageHours ?? 0) > 0);
  const compliant = withData.filter((n) => (n.usageHours ?? 0) >= 4);
  const avg = (xs: number[]) =>
    xs.length
      ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10
      : null;
  return {
    hasData: true,
    patientLinked: true,
    windowNights: 30,
    nightsWithData: withData.length,
    windowStartDate: dateOnly(-30),
    windowEndDate: dateOnly(0),
    avgUsageHours: avg(withData.map((n) => n.usageHours ?? 0)),
    avgAhi: avg(withData.map((n) => n.ahi ?? 0)),
    avgLeakLMin: avg(withData.map((n) => n.leakLMin ?? 0)),
    compliantNights: compliant.length,
    complianceRate:
      Math.round((compliant.length / withData.length) * 100) / 100,
    nights,
  };
}

export function demoMaintenance(): MaintenanceSummary {
  return {
    patientLinked: true,
    asOfDate: dateOnly(0),
    tasks: [
      {
        key: "wipe_mask",
        label: "Wipe down your mask cushion",
        category: "mask",
        frequencyDays: 1,
        why: "A daily wipe removes facial oils so the cushion seals well and lasts longer.",
        lastCompletedAt: daysAgo(2),
        nextDueDate: dateOnly(-1),
        bucket: "due_now",
        daysUntilDue: -1,
      },
      {
        key: "wash_hose",
        label: "Wash your hose & humidifier chamber",
        category: "tubing",
        frequencyDays: 7,
        why: "Weekly washing prevents buildup and keeps the air you breathe clean.",
        lastCompletedAt: daysAgo(4),
        nextDueDate: dateOnly(3),
        bucket: "due_soon",
        daysUntilDue: 3,
      },
      {
        key: "replace_filter",
        label: "Replace your disposable filter",
        category: "filter",
        frequencyDays: 30,
        why: "A fresh filter keeps dust and allergens out of your airflow.",
        lastCompletedAt: daysAgo(20),
        nextDueDate: dateOnly(10),
        bucket: "current",
        daysUntilDue: 10,
      },
    ],
  };
}

export function demoInsights(): CustomerInsight[] {
  return [
    {
      id: "demo-insight-1",
      kind: "cushion_wear",
      detectedAt: daysAgo(1),
      windowStartDate: dateOnly(-14),
      windowEndDate: dateOnly(0),
      notified: false,
      headline: "Time to refresh your cushion 🌬️",
      body: "Your nasal cushion is about 30 days old — replacing it now keeps the seal tight and your therapy comfortable.",
      cta: { label: "Reorder cushion", url: "/shop" },
    },
  ];
}

export function demoSubscriptions(): ShopSubscriptionsResponse {
  return {
    subscriptions: [
      {
        id: "demo-sub-1",
        stripeSubscriptionId: "sub_demo_1",
        status: "active",
        items: [
          {
            priceId: "demo_price_2999_sub",
            productId: "demo-prod-n20-cushion",
            quantity: 1,
            name: "AirFit N20 Nasal Cushion",
            unitAmountCents: 2999,
            currency: "usd",
            intervalLabel: "3 months",
          },
        ],
        currentPeriodEnd: daysFromNow(18),
        cancelAtPeriodEnd: false,
        canceledAt: null,
        createdAt: daysAgo(74),
      },
    ],
  };
}

export function demoReorderSuggestions(): {
  suggestions: ReorderSuggestion[];
  previewMode?: boolean;
} {
  return {
    suggestions: [
      {
        productId: "demo-prod-filter-disposable",
        productName: "Disposable Filters (6-pack)",
        category: "filter",
        imageUrl: "/products/filter-disposable.png",
        cadenceDays: 30,
        lastPaidAt: daysAgo(34),
        ageDays: 34,
        dueOn: dateOnly(-4),
        status: "overdue",
        totalQuantityHistorical: 3,
      },
      {
        productId: "demo-prod-p10-pillows",
        productName: "AirFit P10 Nasal Pillows",
        category: "cushion",
        imageUrl: "/products/cushion-p10.jpg",
        cadenceDays: 14,
        lastPaidAt: daysAgo(11),
        ageDays: 11,
        dueOn: dateOnly(3),
        status: "due_soon",
        totalQuantityHistorical: 6,
      },
    ],
  };
}

export function demoBillingBalance(): BillingBalanceResponse {
  return {
    totalOpenCents: 4250,
    claimCount: 1,
    claims: [
      {
        id: "demo-claim-1",
        payerName: "Independence Blue Cross",
        dateOfService: dateOnly(-40),
        patientResponsibilityCents: 4250,
      },
    ],
  };
}

export function demoBillingStatements(): PatientStatementsResponse {
  return {
    statements: [
      {
        id: "demo-stmt-1",
        totalPatientResponsibilityCents: 4250,
        lineItemCount: 1,
        deliveryMethod: "email",
        deliveredAt: daysAgo(15),
        createdAt: daysAgo(15),
      },
    ],
  };
}

export function demoPayments(): PatientPaymentsResponse {
  return {
    payments: [
      {
        id: "demo-pay-1",
        amount_cents: 2999,
        currency: "usd",
        status: "succeeded",
        applied_claims_json: [],
        note: "Auto-ship resupply",
        failure_reason: null,
        succeeded_at: daysAgo(74),
        created_at: daysAgo(74),
      },
    ],
  };
}

export function demoInsuranceEstimate(): PersonalEstimateResponse {
  return {
    available: true,
    payerName: "Independence Blue Cross",
    isActive: true,
    inNetwork: true,
    deductibleCents: 150000,
    deductibleMetCents: 92000,
    oopMaxCents: 400000,
    oopMetCents: 110000,
    copayCents: null,
    coinsurancePct: 20,
    requiresPriorAuth: false,
    asOf: daysAgo(3),
  };
}
