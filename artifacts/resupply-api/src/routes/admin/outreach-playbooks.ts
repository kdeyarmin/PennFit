// /admin/outreach-playbooks — situation-based contact templates.
//
// A playbook bundles everything staff used to re-decide per patient:
// the situation it's for ("used the fitter, no order", "not meeting
// compliance goals", "ready to re-order supplies"), a multi-touch
// cadence (day offsets), the channel per touch (sms / email / call),
// and editable wording templates. Starting a playbook for a patient
// creates a run; the dispatcher (worker/jobs/outreach-playbook-tick.ts)
// sends SMS/email touches on schedule and surfaces call touches as
// staff call tasks with the rendered script.
//
//   GET    /admin/outreach-playbooks                 (conversations.manage)
//   POST   /admin/outreach-playbooks                 (admin.tools.manage)
//   PATCH  /admin/outreach-playbooks/:id             (admin.tools.manage)
//   PUT    /admin/outreach-playbooks/:id/steps       (admin.tools.manage)
//   POST   /admin/outreach-playbooks/:id/start       (conversations.manage)
//   GET    /admin/outreach-playbooks/runs            (conversations.manage)
//   POST   /admin/outreach-playbooks/runs/:id/cancel (conversations.manage)
//   GET    /admin/outreach-playbooks/call-queue      (conversations.manage)
//   POST   /admin/outreach-playbooks/call-tasks/:id/complete
//                                                    (conversations.manage)
//
// PHI / log posture: step bodies and call scripts are patient-facing
// copy — returned to the authorized admin UI and stored in the DB,
// never logged. Audit metadata is structural (ids, counts, channels).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  PLAYBOOK_CHANNELS,
  stepDueAt,
  validateSteps,
  type PlaybookStepShape,
} from "../../lib/outreach-playbooks";
import { logger } from "../../lib/logger";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { rateLimit } from "../../middlewares/rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";
import { CALL_OUTCOMES } from "./click-to-dial";

const router: IRouter = Router();

// Per-admin cap on playbook mutations — same envelope as the other
// non-financial admin write workflows (customer followups, macros).
// Mounted AFTER requirePermission on every route so req.adminUserId is
// populated and the limiter keys per actor (not one shared bucket).
const playbookMutationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 120,
  name: "admin_outreach_playbook_mutation",
  keyFn: (req) => req.adminUserId ?? "unknown",
});

export const PLAYBOOK_CATEGORIES = [
  "resupply",
  "clinical",
  "sales",
  "onboarding",
  "service",
  "engagement",
] as const;

const idParam = z.string().uuid();

const stepSchema = z
  .object({
    dayOffset: z.number().int().min(0).max(365),
    channel: z.enum(PLAYBOOK_CHANNELS),
    subject: z.string().trim().max(200).nullish(),
    body: z.string().trim().min(1).max(5000),
  })
  .strict();

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    situation: z.string().trim().min(1).max(2000),
    description: z.string().trim().max(2000).nullish(),
    category: z.enum(PLAYBOOK_CATEGORIES),
    steps: z.array(stepSchema).min(1).max(20),
  })
  .strict();

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    situation: z.string().trim().min(1).max(2000).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    category: z.enum(PLAYBOOK_CATEGORIES).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

const putStepsSchema = z
  .object({ steps: z.array(stepSchema).min(1).max(20) })
  .strict();

const startSchema = z.object({ patientId: z.string().uuid() }).strict();

const completeCallSchema = z
  .object({ outcome: z.enum(CALL_OUTCOMES) })
  .strict();

function toStepShapes(
  steps: Array<z.infer<typeof stepSchema>>,
): PlaybookStepShape[] {
  return steps.map((s, i) => ({
    stepIndex: i + 1,
    dayOffset: s.dayOffset,
    channel: s.channel,
    subject: s.subject?.trim() || null,
    body: s.body,
  }));
}

interface PlaybookRow {
  id: string;
  playbook_key: string;
  name: string;
  situation: string;
  description: string | null;
  category: string;
  is_active: boolean;
  is_seeded: boolean;
  updated_at: string;
}

