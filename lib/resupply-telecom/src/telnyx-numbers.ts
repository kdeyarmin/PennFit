// @workspace/resupply-telecom — Telnyx number-search + ordering client.
//
// Used to PROVISION a fax-capable phone number for a tenant (DME company)
// when it signs up. Twilio retired Programmable Fax, so — like the fax
// SEND path in telnyx-fax.ts — number provisioning for fax goes through
// Telnyx's v2 REST API:
//   * GET  /v2/available_phone_numbers  — search for a fax-capable DID
//   * POST /v2/number_orders            — buy one and route it to the
//                                         fax Application (connection)
//
// Ordering a number costs money and assigns a real DID, so callers gate
// this behind an explicit operator action (the tenant:onboard
// `--provision-fax` flag, or the admin "Provision fax number" button).
//
// Environment:
//   - TELNYX_API_KEY            — required for every operation. Bearer key
//                                 (Keys & Credentials).
//   - TELNYX_FAX_CONNECTION_ID  — required only to ORDER a number. The Fax
//                                 Application ("connection") the ordered
//                                 number is attached to, so inbound faxes
//                                 hit our webhook and outbound faxes send
//                                 from it. Search/release need only the key.
//
// Architecture: this package MUST NOT import @workspace/resupply-db (Rule
// 10). Persisting the provisioned number onto `organizations.fax_from_number`
// is the CALLER's job — this client only talks to Telnyx.
//
// PHI note: a tenant's own fax DID is business data, not PHI. Recipient /
// sender fax numbers are handled (and kept out of logs) by the fax SEND /
// RECEIVE paths, not here.

import { TelnyxApiError, TelnyxConfigError } from "./telnyx-fax";

const AVAILABLE_NUMBERS_URL =
  "https://api.telnyx.com/v2/available_phone_numbers";
const NUMBER_ORDERS_URL = "https://api.telnyx.com/v2/number_orders";
const PHONE_NUMBERS_URL = "https://api.telnyx.com/v2/phone_numbers";

/** A fax-capable DID returned by the availability search. */
export interface AvailableFaxNumber {
  /** E.164 phone number, e.g. "+12155551212". */
  phoneNumber: string;
  /** Capability names Telnyx reports for it (e.g. ["voice","fax"]). */
  features: string[];
}

export interface SearchFaxNumbersInput {
  /** ISO-3166 alpha-2 country, default "US". */
  countryCode?: string;
  /**
   * National destination code (US area code, e.g. "215") to keep the
   * tenant's fax number local to them. Omit to let Telnyx pick.
   */
  areaCode?: string;
  /** How many candidates to return. Default 10. */
  limit?: number;
}

export interface OrderNumberInput {
  /** E.164 number to buy (from a prior availability search). */
  phoneNumber: string;
  /** Opaque reference stored on the Telnyx order (we pass the org slug/id). */
  customerReference?: string;
}

export interface OrderNumberResult {
  /** Telnyx number-order id (UUID). Persist for audit/reconciliation. */
  orderId: string;
  /** The ordered number in E.164. */
  phoneNumber: string;
  /** Order status: "pending" | "success" | "failure". */
  status: string;
}

export interface ProvisionFaxNumberInput {
  countryCode?: string;
  areaCode?: string;
  customerReference?: string;
}

export type ProvisionFaxNumberResult = OrderNumberResult;

export interface ReleaseFaxNumberResult {
  /**
   * True when this call actually deleted the number; false when it was
   * already gone — either not on the account at lookup time, or the DELETE
   * returned 404. Either way the number is no longer ours.
   */
  released: boolean;
  /** The Telnyx phone-number record id that was released, when known. */
  phoneNumberId: string | null;
}

