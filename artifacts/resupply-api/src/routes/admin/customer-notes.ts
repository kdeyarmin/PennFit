// /admin/shop/customers/:userId/notes — internal CSR-authored
// notes attached to a shop customer.
//
//   GET  /admin/shop/customers/:userId/notes  — list (newest first)
//   POST /admin/shop/customers/:userId/notes  — append
//
// Mirrors `routes/patients/notes-{list,create}.ts` for the shop side.
// See `lib/resupply-db/src/schema/shop-customer-notes.ts` for the
// table policy (append-only, no PATCH/DELETE in v1, internal-only).
//
// Why a separate route family from /admin/shop/customers/:userId
// (the customer-360 detail endpoint): notes are their own write
// surface with their own audit verb (`shop_customer.note.create`)
// and their own load cadence (the dashboard renders them in a
// dedicated panel, not tucked inside the heavy customer detail
// fetch). Splitting keeps each surface narrow.
//
// PHI / log posture (mirrors patient notes): the note body is
// stored as plaintext text and may contain whatever the CSR wrote.
// The audit row records the customer_id + body_length only — never
// the body itself.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// `userId` is the shop_customers.customer_id (sourced from
// auth.users.id). Same regex as the existing customer detail route
// (`routes/admin/customers.ts:userIdParam`) — opaque, alphanumeric
// + `_` + `-`.
const userIdParam = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);

const bodySchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1, "Note body cannot be empty.")
      .max(4000, "Note body must be 4000 characters or fewer."),
  })
  .strict();

router.get(
  "/admin/shop/customers/:userId/notes",
  // CSR-authored notes — read tier under `conversations.manage`
  // (admin / supervisor / csr / agent). The catalog has no narrower
  // `notes.read` scope; using the broader operational perm keeps the
  // access matrix coherent with /admin/shop/customers/:userId itself.
  requirePermission("conversations.manage"),
  async (req, res) => {
    const parsed = userIdParam.safeParse(req.params.userId);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }
    const userId = parsed.data;
    const supabase = getSupabaseServiceRoleClient();

    const { data: customer } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .select("customer_id")
      .eq("customer_id", userId)
      .limit(1)
      .maybeSingle();
    if (!customer) {
      res.status(404).json({ error: "customer_not_found" });
      return;
    }

    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("shop_customer_notes")
      .select("id, body, author_email, author_user_id, created_at")
      .eq("customer_id", userId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }

    await logAudit({
      action: "shop_customer.notes.list",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_customer_notes",
      targetId: userId,
      metadata: { customer_id: userId, count: rows?.length ?? 0 },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "shop_customer.notes.list audit write failed");
    });

    res.json({
      notes: (rows ?? []).map((r) => ({
        id: r.id,
        body: r.body ?? "",
        authorEmail: r.author_email,
        authorUserId: r.author_user_id,
        createdAt: r.created_at,
      })),
    });
  },
);

router.post(
  "/admin/shop/customers/:userId/notes",
  // Append-only CSR note. Same scope as the read above —
  // `conversations.manage` is the operational tier that authors
  // these notes.
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "shop_customer_notes.create", preset: "mutation" }),
  async (req, res) => {
    const idCheck = userIdParam.safeParse(req.params.userId);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }
    const userId = idCheck.data;

    const bodyParsed = bodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyParsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const { body } = bodyParsed.data;

    const supabase = getSupabaseServiceRoleClient();

    const { data: customer } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .select("customer_id")
      .eq("customer_id", userId)
      .limit(1)
      .maybeSingle();
    if (!customer) {
      res.status(404).json({ error: "customer_not_found" });
      return;
    }

    const { data: inserted, error: insErr } = await supabase
      .schema("resupply")
      .from("shop_customer_notes")
      .insert({
        customer_id: userId,
        body,
        author_email: req.adminEmail ?? "<unknown>",
        author_user_id: req.adminUserId ?? null,
      })
      .select("id, created_at")
      .single();
    if (insErr) throw insErr;

    // Structural metadata only — `body_length` lets reviewers spot
    // suspiciously long pastes (paste-attack from a clipboard,
    // accidental dump of an email body) without exposing contents.
    await logAudit({
      action: "shop_customer.note.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_customer_notes",
      targetId: inserted.id,
      metadata: { customer_id: userId, body_length: body.length },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "shop_customer.note.create audit write failed");
    });

    res.status(201).json({
      id: inserted.id,
      createdAt: inserted.created_at,
    });
  },
);

export default router;
