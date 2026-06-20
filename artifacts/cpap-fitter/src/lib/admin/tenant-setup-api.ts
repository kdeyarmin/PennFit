// Typed fetch wrapper for the PER-TENANT onboarding checklist
// (/admin/organization/setup-checklist).
//
// Mirrors the resupply-api route
// `artifacts/resupply-api/src/routes/admin/tenant-setup.ts`. Distinct from
// the platform deployment checklist (account-setup-api.ts): this one is
// scoped to the signed-in tenant's own workspace setup and drives both the
// Setup page and the dashboard "Finish setting up" card.

import { ApiError } from "@workspace/api-client-react/admin";

export type TenantSetupStatus = "complete" | "incomplete" | "action";

export interface TenantSetupItem {
  id: string;
  group: string;
  title: string;
  description: string;
  status: TenantSetupStatus;
  detail: string | null;
  href: string | null;
  required: boolean;
}

export interface TenantSetupResponse {
  generatedAt: string;
  items: TenantSetupItem[];
  summary: {
    requiredTotal: number;
    requiredDone: number;
    allRequiredDone: boolean;
  };
}

export async function fetchTenantSetup(): Promise<TenantSetupResponse> {
  const url = "/resupply-api/admin/organization/setup-checklist";
  const res = await fetch(url, {
    credentials: "same-origin",
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
  return (await res.json()) as TenantSetupResponse;
}
