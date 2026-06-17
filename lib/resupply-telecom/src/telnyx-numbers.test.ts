// Unit tests for the Telnyx number-search + ordering client
// (telnyx-numbers.ts) used to PROVISION a tenant's fax number.
//
// Coverage:
//   * TelnyxConfigError when TELNYX_API_KEY / TELNYX_FAX_CONNECTION_ID missing
//   * Explicit options override env
//   * search builds the fax-feature filter + area code
//   * order attaches the connection_id and customer_reference
//   * provisionFaxNumber picks a fax-capable candidate and orders it
//   * provisionFaxNumber throws TelnyxApiError when nothing matches
//   * default fetch path parses the data envelopes + maps error envelopes

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TelnyxApiError, TelnyxConfigError } from "./telnyx-fax";
import {
  createTelnyxNumberClient,
  type AvailableFaxNumber,
  type NumbersHttpDelete,
  type NumbersHttpGet,
  type NumbersHttpLookup,
  type NumbersHttpPost,
  type OrderNumberResult,
} from "./telnyx-numbers";

const BASE_CREDS = { apiKey: "KEYtest", connectionId: "conn-fax" };

function makeGet(rows: AvailableFaxNumber[]): NumbersHttpGet {
  return vi.fn(async () => rows);
}
function makePost(result: OrderNumberResult): NumbersHttpPost {
  return vi.fn(async () => result);
}

describe("createTelnyxNumberClient — config validation", () => {
  beforeEach(() => {
    delete process.env.TELNYX_API_KEY;
    delete process.env.TELNYX_FAX_CONNECTION_ID;
  });
  afterEach(() => {
    delete process.env.TELNYX_API_KEY;
    delete process.env.TELNYX_FAX_CONNECTION_ID;
  });

  it("throws TelnyxConfigError when TELNYX_API_KEY is missing", () => {
    expect(() => createTelnyxNumberClient()).toThrow(TelnyxConfigError);
  });

  it("throws TelnyxConfigError when TELNYX_FAX_CONNECTION_ID is missing", () => {
    process.env.TELNYX_API_KEY = "KEYenv";
    expect(() => createTelnyxNumberClient()).toThrow(TelnyxConfigError);
  });

  it("reads credentials from env when options are not supplied", async () => {
    process.env.TELNYX_API_KEY = "KEYenv";
    process.env.TELNYX_FAX_CONNECTION_ID = "conn-env";
    const keys: string[] = [];
    const httpGet: NumbersHttpGet = vi.fn(async (_url, apiKey) => {
      keys.push(apiKey);
      return [];
    });
    const client = createTelnyxNumberClient({ httpGet });
    await client.searchAvailableFaxNumbers();
    expect(keys[0]).toBe("KEYenv");
  });
});

describe("searchAvailableFaxNumbers", () => {
  it("requests the fax feature filter and area code", async () => {
    const urls: string[] = [];
    const httpGet: NumbersHttpGet = vi.fn(async (url) => {
      urls.push(url);
      return [{ phoneNumber: "+12155551212", features: ["fax", "voice"] }];
    });
    const client = createTelnyxNumberClient({ ...BASE_CREDS, httpGet });
    await client.searchAvailableFaxNumbers({ areaCode: "215" });
    const url = urls[0]!;
    expect(url).toContain("https://api.telnyx.com/v2/available_phone_numbers");
    expect(decodeURIComponent(url)).toContain("filter[features][]=fax");
    expect(decodeURIComponent(url)).toContain(
      "filter[national_destination_code]=215",
    );
    expect(decodeURIComponent(url)).toContain("filter[country_code]=US");
  });
});

describe("orderNumber", () => {
  it("attaches connection_id and customer_reference to the order body", async () => {
    const bodies: Record<string, unknown>[] = [];
    const httpPost: NumbersHttpPost = vi.fn(async (_url, _key, body) => {
      bodies.push(body);
      return {
        orderId: "ord-1",
        phoneNumber: "+12155551212",
        status: "pending",
      };
    });
    const client = createTelnyxNumberClient({ ...BASE_CREDS, httpPost });
    await client.orderNumber({
      phoneNumber: "+12155551212",
      customerReference: "org:acme",
    });
    expect(bodies[0]).toMatchObject({
      phone_numbers: [{ phone_number: "+12155551212" }],
      connection_id: "conn-fax",
      customer_reference: "org:acme",
    });
  });
});

