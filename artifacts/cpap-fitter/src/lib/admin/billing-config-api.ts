// Typed fetch wrappers for the read-only billing-config admin routes
// (/admin/payer-profiles, /admin/payer-fee-schedules,
//  /admin/payer-modifier-rules, /admin/denial-codes,
//  /admin/claim-templates).
//
// Config edits are still done via the existing backend routes — the
// SPA pages here are list / filter / inspect surfaces so admins can
// SEE the configuration that drives the scrubber and claim-builder.

const BASE = "/resupply-api";

async function getJSON<T>(
  path: string,
  params?: Record<string, string | undefined>,
): Promise<T> {
  const search = params
    ? new URLSearchParams(
        Object.entries(params).flatMap(([k, v]) =>
          v == null || v === "" ? [] : [[k, v] as [string, string]],
        ),
      )
    : null;
  const qs = search?.toString();
  const res = await fetch(`${BASE}${path}${qs ? `?${qs}` : ""}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
  return (await res.json()) as T;
}

// ─── Payer profiles ────────────────────────────────────────────────

export interface PayerProfile {
  id: string;
  slug: string;
  displayName: string;
  payerLegalName: string;
  parentOrg: string | null;
  lineOfBusiness: string;
  region: string;
  officeAllyPayerId: string | null;
  edi5010PayerId: string | null;
  claimFormat: string;
  paperOnly: boolean;
  requiresPriorAuthDme: boolean;
  priorAuthPhoneE164: string | null;
  claimStatusPhoneE164: string | null;
  providerPortalUrl: string | null;
  feeScheduleSource: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export function fetchPayerProfiles(filters?: {
  region?: string;
  lineOfBusiness?: string;
  active?: "true" | "false";
  q?: string;
}): Promise<{ payerProfiles: PayerProfile[] }> {
  return getJSON("/admin/payer-profiles", filters);
}

// ─── Payer fee schedules ───────────────────────────────────────────

export interface PayerFeeSchedule {
  id: string;
  payerProfileId: string;
  hcpcsCode: string;
  modifier: string | null;
  allowedCents: number;
  effectiveFrom: string;
  effectiveThrough: string | null;
  source: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export function fetchPayerFeeSchedules(filters?: {
  payerProfileId?: string;
  hcpcs?: string;
}): Promise<{ feeSchedules: PayerFeeSchedule[] }> {
  return getJSON("/admin/payer-fee-schedules", filters);
}

// ─── Payer modifier rules ──────────────────────────────────────────

export interface PayerModifierRule {
  id: string;
  payerProfileId: string;
  hcpcsCode: string;
  condition: string;
  modifiersCsv: string;
  priority: number;
  rationale: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export function fetchPayerModifierRules(filters?: {
  payerProfileId?: string;
  hcpcs?: string;
}): Promise<{ rules: PayerModifierRule[] }> {
  return getJSON("/admin/payer-modifier-rules", filters);
}

// ─── Denial codes ──────────────────────────────────────────────────

export interface DenialCode {
  id: string;
  codeSystem: string;
  code: string;
  description: string;
  category: string;
  recommendedAction: string | null;
  isTerminal: boolean;
  createdAt: string;
  updatedAt: string;
}

export function fetchDenialCodes(filters?: {
  codeSystem?: string;
  category?: string;
  q?: string;
}): Promise<{ denialCodes: DenialCode[] }> {
  return getJSON("/admin/denial-codes", filters);
}

// ─── Claim templates ───────────────────────────────────────────────

export interface ClaimTemplate {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  lines: Array<{
    hcpcsCode: string;
    modifier?: string | null;
    description?: string | null;
    chargeCents?: number | null;
    quantity?: number | null;
  }>;
  defaultDiagnosisCodes: string[];
  scopedPayerProfileId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export function fetchClaimTemplates(): Promise<{
  templates: ClaimTemplate[];
}> {
  return getJSON("/admin/claim-templates");
}

export function formatMoneyCents(cents: number | null | undefined): string {
  if (cents == null || Number.isNaN(cents)) return "—";
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
