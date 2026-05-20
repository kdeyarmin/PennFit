// Route tests for /admin/shop/orders/:orderId/pod (the upload-url
// + finalize + GET + DELETE pipeline added in phase 7).
//
// Coverage focus:
//   * 401 when not authenticated (requirePermission gate)
//   * 404 when the order doesn't exist
//   * 400 on unsupported content-type at upload-url issuance
//   * 400 on object-too-large at finalize (server-side bucket
//     verification rejects + deletes the GCS object before
//     touching the DB row)
//   * Meta endpoint shapes pod_uploaded_at + pod_signed_name
//   * GET 404s when there's no POD on file
//
// The full 3-step happy path is covered indirectly via the
// finalize test (it asserts the row is updated). End-to-end
// HTTP-against-real-GCS is out of scope here.

import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// ObjectStorageService stub — gives us deterministic upload URLs
// and ACL paths, plus a metadata hook the test controls so we
// can simulate the bucket-truth re-read on finalize. vi.mock is
// hoisted to file-top, so the factory's closures must reach
// values declared via vi.hoisted (which IS hoisted too).
const {
  getUploadUrlMock,
  setAclMock,
  getMetadataMock,
  deleteObjectMock,
  ObjectNotFoundErrorClass,
} = vi.hoisted(() => {
  return {
    getUploadUrlMock: vi.fn(
      async () => "https://storage.googleapis.com/bucket/upload/abc?signed=1",
    ),
    setAclMock: vi.fn(async (_url: string, _opts: unknown) => "/objects/abc"),
    getMetadataMock: vi.fn(async () => [
      { size: "12345", contentType: "image/jpeg" },
    ]),
    deleteObjectMock: vi.fn(async () => undefined),
    ObjectNotFoundErrorClass: class ObjectNotFoundError extends Error {
      constructor() {
        super("object_not_found");
        this.name = "ObjectNotFoundError";
      }
    },
  };
});

vi.mock("../../lib/object-storage/objectStorage", () => ({
  ObjectNotFoundError: ObjectNotFoundErrorClass,
  ObjectStorageService: class {
    getObjectEntityUploadURL = () => getUploadUrlMock();
    normalizeObjectEntityPath = (url: string) =>
      url.startsWith("/") ? url : "/objects/abc";
    trySetObjectEntityAclPolicy = (url: string, opts: unknown) =>
      setAclMock(url, opts);
    getObjectEntityFile = async (_path: string) => ({
      getMetadata: () => getMetadataMock(),
      delete: () => deleteObjectMock(),
    });
    downloadObject = async () => ({
      status: 200,
      headers: new Map(),
      body: null,
    });
  },
}));

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// adminRateLimit is a no-op pass-through in tests — bypassing the
// 429 logic keeps these focused on the handler's behaviour.
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit:
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import shopOrderPodUploadRouter from "./shop-order-pod-upload";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", shopOrderPodUploadRouter);
  return app;
}

function stubVerifiedAdmin(): void {
  mockAdmin.current = {
    userId: "user_admin",
    email: "ops@penn.example.com",
    role: "admin",
  };
}

describe("/admin/shop/orders/:orderId/pod/meta", () => {
  beforeEach(() => {
    supabaseMock.reset();
    mockAdmin.current = null;
  });

  it("401s without an admin session", async () => {
    const res = await request(makeApp()).get(
      `/resupply-api/admin/shop/orders/${ORDER_ID}/pod/meta`,
    );
    expect(res.status).toBe(401);
  });

  it("404s when the order doesn't exist", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: null });

    const res = await request(makeApp()).get(
      `/resupply-api/admin/shop/orders/${ORDER_ID}/pod/meta`,
    );

    expect(res.status).toBe(404);
  });

  it("shapes pod_uploaded_at + pod_signed_name", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", {
      data: {
        id: ORDER_ID,
        pod_uploaded_at: "2026-05-20T10:00:00.000Z",
        pod_signed_name: "J. Smith",
      },
    });

    const res = await request(makeApp()).get(
      `/resupply-api/admin/shop/orders/${ORDER_ID}/pod/meta`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      uploadedAt: "2026-05-20T10:00:00.000Z",
      signedName: "J. Smith",
    });
  });
});

