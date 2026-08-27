// Demo handlers for the admin ANALYTICS pages. In demo mode the fetch
// interceptor answers same-origin API calls from in-browser fixtures; an
// unmatched GET falls back to an empty `{}`, which makes these owner /
// analytics dashboards read nested keys (overall.marginRatio,
// byChannel[].ltvToCacRatio, counters.activeNow, …) off undefined and
// render empty states or crash. These handlers return fully-shaped,
// internally-consistent sample data so each page shows realistic numbers.
//
// Every shape here is matched against the live route's res.json({...}) under
// artifacts/resupply-api/src/routes/admin/* (and the pure aggregators in
// src/lib/analytics + lib/resupply-domain). Fictional demo data only — no
// real PHI; obviously-fake names; platform brand "CareMetric Breathe", with
// CareMetric Demo DME as the storefront tenant.

import { json } from "../respond";
import { route, type DemoHandler } from "../types";
import { daysAgo, dateOnly, NOW_ISO } from "../fixtures/dates";

function intParam(
  req: { query: URLSearchParams },
  key: string,
  fallback: number,
): number {
  const raw = req.query.get(key);
  const n = raw == null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Round a ratio to 4 dp the way the live aggregators do.
function r4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// ── /admin/analytics/margin ─────────────────────────────────────────────
// MarginAggregate (lib/resupply-domain/src/margin.ts) for overall + per
// product, plus windowDays + generatedAt + a productName per product.
interface MarginAggregate {
  lineCount: number;
  revenueCents: number;
  costedRevenueCents: number;
  uncostedRevenueCents: number;
  costCents: number;
  marginCents: number;
  marginRatio: number | null;
  linesWithKnownCost: number;
  linesWithUnknownCost: number;
  lossLineCount: number;
  negativeMarginRevenueCents: number;
}

function marginAgg(
  revenueCents: number,
  costCents: number,
  lines: number,
  uncostedRevenueCents = 0,
  lossLineCount = 0,
  negativeMarginRevenueCents = 0,
): MarginAggregate {
  const costedRevenueCents = revenueCents - uncostedRevenueCents;
  const marginCents = costedRevenueCents - costCents;
  const linesWithUnknownCost = uncostedRevenueCents > 0 ? 1 : 0;
  return {
    lineCount: lines,
    revenueCents,
    costedRevenueCents,
    uncostedRevenueCents,
    costCents,
    marginCents,
    marginRatio:
      costedRevenueCents > 0 ? r4(marginCents / costedRevenueCents) : null,
    linesWithKnownCost: lines - linesWithUnknownCost,
    linesWithUnknownCost,
    lossLineCount,
    negativeMarginRevenueCents,
  };
}

interface ProductMargin extends MarginAggregate {
  productId: string;
  productName: string | null;
}

function demoMargin(days: number) {
  const byProduct: ProductMargin[] = [
    {
      productId: "prod_demo_mask_n30i",
      productName: "AirFit N30i Nasal Mask",
      ...marginAgg(412_000, 233_000, 88),
    },
    {
      productId: "prod_demo_cushion_n30i",
      productName: "N30i Nasal Cushion (replacement)",
      ...marginAgg(286_500, 121_400, 191),
    },
    {
      productId: "prod_demo_filter_pack",
      productName: "Disposable Filter 6-Pack",
      ...marginAgg(94_700, 38_900, 173),
    },
    {
      productId: "prod_demo_tubing_heated",
      productName: "ClimateLineAir Heated Tubing",
      ...marginAgg(168_000, 142_000, 56, 0, 4, 24_000),
    },
    {
      productId: "prod_demo_water_chamber",
      productName: "Standard Water Chamber",
      // Uncosted blind-spot: no recorded COGS for this SKU.
      ...marginAgg(61_200, 0, 51, 61_200),
    },
  ];
  const overall = marginAgg(
    byProduct.reduce((s, p) => s + p.revenueCents, 0),
    byProduct.reduce((s, p) => s + p.costCents, 0),
    byProduct.reduce((s, p) => s + p.lineCount, 0),
    byProduct.reduce((s, p) => s + p.uncostedRevenueCents, 0),
    4,
    24_000,
  );
  return {
    windowDays: days,
    overall,
    byProduct,
    generatedAt: NOW_ISO(),
  };
}

// ── /admin/analytics/channel-engagement ─────────────────────────────────
function demoChannelEngagement(days: number) {
  const messaging = [
    {
      channel: "sms" as const,
      label: "SMS",
      conversations: 214,
      outbound: 689,
      inbound: 271,
      replyRate: r4(271 / 689),
      delivered: 662,
      failed: 14,
      deliveryRate: r4(662 / (662 + 14)),
    },
    {
      channel: "email" as const,
      label: "Email",
      conversations: 158,
      outbound: 503,
      inbound: 142,
      replyRate: r4(142 / 503),
      delivered: 488,
      failed: 9,
      deliveryRate: r4(488 / (488 + 9)),
    },
    {
      channel: "chat" as const,
      label: "Chat",
      conversations: 96,
      outbound: 318,
      inbound: 188,
      replyRate: r4(188 / 318),
      delivered: 0,
      failed: 0,
      deliveryRate: null,
    },
  ];
  const voice = {
    totalCalls: 142,
    inboundCalls: 58,
    outboundCalls: 84,
    answeredCalls: 119,
    answerRate: r4(119 / 142),
    missedCalls: 23,
    avgDurationSeconds: 184,
    byStatus: { completed: 119, "no-answer": 14, busy: 5, failed: 4 },
  };
  const messagingOutbound = messaging.reduce((s, c) => s + c.outbound, 0);
  const messagingInbound = messaging.reduce((s, c) => s + c.inbound, 0);
  const totalOutbound = messagingOutbound + voice.outboundCalls;
  const totalInbound = messagingInbound + voice.inboundCalls;
  const totalReplies = messagingInbound + voice.answeredCalls;
  return {
    windowDays: days,
    messaging,
    voice,
    outcomes: { purchases: 187, purchaseRevenueCents: 2_414_900 },
    summary: {
      totalOutbound,
      totalInbound,
      totalReplies,
      overallEngagementRate: r4(totalReplies / totalOutbound),
    },
  };
}

// ── /admin/analytics/revenue-by-source ──────────────────────────────────
function demoRevenueBySource(days: number) {
  const bySource = [
    {
      source: "storefront" as const,
      label: "Storefront (historical)",
      orders: 241,
      units: null,
      paidOrders: 187,
      cashRevenueCents: 2_414_900,
      payerPaidCents: null,
    },
    {
      source: "resupply_fulfillment" as const,
      label: "Resupply (insurance)",
      orders: 396,
      units: 712,
      paidOrders: null,
      cashRevenueCents: null,
      payerPaidCents: 8_920_000,
    },
    {
      source: "clinical_form" as const,
      label: "Clinical intake form",
      orders: 64,
      units: null,
      paidOrders: null,
      cashRevenueCents: null,
      payerPaidCents: null,
    },
  ];
  return {
    windowDays: days,
    bySource,
    totalOrders: bySource.reduce((s, b) => s + b.orders, 0),
    totalCashRevenueCents: 2_414_900,
    totalPayerPaidCents: 8_920_000,
  };
}

// ── /admin/analytics/outreach-attribution ───────────────────────────────
function demoOutreachAttribution(days: number, windowDays: number) {
  const reminder = { contacted: 318, converted: 142 };
  const clinical = { contacted: 96, converted: 33 };
  const overall = { contacted: 372, converted: 168 };
  const bucket = (
    source: "resupply_reminder" | "clinical_outreach" | "overall",
    label: string,
    c: { contacted: number; converted: number },
  ) => ({
    source,
    label,
    contactedPatients: c.contacted,
    convertedPatients: c.converted,
    conversionRate: c.contacted === 0 ? null : c.converted / c.contacted,
  });
  return {
    windowDays: days,
    attributionWindowDays: windowDays,
    bySource: [
      bucket("resupply_reminder", "Resupply reminders", reminder),
      bucket("clinical_outreach", "Clinical outreach", clinical),
    ],
    overall: bucket("overall", "All outreach (de-duped)", overall),
  };
}

// ── /admin/analytics/ltv-cac ────────────────────────────────────────────
interface ChannelEconomics {
  channel: string;
  customerCount: number;
  totalRevenueCents: number;
  avgLtvCents: number;
  customersWithCost: number;
  knownAcquisitionCostCents: number;
  avgCacCents: number | null;
  ltvToCacRatio: number | null;
  avgGrossMarginLtvCents: number | null;
  cacPaybackMonths: number | null;
}

function channelEcon(
  channel: string,
  customerCount: number,
  totalRevenueCents: number,
  customersWithCost: number,
  knownAcquisitionCostCents: number,
): ChannelEconomics {
  const avgLtvCents = Math.round(totalRevenueCents / customerCount);
  const avgCacCents =
    customersWithCost > 0
      ? Math.round(knownAcquisitionCostCents / customersWithCost)
      : null;
  const ltvToCacRatio =
    customersWithCost > 0 && knownAcquisitionCostCents > 0
      ? totalRevenueCents /
        customerCount /
        (knownAcquisitionCostCents / customersWithCost)
      : null;
  return {
    channel,
    customerCount,
    totalRevenueCents,
    avgLtvCents,
    customersWithCost,
    knownAcquisitionCostCents,
    avgCacCents,
    ltvToCacRatio,
    avgGrossMarginLtvCents: null,
    cacPaybackMonths: null,
  };
}

function demoLtvCac() {
  const byChannel = [
    channelEcon("organic", 412, 18_640_000, 0, 0),
    channelEcon("paid_search", 286, 11_880_000, 286, 4_290_000),
    channelEcon("referral", 174, 9_120_000, 121, 605_000),
    channelEcon("fitter", 138, 6_210_000, 138, 1_104_000),
    channelEcon("insurance_lead", 96, 3_840_000, 71, 1_065_000),
    channelEcon("paid_social", 88, 2_640_000, 88, 1_584_000),
    channelEcon("unattributed", 57, 1_710_000, 0, 0),
  ].sort((a, b) => b.totalRevenueCents - a.totalRevenueCents);

  const customerCount = byChannel.reduce((s, c) => s + c.customerCount, 0);
  const totalRevenueCents = byChannel.reduce(
    (s, c) => s + c.totalRevenueCents,
    0,
  );
  const customersWithCost = byChannel.reduce(
    (s, c) => s + c.customersWithCost,
    0,
  );
  const knownAcquisitionCostCents = byChannel.reduce(
    (s, c) => s + c.knownAcquisitionCostCents,
    0,
  );
  const avgCacCents =
    customersWithCost > 0
      ? Math.round(knownAcquisitionCostCents / customersWithCost)
      : null;
  const ltvToCacRatio =
    customersWithCost > 0 && knownAcquisitionCostCents > 0
      ? totalRevenueCents /
        customerCount /
        (knownAcquisitionCostCents / customersWithCost)
      : null;
  return {
    byChannel,
    totals: {
      customerCount,
      totalRevenueCents,
      avgLtvCents: Math.round(totalRevenueCents / customerCount),
      customersWithCost,
      knownAcquisitionCostCents,
      avgCacCents,
      ltvToCacRatio,
      avgGrossMarginLtvCents: null,
      cacPaybackMonths: null,
    },
    generatedAt: NOW_ISO(),
  };
}

// ── /admin/analytics/acquisition-funnel ─────────────────────────────────
interface FunnelStage {
  step: string;
  label: string;
  sessions: number;
  events: number;
  conversionFromPrev: number | null;
  conversionFromTop: number | null;
}

function buildFunnel(
  defs: ReadonlyArray<{ step: string; label: string; sessions: number }>,
): {
  stages: FunnelStage[];
  topSessions: number;
  overallConversion: number | null;
} {
  const top = defs[0]?.sessions ?? 0;
  let prev: number | null = null;
  const stages: FunnelStage[] = defs.map((d) => {
    const stage: FunnelStage = {
      step: d.step,
      label: d.label,
      sessions: d.sessions,
      events: Math.round(d.sessions * 1.3),
      conversionFromPrev: prev != null && prev > 0 ? d.sessions / prev : null,
      conversionFromTop: top > 0 ? d.sessions / top : null,
    };
    prev = d.sessions;
    return stage;
  });
  const last = stages[stages.length - 1];
  return {
    stages,
    topSessions: top,
    overallConversion: top > 0 && last ? last.sessions / top : null,
  };
}

function demoAcquisitionFunnel(days: number) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  return {
    window: { from: from.toISOString(), to: to.toISOString(), days },
    fitter: buildFunnel([
      { step: "home_view", label: "Home view", sessions: 1840 },
      { step: "consent_given", label: "Consent given", sessions: 1102 },
      { step: "capture_taken", label: "Photo captured", sessions: 934 },
      {
        step: "measurements_extracted",
        label: "Measurements extracted",
        sessions: 871,
      },
      {
        step: "questionnaire_completed",
        label: "Questionnaire completed",
        sessions: 798,
      },
      { step: "results_viewed", label: "Results viewed", sessions: 742 },
      { step: "mask_chosen", label: "Mask chosen", sessions: 511 },
      { step: "order_started", label: "Order started", sessions: 389 },
      {
        step: "order_submitted_success",
        label: "Order submitted",
        sessions: 264,
      },
    ]),
    checkout: buildFunnel([
      { step: "checkout_started", label: "Checkout started", sessions: 612 },
      {
        step: "checkout_step_viewed",
        label: "Checkout step viewed",
        sessions: 548,
      },
      {
        step: "checkout_completed",
        label: "Checkout completed",
        sessions: 421,
      },
    ]),
    signals: [
      { step: "measurement_error", label: "Measurement errors", events: 47 },
      { step: "capture_blocked", label: "Camera blocked", events: 88 },
      {
        step: "results_retake_requested",
        label: "Retake requested",
        events: 122,
      },
      { step: "cart_items_dropped", label: "Cart items dropped", events: 63 },
      { step: "checkout_error", label: "Checkout errors", events: 19 },
    ],
  };
}

