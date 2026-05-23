// Route tests for the patient-facing POD endpoint
// (GET /shop/orders/:sessionId/pod) added in phase 7b.
//
// Coverage:
//   * 400 on an invalid session-id shape (defends against probing)
//   * 404 when the order isn't in shop_orders
//   * 404 when the order has no POD on file
//   * 500 with shaped error on a Supabase lookup failure (no PHI
//     leak through the response body)
//
// Image bytes streaming isn't exercised here — that goes through
// ObjectStorageService.downloadObject which we mock to a no-body
// 200 response.

import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { ObjectNotFoundErrorClass } = vi.hoisted(() => ({
  ObjectNotFoundErrorClass: class ObjectNotFoundError extends Error {
    constructor() {
      super("object_not_found");
      this.name = "ObjectNotFoundError";
    }
  },
}));

vi.mock("../../lib/object-storage/objectStorage", () => ({
  ObjectNotFoundError: ObjectNotFoundErrorClass,
  ObjectStorageService: class {
    getObjectEntityFile = async (_path: string) => ({
      getMetadata: async () => [
        { size: "1024", contentType: "image/jpeg" },
      ],
      delete: async () => undefined,
    });
    downloadObject = async () => ({
      status: 200,
      headers: new Map([["content-type", "image/jpeg"]]),
      body: null,
    });
  },
}));

import orderPodRouter from "./order-pod";

const SESSION_OK = "cs_test_" + "a".repeat(40);
const SESSION_BAD = "not_a_session";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", orderPodRouter);
  return app;
}

describe("GET /shop/orders/:sessionId/pod", () => {
  beforeEach(() => {
    supabaseMock.reset();
  });

  it("400s on a session-id that doesn't match the cs_(test|live)_ shape", async () => {
    const res = await request(makeApp()).get(
      `/resupply-api/shop/orders/${SESSION_BAD}/pod`,
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_session_id" });
  });

  it("404s when the session id has no shop_orders row", async () => {
    stageSupabaseResponse("shop_orders", "select", { data: null });
    const res = await request(makeApp()).get(
      `/resupply-api/shop/orders/${SESSION_OK}/pod`,
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("404s when the order exists but has no POD on file", async () => {
    stageSupabaseResponse("shop_orders", "select", {
      data: { pod_object_key: null },
    });
    const res = await request(makeApp()).get(
      `/resupply-api/shop/orders/${SESSION_OK}/pod`,
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("returns lookup_failed (500) with no PHI when Supabase lookup errors", async () => {
    stageSupabaseResponse("shop_orders", "select", {
      error: { message: "boom" },
    });
    const res = await request(makeApp()).get(
      `/resupply-api/shop/orders/${SESSION_OK}/pod`,
    );
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "lookup_failed" });
    // Defensive: the response body must NOT echo the session id or
    // any inner error detail back to the caller.
    expect(JSON.stringify(res.body)).not.toContain(SESSION_OK);
    expect(JSON.stringify(res.body)).not.toContain("boom");
  });

  it("succeeds with private/no-store cache header when bytes flow", async () => {
    stageSupabaseResponse("shop_orders", "select", {
      data: { pod_object_key: "/objects/pod-abc" },
    });
    const res = await request(makeApp()).get(
      `/resupply-api/shop/orders/${SESSION_OK}/pod`,
    );
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/private/);
    expect(res.headers["cache-control"]).toMatch(/no-store/);
    expect(res.headers["content-disposition"]).toMatch(/inline/);
  });
});
