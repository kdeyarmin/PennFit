import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";

const { mockAdmin, record } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
  record: vi.fn(),
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminWriteRateLimiter: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));
vi.mock("../../middlewares/idempotency", () => ({
  withIdempotency:
    () =>
    (
      _req: express.Request,
      _res: express.Response,
      next: express.NextFunction,
    ) =>
      next(),
}));
vi.mock("../../lib/fulfillments/record-shipment-evidence", () => ({
  recordShipmentEvidence: record,
}));
vi.mock("../../lib/episodes/close-episode", () => ({ closeEpisode: vi.fn() }));
import router from "./fulfillment-shipments";

const endpoint =
  "/admin/fulfillments/aaaaaaaa-0000-4000-8000-000000000001/mark-shipped";
const app = express().use(express.json()).use(router);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-05T18:00:00Z"));
  mockAdmin.current = {
    userId: "staff",
    email: "staff@example.com",
    role: "agent",
  };
  record
    .mockReset()
    .mockResolvedValue({ status: "applied", episodeClosed: true });
});
afterEach(() => vi.useRealTimers());

describe("manual shipment dates", () => {
  it.each(["2026-02-29", "2026-02-31", "2026-13-01"])(
    "rejects an impossible ship date %s before recording evidence",
    async (shippedAt) => {
      const response = await request(app).post(endpoint).send({ shippedAt });
      expect(response.status).toBe(400);
      expect(record).not.toHaveBeenCalled();
    },
  );

  it.each(["2026-02-31", "2026-13-01", "2026-03-07", "2026-03-02"])(
    "rejects an impossible, future, or pre-shipment delivery date %s",
    async (deliveredAt) => {
      const response = await request(app).post(endpoint).send({
        shippedAt: "2026-03-03",
        deliveredAt,
      });
      expect(response.status).toBe(400);
      expect(record).not.toHaveBeenCalled();
    },
  );

  it("records valid ship and delivery dates at midday UTC", async () => {
    const response = await request(app).post(endpoint).send({
      shippedAt: "2026-03-03",
      deliveredAt: "2026-03-05",
    });
    expect(response.status).toBe(200);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        shippedAt: new Date("2026-03-03T12:00:00Z"),
        deliveredAt: new Date("2026-03-05T12:00:00Z"),
      }),
    );
  });
});