// ── /admin/analytics/inventory-turnover ─────────────────────────────────
interface InvProductRow {
  productId: string;
  productName: string | null;
  unitsSold: number;
  revenueCents: number;
  cogsKnownCents: number;
  onHandQty: number | null;
  unitCostCents: number | null;
  unitPriceCents: number | null;
  waitingCount: number;
  inventoryValueCents: number | null;
  annualizedCogsCents: number;
  turnover: number | null;
  stockoutDemandCents: number | null;
}

function invRow(
  productId: string,
  productName: string,
  unitsSold: number,
  unitCostCents: number,
  unitPriceCents: number,
  onHandQty: number | null,
  waitingCount: number,
  annualFactor: number,
): InvProductRow {
  const revenueCents = unitsSold * unitPriceCents;
  const cogsKnownCents = unitsSold * unitCostCents;
  const inventoryValueCents =
    onHandQty != null ? onHandQty * unitCostCents : null;
  const annualizedCogsCents = Math.round(cogsKnownCents * annualFactor);
  const turnover =
    inventoryValueCents != null && inventoryValueCents > 0
      ? annualizedCogsCents / inventoryValueCents
      : null;
  return {
    productId,
    productName,
    unitsSold,
    revenueCents,
    cogsKnownCents,
    onHandQty,
    unitCostCents,
    unitPriceCents,
    waitingCount,
    inventoryValueCents,
    annualizedCogsCents,
    turnover,
    stockoutDemandCents: waitingCount * unitPriceCents,
  };
}

