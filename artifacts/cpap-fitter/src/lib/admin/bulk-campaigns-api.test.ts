// Tests for bulk-campaigns-api.ts — fetch wrappers for /admin/bulk-campaigns/*
//
// Coverage:
//   jsonFetch shared behaviour   — URL, credentials, Accept header, error handling
//   TICK_INTERVAL_SECONDS        — exported constant value
//   listBulkCampaigns            — GET /admin/bulk-campaigns
//   getBulkCampaign              — GET /admin/bulk-campaigns/:id
//   createBulkCampaignDraft      — POST /admin/bulk-campaigns/draft
//   cancelBulkCampaign           — POST /admin/bulk-campaigns/:id/cancel
//   startBulkCampaign            — POST /admin/bulk-campaigns/:id/start
//   pauseBulkCampaign            — POST /admin/bulk-campaigns/:id/pause
//   resumeBulkCampaign           — POST /admin/bulk-campaigns/:id/resume

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import { ApiError } from "@workspace/api-client-react/admin";

import {
  TICK_INTERVAL_SECONDS,
  listBulkCampaigns,
  getBulkCampaign,
  createBulkCampaignDraft,
  cancelBulkCampaign,
  startBulkCampaign,
  pauseBulkCampaign,
  resumeBulkCampaign,
} from "./bulk-campaigns-api";

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// TICK_INTERVAL_SECONDS constant
// ---------------------------------------------------------------------------

describe("TICK_INTERVAL_SECONDS", () => {
  test("is exported with value 10", () => {
    expect(TICK_INTERVAL_SECONDS).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// jsonFetch shared behaviour (via listBulkCampaigns)
// ---------------------------------------------------------------------------

describe("jsonFetch shared behaviour (via listBulkCampaigns)", () => {
  test("requests /resupply-api prefix on the URL", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ campaigns: [] }),
    });

    await listBulkCampaigns();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/bulk-campaigns");
  });

  test("sends Accept: application/json header", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ campaigns: [] }),
    });

    await listBulkCampaigns();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/json");
  });

  test("throws Error on non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({}),
    });

    await expect(listBulkCampaigns()).rejects.toThrow("403");
  });

  test("throws using message field from error JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ message: "invalid audience kind" }),
    });

    await expect(listBulkCampaigns()).rejects.toThrow("invalid audience kind");
  });

  test("throws using error field when message is absent", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      statusText: "Unprocessable",
      json: async () => ({ error: "missing_template_key" }),
    });

    await expect(listBulkCampaigns()).rejects.toThrow("missing_template_key");
  });

  test("falls back to status when JSON body is unparseable", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "ISE",
      json: async () => {
        throw new SyntaxError("no body");
      },
    });

    await expect(listBulkCampaigns()).rejects.toThrow("500");
  });

  test("calls fetch exactly once", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ campaigns: [] }),
    });

    await listBulkCampaigns();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// listBulkCampaigns
// ---------------------------------------------------------------------------

const SAMPLE_LIST_ITEM = {
  id: "camp-1",
  name: "CPAP resupply Q1",
  description: null,
  audienceKind: "all_active_shop_customers" as const,
  audiencePayer: null,
  channel: "email" as const,
  category: "service" as const,
  templateKey: "resupply-reminder-v2",
  throttlePerMinute: 60,
  status: "draft" as const,
  totalRecipients: 200,
  pendingRecipients: 200,
  suppressedCount: 5,
  sentCount: 0,
  failedCount: 0,
  createdAt: "2025-01-01T00:00:00Z",
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
};

describe("listBulkCampaigns", () => {
  test("requests /resupply-api/admin/bulk-campaigns", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ campaigns: [] }),
    });

    await listBulkCampaigns();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/bulk-campaigns");
  });

  test("returns the parsed campaigns array", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ campaigns: [SAMPLE_LIST_ITEM] }),
    });

    const result = await listBulkCampaigns();
    expect(result.campaigns).toHaveLength(1);
    expect(result.campaigns[0]!.name).toBe("CPAP resupply Q1");
    expect(result.campaigns[0]!.status).toBe("draft");
  });

  test("returns empty campaigns array when none exist", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ campaigns: [] }),
    });

    const result = await listBulkCampaigns();
    expect(result.campaigns).toEqual([]);
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "ISE",
      json: async () => ({}),
    });
    await expect(listBulkCampaigns()).rejects.toThrow("500");
  });
});

