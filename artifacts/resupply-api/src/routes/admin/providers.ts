// /admin/providers — central registry of prescribing physicians.
//
//   GET    /admin/providers                 — list / search (?q= by name or NPI)
//   GET    /admin/providers/:id             — full record by UUID
//   POST   /admin/providers                 — create (NPI required, deduped)
//   POST   /admin/providers/nppes-lookup    — proxy NPPES lookup by NPI
//                                              (used by the Add Provider form)
//
// CSR workflow:
//   1. Admin opens Add Provider, types a 10-digit NPI.
//   2. The form fires /admin/providers/nppes-lookup, which proxies to
//      the public NPPES v2.1 endpoint and returns the projected
//      provider data (name, taxonomy, address, phone, fax).
//   3. CSR confirms or edits, hits Save. POST /admin/providers writes
//      the row with source='nppes' and verified_at=now.
//   4. Manual entries (provider not in NPPES, or admin chose to skip
//      the lookup) come in with source='csr_entry' and verified_at
//      null. UI surfaces a "verify" CTA in that state.
//
// The route does NOT support PATCH or DELETE in this sprint. Provider
// records are append-only by policy: if the practice moves or changes
// fax, the legal_name + npi stay constant — only the address/phone/
// fax fields drift, and we re-verify against NPPES rather than let
// CSRs hand-edit. A later sprint can add a focused PATCH for the
// non-identity fields once the verification flow is in place.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { lookupNpi, NppesLookupError } from "../../lib/nppes";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const NPI_RE = /^\d{10}$/;

const addressSchema = z
  .object({
    line1: z.string().trim().max(120).optional(),
    line2: z.string().trim().max(120).optional(),
    city: z.string().trim().max(80).optional(),
    state: z.string().trim().max(40).optional(),
    postalCode: z.string().trim().max(20).optional(),
    country: z.string().trim().max(8).optional(),
  })
  .strict()
  .nullable()
  .optional();

const createBody = z
  .object({
    npi: z.string().trim().regex(NPI_RE, "NPI must be a 10-digit number"),
    legalName: z.string().trim().min(1).max(200),
    taxonomyCode: z.string().trim().max(16).nullable().optional(),
    phoneE164: z
      .string()
      .trim()
      .regex(/^\+\d{8,15}$/, "Phone must be E.164 (+ then 8-15 digits)")
      .nullable()
      .optional(),
    faxE164: z
      .string()
      .trim()
      .regex(/^\+\d{8,15}$/, "Fax must be E.164 (+ then 8-15 digits)")
      .nullable()
      .optional(),
    email: z.string().trim().email().max(200).nullable().optional(),
    practiceName: z.string().trim().max(200).nullable().optional(),
    practiceAddress: addressSchema,
    notes: z.string().trim().max(2000).nullable().optional(),
    source: z.enum(["nppes", "csr_entry"]).optional().default("csr_entry"),
  })
  .strict();

const lookupBody = z
  .object({
    npi: z.string().trim().regex(NPI_RE, "NPI must be a 10-digit number"),
  })
  .strict();

// Central physician/NP registry. Reads gate on `patients.read`
// (clinical reference data — every role with patient-tier read
// access needs the registry). Writes gate on `patients.update`.
router.get(
  "/admin/providers",
  requirePermission("patients.read"),
  async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const supabase = getSupabaseServiceRoleClient();

    let query = supabase
      .schema("resupply")
      .from("providers")
      .select(
        "id, npi, legal_name, taxonomy_code, phone_e164, fax_e164, email, practice_name, source, verified_at, created_at",
      )
      .order("legal_name", { ascending: true })
      .limit(50);

    if (q.length > 0) {
      // If the query is 10 digits, treat it as an NPI exact match. The
      // partial-search UX is "scan-as-you-type"; an NPI in hand should
      // never fan out to a name-prefix search.
      if (NPI_RE.test(q)) {
        query = query.eq("npi", q);
      } else {
        const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
        query = query.ilike("legal_name", `%${escaped}%`);
      }
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({
      providers: (data ?? []).map((r) => ({
        id: r.id,
        npi: r.npi,
        legalName: r.legal_name,
        taxonomyCode: r.taxonomy_code,
        phoneE164: r.phone_e164,
        faxE164: r.fax_e164,
        email: r.email,
        practiceName: r.practice_name,
        source: r.source,
        verifiedAt: r.verified_at,
        createdAt: r.created_at,
      })),
    });
  },
);