interface StepRow {
  id: string;
  playbook_id: string;
  step_index: number;
  day_offset: number;
  channel: string;
  subject: string | null;
  body: string;
}

function serializeStep(row: StepRow) {
  return {
    id: row.id,
    stepIndex: row.step_index,
    dayOffset: row.day_offset,
    channel: row.channel,
    subject: row.subject,
    body: row.body,
  };
}

// ---------------------------------------------------------------
// Library
// ---------------------------------------------------------------

router.get(
  "/admin/outreach-playbooks",
  adminReadRateLimiter,
  requirePermission("conversations.manage"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const playbooksRes = await supabase
      .schema("resupply")
      .from("outreach_playbooks")
      .select(
        "id, playbook_key, name, situation, description, category, is_active, is_seeded, updated_at",
      )
      .order("category", { ascending: true })
      .order("name", { ascending: true })
      .limit(200);
    if (playbooksRes.error) {
      res
        .status(500)
        .json({ error: "query_failed", message: playbooksRes.error.message });
      return;
    }
    const playbookIds = ((playbooksRes.data ?? []) as PlaybookRow[]).map(
      (p) => p.id,
    );
    // Steps are fetched for exactly the playbooks on this page so a
    // large library can't truncate another playbook's cadence. The
    // limit is the structural max for the page (200 playbooks × 20
    // steps), not a global cap.
    const [stepsRes, activeRunsRes] = await Promise.all([
      playbookIds.length > 0
        ? supabase
            .schema("resupply")
            .from("outreach_playbook_steps")
            .select(
              "id, playbook_id, step_index, day_offset, channel, subject, body",
            )
            .in("playbook_id", playbookIds)
            .order("step_index", { ascending: true })
            .limit(4000)
        : Promise.resolve({ data: [], error: null }),
      supabase
        .schema("resupply")
        .from("outreach_playbook_runs")
        .select("playbook_id")
        .eq("status", "active")
        .limit(5000),
    ]);
    if (stepsRes.error || activeRunsRes.error) {
      const message = (stepsRes.error ?? activeRunsRes.error)?.message;
      res.status(500).json({ error: "query_failed", message });
      return;
    }

    const stepsByPlaybook = new Map<string, StepRow[]>();
    for (const s of (stepsRes.data ?? []) as StepRow[]) {
      const list = stepsByPlaybook.get(s.playbook_id) ?? [];
      list.push(s);
      stepsByPlaybook.set(s.playbook_id, list);
    }
    const activeRunCounts = new Map<string, number>();
    for (const r of (activeRunsRes.data ?? []) as Array<{
      playbook_id: string;
    }>) {
      activeRunCounts.set(
        r.playbook_id,
        (activeRunCounts.get(r.playbook_id) ?? 0) + 1,
      );
    }

    res.json({
      playbooks: ((playbooksRes.data ?? []) as PlaybookRow[]).map((p) => ({
        id: p.id,
        playbookKey: p.playbook_key,
        name: p.name,
        situation: p.situation,
        description: p.description,
        category: p.category,
        isActive: p.is_active,
        isSeeded: p.is_seeded,
        updatedAt: p.updated_at,
        activeRunCount: activeRunCounts.get(p.id) ?? 0,
        steps: (stepsByPlaybook.get(p.id) ?? []).map(serializeStep),
      })),
    });
  },
);

