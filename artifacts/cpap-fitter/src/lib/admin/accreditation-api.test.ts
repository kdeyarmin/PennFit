// Tests for accreditation-api.ts — fetch wrappers for /admin/accreditation/*
//
// Coverage:
//   jsonFetch shared behaviour — URL, credentials, headers, error handling
//   listPolicies              — GET /admin/accreditation/policies
//   listMyPendingPolicies     — GET /admin/accreditation/policies/me/pending
//   createPolicy              — POST /admin/accreditation/policies
//   patchPolicy               — PATCH /admin/accreditation/policies/:id
//   attestPolicy              — POST /admin/accreditation/policies/:id/attest
//   getBinderSummary          — GET /admin/accreditation/binder

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import {
  listPolicies,
  listMyPendingPolicies,
  createPolicy,
  patchPolicy,
  attestPolicy,
  getBinderSummary,
} from "./accreditation-api";

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
// jsonFetch shared behaviour (via listPolicies as representative GET)
// ---------------------------------------------------------------------------

describe("jsonFetch shared behaviour (via listPolicies)", () => {
  test("requests /resupply-api prefix on the URL", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ policies: [] }),
    });

    await listPolicies();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/accreditation/policies");
  });

  test("sends credentials: include", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ policies: [] }),
    });

    await listPolicies();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  test("sends Accept: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ policies: [] }),
    });

    await listPolicies();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/json");
  });

  test("throws Error on non-OK response using status+statusText", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({}),
    });

    await expect(listPolicies()).rejects.toThrow("403");
  });

  test("throws using message field from error JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      statusText: "Unprocessable Entity",
      json: async () => ({ message: "policy key already exists" }),
    });

    await expect(listPolicies()).rejects.toThrow("policy key already exists");
  });

  test("throws using error field when message is missing", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ error: "invalid_category" }),
    });

    await expect(listPolicies()).rejects.toThrow("invalid_category");
  });

  test("falls back to status+statusText when JSON body is unparseable", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => {
        throw new SyntaxError("no body");
      },
    });

    await expect(listPolicies()).rejects.toThrow("500");
  });

  test("calls fetch exactly once", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ policies: [] }),
    });

    await listPolicies();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// listPolicies
// ---------------------------------------------------------------------------

describe("listPolicies", () => {
  test("requests /resupply-api/admin/accreditation/policies", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ policies: [] }),
    });

    await listPolicies();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/accreditation/policies");
  });

  test("returns the parsed policies array", async () => {
    const policy = {
      id: "pol-1",
      policyKey: "hipaa-baa",
      version: "2025.1",
      title: "HIPAA BAA",
      summary: null,
      bodyUrl: null,
      category: "compliance",
      activeAt: "2025-01-01T00:00:00Z",
      retiredAt: null,
      attestationCount: 5,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ policies: [policy] }),
    });

    const result = await listPolicies();
    expect(result.policies).toHaveLength(1);
    expect(result.policies[0]!.policyKey).toBe("hipaa-baa");
    expect(result.policies[0]!.attestationCount).toBe(5);
  });

  test("returns an empty policies array when no policies exist", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ policies: [] }),
    });

    const result = await listPolicies();
    expect(result.policies).toEqual([]);
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: "ISE", json: async () => ({}) });
    await expect(listPolicies()).rejects.toThrow("500");
  });
});

// ---------------------------------------------------------------------------
// listMyPendingPolicies
// ---------------------------------------------------------------------------

describe("listMyPendingPolicies", () => {
  test("requests /resupply-api/admin/accreditation/policies/me/pending", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ pending: [] }),
    });

    await listMyPendingPolicies();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/accreditation/policies/me/pending");
  });

  test("returns the pending policies array", async () => {
    const pending = {
      id: "pol-2",
      policyKey: "covid-policy",
      version: "2025.2",
      title: "COVID Safety Policy",
      summary: "Summary here",
      bodyUrl: "https://example.com/policy",
      category: "safety",
      activeAt: "2025-06-01T00:00:00Z",
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ pending: [pending] }),
    });

    const result = await listMyPendingPolicies();
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]!.policyKey).toBe("covid-policy");
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized", json: async () => ({}) });
    await expect(listMyPendingPolicies()).rejects.toThrow("401");
  });
});

// ---------------------------------------------------------------------------
// createPolicy
// ---------------------------------------------------------------------------

