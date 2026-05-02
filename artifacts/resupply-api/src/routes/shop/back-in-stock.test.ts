// Unit tests for POST /shop/back-in-stock — covers the happy path,
// validation, honeypot, and rate limit. The DB write is mocked at
// the helper boundary so we don't need a live pool.

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../lib/back-in-stock-record", () => ({
  recordBackInStockSignup: vi.fn(async () => ({ status: "inserted" as const })),
}));

import backInStockRouter, {
  _resetBackInStockRateBucketForTests,
} from "./back-in-stock";
import { recordBackInStockSignup } from "../../lib/back-in-stock-record";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(backInStockRouter);
  return app;
}

const VALID = {
  productId: "prod_ABC123",
  email: "patient@example.com",
};

describe("POST /shop/back-in-stock", () => {
  beforeEach(() => {
    _resetBackInStockRateBucketForTests();
    vi.mocked(recordBackInStockSignup).mockClear();
    vi.mocked(recordBackInStockSignup).mockResolvedValue({
      status: "inserted",
    });
  });

  it("inserts a row and returns ok", async () => {
    const app = makeApp();
    const res = await request(app).post("/shop/back-in-stock").send(VALID);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: "inserted" });
    expect(recordBackInStockSignup).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "prod_ABC123",
        email: "patient@example.com",
      }),
    );
  });

  it("treats duplicate as a clean ok", async () => {
    vi.mocked(recordBackInStockSignup).mockResolvedValue({
      status: "duplicate",
    });
    const app = makeApp();
    const res = await request(app).post("/shop/back-in-stock").send(VALID);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("duplicate");
  });

  it("rejects a non-Stripe product id", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/shop/back-in-stock")
      .send({ ...VALID, productId: "not-a-stripe-id" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(recordBackInStockSignup).not.toHaveBeenCalled();
  });

  it("rejects an obviously invalid email", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/shop/back-in-stock")
      .send({ ...VALID, email: "notanemail" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("lowercases the email before persisting", async () => {
    const app = makeApp();
    await request(app)
      .post("/shop/back-in-stock")
      .send({ ...VALID, email: "MIXEDCase@Example.COM" });
    expect(recordBackInStockSignup).toHaveBeenCalledWith(
      expect.objectContaining({ email: "mixedcase@example.com" }),
    );
  });

  it("honeypot trip returns 200 but skips DB write", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/shop/back-in-stock")
      .send({ ...VALID, website: "spam.example.com" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(recordBackInStockSignup).not.toHaveBeenCalled();
  });

  it("rate-limits after the 10th submit from the same ip", async () => {
    const app = makeApp();
    for (let i = 0; i < 10; i++) {
      const r = await request(app).post("/shop/back-in-stock").send({
        productId: "prod_ABC123",
        email: `patient${i}@example.com`,
      });
      expect(r.status).toBe(200);
    }
    const blocked = await request(app)
      .post("/shop/back-in-stock")
      .send({ productId: "prod_ABC123", email: "patient11@example.com" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("rate_limited");
  });
});
