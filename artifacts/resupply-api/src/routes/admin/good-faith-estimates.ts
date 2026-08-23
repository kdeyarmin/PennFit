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
  getOrgScopedClient,
} from "@workspace/resupply-db";
import { EmailConfigError } from "@workspace/resupply-email";

import {
  DEFAULT_GFE_DISCLAIMER,
  type GfeInput,
  renderGfePdf,
} from "../../lib/billing/gfe-pdf";
import {
  type ResolvedBillingIdentity,
  resolveBillingIdentity,
} from "../../lib/billing/identity-resolver";
import { createTenantSendgridClient } from "../../lib/email/tenant-sender";
import { redactDbErr } from "../../lib/redact-db-err";
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
        state: z
          .string()
          .trim()
          .regex(/^[A-Z]{2}$/),
        zip: z
          .string()
          .trim()
          .regex(/^\d{5}(-?\d{4})?$/),
      })
      .optional(),
    customerId: z.string().uuid().nullable().optional(),
    items: z.array(gfeItem).min(1).max(40),
    expectedServiceDate: z.string().regex(ISO_DATE_RE).nullable().optional(),
    deliveryMethod: z.enum(["email", "sms", "in_person", "mail"]).optional(),
  })
  .strict();

const idParam = z.object({ id: z.string().uuid() });

// Mirrors the good_faith_estimates_delivery_method_enum CHECK constraint
// (migration 0133) — keep in sync.
const deliverBody = z
  .object({
    deliveryMethod: z.enum(["email", "sms", "in_person", "mail"]),
  })
  .strict();

// The GFE issuer block, derived from the resolved (org-scoped) billing
// identity. Shared by the create and re-send-email paths so the PDF's issuer
// header never drifts between them.
function toDmeOrgBlock(
  identity: ResolvedBillingIdentity,
): GfeInput["dmeOrganization"] {
  return {
    legalName:
      identity.organization?.legal_name ??
      identity.billingProvider.organizationName,
    npi: identity.billingProvider.npi,
    addressLine1: identity.billingProvider.address.line1,
    city: identity.billingProvider.address.city,
    state: identity.billingProvider.address.state,
    zip: identity.billingProvider.address.zip,
    phoneE164: identity.organization?.phone_e164 ?? "+10000000000",
    billingEmail: identity.organization?.billing_email ?? "billing@example.com",
  };
}

// Re-render a persisted GFE row to a PDF, faithful to what was generated
// (stored items + disclaimer version). recipientAddress isn't persisted, so
// the re-render omits it. Fails closed (returns null) when the tenant has no
// billing identity, exactly like create.
async function renderStoredGfe(
  row: Database["resupply"]["Tables"]["good_faith_estimates"]["Row"],
  orgId: string,
): Promise<{ pdf: Buffer; totalCents: number } | { error: "no_identity" }> {
  const identity = await resolveBillingIdentity({ orgId });
  if (identity.source === "stub") return { error: "no_identity" };
  const items = Array.isArray(row.items_json)
    ? (row.items_json as unknown as Array<{
        description?: unknown;
        hcpcsCode?: unknown;
        quantity?: unknown;
        unitPriceCents?: unknown;
      }>)
    : [];
  const result = await renderGfePdf({
    recipientName: row.recipient_name,
    recipientEmail: row.recipient_email,
    items: items.map((i) => ({
      description: typeof i.description === "string" ? i.description : "",
      hcpcsCode: typeof i.hcpcsCode === "string" ? i.hcpcsCode : null,
      quantity: typeof i.quantity === "number" ? i.quantity : 1,
      unitPriceCents:
        typeof i.unitPriceCents === "number" ? i.unitPriceCents : 0,
    })),
    expectedServiceDate: row.expected_service_date ?? null,
    disclaimerText: row.disclaimer_text ?? DEFAULT_GFE_DISCLAIMER,
    dmeOrganization: toDmeOrgBlock(identity),
  });
  return { pdf: result.pdf, totalCents: result.totalCents };
}

router.get(
  "/admin/good-faith-estimates",
  requirePermission("reports.read"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data, error } = await supabase
      .from("good_faith_estimates")
      .select(
        "id, customer_id, recipient_name, recipient_email, items_json, total_cents, expected_service_date, delivery_method, delivered_at, generated_by_email, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json({ estimates: data ?? [] });
  },
);

