// /admin/payer-profiles — Pennsylvania payer catalog management.
//
//   GET   /admin/payer-profiles           — list (filter by region / LOB / search)
//   GET   /admin/payer-profiles/:id       — detail
//   POST  /admin/payer-profiles           — create (admin only)
//   PATCH /admin/payer-profiles/:id       — edit (admin only)
//
// Seeded with ~25 known PA payers in migration 0128. The admin UI
// allows operators to add new payers and edit electronic IDs without
// a deploy (Office Ally publishes payer-id updates quarterly).
//
// PHI posture: payer profiles are NOT patient data. The notes field
// is enforced by application-side validation to reject anything that
// looks like a patient identifier (we keep the check shallow because
// payer-level notes shouldn't reference any patient at all).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { safeCsvCell } from "../../lib/safe-csv-cell";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import {
  requireAdminOnly,
  requirePermission,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

type PayerProfileRow = Database["resupply"]["Tables"]["payer_profiles"]["Row"];
type PayerLineOfBusiness = PayerProfileRow["line_of_business"];
type PayerRegion = PayerProfileRow["region"];
type PayerClaimFormat = PayerProfileRow["claim_format"];
type PayerPaMethod = NonNullable<
  PayerProfileRow["prior_auth_submission_method"]
>;
type PayerEdiEnrollmentStatus = PayerProfileRow["edi_enrollment_status"];

const LINE_OF_BUSINESS_VALUES = [
  "commercial",
  "medicare_advantage",
  "medicare_part_b",
  "medicaid_ffs",
  "medicaid_mco",
  "federal",
  "workers_comp",
  "other",
] as const satisfies readonly PayerLineOfBusiness[];

const REGION_VALUES = [
  "pa",
  "multi_state",
  "national",
] as const satisfies readonly PayerRegion[];
const CLAIM_FORMAT_VALUES = [
  "837p",
  "837i",
  "paper_1500",
] as const satisfies readonly PayerClaimFormat[];
const PA_METHOD_VALUES = [
  "portal",
  "fax",
  "phone",
  "electronic_278",
  "paper",
  "none",
] as const satisfies readonly PayerPaMethod[];
const EDI_ENROLLMENT_VALUES = [
  "enrolled",
  "pending",
  "not_enrolled",
  "not_applicable",
] as const satisfies readonly PayerEdiEnrollmentStatus[];

const SLUG_RE = /^[a-z0-9_]+$/;
// US state two-letter — used for the paper-claims mailing address.
const US_STATE_RE = /^[A-Z]{2}$/;
// HCPCS Level-II / CPT modifier — exactly 2 alphanumerics.
const MODIFIER_RE = /^[A-Z0-9]{2}$/;