function demoInventoryTurnover(days: number) {
  const annualFactor = days > 0 ? 365 / days : 0;
  const products = [
    invRow(
      "prod_demo_cushion_n30i",
      "N30i Nasal Cushion (replacement)",
      191,
      6_400,
      14_900,
      48,
      3,
      annualFactor,
    ),
    invRow(
      "prod_demo_mask_n30i",
      "AirFit N30i Nasal Mask",
      88,
      26_500,
      46_900,
      22,
      0,
      annualFactor,
    ),
    invRow(
      "prod_demo_filter_pack",
      "Disposable Filter 6-Pack",
      173,
      2_250,
      5_500,
      140,
      0,
      annualFactor,
    ),
    invRow(
      "prod_demo_tubing_heated",
      "ClimateLineAir Heated Tubing",
      56,
      19_900,
      29_900,
      null, // never reconciled — turnover stays null
      6,
      annualFactor,
    ),
    invRow(
      "prod_demo_water_chamber",
      "Standard Water Chamber",
      51,
      4_100,
      12_000,
      31,
      2,
      annualFactor,
    ),
  ].sort((a, b) => b.cogsKnownCents - a.cogsKnownCents);

  const totals = products.reduce(
    (acc, p) => {
      if (p.inventoryValueCents != null)
        acc.inventoryValueCents += p.inventoryValueCents;
      else acc.productsWithoutReconciliation += 1;
      acc.annualizedCogsCents += p.annualizedCogsCents;
      if (p.stockoutDemandCents != null)
        acc.stockoutDemandCents += p.stockoutDemandCents;
      return acc;
    },
    {
      inventoryValueCents: 0,
      annualizedCogsCents: 0,
      stockoutDemandCents: 0,
      productsWithoutReconciliation: 0,
    },
  );
  return {
    windowDays: days,
    products,
    totals: {
      ...totals,
      turnover:
        totals.inventoryValueCents > 0
          ? totals.annualizedCogsCents / totals.inventoryValueCents
          : null,
    },
    generatedAt: NOW_ISO(),
  };
}

