// Hand-authored React Query hooks for the Front Desk (walk-in / counter)
// surface (no OpenAPI/orval pipeline — see CLAUDE.md). Mirrors the shape
// of the generated hooks but stays compact.
//
// Three pieces the Front Desk page needs:
//   * useFrontDeskCatalog()      — the live shop catalog (GET
//                                  /shop/products) so a CSR can pick line
//                                  items to ring up.
//   * useCreateCounterOrder()    — POST /admin/shop/counter-orders: ring
//                                  up a cash or bill-to-insurance order.
//   * useMarkCounterOrderPickedUp() — POST
//                                  /admin/shop/orders/:id/picked-up: hand
//                                  the product over the counter (reuses
//                                  the existing pickup-lifecycle endpoint).

import {
  useMutation,
  useQuery,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";

import { customFetch, type ErrorType } from "./custom-fetch";

type FrontDeskError = ErrorType<{ error?: string; message?: string }>;

// ── Catalog ────────────────────────────────────────────────────────

export interface FrontDeskProductPrice {
  id: string;
  unitAmount: number;
  currency: string;
}

export interface FrontDeskProduct {
  id: string;
  name: string;
  category: string;
  description: string | null;
  imageUrl: string | null;
  stockCount: number | null;
  price: FrontDeskProductPrice;
}

export interface FrontDeskCatalogResponse {
  previewMode: boolean;
  purchasingEnabled: boolean;
  categories: string[];
  products: FrontDeskProduct[];
}

const CATALOG_URL = "/resupply-api/shop/products";

export const getFrontDeskCatalogQueryKey = () => [CATALOG_URL] as const;

export function useFrontDeskCatalog(options?: {
  query?: Partial<UseQueryOptions<FrontDeskCatalogResponse, FrontDeskError>>;
}) {
  return useQuery<FrontDeskCatalogResponse, FrontDeskError>({
    queryKey: getFrontDeskCatalogQueryKey(),
    queryFn: ({ signal }) =>
      customFetch<FrontDeskCatalogResponse>(CATALOG_URL, {
        method: "GET",
        signal,
      }),
    ...options?.query,
  });
}

// ── Counter order ──────────────────────────────────────────────────

export interface CounterOrderLineItem {
  priceId: string;
  quantity: number;
}

export interface CounterOrderShippingAddress {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: "US";
}

export interface CreateCounterOrderRequest {
  patientId?: string | null;
  customerId?: string | null;
  customerEmail?: string | null;
  items: CounterOrderLineItem[];
  paymentMethod: "cash" | "insurance";
  fulfillmentMethod: "pickup" | "ship";
  pickupLocationId?: string | null;
  shippingAddress?: CounterOrderShippingAddress | null;
}

export interface CreateCounterOrderResponse {
  order: {
    id: string;
    status: "paid" | "pending";
    source: "counter";
    paymentMethod: "cash" | "insurance";
    fulfillmentMethod: "pickup" | "ship";
    pickupLocationId: string | null;
    amountTotalCents: number;
    currency: string | null;
    itemCount: number;
  };
}

const COUNTER_ORDERS_URL = "/resupply-api/admin/shop/counter-orders";

export function useCreateCounterOrder(options?: {
  mutation?: UseMutationOptions<
    CreateCounterOrderResponse,
    FrontDeskError,
    CreateCounterOrderRequest
  >;
}) {
  return useMutation<
    CreateCounterOrderResponse,
    FrontDeskError,
    CreateCounterOrderRequest
  >({
    mutationFn: (data) =>
      customFetch<CreateCounterOrderResponse>(COUNTER_ORDERS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    ...options?.mutation,
  });
}

// ── Hand over the counter (mark picked up) ─────────────────────────

export interface MarkPickedUpResponse {
  order: { id: string; status: string; pickedUpAt?: string | null };
}

export function useMarkCounterOrderPickedUp(options?: {
  mutation?: UseMutationOptions<
    MarkPickedUpResponse,
    FrontDeskError,
    { orderId: string }
  >;
}) {
  return useMutation<MarkPickedUpResponse, FrontDeskError, { orderId: string }>(
    {
      mutationFn: ({ orderId }) =>
        customFetch<MarkPickedUpResponse>(
          `/resupply-api/admin/shop/orders/${encodeURIComponent(orderId)}/picked-up`,
          { method: "POST" },
        ),
      ...options?.mutation,
    },
  );
}