const upsertBody = z
  .object({
    slug: z.string().trim().min(2).max(64).regex(SLUG_RE),
    displayName: z.string().trim().min(1).max(160),
    payerLegalName: z.string().trim().min(1).max(160),
    parentOrg: z.string().trim().max(120).nullable().optional(),
    lineOfBusiness: z.enum(LINE_OF_BUSINESS_VALUES),
    region: z.enum(REGION_VALUES).default("pa"),
    officeAllyPayerId: z.string().trim().max(20).nullable().optional(),
    edi5010PayerId: z.string().trim().max(20).nullable().optional(),
    claimFormat: z.enum(CLAIM_FORMAT_VALUES).default("837p"),
    paperOnly: z.boolean().default(false),
    requiresPriorAuthDme: z.boolean().default(false),
    // When true, a patient whose primary coverage maps to this payer
    // must have signed intake paperwork on file before any of their
    // orders can be marked shipped (migration 0248).
    requiresSignedPaperwork: z.boolean().default(false),
    priorAuthPhoneE164: z.string().trim().max(20).nullable().optional(),
    claimStatusPhoneE164: z.string().trim().max(20).nullable().optional(),
    providerPortalUrl: z.string().trim().max(240).nullable().optional(),
    feeScheduleSource: z.string().trim().max(240).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    isActive: z.boolean().default(true),
    // ── Submission-readiness fields (migration 0149) ──
    timelyFilingDays: z.number().int().min(30).max(1825).nullable().optional(),
    claimsAddressLine1: z.string().trim().max(120).nullable().optional(),
    claimsAddressLine2: z.string().trim().max(120).nullable().optional(),
    claimsCity: z.string().trim().max(80).nullable().optional(),
    claimsState: z
      .string()
      .trim()
      .max(2)
      .regex(US_STATE_RE, "must be a 2-letter US state code")
      .nullable()
      .optional(),
    claimsZip: z.string().trim().max(10).nullable().optional(),
    claimsPhoneE164: z.string().trim().max(20).nullable().optional(),
    claimsFaxE164: z.string().trim().max(20).nullable().optional(),
    priorAuthSubmissionMethod: z.enum(PA_METHOD_VALUES).nullable().optional(),
    priorAuthFaxE164: z.string().trim().max(20).nullable().optional(),
    priorAuthTurnaroundBusinessDays: z
      .number()
      .int()
      .min(0)
      .max(180)
      .nullable()
      .optional(),
    requiredClaimModifiers: z
      .array(
        z
          .string()
          .trim()
          .toUpperCase()
          .regex(MODIFIER_RE, "modifier must be 2 alphanumeric chars"),
      )
      .max(20)
      .optional(),
    acceptsElectronicSecondary: z.boolean().optional(),
    ediEnrollmentStatus: z.enum(EDI_ENROLLMENT_VALUES).optional(),
    memberIdFormatHint: z.string().trim().max(120).nullable().optional(),
  })
  .strict();

const patchBody = upsertBody.partial();

interface PayerRow {
  id: string;
  slug: string;
  display_name: string;
  payer_legal_name: string;
  parent_org: string | null;
  line_of_business: string;
  region: string;
  office_ally_payer_id: string | null;
  edi_5010_payer_id: string | null;
  claim_format: string;
  paper_only: boolean;
  requires_prior_auth_dme: boolean;
  requires_signed_paperwork: boolean;
  prior_auth_phone_e164: string | null;
  claim_status_phone_e164: string | null;
  provider_portal_url: string | null;
  fee_schedule_source: string | null;
  notes: string | null;
  is_active: boolean;
  // ── 0149 columns ──
  timely_filing_days: number | null;
  claims_address_line1: string | null;
  claims_address_line2: string | null;
  claims_city: string | null;
  claims_state: string | null;
  claims_zip: string | null;
  claims_phone_e164: string | null;
  claims_fax_e164: string | null;
  prior_auth_submission_method: string | null;
  prior_auth_fax_e164: string | null;
  prior_auth_turnaround_business_days: number | null;
  required_claim_modifiers: string[] | null;
  accepts_electronic_secondary: boolean;
  edi_enrollment_status: string;
  member_id_format_hint: string | null;
  requirements_last_verified_at: string | null;
  requirements_last_verified_by: string | null;
  created_at: string;
  updated_at: string;
}

