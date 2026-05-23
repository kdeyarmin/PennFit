import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { ApiError } from "@workspace/api-client-react/admin";

import { listInboundFaxes, patchInboundFax } from "./inbound-faxes-api";

const ORIGINAL_FETCH = globalThis.fetch;

let fetchMock: Mock;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("inbound-faxes-api", () => {
  it("throws ApiError with request metadata when the server returns a non-ok response", async () => {
    const data = { message: "fax is already attached" };
    fetchMock.mockResolvedValue(
      jsonResponse(data, { status: 409, statusText: "Conflict" }),
    );

    await expect(
      patchInboundFax("fax-123", { status: "attached" }),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      data,
      method: "PATCH",
      url: "/resupply-api/admin/inbound-faxes/fax-123",
    });

    await expect(
      patchInboundFax("fax-123", { status: "attached" }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("preserves true network failures as non-ApiError rejections", async () => {
    const error = new TypeError("fetch failed");
    fetchMock.mockRejectedValue(error);

    await expect(listInboundFaxes()).rejects.toBe(error);
    await expect(listInboundFaxes()).rejects.not.toBeInstanceOf(ApiError);
  });
});
