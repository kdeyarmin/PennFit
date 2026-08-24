// Public CSR-order signature endpoints (no login — the HMAC token is
// the auth).
//
//   GET  /csr-orders/view?token=...  — fetch the order + paperwork for
//                                      the review/sign UI
//   POST /csr-orders/sign            — submit the e-signature
//
// Mounted inside the storefront router (BEFORE attachSignedIn) so the
// cpap-fitter SPA reaches it at /api/csr-orders/*. The signing body
// can carry a drawn-signature PNG data URL; a dedicated 1 MB JSON
// parser is mounted for /api/csr-orders/sign in app.ts (the global
// parser caps at 100 KB).
//
// Nothing is charged: the patient signs, and the order is billed to
// their insurance through the claims pipeline.
//
// PHI / logging posture: the signature image is the signed artifact —
// it is persisted but NEVER logged. Order line items are never logged.

import { Router, type IRouter, type Request } from "express";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getOrgScopedClient,
  type OrgScopedClient,
} from "@workspace/resupply-db";

import {
  parseOrderDocuments,
  parseOrderItems,
} from "../../lib/csr-order/order";
import { verifyCsrOrderToken } from "../../lib/csr-order/token";
import { redactDbErr } from "../../lib/redact-db-err";
import { logger } from "../../lib/logger";
import { resolveOrgIdForSignedRecord } from "../../lib/storefront/signed-link-org";
import { resolveCompanyProfile } from "../../lib/patient-packet/company";
import { renderPacketDocumentSections } from "../../lib/patient-packet/content";

const router: IRouter = Router();

const viewLimiter = expressRateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "rate_limited" },
});

const mutateLimiter = expressRateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "rate_limited" },
});

const SIGNATURE_MAX_CHARS = 90_000; // keeps the body within the parser cap

type ResolvedOrderRow = {
  id: string;
  order_reference: string;
  status: "sent" | "viewed" | "signed" | "canceled";
  customer_name: string;
  customer_email: string | null;
  items: unknown;
  amount_total_cents: number;
  currency: string;
  note_to_customer: string | null;
  documents: unknown;
  link_version: number;
  expires_at: string | null;
  signed_at: string | null;
  signer_name: string | null;
};

const ORDER_COLUMNS =
  "id, order_reference, status, customer_name, customer_email, items, amount_total_cents, currency, note_to_customer, documents, link_version, expires_at, signed_at, signer_name";

// Verify a token against a freshly-loaded order row. The signed token is
// the authorization, so we resolve the order's TENANT from its record
// (so a tenant-B link lands in tenant B) and scope every read/write to it.
// Returns the order + its org-scoped client, or an error code to surface.
async function resolveOpenOrder(token: string): Promise<
  | {
      ok: true;
      order: ResolvedOrderRow;
      supabase: OrgScopedClient;
      orgId: string;
    }
  | { ok: false; code: "invalid" | "not_found" | "expired" | "canceled" }
> {
  const verified = verifyCsrOrderToken(token);
  if (!verified.valid) return { ok: false, code: "invalid" };

  const orgId = await resolveOrgIdForSignedRecord(
    "csr_order_requests",
    verified.orderRequestId,
  );
  if (!orgId) return { ok: false, code: "not_found" };
  const supabase = getOrgScopedClient(orgId);

  const { data: order, error } = await supabase
    .from("csr_order_requests")
    .select(ORDER_COLUMNS)
    .eq("id", verified.orderRequestId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!order) return { ok: false, code: "not_found" };
  // A stale link (re-issued / canceled) carries an old version.
  if (order.link_version !== verified.linkVersion) {
    return { ok: false, code: "invalid" };
  }
  if (order.status === "canceled") return { ok: false, code: "canceled" };
  if (order.expires_at && new Date(order.expires_at).getTime() < Date.now()) {
    return { ok: false, code: "expired" };
  }
  return { ok: true, order: order as ResolvedOrderRow, supabase, orgId };
}

function errorStatus(code: "invalid" | "not_found" | "expired" | "canceled") {
  return code === "not_found" ? 404 : 410;
}

