// /admin/webhook-subscriptions — outbound event subscribers CRUD.
//
//   GET   /admin/webhook-subscriptions
//   POST  /admin/webhook-subscriptions               admin-only
//   PATCH /admin/webhook-subscriptions/:id           admin-only
//   DELETE /admin/webhook-subscriptions/:id          admin-only
//   GET   /admin/webhook-deliveries?subscriptionId=  recent attempts

import { randomBytes } from "node:crypto";

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { assertSafeOutboundUrlSync } from "../../lib/safe-outbound";
import { VALID_EVENT_TYPE_SET } from "../../lib/webhooks/event-catalog";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import {
  requireAdminOnly,
  requirePermission,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const upsertBody = z
  .object({
    name: z.string().trim().min(1).max(160),
    targetUrl: z
      .string()
      .url()
      .max(500)
      .refine((u) => u.startsWith("https://"), "must be https://")
      .refine((u) => {
        // Block IP literals in private / loopback / metadata
        // ranges at validate time so a misconfigured (or
        // malicious) admin can't point a subscription at the
        // internal network. The dispatcher re-checks via DNS
        // before each send, but rejecting obvious cases here
        // gives faster feedback in the admin UI.
        try {
          assertSafeOutboundUrlSync(u);
          return true;
        } catch {
          return false;
        }
      }, "target_url must be a public https URL"),
    eventTypes: z.array(z.string().trim().min(1).max(80)).min(1).max(40),
    maxRetries: z.number().int().min(0).max(12).default(5),
    isActive: z.boolean().default(true),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();
const patchBody = upsertBody.partial();
const idParam = z.object({ id: z.string().uuid() });

router.get(
  "/admin/webhook-subscriptions",
  requirePermission("admin.tools.manage"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data } = await supabase
      .schema("resupply")
      .from("webhook_subscriptions")
      .select(
        "id, name, target_url, event_types, is_active, max_retries, last_delivery_at, last_delivery_status, notes, created_at, updated_at",
      )
      .order("created_at", { ascending: false });
    res.json({
      // The signing_secret is intentionally NOT returned in the list
      // view — only the create response surfaces it once.
      subscriptions: data ?? [],
    });
  },
);

router.post(
  "/admin/webhook-subscriptions",
  requireAdminOnly,
  adminRateLimit({ name: "webhook_subscriptions.create", preset: "sensitive" }),
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
    // Validate every event_type against the static catalog except
    // for the '*' wildcard. Unknown slugs would silently never
    // match a publisher, so we 400 with the list of bad slugs.
    const unknown = b.eventTypes.filter(
      (t) => t !== "*" && !VALID_EVENT_TYPE_SET.has(t),
    );
    if (unknown.length > 0) {
      res.status(400).json({
        error: "unknown_event_types",
        unknown,
        hint: "GET /admin/webhook-event-catalog for the valid list",
      });
      return;
    }
    const signingSecret = randomBytes(32).toString("base64");
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("webhook_subscriptions")
      .insert({
        name: b.name,
        target_url: b.targetUrl,
        signing_secret: signingSecret,
        event_types: b.eventTypes,
        max_retries: b.maxRetries,
        is_active: b.isActive,
        notes: b.notes ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;
    await logAudit({
      action: "webhook_subscription.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "webhook_subscriptions",
      targetId: data.id,
      metadata: { name: b.name, event_types: b.eventTypes },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "webhook_subscription.create audit write failed");
    });
    // ONE TIME response with the signing secret. The admin UI must
    // copy it now — the GET endpoint never returns it again.
    res.status(201).json({ id: data.id, signingSecret });
  },
);

router.patch(
  "/admin/webhook-subscriptions/:id",
  requireAdminOnly,
  adminRateLimit({ name: "webhook_subscriptions.update", preset: "sensitive" }),
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
    const update: Database["resupply"]["Tables"]["webhook_subscriptions"]["Update"] =
      {
        updated_at: new Date().toISOString(),
      };
    if (b.name !== undefined) update.name = b.name;
    if (b.targetUrl !== undefined) update.target_url = b.targetUrl;
    if (b.eventTypes !== undefined) update.event_types = b.eventTypes;
    if (b.maxRetries !== undefined) update.max_retries = b.maxRetries;
    if (b.isActive !== undefined) update.is_active = b.isActive;
    if (b.notes !== undefined) update.notes = b.notes;
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("webhook_subscriptions")
      .update(update)
      .eq("id", idParsed.data.id);
    if (error) throw error;
    res.json({ ok: true });
  },
);

router.delete(
  "/admin/webhook-subscriptions/:id",
  requireAdminOnly,
  adminRateLimit({ name: "webhook_subscriptions.delete", preset: "destroy" }),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    // Verify the row existed AND check the DELETE error so the
    // response actually reflects what happened. Previously this
    // handler swallowed errors AND ignored "row didn't exist",
    // returning `{ ok: true }` regardless — an operator clicking
    // "delete" on a stale list saw success but the row was either
    // still there or had been deleted earlier with no observable
    // signal either way.
    const { data: deleted, error } = await supabase
      .schema("resupply")
      .from("webhook_subscriptions")
      .delete()
      .eq("id", idParsed.data.id)
      .select("id");
    if (error) throw error;
    if (!deleted || deleted.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ ok: true, deletedId: deleted[0]!.id });
  },
);

router.get(
  "/admin/webhook-deliveries",
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    let query = supabase
      .schema("resupply")
      .from("webhook_deliveries")
      .select(
        "id, subscription_id, event_type, status, attempt_count, last_http_status, last_error, next_attempt_at, delivered_at, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    const subscriptionId =
      typeof req.query.subscriptionId === "string"
        ? req.query.subscriptionId
        : undefined;
    if (subscriptionId) {
      query = query.eq("subscription_id", subscriptionId);
    }
    const status =
      typeof req.query.status === "string" ? req.query.status : undefined;
    if (
      status &&
      ["queued", "delivered", "failed", "exhausted"].includes(status)
    ) {
      query = query.eq(
        "status",
        status as Database["resupply"]["Tables"]["webhook_deliveries"]["Row"]["status"],
      );
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ deliveries: data ?? [] });
  },
);

export default router;
