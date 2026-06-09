// Tests for syncCustomerAfterCheckout phone capture.
//
// Stripe collects the phone at Checkout (phone_number_collection); the
// completed session carries it on customer_details.phone. The webhook
// now persists it to shop_customers.phone_e164 (go-forward), normalized
// to E.164, without clobbering an existing value — so an inbound voice
// caller can later be matched to their storefront account.
//
// We exercise syncCustomerAfterCheckout directly (exported for this,
// like sendOrderConfirmationIfFirst) rather than through the full
// webhook entry point, which would require Stripe signature construction.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// readDefaultPaymentMethod hits the Stripe API — stub it to null; these
// tests are about phone capture, not the card crumbs.
vi.mock("./customer", async () => {
  const actual =
    await vi.importActual<typeof import("./customer")>("./customer");
  return {
    ...actual,
    readDefaultPaymentMethod: vi.fn(async () => null),
  };
});

import { syncCustomerAfterCheckout } from "./webhook-handler";
import type { StripeConfig } from "./config";

const CONFIG = {} as unknown as StripeConfig;

function makeSession(
  over: Partial<Stripe.Checkout.Session> = {},
): Stripe.Checkout.Session {
  return {
    id: "cs_test_phone",
    object: "checkout.session",
    customer: "cus_123",
    metadata: { customer_id: "user_alice" },
    customer_details: {
      email: "alice@example.com",
      phone: "+12155550000",
    } as unknown as Stripe.Checkout.Session["customer_details"],
    ...over,
  } as unknown as Stripe.Checkout.Session;
}

describe("syncCustomerAfterCheckout — phone capture", () => {
  beforeEach(() => {
    supabaseMock.reset();
  });

  it("persists a normalized phone_e164 on the INSERT branch (first-time customer)", async () => {
    stageSupabaseResponse("shop_customers", "select", { data: null });
    stageSupabaseResponse("shop_customers", "upsert", { error: null });

    await syncCustomerAfterCheckout(
      CONFIG,
      makeSession({
        customer_details: {
          email: "alice@example.com",
          // bare 10-digit → normalized to +1XXXXXXXXXX
          phone: "2155550000",
        } as unknown as Stripe.Checkout.Session["customer_details"],
      }),
      undefined,
    );

    const upserts = getSupabaseWritePayloads(
      "shop_customers",
      "upsert",
    ) as Array<Record<string, unknown>>;
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      customer_id: "user_alice",
      phone_e164: "+12155550000",
    });
  });

  it("sets phone_e164 on UPDATE only when the existing value is empty", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        shipping_address_json: null,
        stripe_customer_id: "cus_123",
        phone_e164: null,
      },
    });
    stageSupabaseResponse("shop_customers", "update", { error: null });

    await syncCustomerAfterCheckout(CONFIG, makeSession(), undefined);

    const updates = getSupabaseWritePayloads(
      "shop_customers",
      "update",
    ) as Array<Record<string, unknown>>;
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ phone_e164: "+12155550000" });
  });

  it("does NOT overwrite an existing phone_e164 on UPDATE (don't clobber)", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        shipping_address_json: null,
        stripe_customer_id: "cus_123",
        phone_e164: "+19998887777",
      },
    });
    stageSupabaseResponse("shop_customers", "update", { error: null });

    await syncCustomerAfterCheckout(CONFIG, makeSession(), undefined);

    const updates = getSupabaseWritePayloads(
      "shop_customers",
      "update",
    ) as Array<Record<string, unknown>>;
    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toHaveProperty("phone_e164");
  });

  it("writes phone_e164: null on INSERT when Stripe collected no phone", async () => {
    stageSupabaseResponse("shop_customers", "select", { data: null });
    stageSupabaseResponse("shop_customers", "upsert", { error: null });

    await syncCustomerAfterCheckout(
      CONFIG,
      makeSession({
        customer_details: {
          email: "alice@example.com",
        } as unknown as Stripe.Checkout.Session["customer_details"],
      }),
      undefined,
    );

    const upserts = getSupabaseWritePayloads(
      "shop_customers",
      "upsert",
    ) as Array<Record<string, unknown>>;
    expect(upserts[0]).toMatchObject({ phone_e164: null });
  });
});
