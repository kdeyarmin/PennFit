// Carrier-label adapter — interface boundary for ShipStation /
// EasyPost / Shippo style integrations.
//
// Today: returns a 503 result and lets the caller render a "label
// generation not yet wired up" banner. The interface and result
// shape are stable so the worker that drives outbound shipments
// (and the return-label flow that drives shop_returns) can call
// against a real type without waiting for the partner integration.
//
// When a real adapter is added, populate the env var
// CARRIER_LABEL_VENDOR (e.g. "shipstation") and a per-vendor
// secret; the dispatcher in `selectAdapter()` chooses by env value
// at runtime so swapping vendors is a config change, not a code
// change.

export type LabelKind = "outbound" | "return";

export type CarrierLabelInput = {
  kind: LabelKind;
  to: {
    name: string;
    line1: string;
    line2?: string | null;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    phone?: string | null;
  };
  from: {
    name: string;
    line1: string;
    line2?: string | null;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    phone?: string | null;
  };
  weightOz: number;
  carrierHint?: "USPS" | "UPS" | "FedEx" | "DHL";
};

export type CarrierLabelResult =
  | {
      ok: true;
      carrier: string;
      trackingNumber: string;
      /** PDF or PNG bytes — base64 to keep the interface JSON-shaped. */
      labelBase64: string;
      labelMime: "application/pdf" | "image/png";
      shippingCostCents: number | null;
    }
  | {
      ok: false;
      error: "vendor_not_configured" | "vendor_error" | "invalid_address";
      message: string;
    };

export interface CarrierLabelAdapter {
  vendorName: string;
  createLabel(input: CarrierLabelInput): Promise<CarrierLabelResult>;
}

class NullAdapter implements CarrierLabelAdapter {
  readonly vendorName = "null";
  async createLabel(): Promise<CarrierLabelResult> {
    return {
      ok: false,
      error: "vendor_not_configured",
      message:
        "Set CARRIER_LABEL_VENDOR + the vendor's API key to enable label generation.",
    };
  }
}

/**
 * Resolve the carrier-label adapter for this process. Returns the
 * null adapter when no vendor is configured; callers handle the
 * `ok: false` path identically regardless of adapter.
 */
export function selectAdapter(): CarrierLabelAdapter {
  // Future: switch on process.env.CARRIER_LABEL_VENDOR and return
  // a real adapter. Keep the null path as the unset default — every
  // caller must already handle the vendor_not_configured branch.
  return new NullAdapter();
}
