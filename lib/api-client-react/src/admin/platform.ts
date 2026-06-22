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

// ── Platform health ────────────────────────────────────────────────

export interface PlatformHealth {
  generatedAt: string;
  readiness: {
    status: "ready" | "not_ready";
    checks: { db: "ok" | "failed"; queue: "ok" | "failed" };
    errors: Record<string, string> | null;
    latencyMs: number;
  };
  vendors: {
    ai: {
      anthropic: boolean;
      openai: boolean;
      elevenlabs: boolean;
      deepgram: boolean;
    };
    comms: {
      sendgrid: boolean;
      twilioVoice: boolean;
      twilioSms: boolean;
      telnyxFax: boolean;
    };
    payments: { stripe: boolean; platformBilling: boolean };
    storage: boolean;
  };
}

const PLATFORM_HEALTH_URL = "/resupply-api/platform/health";

export const getPlatformHealthQueryKey = () => [PLATFORM_HEALTH_URL] as const;

export function useGetPlatformHealth(options?: {
  query?: Partial<UseQueryOptions<PlatformHealth, PlatformError>>;
}) {
  return useQuery<PlatformHealth, PlatformError>({
    queryKey: getPlatformHealthQueryKey(),
    queryFn: ({ signal }) =>
      customFetch<PlatformHealth>(PLATFORM_HEALTH_URL, {
        method: "GET",
        signal,
      }),
    ...options?.query,
  });
}

// ── Platform operator roster ───────────────────────────────────────

export interface PlatformOperator {
  authUserId: string;
  email: string | null;
  displayName: string | null;
  status: string | null;
  grantedByEmail: string | null;
  createdAt: string;
}

export interface ListOperatorsResponse {
  operators: PlatformOperator[];
}

const OPERATORS_URL = "/resupply-api/platform/admins";

export const getListOperatorsQueryKey = () => [OPERATORS_URL] as const;

export function useListOperators(options?: {
  query?: Partial<UseQueryOptions<ListOperatorsResponse, PlatformError>>;
}) {
  return useQuery<ListOperatorsResponse, PlatformError>({
    queryKey: getListOperatorsQueryKey(),
    queryFn: ({ signal }) =>
      customFetch<ListOperatorsResponse>(OPERATORS_URL, {
        method: "GET",
        signal,
      }),
    ...options?.query,
  });
}

export interface GrantOperatorResponse {
  operator: PlatformOperator;
}

export function useGrantOperator(options?: {
  mutation?: UseMutationOptions<GrantOperatorResponse, PlatformError, string>;
}) {
  return useMutation<GrantOperatorResponse, PlatformError, string>({
    mutationFn: (email) =>
      customFetch<GrantOperatorResponse>(OPERATORS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      }),
    ...options?.mutation,
  });
}