describe("provisionFaxNumber", () => {
  it("orders the first fax-capable candidate", async () => {
    const httpGet = makeGet([
      { phoneNumber: "+12155550001", features: ["voice"] },
      { phoneNumber: "+12155550002", features: ["voice", "fax"] },
    ]);
    const ordered: string[] = [];
    const httpPost: NumbersHttpPost = vi.fn(async (_url, _key, body) => {
      const pn = (body.phone_numbers as Array<{ phone_number: string }>)[0]!
        .phone_number;
      ordered.push(pn);
      return { orderId: "ord-9", phoneNumber: pn, status: "pending" };
    });
    const client = createTelnyxNumberClient({
      ...BASE_CREDS,
      httpGet,
      httpPost,
    });
    const result = await client.provisionFaxNumber({ areaCode: "215" });
    expect(ordered[0]).toBe("+12155550002");
    expect(result).toEqual({
      orderId: "ord-9",
      phoneNumber: "+12155550002",
      status: "pending",
    });
  });

  it("throws TelnyxApiError when no fax-capable number is available", async () => {
    const httpGet = makeGet([
      { phoneNumber: "+12155550001", features: ["voice"] },
    ]);
    const httpPost = makePost({
      orderId: "x",
      phoneNumber: "x",
      status: "pending",
    });
    const client = createTelnyxNumberClient({
      ...BASE_CREDS,
      httpGet,
      httpPost,
    });
    await expect(
      client.provisionFaxNumber({ areaCode: "999" }),
    ).rejects.toBeInstanceOf(TelnyxApiError);
    expect(httpPost).not.toHaveBeenCalled();
  });
});

describe("releaseFaxNumber", () => {
  it("looks the number up by E.164 then deletes it by id", async () => {
    const lookupUrls: string[] = [];
    const deleteUrls: string[] = [];
    const httpLookup: NumbersHttpLookup = vi.fn(async (url) => {
      lookupUrls.push(url);
      return "num-123";
    });
    const httpDelete: NumbersHttpDelete = vi.fn(async (url) => {
      deleteUrls.push(url);
    });
    const client = createTelnyxNumberClient({
      ...BASE_CREDS,
      httpLookup,
      httpDelete,
    });
    const result = await client.releaseFaxNumber("+12155551212");
    expect(result).toEqual({ released: true, phoneNumberId: "num-123" });
    expect(decodeURIComponent(lookupUrls[0]!)).toContain(
      "filter[phone_number]=+12155551212",
    );
    expect(deleteUrls[0]).toBe(
      "https://api.telnyx.com/v2/phone_numbers/num-123",
    );
  });

  it("is idempotent when the number is not on the account", async () => {
    const httpLookup: NumbersHttpLookup = vi.fn(async () => null);
    const httpDelete: NumbersHttpDelete = vi.fn(async () => {});
    const client = createTelnyxNumberClient({
      ...BASE_CREDS,
      httpLookup,
      httpDelete,
    });
    const result = await client.releaseFaxNumber("+12155550000");
    expect(result).toEqual({ released: false, phoneNumberId: null });
    expect(httpDelete).not.toHaveBeenCalled();
  });
});

describe("default fetch path", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses the availability data envelope and features", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  phone_number: "+12155551212",
                  features: [{ name: "fax" }, { name: "voice" }],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const client = createTelnyxNumberClient(BASE_CREDS);
    const rows = await client.searchAvailableFaxNumbers();
    expect(rows).toEqual([
      { phoneNumber: "+12155551212", features: ["fax", "voice"] },
    ]);
  });

  it("parses the order data envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                id: "ord-7",
                status: "success",
                phone_numbers: [{ phone_number: "+12155551212" }],
              },
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const client = createTelnyxNumberClient(BASE_CREDS);
    const result = await client.orderNumber({ phoneNumber: "+12155551212" });
    expect(result).toEqual({
      orderId: "ord-7",
      phoneNumber: "+12155551212",
      status: "success",
    });
  });

  it("maps a Telnyx error envelope to TelnyxApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              errors: [{ code: "10015", title: "Bad", detail: "no inventory" }],
            }),
            { status: 422, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const client = createTelnyxNumberClient(BASE_CREDS);
    await expect(client.searchAvailableFaxNumbers()).rejects.toMatchObject({
      name: "TelnyxApiError",
      status: 422,
      code: "10015",
      message: "no inventory",
    });
  });

  it("releaseFaxNumber parses lookup id then DELETEs (and treats 404 as success)", async () => {
    const calls: Array<{ method: string; status: number }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "GET") {
          calls.push({ method, status: 200 });
          return new Response(JSON.stringify({ data: [{ id: "num-9" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        // DELETE → simulate "already gone"; release should still succeed.
        calls.push({ method, status: 404 });
        return new Response(null, { status: 404 });
      }),
    );
    const client = createTelnyxNumberClient(BASE_CREDS);
    const result = await client.releaseFaxNumber("+12155551212");
    expect(result).toEqual({ released: true, phoneNumberId: "num-9" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
  });
});
