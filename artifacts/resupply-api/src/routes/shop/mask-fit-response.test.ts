// Tests for the public mask-fit capture endpoint (RT #22a).

import { describe, it, expect, beforeEach, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

vi.mock("@workspace/resupply-secrets", () => ({
  getLinkHmacKey: () =>
    Buffer.from("test-mask-fit-hmac-key-0123456789", "utf8"),
}));

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import maskFitResponseRouter from "./mask-fit-response";
import { signMaskFitToken } from "../../lib/mask-fit-token";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(maskFitResponseRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
});

describe("POST /shop/orders/mask-fit", () => {
  it("400s an invalid token", async () => {
    const res = await request(makeApp())
      .post("/shop/orders/mask-fit")
      .send({ token: "garbage.token" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_token");
  });

  it("404s when the order doesn't resolve", async () => {
    stageSupabaseResponse("shop_orders", "select", { data: null, error: null });
    const token = signMaskFitToken("missing-order", "leaking");
    const res = await request(makeApp())
      .post("/shop/orders/mask-fit")
      .send({ token });
    expect(res.status).toBe(404);
  });

  it("records the outcome for a valid token + existing order", async () => {
    stageSupabaseResponse("shop_orders", "select", {
      data: { id: "order-1", status: "delivered" },
      error: null,
    });
    stageSupabaseResponse("mask_fit_outcomes", "insert", {
      data: [{ id: "mfo-1" }],
      error: null,
    });
    const token = signMaskFitToken("order-1", "uncomfortable");
    const res = await request(makeApp())
      .post("/shop/orders/mask-fit")
      .send({ token, comment: "leaks at the bridge of my nose" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("400s a malformed body", async () => {
    const res = await request(makeApp())
      .post("/shop/orders/mask-fit")
      .send({ nope: true });
    expect(res.status).toBe(400);
  });
});