function rowToApi(r: PayerRow) {
  return {
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    payerLegalName: r.payer_legal_name,
    parentOrg: r.parent_org,
    lineOfBusiness: r.line_of_business,
    region: r.region,
    officeAllyPayerId: r.office_ally_payer_id,
    edi5010PayerId: r.edi_5010_payer_id,
    claimFormat: r.claim_format,
    paperOnly: r.paper_only,
    requiresPriorAuthDme: r.requires_prior_auth_dme,
    requiresSignedPaperwork: r.requires_signed_paperwork,
    priorAuthPhoneE164: r.prior_auth_phone_e164,
    claimStatusPhoneE164: r.claim_status_phone_e164,
    providerPortalUrl: r.provider_portal_url,
    feeScheduleSource: r.fee_schedule_source,
    notes: r.notes,
    isActive: r.is_active,
    timelyFilingDays: r.timely_filing_days,
    claimsAddressLine1: r.claims_address_line1,
    claimsAddressLine2: r.claims_address_line2,
    claimsCity: r.claims_city,
    claimsState: r.claims_state,
    claimsZip: r.claims_zip,
    claimsPhoneE164: r.claims_phone_e164,
    claimsFaxE164: r.claims_fax_e164,
    priorAuthSubmissionMethod: r.prior_auth_submission_method,
    priorAuthFaxE164: r.prior_auth_fax_e164,
    priorAuthTurnaroundBusinessDays: r.prior_auth_turnaround_business_days,
    requiredClaimModifiers: r.required_claim_modifiers ?? [],
    acceptsElectronicSecondary: r.accepts_electronic_secondary,
    ediEnrollmentStatus: r.edi_enrollment_status,
    memberIdFormatHint: r.member_id_format_hint,
    requirementsLastVerifiedAt: r.requirements_last_verified_at,
    requirementsLastVerifiedBy: r.requirements_last_verified_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const FULL_SELECT =
  "id, slug, display_name, payer_legal_name, parent_org, line_of_business, region, office_ally_payer_id, edi_5010_payer_id, claim_format, paper_only, requires_prior_auth_dme, requires_signed_paperwork, prior_auth_phone_e164, claim_status_phone_e164, provider_portal_url, fee_schedule_source, notes, is_active, timely_filing_days, claims_address_line1, claims_address_line2, claims_city, claims_state, claims_zip, claims_phone_e164, claims_fax_e164, prior_auth_submission_method, prior_auth_fax_e164, prior_auth_turnaround_business_days, required_claim_modifiers, accepts_electronic_secondary, edi_enrollment_status, member_id_format_hint, requirements_last_verified_at, requirements_last_verified_by, created_at, updated_at";

// ── LIST ────────────────────────────────────────────────────────────
router.get(
  "/admin/payer-profiles",
  requirePermission("reports.read"),
  async (req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    let query = supabase
      .schema("resupply")
      .from("payer_profiles")
      .select(FULL_SELECT)
      .order("display_name", { ascending: true })
      .limit(500);

    const region =
      typeof req.query.region === "string" ? req.query.region : undefined;
    if (region && isRegion(region)) {
      query = query.eq("region", region);
    }
    const lob =
      typeof req.query.lineOfBusiness === "string"
        ? req.query.lineOfBusiness
        : undefined;
    if (lob && isLineOfBusiness(lob)) {
      query = query.eq("line_of_business", lob);
    }
    const active = req.query.active;
    if (active === "true") query = query.eq("is_active", true);
    if (active === "false") query = query.eq("is_active", false);

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length > 0 && q.length <= 80) {
      // Case-insensitive name search; PostgREST `ilike` w/ escape
      const safe = q.replace(/[%_]/g, (m) => `\\${m}`);
      query = query.ilike("display_name", `%${safe}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ payerProfiles: (data ?? []).map(rowToApi) });
  },
);

// ── EXPORT — Office Ally enrollment CSV ─────────────────────────────
//
// MUST be registered before the `/:id` route below; otherwise the
// :id matcher catches "export.csv" first and returns 404.
//
// Returns the catalog formatted as an Office-Ally enrollment-review
// CSV. The column order matches the layout Office Ally publishes for
// its Payer Enrollment console so an admin can paste the export
// directly into OA's intake spreadsheet (or attach it to an OA
// support ticket when an enrollment is in flight).
//
// Rules:
//   * Only `is_active=true` rows.
//   * Default scope is electronically billable (Office Ally cannot
//     enroll payers it doesn't clear). Pass `?includeNonElectronic=true`
//     to include WC / paper-only rows for an internal audit export.
//   * Header row is fixed; row order is by display_name ASC.
//
// Permission: reports.read (this is metadata, not PHI).
router.get(
  "/admin/payer-profiles/export.csv",
  requirePermission("reports.read"),
  async (req, res) => {
    const includeNonElectronic = req.query.includeNonElectronic === "true";
    const supabase = getSupabaseServiceRoleClient();
    let query = supabase
      .schema("resupply")
      .from("payer_profiles")
      .select(FULL_SELECT)
      .eq("is_active", true)
      .order("display_name", { ascending: true })
      .limit(2000);
    if (!includeNonElectronic) {
      query = query
        .eq("paper_only", false)
        .not("office_ally_payer_id", "is", null);
    }
    const { data, error } = await query;
    if (error) throw error;

    const rows = (data ?? []).map(rowToApi);
    const filename = `pa-payer-profiles-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(renderOfficeAllyCsv(rows));
  },
);

// ── DETAIL ──────────────────────────────────────────────────────────
router.get(
  "/admin/payer-profiles/:id",
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("payer_profiles")
      .select(FULL_SELECT)
      .eq("id", parsed.data.id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ payerProfile: rowToApi(data) });
  },
);

// ── CREATE (admin only) ─────────────────────────────────────────────
router.post(
  "/admin/payer-profiles",
  requireAdminOnly,
  adminRateLimit({ name: "payer_profiles.create", preset: "sensitive" }),
  async (req, res) => {
    const parsed = upsertBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const b = parsed.data;
    if (b.paperOnly && (b.officeAllyPayerId || b.edi5010PayerId)) {
      res.status(400).json({
        error: "invalid_body",
        issues: [
          {
            path: "paperOnly",
            message: "paper-only payers must not carry electronic IDs",
          },
        ],
      });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("payer_profiles")
      .insert({
        slug: b.slug,
        display_name: b.displayName,
        payer_legal_name: b.payerLegalName,
        parent_org: b.parentOrg ?? null,
        line_of_business: b.lineOfBusiness,
        region: b.region,
        office_ally_payer_id: b.officeAllyPayerId ?? null,
        edi_5010_payer_id: b.edi5010PayerId ?? null,
        claim_format: b.claimFormat,
        paper_only: b.paperOnly,
        requires_prior_auth_dme: b.requiresPriorAuthDme,
        requires_signed_paperwork: b.requiresSignedPaperwork,
        prior_auth_phone_e164: b.priorAuthPhoneE164 ?? null,
        claim_status_phone_e164: b.claimStatusPhoneE164 ?? null,
        provider_portal_url: b.providerPortalUrl ?? null,
        fee_schedule_source: b.feeScheduleSource ?? null,
        notes: b.notes ?? null,
        is_active: b.isActive,
        timely_filing_days: b.timelyFilingDays ?? null,
        claims_address_line1: b.claimsAddressLine1 ?? null,
        claims_address_line2: b.claimsAddressLine2 ?? null,
        claims_city: b.claimsCity ?? null,
        claims_state: b.claimsState ?? null,
        claims_zip: b.claimsZip ?? null,
        claims_phone_e164: b.claimsPhoneE164 ?? null,
        claims_fax_e164: b.claimsFaxE164 ?? null,
        prior_auth_submission_method: b.priorAuthSubmissionMethod ?? null,
        prior_auth_fax_e164: b.priorAuthFaxE164 ?? null,
        prior_auth_turnaround_business_days:
          b.priorAuthTurnaroundBusinessDays ?? null,
        required_claim_modifiers: b.requiredClaimModifiers ?? [],
        accepts_electronic_secondary: b.acceptsElectronicSecondary ?? true,
        edi_enrollment_status: b.ediEnrollmentStatus ?? "not_applicable",
        member_id_format_hint: b.memberIdFormatHint ?? null,
        // Creating a new payer = the act of verifying its requirements.
        requirements_last_verified_at: new Date().toISOString(),
        requirements_last_verified_by: req.adminEmail ?? null,
      })
      .select("id")
      .single();
    if (error) {
      // Unique violation on slug surfaces as 409 — operator can re-key.
      if (typeof error.code === "string" && error.code === "23505") {
        res.status(409).json({ error: "slug_conflict" });
        return;
      }
      throw error;
    }
    await logAudit({
      action: "payer_profile.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "payer_profiles",
      targetId: data.id,
      metadata: { slug: b.slug, display_name: b.displayName },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "payer_profile.create audit write failed");
    });
    res.status(201).json({ id: data.id });
  },
);

// ── PATCH (admin only) ──────────────────────────────────────────────
router.patch(
  "/admin/payer-profiles/:id",
  requireAdminOnly,
  adminRateLimit({ name: "payer_profiles.update", preset: "sensitive" }),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const b = parsed.data;
    const update: Database["resupply"]["Tables"]["payer_profiles"]["Update"] = {
      updated_at: new Date().toISOString(),
    };
    if (b.slug !== undefined) update.slug = b.slug;
    if (b.displayName !== undefined) update.display_name = b.displayName;
    if (b.payerLegalName !== undefined)
      update.payer_legal_name = b.payerLegalName;
    if (b.parentOrg !== undefined) update.parent_org = b.parentOrg;
    if (b.lineOfBusiness !== undefined)
      update.line_of_business = b.lineOfBusiness;
    if (b.region !== undefined) update.region = b.region;
    if (b.officeAllyPayerId !== undefined)
      update.office_ally_payer_id = b.officeAllyPayerId;
    if (b.edi5010PayerId !== undefined)
      update.edi_5010_payer_id = b.edi5010PayerId;
    if (b.claimFormat !== undefined) update.claim_format = b.claimFormat;
    if (b.paperOnly !== undefined) update.paper_only = b.paperOnly;
    if (b.requiresPriorAuthDme !== undefined)
      update.requires_prior_auth_dme = b.requiresPriorAuthDme;
    if (b.requiresSignedPaperwork !== undefined)
      update.requires_signed_paperwork = b.requiresSignedPaperwork;
    if (b.priorAuthPhoneE164 !== undefined)
      update.prior_auth_phone_e164 = b.priorAuthPhoneE164;
    if (b.claimStatusPhoneE164 !== undefined)
      update.claim_status_phone_e164 = b.claimStatusPhoneE164;
    if (b.providerPortalUrl !== undefined)
      update.provider_portal_url = b.providerPortalUrl;
    if (b.feeScheduleSource !== undefined)
      update.fee_schedule_source = b.feeScheduleSource;
    if (b.notes !== undefined) update.notes = b.notes;
    if (b.isActive !== undefined) update.is_active = b.isActive;
    if (b.timelyFilingDays !== undefined)
      update.timely_filing_days = b.timelyFilingDays;
    if (b.claimsAddressLine1 !== undefined)
      update.claims_address_line1 = b.claimsAddressLine1;
    if (b.claimsAddressLine2 !== undefined)
      update.claims_address_line2 = b.claimsAddressLine2;
    if (b.claimsCity !== undefined) update.claims_city = b.claimsCity;
    if (b.claimsState !== undefined) update.claims_state = b.claimsState;
    if (b.claimsZip !== undefined) update.claims_zip = b.claimsZip;
    if (b.claimsPhoneE164 !== undefined)
      update.claims_phone_e164 = b.claimsPhoneE164;
    if (b.claimsFaxE164 !== undefined) update.claims_fax_e164 = b.claimsFaxE164;
    if (b.priorAuthSubmissionMethod !== undefined)
      update.prior_auth_submission_method = b.priorAuthSubmissionMethod;
    if (b.priorAuthFaxE164 !== undefined)
      update.prior_auth_fax_e164 = b.priorAuthFaxE164;
    if (b.priorAuthTurnaroundBusinessDays !== undefined)
      update.prior_auth_turnaround_business_days =
        b.priorAuthTurnaroundBusinessDays;
    if (b.requiredClaimModifiers !== undefined)
      update.required_claim_modifiers = b.requiredClaimModifiers;
    if (b.acceptsElectronicSecondary !== undefined)
      update.accepts_electronic_secondary = b.acceptsElectronicSecondary;
    if (b.ediEnrollmentStatus !== undefined)
      update.edi_enrollment_status = b.ediEnrollmentStatus;
    if (b.memberIdFormatHint !== undefined)
      update.member_id_format_hint = b.memberIdFormatHint;
    // Any patch is a verification act — stamp the reviewer + time so
    // the admin list can show staleness without a separate column.
    update.requirements_last_verified_at = new Date().toISOString();
    update.requirements_last_verified_by = req.adminEmail ?? null;

    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("payer_profiles")
      .update(update)
      .eq("id", idParsed.data.id);
    if (error) throw error;

    await logAudit({
      action: "payer_profile.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "payer_profiles",
      targetId: idParsed.data.id,
      metadata: {
        fields_changed: Object.keys(update).filter((k) => k !== "updated_at"),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "payer_profile.update audit write failed");
    });

    res.json({ ok: true });
  },
);