// ── GET /csr-orders/view ──────────────────────────────────────────
router.get("/csr-orders/view", viewLimiter, async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!token || token.length > 600) {
    res.status(400).json({ error: "missing_token" });
    return;
  }
  const resolved = await resolveOpenOrder(token);
  if (!resolved.ok) {
    res.status(errorStatus(resolved.code)).json({ error: resolved.code });
    return;
  }
  const order = resolved.order;
  const supabase = resolved.supabase;

  const company = await resolveCompanyProfile(supabase);

  // First view? Stamp it (best-effort; never blocks the read).
  if (order.status === "sent") {
    const { error: viewStampErr } = await supabase
      .from("csr_order_requests")
      .update({
        status: "viewed",
        first_viewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id)
      .eq("status", "sent");
    if (viewStampErr) {
      logger.warn(
        { err: viewStampErr, orderRequestId: order.id },
        "csr-orders.view: first-view stamp failed (non-fatal)",
      );
    }
  }

  const documents = parseOrderDocuments(
    order.documents as Parameters<typeof parseOrderDocuments>[0],
  );

  res.json({
    status: "open",
    orderReference: order.order_reference,
    customerName: order.customer_name,
    items: parseOrderItems(
      order.items as Parameters<typeof parseOrderItems>[0],
    ),
    amountTotalCents: order.amount_total_cents,
    currency: order.currency,
    note: order.note_to_customer,
    company: {
      legalName: company.legalName,
      phone: company.phone,
      email: company.email,
    },
    documents: documents.map((d) => ({
      key: d.key,
      title: d.title,
      category: d.category,
      requiresSignature: d.requiresSignature,
      // Send-time snapshot (merge tokens resolved here against live
      // company data + this order's recipient).
      sections: renderPacketDocumentSections({
        documentKey: d.key,
        storedSections: d.sections,
        company,
        recipientName: order.customer_name,
        recipientEmail: order.customer_email,
        deliveryDetails: { orderRef: order.order_reference },
      }),
    })),
    signed: Boolean(order.signed_at),
    signedAt: order.signed_at,
  });
});

// ── POST /csr-orders/sign ─────────────────────────────────────────
const signBody = z
  .object({
    token: z.string().min(10).max(600),
    signerName: z.string().trim().min(2).max(160),
    signatureImage: z
      .string()
      .max(SIGNATURE_MAX_CHARS)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/u)
      .optional()
      .nullable(),
    consentEsign: z.literal(true),
    acknowledgedDocumentKeys: z.array(z.string().min(1).max(64)).max(20),
  })
  .strict();

router.post("/csr-orders/sign", mutateLimiter, async (req, res) => {
  const parsed = signBody.safeParse(req.body ?? {});
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

  const resolved = await resolveOpenOrder(b.token);
  if (!resolved.ok) {
    res.status(errorStatus(resolved.code)).json({ error: resolved.code });
    return;
  }
  const order = resolved.order;
  const supabase = resolved.supabase;
  if (order.signed_at) {
    res.status(409).json({ error: "already_signed" });
    return;
  }

  // Every paperwork document must be acknowledged before signing.
  const documents = parseOrderDocuments(
    order.documents as Parameters<typeof parseOrderDocuments>[0],
  );
  const ackedKeys = new Set(b.acknowledgedDocumentKeys);
  const missing = documents.map((d) => d.key).filter((k) => !ackedKeys.has(k));
  if (missing.length > 0) {
    res.status(400).json({ error: "documents_not_acknowledged", missing });
    return;
  }

  const nowIso = new Date().toISOString();
  const ip = req.ip ?? null;
  const userAgent = (req.get("user-agent") ?? "").slice(0, 500) || null;

  // Optimistic guard against a double-submit: only flip rows that are
  // still unsigned. The link stays valid (same version) so the
  // customer sees the signed state immediately.
  const { data: updated, error: updErr } = await supabase
    .from("csr_order_requests")
    .update({
      status: "signed",
      signed_at: nowIso,
      signer_name: b.signerName,
      signature_image: b.signatureImage ?? null,
      signer_ip: ip,
      signer_user_agent: userAgent,
      consent_esign: true,
      updated_at: nowIso,
    })
    .eq("id", order.id)
    .is("signed_at", null)
    .select("id");
  if (updErr) throw updErr;
  if (!updated || updated.length === 0) {
    res.status(409).json({ error: "already_signed" });
    return;
  }

  await logAudit({
    action: "csr_order.signed",
    targetTable: "csr_order_requests",
    targetId: order.id,
    metadata: {
      document_count: documents.length,
      has_drawn_signature: Boolean(b.signatureImage),
    },
    ip,
    userAgent,
  }).catch((err) => {
    logger.warn(
      { err: redactDbErr(err) },
      "csr_order.signed audit write failed",
    );
  });

  res.json({ status: "signed", signedAt: nowIso });
});

export default router;
