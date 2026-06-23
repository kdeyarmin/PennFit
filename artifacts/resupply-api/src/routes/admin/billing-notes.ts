// /admin/billing/notes — a free-form notes log for the billing team
// (migration 0465).
//
//   GET  /admin/billing/notes            — list (newest first), optional
//                                           ?category= and ?patientId= filters
//   POST /admin/billing/notes            — append a note
//
// Unlike insurance_claim_events (per-claim) or shop_order_notes (per-order),
// these notes are NOT pinned to one artifact. They're the billers' shared
// scratchpad for cross-cutting work — payer follow-ups, batch status,
// collections-agency coordination, anything that wouldn't survive on a
// single claim row. Each note carries a coarse `category` so the feed
// filters, plus an OPTIONAL patient link.
//
// Gate: `requireAdmin` only — any signed-in admin staffer can read and
// post (the billing team isn't a separate RBAC role). Append-only; there
// is intentionally no edit/delete affordance, mirroring the other note
// families.
//
// PHI / log posture: the body may contain anything the biller types. The
// audit row records category + body_length only — never the body content.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { type Database, getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const CATEGORY_VALUES = [
  "claims",
  "collections",
  "payer",
  "patient",
  "general",
] as const;

const listQuery = z
  .object({
    category: z.enum(CATEGORY_VALUES).optional(),
    patientId: z.string().trim().uuid().optional(),
  })
  .strict();

const createBody = z
  .object({
    category: z.enum(CATEGORY_VALUES).default("general"),
    patientId: z.string().trim().uuid().nullable().optional(),
    body: z
      .string()
      .trim()
      .min(1, "Note body cannot be empty.")
      .max(4000, "Note body must be 4000 characters or fewer."),
  })
  .strict();

type BillingNoteRow = Database["resupply"]["Tables"]["billing_notes"]["Row"];

router.get("/admin/billing/notes", requireAdmin, async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const orgId = req.orgId;
  if (!orgId) {
    res.status(500).json({ error: "tenant_context_missing" });
    return;
  }
  const supabase = getOrgScopedClient(orgId);

  let q = supabase
    .from("billing_notes")
    .select(
      "id, category, patient_id, body, author_email, author_user_id, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(200);
  if (parsed.data.category) q = q.eq("category", parsed.data.category);
  if (parsed.data.patientId) q = q.eq("patient_id", parsed.data.patientId);

  const { data: rows, error } = await q;
  if (error) {
    res.status(500).json({ error: "query_failed", message: error.message });
    return;
  }

  // Safe log. NO note bodies; just the count + admin who looked.
  req.log?.info(
    {
      count: rows?.length ?? 0,
      category: parsed.data.category ?? null,
      adminEmail: req.adminEmail,
    },
    "admin.billing.notes.list",
  );

  res.json({
    notes: ((rows ?? []) as Array<BillingNoteRow>).map((r) => ({
      id: r.id,
      category: r.category,
      patientId: r.patient_id,
      body: r.body ?? "",
      authorEmail: r.author_email,
      authorUserId: r.author_user_id,
      createdAt: r.created_at,
    })),
  });
});

router.post(
  "/admin/billing/notes",
  requireAdmin,
  adminRateLimit({ name: "billing_notes.create", preset: "mutation" }),
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
    const { category, body } = parsed.data;
    const patientId = parsed.data.patientId ?? null;

    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    // If a patient was linked, map a bad reference to a clean 404 rather
    // than surfacing the FK violation as a 500.
    if (patientId) {
      const { data: patient } = await supabase
        .from("patients")
        .select("id")
        .eq("id", patientId)
        .limit(1)
        .maybeSingle();
      if (!patient) {
        res.status(404).json({ error: "patient_not_found" });
        return;
      }
    }

    const { data: inserted, error: insErr } = await supabase
      .from("billing_notes")
      .insert({
        category,
        patient_id: patientId,
        body,
        author_email: req.adminEmail ?? "<unknown>",
        author_user_id: req.adminUserId ?? null,
      })
      .select("id, created_at")
      .single();
    if (insErr) throw insErr;

    // Audit. Structural metadata only — same policy as the other note
    // families. The body content NEVER lands in the envelope.
    await logAudit({
      action: "billing.note.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "billing_notes",
      targetId: inserted.id,
      metadata: {
        category,
        patient_id: patientId,
        body_length: body.length,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "billing.note.create audit write failed");
    });

    res.status(201).json({
      id: inserted.id,
      createdAt: inserted.created_at,
    });
  },
);

export default router;