router.post(
  "/admin/outreach-playbooks",
  requirePermission("admin.tools.manage"),
  playbookMutationLimiter,
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
    const steps = toStepShapes(parsed.data.steps);
    const problems = validateSteps(steps);
    if (problems.length > 0) {
      res.status(400).json({ error: "invalid_steps", problems });
      return;
    }

    // Stable-but-unique key for operator-built playbooks. Seeded rows
    // keep their hand-picked keys; customs get slug + time suffix.
    const slug = parsed.data.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80);
    const playbookKey = `custom_${slug || "playbook"}_${Date.now().toString(36)}`;

    const supabase = getSupabaseServiceRoleClient();
    const { data: created, error: createErr } = await supabase
      .schema("resupply")
      .from("outreach_playbooks")
      .insert({
        playbook_key: playbookKey,
        name: parsed.data.name,
        situation: parsed.data.situation,
        description: parsed.data.description ?? null,
        category: parsed.data.category,
        is_seeded: false,
        created_by_email: req.adminEmail ?? null,
      })
      .select("id")
      .maybeSingle();
    if (createErr || !created) {
      res.status(500).json({
        error: "create_failed",
        message: createErr?.message,
      });
      return;
    }
    const playbookId = (created as { id: string }).id;

    const { error: stepsErr } = await supabase
      .schema("resupply")
      .from("outreach_playbook_steps")
      .insert(
        steps.map((s) => ({
          playbook_id: playbookId,
          step_index: s.stepIndex,
          day_offset: s.dayOffset,
          channel: s.channel,
          subject: s.subject,
          body: s.body,
        })),
      );
    if (stepsErr) {
      // Best-effort rollback of the header row so a half-created
      // playbook doesn't linger in the library.
      await supabase
        .schema("resupply")
        .from("outreach_playbooks")
        .delete()
        .eq("id", playbookId);
      res
        .status(500)
        .json({ error: "create_failed", message: stepsErr.message });
      return;
    }

    await logAudit({
      action: "outreach_playbook.create",
      adminUserId: req.adminUserId ?? null,
      adminEmail: req.adminEmail ?? null,
      targetTable: "outreach_playbooks",
      targetId: playbookId,
      metadata: {
        category: parsed.data.category,
        step_count: steps.length,
        channels: steps.map((s) => s.channel),
      },
    });
    res.status(201).json({ id: playbookId, playbookKey });
  },
);

router.patch(
  "/admin/outreach-playbooks/:id",
  requirePermission("admin.tools.manage"),
  playbookMutationLimiter,
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params.id);
    if (!idParsed.success) {
      res.status(400).json({ error: "invalid_playbook_id" });
      return;
    }
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
    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (parsed.data.name !== undefined) update.name = parsed.data.name;
    if (parsed.data.situation !== undefined) {
      update.situation = parsed.data.situation;
    }
    if (parsed.data.description !== undefined) {
      update.description = parsed.data.description;
    }
    if (parsed.data.category !== undefined) {
      update.category = parsed.data.category;
    }
    if (parsed.data.isActive !== undefined) {
      update.is_active = parsed.data.isActive;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("outreach_playbooks")
      .update(update)
      .eq("id", idParsed.data)
      .select("id")
      .maybeSingle();
    if (error) {
      res.status(500).json({ error: "update_failed", message: error.message });
      return;
    }
    if (!data) {
      res.status(404).json({ error: "playbook_not_found" });
      return;
    }
    await logAudit({
      action: "outreach_playbook.update",
      adminUserId: req.adminUserId ?? null,
      adminEmail: req.adminEmail ?? null,
      targetTable: "outreach_playbooks",
      targetId: idParsed.data,
      metadata: { fields_changed: Object.keys(update) },
    });
    res.json({ id: idParsed.data });
  },
);

