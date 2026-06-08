// Tests for the real-time eligibility transport: the CORE envelope
// builder, the 271 extractor, HTTP outcome classification (via an
// injected fake fetch), and the fail-soft config reader.

import { describe, expect, it } from "vitest";

import { readOfficeAllyRealtimeConfigOrNull } from "../config";
import {
  buildCoreRealTimeRequestEnvelope,
  createRealtimeEligibilityTransport,
  extract271FromCoreResponse,
  type FetchLike,
} from "./realtime";

const CONFIG = {
  url: "https://oa.example/realtime",
  username: "user",
  password: "pass",
  senderId: "SENDER1",
  receiverId: "OFFICEALLY",
  timeoutMs: 5000,
};

const SAMPLE_271 =
  "ISA*00*          *00*          *ZZ*OFFCLY         *ZZ*SENDER1        *260608*1200*^*00501*000000001*0*P*:~" +
  "GS*HB*OFFCLY*SENDER1*20260608*1200*1*X*005010X279A1~ST*271*0001*005010X279A1~" +
  "EB*1~SE*4*0001~GE*1*1~IEA*1*000000001~";

function coreResponse(payloadInner: string): string {
  return [
    '<?xml version="1.0"?>',
    "<soap:Envelope><soap:Body>",
    "<cor:COREEnvelopeRealTimeResponse>",
    "<PayloadType>X12_271_Response_005010X279A1</PayloadType>",
    "<ErrorCode>Success</ErrorCode>",
    `<Payload>${payloadInner}</Payload>`,
    "</cor:COREEnvelopeRealTimeResponse>",
    "</soap:Body></soap:Envelope>",
  ].join("");
}

/** Build a fake fetch that records the last request init and returns a
 *  canned status + body. */
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

const DETERMINISTIC = {
  payloadId: () => "PID-123",
  now: () => new Date("2026-06-08T12:00:00.000Z"),
};

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
  it("returns the extracted 271 and echoes the PayloadID as sessionId", async () => {
    const { fetchImpl } = fakeFetch(200, coreResponse(SAMPLE_271));
    const transport = createRealtimeEligibilityTransport(CONFIG, {
      fetchImpl,
      ...DETERMINISTIC,
    });
    const res = await transport.requestEligibility({ payload: "ISA*00*270~" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.payload271).toContain("ST*271");
      expect(res.sessionId).toBe("PID-123");
    }
  });

  it("posts a CORE envelope carrying the 270 with Basic auth", async () => {
    const { fetchImpl, lastInit } = fakeFetch(200, coreResponse(SAMPLE_271));
    const transport = createRealtimeEligibilityTransport(CONFIG, {
      fetchImpl,
      ...DETERMINISTIC,
    });
    await transport.requestEligibility({ payload: "ISA*00*270-PAYLOAD~" });
    const init = lastInit();
    expect(init).not.toBeNull();
    expect(init!.method).toBe("POST");
    expect(init!.body).toContain("ISA*00*270-PAYLOAD~");
    expect(init!.body).toContain("X12_270_Request_005010X279A1");
    expect(init!.body).toContain("<SenderID>SENDER1</SenderID>");
    expect(init!.body).toContain("<ReceiverID>OFFICEALLY</ReceiverID>");
    const expectedAuth = Buffer.from("user:pass", "utf8").toString("base64");
    expect(init!.headers.Authorization).toBe(`Basic ${expectedAuth}`);
  });
});