// ── /admin/billing/payer-profitability ──────────────────────────────────
interface PayerProfitability {
  payerKey: string;
  payerName: string | null;
  claimCount: number;
  deniedCount: number;
  denialRate: number | null;
  billedCents: number;
  allowedCents: number;
  paidCents: number;
  collectionRate: number | null;
  allowedRate: number | null;
  costKnownCents: number;
  claimsWithCost: number;
  claimsWithoutCost: number;
  netCents: number;
  netYieldRatio: number | null;
}

function payer(
  payerKey: string,
  payerName: string,
  claimCount: number,
  deniedCount: number,
  billedCents: number,
  allowedCents: number,
  paidCents: number,
  costKnownCents: number,
  claimsWithCost: number,
): PayerProfitability {
  const netCents = paidCents - costKnownCents;
  return {
    payerKey,
    payerName,
    claimCount,
    deniedCount,
    denialRate: claimCount > 0 ? deniedCount / claimCount : null,
    billedCents,
    allowedCents,
    paidCents,
    collectionRate: billedCents > 0 ? paidCents / billedCents : null,
    allowedRate: billedCents > 0 ? allowedCents / billedCents : null,
    costKnownCents,
    claimsWithCost,
    claimsWithoutCost: claimCount - claimsWithCost,
    netCents,
    netYieldRatio: billedCents > 0 ? netCents / billedCents : null,
  };
}

