// /admin/compliance/oig-leie-screenings — record + list OIG LEIE
// monthly exclusion checks for staff / providers / vendors / owners.
//
//   POST /admin/compliance/oig-leie-screenings/run
//        — run a screen on the provided subject, persist the result.
//   GET  /admin/compliance/oig-leie-screenings
//        — most-recent N screenings, optionally filtered by
//          subject_kind / result.
//   GET  /admin/compliance/oig-leie-screenings/coverage
//        — per-subject "last screened" rollup so the dashboard can
//          flag who's overdue for the monthly check.
//
// The screening flow records every attempt — even when the lookup
// errors — so the audit trail proves "we tried, here's why it didn't
// resolve" rather than vanishing on a failure.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getSupabaseServiceRoleClient,
  OIG_LEIE_RESULT_VALUES,
  OIG_LEIE_SUBJECT_KIND_VALUES,
} from "@workspace/resupply-db";

import {
  recordScreening,
  screenSubject,
} from "../../lib/compliance/oig-leie-screener";
import { logger } from "../../lib/logger";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const runBody = z
  .object({
    subjectKind: z.enum(OIG_LEIE_SUBJECT_KIND_VALUES),
    subjectLabel: z.string().trim().min(1).max(200),
    subjectAdminUserId: z.string().uuid().nullable().optional(),
    subjectProviderId: z.string().uuid().nullable().optional(),
    subjectBaaId: z.string().uuid().nullable().optional(),
    subjectNpi: z
      .string()
      .regex(/^\d{10}$/)
      .nullable()
      .optional(),
    subjectFirstname: z.string().trim().max(80).nullable().optional(),
    subjectLastname: z.string().trim().min(1).max(80),
    dispositionNote: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

router.post(
  "/admin/compliance/oig-leie-screenings/run",
  requirePermission("compliance.resolve"),
  async (req, res) => {
    const parsed = runBody.safeParse(req.body);
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
    let result: "clear" | "hit" | "errored" = "clear";
    let matchedExclusionId: string | null = null;
    try {
      const scan = await screenSubject({
        npi: b.subjectNpi ?? null,
        lastname: b.subjectLastname,
        firstname: b.subjectFirstname ?? null,
      });
      if (scan.match) {
        result = "hit";
        matchedExclusionId = scan.match.id;
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "oig.leie.run scan failed",
      );
      result = "errored";
    }
    const recorded = await recordScreening({
      subjectKind: b.subjectKind,
      subjectLabel: b.subjectLabel,
      subjectAdminUserId: b.subjectAdminUserId ?? null,
      subjectProviderId: b.subjectProviderId ?? null,
      subjectBaaId: b.subjectBaaId ?? null,
      subjectNpi: b.subjectNpi ?? null,
      result,
      matchedExclusionId,
      dispositionNote: b.dispositionNote ?? null,
      screenedByEmail: req.adminEmail ?? "unknown",
    });
    await logAudit({
      action: "compliance.oig_leie.screen",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "oig_leie_screenings",
      targetId: recorded.id,
      metadata: {
        subject_kind: b.subjectKind,
        subject_label: b.subjectLabel,
        result,
        had_npi: b.subjectNpi != null,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "compliance.oig_leie.screen audit failed");
    });
    res.status(201).json({
      id: recorded.id,
      result,
      matched_exclusion_id: matchedExclusionId,
    });
  },
);

const listQuery = z
  .object({
    subjectKind: z.enum(OIG_LEIE_SUBJECT_KIND_VALUES).optional(),
    result: z.enum(OIG_LEIE_RESULT_VALUES).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

router.get(
  "/admin/compliance/oig-leie-screenings",
  requirePermission("compliance.read"),
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    let q = supabase
      .schema("resupply")
      .from("oig_leie_screenings")
      .select("*")
      .order("screened_at", { ascending: false })
      .limit(parsed.data.limit);
    if (parsed.data.subjectKind)
      q = q.eq("subject_kind", parsed.data.subjectKind);
    if (parsed.data.result) q = q.eq("result", parsed.data.result);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ screenings: data ?? [] });
  },
);

router.get(
  "/admin/compliance/oig-leie-screenings/coverage",
  requirePermission("compliance.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    // Most-recent screening per subject_label. PostgREST can't do
    // DISTINCT ON in one call so we cap at the most recent 1000
    // screenings and reduce client-side. The dashboard's expected
    // active-staff/vendor cardinality is well under that.
    const { data, error } = await supabase
      .schema("resupply")
      .from("oig_leie_screenings")
      .select("subject_kind, subject_label, result, screened_at")
      .order("screened_at", { ascending: false })
      .limit(1000);
    if (error) throw error;
    const seen = new Set<string>();
    const newest: Array<{
      subject_kind: string;
      subject_label: string;
      result: string;
      screened_at: string;
      days_since: number;
    }> = [];
    const today = Date.now();
    for (const row of data ?? []) {
      const k = `${row.subject_kind}:${row.subject_label}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const days = Math.floor(
        (today - new Date(row.screened_at).getTime()) /
          (24 * 60 * 60 * 1000),
      );
      newest.push({ ...row, days_since: days });
    }
    res.json({
      subjects: newest,
      overdue_count: newest.filter((r) => r.days_since > 30).length,
    });
  },
);

export default router;