router.get(
  "/admin/good-faith-estimates/:id",
  requirePermission("reports.read"),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data } = await supabase
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
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    // The billing-identity helper reads dme_organization ORG-SCOPED (by the
    // caller's org_id) and the tenant's clearinghouse credentials, failing
    // closed for a non-seed tenant without its own identity — so the GFE
    // issuer block carries THIS tenant's NPI/name, never the seed's.
    const identity = await resolveBillingIdentity({ orgId });
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
      dmeOrganization: toDmeOrgBlock(identity),
    });

    const insertRow: Database["resupply"]["Tables"]["good_faith_estimates"]["Insert"] =
      {
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
      logger.warn(
        { err: redactDbErr(err) },
        "good_faith_estimate.generate audit write failed",
      );
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

// POST .../:id/email — re-render the stored GFE and email the PDF to the
// recipient, then stamp delivered_at + delivery_method='email'. Re-delivery
// is allowed (latest send wins) so a corrected GFE can be re-sent. Only
// stamps on an actual successful send: an unconfigured tenant (no SendGrid)
// is a 503 and a send failure a 502 — neither marks the GFE delivered.
router.post(
  "/admin/good-faith-estimates/:id/email",
  requireAdminOnly,
  adminRateLimit({ name: "good_faith_estimates.email", preset: "sensitive" }),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data: row } = await supabase
      .from("good_faith_estimates")
      .select("*")
      .eq("id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const rendered = await renderStoredGfe(row, orgId);
    if ("error" in rendered) {
      res.status(409).json({
        error: "no_dme_organization",
        message:
          "configure dme_organization first — required for the GFE issuer block",
      });
      return;
    }

    try {
      const sendgrid = await createTenantSendgridClient(orgId);
      await sendgrid.sendEmail({
        to: row.recipient_email,
        subject: "Your Good Faith Estimate",
        text:
          "Attached is your Good Faith Estimate of the expected costs for the " +
          "items and services discussed. This is an estimate only and not a bill.",
        html:
          "<p>Attached is your Good Faith Estimate of the expected costs for " +
          "the items and services discussed.</p><p>This is an estimate only " +
          "and not a bill.</p>",
        attachments: [
          {
            content: rendered.pdf,
            filename: `good-faith-estimate-${row.id.slice(0, 8)}.pdf`,
            contentType: "application/pdf",
          },
        ],
      });
    } catch (err) {
      if (err instanceof EmailConfigError) {
        res.status(503).json({ error: "email_not_configured" });
        return;
      }
      logger.warn(
        { event: "gfe_email_send_failed", gfe_id: row.id },
        "good_faith_estimate.email: send failed",
      );
      res.status(502).json({ error: "email_send_failed" });
      return;
    }

    const nowIso = new Date().toISOString();
    const { error: stampErr } = await supabase
      .from("good_faith_estimates")
      .update({ delivered_at: nowIso, delivery_method: "email" })
      .eq("id", row.id);
    if (stampErr) {
      logger.warn(
        { event: "gfe_email_stamp_failed", gfe_id: row.id, err: stampErr },
        "good_faith_estimate.email: sent but delivered_at stamp failed",
      );
    }

    await logAudit({
      action: "good_faith_estimate.emailed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "good_faith_estimates",
      targetId: row.id,
      metadata: { delivery_method: "email" },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err: redactDbErr(err) },
        "good_faith_estimate.emailed audit write failed",
      );
    });

    res.json({ ok: true, deliveredAt: nowIso, deliveryMethod: "email" });
  },
);

// POST .../:id/deliver — mark a GFE delivered out-of-band (mail / in-person /
// portal / a manual email), stamping delivered_at + the channel. Does NOT
// send anything. Re-delivery is allowed (latest delivery wins).
router.post(
  "/admin/good-faith-estimates/:id/deliver",
  requireAdminOnly,
  adminRateLimit({ name: "good_faith_estimates.deliver", preset: "sensitive" }),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = deliverBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data: row } = await supabase
      .from("good_faith_estimates")
      .select("id")
      .eq("id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const nowIso = new Date().toISOString();
    const { error: stampErr } = await supabase
      .from("good_faith_estimates")
      .update({
        delivered_at: nowIso,
        delivery_method: parsed.data.deliveryMethod,
      })
      .eq("id", row.id);
    if (stampErr) throw stampErr;

    await logAudit({
      action: "good_faith_estimate.delivered",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "good_faith_estimates",
      targetId: row.id,
      metadata: { delivery_method: parsed.data.deliveryMethod },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err: redactDbErr(err) },
        "good_faith_estimate.delivered audit write failed",
      );
    });

    res.json({
      ok: true,
      deliveredAt: nowIso,
      deliveryMethod: parsed.data.deliveryMethod,
    });
  },
);

export default router;
