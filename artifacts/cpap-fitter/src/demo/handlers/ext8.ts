// Admin SHOP / storefront-ops handlers for the demo sandbox (batch 8).
//
// Seeds the admin shop surfaces that otherwise hit the interceptor's
// benign empty-`{}` fallback and break pages that deref nested fields /
// map over arrays: reports presets, return notes, back-in-stock queue,
// backorders + SKU substitutes, membership, order loss-claims, POD
// metadata, and the shop returns queue + detail. Mutations on these
// surfaces return benign success in the live route's response shape.
//
// Every endpoint here mounts under /resupply-api (admin), confirmed
// against the live route files in
// artifacts/resupply-api/src/routes/admin/* and the client wrappers in
// artifacts/cpap-fitter/src/lib/admin/*.
//
// DATA RULES: fictional demo data only — fake customer names ("Demo
// Patient", "Avery Sample"), demo ids, fresh relative dates, money in
// integer cents. Platform = CareMetric Breathe; tenant = Penn Home
// Medical Supply (pennpaps.com). Internally consistent with the seeded
// product / order fixtures. NO real PHI.
//
// SKIPPED (handled elsewhere or non-JSON):
//   * admin/resupply-order-drafts.ts — already seeded in handlers/therapy.ts.
//   * admin/reports.ts — CSV/PDF/IIF stream downloads only, no JSON GET.
//   * shop-order-pod-upload.ts image stream + presigned PUT / finalize —
//     only the JSON metadata GET (/pod/meta) is seeded.
//   * shop-order-pod.ts GET — streams image bytes (binary), skipped; its
//     PATCH (stamp an already-uploaded key) is seeded as benign success.

import { route, type DemoHandler } from "../types";
import { json, noContent } from "../respond";
import { DEMO_PRODUCTS } from "../fixtures/products";
import { daysAgo, daysFromNow, dateOnly, NOW_ISO } from "../fixtures/dates";

// ── Reports presets (report-presets.ts) ───────────────────────────────
// GET    /resupply-api/admin/reports/presets        → { presets: [...] }
// POST   /resupply-api/admin/reports/presets        → { preset } (201)
// DELETE /resupply-api/admin/reports/presets/:id     → 204
const REPORT_PRESETS = [
  {
    id: "demo-rp-0001-0000-0000-0000-000000000001",
    name: "Monthly revenue (last 30 days)",
    slug: "revenue-summary",
    format: "csv" as const,
    rangeKind: "preset" as const,
    rangePreset: "last_30_days",
    rangeFrom: null,
    rangeTo: null,
    recipient: "owner@pennpaps.com",
    createdAt: daysAgo(20),
    updatedAt: daysAgo(20),
  },
  {
    id: "demo-rp-0001-0000-0000-0000-000000000002",
    name: "Q1 resupply orders",
    slug: "resupply-orders",
    format: "qbo.csv" as const,
    rangeKind: "absolute" as const,
    rangePreset: null,
    rangeFrom: dateOnly(-90),
    rangeTo: dateOnly(0),
    recipient: null,
    createdAt: daysAgo(8),
    updatedAt: daysAgo(8),
  },
];

// ── Return notes (return-notes.ts) ────────────────────────────────────
// GET  /resupply-api/admin/shop/returns/:returnId/notes → { notes: [...] }
// POST /resupply-api/admin/shop/returns/:returnId/notes → { id, createdAt }
function returnNotes() {
  return {
    notes: [
      {
        id: "demo-rn-0001-0000-0000-0000-000000000001",
        body: "Customer reports cushion was too large; approved exchange for a medium.",
        authorEmail: "demo.csr@pennpaps.com",
        authorUserId: "demo-user-csr-1",
        createdAt: daysAgo(2),
      },
      {
        id: "demo-rn-0001-0000-0000-0000-000000000002",
        body: "Return label emailed. Awaiting drop-off at carrier.",
        authorEmail: "demo.csr@pennpaps.com",
        authorUserId: "demo-user-csr-1",
        createdAt: daysAgo(1),
      },
    ],
  };
}