router.get(
  "/admin/providers/:id",
  requirePermission("patients.read"),
  async (req, res) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("providers")
      .select("*")
      .eq("id", idParse.data)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({
      id: data.id,
      npi: data.npi,
      legalName: data.legal_name,
      taxonomyCode: data.taxonomy_code,
      phoneE164: data.phone_e164,
      faxE164: data.fax_e164,
      email: data.email,
      practiceName: data.practice_name,
      practiceAddress: data.practice_address,
      source: data.source,
      verifiedAt: data.verified_at,
      notes: data.notes,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    });
  },
);

router.post(
  "/admin/providers",
  requirePermission("patients.update"),
  adminRateLimit({ name: "providers.create", preset: "mutation" }),
  async (req, res) => {
    const parsed = createBody.safeParse(req.body);
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
    const body = parsed.data;

    const supabase = getSupabaseServiceRoleClient();

    // Dedupe by NPI: if a row already exists with this NPI, return its
    // id with a 200 instead of creating a duplicate. The UNIQUE index
    // would refuse the insert anyway; surfacing the existing row keeps
    // the CSR flow happy (they get to the same provider regardless).
    const { data: existing, error: lookupErr } = await supabase
      .schema("resupply")
      .from("providers")
      .select("id")
      .eq("npi", body.npi)
      .limit(1)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (existing) {
      res.status(200).json({ id: existing.id, created: false });
      return;
    }

    const verifiedAt =
      body.source === "nppes" ? new Date().toISOString() : null;

    const { data: row, error } = await supabase
      .schema("resupply")
      .from("providers")
      .insert({
        npi: body.npi,
        legal_name: body.legalName,
        taxonomy_code: body.taxonomyCode ?? null,
        phone_e164: body.phoneE164 ?? null,
        fax_e164: body.faxE164 ?? null,
        email: body.email ?? null,
        practice_name: body.practiceName ?? null,
        practice_address: body.practiceAddress ?? null,
        notes: body.notes ?? null,
        source: body.source,
        verified_at: verifiedAt,
      })
      .select("id")
      .single();
    if (error) throw error;

    await logAudit({
      action: "provider.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "providers",
      targetId: row.id,
      metadata: {
        // npi is NOT PHI; safe to include in the audit metadata.
        npi: body.npi,
        source: body.source,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "provider.create audit write failed");
    });

    res.status(201).json({ id: row.id, created: true });
  },
);

// GET /admin/providers/:id/patients — referral-attribution view:
// every patient who currently has an active prescription written by
// this provider. Useful when a CSR opens a provider record and needs
// to see "who's on Dr. Smith's caseload" or before a bulk fax-to-MD
// outreach. Limited to 200 most-recently-prescribed-for patients to
// keep the payload bounded; CSRs needing more should use the search
// bar on /admin/patients with the provider's NPI.
router.get(
  "/admin/providers/:id/patients",
  // Patient roster keyed by provider — read-only patient-tier
  // data.
  requirePermission("patients.read"),
  async (req, res) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("prescriptions")
      .select(
        "id, patient_id, status, valid_from, valid_until, patients!inner(id, legal_first_name, legal_last_name, email, phone_e164, status)",
      )
      .eq("provider_id", idParse.data)
      .order("valid_from", { ascending: false })
      .limit(200);
    if (error) throw error;
    const seen = new Set<string>();
    const patients: Array<{
      patientId: string;
      legalFirstName: string | null;
      legalLastName: string | null;
      email: string | null;
      phoneE164: string | null;
      patientStatus: string | null;
      prescriptionId: string;
      prescriptionStatus: string | null;
      validFrom: string | null;
      validUntil: string | null;
    }> = [];
    for (const r of data ?? []) {
      if (seen.has(r.patient_id)) continue;
      seen.add(r.patient_id);
      const p = (r as { patients?: unknown }).patients as {
        id: string;
        legal_first_name: string | null;
        legal_last_name: string | null;
        email: string | null;
        phone_e164: string | null;
        status: string | null;
      } | null;
      patients.push({
        patientId: r.patient_id,
        legalFirstName: p?.legal_first_name ?? null,
        legalLastName: p?.legal_last_name ?? null,
        email: p?.email ?? null,
        phoneE164: p?.phone_e164 ?? null,
        patientStatus: p?.status ?? null,
        prescriptionId: r.id,
        prescriptionStatus: r.status,
        validFrom: r.valid_from,
        validUntil: r.valid_until,
      });
    }
    res.json({ patients });
  },
);

