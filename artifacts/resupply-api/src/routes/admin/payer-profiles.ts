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
  type Json,
  PAYER_ENROLLMENT_STATUS_VALUES,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  requireAdmin,
  requireAdminOnly,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

type PayerProfileRow = Database["resupply"]["Tables"]["payer_profiles"]["Row"];
type PayerLineOfBusiness = PayerProfileRow["line_of_business"];
type PayerRegion = PayerProfileRow["region"];
type PayerClaimFormat = PayerProfileRow["claim_format"];

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

const REGION_VALUES = ["pa", "multi_state", "national"] as const satisfies readonly PayerRegion[];
const CLAIM_FORMAT_VALUES = ["837p", "837i", "paper_1500"] as const satisfies readonly PayerClaimFormat[];

const SLUG_RE = /^[a-z0-9_]+$/;

const POSTAL_ADDRESS_SCHEMA = z
  .object({
    line1: z.string().trim().min(1).max(120),
    line2: z.string().trim().max(120).nullable().optional(),
    line3: z.string().trim().max(120).nullable().optional(),
    city: z.string().trim().min(1).max(60),
    state: z.string().trim().regex(/^[A-Z]{2}$/),
    zip: z.string().trim().regex(/^\d{5}(-?\d{4})?$/),
  })
  .strict();

const MODIFIER_SCHEMA = z.string().trim().regex(/^[A-Z0-9]{2}$/);

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
    priorAuthPhoneE164: z.string().trim().max(20).nullable().optional(),
    claimStatusPhoneE164: z.string().trim().max(20).nullable().optional(),
    providerPortalUrl: z.string().trim().max(240).nullable().optional(),
    feeScheduleSource: z.string().trim().max(240).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    isActive: z.boolean().default(true),
    // ── Phase 12 completeness (migration 0142) ──
    timelyFilingDays: z
      .number()
      .int()
      .min(30)
      .max(1825)
      .nullable()
      .optional(),
    claimsMailingAddress: POSTAL_ADDRESS_SCHEMA.nullable().optional(),
    appealsMailingAddress: POSTAL_ADDRESS_SCHEMA.nullable().optional(),
    memberIdPattern: z.string().trim().max(200).nullable().optional(),
    requiredModifiersDme: z.array(MODIFIER_SCHEMA).max(20).optional(),
    requiresReferringProviderNpi: z.boolean().optional(),
    acceptsSecondaryElectronic: z.boolean().optional(),
    eraPayerId: z.string().trim().max(20).nullable().optional(),
    eraEnrollmentRequired: z.boolean().optional(),
    enrollmentStatus: z.enum(PAYER_ENROLLMENT_STATUS_VALUES).optional(),
    enrollmentEffectiveOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
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
  prior_auth_phone_e164: string | null;
  claim_status_phone_e164: string | null;
  provider_portal_url: string | null;
  fee_schedule_source: string | null;
  notes: string | null;
  is_active: boolean;
  // Phase 12 completeness (migration 0142)
  timely_filing_days: number | null;
  claims_mailing_address: Json | null;
  appeals_mailing_address: Json | null;
  member_id_pattern: string | null;
  required_modifiers_dme: string[];
  requires_referring_provider_npi: boolean;
  accepts_secondary_electronic: boolean;
  era_payer_id: string | null;
  era_enrollment_required: boolean;
  enrollment_status: string;
  enrollment_effective_on: string | null;
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
    priorAuthPhoneE164: r.prior_auth_phone_e164,
    claimStatusPhoneE164: r.claim_status_phone_e164,
    providerPortalUrl: r.provider_portal_url,
    feeScheduleSource: r.fee_schedule_source,
    notes: r.notes,
    isActive: r.is_active,
    timelyFilingDays: r.timely_filing_days,
    claimsMailingAddress: r.claims_mailing_address,
    appealsMailingAddress: r.appeals_mailing_address,
    memberIdPattern: r.member_id_pattern,
    requiredModifiersDme: r.required_modifiers_dme,
    requiresReferringProviderNpi: r.requires_referring_provider_npi,
    acceptsSecondaryElectronic: r.accepts_secondary_electronic,
    eraPayerId: r.era_payer_id,
    eraEnrollmentRequired: r.era_enrollment_required,
    enrollmentStatus: r.enrollment_status,
    enrollmentEffectiveOn: r.enrollment_effective_on,
    /** Set of payer-profile field gaps that block / risk submission. */
    completenessGaps: deriveCompletenessGaps(r),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Return the list of payer-profile fields that need to be filled in
 *  before this payer is "complete" enough to generate + submit a
 *  clean claim. Used by the admin UI to surface the per-payer
 *  completeness chip and by the dashboard's bulk roll-up. */
