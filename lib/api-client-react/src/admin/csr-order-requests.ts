// Hand-authored React Query hooks for the CSR "sign & pay" order
// admin endpoints (no OpenAPI/orval pipeline — see CLAUDE.md). Mirrors
// the patient-packets hooks but stays compact.

import {
  useMutation,
  useQuery,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";

import { customFetch, type ErrorType } from "./custom-fetch";

export interface CsrOrderItem {
  description: string;
  quantity: number;
  unitAmountCents: number;
}

export type CsrOrderRequestStatus = "sent" | "viewed" | "signed" | "canceled";

export interface CsrOrderPaymentState {
  status: "not_started" | "pending" | "paid" | "refunded";
  paidAt: string | null;
  shopOrderId: string | null;
}

export interface CsrOrderRequestSummary {
  id: string;
  orderReference: string;
  status: CsrOrderRequestStatus;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  items: CsrOrderItem[];
  amountTotalCents: number;
  currency: string;
  noteToCustomer: string | null;
  documents: { key: string; title: string; requiresSignature: boolean }[];
  expiresAt: string | null;
  sentAt: string | null;
  firstViewedAt: string | null;
  signedAt: string | null;
  signerName: string | null;
  canceledAt: string | null;
  payment: CsrOrderPaymentState;
  createdByEmail: string | null;
  createdAt: string;
}

export interface CsrOrderRequestListResponse {
  requests: CsrOrderRequestSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreateCsrOrderRequest {
  customerName: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  items: CsrOrderItem[];
  noteToCustomer?: string | null;
  documentKeys?: string[];
  expiresInDays?: number;
}

export interface CreateCsrOrderResponse {
  id: string;
  orderReference: string;
  status: "sent";
  signingLink: string;
  emailSent: boolean;
  smsSent: boolean;
}

export interface ResendCsrOrderResponse {
  status: string;
  signingLink: string;
  emailSent: boolean;
  smsSent: boolean;
}

type CsrOrderError = ErrorType<{ error?: string; message?: string }>;

const BASE_URL = "/resupply-api/admin/csr-order-requests";

export const getCsrOrderRequestsQueryKey = (params?: {
  status?: string;
  page?: number;
  pageSize?: number;
}) => [BASE_URL, params ?? {}] as const;

export function useCsrOrderRequests(
  params?: { status?: string; page?: number; pageSize?: number },
  options?: {
    query?: Partial<
      UseQueryOptions<CsrOrderRequestListResponse, CsrOrderError>
    >;
  },
) {
  const search = new URLSearchParams();
  if (params?.status) search.set("status", params.status);
  if (params?.page) search.set("page", String(params.page));
  if (params?.pageSize) search.set("pageSize", String(params.pageSize));
  const qs = search.toString();
  return useQuery<CsrOrderRequestListResponse, CsrOrderError>({
    queryKey: getCsrOrderRequestsQueryKey(params),
    queryFn: ({ signal }) =>
      customFetch<CsrOrderRequestListResponse>(
        qs ? `${BASE_URL}?${qs}` : BASE_URL,
        { method: "GET", signal },
      ),
    ...options?.query,
  });
}

export function useCreateCsrOrderRequest(options?: {
  mutation?: UseMutationOptions<
    CreateCsrOrderResponse,
    CsrOrderError,
    CreateCsrOrderRequest
  >;
}) {
  return useMutation<
    CreateCsrOrderResponse,
    CsrOrderError,
    CreateCsrOrderRequest
  >({
    mutationFn: (data) =>
      customFetch<CreateCsrOrderResponse>(BASE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    ...options?.mutation,
  });
}

export function useResendCsrOrderRequest(options?: {
  mutation?: UseMutationOptions<
    ResendCsrOrderResponse,
    CsrOrderError,
    { id: string }
  >;
}) {
  return useMutation<ResendCsrOrderResponse, CsrOrderError, { id: string }>({
    mutationFn: ({ id }) =>
      customFetch<ResendCsrOrderResponse>(
        `${BASE_URL}/${encodeURIComponent(id)}/resend`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      ),
    ...options?.mutation,
  });
}

export function useCancelCsrOrderRequest(options?: {
  mutation?: UseMutationOptions<
    { status: "canceled" },
    CsrOrderError,
    { id: string }
  >;
}) {
  return useMutation<{ status: "canceled" }, CsrOrderError, { id: string }>({
    mutationFn: ({ id }) =>
      customFetch<{ status: "canceled" }>(
        `${BASE_URL}/${encodeURIComponent(id)}/cancel`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      ),
    ...options?.mutation,
  });
}