// POST /admin/providers/:id/portal-link — mint a 30-day signed link
// the CSR sends to the provider so they can self-serve a view of
// their caseload without an account. Idempotent; returns a new
// token per call (so revocation is "stop sharing this URL").
router.post(
  "/admin/providers/:id/portal-link",
  // Mints a signed provider-portal token. Write/share workflow,
  // gated like the other patient-update endpoints.
  requirePermission("patients.update"),
  adminRateLimit({ name: "providers.portal_link", preset: "mutation" }),
  async (req, res) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // Read the provider's current portal_link_version so the token
    // payload carries it. The verifier rejects any token whose
    // embedded version is below the row's current value, so bumping
    // this column revokes every outstanding token (see the new
    // DELETE handler below).
    const supabase = getSupabaseServiceRoleClient();
    const { data: existing, error: pErr } = await supabase
      .schema("resupply")
      .from("providers")
      .select("id, portal_link_version")
      .eq("id", idParse.data)
      .limit(1)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!existing) {
      res.status(404).json({ error: "provider_not_found" });
      return;
    }
    const { signProviderPortalToken } =
      await import("../../lib/provider-portal-token");
    const token = signProviderPortalToken(idParse.data, undefined, {
      portalLinkVersion: existing.portal_link_version,
    });
    res.json({
      token,
      path: `/provider-portal/${token}`,
      expiresInDays: 30,
    });
  },
);

// DELETE /admin/providers/:id/portal-link — revoke every outstanding
// portal token for this provider by incrementing portal_link_version.
// Any token issued before this bump fails the version check in the
// public portal route. Subsequent mints use the new version.
router.delete(
  "/admin/providers/:id/portal-link",
  requirePermission("patients.update"),
  adminRateLimit({ name: "providers.portal_link_revoke", preset: "mutation" }),
  async (req, res) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: existing, error: pErr } = await supabase
      .schema("resupply")
      .from("providers")
      .select("id, portal_link_version")
      .eq("id", idParse.data)
      .limit(1)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!existing) {
      res.status(404).json({ error: "provider_not_found" });
      return;
    }
    const nextVersion = (existing.portal_link_version ?? 0) + 1;
    const { error: updErr } = await supabase
      .schema("resupply")
      .from("providers")
      .update({
        portal_link_version: nextVersion,
        updated_at: new Date().toISOString(),
      })
      .eq("id", idParse.data);
    if (updErr) throw updErr;
    res.json({ ok: true, portalLinkVersion: nextVersion });
  },
);

router.post(
  "/admin/providers/nppes-lookup",
  // External NPI registry lookup — read-side action, used during
  // provider record creation, so same scope as the read endpoints.
  requirePermission("patients.read"),
  adminRateLimit({ name: "providers.nppes_lookup", preset: "mutation" }),
  async (req, res) => {
    const parsed = lookupBody.safeParse(req.body);
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

    try {
      const projection = await lookupNpi(parsed.data.npi);
      if (!projection) {
        res.status(404).json({ error: "npi_not_found" });
        return;
      }
      res.json({ provider: projection });
    } catch (err) {
      if (err instanceof NppesLookupError) {
        logger.warn({ err: err.message }, "NPPES lookup failed");
        res.status(502).json({ error: "nppes_unavailable" });
        return;
      }
      throw err;
    }
  },
);

export default router;