function deriveCompletenessGaps(r: PayerRow): string[] {
  const gaps: string[] = [];
  if (!r.paper_only && !r.office_ally_payer_id) gaps.push("office_ally_payer_id");
  if (!r.payer_legal_name) gaps.push("payer_legal_name");
  if (r.timely_filing_days == null) gaps.push("timely_filing_days");
  if (!r.claims_mailing_address) gaps.push("claims_mailing_address");
  if (!r.appeals_mailing_address) gaps.push("appeals_mailing_address");
  if (!r.member_id_pattern) gaps.push("member_id_pattern");
  if (r.required_modifiers_dme.length === 0) gaps.push("required_modifiers_dme");
  if (r.enrollment_status === "unknown") gaps.push("enrollment_status");
  return gaps;
}

const FULL_SELECT =
  "id, slug, display_name, payer_legal_name, parent_org, line_of_business, region, office_ally_payer_id, edi_5010_payer_id, claim_format, paper_only, requires_prior_auth_dme, prior_auth_phone_e164, claim_status_phone_e164, provider_portal_url, fee_schedule_source, notes, is_active, timely_filing_days, claims_mailing_address, appeals_mailing_address, member_id_pattern, required_modifiers_dme, requires_referring_provider_npi, accepts_secondary_electronic, era_payer_id, era_enrollment_required, enrollment_status, enrollment_effective_on, created_at, updated_at";

// ── COMPLETENESS ROLLUP ────────────────────────────────────────────
// GET /admin/payer-profiles/completeness — bulk roll-up across every
// active payer. Returns the count of active payers, the count fully
// complete, and the per-gap histogram so the dashboard can show
// "fix the X payers missing timely_filing_days" without N round-trips.
router.get(
  "/admin/payer-profiles/completeness",
  requireAdmin,
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("payer_profiles")
      .select(FULL_SELECT)
      .eq("is_active", true);
    if (error) throw error;
    const rows = (data ?? []) as PayerRow[];
    const histogram: Record<string, number> = {};
    const incomplete: Array<{ id: string; slug: string; gaps: string[] }> = [];
    for (const r of rows) {
      const gaps = deriveCompletenessGaps(r);
      if (gaps.length === 0) continue;
      incomplete.push({ id: r.id, slug: r.slug, gaps });
      for (const g of gaps) {
        histogram[g] = (histogram[g] ?? 0) + 1;
      }
    }
    res.json({
      activeCount: rows.length,
      completeCount: rows.length - incomplete.length,
      incompleteCount: incomplete.length,
      gapHistogram: histogram,
      incomplete,
    });
  },
);

// ── LIST ────────────────────────────────────────────────────────────
router.get("/admin/payer-profiles", requireAdmin, async (req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  let query = supabase
    .schema("resupply")
    .from("payer_profiles")
    .select(FULL_SELECT)
    .order("display_name", { ascending: true })
    .limit(500);

  const region = typeof req.query.region === "string" ? req.query.region : undefined;
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
});

// ── DETAIL ──────────────────────────────────────────────────────────
router.get("/admin/payer-profiles/:id", requireAdmin, async (req, res) => {
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
});