function demoPayerProfitability(days: number) {
  const payers = [
    payer(
      "payer_medicare_pa",
      "Medicare Part B (PA)",
      412,
      38,
      8_240_000,
      4_120_000,
      3_910_000,
      1_640_000,
      388,
    ),
    payer(
      "payer_highmark_bcbs",
      "Highmark Blue Cross Blue Shield",
      268,
      29,
      6_700_000,
      3_350_000,
      3_080_000,
      1_210_000,
      241,
    ),
    payer(
      "payer_aetna",
      "Aetna",
      141,
      22,
      3_525_000,
      1_692_000,
      1_488_000,
      612_000,
      118,
    ),
    payer(
      "payer_uhc",
      "UnitedHealthcare",
      98,
      19,
      2_450_000,
      1_078_000,
      921_000,
      0,
      0,
    ),
  ].sort((a, b) => b.paidCents - a.paidCents);

  const totals = payers.reduce(
    (acc, p) => {
      acc.claimCount += p.claimCount;
      acc.billedCents += p.billedCents;
      acc.allowedCents += p.allowedCents;
      acc.paidCents += p.paidCents;
      acc.costKnownCents += p.costKnownCents;
      acc.netCents += p.netCents;
      acc.claimsWithCost += p.claimsWithCost;
      acc.claimsWithoutCost += p.claimsWithoutCost;
      return acc;
    },
    {
      claimCount: 0,
      billedCents: 0,
      allowedCents: 0,
      paidCents: 0,
      costKnownCents: 0,
      netCents: 0,
      claimsWithCost: 0,
      claimsWithoutCost: 0,
    },
  );
  return { windowDays: days, payers, totals, generatedAt: NOW_ISO() };
}

// ── /admin/productivity ─────────────────────────────────────────────────
function demoProductivity(win: string) {
  const to = new Date();
  const from = new Date(to);
  if (win === "today") from.setUTCHours(0, 0, 0, 0);
  else if (win === "30d") from.setUTCDate(from.getUTCDate() - 30);
  else from.setUTCDate(from.getUTCDate() - 7);
  const agents = [
    {
      adminUserId: "demo-admin-1",
      email: "jordan.demo@demo.example",
      displayName: "Jordan Sample",
      role: "csr",
      assignedConversationsOpen: 12,
      conversationsClosedInWindow: 64,
      returnsApproved: 9,
      returnsRejected: 2,
      complianceAlertsResolved: 18,
      followupsCompleted: 27,
    },
    {
      adminUserId: "demo-admin-2",
      email: "taylor.example@demo.example",
      displayName: "Taylor Placeholder",
      role: "csr",
      assignedConversationsOpen: 8,
      conversationsClosedInWindow: 51,
      returnsApproved: 6,
      returnsRejected: 1,
      complianceAlertsResolved: 11,
      followupsCompleted: 33,
    },
    {
      adminUserId: "demo-admin-3",
      email: "morgan.mock@demo.example",
      displayName: "Morgan Fictional",
      role: "supervisor",
      assignedConversationsOpen: 4,
      conversationsClosedInWindow: 38,
      returnsApproved: 14,
      returnsRejected: 3,
      complianceAlertsResolved: 7,
      followupsCompleted: 12,
    },
  ];
  return {
    window: { kind: win, from: from.toISOString(), to: to.toISOString() },
    agents,
  };
}

// ── /admin/analytics/resupply-funnel (analytics.ts version — byStage) ────
function demoResupplyFunnelStages(days: number) {
  const byStage = {
    outreach_pending: 41,
    awaiting_response: 68,
    confirmed: 96,
    fulfilled: 312,
  };
  const dropOuts = { declined: 22, expired: 17, canceled: 9 };
  return {
    windowDays: days,
    total:
      Object.values(byStage).reduce((a, b) => a + b, 0) +
      Object.values(dropOuts).reduce((a, b) => a + b, 0),
    byStage,
    dropOuts,
    fulfillmentRate: r4(312 / 96),
  };
}

// ── /admin/analytics/resupply-kpis ──────────────────────────────────────
function demoResupplyKpis(days: number) {
  return {
    windowDays: days,
    totalEpisodes: 565,
    confirmedOrders: 408,
    fulfilledOrders: 312,
    uniquePatientsServed: 487,
    outreachCount: 1180,
    respondedCount: 642,
    activePatientCount: 1240,
    confirmationRate: r4(408 / 565),
    fulfillmentRate: r4(312 / 408),
    connectionRate: r4(642 / 1180),
    ordersPerActivePatientAnnualized: r4((312 / 1240) * (365 / days)),
    fulfillmentLineItems: 564,
    ordersWithFulfillments: 312,
    itemsPerOrder: r4(564 / 312),
    paidOrderCount: 187,
    averageOrderValueCents: Math.round(2_414_900 / 187),
  };
}

