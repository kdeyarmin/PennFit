// Hand-rolled fetch wrappers for the inventory reconciliation
// endpoints. Mirrors the shape of shop-inventory-api.ts — same
// hand-typed contracts (no OpenAPI generation in this repo since
// Task #37) and same on-same-origin cookie auth.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export interface ReconciliationHeader {
  id: string;
  periodLabel: string;
  status: "draft" | "submitted";
  startedByEmail: string;
  startedByUserId: string | null;
  startedAt: string;
  submittedAt: string | null;
  notes: string | null;
  totalLines: number;
  totalVarianceUnits: number;
  appliedToStripe: boolean;
}

export interface ReconciliationListItem {
  id: string;
  periodLabel: string;
  status: "draft" | "submitted";
  startedByEmail: string;
  startedAt: string;
  submittedAt: string | null;
  totalLines: number;
  totalVarianceUnits: number;
  appliedToStripe: boolean;
}

export interface ReconciliationLine {
  id: string;
  productId: string;
  productName: string;
  systemCount: number | null;
  countedQty: number;
  variance: number;
  applied: boolean;
  createdAt: string;
}

export interface CurrentProductSnapshot {
  productId: string;
  name: string;
  category: string;
  systemCount: number | null;
  lowStockThreshold: number | null;
}

export interface ReconciliationDetail {
  reconciliation: ReconciliationHeader;
  lines: ReconciliationLine[];
  /** Live Stripe catalog snapshot — only populated for drafts. */
  currentProducts: CurrentProductSnapshot[] | null;
}

export class ReconciliationUnavailableError extends Error {
  constructor(
    public readonly reason: "stripe_not_configured" | "stripe_list_failed",
  ) {
    super(reason);
    this.name = "ReconciliationUnavailableError";
  }
}

const BASE = "/resupply-api/admin/shop/inventory/reconciliations";

export async function startReconciliation(input: {
  periodLabel: string;
  notes?: string | null;
}): Promise<{ id: string; startedAt: string }> {
  const res = await fetch(BASE, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let detail = `Start failed (${res.status})`;
    try {
      const body = (await res.json()) as {
        error?: string;
        issues?: Array<{ path: string; message: string }>;
      };
      if (body.issues && body.issues.length > 0) {
        detail = body.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
      } else if (body.error) {
        detail = body.error;
      }
    } catch {
      // fallthrough
    }
    throw new Error(detail);
  }
  return (await res.json()) as { id: string; startedAt: string };
}

export async function listReconciliations(): Promise<ReconciliationListItem[]> {
  const res = await fetch(BASE, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // non-JSON error body — status alone is enough
    }
    throw new ApiError(res, data, { method: "GET", url: res.url });
  }
  const json = (await res.json()) as {
    reconciliations: ReconciliationListItem[];
  };
  return json.reconciliations;
}

export async function getReconciliation(
  id: string,
): Promise<ReconciliationDetail> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // non-JSON error body — status alone is enough
    }
    throw new ApiError(res, data, { method: "GET", url: res.url });
  }
  return (await res.json()) as ReconciliationDetail;
}

export async function submitReconciliation(
  id: string,
  input: {
    lines: Array<{ productId: string; countedQty: number }>;
    applyToStripe: boolean;
  },
): Promise<{
  id: string;
  totalLines: number;
  totalVarianceUnits: number;
  appliedToStripe: boolean;
  stripeApplyFailures: number;
}> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}/submit`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(input),
  });
  if (res.status === 503) {
    throw new ReconciliationUnavailableError("stripe_not_configured");
  }
  if (res.status === 502) {
    throw new ReconciliationUnavailableError("stripe_list_failed");
  }
  if (!res.ok) {
    let detail = `Submit failed (${res.status})`;
    try {
      const body = (await res.json()) as {
        error?: string;
        issues?: Array<{ path: string; message: string }>;
      };
      if (body.issues && body.issues.length > 0) {
        detail = body.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
      } else if (body.error) {
        detail = body.error;
      }
    } catch {
      // fallthrough
    }
    throw new Error(detail);
  }
  return (await res.json()) as {
    id: string;
    totalLines: number;
    totalVarianceUnits: number;
    appliedToStripe: boolean;
    stripeApplyFailures: number;
  };
}
