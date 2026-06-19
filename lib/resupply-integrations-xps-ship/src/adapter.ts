// XPS Ship adapter — the one place PennFit talks to the XPS REST API.
//
// XPS's eCommerce REST API is a STAGE-then-PROCESS model: there is no
// single "buy this label" call. You PUT an order (Put Order) carrying the
// merged patient/address data; XPS turns it into a booked shipment (with a
// bookNumber, tracking number, and printable label) either via the
// operator's Webship rules or auto-processing. PennFit then resolves the
// resulting shipment by searching for the order id, and retrieves the
// label bytes for printing.
//
// Methods exposed:
//   availability()            — configured / stub
//   quoteRates(input)         — rate-shop carriers (informational)
//   createOrder(input)        — Put Order (stage with merged data)
//   findShipmentByOrderId(id) — resolve bookNumber/tracking once processed
//   getShipment(bookNumber)   — refresh tracking/carrier/cost
//   getLabel(bookNumber, fmt) — printable label bytes (PDF / PNG)
//   deleteOrder(orderId)      — cancel a staged (un-processed) order
//
// All errors are normalised to the XpsError union; XPS response bodies
// never leak into thrown errors or logs.

import {
  readXpsShipConfigOrNull,
  isXpsShipUnconfigured,
  type XpsAddress,
  type XpsShipConfig,
} from "./config";
import {
  parseRates,
  parseSearchShipments,
  parseShipment,
  parsePngLabel,
  type XpsCreateOrderInput,
  type XpsError,
  type XpsLabel,
  type XpsParcel,
  type XpsQuoteInput,
  type XpsRate,
  type XpsShipment,
} from "./types";

export type XpsAvailability =
  | { status: "configured" }
  | { status: "stub"; reason: "no_credentials" | "incomplete_config" };

export type XpsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: XpsError };

const DEFAULT_TIMEOUT_MS = 30_000;
/** oz → lb, rounded to 2 dp (XPS wants pounds with `weightUnit: "lb"`). */
const ozToLb = (oz: number): string => (oz / 16).toFixed(2);

class XpsHttpError extends Error {
  constructor(public readonly kind: XpsError) {
    super(kind);
  }
}

function mapStatus(status: number): XpsError {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "invalid_request";
  return "unavailable";
}

export interface XpsShipAdapter {
  availability(): XpsAvailability;
  quoteRates(input: XpsQuoteInput): Promise<XpsResult<XpsRate[]>>;
  createOrder(
    input: XpsCreateOrderInput,
  ): Promise<XpsResult<{ orderId: string }>>;
  findShipmentByOrderId(
    orderId: string,
  ): Promise<XpsResult<XpsShipment | null>>;
  getShipment(bookNumber: string): Promise<XpsResult<XpsShipment | null>>;
  getLabel(
    bookNumber: string,
    format?: "PDF" | "PNG",
  ): Promise<XpsResult<XpsLabel>>;
  deleteOrder(orderId: string): Promise<XpsResult<true>>;
}

