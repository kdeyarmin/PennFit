import { describe, expect, it } from "vitest";

import { submitPasBundle } from "./client";
import type { FhirBundle } from "./build-bundle";

const bundle = {
  resourceType: "Bundle",
  type: "collection",
  entry: [],
} as unknown as FhirBundle;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/fhir+json" },
  });
}

describe("submitPasBundle", () => {
  it("parses a 2xx payer response as 'responded'", async () => {
    const out = await submitPasBundle({
      bundle,
      endpointUrl: "https://payer.example.com/fhir",
      accessToken: "secret-token",
      fetchImpl: async () =>
        jsonResponse({ resourceType: "ClaimResponse", id: "cr1" }),
    });
    expect(out.status).toBe("responded");
    expect(out.httpStatus).toBe(200);
    expect((out.responseJson as { id?: string })?.id).toBe("cr1");
    expect(out.errorMessage).toBeNull();
  });

  it("treats a non-2xx payer response as 'rejected'", async () => {
    const out = await submitPasBundle({
      bundle,
      endpointUrl: "https://payer.example.com/fhir",
      accessToken: "secret-token",
      fetchImpl: async () =>
        jsonResponse({ resourceType: "OperationOutcome" }, 422),
    });
    expect(out.status).toBe("rejected");
    expect(out.httpStatus).toBe(422);
  });

  it("enforces the response body size cap (no OOM on a hostile/huge body)", async () => {
    // Emit a body larger than the 4 MB cap as a streamed chunk. The
    // bounded reader must abort and surface a transport failure rather
    // than buffering the whole thing.
    const oversized = new Uint8Array(4 * 1024 * 1024 + 16);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized);
        controller.close();
      },
    });
    const out = await submitPasBundle({
      bundle,
      endpointUrl: "https://payer.example.com/fhir",
      accessToken: "secret-token",
      fetchImpl: async () => new Response(body, { status: 200 }),
    });
    expect(out.status).toBe("transport_failed");
    expect(out.responseJson).toBeNull();
  });

  it("returns a caller-safe message on transport error (no raw error leak)", async () => {
    const out = await submitPasBundle({
      bundle,
      endpointUrl: "https://payer.example.com/fhir",
      accessToken: "secret-token",
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.5:443 secret-token-leak");
      },
    });
    expect(out.status).toBe("transport_failed");
    expect(out.errorMessage).toBe("payer transport error");
    // The raw error (which could carry internal host/credential detail)
    // must not be surfaced.
    expect(out.errorMessage).not.toContain("ECONNREFUSED");
    expect(out.errorMessage).not.toContain("secret-token");
  });

  it("reports a timeout distinctly", async () => {
    const out = await submitPasBundle({
      bundle,
      endpointUrl: "https://payer.example.com/fhir",
      accessToken: "secret-token",
      timeoutMs: 5,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    });
    expect(out.status).toBe("transport_failed");
    expect(out.errorMessage).toBe("payer request timed out");
  });
});