// ── Back-in-stock queue (shop-back-in-stock.ts) ───────────────────────
// GET  /resupply-api/admin/shop/back-in-stock-queue
//   { queue: QueueRow[], totals: {pending,notified,delivered}, stripeAvailable }
// POST /resupply-api/admin/shop/back-in-stock-queue/:productId/dispatch
//   { productId, productName, pending, attempted, delivered, failed }
function backInStockQueue() {
  // Use real demo catalog names for the rows that are out of stock in
  // the product fixture (P10 pillows low, water chamber at 0).
  const queue = [
    {
      productId: "prod_demo_chamber",
      productName: "AirSense Humidifier Water Chamber",
      productImageUrl: "/products/chamber-airsense.webp",
      priceLabel: "$27.99",
      pendingCount: 7,
      notifiedCount: 3,
      deliveredCount: 3,
      oldestPendingAt: daysAgo(12),
      lastNotifiedAt: daysAgo(4),
    },
    {
      productId: "prod_demo_p10_pillows",
      productName: "AirFit P10 Nasal Pillows",
      productImageUrl: "/products/cushion-p10.jpg",
      priceLabel: "$24.49",
      pendingCount: 2,
      notifiedCount: 0,
      deliveredCount: 0,
      oldestPendingAt: daysAgo(3),
      lastNotifiedAt: null,
    },
  ];
  const totals = queue.reduce(
    (acc, r) => {
      acc.pending += r.pendingCount;
      acc.notified += r.notifiedCount;
      acc.delivered += r.deliveredCount;
      return acc;
    },
    { pending: 0, notified: 0, delivered: 0 },
  );
  return { queue, totals, stripeAvailable: true };
}

// ── Backorders + SKU substitutes (shop-backorders.ts) ─────────────────
// GET  /resupply-api/admin/shop/backorders            → { backorders: [...] }
// POST /resupply-api/admin/shop/backorders            → { id } (201)
// POST /resupply-api/admin/shop/backorders/:id/clear  → { ok: true }
// GET  /resupply-api/admin/shop/sku-substitutes       → { substitutes: [...] }
// POST /resupply-api/admin/shop/sku-substitutes       → { id } (201)
// PATCH/DELETE /resupply-api/admin/shop/sku-substitutes/:id → { ok: true }
function backorders() {
  return {
    backorders: [
      {
        id: "demo-bo-0001-0000-0000-0000-000000000001",
        sku: "n20-cushion-std",
        markedAt: daysAgo(5),
        clearedAt: null,
        notes: "Vendor backorder — ETA 2 weeks",
        markedByUserId: "demo-user-csr-1",
        createdAt: daysAgo(5),
      },
      {
        id: "demo-bo-0001-0000-0000-0000-000000000002",
        sku: "airsense-chamber",
        markedAt: daysAgo(18),
        clearedAt: daysAgo(2),
        notes: "Restocked; cleared.",
        markedByUserId: "demo-user-csr-1",
        createdAt: daysAgo(18),
      },
    ],
  };
}

function skuSubstitutes(primary: string | null) {
  const all = [
    {
      id: "demo-sub-0001-0000-0000-0000-000000000001",
      primarySku: "n20-cushion-std",
      alternativeSku: "n20-cushion-sm",
      priority: 10,
      active: true,
      notes: "Offer smaller cushion while standard is backordered.",
      createdAt: daysAgo(30),
      updatedAt: daysAgo(5),
    },
    {
      id: "demo-sub-0001-0000-0000-0000-000000000002",
      primarySku: "airsense-chamber",
      alternativeSku: "airsense-chamber-oem",
      priority: 20,
      active: true,
      notes: null,
      createdAt: daysAgo(40),
      updatedAt: daysAgo(40),
    },
  ];
  return {
    substitutes: primary ? all.filter((s) => s.primarySku === primary) : all,
  };
}