router.put(
  "/admin/outreach-playbooks/:id/steps",
  requirePermission("admin.tools.manage"),
  playbookMutationLimiter,
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params.id);
    if (!idParsed.success) {
      res.status(400).json({ error: "invalid_playbook_id" });
      return;
    }
    const parsed = putStepsSchema.safeParse(req.body);
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
    const steps = toStepShapes(parsed.data.steps);
    const problems = validateSteps(steps);
    if (problems.length > 0) {
      res.status(400).json({ error: "invalid_steps", problems });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: playbook, error: pbErr } = await supabase
      .schema("resupply")
      .from("outreach_playbooks")
      .select("id")
      .eq("id", idParsed.data)
      .maybeSingle();
    if (pbErr) {
      res.status(500).json({ error: "query_failed", message: pbErr.message });
      return;
    }
    if (!playbook) {
      res.status(404).json({ error: "playbook_not_found" });
      return;
    }

    // Replace wholesale. Active runs keep their step POINTER (index);
    // a run whose pointer now exceeds the new step count completes on
    // its next dispatcher tick. Already-scheduled next_step_at values
    // are unchanged — edits affect future steps' wording, not the
    // in-flight schedule.
    //
    // PostgREST has no multi-statement transaction, so delete + insert
    // can't be atomic; snapshot the prior rows first and best-effort
    // restore them if the insert fails, so a transient error can't
    // leave the playbook with an empty cadence.
    const { data: priorSteps, error: priorErr } = await supabase
      .schema("resupply")
      .from("outreach_playbook_steps")
      .select("step_index, day_offset, channel, subject, body")
      .eq("playbook_id", idParsed.data);
    if (priorErr) {
      res
        .status(500)
        .json({ error: "query_failed", message: priorErr.message });
      return;
    }
    const { error: delErr } = await supabase
      .schema("resupply")
      .from("outreach_playbook_steps")
      .delete()
      .eq("playbook_id", idParsed.data);
    if (delErr) {
      res.status(500).json({ error: "update_failed", message: delErr.message });
      return;
    }
    const { error: insErr } = await supabase
      .schema("resupply")
      .from("outreach_playbook_steps")
      .insert(
        steps.map((s) => ({
          playbook_id: idParsed.data,
          step_index: s.stepIndex,
          day_offset: s.dayOffset,
          channel: s.channel,
          subject: s.subject,
          body: s.body,
        })),
      );
    if (insErr) {
      const { error: restoreErr } = await supabase
        .schema("resupply")
        .from("outreach_playbook_steps")
        .insert(
          ((priorSteps ?? []) as Array<Record<string, unknown>>).map((s) => ({
            ...s,
            playbook_id: idParsed.data,
          })),
        );
      if (restoreErr) {
        logger.error(
          { err: restoreErr.message, playbookId: idParsed.data },
          "outreach-playbooks: step replace failed AND prior steps could not be restored — playbook left with no cadence",
        );
      }
      res.status(500).json({ error: "update_failed", message: insErr.message });
      return;
    }
    const { error: touchErr } = await supabase
      .schema("resupply")
      .from("outreach_playbooks")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", idParsed.data);
    if (touchErr) {
      logger.warn(
        { err: touchErr.message, playbookId: idParsed.data },
        "outreach-playbooks: updated_at stamp failed after step replace",
      );
    }

    await logAudit({
      action: "outreach_playbook.steps_replace",
      adminUserId: req.adminUserId ?? null,
      adminEmail: req.adminEmail ?? null,
      targetTable: "outreach_playbooks",
      targetId: idParsed.data,
      metadata: {
        step_count: steps.length,
        channels: steps.map((s) => s.channel),
      },
    });
    res.json({ id: idParsed.data, stepCount: steps.length });
  },
);

// ---------------------------------------------------------------
// Runs
// ---------------------------------------------------------------

