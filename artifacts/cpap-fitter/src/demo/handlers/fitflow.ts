// Fit-flow handlers: consent lead capture, the mask recommendation
// engine, the mask catalog, the fitter-complete enrollment ping, and
// the final order submission. (Capture + measure run MediaPipe in the
// browser and make no server calls.)

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import { demoMaskCatalog, demoRecommendation } from "../fixtures/masks";
import { demoStore } from "../fixtures/store";
import { NOW_ISO } from "../fixtures/dates";

export const fitflowHandlers: DemoHandler[] = [
  // /consent → capture the lead (best-effort on the real server too).
  route("POST", "/resupply-api/shop/fitter-leads", () => json({ ok: true })),

  // /results → mask recommendation + full catalog.
  route("POST", "/api/recommendations", () => json(demoRecommendation())),
  route("GET", "/api/masks", () => json(demoMaskCatalog())),

  // /results → enroll the completed lead in the supply campaign.
  route("POST", "/resupply-api/shop/fitter-complete", () =>
    json({ ok: true, enrolled: true }),
  ),

  // /order → place the order. Record it so it shows up in the demo
  // customer's order history, then return the confirmation.
  route("POST", "/api/orders", (req) => {
    const body =
      req.json<{
        chosenMask?: { name?: string; manufacturer?: string };
      }>() ?? {};
    const orderReference = `PENN-DEMO-${Math.floor(1000 + Math.random() * 9000)}`;
    demoStore.recordPlacedOrder({
      id: `demo-order-${Date.now()}`,
      sessionId: `demo_sess_${Math.random().toString(36).slice(2, 10)}`,
      status: "paid",
      amountTotalCents: 0,
      currency: "usd",
      createdAt: NOW_ISO(),
      paidAt: NOW_ISO(),
      shippingAddress: demoStore.getProfile().shippingAddress
        ? {
            line1: demoStore.getProfile().shippingAddress!.line1,
            line2: demoStore.getProfile().shippingAddress!.line2 ?? null,
            city: demoStore.getProfile().shippingAddress!.city,
            state: demoStore.getProfile().shippingAddress!.state,
            postalCode: demoStore.getProfile().shippingAddress!.postalCode,
            country: "US",
          }
        : null,
      tracking: null,
      shippedAt: null,
      deliveredAt: null,
      podUploadedAt: null,
      canEditAddress: true,
      items: [
        {
          productId: "demo-mask-n20",
          productName: body.chosenMask?.name ?? "ResMed AirFit N20",
          quantity: 1,
          unitAmountCents: null,
          currency: "usd",
        },
      ],
    });
    return json({
      success: true,
      orderReference,
      deliveredAt: NOW_ISO(),
      message:
        "Your order has been sent to Penn Home Medical Supply. A team member will contact you within 1 business day to confirm and arrange shipping. (This is a demo — no real order was placed.)",
    });
  }),
];