// ── Membership (shop-membership.ts) ───────────────────────────────────
// GET   /resupply-api/admin/shop/customers/:customerId/membership
//   → { membership: { customer_id, membership_tier, ... } }
// PATCH /resupply-api/admin/shop/customers/:customerId/membership
//   → { ok: true }
function membership(customerId: string) {
  return {
    membership: {
      customer_id: customerId,
      membership_tier: "monthly_unlimited",
      membership_started_at: daysAgo(60),
      membership_renews_at: daysFromNow(5),
      membership_stripe_subscription_id: "sub_demo_membership_001",
    },
  };
}

// ── Order loss-claims (shop-order-loss-claims.ts) ─────────────────────
// GET   /resupply-api/admin/shop/orders/:orderId/loss-claims → { claims }
// POST  /resupply-api/admin/shop/orders/:orderId/loss-claims → { id } (201)
// PATCH /resupply-api/admin/shop/loss-claims/:id             → { ok: true }
function lossClaims(orderId: string) {
  return {
    claims: [
      {
        id: "demo-lc-0001-0000-0000-0000-000000000001",
        orderId,
        openedByUserId: "demo-user-csr-1",
        status: "carrier_filed" as const,
        carrierClaimNumber: "UPS-CLAIM-DEMO-4471",
        resolutionNote:
          "Parcel scanned in transit then went dark; claim filed.",
        openedAt: daysAgo(6),
        carrierFiledAt: daysAgo(4),
        resolvedAt: null,
      },
    ],
  };
}

// ── Shop returns queue + detail (shop-returns.ts) ─────────────────────
// GET  /resupply-api/admin/shop/returns?status=&cursor=&limit=
//   → { returns: SerializedReturn[], nextCursor }
// GET  /resupply-api/admin/shop/returns/:id → { return: SerializedReturn }
// POST lifecycle endpoints → { return: SerializedReturn }
function serializedReturn(over: Partial<Record<string, unknown>>) {
  return {
    id: "demo-ret-0000",
    customerId: "demo-cust-9001",
    orderId: "demo-order-1",
    sessionId: "demo_sess_1001",
    status: "requested" as string,
    reason: "wrong_size",
    reasonNote: "Cushion too large, leaks at the bridge of the nose.",
    resolution: null as string | null,
    refundCents: null as number | null,
    stripeRefundId: null as string | null,
    exchangeProductId: null as string | null,
    exchangePriceId: null as string | null,
    exchangeOrderId: null as string | null,
    returnLabelUrl: null as string | null,
    returnCarrier: null as string | null,
    returnTrackingNumber: null as string | null,
    adminNote: null as string | null,
    adminUserId: null as string | null,
    createdAt: daysAgo(3),
    updatedAt: daysAgo(2),
    approvedAt: null as string | null,
    rejectedAt: null as string | null,
    shippedBackAt: null as string | null,
    receivedAt: null as string | null,
    resolvedAt: null as string | null,
    closedAt: null as string | null,
    ...over,
  };
}

const DEMO_RETURNS = [
  serializedReturn({
    id: "demo-ret-0001-0000-0000-0000-000000000001",
    status: "requested",
    customerId: "demo-cust-9001",
    orderId: "demo-order-2",
    sessionId: "demo_sess_1002",
    reason: "wrong_size",
    reasonNote: "Cushion too large; would like a medium.",
    createdAt: daysAgo(3),
    updatedAt: daysAgo(3),
  }),
  serializedReturn({
    id: "demo-ret-0001-0000-0000-0000-000000000002",
    status: "approved",
    customerId: "demo-cust-9002",
    orderId: "demo-order-1",
    sessionId: "demo_sess_1001",
    reason: "defective",
    reasonNote: "Headgear strap clip cracked on arrival.",
    returnCarrier: "UPS",
    returnTrackingNumber: "1Z999AA10112233445",
    returnLabelUrl: "https://www.ups.com/track?tracknum=1Z999AA10112233445",
    adminNote:
      "[approved] demo.csr@pennpaps.com — Approved: defective on arrival",
    adminUserId: "demo-user-csr-1",
    approvedAt: daysAgo(1),
    createdAt: daysAgo(5),
    updatedAt: daysAgo(1),
  }),
  serializedReturn({
    id: "demo-ret-0001-0000-0000-0000-000000000003",
    status: "refunded",
    customerId: "demo-cust-9003",
    orderId: "demo-order-2",
    sessionId: "demo_sess_1002",
    reason: "changed_mind",
    reasonNote: "Switched to a different mask style.",
    resolution: "refund",
    refundCents: 2999,
    stripeRefundId: "re_demo_refund_001",
    receivedAt: daysAgo(8),
    resolvedAt: daysAgo(7),
    closedAt: daysAgo(7),
    createdAt: daysAgo(14),
    updatedAt: daysAgo(7),
  }),
];