router.post(
  "/admin/outreach-playbooks/:id/start",
  requirePermission("conversations.manage"),
  playbookMutationLimiter,
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params.id);
    if (!idParsed.success) {
      res.status(400).json({ error: "invalid_playbook_id" });
      return;
    }
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();

    const [playbookRes, stepsRes, patientRes] = await Promise.all([
      supabase
        .schema("resupply")
        .from("outreach_playbooks")
        .select("id, name, is_active")
        .eq("id", idParsed.data)
        .maybeSingle(),
      supabase
        .schema("resupply")
        .from("outreach_playbook_steps")
        .select("step_index, day_offset, channel")
        .eq("playbook_id", idParsed.data)
        .order("step_index", { ascending: true }),
      supabase
        .schema("resupply")
        .from("patients")
        .select("id, status")
        .eq("id", parsed.data.patientId)
        .maybeSingle(),
    ]);
    if (playbookRes.error || stepsRes.error || patientRes.error) {
      const message = (playbookRes.error ?? stepsRes.error ?? patientRes.error)
        ?.message;
      res.status(500).json({ error: "query_failed", message });
      return;
    }
    const playbook = playbookRes.data as {
      id: string;
      is_active: boolean;
    } | null;
    if (!playbook) {
      res.status(404).json({ error: "playbook_not_found" });
      return;
    }
    if (!playbook.is_active) {
      res.status(409).json({ error: "playbook_inactive" });
      return;
    }
    const steps = (stepsRes.data ?? []) as Array<{
      step_index: number;
      day_offset: number;
      channel: string;
    }>;
    if (steps.length === 0) {
      res.status(409).json({ error: "playbook_has_no_steps" });
      return;
    }
    const patient = patientRes.data as { status: string } | null;
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    if (patient.status !== "active") {
      res.status(409).json({
        error: "patient_not_active",
        message: `Patient status is "${patient.status}"; playbooks can only be started for active patients.`,
      });
      return;
    }

    const startedAt = new Date();
    const { data: run, error: runErr } = await supabase
      .schema("resupply")
      .from("outreach_playbook_runs")
      .insert({
        playbook_id: idParsed.data,
        patient_id: parsed.data.patientId,
        status: "active",
        next_step_index: 1,
        next_step_at: stepDueAt(startedAt, steps[0]!.day_offset).toISOString(),
        started_by_user_id: req.adminUserId ?? null,
        started_by_email: req.adminEmail ?? null,
        started_at: startedAt.toISOString(),
      })
      .select("id")
      .maybeSingle();
    if (runErr) {
      // Partial unique index: one live run per (playbook, patient).
      if ((runErr as { code?: string }).code === "23505") {
        res.status(409).json({
          error: "run_already_active",
          message: "This playbook is already running for this patient.",
        });
        return;
      }
      res.status(500).json({ error: "start_failed", message: runErr.message });
      return;
    }
    if (!run) {
      res.status(500).json({ error: "start_failed" });
      return;
    }

    await logAudit({
      action: "outreach_playbook.run_started",
      adminUserId: req.adminUserId ?? null,
      adminEmail: req.adminEmail ?? null,
      targetTable: "outreach_playbook_runs",
      targetId: (run as { id: string }).id,
      metadata: {
        playbook_id: idParsed.data,
        patient_id: parsed.data.patientId,
        step_count: steps.length,
      },
    });

    res.status(201).json({
      runId: (run as { id: string }).id,
      schedule: steps.map((s) => ({
        stepIndex: s.step_index,
        channel: s.channel,
        dueAt: stepDueAt(startedAt, s.day_offset).toISOString(),
      })),
    });
  },
);

const runsQuerySchema = z
  .object({
    status: z.enum(["active", "completed", "cancelled"]).optional(),
  })
  .partial();

