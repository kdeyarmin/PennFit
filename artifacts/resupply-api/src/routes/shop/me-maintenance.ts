// /shop/me/maintenance — patient-facing hygiene checklist.
//
//   GET  /shop/me/maintenance              — catalog + per-task
//                                             last-completed + next-due
//   POST /shop/me/maintenance/:taskKey/log — patient checks off a task
//
// Identity bridge — same email-match strategy as
// /shop/me/therapy-summary: the shop customer is resolved to a
// single patient row by case-insensitive email, refusing to merge
// when multiple matches exist. See that route's preamble for the
// HIPAA rationale.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  MAINTENANCE_CATALOG,
  MAINTENANCE_TASK_KEYS,
  bucketizeMaintenance,
  findMaintenanceTask,
} from "../../lib/patient-maintenance/catalog";
import { logger } from "../../lib/logger";
import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

const logParams = z.object({
  taskKey: z.enum(MAINTENANCE_TASK_KEYS as [string, ...string[]]),
});

async function resolveSinglePatientByEmail(
  customerEmail: string,
): Promise<string | null> {
  const supabase = getSupabaseServiceRoleClient();
  const escaped = customerEmail.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id")
    .ilike("email", escaped)
    .limit(2);
  if (error) throw error;
  if (!rows || rows.length !== 1) return null;
  return rows[0]!.id;
}

router.get("/shop/me/maintenance", requireSignedIn, async (req, res) => {
  const customerEmail = req.shopCustomerEmail;
  if (!customerEmail) {
    res.json(emptyResponse({ patientLinked: false }));
    return;
  }
  const patientId = await resolveSinglePatientByEmail(customerEmail);
  if (!patientId) {
    res.json(emptyResponse({ patientLinked: false }));
    return;
  }

  // Pull the most-recent completion per task. PostgREST doesn't
  // do GROUP BY MAX cleanly, so we fetch all rows for the patient
  // and reduce in memory. The data is small (5 tasks × N
  // completions; even a daily wipe over a year is 365 rows).
  const supabase = getSupabaseServiceRoleClient();
  const { data: log, error } = await supabase
    .schema("resupply")
    .from("patient_maintenance_log")
    .select("task_key, completed_at")
    .eq("patient_id", patientId)
    .order("completed_at", { ascending: false });
  if (error) throw error;

  const latest = new Map<string, string>();
  for (const row of log ?? []) {
    if (!latest.has(row.task_key)) {
      latest.set(row.task_key, row.completed_at);
    }
  }

  const asOfDate = new Date();
  const tasks = MAINTENANCE_CATALOG.map((task) => {
    const lastCompletedAt = latest.get(task.key) ?? null;
    const bucketInfo = bucketizeMaintenance({
      lastCompletedAt,
      frequencyDays: task.frequencyDays,
      asOfDate,
    });
    return {
      key: task.key,
      label: task.label,
      category: task.category,
      frequencyDays: task.frequencyDays,
      why: task.why,
      lastCompletedAt,
      ...bucketInfo,
    };
  });

  res.json({
    patientLinked: true,
    asOfDate: asOfDate.toISOString().slice(0, 10),
    tasks,
  });
});

router.post(
  "/shop/me/maintenance/:taskKey/log",
  requireSignedIn,
  async (req, res) => {
    const parsed = logParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "unknown_task" });
      return;
    }
    const customerEmail = req.shopCustomerEmail;
    if (!customerEmail) {
      res.status(403).json({ error: "patient_not_linked" });
      return;
    }
    const patientId = await resolveSinglePatientByEmail(customerEmail);
    if (!patientId) {
      res.status(403).json({ error: "patient_not_linked" });
      return;
    }
    const task = findMaintenanceTask(parsed.data.taskKey);
    if (!task) {
      // Defensive — zod already enforced the enum.
      res.status(404).json({ error: "unknown_task" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("patient_maintenance_log")
      .insert({
        patient_id: patientId,
        task_key: task.key,
        source: "patient_portal",
      })
      .select("id, completed_at")
      .single();
    if (error) throw error;

    logger.info(
      {
        event: "shop.me.maintenance.logged",
        taskKey: task.key,
        patientId,
      },
      "patient maintenance task logged",
    );

    res.status(201).json({
      id: row.id,
      taskKey: task.key,
      completedAt: row.completed_at,
    });
  },
);

function emptyResponse(opts: { patientLinked: boolean }): {
  patientLinked: boolean;
  asOfDate: string;
  tasks: [];
} {
  return {
    patientLinked: opts.patientLinked,
    asOfDate: new Date().toISOString().slice(0, 10),
    tasks: [],
  };
}

export default router;