export function useRevokeOperator(options?: {
  mutation?: UseMutationOptions<
    { ok: boolean; removed: string },
    PlatformError,
    string
  >;
}) {
  return useMutation<{ ok: boolean; removed: string }, PlatformError, string>({
    mutationFn: (authUserId) =>
      customFetch<{ ok: boolean; removed: string }>(
        `${OPERATORS_URL}/${encodeURIComponent(authUserId)}`,
        { method: "DELETE" },
      ),
    ...options?.mutation,
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

// ── Single-tenant detail ───────────────────────────────────────────

export interface PlatformTenantDetail extends PlatformTenant {
  fromEmail: string | null;
  fromName: string | null;
  updatedAt: string | null;
}

export interface GetTenantResponse {
  tenant: PlatformTenantDetail;
}

export const getTenantQueryKey = (id: string) =>
  [`${TENANTS_URL}/${id}`] as const;

export function useGetTenant(
  id: string,
  options?: {
    query?: Partial<UseQueryOptions<GetTenantResponse, PlatformError>>;
  },
) {
  return useQuery<GetTenantResponse, PlatformError>({
    queryKey: getTenantQueryKey(id),
    queryFn: ({ signal }) =>
      customFetch<GetTenantResponse>(
        `${TENANTS_URL}/${encodeURIComponent(id)}`,
        { method: "GET", signal },
      ),
    ...options?.query,
  });
}

// ── Per-tenant feature flags ───────────────────────────────────────

export interface TenantFeatureFlag {
  key: string;
  enabled: boolean;
  description: string;
  category: string;
  /** False when this build can't toggle the key (deploy-drift). */
  manageable: boolean;
  updatedByEmail: string | null;
  updatedAt: string;
}

export interface TenantFeatureFlagsResponse {
  tenantId: string;
  flags: TenantFeatureFlag[];
}

export const getTenantFeatureFlagsQueryKey = (id: string) =>
  [`${TENANTS_URL}/${id}/feature-flags`] as const;

export function useTenantFeatureFlags(
  id: string,
  options?: {
    query?: Partial<UseQueryOptions<TenantFeatureFlagsResponse, PlatformError>>;
  },
) {
  return useQuery<TenantFeatureFlagsResponse, PlatformError>({
    queryKey: getTenantFeatureFlagsQueryKey(id),
    queryFn: ({ signal }) =>
      customFetch<TenantFeatureFlagsResponse>(
        `${TENANTS_URL}/${encodeURIComponent(id)}/feature-flags`,
        { method: "GET", signal },
      ),
    ...options?.query,
  });
}

export interface ToggleTenantFeatureFlagVariables {
  key: string;
  enabled: boolean;
}

export interface ToggleTenantFeatureFlagResponse {
  tenantId: string;
  flag: TenantFeatureFlag;
}

export function useToggleTenantFeatureFlag(
  id: string,
  options?: {
    mutation?: UseMutationOptions<
      ToggleTenantFeatureFlagResponse,
      PlatformError,
      ToggleTenantFeatureFlagVariables
    >;
  },
) {
  return useMutation<
    ToggleTenantFeatureFlagResponse,
    PlatformError,
    ToggleTenantFeatureFlagVariables
  >({
    mutationFn: ({ key, enabled }) =>
      customFetch<ToggleTenantFeatureFlagResponse>(
        `${TENANTS_URL}/${encodeURIComponent(id)}/feature-flags/${encodeURIComponent(key)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        },
      ),
    ...options?.mutation,
  });
}

// ── Per-tenant feature-flag activity ───────────────────────────────

export interface TenantFlagActivity {
  occurredAt: string;
  operatorEmail: string | null;
  key: string;
  from: boolean;
  to: boolean;
}

export interface TenantFlagActivityResponse {
  tenantId: string;
  activity: TenantFlagActivity[];
}

export const getTenantFlagActivityQueryKey = (id: string, limit?: number) =>
  [`${TENANTS_URL}/${id}/feature-flag-activity`, { limit }] as const;

export function useTenantFeatureFlagActivity(
  id: string,
  limit?: number,
  options?: {
    query?: Partial<UseQueryOptions<TenantFlagActivityResponse, PlatformError>>;
  },
) {
  const qs = limit ? `?limit=${encodeURIComponent(String(limit))}` : "";
  return useQuery<TenantFlagActivityResponse, PlatformError>({
    queryKey: getTenantFlagActivityQueryKey(id, limit),
    queryFn: ({ signal }) =>
      customFetch<TenantFlagActivityResponse>(
        `${TENANTS_URL}/${encodeURIComponent(id)}/feature-flag-activity${qs}`,
        { method: "GET", signal },
      ),
    ...options?.query,
  });
}

// ── Per-tenant activity series (sparklines) ────────────────────────

export interface TenantActivitySeries {
  tenantId: string;
  days: number;
  dayKeys: string[];
  window: {
    newTenants: number;
    newPatients: number;
    newOrders: number;
    newConversations: number;
    gmvCents: number;
    delta: {
      newPatients: number | null;
      newOrders: number | null;
      newConversations: number | null;
      gmvCents: number | null;
    };
  };
  series: {
    newTenants: number[];
    newPatients: number[];
    newOrders: number[];
    newConversations: number[];
    gmvCents: number[];
  };
  generatedAt: string;
}

export const getTenantActivitySeriesQueryKey = (id: string, days?: number) =>
  [`${TENANTS_URL}/${id}/activity-series`, { days }] as const;

export function useTenantActivitySeries(
  id: string,
  days?: number,
  options?: {
    query?: Partial<UseQueryOptions<TenantActivitySeries, PlatformError>>;
  },
) {
  const qs = days ? `?days=${encodeURIComponent(String(days))}` : "";
  return useQuery<TenantActivitySeries, PlatformError>({
    queryKey: getTenantActivitySeriesQueryKey(id, days),
    queryFn: ({ signal }) =>
      customFetch<TenantActivitySeries>(
        `${TENANTS_URL}/${encodeURIComponent(id)}/activity-series${qs}`,
        { method: "GET", signal },
      ),
    ...options?.query,
  });
}

// ── Per-tenant admins (staff who can sign in) ──────────────────────

export interface TenantAdmin {
  id: string;
  email: string | null;
  role: string;
  status: string;
  displayName: string | null;
  lastLoginAt: string | null;
  invitedAt: string | null;
}

export interface TenantAdminsResponse {
  tenantId: string;
  admins: TenantAdmin[];
}

export const getTenantAdminsQueryKey = (id: string) =>
  [`${TENANTS_URL}/${id}/admins`] as const;

export function useTenantAdmins(
  id: string,
  options?: {
    query?: Partial<UseQueryOptions<TenantAdminsResponse, PlatformError>>;
  },
) {
  return useQuery<TenantAdminsResponse, PlatformError>({
    queryKey: getTenantAdminsQueryKey(id),
    queryFn: ({ signal }) =>
      customFetch<TenantAdminsResponse>(
        `${TENANTS_URL}/${encodeURIComponent(id)}/admins`,
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
