// Tests for the real-time eligibility transport — Office Ally's EDI REST
// API v2: a JSON POST that wraps the raw X12 270 ({"x12": …}) and returns
// the X12 271 wrapped in a JSON envelope ({"data": {"x12": …}}). HTTP
// outcomes are exercised via an injected fake fetch; the config reader is
// covered too.

import { describe, expect, it } from "vitest";

import { readOfficeAllyRealtimeConfigOrNull } from "../config";
import {
  createRealtimeEligibilityTransport,
  extract271,
  isX12Response271,
  type FetchLike,
} from "./realtime";

const CONFIG = {
  url: "https://edi.officeally.io/v2/eligibility-benefits/x12",
  apiKey: "test-api-key",
  timeoutMs: 5000,
};

const SAMPLE_271 =
  "ISA*00*          *00*          *ZZ*SENDER1        *ZZ*OFFALLY         *260608*1200*^*00501*000000001*0*P*:~" +
  "GS*HB*SENDER1*OFFALLY*20260608*1200*1*X*005010X279A1~ST*271*0001*005010X279A1~" +
  "EB*1~SE*4*0001~GE*1*1~IEA*1*000000001~";

const SAMPLE_270 =
  "ISA*00*          *00*          *ZZ*SENDER1        *ZZ*OFFALLY         *260608*1200*^*00501*000000001*0*P*:~" +
  "GS*HS*SENDER1*OFFALLY*20260608*1200*1*X*005010X279A1~ST*270*0001*005010X279A1~SE*2*0001~GE*1*1~IEA*1*000000001~";

/** Office Ally v2 wraps the 271 in an ApiResponseOfEligibilityResponse
 *  envelope; the raw X12 lives at data.x12. */
function envelope271(x12: string): string {
  return JSON.stringify({
    data: {
      responseStatus: { codeValue: "0", description: "Success" },
      transactionId: "TXN-1",
      x12,
    },
  });
}

/** Fake fetch that records the last request init and returns a canned
 *  status + body. */
function fakeFetch(
  status: number,
  body: string,
): { fetchImpl: FetchLike; lastInit: () => Parameters<FetchLike>[1] | null } {
  let captured: Parameters<FetchLike>[1] | null = null;
  const fetchImpl: FetchLike = async (_url, init) => {
    captured = init;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    };
  };
  return { fetchImpl, lastInit: () => captured };
}

const DETERMINISTIC = { requestId: () => "REQ-123" };

