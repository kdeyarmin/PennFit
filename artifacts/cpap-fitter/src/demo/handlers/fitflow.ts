// Fit-flow handlers: consent lead capture, the mask recommendation
// engine, the mask catalog, the fitter-complete enrollment ping, and
// the final order submission. (Capture + measure run MediaPipe in the
// browser and make no server calls.)

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import { demoMaskCatalog, demoRecommendation } from "../fixtures/masks";
import { demoStore } from "../fixtures/store";
import { NOW_ISO } from "../fixtures/dates";
import { demoOrderReference, demoSessionId } from "../ids";

export const fitflowHandlers: DemoHandler[] = [
  // /consent → capture the lead (best-effort on the real server too).
  route("POST", "/resupply-api/shop/fitter-leads", () => json({ ok: true })),

  // /results → mask recommendation + full catalog. The real endpoint
  // is /api/recommend (invitation-gated on the server); intercepting it
  // here keeps the demo sandbox walkthrough working without a real
  // invite token.
  route("POST", "/api/recommend", () => json(demoRecommendation())),
  route("GET", "/api/masks", () => json(demoMaskCatalog())),

  // /results → enroll the completed lead in the supply campaign.
  route("POST", "/resupply-api/shop/fitter-complete", () =>
    json({ ok: true, enrolled: true }),
  ),

  // /fit-request → file a fit request. This is how a fitting ENDS under
  // `fitter.lead_capture_only` (the default): the patient sends their
  // details or asks for a call, and staff place the order. There is
  // deliberately no reference number in the response — it is not an
  // order — so the demo returns exactly what the real route does.
  route("POST", "/resupply-api/shop/fitter-requests", (req) => {
    const body = req.json<{ requestType?: string }>() ?? {};
    return json({
      ok: true,
      requestType: body.requestType ?? "full_details",
      confirmationEmailed: true,
    });
  }),

  // /order → place the order. Reachable only for a tenant that turned
  // `fitter.lead_capture_only` OFF; kept so that path stays demoable.
  // Record it so it shows up in the demo customer's order history, then
  // return the confirmation.
  route("POST", "/api/orders", (req) => {
    const body =
      req.json<{
        chosenMask?: { name?: string; manufacturer?: string };
      }>() ?? {};
    const orderReference = demoOrderReference();
    demoStore.recordPlacedOrder({
      id: `demo-order-${Date.now()}`,
      sessionId: demoSessionId(),
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
      fulfillmentMethod: "ship",
      pickup: null,
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
        "Your order has been sent to CareMetric Breathe. A team member will contact you within 1 business day to confirm and arrange shipping. (This is a demo — no real order was placed.)",
    });
  }),
];