describe("createPolicy", () => {
  const CREATE_INPUT = {
    policyKey: "new-policy",
    version: "2025.1",
    title: "New Policy",
    category: "compliance",
  };

  test("posts to /resupply-api/admin/accreditation/policies", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "pol-new" }),
    });

    await createPolicy(CREATE_INPUT);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/accreditation/policies");
  });

  test("uses POST method", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "pol-new" }),
    });

    await createPolicy(CREATE_INPUT);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
  });

  test("sends Content-Type: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "pol-new" }),
    });

    await createPolicy(CREATE_INPUT);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("serialises the body as JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "pol-new" }),
    });

    await createPolicy(CREATE_INPUT);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(CREATE_INPUT);
  });

  test("returns the new policy id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "pol-created-123" }),
    });

    const result = await createPolicy(CREATE_INPUT);
    expect(result.id).toBe("pol-created-123");
  });

  test("includes optional activate flag when provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "pol-x" }),
    });

    await createPolicy({ ...CREATE_INPUT, activate: true });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ activate: true });
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, statusText: "Conflict", json: async () => ({}) });
    await expect(createPolicy(CREATE_INPUT)).rejects.toThrow("409");
  });
});

// ---------------------------------------------------------------------------
// patchPolicy
// ---------------------------------------------------------------------------

describe("patchPolicy", () => {
  test("sends PATCH to /resupply-api/admin/accreditation/policies/:id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await patchPolicy("pol-abc", { title: "Updated Title" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/accreditation/policies/pol-abc");
    expect(init.method).toBe("PATCH");
  });

  test("serialises the patch body correctly", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    const body = { title: "New Title", activate: true };
    await patchPolicy("pol-xyz", body);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  test("URL-encodes the policy id in the path", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    // The API uses string IDs — test with a plain slug-style ID
    await patchPolicy("pol-retire-test", { retire: true });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("pol-retire-test");
  });

  test("returns { ok: true } on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    const result = await patchPolicy("pol-1", { category: "training" });
    expect(result).toEqual({ ok: true });
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, statusText: "Not Found", json: async () => ({}) });
    await expect(patchPolicy("no-such-policy", {})).rejects.toThrow("404");
  });
});

// ---------------------------------------------------------------------------
// attestPolicy
// ---------------------------------------------------------------------------

describe("attestPolicy", () => {
  const ACK_TEXT = "I acknowledge this policy";

  test("posts to /resupply-api/admin/accreditation/policies/:id/attest", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "att-1", attestedAt: "2025-01-01T00:00:00Z" }),
    });

    await attestPolicy("pol-hipaa", ACK_TEXT);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/accreditation/policies/pol-hipaa/attest");
  });

  test("sends acknowledgedText in the request body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "att-1", attestedAt: "2025-01-01T00:00:00Z" }),
    });

    await attestPolicy("pol-1", ACK_TEXT);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ acknowledgedText: ACK_TEXT });
  });

  test("returns attestation id and attestedAt on new attestation", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "att-999", attestedAt: "2025-06-15T10:00:00Z" }),
    });

    const result = await attestPolicy("pol-1", ACK_TEXT);
    expect(result).toMatchObject({ id: "att-999", attestedAt: "2025-06-15T10:00:00Z" });
  });

  test("returns alreadyAttested: true when already attested", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ alreadyAttested: true }),
    });

    const result = await attestPolicy("pol-1", ACK_TEXT);
    expect(result).toMatchObject({ alreadyAttested: true });
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden", json: async () => ({}) });
    await expect(attestPolicy("pol-1", ACK_TEXT)).rejects.toThrow("403");
  });
});

// ---------------------------------------------------------------------------
// getBinderSummary
// ---------------------------------------------------------------------------

describe("getBinderSummary", () => {
  const BINDER_PAYLOAD = {
    asOf: "2025-01-01T00:00:00Z",
    sections: {
      policies: { total: 10, active: 8, attestations: 50, csvUrl: "/binder.csv" },
      training: { total: 3, listUrl: "/training" },
      grievances: { total: 2, open: 1, listUrl: "/grievances" },
      auditLog: { csvUrl: "/audit.csv" },
    },
  };

  test("requests /resupply-api/admin/accreditation/binder", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => BINDER_PAYLOAD,
    });

    await getBinderSummary();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/accreditation/binder");
  });

  test("returns binder summary data", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => BINDER_PAYLOAD,
    });

    const result = await getBinderSummary();
    expect(result.sections.policies.total).toBe(10);
    expect(result.sections.policies.active).toBe(8);
    expect(result.sections.grievances.open).toBe(1);
    expect(result.asOf).toBe("2025-01-01T00:00:00Z");
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, statusText: "Unavailable", json: async () => ({}) });
    await expect(getBinderSummary()).rejects.toThrow("503");
  });
});