describe("createRealtimeEligibilityTransport — unconfigured", () => {
  it("returns a noop transport that reports unavailable", async () => {
    const transport = createRealtimeEligibilityTransport(null);
    expect(transport.kind).toBe("noop");
    const res = await transport.requestEligibility({ payload: "ISA*00~" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("unavailable");
  });
});

describe("createRealtimeEligibilityTransport — happy path", () => {
  it("extracts the raw 271 from the JSON envelope and returns a sessionId", async () => {
    const { fetchImpl } = fakeFetch(200, envelope271(SAMPLE_271));
    const transport = createRealtimeEligibilityTransport(CONFIG, {
      fetchImpl,
      ...DETERMINISTIC,
    });
    const res = await transport.requestEligibility({ payload: SAMPLE_270 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.payload271).toContain("ST*271");
      expect(res.sessionId).toBe("REQ-123");
    }
  });

  it("POSTs the 270 wrapped as JSON {x12} with the API key in Authorization", async () => {
    const { fetchImpl, lastInit } = fakeFetch(200, envelope271(SAMPLE_271));
    const transport = createRealtimeEligibilityTransport(CONFIG, {
      fetchImpl,
      ...DETERMINISTIC,
    });
    await transport.requestEligibility({ payload: "ISA*00*270-PAYLOAD~" });
    const init = lastInit();
    expect(init).not.toBeNull();
    expect(init!.method).toBe("POST");
    // The body is the raw 270 wrapped in the v2 RealTimeX12Request shape.
    expect(init!.body).toBe(JSON.stringify({ x12: "ISA*00*270-PAYLOAD~" }));
    expect(JSON.parse(init!.body)).toEqual({ x12: "ISA*00*270-PAYLOAD~" });
    expect(init!.headers.Authorization).toBe("test-api-key");
    expect(init!.headers["Content-Type"]).toBe("application/json");
    expect(init!.headers.Accept).toBe("application/json");
  });
});

describe("createRealtimeEligibilityTransport — failure classification", () => {
  it("maps HTTP 401 to auth_failed", async () => {
    const { fetchImpl } = fakeFetch(401, "nope");
    const transport = createRealtimeEligibilityTransport(CONFIG, { fetchImpl });
    const res = await transport.requestEligibility({ payload: SAMPLE_270 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("auth_failed");
  });

  it("maps HTTP 403 to auth_failed", async () => {
    const { fetchImpl } = fakeFetch(403, "forbidden");
    const transport = createRealtimeEligibilityTransport(CONFIG, { fetchImpl });
    const res = await transport.requestEligibility({ payload: SAMPLE_270 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("auth_failed");
  });

  it("maps HTTP 500 to rejected and surfaces a short body detail", async () => {
    const { fetchImpl } = fakeFetch(500, "Internal payer error");
    const transport = createRealtimeEligibilityTransport(CONFIG, { fetchImpl });
    const res = await transport.requestEligibility({ payload: SAMPLE_270 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("rejected");
      expect(res.message).toContain("500");
      expect(res.message).toContain("Internal payer error");
    }
  });

  it("maps a thrown network error to connect_failed", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const transport = createRealtimeEligibilityTransport(CONFIG, { fetchImpl });
    const res = await transport.requestEligibility({ payload: SAMPLE_270 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("connect_failed");
  });

  it("maps an AbortError (timeout) to connect_failed with a timeout message", async () => {
    const fetchImpl: FetchLike = async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    };
    const transport = createRealtimeEligibilityTransport(CONFIG, { fetchImpl });
    const res = await transport.requestEligibility({ payload: SAMPLE_270 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("connect_failed");
      expect(res.message).toContain("timed out");
    }
  });

  it("rejects a 200 JSON envelope that carries no X12 271 and surfaces the status detail", async () => {
    const body = JSON.stringify({
      data: {
        responseStatus: { codeValue: "1", description: "Payer not available" },
        x12: null,
      },
    });
    const { fetchImpl } = fakeFetch(200, body);
    const transport = createRealtimeEligibilityTransport(CONFIG, { fetchImpl });
    const res = await transport.requestEligibility({ payload: SAMPLE_270 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("rejected");
      expect(res.message).toContain("Payer not available");
    }
  });

  it("rejects a 200 body that is not valid JSON", async () => {
    const { fetchImpl } = fakeFetch(200, "<html>not json</html>");
    const transport = createRealtimeEligibilityTransport(CONFIG, { fetchImpl });
    const res = await transport.requestEligibility({ payload: SAMPLE_270 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("rejected");
      expect(res.message).toContain("not valid JSON");
    }
  });

  it("rejects a 200 JSON envelope whose data.x12 is present but not a 271", async () => {
    const { fetchImpl } = fakeFetch(200, envelope271(SAMPLE_270));
    const transport = createRealtimeEligibilityTransport(CONFIG, { fetchImpl });
    const res = await transport.requestEligibility({ payload: SAMPLE_270 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("rejected");
  });
});

describe("extract271", () => {
  it("pulls data.x12 out of the v2 envelope", () => {
    expect(extract271({ data: { x12: SAMPLE_271 } })).toBe(SAMPLE_271);
  });

  it("returns null when data or data.x12 is missing/empty/non-string", () => {
    expect(extract271(null)).toBeNull();
    expect(extract271({})).toBeNull();
    expect(extract271({ data: null })).toBeNull();
    expect(extract271({ data: {} })).toBeNull();
    expect(extract271({ data: { x12: "" } })).toBeNull();
    expect(extract271({ data: { x12: 123 } })).toBeNull();
  });
});

describe("isX12Response271", () => {
  it("is true for a 271 body", () => {
    expect(isX12Response271(SAMPLE_271)).toBe(true);
  });

  it("is false for a 270 (no 271 transaction set) and for non-X12", () => {
    expect(isX12Response271(SAMPLE_270)).toBe(false);
    expect(isX12Response271("garbage")).toBe(false);
  });
});

describe("readOfficeAllyRealtimeConfigOrNull", () => {
  const base = {
    OFFICE_ALLY_REALTIME_URL:
      "https://edi.officeally.io/v2/eligibility-benefits/x12",
    OFFICE_ALLY_REALTIME_API_KEY: "key123",
  } as NodeJS.ProcessEnv;

  it("returns null when the url or the api key is missing", () => {
    expect(
      readOfficeAllyRealtimeConfigOrNull({} as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(
      readOfficeAllyRealtimeConfigOrNull({
        OFFICE_ALLY_REALTIME_URL: "https://x",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("returns null in stub mode even when all vars are present", () => {
    expect(
      readOfficeAllyRealtimeConfigOrNull({
        ...base,
        OFFICE_ALLY_STUB: "1",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("reads url + api key and defaults the timeout", () => {
    const cfg = readOfficeAllyRealtimeConfigOrNull(base);
    expect(cfg).not.toBeNull();
    expect(cfg!.url).toContain("/eligibility-benefits/x12");
    expect(cfg!.apiKey).toBe("key123");
    expect(cfg!.timeoutMs).toBe(30_000);
  });

  it("falls back to OFFICE_ALLY_REALTIME_PASSWORD for the api key (legacy alias)", () => {
    const cfg = readOfficeAllyRealtimeConfigOrNull({
      OFFICE_ALLY_REALTIME_URL: base.OFFICE_ALLY_REALTIME_URL,
      OFFICE_ALLY_REALTIME_PASSWORD: "legacykey",
    } as NodeJS.ProcessEnv);
    expect(cfg!.apiKey).toBe("legacykey");
  });

  it("honors an explicit timeout override", () => {
    const cfg = readOfficeAllyRealtimeConfigOrNull({
      ...base,
      OFFICE_ALLY_REALTIME_TIMEOUT_MS: "9000",
    } as NodeJS.ProcessEnv);
    expect(cfg!.timeoutMs).toBe(9000);
  });
});