function returnsList(status: string) {
  const open = new Set(["requested", "approved", "shipped_back", "received"]);
  let rows = DEMO_RETURNS;
  if (status === "open") {
    rows = DEMO_RETURNS.filter((r) => open.has(r.status));
  } else if (status !== "all") {
    rows = DEMO_RETURNS.filter((r) => r.status === status);
  }
  return { returns: rows, nextCursor: null };
}

function findReturn(id: string) {
  return DEMO_RETURNS.find((r) => r.id === id) ?? serializedReturn({ id });
}

// Reference DEMO_PRODUCTS so a future drift between the catalog fixture
// and the back-in-stock rows is obvious (and to keep the import live).
void DEMO_PRODUCTS;

// ── Shop orders: list + detail (shop-orders.ts) ───────────────────────
// GET /resupply-api/admin/shop/orders            → AdminShopOrderListPage
// GET /resupply-api/admin/shop/orders/:orderId   → AdminShopOrderDetail
//
// Every per-order ACTION below (tracking, delivered, pickup, refund,
// address, POD, loss-claims, shipping labels) was already seeded, but the
// list that reaches an order was not — so /admin/shop/orders rendered an
// empty table and none of those actions could be exercised from the UI.
// Shapes mirror src/lib/admin/shop-orders-api.ts.
const SHOP_ORDER_SEED: ReadonlyArray<{
  n: number;
  status: string;
  name: string;
  email: string;
  cents: number;
  method: "ship" | "pickup";
  carrier: string | null;
  stage: "paid" | "shipped" | "delivered" | "ready" | "picked_up" | "refunded";
}> = [
  {
    n: 1,
    status: "delivered",
    name: "Avery Sample",
    email: "avery.sample@example.com",
    cents: 18400,
    method: "ship",
    carrier: "UPS",
    stage: "delivered",
  },
  {
    n: 2,
    status: "shipped",
    name: "Demo Patient",
    email: "demo.patient@example.com",
    cents: 9250,
    method: "ship",
    carrier: "USPS",
    stage: "shipped",
  },
  {
    n: 3,
    status: "paid",
    name: "Jordan Reyes",
    email: "jordan.reyes@example.com",
    cents: 24600,
    method: "ship",
    carrier: null,
    stage: "paid",
  },
  {
    n: 4,
    status: "ready_for_pickup",
    name: "Sam Okafor",
    email: "sam.okafor@example.com",
    cents: 7100,
    method: "pickup",
    carrier: null,
    stage: "ready",
  },
  {
    n: 5,
    status: "picked_up",
    name: "Nina Alvarez",
    email: "nina.alvarez@example.com",
    cents: 13350,
    method: "pickup",
    carrier: null,
    stage: "picked_up",
  },
  {
    n: 6,
    status: "refunded",
    name: "Chris Bell",
    email: "chris.bell@example.com",
    cents: 15900,
    method: "ship",
    carrier: "UPS",
    stage: "refunded",
  },
  {
    n: 7,
    status: "paid",
    name: "Robin Diaz",
    email: "robin.diaz@example.com",
    cents: 20800,
    method: "ship",
    carrier: null,
    stage: "paid",
  },
];

function shopOrderId(n: number): string {
  return `demo-order-${String(n).padStart(4, "0")}`;
}

