// Tests for POST /shop/back-in-stock — validation, honeypot, rate limit,
// tenant resolution, and happy-path signup recording.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const recordMock = vi.fn();
vi.mock("../../lib/back-in-stock-record", () => ({
  recordBackInStockSignup: (...args: unknown[]) => recordMock(...args),
}));

const resolveBrandOrgMock = vi.fn();
vi.mock("../../lib/tenant-branding", () => ({
  resolveBrandOrgIdByHost: (...args: unknown[]) => resolveBrandOrgMock(...args),
}));

vi.mock("../../lib/request-host", () => ({
  requestHost: () => "pennpaps.com",
}));

import backInStockRouter, {
  _resetBackInStockRateBucketForTests,
} from "./back-in-stock";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", backInStockRouter);
  return app;
}

const VALID = {
  productId: "MASK-NASAL-M",
  email: "patient@example.com",
};

beforeEach(() => {
  recordMock.mockReset();
  recordMock.mockResolvedValue({ status: "inserted" });
  resolveBrandOrgMock.mockReset();
  resolveBrandOrgMock.mockResolvedValue("org-penn");
  _resetBackInStockRateBucketForTests();
});

describe("POST /shop/back-in-stock", () => {
  it("accepts a valid SKU signup and records under the host tenant", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/shop/back-in-stock")
      .send(VALID);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: "inserted" });
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock.mock.calls[0]?.[0]).toMatchObject({
      productId: "MASK-NASAL-M",
      email: "patient@example.com",
      orgId: "org-penn",
    });
  });

  it("rejects Stripe-era prod_ ids with 400", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/shop/back-in-stock")
      .send({ ...VALID, productId: "prod_abc123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid email with 400", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/shop/back-in-stock")
      .send({ ...VALID, email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("short-circuits with a fake 200 when the honeypot is filled", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/shop/back-in-stock")
      .send({ ...VALID, website: "http://spam.example" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: "queued" });
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("returns 503 when the host does not resolve to a tenant", async () => {
    resolveBrandOrgMock.mockResolvedValueOnce(null);
    const res = await request(makeApp())
      .post("/resupply-api/shop/back-in-stock")
      .send(VALID);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("tenant_unavailable");
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("rate-limits after 10 submissions from the same IP", async () => {
    const app = makeApp();
    for (let i = 0; i < 10; i++) {
      const ok = await request(app)
        .post("/resupply-api/shop/back-in-stock")
        .send({ ...VALID, email: `user${i}@example.com` });
      expect(ok.status).toBe(200);
    }
    const limited = await request(app)
      .post("/resupply-api/shop/back-in-stock")
      .send({ ...VALID, email: "one-more@example.com" });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("rate_limited");
  });
});
