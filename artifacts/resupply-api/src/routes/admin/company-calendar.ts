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
// schedule, not a per-user one.
//
// Assignment: an appointment can be assigned to another staff member
// (`assigned_to_user_id` / `assigned_to_email`, distinct from the created_by
// actor). On a new assignment the assignee gets a PHI-light email and the
// event surfaces on their /admin/today worklist. The email send is
// fire-and-forget — a SendGrid hiccup never fails the calendar write.

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { getAuthDeps } from "../../lib/auth-deps";
import { sendAppointmentAssignedEmail } from "../../lib/calendar/appointment-assigned-email";
import {
  type AssignableStaff,
  listAssignableStaff,
  resolveAssignableStaff,
} from "../../lib/calendar/assignable-staff";
import { logger } from "../../lib/logger";
import {
  adminRateLimit,
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
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
    // The auth-user id (resupply_auth.users.id) of the staff member this
    // appointment is assigned to. Validated against the active staff roster
    // server-side; never trust a client-supplied email.
    assignedToUserId: z.string().uuid().nullable().optional(),
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
    assignedToUserId: z.string().uuid().nullable().optional(),
  })
  .strict();

const listQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

const DAY_MS = 86_400_000;

/** Absolute URL to the company calendar for the notification email. */
function calendarDashboardUrl(): string {
  return `${getAuthDeps().publicBaseUrl}/admin/company-calendar`;
}

/** Fire-and-forget the assignment email; never throws into the request. */
function fireAssignmentEmail(args: {
  assignee: AssignableStaff;
  startsAt: string;
  endsAt: string;
  eventType: string;
  location: string | null;
  assignedByEmail: string | null;
}): void {
  void sendAppointmentAssignedEmail({
    toEmail: args.assignee.email,
    assigneeName: args.assignee.displayName,
    startsAt: args.startsAt,
    endsAt: args.endsAt,
    eventType: args.eventType,
    location: args.location,
    assignedByEmail: args.assignedByEmail,
    dashboardUrl: calendarDashboardUrl(),
  })
    .then((r) => {
      if (!r.delivered) {
        // Metadata only — no patient data, no recipient address in the log.
        logger.warn(
          {
            event: "appointment_assigned_email_undelivered",
            configured: r.configured,
            // Plain string detail (not an Error object) — keep it off the
            // pino `err` key so it can't masquerade past err-path redaction.
            reason: r.error,
          },
          "appointment-assigned email not delivered",
        );
      }
    })
    .catch((err) => {
      logger.warn(
        { event: "appointment_assigned_email_threw", err },
        "appointment-assigned email threw",
      );
    });
}

router.get(
  "/admin/company-calendar",
  adminReadRateLimiter,
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
        "id, patient_id, event_type, status, starts_at, ends_at, location, notes, created_by_user_id, created_by_email, assigned_to_user_id, assigned_to_email, created_at, updated_at",
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
          assignedToUserId: r.assigned_to_user_id,
          assignedToEmail: r.assigned_to_email,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        };
      }),
    });
  },
);

// GET /admin/company-calendar/assignable-staff — the staff members an
// appointment can be assigned to (effectively-active roster). Gated by
// requireAdmin (same as the rest of the calendar) so AGENTS — who can edit the
// calendar but are blocked from the admin-only /admin/team — can still
// populate the assignee picker. Returns minimal directory fields only.
//
// Uses the direct express-rate-limit instance (adminReadRateLimiter) BEFORE
// the auth gate: CodeQL's js/missing-rate-limiting query only recognises the
// upstream middleware at the call site, not the adminRateLimit() wrapper, and
// the limiter must precede requireAdmin's DB session lookup.
router.get(
  "/admin/company-calendar/assignable-staff",
  adminReadRateLimiter,
  requireAdmin,
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const staff = await listAssignableStaff(supabase);
    res.json({ staff });
  },
);