function shopOrderListItem(seed: (typeof SHOP_ORDER_SEED)[number]) {
  const shipped = ["shipped", "delivered", "refunded"].includes(seed.stage);
  const delivered = seed.stage === "delivered";
  return {
    id: shopOrderId(seed.n),
    status: seed.status,
    customerName: seed.name,
    customerEmail: seed.email,
    amountTotalCents: seed.cents,
    currency: "usd",
    createdAt: daysAgo(seed.n * 3),
    paidAt: daysAgo(seed.n * 3),
    shippedAt: shipped ? daysAgo(seed.n * 3 - 1) : null,
    deliveredAt: delivered ? daysAgo(seed.n * 3 - 2) : null,
    trackingCarrier: shipped ? seed.carrier : null,
    trackingNumber: shipped
      ? `1Z999AA1${String(10000000 + seed.n * 137)}`
      : null,
    fulfillmentMethod: seed.method,
    itemCount: 1 + (seed.n % 3),
  };
}

/**
 * Session-scoped order state.
 *
 * The list/detail readers used to rebuild rows from `SHOP_ORDER_SEED` on
 * every call while the fulfilment mutations only returned a projected
 * response. The page invalidates and refetches after each action, so every
 * successful save (tracking, delivered, pickup, refund, address) visibly
 * reverted a moment later. Both sides now share this map, so an action
 * sticks for the session — the same posture as the other demo stores.
 */
type DemoOrderRow = ReturnType<typeof shopOrderListItem> & {
  shippingAddress: Record<string, string | null> | null;
  readyForPickupAt: string | null;
  pickedUpAt: string | null;
  refundedAmountCents: number | null;
};

let orderStore: Map<string, DemoOrderRow> | null = null;

function orders(): Map<string, DemoOrderRow> {
  if (!orderStore) {
    orderStore = new Map(
      SHOP_ORDER_SEED.map((seed) => {
        const base = shopOrderListItem(seed);
        return [
          base.id,
          {
            ...base,
            shippingAddress:
              seed.method === "pickup"
                ? null
                : {
                    name: seed.name,
                    line1: `${200 + seed.n * 5} Market St`,
                    line2: null,
                    city: "Philadelphia",
                    state: "PA",
                    postalCode: "19103",
                    country: "US",
                  },
            readyForPickupAt:
              seed.stage === "ready" || seed.stage === "picked_up"
                ? daysAgo(1)
                : null,
            pickedUpAt: seed.stage === "picked_up" ? daysAgo(1) : null,
            refundedAmountCents: seed.stage === "refunded" ? seed.cents : null,
          } satisfies DemoOrderRow,
        ];
      }),
    );
  }
  return orderStore;
}

/** Apply a fulfilment patch and return the stored row. */
function patchDemoOrder(
  orderId: string,
  patch: Partial<DemoOrderRow>,
): DemoOrderRow {
  const store = orders();
  const existing = store.get(orderId);
  // A deep link to an id we never seeded still resolves to a coherent
  // order rather than 404-ing mid-demo.
  const base =
    existing ??
    ({
      ...shopOrderListItem(SHOP_ORDER_SEED[0]),
      id: orderId,
      shippingAddress: null,
      readyForPickupAt: null,
      pickedUpAt: null,
      refundedAmountCents: null,
    } as DemoOrderRow);
  const next = { ...base, ...patch };
  store.set(orderId, next);
  return next;
}

function shopOrdersList(query: URLSearchParams) {
  const status = query.get("status");
  const q = query.get("q")?.toLowerCase();
  const limit = Number(query.get("limit")) || 25;
  const offset = Number(query.get("offset")) || 0;

  let rows = [...orders().values()];
  if (status) rows = rows.filter((o) => o.status === status);
  if (q) {
    rows = rows.filter(
      (o) =>
        (o.customerName ?? "").toLowerCase().includes(q) ||
        (o.customerEmail ?? "").toLowerCase().includes(q) ||
        o.id.includes(q),
    );
  }
  return {
    orders: rows.slice(offset, offset + limit),
    total: rows.length,
    limit,
    offset,
  };
}

