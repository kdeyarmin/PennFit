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
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
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
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const FULL_SELECT =
  "id, slug, display_name, payer_legal_name, parent_org, line_of_business, region, office_ally_payer_id, edi_5010_payer_id, claim_format, paper_only, requires_prior_auth_dme, prior_auth_phone_e164, claim_status_phone_e164, provider_portal_url, fee_schedule_source, notes, is_active, created_at, updated_at";

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
      prior_auth_phone_e164: b.priorAuthPhoneE164 ?? null,
      claim_status_phone_e164: b.claimStatusPhoneE164 ?? null,
      provider_portal_url: b.providerPortalUrl ?? null,
      fee_schedule_source: b.feeScheduleSource ?? null,
      notes: b.notes ?? null,
      is_active: b.isActive,
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
