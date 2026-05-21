// /admin/good-faith-estimates — generate + audit GFEs for cash-pay patients.
//
//   POST /admin/good-faith-estimates           admin-only
//        body: { recipientName, recipientEmail, items: [...], ... }
//        → returns the PDF (application/pdf) and persists a row.
//
//   GET  /admin/good-faith-estimates           admin-only — list recent
//   GET  /admin/good-faith-estimates/:id       admin-only — detail

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import {
  DEFAULT_GFE_DISCLAIMER,
  renderGfePdf,
} from "../../lib/billing/gfe-pdf";
import { resolveBillingIdentity } from "../../lib/billing/identity-resolver";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import {
  requireAdminOnly,
  requirePermission,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const HCPCS_RE = /^[A-Z]\d{4}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const gfeItem = z.object({
  description: z.string().trim().min(1).max(240),
  hcpcsCode: z
    .string()
    .trim()
    .max(12)
    .nullable()
    .optional()
    .transform((s) => (s ? s.toUpperCase() : null))
    .refine((s) => s === null || HCPCS_RE.test(s), "HCPCS shape"),
  quantity: z.number().int().min(1).max(9999),
  unitPriceCents: z.number().int().min(0),
});

const body = z
  .object({
    recipientName: z.string().trim().min(1).max(160),
    recipientEmail: z.string().trim().email().max(180),
    recipientAddress: z
      .object({
        line1: z.string().trim().min(1).max(120),
        line2: z.string().trim().max(120).optional(),
        city: z.string().trim().min(1).max(80),
        state: z.string().trim().regex(/^[A-Z]{2}$/),
        zip: z.string().trim().regex(/^\d{5}(-?\d{4})?$/),
      })
      .optional(),
    customerId: z.string().uuid().nullable().optional(),
    items: z.array(gfeItem).min(1).max(40),
    expectedServiceDate: z.string().regex(ISO_DATE_RE).nullable().optional(),
    deliveryMethod: z.enum(["email", "sms", "in_person", "mail"]).optional(),
  })
  .strict();

const idParam = z.object({ id: z.string().uuid() });

router.get(
  "/admin/good-faith-estimates",
  requirePermission("reports.read"),
  async (_req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("good_faith_estimates")
    .select(
      "id, customer_id, recipient_name, recipient_email, items_json, total_cents, expected_service_date, delivery_method, delivered_at, generated_by_email, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  res.json({ estimates: data ?? [] });
});

router.get(
  "/admin/good-faith-estimates/:id",
  requirePermission("reports.read"),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data } = await supabase
      .schema("resupply")
      .from("good_faith_estimates")
      .select("*")
      .eq("id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ estimate: data });
  },
);

router.post(
  "/admin/good-faith-estimates",
  requireAdminOnly,
  adminRateLimit({ name: "good_faith_estimates.create", preset: "sensitive" }),
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
    const b = parsed.data;
    const supabase = getSupabaseServiceRoleClient();
    const identity = await resolveBillingIdentity({ supabase });
    if (identity.source === "stub") {
      res.status(409).json({
        error: "no_dme_organization",
        message:
          "configure dme_organization first — required for the GFE issuer block",
      });
      return;
    }

    const result = await renderGfePdf({
      recipientName: b.recipientName,
      recipientEmail: b.recipientEmail,
      recipientAddress: b.recipientAddress
        ? {
            line1: b.recipientAddress.line1,
            line2: b.recipientAddress.line2,
            city: b.recipientAddress.city,
            state: b.recipientAddress.state,
            zip: b.recipientAddress.zip,
          }
        : undefined,
      items: b.items.map((i) => ({
        description: i.description,
        hcpcsCode: i.hcpcsCode ?? null,
        quantity: i.quantity,
        unitPriceCents: i.unitPriceCents,
      })),
      expectedServiceDate: b.expectedServiceDate ?? null,
      disclaimerText: DEFAULT_GFE_DISCLAIMER,
      dmeOrganization: {
        legalName: identity.organization?.legal_name ??
          identity.billingProvider.organizationName,
        npi: identity.billingProvider.npi,
        addressLine1: identity.billingProvider.address.line1,
        city: identity.billingProvider.address.city,
        state: identity.billingProvider.address.state,
        zip: identity.billingProvider.address.zip,
        phoneE164: identity.organization?.phone_e164 ?? "+10000000000",
        billingEmail:
          identity.organization?.billing_email ?? "billing@example.com",
      },
    });

    const insertRow: Database["resupply"]["Tables"]["good_faith_estimates"]["Insert"] = {
      customer_id: b.customerId ?? null,
      recipient_name: b.recipientName,
      recipient_email: b.recipientEmail,
      items_json: b.items as unknown as Json,
      total_cents: result.totalCents,
      expected_service_date: b.expectedServiceDate ?? null,
      disclaimer_text: DEFAULT_GFE_DISCLAIMER,
      generated_by_email: req.adminEmail ?? "unknown",
      delivery_method: b.deliveryMethod ?? null,
    };
    const { data: row, error: insertErr } = await supabase
      .schema("resupply")
      .from("good_faith_estimates")
      .insert(insertRow)
      .select("id")
      .single();
    if (insertErr) throw insertErr;

    await logAudit({
      action: "good_faith_estimate.generate",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "good_faith_estimates",
      targetId: row.id,
      metadata: {
        item_count: b.items.length,
        total_cents: result.totalCents,
        delivery_method: b.deliveryMethod ?? null,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "good_faith_estimate.generate audit write failed");
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="gfe-${row.id.slice(0, 8)}.pdf"`,
    );
    res.setHeader("X-GFE-Id", row.id);
    res.setHeader("X-GFE-Total-Cents", String(result.totalCents));
    res.status(201).end(result.pdf);
  },
);

export default router;