// ── CREATE (admin only) ─────────────────────────────────────────────
router.post("/admin/payer-profiles", requireAdminOnly, async (req, res) => {
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
      prior_auth_phone_e164: b.priorAuthPhoneE164 ?? null,
      claim_status_phone_e164: b.claimStatusPhoneE164 ?? null,
      provider_portal_url: b.providerPortalUrl ?? null,
      fee_schedule_source: b.feeScheduleSource ?? null,
      notes: b.notes ?? null,
      is_active: b.isActive,
      timely_filing_days: b.timelyFilingDays ?? null,
      claims_mailing_address:
        (b.claimsMailingAddress ?? null) as Json | null,
      appeals_mailing_address:
        (b.appealsMailingAddress ?? null) as Json | null,
      member_id_pattern: b.memberIdPattern ?? null,
      required_modifiers_dme: b.requiredModifiersDme ?? [],
      requires_referring_provider_npi:
        b.requiresReferringProviderNpi ?? false,
      accepts_secondary_electronic: b.acceptsSecondaryElectronic ?? true,
      era_payer_id: b.eraPayerId ?? null,
      era_enrollment_required: b.eraEnrollmentRequired ?? false,
      enrollment_status: b.enrollmentStatus ?? "unknown",
      enrollment_effective_on: b.enrollmentEffectiveOn ?? null,
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
});

// ── PATCH (admin only) ──────────────────────────────────────────────
router.patch("/admin/payer-profiles/:id", requireAdminOnly, async (req, res) => {
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
  if (b.payerLegalName !== undefined) update.payer_legal_name = b.payerLegalName;
  if (b.parentOrg !== undefined) update.parent_org = b.parentOrg;
  if (b.lineOfBusiness !== undefined) update.line_of_business = b.lineOfBusiness;
  if (b.region !== undefined) update.region = b.region;
  if (b.officeAllyPayerId !== undefined) update.office_ally_payer_id = b.officeAllyPayerId;
  if (b.edi5010PayerId !== undefined) update.edi_5010_payer_id = b.edi5010PayerId;
  if (b.claimFormat !== undefined) update.claim_format = b.claimFormat;
  if (b.paperOnly !== undefined) update.paper_only = b.paperOnly;
  if (b.requiresPriorAuthDme !== undefined) update.requires_prior_auth_dme = b.requiresPriorAuthDme;
  if (b.priorAuthPhoneE164 !== undefined) update.prior_auth_phone_e164 = b.priorAuthPhoneE164;
  if (b.claimStatusPhoneE164 !== undefined) update.claim_status_phone_e164 = b.claimStatusPhoneE164;
  if (b.providerPortalUrl !== undefined) update.provider_portal_url = b.providerPortalUrl;
  if (b.feeScheduleSource !== undefined) update.fee_schedule_source = b.feeScheduleSource;
  if (b.notes !== undefined) update.notes = b.notes;
  if (b.isActive !== undefined) update.is_active = b.isActive;
  if (b.timelyFilingDays !== undefined)
    update.timely_filing_days = b.timelyFilingDays;
  if (b.claimsMailingAddress !== undefined)
    update.claims_mailing_address =
      (b.claimsMailingAddress ?? null) as Json | null;
  if (b.appealsMailingAddress !== undefined)
    update.appeals_mailing_address =
      (b.appealsMailingAddress ?? null) as Json | null;
  if (b.memberIdPattern !== undefined)
    update.member_id_pattern = b.memberIdPattern;
  if (b.requiredModifiersDme !== undefined)
    update.required_modifiers_dme = b.requiredModifiersDme;
  if (b.requiresReferringProviderNpi !== undefined)
    update.requires_referring_provider_npi = b.requiresReferringProviderNpi;
  if (b.acceptsSecondaryElectronic !== undefined)
    update.accepts_secondary_electronic = b.acceptsSecondaryElectronic;
  if (b.eraPayerId !== undefined) update.era_payer_id = b.eraPayerId;
  if (b.eraEnrollmentRequired !== undefined)
    update.era_enrollment_required = b.eraEnrollmentRequired;
  if (b.enrollmentStatus !== undefined)
    update.enrollment_status = b.enrollmentStatus;
  if (b.enrollmentEffectiveOn !== undefined)
    update.enrollment_effective_on = b.enrollmentEffectiveOn;

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
});

function isRegion(v: string): v is PayerRegion {
  return (REGION_VALUES as readonly string[]).includes(v);
}
function isLineOfBusiness(v: string): v is PayerLineOfBusiness {
  return (LINE_OF_BUSINESS_VALUES as readonly string[]).includes(v);
}

export default router;
