// Seed data for order history, order summaries, and order tracking.

import type {
  OrderHistoryResponse,
  OrderSummaryResponse,
} from "@/lib/shop-api";
import { daysAgo } from "./dates";

export function demoOrderHistory(): OrderHistoryResponse {
  return {
    orders: [
      {
        id: "demo-order-1",
        sessionId: "demo_sess_1001",
        status: "paid",
        amountTotalCents: 8900,
        currency: "usd",
        createdAt: daysAgo(12),
        paidAt: daysAgo(12),
        shippingAddress: {
          line1: "1200 Market Street",
          line2: "Apt 4B",
          city: "Philadelphia",
          state: "PA",
          postalCode: "19107",
          country: "US",
        },
        tracking: {
          carrier: "UPS",
          number: "1Z999AA10123456784",
          url: "https://www.ups.com/track?tracknum=1Z999AA10123456784",
        },
        shippedAt: daysAgo(10),
        deliveredAt: daysAgo(8),
        podUploadedAt: daysAgo(8),
        canEditAddress: false,
        fulfillmentMethod: "ship",
        pickup: null,
        items: [
          {
            productId: "demo-prod-resupply-bundle",
            productName: "Complete Resupply Bundle — Nasal",
            quantity: 1,
            unitAmountCents: 8900,
            currency: "usd",
          },
        ],
      },
      {
        id: "demo-order-2",
        sessionId: "demo_sess_1002",
        status: "paid",
        amountTotalCents: 2999,
        currency: "usd",
        createdAt: daysAgo(74),
        paidAt: daysAgo(74),
        shippingAddress: {
          line1: "1200 Market Street",
          line2: "Apt 4B",
          city: "Philadelphia",
          state: "PA",
          postalCode: "19107",
          country: "US",
        },
        tracking: {
          carrier: "UPS",
          number: "1Z999AA10198765432",
          url: "https://www.ups.com/track?tracknum=1Z999AA10198765432",
        },
        shippedAt: daysAgo(72),
        deliveredAt: daysAgo(70),
        podUploadedAt: null,
        canEditAddress: false,
        fulfillmentMethod: "ship",
        pickup: null,
        items: [
          {
            productId: "demo-prod-n20-cushion",
            productName: "AirFit N20 Nasal Cushion",
            quantity: 1,
            unitAmountCents: 2999,
            currency: "usd",
          },
        ],
      },
    ],
    nextCursor: null,
  };
}

/**
 * Build an order summary for the checkout-success page. The session id
 * is echoed back; for the seeded historical orders we return their
 * real contents, otherwise we synthesize a freshly-placed order.
 */
export function demoOrderSummary(sessionId: string): OrderSummaryResponse {
  if (sessionId === "demo_sess_1001") {
    return {
      sessionId,
      status: "complete",
      paymentStatus: "paid",
      amountTotalCents: 8900,
      currency: "usd",
      lineItems: [
        {
          name: "Complete Resupply Bundle — Nasal",
          quantity: 1,
          amountSubtotalCents: 8900,
          priceId: "demo_price_8900",
          productId: "demo-prod-resupply-bundle",
          unitAmountCents: 8900,
          imageUrl: "/products/cushion-n20.webp",
        },
      ],
      shippingCity: "Philadelphia",
      shippingState: "PA",
      podUploadedAt: null,
    };
  }
  // Freshly-completed demo checkout.
  return {
    sessionId,
    status: "complete",
    paymentStatus: "paid",
    amountTotalCents: 2999,
    currency: "usd",
    lineItems: [
      {
        name: "AirFit N20 Nasal Cushion",
        quantity: 1,
        amountSubtotalCents: 2999,
        priceId: "demo_price_2999",
        productId: "demo-prod-n20-cushion",
        unitAmountCents: 2999,
        imageUrl: "/products/cushion-n20.webp",
      },
    ],
    shippingCity: "Philadelphia",
    shippingState: "PA",
    podUploadedAt: null,
  };
}

export interface DemoTrackResult {
  orderReference: string;
  mask: { name: string; manufacturer: string | null };
  createdAt: string;
  emailStatus: string | null;
  emailDeliveredAt: string | null;
}

export function demoTrackResult(orderReference: string): DemoTrackResult {
  return {
    orderReference: orderReference || "PENN-DEMO-2048",
    mask: { name: "ResMed AirFit N20", manufacturer: "ResMed" },
    createdAt: daysAgo(3),
    emailStatus: "sent",
    emailDeliveredAt: daysAgo(3),
  };
}
