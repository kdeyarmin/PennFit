// Typed fetch wrappers for the billing-config admin routes
// (/admin/payer-profiles, /admin/payer-fee-schedules,
//  /admin/payer-modifier-rules, /admin/denial-codes,
//  /admin/claim-templates).
//
// The payer-profile surface is read + write (create / patch) so the
// catalog page can inline-edit a row when Office Ally publishes a
// quarterly payer-ID change or an op needs to refresh contact /
// prior-auth details. The other config tables remain read-only here;
// edits still flow through their dedicated backend routes.

const BASE = "/resupply-api";

async function getJSON<T>(
  path: string,
  params?: Record<string, string | undefined>,
): Promise<T> {
  const res = await fetch(`${BASE}${path}${buildQs(params)}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
  return (await res.json()) as T;
}

function buildQs(params?: Record<string, string | undefined>): string {
  if (!params) return "";
  const search = new URLSearchParams(
    Object.entries(params).flatMap(([k, v]) =>
      v == null || v === "" ? [] : [[k, v] as [string, string]],
    ),
  );
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

async function sendJSON<T>(
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      // Body not JSON or unreadable — fall through with empty detail.
    }
    throw new Error(`${method} ${path} failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  return (await res.json()) as T;
}

// ─── Payer profiles ────────────────────────────────────────────────

export type PayerLineOfBusiness =
  | "commercial"
  | "medicare_advantage"
  | "medicare_part_b"
  | "medicaid_ffs"
  | "medicaid_mco"
  | "federal"
  | "workers_comp"
  | "other";

export type PayerRegion = "pa" | "multi_state" | "national";

export type PayerClaimFormat = "837p" | "837i" | "paper_1500";

export type PayerPaSubmissionMethod =
  | "portal"
  | "fax"
  | "phone"
  | "electronic_278"
  | "paper"
  | "none";

export type PayerEdiEnrollmentStatus =
  | "enrolled"
  | "pending"
  | "not_enrolled"
  | "not_applicable";

export interface PayerProfile {
  id: string;
  slug: string;
  displayName: string;
  payerLegalName: string;
  parentOrg: string | null;
  lineOfBusiness: PayerLineOfBusiness;
  region: PayerRegion;
  officeAllyPayerId: string | null;
  edi5010PayerId: string | null;
  claimFormat: PayerClaimFormat;
  paperOnly: boolean;
  requiresPriorAuthDme: boolean;
  priorAuthPhoneE164: string | null;
  claimStatusPhoneE164: string | null;
  providerPortalUrl: string | null;
  feeScheduleSource: string | null;
  notes: string | null;
  isActive: boolean;
  // ── 0149 submission-readiness fields ──
  timelyFilingDays: number | null;
  claimsAddressLine1: string | null;
  claimsAddressLine2: string | null;
  claimsCity: string | null;
  claimsState: string | null;
  claimsZip: string | null;
  claimsPhoneE164: string | null;
  claimsFaxE164: string | null;
  priorAuthSubmissionMethod: PayerPaSubmissionMethod | null;
  priorAuthFaxE164: string | null;
  priorAuthTurnaroundBusinessDays: number | null;
  requiredClaimModifiers: string[];
  acceptsElectronicSecondary: boolean;
  ediEnrollmentStatus: PayerEdiEnrollmentStatus;
  memberIdFormatHint: string | null;
  requirementsLastVerifiedAt: string | null;
  requirementsLastVerifiedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PayerProfileUpsert {
  slug: string;
  displayName: string;
  payerLegalName: string;
  parentOrg?: string | null;
  lineOfBusiness: PayerLineOfBusiness;
  region?: PayerRegion;
  officeAllyPayerId?: string | null;
  edi5010PayerId?: string | null;
  claimFormat?: PayerClaimFormat;
  paperOnly?: boolean;
  requiresPriorAuthDme?: boolean;
  priorAuthPhoneE164?: string | null;
  claimStatusPhoneE164?: string | null;
  providerPortalUrl?: string | null;
  feeScheduleSource?: string | null;
  notes?: string | null;
  isActive?: boolean;
  timelyFilingDays?: number | null;
  claimsAddressLine1?: string | null;
  claimsAddressLine2?: string | null;
  claimsCity?: string | null;
  claimsState?: string | null;
  claimsZip?: string | null;
  claimsPhoneE164?: string | null;
  claimsFaxE164?: string | null;
  priorAuthSubmissionMethod?: PayerPaSubmissionMethod | null;
  priorAuthFaxE164?: string | null;
  priorAuthTurnaroundBusinessDays?: number | null;
  requiredClaimModifiers?: string[];
  acceptsElectronicSecondary?: boolean;
  ediEnrollmentStatus?: PayerEdiEnrollmentStatus;
  memberIdFormatHint?: string | null;
}

export type PayerProfilePatch = Partial<PayerProfileUpsert>;

export function fetchPayerProfiles(filters?: {
  region?: string;
  lineOfBusiness?: string;
  active?: "true" | "false";
  q?: string;
}): Promise<{ payerProfiles: PayerProfile[] }> {
  return getJSON("/admin/payer-profiles", filters);
}

export function fetchPayerProfile(
  id: string,
): Promise<{ payerProfile: PayerProfile }> {
  return getJSON(`/admin/payer-profiles/${encodeURIComponent(id)}`);
}

export function createPayerProfile(
  body: PayerProfileUpsert,
): Promise<{ id: string }> {
  return sendJSON("POST", "/admin/payer-profiles", body);
}

export function updatePayerProfile(
  id: string,
  body: PayerProfilePatch,
): Promise<{ ok: true }> {
  return sendJSON(
    "PATCH",
    `/admin/payer-profiles/${encodeURIComponent(id)}`,
    body,
  );
}

// URL the browser hits to download the OA enrollment CSV. Plain
// `<a href>` works (cookie auth, no preflight); admins can right-click
// to save-as without us juggling Blob URLs.
export function officeAllyExportCsvHref(opts?: {
  includeNonElectronic?: boolean;
}): string {
  const qs = buildQs({
    includeNonElectronic: opts?.includeNonElectronic ? "true" : undefined,
  });
  return `${BASE}/admin/payer-profiles/export.csv${qs}`;
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