export interface TelnyxNumberClient {
  /** Search Telnyx for fax-capable numbers matching the filters. */
  searchAvailableFaxNumbers(
    input?: SearchFaxNumbersInput,
  ): Promise<AvailableFaxNumber[]>;
  /** Buy a specific number and attach it to the fax connection. */
  orderNumber(input: OrderNumberInput): Promise<OrderNumberResult>;
  /**
   * Convenience: search for a fax-capable number then order the first
   * match, all in one call. Throws TelnyxApiError when nothing matches.
   */
  provisionFaxNumber(
    input?: ProvisionFaxNumberInput,
  ): Promise<ProvisionFaxNumberResult>;
  /**
   * Release (delete) a number back to Telnyx by its E.164 — used when a
   * tenant offboards so we stop paying for the DID. Idempotent: a number
   * that isn't on the account returns `{ released: false }` rather than
   * throwing, so a re-run after a partial failure is safe.
   */
  releaseFaxNumber(phoneNumber: string): Promise<ReleaseFaxNumberResult>;
}

/** Test-only seams: replace the HTTP calls without touching global fetch. */
export type NumbersHttpGet = (
  url: string,
  apiKey: string,
) => Promise<AvailableFaxNumber[]>;
export type NumbersHttpPost = (
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
) => Promise<OrderNumberResult>;
/** Look up a Telnyx phone-number record id by E.164; null when not found. */
export type NumbersHttpLookup = (
  url: string,
  apiKey: string,
) => Promise<string | null>;
/**
 * DELETE a Telnyx phone-number record by id. Resolves `true` when the
 * record was actually deleted, `false` when it was already gone (404).
 */
export type NumbersHttpDelete = (
  url: string,
  apiKey: string,
) => Promise<boolean>;

export interface CreateTelnyxNumberClientOptions {
  apiKey?: string;
  connectionId?: string;
  /** Test-only seams. Production callers leave undefined. */
  httpGet?: NumbersHttpGet;
  httpPost?: NumbersHttpPost;
  httpLookup?: NumbersHttpLookup;
  httpDelete?: NumbersHttpDelete;
}

/**
 * Build a TelnyxNumberClient. Reads credentials from the environment when
 * options are unset, and throws TelnyxConfigError at construction when
 * they're missing — better to fail before a half-finished provision than
 * inside the search/order flow.
 */