router.get(
  "/admin/outreach-playbooks/runs",
  adminReadRateLimiter,
  requirePermission("conversations.manage"),
  async (req, res) => {
    const queryParsed = runsQuerySchema.safeParse(req.query);
    const status = queryParsed.success
      ? (queryParsed.data.status ?? "active")
      : "active";
    const supabase = getSupabaseServiceRoleClient();
    const { data: runs, error } = await supabase
      .schema("resupply")
      .from("outreach_playbook_runs")
      .select(
        "id, playbook_id, patient_id, status, next_step_index, next_step_at, started_by_email, started_at, completed_at, cancelled_at",
      )
      .eq("status", status)
      .order("started_at", { ascending: false })
      .limit(200);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    const runRows = (runs ?? []) as Array<{
      id: string;
      playbook_id: string;
      patient_id: string;
      status: string;
      next_step_index: number;
      next_step_at: string | null;
      started_by_email: string | null;
      started_at: string;
      completed_at: string | null;
      cancelled_at: string | null;
    }>;

    const playbookIds = [...new Set(runRows.map((r) => r.playbook_id))];
    const patientIds = [...new Set(runRows.map((r) => r.patient_id))];
    const [playbooksRes, patientsRes] = await Promise.all([
      playbookIds.length > 0
        ? supabase
            .schema("resupply")
            .from("outreach_playbooks")
            .select("id, name")
            .in("id", playbookIds)
        : Promise.resolve({ data: [], error: null }),
      patientIds.length > 0
        ? supabase
            .schema("resupply")
            .from("patients")
            .select("id, legal_first_name, legal_last_name")
            .in("id", patientIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (playbooksRes.error || patientsRes.error) {
      const message = (playbooksRes.error ?? patientsRes.error)?.message;
      res.status(500).json({ error: "query_failed", message });
      return;
    }
    const playbookNames = new Map(
      ((playbooksRes.data ?? []) as Array<{ id: string; name: string }>).map(
        (p) => [p.id, p.name],
      ),
    );
    const patientNames = new Map(
      (
        (patientsRes.data ?? []) as Array<{
          id: string;
          legal_first_name: string | null;
          legal_last_name: string | null;
        }>
      ).map((p) => [
        p.id,
        [p.legal_first_name, p.legal_last_name].filter(Boolean).join(" ") ||
          "Unknown patient",
      ]),
    );

    res.json({
      runs: runRows.map((r) => ({
        id: r.id,
        playbookId: r.playbook_id,
        playbookName: playbookNames.get(r.playbook_id) ?? "Deleted playbook",
        patientId: r.patient_id,
        patientName: patientNames.get(r.patient_id) ?? "Unknown patient",
        status: r.status,
        nextStepIndex: r.next_step_index,
        nextStepAt: r.next_step_at,
        startedByEmail: r.started_by_email,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        cancelledAt: r.cancelled_at,
      })),
    });
  },
);

router.post(
  "/admin/outreach-playbooks/runs/:id/cancel",
  requirePermission("conversations.manage"),
  playbookMutationLimiter,
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params.id);
    if (!idParsed.success) {
      res.status(400).json({ error: "invalid_run_id" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .schema("resupply")
      .from("outreach_playbook_runs")
      .update({ status: "cancelled", cancelled_at: nowIso, updated_at: nowIso })
      .eq("id", idParsed.data)
      .eq("status", "active")
      .select("id");
    if (error) {
      res.status(500).json({ error: "cancel_failed", message: error.message });
      return;
    }
    if (!data || data.length === 0) {
      res.status(409).json({
        error: "run_not_active",
        message: "Run not found or already finished.",
      });
      return;
    }

    // Pull the run's still-open call tasks out of the staff queue.
    const { error: taskErr } = await supabase
      .schema("resupply")
      .from("outreach_playbook_step_log")
      .update({ status: "skipped", detail: "run_cancelled" })
      .eq("run_id", idParsed.data)
      .eq("status", "call_due");
    if (taskErr) {
      logger.warn(
        { err: taskErr.message, runId: idParsed.data },
        "outreach-playbooks: cancel could not skip open call tasks",
      );
    }

    await logAudit({
      action: "outreach_playbook.run_cancelled",
      adminUserId: req.adminUserId ?? null,
      adminEmail: req.adminEmail ?? null,
      targetTable: "outreach_playbook_runs",
      targetId: idParsed.data,
      metadata: {},
    });
    res.json({ id: idParsed.data, status: "cancelled" });
  },
);

// ---------------------------------------------------------------
// Call queue — due call touches with the rendered staff script.
// ---------------------------------------------------------------

router.get(
  "/admin/outreach-playbooks/call-queue",
  adminReadRateLimiter,
  requirePermission("conversations.manage"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data: tasks, error } = await supabase
      .schema("resupply")
      .from("outreach_playbook_step_log")
      .select("id, run_id, step_index, call_script, created_at")
      .eq("status", "call_due")
      .order("created_at", { ascending: true })
      .limit(200);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    const taskRows = (tasks ?? []) as Array<{
      id: string;
      run_id: string;
      step_index: number;
      call_script: string | null;
      created_at: string;
    }>;
    const runIds = [...new Set(taskRows.map((t) => t.run_id))];
    const { data: runs, error: runsErr } =
      runIds.length > 0
        ? await supabase
            .schema("resupply")
            .from("outreach_playbook_runs")
            .select("id, playbook_id, patient_id")
            .in("id", runIds)
        : { data: [], error: null };
    if (runsErr) {
      res.status(500).json({ error: "query_failed", message: runsErr.message });
      return;
    }
    const runRows = (runs ?? []) as Array<{
      id: string;
      playbook_id: string;
      patient_id: string;
    }>;
    const runById = new Map(runRows.map((r) => [r.id, r]));
    const playbookIds = [...new Set(runRows.map((r) => r.playbook_id))];
    const patientIds = [...new Set(runRows.map((r) => r.patient_id))];
    const [playbooksRes, patientsRes] = await Promise.all([
      playbookIds.length > 0
        ? supabase
            .schema("resupply")
            .from("outreach_playbooks")
            .select("id, name")
            .in("id", playbookIds)
        : Promise.resolve({ data: [], error: null }),
      patientIds.length > 0
        ? supabase
            .schema("resupply")
            .from("patients")
            .select("id, legal_first_name, legal_last_name, phone_e164")
            .in("id", patientIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (playbooksRes.error || patientsRes.error) {
      const message = (playbooksRes.error ?? patientsRes.error)?.message;
      res.status(500).json({ error: "query_failed", message });
      return;
    }
    const playbookNames = new Map(
      ((playbooksRes.data ?? []) as Array<{ id: string; name: string }>).map(
        (p) => [p.id, p.name],
      ),
    );
    const patientById = new Map(
      (
        (patientsRes.data ?? []) as Array<{
          id: string;
          legal_first_name: string | null;
          legal_last_name: string | null;
          phone_e164: string | null;
        }>
      ).map((p) => [p.id, p]),
    );

    res.json({
      tasks: taskRows.map((t) => {
        const run = runById.get(t.run_id);
        const patient = run ? patientById.get(run.patient_id) : undefined;
        return {
          id: t.id,
          runId: t.run_id,
          stepIndex: t.step_index,
          // Phone numbers stay server-side (same posture as the
          // patient list) — the UI dials via click-to-dial.
          hasPhone: Boolean(patient?.phone_e164),
          patientId: run?.patient_id ?? null,
          patientName: patient
            ? [patient.legal_first_name, patient.legal_last_name]
                .filter(Boolean)
                .join(" ") || "Unknown patient"
            : "Unknown patient",
          playbookName: run
            ? (playbookNames.get(run.playbook_id) ?? "Deleted playbook")
            : "Deleted playbook",
          callScript: t.call_script,
          dueSince: t.created_at,
        };
      }),
    });
  },
);

router.post(
  "/admin/outreach-playbooks/call-tasks/:id/complete",
  requirePermission("conversations.manage"),
  playbookMutationLimiter,
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params.id);
    if (!idParsed.success) {
      res.status(400).json({ error: "invalid_task_id" });
      return;
    }
    const parsed = completeCallSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("outreach_playbook_step_log")
      .update({
        status: "call_completed",
        call_outcome: parsed.data.outcome,
        completed_by_email: req.adminEmail ?? null,
        completed_at: new Date().toISOString(),
      })
      .eq("id", idParsed.data)
      .eq("status", "call_due")
      .select("id");
    if (error) {
      res
        .status(500)
        .json({ error: "complete_failed", message: error.message });
      return;
    }
    if (!data || data.length === 0) {
      res.status(409).json({
        error: "task_not_open",
        message: "Call task not found or already completed.",
      });
      return;
    }
    await logAudit({
      action: "outreach_playbook.call_completed",
      adminUserId: req.adminUserId ?? null,
      adminEmail: req.adminEmail ?? null,
      targetTable: "outreach_playbook_step_log",
      targetId: idParsed.data,
      metadata: { outcome: parsed.data.outcome },
    });
    res.json({ id: idParsed.data, status: "call_completed" });
  },
);

export default router;