function shopOrderDetail(orderId: string) {
  const row = orders().get(orderId) ?? patchDemoOrder(orderId, {});
  const products = DEMO_PRODUCTS.slice(0, Math.max(1, row.itemCount));
  return {
    ...row,
    stripeSessionId: `cs_demo_${orderId}`,
    stripePaymentIntentId: row.status === "paid" ? null : `pi_demo_${orderId}`,
    lineItems: products.map((p, i) => ({
      name: p.name,
      quantity: i === 0 ? 1 : 2,
      amountSubtotalCents: Math.round(
        (row.amountTotalCents ?? 0) / Math.max(1, row.itemCount),
      ),
    })),
  };
}

export const ext8Handlers: DemoHandler[] = [
  // ── Reports presets ─────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/reports/presets", () =>
    json({ presets: REPORT_PRESETS }),
  ),
  route("POST", "/resupply-api/admin/reports/presets", (req) => {
    const body =
      req.json<{
        name?: string;
        slug?: string;
        format?: string;
        recipient?: string | null;
      }>() ?? {};
    return json(
      {
        preset: {
          id: "demo-rp-0001-0000-0000-0000-0000000000ff",
          name: body.name ?? "New report preset",
          slug: body.slug ?? "revenue-summary",
          format: body.format ?? "csv",
          rangeKind: "preset",
          rangePreset: "last_30_days",
          rangeFrom: null,
          rangeTo: null,
          recipient: body.recipient ?? null,
          createdAt: NOW_ISO(),
          updatedAt: NOW_ISO(),
        },
      },
      201,
    );
  }),
  route("DELETE", "/resupply-api/admin/reports/presets/:id", () => noContent()),

  // ── Return notes ────────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/shop/returns/:returnId/notes", () =>
    json(returnNotes()),
  ),
  route("POST", "/resupply-api/admin/shop/returns/:returnId/notes", () =>
    json(
      {
        id: "demo-rn-0001-0000-0000-0000-0000000000ff",
        createdAt: NOW_ISO(),
      },
      201,
    ),
  ),

  // ── Back-in-stock queue ─────────────────────────────────────────────
  route("GET", "/resupply-api/admin/shop/back-in-stock-queue", () =>
    json(backInStockQueue()),
  ),
  route(
    "POST",
    "/resupply-api/admin/shop/back-in-stock-queue/:productId/dispatch",
    (_req, { productId }) =>
      json({
        productId,
        productName: "AirSense Humidifier Water Chamber",
        pending: 7,
        attempted: 7,
        delivered: 7,
        failed: 0,
      }),
  ),

  // ── Backorders ──────────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/shop/backorders", () => json(backorders())),
  route("POST", "/resupply-api/admin/shop/backorders", () =>
    json({ id: "demo-bo-0001-0000-0000-0000-0000000000ff" }, 201),
  ),
  route("POST", "/resupply-api/admin/shop/backorders/:id/clear", () =>
    json({ ok: true }),
  ),

  // ── SKU substitutes ─────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/shop/sku-substitutes", (req) =>
    json(skuSubstitutes(req.query.get("primary_sku"))),
  ),
  route("POST", "/resupply-api/admin/shop/sku-substitutes", () =>
    json({ id: "demo-sub-0001-0000-0000-0000-0000000000ff" }, 201),
  ),
  route("PATCH", "/resupply-api/admin/shop/sku-substitutes/:id", () =>
    json({ ok: true }),
  ),
  route("DELETE", "/resupply-api/admin/shop/sku-substitutes/:id", () =>
    json({ ok: true }),
  ),

  // ── Membership ──────────────────────────────────────────────────────
  route(
    "GET",
    "/resupply-api/admin/shop/customers/:customerId/membership",
    (_req, { customerId }) => json(membership(customerId)),
  ),
  route(
    "PATCH",
    "/resupply-api/admin/shop/customers/:customerId/membership",
    () => json({ ok: true }),
  ),

  // ── Shop orders: list + detail ──────────────────────────────────────
  // Declared before the `:orderId` sub-routes below; `/orders` and
  // `/orders/:orderId` are distinct patterns, and the detail route is a
  // two-segment match so it cannot swallow `/orders/:orderId/pod` etc.
  route("GET", "/resupply-api/admin/shop/orders", (req) =>
    json(shopOrdersList(req.query)),
  ),
  route(
    "GET",
    "/resupply-api/admin/shop/orders/:orderId",
    (_req, { orderId }) => json(shopOrderDetail(orderId)),
  ),

  // ── Order loss-claims ───────────────────────────────────────────────
  route(
    "GET",
    "/resupply-api/admin/shop/orders/:orderId/loss-claims",
    (_req, { orderId }) => json(lossClaims(orderId)),
  ),
  route("POST", "/resupply-api/admin/shop/orders/:orderId/loss-claims", () =>
    json({ id: "demo-lc-0001-0000-0000-0000-0000000000ff" }, 201),
  ),
  route("PATCH", "/resupply-api/admin/shop/loss-claims/:id", () =>
    json({ ok: true }),
  ),

  // ── POD metadata (JSON only; image stream + PATCH stamp seeded) ──────
  route("GET", "/resupply-api/admin/shop/orders/:orderId/pod/meta", () =>
    json({
      uploadedAt: daysAgo(8),
      signedName: "D. Patient",
    }),
  ),
  // Legacy PATCH (stamp an already-uploaded objectKey) — benign success.
  route("PATCH", "/resupply-api/admin/shop/orders/:orderId/pod", () =>
    json({ ok: true }),
  ),

  // ── Shop returns queue + detail ─────────────────────────────────────
  route("GET", "/resupply-api/admin/shop/returns", (req) =>
    json(returnsList(String(req.query.get("status") ?? "open"))),
  ),
  route("GET", "/resupply-api/admin/shop/returns/:id", (_req, { id }) =>
    json({ return: findReturn(id) }),
  ),
  route(
    "POST",
    "/resupply-api/admin/shop/returns/:id/approve",
    (req, { id }) => {
      const body = req.json<{
        returnLabelUrl?: string | null;
        returnCarrier?: string | null;
        returnTrackingNumber?: string | null;
      }>();
      return json({
        return: serializedReturn({
          ...findReturn(id),
          status: "approved",
          returnLabelUrl: body?.returnLabelUrl ?? null,
          returnCarrier: body?.returnCarrier ?? null,
          returnTrackingNumber: body?.returnTrackingNumber ?? null,
          approvedAt: NOW_ISO(),
          updatedAt: NOW_ISO(),
        }),
      });
    },
  ),
  route("POST", "/resupply-api/admin/shop/returns/:id/reject", (_req, { id }) =>
    json({
      return: serializedReturn({
        ...findReturn(id),
        status: "rejected",
        rejectedAt: NOW_ISO(),
        closedAt: NOW_ISO(),
        updatedAt: NOW_ISO(),
      }),
    }),
  ),
  route(
    "POST",
    "/resupply-api/admin/shop/returns/:id/mark-shipped",
    (_req, { id }) =>
      json({
        return: serializedReturn({
          ...findReturn(id),
          status: "shipped_back",
          shippedBackAt: NOW_ISO(),
          updatedAt: NOW_ISO(),
        }),
      }),
  ),
  route(
    "POST",
    "/resupply-api/admin/shop/returns/:id/mark-received",
    (_req, { id }) =>
      json({
        return: serializedReturn({
          ...findReturn(id),
          status: "received",
          receivedAt: NOW_ISO(),
          updatedAt: NOW_ISO(),
        }),
      }),
  ),
  route(
    "POST",
    "/resupply-api/admin/shop/returns/:id/refund",
    (req, { id }) => {
      const body = req.json<{ amountCents?: number }>();
      return json({
        return: serializedReturn({
          ...findReturn(id),
          status: "refunded",
          resolution: "refund",
          refundCents: body?.amountCents ?? 2999,
          stripeRefundId: "re_demo_refund_ff",
          resolvedAt: NOW_ISO(),
          closedAt: NOW_ISO(),
          updatedAt: NOW_ISO(),
        }),
      });
    },
  ),
  route(
    "POST",
    "/resupply-api/admin/shop/returns/:id/replace",
    (req, { id }) => {
      const body = req.json<{
        exchangeProductId?: string;
        exchangePriceId?: string;
        exchangeOrderId?: string | null;
      }>();
      return json({
        return: serializedReturn({
          ...findReturn(id),
          status: "replaced",
          resolution: "exchange",
          exchangeProductId: body?.exchangeProductId ?? "demo-prod-n20-cushion",
          exchangePriceId: body?.exchangePriceId ?? "demo_price_2999",
          exchangeOrderId: body?.exchangeOrderId ?? null,
          resolvedAt: NOW_ISO(),
          closedAt: NOW_ISO(),
          updatedAt: NOW_ISO(),
        }),
      });
    },
  ),
  route("POST", "/resupply-api/admin/shop/returns/:id/note", (_req, { id }) =>
    json({
      return: serializedReturn({
        ...findReturn(id),
        adminNote: "[note] demo.csr@pennpaps.com — Note added",
        updatedAt: NOW_ISO(),
      }),
    }),
  ),

  // ── Shop orders fulfillment mutations (shop-orders.ts) ──────────────
  // These admin order ids are text UUIDs in prod; the demo order ids
  // (demo-order-*) won't match the route's UUID validator, but the demo
  // interceptor doesn't validate — return the projected order shape so
  // the order-detail fulfillment actions show optimistic success.
  route(
    "POST",
    "/resupply-api/admin/shop/orders/:orderId/tracking",
    (req, { orderId }) => {
      const body = req.json<{ carrier?: string; number?: string }>();
      return json({
        order: patchDemoOrder(orderId, {
          status: "shipped",
          trackingCarrier: body?.carrier ?? "UPS",
          trackingNumber: body?.number ?? "1Z999AA10123456784",
          shippedAt: NOW_ISO(),
        }),
      });
    },
  ),
  route(
    "POST",
    "/resupply-api/admin/shop/orders/:orderId/delivered",
    (_req, { orderId }) =>
      json({
        order: patchDemoOrder(orderId, {
          status: "delivered",
          deliveredAt: NOW_ISO(),
        }),
      }),
  ),
  route(
    "POST",
    "/resupply-api/admin/shop/orders/:orderId/ready-for-pickup",
    (_req, { orderId }) =>
      json({
        order: patchDemoOrder(orderId, {
          status: "ready_for_pickup",
          fulfillmentMethod: "pickup",
          readyForPickupAt: NOW_ISO(),
        }),
      }),
  ),
  route(
    "POST",
    "/resupply-api/admin/shop/orders/:orderId/picked-up",
    (_req, { orderId }) =>
      json({
        order: patchDemoOrder(orderId, {
          status: "picked_up",
          fulfillmentMethod: "pickup",
          pickedUpAt: NOW_ISO(),
        }),
      }),
  ),
  route(
    "PATCH",
    "/resupply-api/admin/shop/orders/:orderId/shipping-address",
    (req, { orderId }) => {
      const body = req.json<{
        line1?: string;
        line2?: string | null;
        city?: string;
        state?: string;
        postalCode?: string;
      }>();
      return json({
        order: patchDemoOrder(orderId, {
          shippingAddress: {
            line1: body?.line1 ?? "1200 Market Street",
            line2: body?.line2 ?? "Apt 4B",
            city: body?.city ?? "Philadelphia",
            state: (body?.state ?? "PA").toUpperCase(),
            postalCode: body?.postalCode ?? "19107",
            country: "US",
          },
        }),
      });
    },
  ),
  route(
    "POST",
    "/resupply-api/admin/shop/orders/:orderId/refund",
    (req, { orderId }) => {
      const body = req.json<{ amountCents?: number }>();
      const amount = body?.amountCents ?? 8900;
      return json({
        refund: {
          id: "re_demo_order_refund_001",
          amountCents: amount,
          status: "succeeded",
        },
        order: patchDemoOrder(orderId, {
          status: "refunded",
          refundedAmountCents: amount,
        }),
      });
    },
  ),
];

/**
 * Build the `{ order }` payload the shop-order fulfillment client expects
 * (matches projectOrder() in shop-orders.ts). Defaults model a paid
 * shippable order; the patch overrides whichever fields the action sets.
 */