// ---------------------------------------------------------------------------
// getBulkCampaign
// ---------------------------------------------------------------------------

describe("getBulkCampaign", () => {
  const SAMPLE_DETAIL = {
    ...SAMPLE_LIST_ITEM,
    complianceAttestation: null,
    recipients: [
      {
        id: "rec-1",
        recipientKind: "shop_customer" as const,
        recipientId: "cust-1",
        recipientEmail: "patient@example.com",
        status: "pending" as const,
        suppressionReason: null,
      },
    ],
  };

  test("requests /resupply-api/admin/bulk-campaigns/:id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => SAMPLE_DETAIL,
    });

    await getBulkCampaign("camp-1");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/bulk-campaigns/camp-1");
  });

  test("URL-encodes the campaign id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => SAMPLE_DETAIL,
    });

    await getBulkCampaign("camp id/with special chars");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain(" ");
    expect(url).not.toContain("/resupply-api/admin/bulk-campaigns/camp id");
  });

  test("returns campaign detail including recipients", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => SAMPLE_DETAIL,
    });

    const result = await getBulkCampaign("camp-1");
    expect(result.id).toBe("camp-1");
    expect(result.recipients).toHaveLength(1);
    expect(result.recipients[0]!.recipientEmail).toBe("patient@example.com");
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({}),
    });
    await expect(getBulkCampaign("ghost")).rejects.toThrow("404");
  });
});

// ---------------------------------------------------------------------------
// createBulkCampaignDraft
// ---------------------------------------------------------------------------

describe("createBulkCampaignDraft", () => {
  const DRAFT_INPUT = {
    name: "Test Campaign",
    audienceKind: "all_active_patients" as const,
    category: "marketing" as const,
    templateKey: "template-v1",
  };

  test("posts to /resupply-api/admin/bulk-campaigns/draft", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        id: "camp-new",
        totals: { total: 100, pending: 95, suppressed: 5 },
      }),
    });

    await createBulkCampaignDraft(DRAFT_INPUT);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/bulk-campaigns/draft");
    expect(init.method).toBe("POST");
  });

  test("sends Content-Type: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        id: "camp-new",
        totals: { total: 0, pending: 0, suppressed: 0 },
      }),
    });

    await createBulkCampaignDraft(DRAFT_INPUT);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("serialises the draft input as JSON body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        id: "camp-new",
        totals: { total: 0, pending: 0, suppressed: 0 },
      }),
    });

    await createBulkCampaignDraft(DRAFT_INPUT);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(DRAFT_INPUT);
  });

  test("includes optional fields when provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        id: "camp-new",
        totals: { total: 0, pending: 0, suppressed: 0 },
      }),
    });

    const body = {
      ...DRAFT_INPUT,
      description: "Quarterly reminder",
      audiencePayer: "Aetna",
      throttlePerMinute: 30,
      complianceAttestation: "Approved by compliance team",
    };
    await createBulkCampaignDraft(body);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      description: "Quarterly reminder",
      audiencePayer: "Aetna",
      throttlePerMinute: 30,
    });
  });

  test("returns the campaign id and audience totals", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        id: "camp-created-abc",
        totals: { total: 500, pending: 490, suppressed: 10 },
      }),
    });

    const result = await createBulkCampaignDraft(DRAFT_INPUT);
    expect(result.id).toBe("camp-created-abc");
    expect(result.totals.total).toBe(500);
    expect(result.totals.suppressed).toBe(10);
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      statusText: "Unprocessable",
      json: async () => ({}),
    });
    await expect(createBulkCampaignDraft(DRAFT_INPUT)).rejects.toThrow("422");
  });
});

// ---------------------------------------------------------------------------
// cancelBulkCampaign
// ---------------------------------------------------------------------------

