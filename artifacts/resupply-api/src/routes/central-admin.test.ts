import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createCentralAdminRouter } from "./central-admin";

describe("central administration HTTP ingress", () => {
  it("bounds bodies and refuses unsupported transport before native reads", async () => {
    const getClient = vi.fn();
    const app = express();
    app.use(
      "/resupply-api/central-admin",
      createCentralAdminRouter({
        getClient,
        getEnv: (name) =>
          ({
            CAREMETRIC_ADMIN_ENABLED: "true",
            HUB_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
            CAREMETRIC_ADMIN_IDENTITY_MAP_JSON:
              '{"11111111-1111-4111-8111-111111111111":"22222222-2222-4222-8222-222222222222"}',
          })[name],
      }),
    );
    const url = "/resupply-api/central-admin/read";
    expect((await request(app).get(url)).status).toBe(405);
    expect((await request(app).options(url)).status).toBe(405);
    expect(
      (
        await request(app)
          .post(url)
          .set("Content-Type", "application/json")
          .send("x".repeat(2049))
      ).status,
    ).toBe(413);
    expect(
      (
        await request(app)
          .post(url)
          .set("Content-Type", "text/plain")
          .send("{}")
      ).status,
    ).toBe(415);
    expect(
      (
        await request(app)
          .post(url)
          .set("Content-Type", "application/json")
          .send({ operation: "overview" })
      ).status,
    ).toBe(401);
    expect(getClient).not.toHaveBeenCalled();
  });

  it("keeps default-off API responses distinct from the SPA fallback", async () => {
    const app = express();
    app.use(
      "/resupply-api/central-admin",
      createCentralAdminRouter({ getEnv: () => undefined }),
    );
    const response = await request(app)
      .post("/resupply-api/central-admin/read")
      .send({ operation: "capabilities" });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: { code: "unconfigured" } });
    expect(response.headers["cache-control"]).toContain("no-store");
  });
});
