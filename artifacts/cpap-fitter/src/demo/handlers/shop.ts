// Public storefront handlers: catalog, product detail (reviews,
// questions, compatibility), site-wide review aggregate, the
// simulated checkout, and order summaries.

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import { DEMO_PRODUCTS, demoProductsResponse } from "../fixtures/products";
import { demoOrderSummary } from "../fixtures/orders";
import { demoSessionId } from "../ids";
import { appBaseUrl } from "../paths";

export const shopHandlers: DemoHandler[] = [
  // Catalog (also consumed by the admin inventory page, which maps it
  // client-side — one fixture serves both).
  route("GET", "/resupply-api/shop/products", () =>
    json(demoProductsResponse()),
  ),

  // Bulk review aggregates (must precede the :id/reviews pattern in
  // intent, though the paths are disjoint).
  route("GET", "/resupply-api/shop/products/reviews/aggregates", (req) => {
    const ids = (req.query.get("productIds") ?? "").split(",").filter(Boolean);
    const aggregates: Record<string, { count: number; averageRating: number }> =
      {};
    for (const id of ids) {
      // Deterministic-ish pseudo aggregate so cards show stars.
      const seed = id.length;
      aggregates[id] = {
        count: 8 + (seed % 40),
        averageRating: Math.round((4.2 + (seed % 7) / 10) * 10) / 10,
      };
    }
    return json({ aggregates });
  }),

  // Per-product review list.
  route("GET", "/resupply-api/shop/products/:id/reviews", () =>
    json({
      items: [
        {
          id: "demo-rev-a",
          rating: 5,
          title: "Best sleep in years",
          body: "The fit guide nailed my size on the first try. Comfortable and quiet — I actually sleep through the night now.",
          authorDisplayName: "Jamie R.",
          createdAt: new Date(Date.now() - 9 * 864e5).toISOString(),
          verifiedPurchaser: true,
        },
        {
          id: "demo-rev-b",
          rating: 4,
          title: "Great, minor learning curve",
          body: "Took a couple nights to get used to, but the seal is excellent and reordering is effortless.",
          authorDisplayName: "Pat L.",
          createdAt: new Date(Date.now() - 21 * 864e5).toISOString(),
          verifiedPurchaser: true,
        },
      ],
      nextCursor: null,
      aggregate: {
        count: 27,
        averageRating: 4.6,
        distribution: { "1": 0, "2": 1, "3": 2, "4": 7, "5": 17 },
      },
    }),
  ),

  route("GET", "/resupply-api/shop/products/:id/questions", () =>
    json({
      questions: [
        {
          id: "demo-q-a",
          askerDisplayName: "Chris M.",
          questionBody: "Does this work with an AirSense 11?",
          answerBody:
            "Yes — it's fully compatible with the AirSense 10 and 11 series.",
          answeredAt: new Date(Date.now() - 6 * 864e5).toISOString(),
          createdAt: new Date(Date.now() - 7 * 864e5).toISOString(),
        },
      ],
    }),
  ),

  route("GET", "/resupply-api/shop/products/:id/compatibility", () =>
    json({
      compatibility: [
        {
          id: "demo-compat-1",
          machineManufacturer: "ResMed",
          machineModel: "AirSense 11 AutoSet",
          notes: null,
        },
        {
          id: "demo-compat-2",
          machineManufacturer: "ResMed",
          machineModel: "AirSense 10",
          notes: null,
        },
      ],
    }),
  ),

  route("GET", "/resupply-api/shop/products/compatibility", () =>
    json({
      explicitCompatibleProductIds: DEMO_PRODUCTS.slice(0, 6).map((p) => p.id),
      constrainedProductIds: DEMO_PRODUCTS.filter(
        (p) => p.category === "tubing" || p.category === "chamber",
      ).map((p) => p.id),
    }),
  ),

  route("GET", "/resupply-api/shop/reviews/site-aggregate", () =>
    json({ count: 1284, averageRating: 4.7 }),
  ),

  // Simulated checkout — returns a same-origin URL that lands on the
  // SPA's checkout-success page (no Stripe round-trip in the demo).
  route("POST", "/resupply-api/shop/checkout", () => {
    const sessionId = demoSessionId();
    const url = `${appBaseUrl()}shop/checkout-success?session_id=${sessionId}`;
    return json({ url, sessionId });
  }),

  // Order summary for the success page (and the admin order lookup).
  route("GET", "/resupply-api/shop/orders/:sessionId", (_req, { sessionId }) =>
    json(demoOrderSummary(sessionId)),
  ),

  // Back-in-stock notify (public).
  route("POST", "/resupply-api/shop/back-in-stock", () =>
    json({ ok: true, status: "inserted" }),
  ),

  // Sleep-apnea quiz lead capture.
  route("POST", "/resupply-api/shop/quiz-leads", () => json({ ok: true })),

  // Insurance estimate + lead capture (public forms).
  route("POST", "/resupply-api/shop/insurance-estimates", (req) => {
    const body = req.json<{ payerSlug?: string }>() ?? {};
    return json({
      ok: true,
      estimate: {
        slug: body.payerSlug ?? "blue-cross",
        label: "Independence Blue Cross",
        lowDollars: 0,
        highDollars: 45,
        note: "Most members with this plan pay $0–$45 out of pocket for a resupply once their deductible is met. This is a demo estimate.",
      },
    });
  }),
  route("POST", "/resupply-api/shop/insurance-leads", () =>
    json({ ok: true, delivered: true }),
  ),
];
