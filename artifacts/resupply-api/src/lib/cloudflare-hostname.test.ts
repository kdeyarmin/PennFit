// Unit tests for the Cloudflare Custom Hostnames client (ADR 021).
// Uses an injected fetch + config so no env or network is required.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCustomHostname,
  deleteCustomHostname,
  getCustomHostname,
  isCloudflareConfigured,
  readCloudflareConfigOrNull,
  CloudflareError,
} from "./cloudflare-hostname";

const CONFIG = { apiToken: "tok", zoneId: "zone1" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function cfOk(result: unknown): Response {
  return jsonResponse({ success: true, errors: [], result });
}

afterEach(() => {
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ZONE_ID;
});

describe("readCloudflareConfigOrNull / isCloudflareConfigured", () => {
  it("returns null when either var is missing", () => {
    expect(readCloudflareConfigOrNull()).toBeNull();
    expect(isCloudflareConfigured()).toBe(false);
    process.env.CLOUDFLARE_API_TOKEN = "tok";
    expect(readCloudflareConfigOrNull()).toBeNull();
  });

  it("returns the config when both are set", () => {
    process.env.CLOUDFLARE_API_TOKEN = "tok";
    process.env.CLOUDFLARE_ZONE_ID = "zone1";
    expect(readCloudflareConfigOrNull()).toEqual(CONFIG);
    expect(isCloudflareConfigured()).toBe(true);
  });
});

describe("createCustomHostname", () => {
  it("maps an active ssl status to tls=active and posts the hostname", async () => {
    const fetchImpl = vi.fn(async () =>
      cfOk({
        id: "ch_1",
        hostname: "shop.acme.com",
        status: "active",
        ssl: { status: "active" },
      }),
    ) as unknown as typeof fetch;
    const out = await createCustomHostname("shop.acme.com", {
      config: CONFIG,
      fetchImpl,
    });
    expect(out).toEqual({
      id: "ch_1",
      tls: "active",
      hostnameStatus: "active",
      sslStatus: "active",
      validation: null,
    });
    // Posted to the zone's custom_hostnames with a bearer token.
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(String(url)).toContain("/zones/zone1/custom_hostnames");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("maps a pending ssl status to tls=pending and surfaces the DCV record", async () => {
    const fetchImpl = vi.fn(async () =>
      cfOk({
        id: "ch_2",
        hostname: "shop.acme.com",
        status: "pending",
        ssl: {
          status: "pending_validation",
          validation_records: [
            { txt_name: "_acme-challenge.shop.acme.com", txt_value: "abc123" },
          ],
        },
      }),
    ) as unknown as typeof fetch;
    const out = await createCustomHostname("shop.acme.com", {
      config: CONFIG,
      fetchImpl,
    });
    expect(out.tls).toBe("pending");
    expect(out.validation).toEqual({
      type: "txt",
      name: "_acme-challenge.shop.acme.com",
      value: "abc123",
    });
  });

  it("is idempotent: an 'already exists' error falls back to a lookup", async () => {
    const fetchImpl = vi
      .fn()
      // 1st call: POST create → 1406 already exists
      .mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            errors: [{ code: 1406, message: "exists" }],
            result: null,
          },
          400,
        ),
      )
      // 2nd call: GET list by hostname → existing
      .mockResolvedValueOnce(
        cfOk([
          {
            id: "ch_existing",
            hostname: "shop.acme.com",
            status: "active",
            ssl: { status: "active" },
          },
        ]),
      ) as unknown as typeof fetch;
    const out = await createCustomHostname("shop.acme.com", {
      config: CONFIG,
      fetchImpl,
    });
    expect(out.id).toBe("ch_existing");
    expect(out.tls).toBe("active");
  });

  it("throws CloudflareError on a non-duplicate API error", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          success: false,
          errors: [{ code: 9999, message: "boom" }],
          result: null,
        },
        400,
      ),
    ) as unknown as typeof fetch;
    await expect(
      createCustomHostname("shop.acme.com", { config: CONFIG, fetchImpl }),
    ).rejects.toBeInstanceOf(CloudflareError);
  });
});

describe("getCustomHostname", () => {
  it("maps an error ssl status to tls=failed", async () => {
    const fetchImpl = vi.fn(async () =>
      cfOk({
        id: "ch_3",
        hostname: "shop.acme.com",
        status: "active",
        ssl: { status: "validation_timed_out" },
      }),
    ) as unknown as typeof fetch;
    const out = await getCustomHostname("ch_3", { config: CONFIG, fetchImpl });
    expect(out.tls).toBe("failed");
  });
});

describe("deleteCustomHostname", () => {
  it("returns true on success", async () => {
    const fetchImpl = vi.fn(async () =>
      cfOk({ id: "ch_4" }),
    ) as unknown as typeof fetch;
    expect(
      await deleteCustomHostname("ch_4", { config: CONFIG, fetchImpl }),
    ).toBe(true);
  });
});
