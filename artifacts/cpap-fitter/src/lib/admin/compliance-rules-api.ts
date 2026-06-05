// Fetch helpers for /compliance-rules — per-payer CPAP adherence
// thresholds (mig 0212). Self-contained (custom fetch + react-query in
// the page), mirroring the margin dashboard's fetch wrapper rather than
// the large generated admin client. Endpoints return camelCase already.

import { ApiError } from "@workspace/api-client-react/admin";

export interface ComplianceRule {
  id: string;
  name: string;
  priority: number;
  matchInsurancePayer: string | null;
  minMinutes: number;
  requiredNights: number;
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ComplianceRuleCreate {
  name: string;
  priority: number;
  matchInsurancePayer: string | null;
  minMinutes: number;
  requiredNights: number;
  active: boolean;
  notes: string | null;
}

export type ComplianceRuleUpdate = Partial<ComplianceRuleCreate>;

export const COMPLIANCE_RULES_QUERY_KEY = [
  "admin",
  "compliance-rules",
] as const;

const BASE = "/resupply-api/compliance-rules";

async function readError(res: Response, method: string, url: string) {
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // body not JSON
  }
  return new ApiError(res, data, { method, url });
}

export async function listComplianceRules(): Promise<{
  rules: ComplianceRule[];
}> {
  const res = await fetch(BASE, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await readError(res, "GET", BASE);
  return (await res.json()) as { rules: ComplianceRule[] };
}

export async function createComplianceRule(
  data: ComplianceRuleCreate,
): Promise<ComplianceRule> {
  const res = await fetch(BASE, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw await readError(res, "POST", BASE);
  return (await res.json()) as ComplianceRule;
}

export async function updateComplianceRule(
  id: string,
  data: ComplianceRuleUpdate,
): Promise<void> {
  const url = `${BASE}/${id}`;
  const res = await fetch(url, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw await readError(res, "PATCH", url);
}

export async function deleteComplianceRule(id: string): Promise<void> {
  const url = `${BASE}/${id}`;
  const res = await fetch(url, {
    method: "DELETE",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  // 204 No Content on success.
  if (!res.ok) throw await readError(res, "DELETE", url);
}

export function describeComplianceRuleError(err: unknown): string {
  if (err instanceof ApiError) {
    const data = err.data as { error?: string; message?: string } | undefined;
    return data?.message ?? data?.error ?? "Couldn't save rule.";
  }
  return err instanceof Error ? err.message : "Couldn't save rule.";
}
