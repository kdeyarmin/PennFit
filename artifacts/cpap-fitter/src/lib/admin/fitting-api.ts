// Hand-rolled fetch wrappers for the clinical fitting admin surfaces:
// the Mask Intelligence Catalog, the provider formulary, and the fit
// session / RT review queue. Auth rides on the `pf_session` cookie via
// `adminJsonFetch`, which also attaches the CSRF header on mutations.

import { adminJsonFetch } from "../admin-json-fetch";

// ── Mask catalog ─────────────────────────────────────────────────────

export type InterfaceType =
  | "nasal"
  | "nasal_pillow"
  | "nasal_cradle"
  | "hybrid"
  | "full_face"
  | "total_face"
  | "oral";

export interface MaskModel {
  id: string;
  isPlatformRow: boolean;
  slug: string;
  manufacturer: string;
  modelName: string;
  productLine: string | null;
  interfaceType: InterfaceType;
  serviceLine: "adult" | "pediatric" | "both";
  therapyModes: string[];
  vented: "vented" | "non_vented" | "both";
  hasMagneticComponents: boolean;
  magneticComponentNotes: string | null;
  pressureMinCmH2O: number | null;
  pressureMaxCmH2O: number | null;
  minimalContact: boolean;
  avoidsNasalBridge: boolean;
  facialHairTolerance: string | null;
  sideSleepingTolerance: string | null;
  claustrophobiaTolerance: string | null;
  glassesCompatible: boolean | null;
  cushionMaterial: string | null;
  weightGrams: number | null;
  description: string | null;
  status: "current" | "discontinued" | "pre_release";
  fitDataSource: "manufacturer" | "measured" | "estimated";
  needsClinicalReview: boolean;
  catalogVersion: number;
}

export interface MaskSizeVariant {
  id: string;
  component: string;
  sizeCode: string;
  sizeLabel: string;
  sortOrder: number;
  noseWidthMinMm: number | null;
  noseWidthMaxMm: number | null;
  noseToChinMinMm: number | null;
  noseToChinMaxMm: number | null;
  mouthWidthMinMm: number | null;
  mouthWidthMaxMm: number | null;
  isDefault: boolean;
  hcpcsCode: string | null;
  fitDataSource: string;
  /**
   * Tenant-effective: true when the shared platform flag is set AND this
   * organization has not signed the size off. Sign-off is recorded per
   * organization, so clearing it here never affects another DME.
   */
  needsClinicalReview: boolean;
  reviewedByEmail: string | null;
  reviewedAt: string | null;
  /** What the reviewer checked the bands against (migration 0488). Null on
   *  sign-offs recorded before provenance capture existed. */
  reviewSourceKind: ReviewSourceKind | null;
  reviewSourceRef: string | null;
}

/** Class of evidence behind a sign-off. `clinical_judgment` exists so a
 *  reviewer going on experience can say so rather than overclaim a
 *  citation they do not have. */
export type ReviewSourceKind =
  | "manufacturer_fit_guide"
  | "manufacturer_spec_sheet"
  | "physical_measurement"
  | "clinical_judgment";

export const REVIEW_SOURCE_KINDS: ReadonlyArray<{
  value: ReviewSourceKind;
  label: string;
}> = [
  { value: "manufacturer_fit_guide", label: "Manufacturer fitting guide" },
  { value: "manufacturer_spec_sheet", label: "Manufacturer spec sheet" },
  { value: "physical_measurement", label: "Measured a physical sample" },
  { value: "clinical_judgment", label: "Clinical judgement (no document)" },
];

export interface ReviewProvenance {
  note?: string;
  sourceKind?: ReviewSourceKind;
  sourceRef?: string;
}