describe("cancelBulkCampaign", () => {
  test("posts to /resupply-api/admin/bulk-campaigns/:id/cancel", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "camp-1", status: "cancelled" }),
    });

    await cancelBulkCampaign("camp-1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/bulk-campaigns/camp-1/cancel");
    expect(init.method).toBe("POST");
  });

  test("returns updated campaign status", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "camp-1", status: "cancelled" }),
    });

    const result = await cancelBulkCampaign("camp-1");
    expect(result.status).toBe("cancelled");
    expect(result.id).toBe("camp-1");
  });

  test("URL-encodes the campaign id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "camp-x", status: "cancelled" }),
    });

    await cancelBulkCampaign("camp-with/slash");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("camp-with%2Fslash");
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      json: async () => ({}),
    });
    await expect(cancelBulkCampaign("camp-1")).rejects.toThrow("409");
  });
});

// ---------------------------------------------------------------------------
// startBulkCampaign
// ---------------------------------------------------------------------------

describe("startBulkCampaign", () => {
  test("posts to /resupply-api/admin/bulk-campaigns/:id/start", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "camp-1", status: "sending" }),
    });

    await startBulkCampaign("camp-1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/bulk-campaigns/camp-1/start");
    expect(init.method).toBe("POST");
  });

  test("returns status 'sending' on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "camp-1", status: "sending" }),
    });

    const result = await startBulkCampaign("camp-1");
    expect(result.status).toBe("sending");
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      json: async () => ({ message: "campaign already started" }),
    });
    await expect(startBulkCampaign("camp-1")).rejects.toThrow(
      "campaign already started",
    );
  });
});

// ---------------------------------------------------------------------------
// pauseBulkCampaign
// ---------------------------------------------------------------------------

describe("pauseBulkCampaign", () => {
  test("posts to /resupply-api/admin/bulk-campaigns/:id/pause", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "camp-1", status: "paused" }),
    });

    await pauseBulkCampaign("camp-1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/bulk-campaigns/camp-1/pause");
    expect(init.method).toBe("POST");
  });

  test("returns status 'paused' on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "camp-1", status: "paused" }),
    });

    const result = await pauseBulkCampaign("camp-1");
    expect(result.status).toBe("paused");
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({}),
    });
    await expect(pauseBulkCampaign("ghost")).rejects.toThrow("404");
  });
});

// ---------------------------------------------------------------------------
// resumeBulkCampaign
// ---------------------------------------------------------------------------

describe("resumeBulkCampaign", () => {
  test("posts to /resupply-api/admin/bulk-campaigns/:id/resume", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "camp-1", status: "sending" }),
    });

    await resumeBulkCampaign("camp-1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/bulk-campaigns/camp-1/resume");
    expect(init.method).toBe("POST");
  });

  test("returns status 'sending' after resume", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "camp-1", status: "sending" }),
    });

    const result = await resumeBulkCampaign("camp-1");
    expect(result.status).toBe("sending");
  });

  test("URL-encodes the campaign id in the resume URL", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "camp-x", status: "sending" }),
    });

    await resumeBulkCampaign("camp-x");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/resume");
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      json: async () => ({ message: "campaign not in paused state" }),
    });
    await expect(resumeBulkCampaign("camp-1")).rejects.toThrow(
      "campaign not in paused state",
    );
  });

  test("calls fetch exactly once", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "camp-1", status: "sending" }),
    });

    await resumeBulkCampaign("camp-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// ApiError migration — jsonFetch now throws ApiError (not plain Error)
// ---------------------------------------------------------------------------

describe("bulk-campaigns-api — ApiError thrown on non-OK response", () => {
  test("listBulkCampaigns throws ApiError instance on 403", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      headers: new Headers(),
      url: "",
      json: async () => ({}),
    });
    const err = await listBulkCampaigns().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });

  test("getBulkCampaign throws ApiError instance on 404", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: new Headers(),
      url: "",
      json: async () => ({}),
    });
    const err = await getBulkCampaign("ghost").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });

  test("createBulkCampaignDraft throws ApiError with method POST", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      statusText: "Unprocessable",
      headers: new Headers(),
      url: "",
      json: async () => ({}),
    });
    const err = await createBulkCampaignDraft({
      name: "Test",
      audienceKind: "all_active_patients",
      category: "marketing",
      templateKey: "t1",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).method).toBe("POST");
  });

  test("ApiError carries the request URL", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "ISE",
      headers: new Headers(),
      url: "",
      json: async () => null,
    });
    const err = await listBulkCampaigns().catch((e: unknown) => e);
    expect((err as ApiError).url).toContain("/admin/bulk-campaigns");
  });
});
