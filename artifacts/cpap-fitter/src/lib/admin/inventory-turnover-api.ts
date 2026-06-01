// Fetch wrapper for /admin/analytics/inventory-turnover (Owner #7).
// Route returns camelCase.

import { ApiError } from "@workspace/api-client-react/admin";

export interface InvProductRow {
  productId: string;
  productName: string | null;
  unitsSold: number;
  revenueCents: number;
  cogsKnownCents: number;
  onHandQty: number | null;
  unitCostCents: number | null;
  unitPriceCents: number | null;
  waitingCount: number;
  inventoryValueCents: number | null;
  annualizedCogsCents: number;
  turnover: number | null;
  stockoutDemandCents: number | null;
}

export interface InventoryTurnoverResponse {
  windowDays: number;
  products: InvProductRow[];
  totals: {
    inventoryValueCents: number;
    annualizedCogsCents: number;
    turnover: number | null;
    stockoutDemandCents: number;
    productsWithoutReconciliation: number;
  };
  generatedAt: string;
}

export async function fetchInventoryTurnover(
  days = 90,
): Promise<InventoryTurnoverResponse> {
  const url = `/resupply-api/admin/analytics/inventory-turnover?days=${days}`;
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as InventoryTurnoverResponse;
}