// ── /admin/analytics/compliance-cohorts ─────────────────────────────────
function demoComplianceCohorts(days: number) {
  const month = (offset: number) => {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - offset);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  const bucket = (cohort: string, total: number, qualifying: number) => ({
    cohort,
    total,
    qualifying,
    rate: total > 0 ? r4(qualifying / total) : null,
  });
  return {
    windowDays: days,
    compliantMinutesPerNight: 240,
    adherenceWindowDays: 30,
    byMonth: [
      bucket(month(5), 84, 61),
      bucket(month(4), 96, 72),
      bucket(month(3), 102, 79),
      bucket(month(2), 88, 67),
      bucket(month(1), 79, 58),
      bucket(month(0), 41, 24),
    ],
    byPayer: [
      {
        payer: "Medicare Part B (PA)",
        total: 214,
        qualifying: 162,
        rate: r4(162 / 214),
      },
      {
        payer: "Highmark Blue Cross Blue Shield",
        total: 138,
        qualifying: 101,
        rate: r4(101 / 138),
      },
      { payer: "Aetna", total: 74, qualifying: 49, rate: r4(49 / 74) },
      { payer: "(none on file)", total: 64, qualifying: 39, rate: r4(39 / 64) },
    ],
  };
}

// ── /admin/analytics/csr-productivity ───────────────────────────────────
function demoCsrProductivity(days: number) {
  const rows = [
    {
      operator: "jordan.demo@demo.example",
      total: 120,
      byAction: {
        conversation_closed: 64,
        return_approved: 9,
        return_rejected: 2,
        compliance_alert_resolved: 18,
        followup_completed: 27,
      },
      lastActiveDate: dateOnly(0),
    },
    {
      operator: "taylor.example@demo.example",
      total: 102,
      byAction: {
        conversation_closed: 51,
        return_approved: 6,
        return_rejected: 1,
        compliance_alert_resolved: 11,
        followup_completed: 33,
      },
      lastActiveDate: dateOnly(-1),
    },
  ];
  return {
    windowDays: days,
    rows,
    totalActions: rows.reduce((s, r) => s + r.total, 0),
  };
}

// ── /admin/analytics/patient-retention ──────────────────────────────────
function demoPatientRetention(lookbackDays: number) {
  const month = (offset: number) => {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - offset);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  const cohort = (c: string, size: number, repeat: number) => ({
    cohort: c,
    size,
    repeat,
    repeatRate: size > 0 ? r4(repeat / size) : null,
  });
  const byCohort = [
    cohort(month(6), 96, 71),
    cohort(month(5), 102, 78),
    cohort(month(4), 88, 64),
    cohort(month(3), 94, 67),
    cohort(month(2), 81, 55),
    cohort(month(1), 73, 41),
  ];
  return {
    lookbackDays,
    activeDays: 120,
    reorderDays: 90,
    patientsServed: 612,
    repeatPatients: 388,
    reorderEligible: 534,
    repeatRate: r4(388 / 534),
    activePatients: 471,
    lapsedPatients: 141,
    activeRate: r4(471 / 612),
    byCohort,
  };
}

// ── /admin/analytics/episodes-stuck ─────────────────────────────────────
function demoStuckEpisodes(stage: string, limit: number) {
  const all = [
    {
      id: "demo-ep-9001",
      patientId: "demo-p-2004",
      patientName: "Avery Placeholder",
      insurancePayer: "Medicare Part B (PA)",
      status: stage,
      createdAt: daysAgo(11),
      dueAt: daysAgo(4),
      expiresAt: dateOnly(3),
      prescriptionId: "demo-rx-501",
      ageDays: 11,
    },
    {
      id: "demo-ep-9002",
      patientId: "demo-p-2002",
      patientName: "Morgan Example",
      insurancePayer: "Highmark Blue Cross Blue Shield",
      status: stage,
      createdAt: daysAgo(8),
      dueAt: daysAgo(2),
      expiresAt: dateOnly(6),
      prescriptionId: "demo-rx-502",
      ageDays: 8,
    },
    {
      id: "demo-ep-9003",
      patientId: "demo-p-2006",
      patientName: "Harper Mockford",
      insurancePayer: "Aetna",
      status: stage,
      createdAt: daysAgo(6),
      dueAt: daysAgo(1),
      expiresAt: dateOnly(8),
      prescriptionId: "demo-rx-503",
      ageDays: 6,
    },
  ].slice(0, limit);
  return { stage, count: all.length, episodes: all };
}

