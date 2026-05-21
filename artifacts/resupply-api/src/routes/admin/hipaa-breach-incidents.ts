// /admin/hipaa-breach-incidents — HIPAA §164.404-414 breach
// lifecycle tracking.
//
//   GET   /admin/hipaa-breach-incidents
//   GET   /admin/hipaa-breach-incidents/:id
//   POST  /admin/hipaa-breach-incidents              admin-only
//   PATCH /admin/hipaa-breach-incidents/:id          admin-only
//
// Compliance lever: surveyors ask "show me your breach incidents
// from the last 12 months". Without a structured table the answer
// is "search the inbox", which fails the audit.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  requireAdminOnly,
  requirePermission,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

type Row = Database["resupply"]["Tables"]["hipaa_breach_incidents"]["Row"];

const STATUS_VALUES = [
  "under_investigation",
  "not_a_breach",
  "confirmed_breach",
  "resolved",
] as const satisfies readonly Row["status"][];

const KIND_VALUES = [
  "lost_device",
  "misdirected_fax",
  "misdirected_email",
  "unauthorized_access",
  "phishing",
  "malware",
  "business_associate",
  "mailing_error",
  "paper_disposal",
  "other",
] as const satisfies readonly Row["kind"][];

const SEVERITY_VALUES = ["low", "moderate", "high", "critical"] as const satisfies readonly Row["severity"][];

const upsertBody = z
  .object({
    slug: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .regex(/^[a-z0-9_-]+$/),
    title: z.string().trim().min(1).max(240),
    description: z.string().trim().min(1).max(8000),
    kind: z.enum(KIND_VALUES),
    severity: z.enum(SEVERITY_VALUES),
    discoveredAt: z.string().datetime(),
    individualsAffected: z.number().int().min(0).nullable().optional(),
    mediaNotificationRequired: z.boolean().default(false),
    riskAssessment: z.string().trim().max(4000).nullable().optional(),
    mitigation: z.string().trim().max(4000).nullable().optional(),
    affectedSystems: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    ownerEmail: z.string().email().max(180).nullable().optional(),
    notes: z.string().trim().max(8000).nullable().optional(),
  })
  .strict();

const patchBody = upsertBody
  .partial()
  .extend({
    status: z.enum(STATUS_VALUES).optional(),
    individualsNotifiedAt: z.string().datetime().nullable().optional(),
    hhsNotifiedAt: z.string().datetime().nullable().optional(),
    mediaNotifiedAt: z.string().datetime().nullable().optional(),
    resolvedAt: z.string().datetime().nullable().optional(),
  });

const idParam = z.object({ id: z.string().uuid() });

function rowToApi(r: Row) {
  // Surface a couple of helpers: days remaining vs the 60-day clock
  // (calculated, never persisted — recomputed on every read).
  const sixtyDays = 60 * 24 * 3600 * 1000;
  const discoveredMs = new Date(r.discovered_at).getTime();
  const daysSinceDiscovery = Math.floor(
    (Date.now() - discoveredMs) / (24 * 3600 * 1000),
  );
  const daysToIndividualNotice =
    r.individuals_notified_at !== null
      ? null
      : Math.max(
          0,
          Math.floor(
            (discoveredMs + sixtyDays - Date.now()) / (24 * 3600 * 1000),
          ),
        );
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    description: r.description,
    status: r.status,
    kind: r.kind,
    severity: r.severity,
    individualsAffected: r.individuals_affected,
    mediaNotificationRequired: r.media_notification_required,
    riskAssessment: r.risk_assessment,
    mitigation: r.mitigation,
    discoveredAt: r.discovered_at,
    individualsNotifiedAt: r.individuals_notified_at,
    hhsNotifiedAt: r.hhs_notified_at,
    mediaNotifiedAt: r.media_notified_at,
    resolvedAt: r.resolved_at,
    affectedSystems: r.affected_systems,
    ownerEmail: r.owner_email,
    notes: r.notes,
    daysSinceDiscovery,
    daysToIndividualNotice,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

router.get(
  "/admin/hipaa-breach-incidents",
  requirePermission("compliance.read"),
  async (req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    let query = supabase
      .schema("resupply")
      .from("hipaa_breach_incidents")
      .select("*")
      .order("discovered_at", { ascending: false })
      .limit(200);
    const status =
      typeof req.query.status === "string" ? req.query.status : undefined;
    if (status && (STATUS_VALUES as readonly string[]).includes(status)) {
      query = query.eq("status", status as Row["status"]);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ incidents: (data ?? []).map(rowToApi) });
  },
);

