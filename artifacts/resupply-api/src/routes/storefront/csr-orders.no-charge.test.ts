// The CSR order flow collects a SIGNATURE, never a payment.
//
// This flow used to end in Stripe Hosted Checkout ("sign & pay"). Patients
// are insurance-only now, so the charge leg was removed and the order is
// billed to the payer through the claims pipeline instead. The resupply
// draft-approval path funnels into this same flow, so a reintroduced
// charge here would silently put a pay wall in front of every approved
// resupply — worth pinning.
//
// Driven through the real router: what matters is that no payment
// endpoint RESPONDS, and that the link handed to the patient points at
// the signing page.

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import { installSupabaseMock } from "../../test-helpers/supabase-mock";

installSupabaseMock();

vi.mock("../../lib/auth-deps", () => ({
  getAuthDeps: () => ({ publicBaseUrl: "https://example.test" }),
}));

import csrOrdersRouter from "./csr-orders";
import { buildCsrOrderSigningLink } from "../../lib/csr-order/order";

// The signing link is HMAC-signed; the token module refuses to sign
// without a key. Any 32+ decoded bytes will do — we assert the URL shape,
// not the signature.
const ORIGINAL_HMAC_KEY = process.env.RESUPPLY_LINK_HMAC_KEY;
beforeAll(() => {
  process.env.RESUPPLY_LINK_HMAC_KEY = Buffer.alloc(48, 7).toString("base64");
});
afterAll(() => {
  if (ORIGINAL_HMAC_KEY === undefined) {
    delete process.env.RESUPPLY_LINK_HMAC_KEY;
  } else {
    process.env.RESUPPLY_LINK_HMAC_KEY = ORIGINAL_HMAC_KEY;
  }
});

function app(): Express {
  const a = express();
  a.use(express.json());
  a.use("/api", csrOrdersRouter);
  return a;
}

describe("the public CSR-order surface exposes no payment endpoint", () => {
  it("404s the checkout endpoint the flow used to have", async () => {
    // The single most important assertion in this file: the route that
    // minted a Stripe Checkout Session must not answer at all.
    const res = await request(app())
      .post("/api/csr-orders/checkout")
      .send({ token: "anything" });
    expect(res.status).toBe(404);
  });

  it("404s a payment-intent style endpoint too", async () => {
    const res = await request(app())
      .post("/api/csr-orders/pay")
      .send({ token: "anything" });
    expect(res.status).toBe(404);
  });

  it("still answers view — reached, and rejecting a missing token", async () => {
    // 400 (not 404) proves the endpoint exists and its guard ran, without
    // needing a valid signed token.
    const res = await request(app()).get("/api/csr-orders/view");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "missing_token" });
  });

  it("still answers sign — reached, and rejecting an empty body", async () => {
    const res = await request(app()).post("/api/csr-orders/sign").send({});
    expect(res.status).toBe(400);
  });
});

describe("the patient is handed a signing link, not a pay link", () => {
  it("builds an /order-sign URL", async () => {
    const link = await buildCsrOrderSigningLink(
      "11111111-1111-4111-8111-111111111111",
      1,
    );
    expect(link).toContain("https://example.test/order-sign?token=");
    expect(link).not.toContain("/order-pay");
  });

  it("carries a token the signing page can present", async () => {
    const link = await buildCsrOrderSigningLink(
      "11111111-1111-4111-8111-111111111111",
      2,
    );
    const token = new URL(link).searchParams.get("token");
    expect(token).toBeTruthy();
    expect(token!.length).toBeGreaterThan(20);
  });
});
