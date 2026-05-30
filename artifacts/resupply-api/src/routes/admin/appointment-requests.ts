// /admin/appointment-requests — CSR queue for patient-initiated
// appointment requests.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();
const idParam = z.object({ id: z.string().uuid() });

router.get(
  "/admin/appointment-requests",
  requirePermission("patients.update"),
  async (req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const includeClosed = req.query.include === "closed";
    let query = supabase
      .schema("resupply")
      .from("appointment_requests")
      .select(
        "id, requester_email, requester_name, requester_phone, topic, preferred_window, notes, status, attached_patient_id, assigned_admin_user_id, triaged_at, scheduled_for, meeting_url, meeting_provider, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    if (!includeClosed) {
      query = query.in("status", ["new", "contacted"]);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({
      requests: (data ?? []).map((r) => ({
        id: r.id,
        requesterEmail: r.requester_email,
        requesterName: r.requester_name,
        requesterPhone: r.requester_phone,
        topic: r.topic,
        preferredWindow: r.preferred_window,
        notes: r.notes,
        status: r.status,
        attachedPatientId: r.attached_patient_id,
        assignedAdminUserId: r.assigned_admin_user_id,
        triagedAt: r.triaged_at,
        scheduledFor: r.scheduled_for,
        meetingUrl: r.meeting_url,
        meetingProvider: r.meeting_provider,
        createdAt: r.created_at,
      })),
    });
  },
);

router.patch(
  "/admin/appointment-requests/:id",
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "appointment_requests.update", preset: "mutation" }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = z
      .object({
        status: z
          .enum(["new", "contacted", "scheduled", "declined", "cancelled"])
          .optional(),
        attachedPatientId: z.string().uuid().nullable().optional(),
        assignedAdminUserId: z.string().min(1).max(64).nullable().optional(),
        scheduledFor: z.string().datetime().nullable().optional(),
        notes: z.string().trim().max(2000).nullable().optional(),
        meetingUrl: z.string().trim().url().max(500).nullable().optional(),
        meetingProvider: z.string().trim().max(32).nullable().optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const update: {
      status?: "new" | "contacted" | "scheduled" | "declined" | "cancelled";
      attached_patient_id?: string | null;
      assigned_admin_user_id?: string | null;
      scheduled_for?: string | null;
      notes?: string | null;
      meeting_url?: string | null;
      meeting_provider?: string | null;
      triaged_at?: string;
      updated_at: string;
    } = { updated_at: new Date().toISOString() };
    if (parsed.data.status) {
      update.status = parsed.data.status;
      if (parsed.data.status === "contacted") {
        update.triaged_at = new Date().toISOString();
      }
    }
    if (parsed.data.attachedPatientId !== undefined) {
      // Verify the patient row actually exists before attaching it
      // to a request. The GET endpoint on the patient side returns
      // meeting_url + scheduled_for to the requester_email; a bogus
      // attached_patient_id would otherwise route a real patient's
      // telehealth link to whoever filed the request.
      if (parsed.data.attachedPatientId !== null) {
        const supabaseCheck = getSupabaseServiceRoleClient();
        const { data: patientRow, error: lookupErr } = await supabaseCheck
          .schema("resupply")
          .from("patients")
          .select("id")
          .eq("id", parsed.data.attachedPatientId)
          .limit(1)
          .maybeSingle();
        if (lookupErr) throw lookupErr;
        if (!patientRow) {
          res.status(404).json({ error: "patient_not_found" });
          return;
        }
      }
      update.attached_patient_id = parsed.data.attachedPatientId;
    }
    if (parsed.data.assignedAdminUserId !== undefined) {
      update.assigned_admin_user_id = parsed.data.assignedAdminUserId;
    }
    if (parsed.data.scheduledFor !== undefined) {
      update.scheduled_for = parsed.data.scheduledFor;
    }
    if (parsed.data.notes !== undefined) {
      update.notes = parsed.data.notes;
    }
    if (parsed.data.meetingUrl !== undefined) {
      update.meeting_url = parsed.data.meetingUrl;
    }
    if (parsed.data.meetingProvider !== undefined) {
      update.meeting_provider = parsed.data.meetingProvider;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("appointment_requests")
      .update(update)
      .eq("id", params.data.id);
    if (error) throw error;
    res.json({ ok: true });
  },
);

export default router;