interface AdapterDeps {
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createXpsShipAdapter(
  env: NodeJS.ProcessEnv = process.env,
  deps: AdapterDeps = {},
): XpsShipAdapter {
  const config = readXpsShipConfigOrNull(env);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function availability(): XpsAvailability {
    if (config) return { status: "configured" };
    return {
      status: "stub",
      reason: isXpsShipUnconfigured(env)
        ? "no_credentials"
        : "incomplete_config",
    };
  }

  async function request(
    cfg: XpsShipConfig,
    method: string,
    path: string,
    body?: unknown,
    accept = "application/json",
  ): Promise<{ json: unknown; bytes: Uint8Array; contentType: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${cfg.apiBaseUrl}${path}`, {
        method,
        headers: {
          Authorization: `RSIS ${cfg.apiKey}`,
          Accept: accept,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) throw new XpsHttpError(mapStatus(res.status));
      const contentType = res.headers.get("content-type") ?? "";
      const buf = new Uint8Array(await res.arrayBuffer());
      let json: unknown = null;
      if (contentType.includes("application/json")) {
        try {
          json = JSON.parse(Buffer.from(buf).toString("utf8"));
        } catch {
          json = null;
        }
      }
      return { json, bytes: buf, contentType };
    } catch (err) {
      if (err instanceof XpsHttpError) throw err;
      // AbortError / network failure / DNS — all "unavailable".
      throw new XpsHttpError("unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  function toXpsAddress(a: XpsAddress): Record<string, unknown> {
    return {
      name: a.name,
      company: a.company ?? "",
      address1: a.address1,
      address2: a.address2 ?? "",
      city: a.city,
      state: a.state,
      zip: a.zip,
      country: a.country || "US",
      phone: a.phone ?? "",
      email: a.email ?? "",
    };
  }

  function toPackages(parcels: XpsParcel[]): Array<Record<string, unknown>> {
    return parcels.map((p) => ({
      weight: ozToLb(p.weightOz),
      length: p.lengthIn != null ? String(p.lengthIn) : "",
      width: p.widthIn != null ? String(p.widthIn) : "",
      height: p.heightIn != null ? String(p.heightIn) : "",
      insuranceAmount: null,
      declaredValue: null,
    }));
  }

  async function run<T>(
    fn: (cfg: XpsShipConfig) => Promise<T>,
  ): Promise<XpsResult<T>> {
    if (!config) return { ok: false, error: "unavailable" };
    try {
      return { ok: true, value: await fn(config) };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof XpsHttpError ? err.kind : "unknown_error",
      };
    }
  }

  return {
    availability,

    quoteRates(input) {
      return run(async (cfg) => {
        const pieces = input.parcels.map((p) => ({
          weight: ozToLb(p.weightOz),
          length: p.lengthIn != null ? String(p.lengthIn) : "",
          width: p.widthIn != null ? String(p.widthIn) : "",
          height: p.heightIn != null ? String(p.heightIn) : "",
        }));
        const { json } = await request(
          cfg,
          "POST",
          `/customers/${encodeURIComponent(cfg.customerId)}/quote`,
          {
            weightUnit: "lb",
            dimUnit: "in",
            residential: input.residential ?? true,
            ...(input.carrierCode ? { carrierCode: input.carrierCode } : {}),
            sender: { country: cfg.sender.country, zip: cfg.sender.zip },
            receiver: {
              country: input.receiver.country || "US",
              zip: input.receiver.zip,
              city: input.receiver.city,
            },
            pieces,
          },
        );
        return parseRates(json);
      });
    },

    createOrder(input) {
      return run(async (cfg) => {
        const path =
          `/customers/${encodeURIComponent(cfg.customerId)}` +
          `/integrations/${encodeURIComponent(cfg.integrationId)}` +
          `/orders/${encodeURIComponent(input.orderId)}`;
        await request(cfg, "PUT", path, {
          orderId: input.orderId,
          orderNumber: input.orderNumber ?? input.orderId,
          orderDate: new Date().toISOString().slice(0, 10),
          fulfillmentStatus: "pending",
          weightUnit: "lb",
          dimUnit: "in",
          ...(input.shippingService
            ? { shippingService: input.shippingService }
            : {}),
          ...(input.contentDescription
            ? { contentDescription: input.contentDescription }
            : {}),
          ...(input.reference1 ? { shipperReference: input.reference1 } : {}),
          ...(input.reference2 ? { shipperReference2: input.reference2 } : {}),
          sender: toXpsAddress(cfg.sender),
          receiver: toXpsAddress(input.receiver),
          returnTo: toXpsAddress(cfg.sender),
          packages: toPackages(input.parcels),
        });
        return { orderId: input.orderId };
      });
    },

    findShipmentByOrderId(orderId) {
      return run(async (cfg) => {
        const { json } = await request(
          cfg,
          "POST",
          `/customers/${encodeURIComponent(cfg.customerId)}/searchShipments`,
          { keyword: orderId },
        );
        const shipments = parseSearchShipments(json);
        // The keyword search is fuzzy across many fields — pin to the exact
        // order id so an unrelated partial match never gets booked back.
        const exact = shipments.find((s) => s.orderId === orderId);
        return exact ?? shipments[0] ?? null;
      });
    },

    getShipment(bookNumber) {
      return run(async (cfg) => {
        const { json } = await request(
          cfg,
          "GET",
          `/customers/${encodeURIComponent(cfg.customerId)}/shipments/${encodeURIComponent(bookNumber)}`,
        );
        return parseShipment(json);
      });
    },

    getLabel(bookNumber, format) {
      return run(async (cfg) => {
        const fmt = format ?? cfg.labelFormat;
        const accept = fmt === "PDF" ? "application/pdf" : "application/json";
        const { json, bytes, contentType } = await request(
          cfg,
          "GET",
          `/customers/${encodeURIComponent(cfg.customerId)}/shipments/${encodeURIComponent(bookNumber)}/label/${fmt}`,
          undefined,
          accept,
        );
        if (fmt === "PNG") {
          const png = parsePngLabel(json);
          if (!png) throw new XpsHttpError("not_found");
          return { format: "PNG", bytes: png, contentType: "image/png" };
        }
        return {
          format: "PDF",
          bytes,
          contentType: contentType.includes("pdf")
            ? "application/pdf"
            : "application/pdf",
        } satisfies XpsLabel;
      });
    },

    deleteOrder(orderId) {
      return run(async (cfg) => {
        const path =
          `/customers/${encodeURIComponent(cfg.customerId)}` +
          `/integrations/${encodeURIComponent(cfg.integrationId)}` +
          `/orders/${encodeURIComponent(orderId)}`;
        await request(cfg, "DELETE", path);
        return true as const;
      });
    },
  };
}