describe("createRealtimeEligibilityTransport — failure classification", () => {
  it("maps HTTP 401 to auth_failed", async () => {
    const { fetchImpl } = fakeFetch(401, "nope");
    const transport = createRealtimeEligibilityTransport(CONFIG, { fetchImpl });
    const res = await transport.requestEligibility({ payload: "ISA~" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("auth_failed");
  });

  it("maps HTTP 500 to rejected", async () => {
    const { fetchImpl } = fakeFetch(500, "boom");
    const transport = createRealtimeEligibilityTransport(CONFIG, { fetchImpl });
    const res = await transport.requestEligibility({ payload: "ISA~" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("rejected");
  });

  it("maps a thrown network error to connect_failed", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const transport = createRealtimeEligibilityTransport(CONFIG, { fetchImpl });
    const res = await transport.requestEligibility({ payload: "ISA~" });
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
    const res = await transport.requestEligibility({ payload: "ISA~" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("connect_failed");
      expect(res.message).toContain("timed out");
    }
  });

  it("rejects a 200 response that carries no 271 payload", async () => {
    const { fetchImpl } = fakeFetch(
      200,
      "<soap:Envelope><soap:Body><ErrorCode>Failure</ErrorCode></soap:Body></soap:Envelope>",
    );
    const transport = createRealtimeEligibilityTransport(CONFIG, { fetchImpl });
    const res = await transport.requestEligibility({ payload: "ISA~" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("rejected");
  });
});

describe("buildCoreRealTimeRequestEnvelope", () => {
  it("includes all required CORE fields and the escaped 270 payload", () => {
    const env = buildCoreRealTimeRequestEnvelope({
      payload270: "ISA*00*A&B~",
      senderId: "S1",
      receiverId: "R1",
      payloadId: "PID-1",
      timestamp: "2026-06-08T12:00:00.000Z",
    });
    expect(env).toContain("<ProcessingMode>RealTime</ProcessingMode>");
    expect(env).toContain("<PayloadID>PID-1</PayloadID>");
    expect(env).toContain("<SenderID>S1</SenderID>");
    expect(env).toContain("<ReceiverID>R1</ReceiverID>");
    expect(env).toContain("<CORERuleVersion>2.2.0</CORERuleVersion>");
    // The ampersand in the payload is XML-escaped.
    expect(env).toContain("ISA*00*A&amp;B~");
  });
});

describe("extract271FromCoreResponse", () => {
  it("extracts a raw X12 payload", () => {
    expect(extract271FromCoreResponse(coreResponse(SAMPLE_271))).toContain(
      "ST*271",
    );
  });

  it("tolerates a namespace prefix and attributes on the Payload tag", () => {
    const body = `<env><ns2:Payload xsi:type="x">${SAMPLE_271}</ns2:Payload></env>`;
    expect(extract271FromCoreResponse(body)).toContain("ST*271");
  });

  it("XML-unescapes the payload content", () => {
    const escaped = SAMPLE_271.replace(/&/g, "&amp;");
    const body = `<Payload>${escaped}</Payload>`;
    expect(extract271FromCoreResponse(body)).toContain("ISA*00");
  });

  it("decodes a base64-encoded payload", () => {
    const b64 = Buffer.from(SAMPLE_271, "utf8").toString("base64");
    expect(extract271FromCoreResponse(coreResponse(b64))).toContain("ST*271");
  });

  it("returns null when there is no Payload element", () => {
    expect(
      extract271FromCoreResponse("<env><Other>x</Other></env>"),
    ).toBeNull();
  });

  it("returns null when the payload is neither X12 nor base64-X12", () => {
    expect(
      extract271FromCoreResponse(coreResponse("not an edi payload")),
    ).toBeNull();
  });
});

describe("readOfficeAllyRealtimeConfigOrNull", () => {
  const base = {
    OFFICE_ALLY_REALTIME_URL: "https://oa.example/rt",
    OFFICE_ALLY_REALTIME_USERNAME: "u",
    OFFICE_ALLY_REALTIME_PASSWORD: "p",
  } as NodeJS.ProcessEnv;

  it("returns null when any required var is missing", () => {
    expect(
      readOfficeAllyRealtimeConfigOrNull({} as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(
      readOfficeAllyRealtimeConfigOrNull({
        OFFICE_ALLY_REALTIME_URL: "https://x",
        OFFICE_ALLY_REALTIME_USERNAME: "u",
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

  it("applies defaults for receiverId, senderId (ETIN), and timeout", () => {
    const cfg = readOfficeAllyRealtimeConfigOrNull({
      ...base,
      OFFICE_ALLY_ETIN: "ETIN9",
    } as NodeJS.ProcessEnv);
    expect(cfg).not.toBeNull();
    expect(cfg!.receiverId).toBe("OFFICEALLY");
    expect(cfg!.senderId).toBe("ETIN9");
    expect(cfg!.timeoutMs).toBe(30_000);
  });

  it("honors explicit senderId, receiverId, and timeout overrides", () => {
    const cfg = readOfficeAllyRealtimeConfigOrNull({
      ...base,
      OFFICE_ALLY_REALTIME_SENDER_ID: "SND",
      OFFICE_ALLY_REALTIME_RECEIVER_ID: "RCV",
      OFFICE_ALLY_REALTIME_TIMEOUT_MS: "9000",
    } as NodeJS.ProcessEnv);
    expect(cfg!.senderId).toBe("SND");
    expect(cfg!.receiverId).toBe("RCV");
    expect(cfg!.timeoutMs).toBe(9000);
  });

  it("returns null when neither a sender id nor an ETIN is set", () => {
    // url/username/password present but no SenderID source — an empty
    // <SenderID> would be rejected, so the config is treated as unset.
    expect(readOfficeAllyRealtimeConfigOrNull(base)).toBeNull();
  });
});