export function createTelnyxNumberClient(
  opts: CreateTelnyxNumberClientOptions = {},
): TelnyxNumberClient {
  const apiKey = opts.apiKey ?? process.env.TELNYX_API_KEY;
  const connectionId =
    opts.connectionId ?? process.env.TELNYX_FAX_CONNECTION_ID;

  if (!apiKey) {
    throw new TelnyxConfigError(
      "TELNYX_API_KEY is not set — refusing to construct Telnyx number client.",
    );
  }
  // NOTE: connectionId is required only to ORDER a number (it attaches the
  // DID to the fax Application). Searching and RELEASING need just the API
  // key, so we don't demand it at construction — that would orphan a
  // billable DID on offboard in an API-key-only environment. orderNumber()
  // throws if it's missing.

  const httpGet = opts.httpGet ?? defaultHttpGet;
  const httpPost = opts.httpPost ?? defaultHttpPost;
  const httpLookup = opts.httpLookup ?? defaultHttpLookup;
  const httpDelete = opts.httpDelete ?? defaultHttpDelete;

  async function searchAvailableFaxNumbers(
    input: SearchFaxNumbersInput = {},
  ): Promise<AvailableFaxNumber[]> {
    const params = new URLSearchParams();
    params.set("filter[country_code]", input.countryCode?.trim() || "US");
    // Fax is the capability that matters; voice usually rides along on a
    // local DID, but we explicitly require fax so the number can carry it.
    params.append("filter[features][]", "fax");
    params.set("filter[phone_number_type]", "local");
    const areaCode = input.areaCode?.trim();
    if (areaCode) params.set("filter[national_destination_code]", areaCode);
    params.set("filter[limit]", String(input.limit ?? 10));
    const url = `${AVAILABLE_NUMBERS_URL}?${params.toString()}`;
    return wrapApi(() => httpGet(url, apiKey!));
  }

  async function orderNumber(
    input: OrderNumberInput,
  ): Promise<OrderNumberResult> {
    if (!connectionId) {
      throw new TelnyxConfigError(
        "TELNYX_FAX_CONNECTION_ID is not set — required to order/attach a fax number.",
      );
    }
    const body: Record<string, unknown> = {
      phone_numbers: [{ phone_number: input.phoneNumber }],
      // Attach to the fax Application so inbound faxes reach our webhook
      // and outbound faxes can send from this number.
      connection_id: connectionId,
    };
    if (input.customerReference) {
      body.customer_reference = input.customerReference;
    }
    return wrapApi(() => httpPost(NUMBER_ORDERS_URL, apiKey!, body));
  }

  async function provisionFaxNumber(
    input: ProvisionFaxNumberInput = {},
  ): Promise<ProvisionFaxNumberResult> {
    const candidates = await searchAvailableFaxNumbers({
      countryCode: input.countryCode,
      areaCode: input.areaCode,
      limit: 10,
    });
    const pick = candidates.find((c) =>
      c.features.map((f) => f.toLowerCase()).includes("fax"),
    );
    if (!pick) {
      throw new TelnyxApiError(
        input.areaCode
          ? `No fax-capable Telnyx numbers available in area code ${input.areaCode}.`
          : "No fax-capable Telnyx numbers available for the requested search.",
        404,
      );
    }
    return orderNumber({
      phoneNumber: pick.phoneNumber,
      customerReference: input.customerReference,
    });
  }

  async function releaseFaxNumber(
    phoneNumber: string,
  ): Promise<ReleaseFaxNumberResult> {
    const lookupUrl = `${PHONE_NUMBERS_URL}?filter[phone_number]=${encodeURIComponent(
      phoneNumber,
    )}`;
    const phoneNumberId = await wrapApi(() => httpLookup(lookupUrl, apiKey!));
    if (!phoneNumberId) {
      // Not on the account (already released, or never ours) — idempotent.
      return { released: false, phoneNumberId: null };
    }
    // `deleted` is false when the DELETE 404s (the record vanished between
    // lookup and delete) — still no-longer-ours, but not a delete WE made.
    const deleted = await wrapApi(() =>
      httpDelete(`${PHONE_NUMBERS_URL}/${phoneNumberId}`, apiKey!),
    );
    return { released: deleted, phoneNumberId };
  }

  return {
    searchAvailableFaxNumbers,
    orderNumber,
    provisionFaxNumber,
    releaseFaxNumber,
  };
}

/** Normalize unknown throws into TelnyxApiError so callers get one shape. */
async function wrapApi<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TelnyxApiError || err instanceof TelnyxConfigError) {
      throw err;
    }
    const e = err as {
      status?: number;
      code?: number | string;
      message?: string;
    };
    throw new TelnyxApiError(
      e.message ?? "Telnyx number API error",
      e.status,
      e.code,
    );
  }
}

/** Pull the `{ errors: [...] }` envelope Telnyx returns on a non-2xx. */
function firstErrorMessage(
  parsed: Record<string, unknown>,
  status: number,
  fallback: string,
): { message: string; code?: string | number } {
  const errors = Array.isArray(parsed["errors"])
    ? (parsed["errors"] as Array<Record<string, unknown>>)
    : [];
  const first = errors[0];
  const message =
    first && typeof first["detail"] === "string"
      ? (first["detail"] as string)
      : first && typeof first["title"] === "string"
        ? (first["title"] as string)
        : `${fallback} (HTTP ${status})`;
  const code =
    first &&
    (typeof first["code"] === "string" || typeof first["code"] === "number")
      ? (first["code"] as string | number)
      : undefined;
  return { message, code };
}

