// /admin/company-calendar — shared, staff-wide appointment calendar.
//
//   GET    /admin/company-calendar?from=&to=  — events overlapping the
//                                               [from, to) window (both
//                                               ISO-8601). Defaults to a
//                                               ±45-day window around now.
//   POST   /admin/company-calendar            — create an appointment
//   PATCH  /admin/company-calendar/:id        — edit an appointment
//   DELETE /admin/company-calendar/:id        — remove an appointment
//
// requireAdmin gates everything: every signed-in staff member (admin or
// agent) can both VIEW and EDIT the shared calendar — it is a company-wide
// schedule, not a per-user one. Distinct from /admin/appointment-requests
// (the inbound, patient-initiated triage queue).

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

type CalendarUpdate =
  Database["resupply"]["Tables"]["company_calendar_events"]["Update"];

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

// Allowed appointment kinds. Kept in lock-step with the DB CHECK
// constraint in 0242_company_calendar_events.sql — widen both together.
const EVENT_TYPES = [
  "fitting_virtual",
  "fitting_in_person",
  "setup_virtual",
  "setup_in_person",
  "follow_up",
  "consultation",
  "other",
] as const;

// Lifecycle of an appointment. Kept in lock-step with the DB CHECK
// constraint in 0242_company_calendar_events.sql.
const EVENT_STATUSES = [
  "scheduled",
  "completed",
  "canceled",
  "no_show",
] as const;

const createBody = z
  .object({
    patientId: z.string().uuid(),
    eventType: z.enum(EVENT_TYPES),
    status: z.enum(EVENT_STATUSES).optional(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    location: z.string().trim().max(300).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((b) => new Date(b.endsAt) >= new Date(b.startsAt), {
    message: "endsAt must be at or after startsAt",
  });

const patchBody = z
  .object({
    patientId: z.string().uuid().optional(),
    eventType: z.enum(EVENT_TYPES).optional(),
    status: z.enum(EVENT_STATUSES).optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    location: z.string().trim().max(300).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

const listQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

const DAY_MS = 86_400_000;

router.get(
  "/admin/company-calendar",
  requireAdmin,
  adminRateLimit({ name: "company_calendar.list", preset: "query" }),
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const now = Date.now();
    const from = parsed.data.from ?? new Date(now - 45 * DAY_MS).toISOString();
    const to = parsed.data.to ?? new Date(now + 45 * DAY_MS).toISOString();

    const supabase = getSupabaseServiceRoleClient();
    // Events that OVERLAP the [from, to) window: they start before `to`
    // AND end after `from`.
    const { data, error } = await supabase
      .schema("resupply")
      .from("company_calendar_events")
      .select(
        "id, patient_id, event_type, status, starts_at, ends_at, location, notes, created_by_user_id, created_by_email, created_at, updated_at",
      )
      .lt("starts_at", to)
      .gt("ends_at", from)
      .order("starts_at", { ascending: true })
      .limit(1000);
    if (error) throw error;
    const rows = data ?? [];

    // Resolve patient names in a single batched lookup (two-step fetch —
    // the repo standard; we don't embed PostgREST relations). Resolving at
    // read time keeps `patients` the single source of truth, so a rename
    // shows up on the calendar immediately.
    const patientIds = [...new Set(rows.map((r) => r.patient_id))];
    const patientsById = new Map<
      string,
      { firstName: string; lastName: string }
    >();
    if (patientIds.length > 0) {
      const { data: patients, error: pErr } = await supabase
        .schema("resupply")
        .from("patients")
        .select("id, legal_first_name, legal_last_name")
        .in("id", patientIds);
      if (pErr) throw pErr;
      for (const p of patients ?? []) {
        patientsById.set(p.id, {
          firstName: p.legal_first_name,
          lastName: p.legal_last_name,
        });
      }
    }

    res.json({
      events: rows.map((r) => {
        const pt = patientsById.get(r.patient_id);
        return {
          id: r.id,
          patientId: r.patient_id,
          patientFirstName: pt?.firstName ?? null,
          patientLastName: pt?.lastName ?? null,
          eventType: r.event_type,
          status: r.status,
          startsAt: r.starts_at,
          endsAt: r.ends_at,
          location: r.location,
          notes: r.notes,
          createdByUserId: r.created_by_user_id,
          createdByEmail: r.created_by_email,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        };
      }),
    });
  },
);

router.post(
  "/admin/company-calendar",
  requireAdmin,
  adminRateLimit({ name: "company_calendar.create", preset: "mutation" }),
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
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("company_calendar_events")
      .insert({
        patient_id: parsed.data.patientId,
        event_type: parsed.data.eventType,
        status: parsed.data.status ?? "scheduled",
        starts_at: parsed.data.startsAt,
        ends_at: parsed.data.endsAt,
        location: parsed.data.location ?? null,
        notes: parsed.data.notes ?? null,
        created_by_user_id: req.adminUserId ?? null,
        created_by_email: req.adminEmail ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;
    res.status(201).json({ id: row.id });
  },
);

router.patch(
  "/admin/company-calendar/:id",
  requireAdmin,
  adminRateLimit({ name: "company_calendar.update", preset: "mutation" }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();

    // When either end of the time range changes, validate the EFFECTIVE
    // range — the incoming side(s) merged with the stored side — so a
    // single-sided edit can't slip past the create-time guard and trip the
    // DB CHECK as an unhandled 500. The fetch doubles as the existence check.
    if (parsed.data.startsAt != null || parsed.data.endsAt != null) {
      const { data: existing, error: fetchErr } = await supabase
        .schema("resupply")
        .from("company_calendar_events")
        .select("starts_at, ends_at")
        .eq("id", params.data.id)
        .maybeSingle();
      if (fetchErr) throw fetchErr;
      if (!existing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const effStart = new Date(parsed.data.startsAt ?? existing.starts_at);
      const effEnd = new Date(parsed.data.endsAt ?? existing.ends_at);
      if (effEnd < effStart) {
        res.status(400).json({
          error: "invalid_body",
          message: "endsAt must be at or after startsAt",
        });
        return;
      }
    }

    const update: CalendarUpdate = { updated_at: new Date().toISOString() };
    if (parsed.data.patientId != null)
      update.patient_id = parsed.data.patientId;
    if (parsed.data.eventType != null)
      update.event_type = parsed.data.eventType;
    if (parsed.data.status != null) update.status = parsed.data.status;
    if (parsed.data.startsAt != null) update.starts_at = parsed.data.startsAt;
    if (parsed.data.endsAt != null) update.ends_at = parsed.data.endsAt;
    if (parsed.data.location !== undefined)
      update.location = parsed.data.location;
    if (parsed.data.notes !== undefined) update.notes = parsed.data.notes;

    const { data: row, error } = await supabase
      .schema("resupply")
      .from("company_calendar_events")
      .update(update)
      .eq("id", params.data.id)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ ok: true });
  },
);

router.delete(
  "/admin/company-calendar/:id",
  requireAdmin,
  adminRateLimit({ name: "company_calendar.delete", preset: "mutation" }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("company_calendar_events")
      .delete()
      .eq("id", params.data.id);
    if (error) throw error;
    res.json({ ok: true });
  },
);

export default router;