// ── /admin/shop/subscriptions/metrics ───────────────────────────────────
function demoShopSubsMetrics() {
  const month = (offset: number) => {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - offset);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  return {
    counters: {
      activeNow: 482,
      pausedNow: 23,
      pastDueNow: 14,
      canceledLifetime: 138,
      newSubsLast30d: 41,
      newSubsLast90d: 117,
      canceledLast30d: 12,
      canceledLast90d: 38,
      pendingCancellations: 9,
    },
    churnRate30d: Number(((12 / (482 + 12)) * 100).toFixed(2)),
    cohort: [
      { cohortMonth: month(5), totalCreated: 38, stillLive: 31 },
      { cohortMonth: month(4), totalCreated: 44, stillLive: 38 },
      { cohortMonth: month(3), totalCreated: 39, stillLive: 35 },
      { cohortMonth: month(2), totalCreated: 47, stillLive: 43 },
      { cohortMonth: month(1), totalCreated: 41, stillLive: 39 },
      { cohortMonth: month(0), totalCreated: 22, stillLive: 22 },
    ],
  };
}

// ── /admin/nps/recent ───────────────────────────────────────────────────
function demoNpsRecent(days: number, commentLimit: number) {
  const counts = { promoter: 58, passive: 19, detractor: 7 };
  const total = counts.promoter + counts.passive + counts.detractor;
  const npsScore = Math.round(
    ((counts.promoter - counts.detractor) / total) * 100,
  );
  const comments = [
    {
      id: "demo-nps-1",
      orderId: "demo-order-7001",
      score: 10,
      comment: "Resupply showed up two days early — thank you!",
      createdAt: daysAgo(1),
    },
    {
      id: "demo-nps-2",
      orderId: "demo-order-7002",
      score: 9,
      comment:
        "Easy to reorder my cushions. CareMetric Breathe makes it painless.",
      createdAt: daysAgo(2),
    },
    {
      id: "demo-nps-3",
      orderId: "demo-order-7003",
      score: 6,
      comment: "Mask was fine but shipping took longer than expected.",
      createdAt: daysAgo(3),
    },
    {
      id: "demo-nps-4",
      orderId: "demo-order-7004",
      score: 8,
      comment: "Good service, would have liked a tracking text sooner.",
      createdAt: daysAgo(4),
    },
  ].slice(0, commentLimit);
  return { windowDays: days, total, counts, npsScore, comments };
}

// ── /admin/business-targets ─────────────────────────────────────────────
function goalPace(
  targetValue: number,
  actualToDate: number,
  daysInPeriod: number,
  daysElapsed: number,
) {
  const expectedToDate = targetValue * (daysElapsed / daysInPeriod);
  const paceRatio = expectedToDate > 0 ? actualToDate / expectedToDate : null;
  const projectedValue = actualToDate * (daysInPeriod / daysElapsed);
  const status =
    paceRatio == null
      ? "unknown"
      : paceRatio >= 1.1
        ? "ahead"
        : paceRatio >= 0.9
          ? "on_track"
          : "behind";
  return {
    daysInPeriod,
    daysElapsed,
    actualToDate,
    expectedToDate,
    paceRatio,
    attainmentRatio: targetValue > 0 ? actualToDate / targetValue : null,
    projectedValue,
    projectionConfidence: daysElapsed / daysInPeriod >= 0.5 ? "high" : "medium",
    status,
  };
}

function demoBusinessTargets(period?: string) {
  const thisMonth = (() => {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  })();
  const daysInPeriod = 30;
  const daysElapsed = Math.min(new Date().getUTCDate(), daysInPeriod);
  const all = [
    {
      id: "demo-target-1",
      metricKey: "cash_revenue_cents",
      period: thisMonth,
      targetValue: 3_000_000,
      unit: "cents",
      notes:
        "Historical retail revenue goal (demo only — patients are insurance-only).",
      createdByEmail: "owner.demo@demo.example",
      createdAt: daysAgo(20),
      updatedAt: daysAgo(2),
      pace: goalPace(3_000_000, 2_414_900, daysInPeriod, daysElapsed),
    },
    {
      id: "demo-target-2",
      metricKey: "fulfilled_episodes",
      period: thisMonth,
      targetValue: 350,
      unit: "count",
      notes: "Resupply fulfillment volume.",
      createdByEmail: "owner.demo@demo.example",
      createdAt: daysAgo(20),
      updatedAt: daysAgo(3),
      pace: goalPace(350, 312, daysInPeriod, daysElapsed),
    },
    {
      id: "demo-target-3",
      metricKey: "new_subscriptions",
      period: thisMonth,
      targetValue: 50,
      unit: "count",
      notes: null,
      createdByEmail: "owner.demo@demo.example",
      createdAt: daysAgo(18),
      updatedAt: daysAgo(1),
      pace: goalPace(50, 41, daysInPeriod, daysElapsed),
    },
  ];
  const targets = period ? all.filter((t) => t.period === period) : all;
  return { targets };
}