export interface CatalogFilters {
  manufacturer?: string;
  interfaceType?: InterfaceType;
  serviceLine?: "adult" | "pediatric" | "both";
  status?: "current" | "discontinued" | "pre_release";
  needsReview?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

function qs(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

export function fetchMaskCatalog(
  filters: CatalogFilters = {},
): Promise<{ models: MaskModel[]; limit: number; offset: number }> {
  return adminJsonFetch(`/admin/fitter/catalog${qs({ ...filters })}`);
}

export function fetchMaskModel(id: string): Promise<{
  model: MaskModel;
  variants: MaskSizeVariant[];
  components: unknown[];
  contraindications: Array<{
    factor: string;
    severity: "exclude" | "caution";
    rationale: string;
  }>;
  /**
   * False for a shared platform mask: its facts and measurement ranges
   * are the same data every other organization fits against, so only
   * sign-off is available here.
   */
  editable: boolean;
}> {
  return adminJsonFetch(`/admin/fitter/catalog/${encodeURIComponent(id)}`);
}

export function updateMaskModel(
  id: string,
  patch: Record<string, unknown>,
): Promise<{ ok: true }> {
  return adminJsonFetch(`/admin/fitter/catalog/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function updateVariantBands(
  variantId: string,
  patch: Record<string, unknown>,
): Promise<{ ok: true }> {
  return adminJsonFetch(
    `/admin/fitter/catalog/variants/${encodeURIComponent(variantId)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}

/**
 * Clinical sign-off on one size's millimetre bands.
 *
 * This is the write that lifts the engine's confidence cap: until a
 * variant is approved it can never drive a high-confidence automated
 * recommendation, however well it scores.
 */
export function reviewVariant(
  variantId: string,
  approved: boolean,
  provenance: ReviewProvenance = {},
): Promise<{ ok: true; approved: boolean }> {
  return adminJsonFetch(
    `/admin/fitter/catalog/variants/${encodeURIComponent(variantId)}/review`,
    { method: "POST", body: JSON.stringify({ approved, ...provenance }) },
  );
}

/**
 * Sign off several sizes at once — in practice a whole model's size run.
 *
 * The server applies this all-or-nothing: if any id is not visible to this
 * organization the request is refused rather than partially applied, so a
 * reported count of 42 always means 42.
 */
export function reviewVariantsBatch(
  variantIds: string[],
  approved: boolean,
  provenance: ReviewProvenance = {},
): Promise<{ ok: true; approved: boolean; count: number }> {
  return adminJsonFetch("/admin/fitter/catalog/variants/review-batch", {
    method: "POST",
    body: JSON.stringify({ variantIds, approved, ...provenance }),
  });
}

// ── Formulary ────────────────────────────────────────────────────────

export interface FormularyRule {
  id: string;
  locationId: string | null;
  payerProfileId: string | null;
  contractRef: string | null;
  serviceLine: "adult" | "pediatric" | null;
  therapyMode: "pap" | "niv" | null;
  targetKind:
    | "manufacturer"
    | "interface_type"
    | "mask_model"
    | "size_variant"
    | "all";
  targetManufacturer: string | null;
  targetInterfaceType: string | null;
  targetMaskModelId: string | null;
  targetSizeVariantId: string | null;
  effect: "allow" | "deny" | "prefer" | "deprioritize";
  preferenceRank: number | null;
  reasonCode: string | null;
  reasonNote: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  createdByEmail: string | null;
  createdAt: string;
}

export interface Formulary {
  id: string;
  name: string;
  status: string;
  defaultPosture: "open" | "closed";
  version: number;
  publishedAt: string | null;
  publishedByEmail: string | null;
  notes: string | null;
}

export function fetchFormulary(): Promise<{
  formulary: Formulary | null;
  rules: FormularyRule[];
}> {
  return adminJsonFetch("/admin/fitter/formulary");
}

export function updateFormulary(
  patch: Partial<Pick<Formulary, "name" | "defaultPosture" | "notes">>,
): Promise<{ ok: true }> {
  return adminJsonFetch("/admin/fitter/formulary", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function createFormularyRule(
  rule: Record<string, unknown>,
): Promise<{ id: string }> {
  return adminJsonFetch("/admin/fitter/formulary/rules", {
    method: "POST",
    body: JSON.stringify(rule),
  });
}

export function deleteFormularyRule(id: string): Promise<{ ok: true }> {
  return adminJsonFetch(
    `/admin/fitter/formulary/rules/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

export interface SimulationResult {
  formulary: { name: string; version: number; defaultPosture: string };
  panel: Array<{
    label: string;
    allowedCount: number;
    deniedCount: number;
    preferred: Array<{ mask: string; rank: number | null }>;
    denied: Array<{
      mask: string;
      reasonCode: string | null;
      ruleIds: string[];
    }>;
  }>;
}

/**
 * Dry-run the formulary against a synthetic panel of faces.
 *
 * Multi-axis precedence is not something an operator can evaluate by
 * reading a rule list, so this is the difference between a configurable
 * formulary and an unusable one.
 */
export function simulateFormulary(
  context: Record<string, unknown> = {},
): Promise<SimulationResult> {
  return adminJsonFetch("/admin/fitter/formulary/simulate", {
    method: "POST",
    body: JSON.stringify(context),
  });
}

export function publishFormulary(): Promise<{ ok: true; version: number }> {
  return adminJsonFetch("/admin/fitter/formulary/publish", { method: "POST" });
}

// ── Fit sessions ─────────────────────────────────────────────────────

export type FitOutcome =
  | "high_confidence"
  | "moderate_confidence"
  | "low_confidence"
  | "contraindicated"
  | "outside_validated_range";

export interface FitSessionSummary {
  id: string;
  createdAt: string;
  patientId: string | null;
  status: string;
  outcome: FitOutcome | null;
  recommendationConfidence: number | null;
  measurementConfidenceBand: "high" | "moderate" | "low" | null;
  scanQualityGrade: "good" | "marginal" | "poor" | null;
  reviewStatus: string;
  reviewedByEmail: string | null;
  reviewedAt: string | null;
  population: string;
  serviceLine: string;
  degraded: boolean;
  recommendedMask: string | null;
}

export function fetchFitSessions(
  filters: {
    reviewStatus?: string;
    outcome?: FitOutcome;
    patientId?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ sessions: FitSessionSummary[]; limit: number; offset: number }> {
  return adminJsonFetch(`/admin/fit-sessions${qs(filters)}`);
}

export function fetchFitSession(id: string): Promise<Record<string, unknown>> {
  return adminJsonFetch(`/admin/fit-sessions/${encodeURIComponent(id)}`);
}

export function approveFitSession(
  id: string,
  note?: string,
): Promise<{ ok: true }> {
  return adminJsonFetch(
    `/admin/fit-sessions/${encodeURIComponent(id)}/approve`,
    { method: "POST", body: JSON.stringify({ note }) },
  );
}

export function overrideFitSession(
  id: string,
  body: { maskModelId: string; variantId?: string | null; reason: string },
): Promise<{ ok: true }> {
  return adminJsonFetch(
    `/admin/fit-sessions/${encodeURIComponent(id)}/override`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export interface RescanResult {
  ok: true;
  /** Whether a message actually reached the patient. */
  patientNotified: boolean;
  /** Why not, when it didn't. */
  notifyReason:
    | null
    | "no_invite"
    | "invite_revoked"
    | "no_contact"
    | "no_channel_config"
    | "in_office_handoff"
    | "send_failed";
  /** A usable link when automated delivery had nowhere to send it. */
  inviteLink: string | null;
}

export function requestRescan(
  id: string,
  reason: string,
): Promise<RescanResult> {
  return adminJsonFetch(
    `/admin/fit-sessions/${encodeURIComponent(id)}/request-rescan`,
    { method: "POST", body: JSON.stringify({ reason }) },
  );
}

/** Human wording for a rescan that could not be delivered automatically. */
export function rescanNotifyMessage(result: RescanResult): string {
  if (result.patientNotified) {
    return "The patient has been sent a link to scan again.";
  }
  switch (result.notifyReason) {
    case "no_invite":
      return "Session flagged for rescan. This fitting wasn't started from an invite, so there is nobody to notify automatically — reach out directly.";
    case "invite_revoked":
      return "Session flagged for rescan. The original invite was revoked, so nothing was sent. Create a new fitter invite for this patient.";
    case "in_office_handoff":
      return "Session flagged for rescan. This fitting was started in the office, so nothing was sent automatically — share the link below with the patient.";
    case "no_contact":
      return "Session flagged for rescan, but the invite has no email or phone on file. Use the link below.";
    case "no_channel_config":
      return "Session flagged for rescan, but this channel isn't configured for your organization. Use the link below.";
    default:
      return "Session flagged for rescan, but the message could not be sent. Use the link below, or try again.";
  }
}

/** Absolute path to the report PDF, for a plain download link. */
export function fitReportUrl(id: string): string {
  return `/resupply-api/admin/fit-sessions/${encodeURIComponent(id)}/report.pdf`;
}
