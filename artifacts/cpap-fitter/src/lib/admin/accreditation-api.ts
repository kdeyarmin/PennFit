// Hand-rolled fetch wrappers for /admin/accreditation/* surfaces.

export interface AccreditationPolicy {
  id: string;
  policyKey: string;
  version: string;
  title: string;
  summary: string | null;
  bodyUrl: string | null;
  category: string;
  activeAt: string | null;
  retiredAt: string | null;
  attestationCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PendingPolicy {
  id: string;
  policyKey: string;
  version: string;
  title: string;
  summary: string | null;
  bodyUrl: string | null;
  category: string;
  activeAt: string;
}

export interface CreatePolicyRequest {
  policyKey: string;
  version: string;
  title: string;
  summary?: string | null;
  bodyUrl?: string | null;
  category: string;
  activate?: boolean;
}

export interface PatchPolicyRequest {
  title?: string;
  summary?: string | null;
  bodyUrl?: string | null;
  category?: string;
  activate?: boolean;
  retire?: boolean;
}

export interface BinderSummary {
  asOf: string;
  sections: {
    policies: {
      total: number;
      active: number;
      attestations: number;
      csvUrl: string;
    };
    training: { total: number; listUrl: string };
    grievances: { total: number; open: number; listUrl: string };
    auditLog: { csvUrl: string };
  };
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/resupply-api${path}`, {
    credentials: "include",
    headers: { Accept: "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const listPolicies = () =>
  jsonFetch<{ policies: AccreditationPolicy[] }>(
    "/admin/accreditation/policies",
  );

export const listMyPendingPolicies = () =>
  jsonFetch<{ pending: PendingPolicy[] }>(
    "/admin/accreditation/policies/me/pending",
  );

export const createPolicy = (body: CreatePolicyRequest) =>
  jsonFetch<{ id: string }>("/admin/accreditation/policies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const patchPolicy = (id: string, body: PatchPolicyRequest) =>
  jsonFetch<{ ok: true }>(`/admin/accreditation/policies/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const attestPolicy = (id: string, acknowledgedText: string) =>
  jsonFetch<
    | { id: string; attestedAt: string }
    | { alreadyAttested: true; id?: string; attestedAt?: string }
  >(`/admin/accreditation/policies/${id}/attest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ acknowledgedText }),
  });

export const getBinderSummary = () =>
  jsonFetch<BinderSummary>("/admin/accreditation/binder");
