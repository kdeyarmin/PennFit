// /admin/cases — lightweight CSR case (ticket) object (migration 0189 /
// roadmap F4). A cross-channel issue with a persistent home + links to
// the artifacts (conversation / order / followup / …) it touches.
//
//   GET   /admin/cases             — list (filter by status; default open)
//   POST  /admin/cases             — open a case
//   GET   /admin/cases/:id         — a case + its links
//   PATCH /admin/cases/:id         — update status / priority / assignee / summary
//   POST  /admin/cases/:id/links   — link an artifact to the case
//
// Read on cases.read, write on cases.manage — both held by the CSR tier
// AND management (cases are front-line tooling, not management-only).
//
// Audit posture: title + summary are CSR free-text (may name a customer),
// so the audit envelope records structural fields only (priority, patient
// ref, link kind/ref) — never the free text.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.string().trim().min(1).max(64);

const createSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    patientId: z.string().trim().max(128).optional(),
    customerId: z.string().trim().max(128).optional(),
    summary: z.string().trim().max(4000).optional(),
  })
  .strict();

const patchSchema = z
  .object({
    status: z.enum(["open", "in_progress", "resolved", "closed"]).optional(),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    assignedToUserId: z.string().trim().max(128).nullable().optional(),
    summary: z.string().trim().max(4000).optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, {
    message: "No fields to update.",
  });

const linkSchema = z
  .object({
    linkKind: z.enum([
      "conversation",
      "order",
      "followup",
      "fax",
      "review",
      "product_question",
      "referral",
      "work_item",
      "other",
    ]),
    refId: z.string().trim().min(1).max(128),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

const listQuery = z
  .object({
    status: z
      .enum(["open", "in_progress", "resolved", "closed", "all"])
      .optional(),
  })
  .strip();

function mapCase(r: Record<string, unknown>) {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    priority: r.priority,
    patientId: r.patient_id,
    customerId: r.customer_id,
    assignedToUserId: r.assigned_to_user_id,
    openedByEmail: r.opened_by_email,
    summary: r.summary,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at,
  };
}

const CASE_SELECT =
  "id, title, status, priority, patient_id, customer_id, assigned_to_user_id, opened_by_email, summary, created_at, updated_at, resolved_at";

router.get(
  "/admin/cases",
  requirePermission("cases.read"),
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    const status = parsed.success ? parsed.data.status : undefined;

    const supabase = getSupabaseServiceRoleClient();
    let query = supabase
      .schema("resupply")
      .from("cases")
      .select(CASE_SELECT)
      .order("created_at", { ascending: false })
      .limit(200);
    const effective = status ?? "open";
    if (effective !== "all") query = query.eq("status", effective);

    const { data, error } = await query;
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    res.json({ cases: rows.map(mapCase) });
  },
);

router.post(
  "/admin/cases",
  requirePermission("cases.manage"),
  adminRateLimit({ name: "cases.create", preset: "mutation" }),
  async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
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
    const d = parsed.data;

    const supabase = getSupabaseServiceRoleClient();
    const { data: inserted, error } = await supabase
      .schema("resupply")
      .from("cases")
      .insert({
        title: d.title,
        priority: d.priority ?? "normal",
        patient_id: d.patientId ?? null,
        customer_id: d.customerId ?? null,
        summary: d.summary ?? null,
        opened_by_user_id: req.adminUserId ?? null,
        opened_by_email: req.adminEmail ?? "<unknown>",
      })
      .select("id, created_at")
      .single();
    if (error) {
      res.status(500).json({ error: "insert_failed", message: error.message });
      return;
    }
    const row = inserted as { id: string; created_at: string };

    await logAudit({
      action: "case.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "cases",
      targetId: row.id,
      metadata: {
        priority: d.priority ?? "normal",
        patient_id: d.patientId ?? null,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "case.create audit write failed");
    });

    res.status(201).json({ id: row.id, createdAt: row.created_at });
  },
);