router.get(
  "/admin/hipaa-breach-incidents/:id",
  requirePermission("compliance.read"),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data } = await supabase
      .schema("resupply")
      .from("hipaa_breach_incidents")
      .select("*")
      .eq("id", parsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ incident: rowToApi(data) });
  },
);

router.post(
  "/admin/hipaa-breach-incidents",
  requireAdminOnly,
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
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("hipaa_breach_incidents")
      .insert({
        slug: b.slug,
        title: b.title,
        description: b.description,
        kind: b.kind,
        severity: b.severity,
        discovered_at: b.discoveredAt,
        individuals_affected: b.individualsAffected ?? null,
        media_notification_required: b.mediaNotificationRequired,
        risk_assessment: b.riskAssessment ?? null,
        mitigation: b.mitigation ?? null,
        affected_systems: b.affectedSystems,
        owner_email: b.ownerEmail ?? null,
        notes: b.notes ?? null,
      })
      .select("id")
      .single();
    if (error) {
      if (typeof error.code === "string" && error.code === "23505") {
        res.status(409).json({ error: "slug_conflict" });
        return;
      }
      throw error;
    }
    await logAudit({
      action: "hipaa_breach.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "hipaa_breach_incidents",
      targetId: data.id,
      metadata: { slug: b.slug, kind: b.kind, severity: b.severity },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "hipaa_breach.create audit write failed");
    });
    res.status(201).json({ id: data.id });
  },
);

router.patch(
  "/admin/hipaa-breach-incidents/:id",
  requireAdminOnly,
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const b = parsed.data;
    const update: Database["resupply"]["Tables"]["hipaa_breach_incidents"]["Update"] = {
      updated_at: new Date().toISOString(),
    };
    if (b.slug !== undefined) update.slug = b.slug;
    if (b.title !== undefined) update.title = b.title;
    if (b.description !== undefined) update.description = b.description;
    if (b.kind !== undefined) update.kind = b.kind;
    if (b.severity !== undefined) update.severity = b.severity;
    if (b.discoveredAt !== undefined) update.discovered_at = b.discoveredAt;
    if (b.individualsAffected !== undefined)
      update.individuals_affected = b.individualsAffected;
    if (b.mediaNotificationRequired !== undefined)
      update.media_notification_required = b.mediaNotificationRequired;
    if (b.riskAssessment !== undefined) update.risk_assessment = b.riskAssessment;
    if (b.mitigation !== undefined) update.mitigation = b.mitigation;
    if (b.affectedSystems !== undefined) update.affected_systems = b.affectedSystems;
    if (b.ownerEmail !== undefined) update.owner_email = b.ownerEmail;
    if (b.notes !== undefined) update.notes = b.notes;
    if (b.status !== undefined) update.status = b.status;
    if (b.individualsNotifiedAt !== undefined)
      update.individuals_notified_at = b.individualsNotifiedAt;
    if (b.hhsNotifiedAt !== undefined) update.hhs_notified_at = b.hhsNotifiedAt;
    if (b.mediaNotifiedAt !== undefined) update.media_notified_at = b.mediaNotifiedAt;
    if (b.resolvedAt !== undefined) update.resolved_at = b.resolvedAt;

    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("hipaa_breach_incidents")
      .update(update)
      .eq("id", idParsed.data.id);
    if (error) throw error;
    await logAudit({
      action: "hipaa_breach.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "hipaa_breach_incidents",
      targetId: idParsed.data.id,
      metadata: {
        fields_changed: Object.keys(update).filter((k) => k !== "updated_at"),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "hipaa_breach.update audit write failed");
    });
    res.json({ ok: true });
  },
);

export default router;