// ── /admin/billing/benchmarks ───────────────────────────────────────────
function demoBillingBenchmarks() {
  return {
    dsoDays: {
      population: 388,
      percentiles: { 25: 18.4, 50: 24.1, 75: 31.7, 90: 42.3, 99: 58.9 },
      mean: 26.8,
    },
    denialRate: { population: 412, overall: r4(38 / 412) },
    paidRatio: { population: 388, meanFraction: 0.4912 },
    heuristicScorerLift: {
      claimsScored: 296,
      overHalfCount: 71,
      overHalfDeniedActual: 44,
      overHalfDenialRate: r4(44 / 71),
    },
    topPayersByVolume: [
      {
        payerName: "Medicare Part B (PA)",
        decisions: 214,
        denials: 19,
        denialRate: r4(19 / 214),
      },
      {
        payerName: "Highmark Blue Cross Blue Shield",
        decisions: 138,
        denials: 14,
        denialRate: r4(14 / 138),
      },
      {
        payerName: "Aetna",
        decisions: 74,
        denials: 9,
        denialRate: r4(9 / 74),
      },
    ],
    note:
      "Phase 1: cohort = our own decided claims in the last 180 days. " +
      "National benchmark licensing (LexisNexis MarketView / VGM) is " +
      "Phase 2; the response shape will gain national.* fields without " +
      "breaking the current keys.",
    generatedAt: NOW_ISO(),
  };
}

export const analyticsHandlers: DemoHandler[] = [
  // Owner / finance analytics
  route("GET", "/resupply-api/admin/analytics/margin", (req) =>
    json(demoMargin(intParam(req, "days", 30))),
  ),
  route("GET", "/resupply-api/admin/analytics/channel-engagement", (req) =>
    json(demoChannelEngagement(intParam(req, "days", 30))),
  ),
  route("GET", "/resupply-api/admin/analytics/revenue-by-source", (req) =>
    json(demoRevenueBySource(intParam(req, "days", 30))),
  ),
  route("GET", "/resupply-api/admin/analytics/outreach-attribution", (req) =>
    json(
      demoOutreachAttribution(
        intParam(req, "days", 30),
        intParam(req, "attributionWindowDays", 14),
      ),
    ),
  ),
  route("GET", "/resupply-api/admin/analytics/ltv-cac", () =>
    json(demoLtvCac()),
  ),
  route("GET", "/resupply-api/admin/analytics/acquisition-funnel", (req) =>
    json(demoAcquisitionFunnel(intParam(req, "days", 30))),
  ),
  route("GET", "/resupply-api/admin/analytics/inventory-turnover", (req) =>
    json(demoInventoryTurnover(intParam(req, "days", 90))),
  ),
  route("GET", "/resupply-api/admin/billing/payer-profitability", (req) =>
    json(demoPayerProfitability(intParam(req, "days", 180))),
  ),
  route("GET", "/resupply-api/admin/billing/benchmarks", () =>
    json(demoBillingBenchmarks()),
  ),

  // Clinical analytics dashboard (analytics.ts)
  route("GET", "/resupply-api/admin/analytics/resupply-funnel", (req) =>
    json(demoResupplyFunnelStages(intParam(req, "days", 30))),
  ),
  route("GET", "/resupply-api/admin/analytics/resupply-kpis", (req) =>
    json(demoResupplyKpis(intParam(req, "days", 30))),
  ),
  route("GET", "/resupply-api/admin/analytics/compliance-cohorts", (req) =>
    json(demoComplianceCohorts(intParam(req, "days", 180))),
  ),
  route("GET", "/resupply-api/admin/analytics/csr-productivity", (req) =>
    json(demoCsrProductivity(intParam(req, "days", 14))),
  ),
  route("GET", "/resupply-api/admin/analytics/patient-retention", (req) =>
    json(demoPatientRetention(intParam(req, "lookbackDays", 365))),
  ),
  route("GET", "/resupply-api/admin/analytics/episodes-stuck", (req) =>
    json(
      demoStuckEpisodes(
        req.query.get("stage") ?? "awaiting_response",
        intParam(req, "limit", 25),
      ),
    ),
  ),

  // CSR + subscriptions + NPS + goals
  route("GET", "/resupply-api/admin/productivity", (req) =>
    json(demoProductivity(req.query.get("window") ?? "7d")),
  ),
  route("GET", "/resupply-api/admin/shop/subscriptions/metrics", () =>
    json(demoShopSubsMetrics()),
  ),
  route("GET", "/resupply-api/admin/nps/recent", (req) =>
    json(
      demoNpsRecent(
        intParam(req, "days", 7),
        intParam(req, "commentLimit", 10),
      ),
    ),
  ),
  route("GET", "/resupply-api/admin/business-targets", (req) =>
    json(demoBusinessTargets(req.query.get("period") ?? undefined)),
  ),
];