router.get(
  "/admin/cases/:id",
  requirePermission("cases.read"),
  async (req, res) => {
    const idCheck = idParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const id = idCheck.data;

    const supabase = getSupabaseServiceRoleClient();
    const { data: caseData } = await supabase
      .schema("resupply")
      .from("cases")
      .select(CASE_SELECT)
      .eq("id", id)
      .maybeSingle();
    const c = caseData as Record<string, unknown> | null;
    if (!c) {
      res.status(404).json({ error: "case_not_found" });
      return;
    }

    const { data: linkData } = await supabase
      .schema("resupply")
      .from("case_links")
      .select("id, link_kind, ref_id, note, created_by_email, created_at")
      .eq("case_id", id)
      .order("created_at", { ascending: true });
    const links = (linkData ?? []) as Array<Record<string, unknown>>;

    res.json({
      case: mapCase(c),
      links: links.map((l) => ({
        id: l.id,
        linkKind: l.link_kind,
        refId: l.ref_id,
        note: l.note,
        createdByEmail: l.created_by_email,
        createdAt: l.created_at,
      })),
    });
  },
);

router.patch(
  "/admin/cases/:id",
  requirePermission("cases.manage"),
  adminRateLimit({ name: "cases.update", preset: "mutation" }),
  async (req, res) => {
    const idCheck = idParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const id = idCheck.data;

    const parsed = patchSchema.safeParse(req.body);
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
    const d = parsed.data;

    const nowIso = new Date().toISOString();
    const update: Record<string, unknown> = { updated_at: nowIso };
    if (d.status !== undefined) {
      update.status = d.status;
      update.resolved_at =
        d.status === "resolved" || d.status === "closed" ? nowIso : null;
    }
    if (d.priority !== undefined) update.priority = d.priority;
    if (d.assignedToUserId !== undefined)
      update.assigned_to_user_id = d.assignedToUserId;
    if (d.summary !== undefined) update.summary = d.summary;

    const supabase = getSupabaseServiceRoleClient();
    const { data: updatedData, error } = await supabase
      .schema("resupply")
      .from("cases")
      .update(update)
      .eq("id", id)
      .select("id, status")
      .maybeSingle();
    if (error) {
      res.status(500).json({ error: "update_failed", message: error.message });
      return;
    }
    const updated = updatedData as Record<string, unknown> | null;
    if (!updated) {
      res.status(404).json({ error: "case_not_found" });
      return;
    }

    await logAudit({
      action: "case.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "cases",
      targetId: id,
      metadata: { fields: Object.keys(d) },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "case.update audit write failed");
    });

    res.json({ id: updated.id, status: updated.status });
  },
);

router.post(
  "/admin/cases/:id/links",
  requirePermission("cases.manage"),
  adminRateLimit({ name: "cases.link", preset: "mutation" }),
  async (req, res) => {
    const idCheck = idParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const id = idCheck.data;

    const parsed = linkSchema.safeParse(req.body);
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
    const d = parsed.data;

    const supabase = getSupabaseServiceRoleClient();
    // Pre-check the case so a missing case is a clean 404 (not an FK error).
    const { data: caseRow } = await supabase
      .schema("resupply")
      .from("cases")
      .select("id")
      .eq("id", id)
      .maybeSingle();
    if (!caseRow) {
      res.status(404).json({ error: "case_not_found" });
      return;
    }

    const { error } = await supabase
      .schema("resupply")
      .from("case_links")
      .upsert(
        {
          case_id: id,
          link_kind: d.linkKind,
          ref_id: d.refId,
          note: d.note ?? null,
          created_by_email: req.adminEmail ?? null,
        },
        { onConflict: "case_id,link_kind,ref_id", ignoreDuplicates: true },
      )
      .select("id");
    if (error) {
      res.status(500).json({ error: "link_failed", message: error.message });
      return;
    }

    await logAudit({
      action: "case.link",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "case_links",
      targetId: id,
      metadata: { link_kind: d.linkKind, ref_id: d.refId },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "case.link audit write failed");
    });

    res.status(201).json({ linked: true });
  },
);

export default router;
