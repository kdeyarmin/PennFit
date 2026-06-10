// Patient-responsibility statement SEND (Biller #30).
//
//   GET  /admin/billing/statements/pending        (reports.read)
//     Worklist — rendered statements with a positive balance awaiting
//     send. Ids + amounts only (no patient names).
//
//   POST /admin/billing/statements/:statementId/send   (admin.tools.manage)
//     Send one statement now (consent/DND-gated; outcome recorded).
//
//   POST /admin/billing/statements/batch-send          (admin.tools.manage)
//     Send all pending statements, capped per run; returns a summary.
//
// All send logic + gating lives in lib/billing/statement-send.ts. These
// routes only wire HTTP + supply the PDF-link signer. Counts / ids /
// channel / status in logs — never amount, name, contact, or link.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { resolveBillingIdentity } from "../../lib/billing/identity-resolver";
import {
  renderStatementsBatchPdf,
  type StatementInput,
} from "../../lib/billing/statement-pdf";
import {
  markStatementsMailed,
  runStatementBatchSend,
  sendOneStatement,
} from "../../lib/billing/statement-send";
import {
  createSignedDownloadUrl,
  ObjectStorageService,
} from "../../lib/object-storage/objectStorage";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const MAIL_PRINT_CAP = 100;

interface PersistedLineItem {
  claim_id: string;
  payer_name: string;
  date_of_service: string;
  billed_cents: number;
  paid_cents: number;
  patient_responsibility_cents: number;
}

const router: IRouter = Router();

// 7-day signed link to the statement PDF, fail-soft (null → the message
// goes out as a balance notice without a link rather than not at all).
async function signPdfUrl(objectKey: string): Promise<string | null> {
  try {
    const bucket = new ObjectStorageService().getPrivateBucket();
    return await createSignedDownloadUrl(
      { bucket, path: objectKey },
      7 * 24 * 3600,
    );
  } catch {
    return null;
  }
}

router.get(
  "/admin/billing/statements/pending",
  adminReadRateLimiter,
  requirePermission("reports.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("patient_billing_statements")
      .select("id, patient_id, total_patient_responsibility_cents, created_at")
      .eq("delivery_status", "pending")
      .gt("total_patient_responsibility_cents", 0)
      // Electronic worklist = everything EXCEPT mailed-preference (which
      // has its own /mail-queue). Excluding only 'mail' keeps null (legacy)
      // plus any sms/in_person rows visible here rather than orphaning them
      // between the two queues.
      .or("delivery_method.is.null,delivery_method.neq.mail")
      .order("created_at", { ascending: true })
      .limit(500);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    const rows = (data ?? []) as Array<{
      id: string;
      patient_id: string;
      total_patient_responsibility_cents: number;
      created_at: string;
    }>;
    const pending = rows.map((r) => ({
      statementId: r.id,
      patientId: r.patient_id,
      amountCents: r.total_patient_responsibility_cents,
      createdAt: r.created_at,
    }));
    res.json({
      pending,
      count: pending.length,
      totalCents: pending.reduce((s, i) => s + i.amountCents, 0),
    });
  },
);

router.post(
  "/admin/billing/statements/:statementId/send",
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const parsed = z.string().uuid().safeParse(req.params.statementId);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_statement_id" });
      return;
    }
    const outcome = await sendOneStatement(
      getSupabaseServiceRoleClient(),
      parsed.data,
      { signPdfUrl },
    );
    res.json({ outcome });
  },
);

const batchSchema = z
  .object({ cap: z.coerce.number().int().min(1).max(200).optional() })
  .strip();

router.post(
  "/admin/billing/statements/batch-send",
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const parsed = batchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const summary = await runStatementBatchSend(
      { cap: parsed.data.cap ?? 50 },
      { signPdfUrl },
    );
    req.log?.info(
      {
        event: "admin.statement_batch.send",
        ...summary,
        adminEmail: req.adminEmail,
      },
      "admin.statement_batch.send",
    );
    res.json({ summary });
  },
);

// ── Mail worklist ──────────────────────────────────────────────────
//
// Statements stamped delivery_method='mail' at generation (the patient
// chose paper bills) sit here awaiting a print run — they are never
// emailed/texted by the batch. Workflow: review the queue → download the
// combined print batch (one PDF, one statement per page) → stuff and
// mail → mark the batch mailed.

router.get(
  "/admin/billing/statements/mail-queue",
  adminReadRateLimiter,
  requirePermission("reports.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("patient_billing_statements")
      .select("id, patient_id, total_patient_responsibility_cents, created_at")
      .eq("delivery_status", "pending")
      .eq("delivery_method", "mail")
      .gt("total_patient_responsibility_cents", 0)
      .order("created_at", { ascending: true })
      .limit(500);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    const rows = (data ?? []) as Array<{
      id: string;
      patient_id: string;
      total_patient_responsibility_cents: number;
      created_at: string;
    }>;
    const queued = rows.map((r) => ({
      statementId: r.id,
      patientId: r.patient_id,
      amountCents: r.total_patient_responsibility_cents,
      createdAt: r.created_at,
    }));
    res.json({
      queued,
      count: queued.length,
      totalCents: queued.reduce((s, i) => s + i.amountCents, 0),
      printCap: MAIL_PRINT_CAP,
    });
  },
);