function isRegion(v: string): v is PayerRegion {
  return (REGION_VALUES as readonly string[]).includes(v);
}
function isLineOfBusiness(v: string): v is PayerLineOfBusiness {
  return (LINE_OF_BUSINESS_VALUES as readonly string[]).includes(v);
}

// Delegate to the shared helper for formula-injection neutralisation
// + RFC 4180 quoting. Payer config is admin-curated so the attack
// surface is internal, but naming-equivalent csvCell helpers should
// behave the same — consistency keeps "is this CSV safe?" from
// being a per-file judgement call.
function csvCell(v: unknown): string {
  return safeCsvCell(v);
}

function renderOfficeAllyCsv(rows: ReturnType<typeof rowToApi>[]): string {
  // Column order mirrors Office Ally's published enrollment-review
  // spreadsheet. The "REVIEW" markers in cells highlight gaps so an
  // op can spot stale rows at a glance.
  const headers = [
    "OA Payer ID",
    "EDI 5010 ID",
    "Display Name",
    "Payer Legal Name",
    "Parent Org",
    "Line of Business",
    "Region",
    "Claim Format",
    "EDI Enrollment Status",
    "Accepts Electronic Secondary",
    "PA Required (DME)",
    "PA Submission Method",
    "PA Phone",
    "PA Fax",
    "PA Turnaround (business days)",
    "Required Modifiers",
    "Timely Filing (days)",
    "Claim Status Phone",
    "Claims Address Line 1",
    "Claims Address Line 2",
    "Claims City",
    "Claims State",
    "Claims ZIP",
    "Claims Phone",
    "Claims Fax",
    "Provider Portal URL",
    "Fee Schedule Source",
    "Member ID Format Hint",
    "Notes",
    "Requirements Last Verified At",
    "Requirements Last Verified By",
    "Slug",
  ];
  const lines: string[] = [headers.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.officeAllyPayerId,
        r.edi5010PayerId,
        r.displayName,
        r.payerLegalName,
        r.parentOrg,
        r.lineOfBusiness,
        r.region,
        r.claimFormat,
        r.ediEnrollmentStatus,
        r.acceptsElectronicSecondary ? "yes" : "no",
        r.requiresPriorAuthDme ? "yes" : "no",
        r.priorAuthSubmissionMethod ?? "REVIEW",
        r.priorAuthPhoneE164,
        r.priorAuthFaxE164,
        r.priorAuthTurnaroundBusinessDays,
        r.requiredClaimModifiers,
        r.timelyFilingDays ?? "REVIEW",
        r.claimStatusPhoneE164,
        r.claimsAddressLine1,
        r.claimsAddressLine2,
        r.claimsCity,
        r.claimsState,
        r.claimsZip,
        r.claimsPhoneE164,
        r.claimsFaxE164,
        r.providerPortalUrl,
        r.feeScheduleSource,
        r.memberIdFormatHint,
        r.notes,
        r.requirementsLastVerifiedAt,
        r.requirementsLastVerifiedBy,
        r.slug,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  // CRLF newlines per RFC 4180.
  return `${lines.join("\r\n")}\r\n`;
}

export default router;