router.post(
  "/admin/company-calendar",
  adminWriteRateLimiter,
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

    // Validate the assignee (if any) against the effectively-active roster
    // before the insert, so an unknown id is a clean 400 rather than a
    // dangling column.
    let assignee: AssignableStaff | null = null;
    if (parsed.data.assignedToUserId) {
      assignee = await resolveAssignableStaff(
        supabase,
        parsed.data.assignedToUserId,
      );
      if (!assignee) {
        res.status(400).json({ error: "invalid_assignee" });
        return;
      }
    }

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
        assigned_to_user_id: assignee?.userId ?? null,
        assigned_to_email: assignee?.email ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;

    // Notify the assignee — but not when someone assigns an appointment to
    // themselves (no point emailing your own action).
    if (assignee && assignee.userId !== req.adminUserId) {
      fireAssignmentEmail({
        assignee,
        startsAt: parsed.data.startsAt,
        endsAt: parsed.data.endsAt,
        eventType: parsed.data.eventType,
        location: parsed.data.location ?? null,
        assignedByEmail: req.adminEmail ?? null,
      });
    }

    res.status(201).json({ id: row.id });
  },
);

router.patch(
  "/admin/company-calendar/:id",
  adminWriteRateLimiter,
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

    // Fetch the existing row when we need its prior state: to validate the
    // EFFECTIVE time range on a single-sided edit, and/or to detect whether
    // an assignment is actually NEW (so we don't re-email on an unrelated
    // edit). The fetch doubles as the existence check.
    const needsExisting =
      parsed.data.startsAt != null ||
      parsed.data.endsAt != null ||
      parsed.data.assignedToUserId !== undefined;
    let existing: {
      event_type: string;
      starts_at: string;
      ends_at: string;
      location: string | null;
      assigned_to_user_id: string | null;
    } | null = null;
    if (needsExisting) {
      const { data, error: fetchErr } = await supabase
        .schema("resupply")
        .from("company_calendar_events")
        .select("event_type, starts_at, ends_at, location, assigned_to_user_id")
        .eq("id", params.data.id)
        .maybeSingle();
      if (fetchErr) throw fetchErr;
      if (!data) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      existing = data;
    }

    // Validate the effective time range (incoming side(s) merged with the
    // stored side) so a single-sided edit can't trip the DB CHECK as a 500.
    if (
      (parsed.data.startsAt != null || parsed.data.endsAt != null) &&
      existing
    ) {
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

    // Assignment changes. null clears it (no email); a new non-null assignee
    // is validated, stored, and (if it actually changed and isn't a
    // self-assign) emailed after the write succeeds.
    let emailPlan: {
      assignee: AssignableStaff;
      eventType: string;
      startsAt: string;
      endsAt: string;
      location: string | null;
    } | null = null;
    if (parsed.data.assignedToUserId !== undefined && existing) {
      if (parsed.data.assignedToUserId === null) {
        update.assigned_to_user_id = null;
        update.assigned_to_email = null;
      } else if (
        parsed.data.assignedToUserId === existing.assigned_to_user_id
      ) {
        // Unchanged — skip re-validation (tolerates an assignee who has since
        // left the active roster) and don't re-email.
      } else {
        const assignee = await resolveAssignableStaff(
          supabase,
          parsed.data.assignedToUserId,
        );
        if (!assignee) {
          res.status(400).json({ error: "invalid_assignee" });
          return;
        }
        update.assigned_to_user_id = assignee.userId;
        update.assigned_to_email = assignee.email;
        // Email only on a genuine new assignee, and not a self-assign.
        if (assignee.userId !== req.adminUserId) {
          emailPlan = {
            assignee,
            eventType: parsed.data.eventType ?? existing.event_type,
            startsAt: parsed.data.startsAt ?? existing.starts_at,
            endsAt: parsed.data.endsAt ?? existing.ends_at,
            location:
              parsed.data.location !== undefined
                ? parsed.data.location
                : existing.location,
          };
        }
      }
    }

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

    if (emailPlan) {
      fireAssignmentEmail({
        assignee: emailPlan.assignee,
        startsAt: emailPlan.startsAt,
        endsAt: emailPlan.endsAt,
        eventType: emailPlan.eventType,
        location: emailPlan.location,
        assignedByEmail: req.adminEmail ?? null,
      });
    }

    res.json({ ok: true });
  },
);

router.delete(
  "/admin/company-calendar/:id",
  adminWriteRateLimiter,
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