async function defaultHttpGet(
  url: string,
  apiKey: string,
): Promise<AvailableFaxNumber[]> {
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new TelnyxApiError(
      `Telnyx number search: non-JSON response (HTTP ${res.status})`,
      res.status,
    );
  }
  const p = parsed as Record<string, unknown>;
  if (!res.ok) {
    const { message, code } = firstErrorMessage(
      p,
      res.status,
      "Telnyx number search error",
    );
    throw new TelnyxApiError(message, res.status, code);
  }
  const data = Array.isArray(p["data"])
    ? (p["data"] as Array<Record<string, unknown>>)
    : [];
  return data
    .map((row) => {
      const phoneNumber =
        typeof row["phone_number"] === "string"
          ? (row["phone_number"] as string)
          : null;
      const features = Array.isArray(row["features"])
        ? (row["features"] as Array<Record<string, unknown>>)
            .map((f) =>
              typeof f["name"] === "string" ? (f["name"] as string) : null,
            )
            .filter((n): n is string => n !== null)
        : [];
      return phoneNumber ? { phoneNumber, features } : null;
    })
    .filter((n): n is AvailableFaxNumber => n !== null);
}

async function defaultHttpPost(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<OrderNumberResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new TelnyxApiError(
      `Telnyx number order: non-JSON response (HTTP ${res.status})`,
      res.status,
    );
  }
  const p = parsed as Record<string, unknown>;
  if (!res.ok) {
    const { message, code } = firstErrorMessage(
      p,
      res.status,
      "Telnyx number order error",
    );
    throw new TelnyxApiError(message, res.status, code);
  }
  const data = p["data"];
  if (!data || typeof data !== "object") {
    throw new TelnyxApiError(
      "Telnyx number order: response missing data",
      res.status,
    );
  }
  const d = data as Record<string, unknown>;
  if (typeof d["id"] !== "string") {
    throw new TelnyxApiError(
      "Telnyx number order: response missing id",
      res.status,
    );
  }
  // The ordered number echoes back in phone_numbers[0]; fall back to the
  // requested number when the array is shaped differently.
  const ordered = Array.isArray(d["phone_numbers"])
    ? (d["phone_numbers"] as Array<Record<string, unknown>>)
    : [];
  const requested =
    Array.isArray(body["phone_numbers"]) &&
    typeof (body["phone_numbers"] as Array<Record<string, unknown>>)[0]?.[
      "phone_number"
    ] === "string"
      ? ((body["phone_numbers"] as Array<Record<string, unknown>>)[0]![
          "phone_number"
        ] as string)
      : "";
  const phoneNumber =
    typeof ordered[0]?.["phone_number"] === "string"
      ? (ordered[0]!["phone_number"] as string)
      : requested;

  return {
    orderId: d["id"] as string,
    phoneNumber,
    status:
      typeof d["status"] === "string" ? (d["status"] as string) : "pending",
  };
}

async function defaultHttpLookup(
  url: string,
  apiKey: string,
): Promise<string | null> {
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new TelnyxApiError(
      `Telnyx number lookup: non-JSON response (HTTP ${res.status})`,
      res.status,
    );
  }
  const p = parsed as Record<string, unknown>;
  if (!res.ok) {
    const { message, code } = firstErrorMessage(
      p,
      res.status,
      "Telnyx number lookup error",
    );
    throw new TelnyxApiError(message, res.status, code);
  }
  const data = Array.isArray(p["data"])
    ? (p["data"] as Array<Record<string, unknown>>)
    : [];
  const id = data[0]?.["id"];
  return typeof id === "string" ? id : null;
}

async function defaultHttpDelete(
  url: string,
  apiKey: string,
): Promise<boolean> {
  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  // 200/202/204 mean we deleted it. A 404 means it was already gone — an
  // idempotent no-op, reported as `false` so the caller can tell the two
  // apart.
  if (res.ok) return true;
  if (res.status === 404) return false;
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new TelnyxApiError(
      `Telnyx number delete: non-JSON error (HTTP ${res.status})`,
      res.status,
    );
  }
  const { message, code } = firstErrorMessage(
    parsed as Record<string, unknown>,
    res.status,
    "Telnyx number delete error",
  );
  throw new TelnyxApiError(message, res.status, code);
}
