// Tests for the admin fitter-leads fetch wrappers (fitter-leads-api.ts).
//
// Covers:
//   * listFitterLeads — happy path with default params, stage filter,
//     source filter, combined filters; HTTP error propagation
//   * unsubscribeFitterLead — happy path, HTTP error propagation

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  listFitterLeads,
  unsubscribeFitterLead,
  type FitterLeadJourneyStage,
  type ListFitterLeadsResponse,
  type UnsubscribeFitterLeadResponse,
} from "./fitter-leads-api";

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

const EMPTY_COUNTS: ListFitterLeadsResponse["counts"] = {
  consent: 0,
  completed: 0,
  campaign_active: 0,
  converted: 0,
  unsubscribed: 0,
  expired: 0,
};

const SAMPLE_RESPONSE: ListFitterLeadsResponse = {
  rows: [
    {
      id: "aaaaaaaa-0000-0000-0000-000000000001",
      email: "alice@example.com",
      phoneE164: "+12155550001",
      smsOptIn: true,
      marketingOptIn: true,
      source: "consent",
      journeyStage: "campaign_active",
      recommendedMaskId: "mask-001",
      recommendedMaskName: "ResMed AirFit P30i",
      recommendedMaskType: "nasalPillow",
      campaignTouchCount: 1,
      lastCampaignTouchAt: "2025-01-02T12:00:00Z",
      nextCampaignTouchAt: "2025-01-05T12:00:00Z",
      firstOrderId: null,
      firstOrderPlacedAt: null,
      unsubscribedAt: null,
      completedAt: "2025-01-01T12:00:00Z",
      createdAt: "2025-01-01T10:00:00Z",
    },
  ],
  counts: { ...EMPTY_COUNTS, campaign_active: 1 },
  conversionRate: 0.0,
};

function makeJsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

// ─────────────────────────────────────────────────────────────────
// listFitterLeads
// ─────────────────────────────────────────────────────────────────

describe("listFitterLeads", () => {
  it("fetches from /resupply-api/admin/fitter-leads with no query string when called with defaults", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse(SAMPLE_RESPONSE));

    const result = await listFitterLeads();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/fitter-leads");
    expect(result).toEqual(SAMPLE_RESPONSE);
  });

  it("appends ?stage=<value> when a non-all stage is supplied", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse(SAMPLE_RESPONSE));

    await listFitterLeads("campaign_active");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/fitter-leads?stage=campaign_active");
  });

  it("appends ?source=<value> when a non-all source is supplied", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse(SAMPLE_RESPONSE));

    await listFitterLeads("all", "sleep_apnea_quiz");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/fitter-leads?source=sleep_apnea_quiz");
  });

  it("appends both stage and source filters when both are non-all", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse(SAMPLE_RESPONSE));

    await listFitterLeads("converted", "insurance_quote");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/resupply-api/admin/fitter-leads?stage=converted&source=insurance_quote",
    );
  });

  it("omits stage from the query string when stage='all'", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse(SAMPLE_RESPONSE));

    await listFitterLeads("all", "consent");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("stage=");
  });

  it("omits source from the query string when source='all'", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse(SAMPLE_RESPONSE));

    await listFitterLeads("completed", "all");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("source=");
  });

  it("sends Accept: application/json header", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse(SAMPLE_RESPONSE));

    await listFitterLeads();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.["Accept"]).toBe("application/json");
  });

  it("throws on a non-OK response including the status code", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({}, false, 403));

    await expect(listFitterLeads()).rejects.toThrow("403");
  });

  it("returns conversionRate from the response body", async () => {
    const body: ListFitterLeadsResponse = {
      ...SAMPLE_RESPONSE,
      counts: { ...EMPTY_COUNTS, converted: 3, completed: 7 },
      conversionRate: 0.3,
    };
    fetchMock.mockResolvedValue(makeJsonResponse(body));

    const result = await listFitterLeads();
    expect(result.conversionRate).toBe(0.3);
  });

  it("works for every valid journey stage", async () => {
    const stages: Array<FitterLeadJourneyStage> = [
      "consent",
      "completed",
      "campaign_active",
      "converted",
      "unsubscribed",
      "expired",
    ];
    for (const s of stages) {
      fetchMock.mockResolvedValueOnce(makeJsonResponse(SAMPLE_RESPONSE));
      await expect(listFitterLeads(s)).resolves.toBeDefined();
      const [url] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
      expect(url).toContain(`stage=${s}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// unsubscribeFitterLead
// ─────────────────────────────────────────────────────────────────

const LEAD_ID = "aaaaaaaa-0000-0000-0000-000000000002";
const UNSUB_RESPONSE: UnsubscribeFitterLeadResponse = {
  id: LEAD_ID,
  journeyStage: "unsubscribed",
  unsubscribedAt: "2025-01-10T09:00:00Z",
};

describe("unsubscribeFitterLead", () => {
  it("POSTs to /resupply-api/admin/fitter-leads/<id>/unsubscribe", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse(UNSUB_RESPONSE));

    const result = await unsubscribeFitterLead(LEAD_ID);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `/resupply-api/admin/fitter-leads/${LEAD_ID}/unsubscribe`,
    );
    expect(init.method).toBe("POST");
    expect(result).toEqual(UNSUB_RESPONSE);
  });

  it("sends Accept: application/json header", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse(UNSUB_RESPONSE));

    await unsubscribeFitterLead(LEAD_ID);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.["Accept"]).toBe("application/json");
  });

  it("URL-encodes the lead ID in the path", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse(UNSUB_RESPONSE));
    const weirdId = "abc def/xyz";

    await unsubscribeFitterLead(weirdId);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("abc%20def%2Fxyz");
  });

  it("throws on a non-OK HTTP response", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({}, false, 404));

    await expect(unsubscribeFitterLead(LEAD_ID)).rejects.toThrow("404");
  });

  it("throws on a 429 rate-limit response", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({}, false, 429));

    await expect(unsubscribeFitterLead(LEAD_ID)).rejects.toThrow("429");
  });

  it("returns journeyStage='unsubscribed' from the response body", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse(UNSUB_RESPONSE));

    const res = await unsubscribeFitterLead(LEAD_ID);
    expect(res.journeyStage).toBe("unsubscribed");
  });
});