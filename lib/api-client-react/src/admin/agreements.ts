// Hand-authored React Query hooks for tenant onboarding agreements (G16).
// Mirrors the compact style of front-desk.ts / platform.ts.

import {
  useMutation,
  useQuery,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";

import { customFetch, type ErrorType } from "./custom-fetch";

export type AgreementsError = ErrorType<{ error?: string }>;

export type AgreementType = "baa" | "platform_terms";

export interface AgreementStatus {
  type: AgreementType;
  version: string;
  title: string;
  body: string;
  accepted: boolean;
  acceptedAt: string | null;
}

export interface AgreementsResponse {
  agreements: AgreementStatus[];
}

const AGREEMENTS_URL = "/resupply-api/admin/agreements";

export const getAdminAgreementsQueryKey = () => [AGREEMENTS_URL] as const;

export function useAdminAgreements(options?: {
  query?: Partial<UseQueryOptions<AgreementsResponse, AgreementsError>>;
}) {
  return useQuery<AgreementsResponse, AgreementsError>({
    queryKey: getAdminAgreementsQueryKey(),
    queryFn: ({ signal }) =>
      customFetch<AgreementsResponse>(AGREEMENTS_URL, {
        method: "GET",
        signal,
      }),
    ...options?.query,
  });
}

export interface AcceptAgreementRequest {
  type: AgreementType;
  version: string;
  signatoryName: string;
}

export interface AcceptAgreementResponse {
  ok: boolean;
  pending: AgreementType[];
  allSigned: boolean;
}

export function useAcceptAgreement(options?: {
  mutation?: UseMutationOptions<
    AcceptAgreementResponse,
    AgreementsError,
    AcceptAgreementRequest
  >;
}) {
  return useMutation<
    AcceptAgreementResponse,
    AgreementsError,
    AcceptAgreementRequest
  >({
    mutationFn: (data) =>
      customFetch<AcceptAgreementResponse>(`${AGREEMENTS_URL}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    ...options?.mutation,
  });
}
