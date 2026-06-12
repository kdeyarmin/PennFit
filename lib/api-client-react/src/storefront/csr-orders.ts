// Hand-authored React Query hooks for the public CSR-order "sign &
// pay" flow (token-gated, no login). Used by the cpap-fitter
// /order-pay page. See lib/api-client-react/src/admin/
// csr-order-requests.ts for the admin-side hooks.

import {
  useMutation,
  useQuery,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";

import { customFetch, type ErrorType } from "./custom-fetch";
import type { PacketDocumentSection } from "./patient-packets";

export interface PublicCsrOrderItem {
  description: string;
  quantity: number;
  unitAmountCents: number;
}

export interface PublicCsrOrderDocument {
  key: string;
  title: string;
  category: string;
  requiresSignature: boolean;
  sections: PacketDocumentSection[];
}

export interface PublicCsrOrderView {
  status: "open";
  orderReference: string;
  customerName: string;
  items: PublicCsrOrderItem[];
  amountTotalCents: number;
  currency: string;
  note: string | null;
  company: { legalName: string; phone: string; email: string };
  documents: PublicCsrOrderDocument[];
  signed: boolean;
  signedAt: string | null;
  payment: {
    status: "not_started" | "pending" | "paid" | "refunded";
    paidAt: string | null;
  };
}

export interface SignCsrOrderRequest {
  token: string;
  signerName: string;
  signatureImage?: string | null;
  consentEsign: true;
  acknowledgedDocumentKeys: string[];
}

export interface SignCsrOrderResponse {
  status: "signed";
  signedAt: string;
}

type CsrOrderError = ErrorType<{ error?: string; message?: string }>;

export const getViewCsrOrderQueryKey = (token: string) =>
  ["/api/csr-orders/view", token] as const;

export function useViewCsrOrder(
  token: string,
  options?: {
    query?: Partial<UseQueryOptions<PublicCsrOrderView, CsrOrderError>>;
  },
) {
  return useQuery<PublicCsrOrderView, CsrOrderError>({
    queryKey: getViewCsrOrderQueryKey(token),
    queryFn: ({ signal }) =>
      customFetch<PublicCsrOrderView>(
        `/api/csr-orders/view?token=${encodeURIComponent(token)}`,
        { method: "GET", signal },
      ),
    enabled: token.length > 0,
    retry: false,
    ...options?.query,
  });
}

export function useSignCsrOrder(options?: {
  mutation?: UseMutationOptions<
    SignCsrOrderResponse,
    CsrOrderError,
    SignCsrOrderRequest
  >;
}) {
  return useMutation<SignCsrOrderResponse, CsrOrderError, SignCsrOrderRequest>({
    mutationFn: (data) =>
      customFetch<SignCsrOrderResponse>("/api/csr-orders/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    ...options?.mutation,
  });
}

export function useCsrOrderCheckout(options?: {
  mutation?: UseMutationOptions<
    { url: string },
    CsrOrderError,
    { token: string }
  >;
}) {
  return useMutation<{ url: string }, CsrOrderError, { token: string }>({
    mutationFn: (data) =>
      customFetch<{ url: string }>("/api/csr-orders/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    ...options?.mutation,
  });
}
