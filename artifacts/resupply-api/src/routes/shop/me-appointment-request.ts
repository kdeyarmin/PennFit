// /shop/me/appointment-request — patient-facing self-service form.
// Posts into the admin appointment_requests queue; the CSR triages
// from there.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

const body = z
  .object({
    topic: z.string().trim().min(1).max(200),
    preferredWindow: z.string().trim().max(200).optional(),
    notes: z.string().trim().max(2000).optional(),
    phone: z.string().trim().max(32).optional(),
  })
  .strict();

// GET surfaces all of this patient's open/scheduled appointment
// requests so the portal can show "your telehealth visit is at 4pm
// — join here" when a CSR has set meeting_url.
router.get(
  "/shop/me/appointment-request",
  requireSignedIn,
  async (req, res) => {
    const email = req.shopCustomerEmail;
    if (!email) {
      res.json({ requests: [] });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    // Escape LIKE metacharacters before .ilike so an email like
    // `john_doe@x.com` doesn't also match `johnXdoe@x.com` /
    // `johnAdoe@x.com` etc. The match here returns the patient's
    // PHI (meeting_url, scheduled_for, topic) — without the
    // escape a `_` or `%` in the requester's address would
    // surface other patients' appointments.
    const escapedEmail = email.replace(/[\\%_]/g, (c) => `\\${c}`);
    const { data, error } = await supabase
      .schema("resupply")
      .from("appointment_requests")
      .select(
        "id, topic, preferred_window, status, scheduled_for, meeting_url, meeting_provider, created_at",
      )
      .ilike("requester_email", escapedEmail)
      .in("status", ["new", "contacted", "scheduled"])
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw error;
    res.json({
      requests: (data ?? []).map((r) => ({
        id: r.id,
        topic: r.topic,
        preferredWindow: r.preferred_window,
        status: r.status,
        scheduledFor: r.scheduled_for,
        meetingUrl: r.meeting_url,
        meetingProvider: r.meeting_provider,
        createdAt: r.created_at,
      })),
    });
  },
);

router.post(
  "/shop/me/appointment-request",
  requireSignedIn,
  async (req, res) => {
    const parsed = body.safeParse(req.body);
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
    const email = req.shopCustomerEmail;
    if (!email) {
      res.status(401).json({ error: "sign_in_required" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("appointment_requests")
      .insert({
        requester_email: email,
        requester_name: req.shopCustomerDisplayName ?? null,
        requester_phone: parsed.data.phone ?? null,
        topic: parsed.data.topic,
        preferred_window: parsed.data.preferredWindow ?? null,
        notes: parsed.data.notes ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;
    logger.info(
      { event: "shop.me.appointment-request.created", id: row.id },
      "appointment request created",
    );
    res.status(201).json({ id: row.id });
  },
);

export default router;