// Combined print batch — re-renders the oldest mail-queue statements
// (up to MAIL_PRINT_CAP) from their snapshots into a single PDF. Streams
// PHI (names + balances), so reports.read gated like the worklist.
router.get(
  "/admin/billing/statements/mail-queue/print",
  adminReadRateLimiter,
  requirePermission("reports.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("patient_billing_statements")
      .select("id, patient_id, line_items_json, created_at")
      .eq("delivery_status", "pending")
      .eq("delivery_method", "mail")
      .gt("total_patient_responsibility_cents", 0)
      .order("created_at", { ascending: true })
      .limit(MAIL_PRINT_CAP);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    const rows = (data ?? []) as Array<{
      id: string;
      patient_id: string;
      line_items_json: unknown;
    }>;

    // Resolve the issuer once (org-wide), then batch-fetch every patient.
    const identity = await resolveBillingIdentity({ supabase });
    if (identity.source === "stub") {
      res.status(409).json({ error: "no_dme_organization" });
      return;
    }
    const dmeOrganization = {
      legalName:
        identity.organization?.legal_name ??
        identity.billingProvider.organizationName,
      addressLine1: identity.billingProvider.address.line1,
      city: identity.billingProvider.address.city,
      state: identity.billingProvider.address.state,
      zip: identity.billingProvider.address.zip,
      phoneE164: identity.organization?.phone_e164 ?? "+10000000000",
      billingEmail:
        identity.organization?.billing_email ?? "billing@example.com",
    };

    const patientIds = [...new Set(rows.map((r) => r.patient_id))];
    const patientById = new Map<
      string,
      {
        legal_first_name: string;
        legal_last_name: string;
        address: unknown;
        email: string | null;
      }
    >();
    if (patientIds.length > 0) {
      const { data: pats, error: patsErr } = await supabase
        .schema("resupply")
        .from("patients")
        .select("id, legal_first_name, legal_last_name, address, email")
        .in("id", patientIds);
      // Fail the request rather than render the batch with missing
      // names/addresses — a blank-addressee statement could be printed
      // and mailed before anyone notices.
      if (patsErr) {
        res
          .status(500)
          .json({ error: "query_failed", message: patsErr.message });
        return;
      }
      for (const p of pats ?? []) {
        patientById.set(p.id as string, {
          legal_first_name: p.legal_first_name as string,
          legal_last_name: p.legal_last_name as string,
          address: p.address,
          email: (p.email as string | null) ?? null,
        });
      }
    }

    const inputs: StatementInput[] = rows.map((r) => {
      const patient = patientById.get(r.patient_id);
      const address = (patient?.address ?? null) as {
        line1?: string;
        line2?: string;
        city?: string;
        state?: string;
        zip?: string;
      } | null;
      const lineItemsRaw = r.line_items_json;
      const lineItems = (Array.isArray(lineItemsRaw) ? lineItemsRaw : []).map(
        (li) => {
          const item = li as unknown as PersistedLineItem;
          return {
            claimId: item.claim_id,
            payerName: item.payer_name,
            dateOfService: item.date_of_service,
            billedCents: item.billed_cents,
            paidCents: item.paid_cents,
            patientResponsibilityCents: item.patient_responsibility_cents,
          };
        },
      );
      return {
        patient: {
          name: patient
            ? `${patient.legal_first_name} ${patient.legal_last_name}`
            : "Patient",
          address: address?.line1
            ? {
                line1: address.line1,
                line2: address.line2,
                city: address.city ?? "",
                state: address.state ?? "",
                zip: address.zip ?? "",
              }
            : undefined,
          email: patient?.email ?? null,
        },
        dmeOrganization,
        lineItems,
      };
    });

    const { pdf } = await renderStatementsBatchPdf(inputs);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="statement-mail-batch-${new Date()
        .toISOString()
        .slice(0, 10)}.pdf"`,
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Statement-Mail-Batch-Count", String(inputs.length));
    res.status(200).end(pdf);
  },
);

const markMailedSchema = z
  .object({ statementIds: z.array(z.string().uuid()).min(1).max(500) })
  .strict();

router.post(
  "/admin/billing/statements/mark-mailed",
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const parsed = markMailedSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const marked = await markStatementsMailed(
      getSupabaseServiceRoleClient(),
      parsed.data.statementIds,
    );
    req.log?.info(
      {
        event: "admin.statement_mail_batch.marked",
        marked,
        requested: parsed.data.statementIds.length,
        adminEmail: req.adminEmail,
      },
      "admin.statement_mail_batch.marked",
    );
    res.json({ marked });
  },
);

export default router;
