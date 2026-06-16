// Hand-authored React Query hooks for the platform super-admin console
// (G4 — no OpenAPI/orval pipeline, see CLAUDE.md). Mirrors the compact
// shape of front-desk.ts. Every endpoint is gated server-side by
// `requirePlatformAdmin`; these hooks just wire the SPA to them.
//
// Surfaces:
//   * useGetPlatformMe()        — GET /platform/me: the console's gate
//                                 (200 platform admin, 403 not, 401 signed
//                                 out). Same role as useGetAdminMe.
//   * useListTenants()          — GET /platform/tenants: the tenant
//                                 directory.
//   * useCreateTenant()         — POST /platform/tenants: create a tenant
//                                 shell (org row + feature-flag provisioning).
//   * useSuspendTenant() /
//     useReactivateTenant()     — POST /platform/tenants/:id/{suspend,reactivate}.
//   * useTenantUsage()          — GET /platform/tenants/:id/usage: per-tenant
//                                 headline counts (lazy, enabled on demand).
//   * useImpersonateTenant()    — POST /platform/tenants/:id/impersonate:
//                                 mint an act-as-tenant session.
//   * useStopImpersonation()    — POST /platform/impersonation/stop.

import {
  useMutation,
  useQuery,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";

import { customFetch, type ErrorType } from "./custom-fetch";

export type PlatformError = ErrorType<{ error?: string; message?: string }>;

// ── Identity gate ──────────────────────────────────────────────────

export interface PlatformIdentity {
  userId: string;
  email: string | null;
}

const PLATFORM_ME_URL = "/resupply-api/platform/me";

export const getPlatformMeQueryKey = () => [PLATFORM_ME_URL] as const;

export function useGetPlatformMe(options?: {
  query?: Partial<UseQueryOptions<PlatformIdentity, PlatformError>>;
}) {
  return useQuery<PlatformIdentity, PlatformError>({
    queryKey: getPlatformMeQueryKey(),
    queryFn: ({ signal }) =>
      customFetch<PlatformIdentity>(PLATFORM_ME_URL, { method: "GET", signal }),
    ...options?.query,
  });
}

// ── Tenant directory ───────────────────────────────────────────────

export interface PlatformTenant {
  id: string;
  slug: string;
  name: string | null;
  storefrontName: string | null;
  status: string;
  customDomain: string | null;
  customDomainStatus: string | null;
  createdAt: string;
}

export interface ListTenantsResponse {
  tenants: PlatformTenant[];
}

const TENANTS_URL = "/resupply-api/platform/tenants";

export const getListTenantsQueryKey = () => [TENANTS_URL] as const;

export function useListTenants(options?: {
  query?: Partial<UseQueryOptions<ListTenantsResponse, PlatformError>>;
}) {
  return useQuery<ListTenantsResponse, PlatformError>({
    queryKey: getListTenantsQueryKey(),
    queryFn: ({ signal }) =>
      customFetch<ListTenantsResponse>(TENANTS_URL, { method: "GET", signal }),
    ...options?.query,
  });
}

// ── Create a tenant ────────────────────────────────────────────────

export interface CreateTenantRequest {
  slug: string;
  name: string;
}

export interface CreateTenantResponse {
  tenant: PlatformTenant;
  flagsProvisioned: number;
}

export function useCreateTenant(options?: {
  mutation?: UseMutationOptions<
    CreateTenantResponse,
    PlatformError,
    CreateTenantRequest
  >;
}) {
  return useMutation<CreateTenantResponse, PlatformError, CreateTenantRequest>({
    mutationFn: (data) =>
      customFetch<CreateTenantResponse>(TENANTS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    ...options?.mutation,
  });
}

// ── Suspend / reactivate ───────────────────────────────────────────

export interface TenantMutationResponse {
  tenant: PlatformTenant;
}

export function useSuspendTenant(options?: {
  mutation?: UseMutationOptions<TenantMutationResponse, PlatformError, string>;
}) {
  return useMutation<TenantMutationResponse, PlatformError, string>({
    mutationFn: (id) =>
      customFetch<TenantMutationResponse>(
        `${TENANTS_URL}/${encodeURIComponent(id)}/suspend`,
        { method: "POST" },
      ),
    ...options?.mutation,
  });
}

export function useReactivateTenant(options?: {
  mutation?: UseMutationOptions<TenantMutationResponse, PlatformError, string>;
}) {
  return useMutation<TenantMutationResponse, PlatformError, string>({
    mutationFn: (id) =>
      customFetch<TenantMutationResponse>(
        `${TENANTS_URL}/${encodeURIComponent(id)}/reactivate`,
        { method: "POST" },
      ),
    ...options?.mutation,
  });
}

// ── Per-tenant usage (lazy) ────────────────────────────────────────

export interface TenantUsageResponse {
  tenantId: string;
  usage: {
    patients: number;
    orders: number;
    conversations: number;
  };
}

export const getTenantUsageQueryKey = (id: string) =>
  [`${TENANTS_URL}/${id}/usage`] as const;

export function useTenantUsage(
  id: string,
  options?: {
    query?: Partial<UseQueryOptions<TenantUsageResponse, PlatformError>>;
  },
) {
  return useQuery<TenantUsageResponse, PlatformError>({
    queryKey: getTenantUsageQueryKey(id),
    queryFn: ({ signal }) =>
      customFetch<TenantUsageResponse>(
        `${TENANTS_URL}/${encodeURIComponent(id)}/usage`,
        { method: "GET", signal },
      ),
    ...options?.query,
  });
}

// ── Impersonation ──────────────────────────────────────────────────

export interface ImpersonateResponse {
  ok: boolean;
  impersonatingOrgId: string;
  expiresAt: string;
}

export function useImpersonateTenant(options?: {
  mutation?: UseMutationOptions<ImpersonateResponse, PlatformError, string>;
}) {
  return useMutation<ImpersonateResponse, PlatformError, string>({
    mutationFn: (id) =>
      customFetch<ImpersonateResponse>(
        `${TENANTS_URL}/${encodeURIComponent(id)}/impersonate`,
        { method: "POST" },
      ),
    ...options?.mutation,
  });
}

export interface StopImpersonationResponse {
  ok: boolean;
  stopped: boolean;
}

const STOP_IMPERSONATION_URL = "/resupply-api/platform/impersonation/stop";

export function useStopImpersonation(options?: {
  mutation?: UseMutationOptions<StopImpersonationResponse, PlatformError, void>;
}) {
  return useMutation<StopImpersonationResponse, PlatformError, void>({
    mutationFn: () =>
      customFetch<StopImpersonationResponse>(STOP_IMPERSONATION_URL, {
        method: "POST",
      }),
    ...options?.mutation,
  });
}