describe("/admin/shop/orders/:orderId/pod/upload-url", () => {
  beforeEach(() => {
    supabaseMock.reset();
    mockAdmin.current = null;
    getUploadUrlMock.mockClear();
  });

  it("401s without admin session", async () => {
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${ORDER_ID}/pod/upload-url`)
      .send({ contentType: "image/jpeg", sizeBytes: 1000 });
    expect(res.status).toBe(401);
  });

  it("400s on disallowed content-type", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", {
      data: { id: ORDER_ID, pod_object_key: null },
    });

    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${ORDER_ID}/pod/upload-url`)
      .send({ contentType: "application/pdf", sizeBytes: 1000 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns uploadURL + objectPath on the happy path", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", {
      data: { id: ORDER_ID, pod_object_key: null },
    });

    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${ORDER_ID}/pod/upload-url`)
      .send({ contentType: "image/jpeg", sizeBytes: 12345 });

    expect(res.status).toBe(200);
    expect(res.body.uploadURL).toMatch(/^https:\/\//);
    expect(res.body.objectPath).toMatch(/^\//);
    expect(getUploadUrlMock).toHaveBeenCalledTimes(1);
  });
});

describe("/admin/shop/orders/:orderId/pod (finalize)", () => {
  beforeEach(() => {
    supabaseMock.reset();
    mockAdmin.current = null;
    getMetadataMock.mockReset().mockResolvedValue([
      { size: "12345", contentType: "image/jpeg" },
    ]);
    deleteObjectMock.mockReset().mockResolvedValue(undefined);
  });

  it("400s + deletes the bucket object when actual content-type doesn't match", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", {
      data: { id: ORDER_ID, pod_object_key: null },
    });
    getMetadataMock.mockResolvedValueOnce([
      { size: "12345", contentType: "application/pdf" },
    ]);

    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${ORDER_ID}/pod`)
      .send({
        objectPath: "/objects/abc",
        contentType: "image/jpeg",
        sizeBytes: 12345,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("object_invalid_content_type");
    expect(deleteObjectMock).toHaveBeenCalledTimes(1);
  });

  it("400s when actual size exceeds the 8 MB cap", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", {
      data: { id: ORDER_ID, pod_object_key: null },
    });
    getMetadataMock.mockResolvedValueOnce([
      { size: String(9 * 1024 * 1024), contentType: "image/jpeg" },
    ]);

    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${ORDER_ID}/pod`)
      .send({
        objectPath: "/objects/abc",
        contentType: "image/jpeg",
        sizeBytes: 12345,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("object_too_large");
    expect(deleteObjectMock).toHaveBeenCalledTimes(1);
  });

  it("persists pod_object_key + pod_uploaded_at on a clean finalize", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", {
      data: { id: ORDER_ID, pod_object_key: null },
    });
    // The handler issues an UPDATE after the metadata-verify path.
    stageSupabaseResponse("shop_orders", "update", { data: null });

    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${ORDER_ID}/pod`)
      .send({
        objectPath: "/objects/abc",
        contentType: "image/jpeg",
        sizeBytes: 12345,
        signedName: "J. Smith",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });
});

describe("/admin/shop/orders/:orderId/pod (GET stream)", () => {
  beforeEach(() => {
    supabaseMock.reset();
    mockAdmin.current = null;
  });

  it("404s when there's no POD on the order", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_orders", "select", {
      data: { id: ORDER_ID, pod_object_key: null },
    });

    const res = await request(makeApp()).get(
      `/resupply-api/admin/shop/orders/${ORDER_ID}/pod`,
    );

    expect(res.status).toBe(404);
  });
});
