// /admin/agent-availability — CSR availability toggle (migration 0192 /
// Phase 1, CSR #16).
//
//   GET   /admin/agent-availability       — team availability board
//   PATCH /admin/agent-availability/me     — set your own availability
//
// A rep flips themselves to away / do_not_assign when on a break or
// buried in a complex call; the skill-router (auto-assign) then skips
// them. Self-service: gated on requireAdmin (any staff sets their OWN
// status, keyed on the session's admin id — never another rep's).
// Operational, not PHI; logged structurally, no audit row per toggle.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  adminRateLimit,
  adminReadRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const patchSchema = z
  .object({
    availability: z.enum(["available", "away", "do_not_assign"]),
  })
  .strict();

// The agent's own click-to-dial bridge number (#11). Empty string
// clears it; otherwise E.164.
const phoneSchema = z
  .object({
    phoneE164: z.union([
      z.literal(""),
      z
        .string()
        .regex(/^\+[1-9]\d{6,14}$/, "Must be E.164, e.g. +12155551212."),
    ]),
  })
  .strict();

router.get(
  "/admin/agent-availability",
  // Rate-limit BEFORE the auth gate so an unauthenticated flood is
  // throttled too (CodeQL "missing rate limiting" wants the limiter
  // ahead of the authorization middleware). adminRateLimit keys on
  // req.adminUserId post-auth and falls back to a shared "no-actor"
  // bucket pre-auth.
  adminReadRateLimiter,
  requireAdmin,
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("admin_users")
      .select("id, email_lower, display_name, role, availability")
      .eq("status", "active")
      .order("email_lower", { ascending: true });
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    res.json({
      agents: (data ?? []).map((a) => ({
        adminUserId: a.id,
        email: a.email_lower,
        displayName: a.display_name,
        role: a.role,
        availability: a.availability,
      })),
    });
  },
);

router.get(
  "/admin/agent-availability/me",
  adminRateLimit({ name: "agent_availability.me", preset: "query" }),
  requireAdmin,
  async (req, res) => {
    const userId = req.adminUserId;
    if (!userId) {
      res.status(401).json({ error: "no_user" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("admin_users")
      .select("id, availability, phone_e164")
      .eq("id", userId)
      .maybeSingle();
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    if (!data) {
      res.status(404).json({ error: "admin_not_found" });
      return;
    }
    res.json({
      adminUserId: data.id,
      availability: data.availability,
      // Last 4 only — never echo the full bridge number back to the UI.
      phoneLast4: data.phone_e164 ? String(data.phone_e164).slice(-4) : null,
      hasPhone: Boolean(data.phone_e164),
    });
  },
);

router.put(
  "/admin/agent-availability/me/phone",
  requireAdmin,
  adminRateLimit({ name: "agent_phone.set", preset: "mutation" }),
  async (req, res) => {
    const parsed = phoneSchema.safeParse(req.body);
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
    const userId = req.adminUserId;
    if (!userId) {
      res.status(401).json({ error: "no_user" });
      return;
    }
    const phone = parsed.data.phoneE164 === "" ? null : parsed.data.phoneE164;

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("admin_users")
      .update({ phone_e164: phone, updated_at: new Date().toISOString() })
      .eq("id", userId)
      .select("id, phone_e164")
      .maybeSingle();
    if (error) {
      res.status(500).json({ error: "update_failed", message: error.message });
      return;
    }
    if (!data) {
      res.status(404).json({ error: "admin_not_found" });
      return;
    }
    // Structural log only — never the number.
    req.log?.info(
      { adminUserId: userId, hasPhone: phone !== null },
      "admin.agent_phone.set",
    );
    res.json({
      adminUserId: data.id,
      hasPhone: Boolean(data.phone_e164),
      phoneLast4: data.phone_e164 ? String(data.phone_e164).slice(-4) : null,
    });
  },
);

router.patch(
  "/admin/agent-availability/me",
  requireAdmin,
  adminRateLimit({ name: "agent_availability.set", preset: "mutation" }),
  async (req, res) => {
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
    const userId = req.adminUserId;
    if (!userId) {
      res.status(401).json({ error: "no_user" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("admin_users")
      .update({
        availability: parsed.data.availability,
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId)
      .select("id, availability")
      .maybeSingle();
    if (error) {
      res.status(500).json({ error: "update_failed", message: error.message });
      return;
    }
    if (!data) {
      res.status(404).json({ error: "admin_not_found" });
      return;
    }

    req.log?.info(
      { adminUserId: userId, availability: parsed.data.availability },
      "admin.agent_availability.set",
    );
    res.json({ adminUserId: data.id, availability: data.availability });
  },
);

export default router;
