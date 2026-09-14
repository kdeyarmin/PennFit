import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  makeRequireAdminMock,
  type MockAdminCtx,
  MOCK_ORG_ID,
} from "../../test-helpers/auth-mocks";
const mocks = vi.hoisted(() => ({
  admin: { current: null as MockAdminCtx | null },
  preview: vi.fn(),
  approve: vi.fn(),
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mocks.admin),
);
vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: (orgId: string) => ({ orgId }),
}));
vi.mock("../../lib/csr-order/delivery-review", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../lib/csr-order/delivery-review")
  >()),
  previewDeliveryReview: mocks.preview,
  approveDeliveryReview: mocks.approve,
}));
import router from "./csr-delivery-reviews";
import { PricingError } from "../../lib/pricing/service";
const id = "00000000-0000-4000-8000-000000000001";
const base = `/admin/csr-order-requests/${id}/delivery-review`;
const body = { delivery: { country: "US", service: "Ground" } };
const app = () => express().use(express.json()).use(router);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.current = {
    userId: "manager-id",
    email: "manager@example.invalid",
    role: "admin",
    granularRole: "admin",
  };
  mocks.preview.mockResolvedValue({ reviewId: id });
  mocks.approve.mockResolvedValue({
    fulfillmentIds: [id],
    skipped: null,
    replayed: false,
  });
});
describe("manager delivery review boundaries", () => {
  it("denies ordinary CSR and anonymous attempts before reading private economics", async () => {
    mocks.admin.current = {
      userId: "csr",
      email: "csr@example.invalid",
      role: "agent",
      granularRole: "csr",
    };
    expect(
      (await request(app()).post(`${base}/preview`).send(body)).status,
    ).toBe(403);
    expect(
      (
        await request(app()).post(`${base}/${id}/approve`).send({
          revision: 1,
          reason: "Validated new delivery",
          allowException: true,
        })
      ).status,
    ).toBe(403);
    mocks.admin.current = null;
    expect(
      (await request(app()).post(`${base}/preview`).send(body)).status,
    ).toBe(401);
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.approve).not.toHaveBeenCalled();
  });
  it("uses the authenticated organization and manager, rejecting accepted price overrides", async () => {
    expect(
      (
        await request(app())
          .post(`${base}/preview`)
          .send({ ...body, unitAmountCents: 9999 })
      ).status,
    ).toBe(400);
    expect(
      (await request(app()).post(`${base}/preview`).send(body)).status,
    ).toBe(201);
    expect(mocks.preview).toHaveBeenCalledWith(
      { orgId: MOCK_ORG_ID },
      id,
      "manager-id",
      body,
    );
  });
  it("requires a reason and reports stale address conflicts without releasing the order", async () => {
    expect(
      (
        await request(app())
          .post(`${base}/${id}/approve`)
          .send({ revision: 1, reason: "" })
      ).status,
    ).toBe(400);
    expect(mocks.approve).not.toHaveBeenCalled();
    mocks.approve.mockRejectedValueOnce(
      new PricingError("delivery_snapshot_changed", 409),
    );
    const response = await request(app()).post(`${base}/${id}/approve`).send({
      revision: 1,
      reason: "Updated delivery verified",
      allowException: false,
    });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: "delivery_snapshot_changed" });
  });
});
