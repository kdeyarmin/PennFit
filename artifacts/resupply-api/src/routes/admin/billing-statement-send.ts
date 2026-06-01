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

import {
  runStatementBatchSend,
  sendOneStatement,
} from "../../lib/billing/statement-send";
import {
  createSignedDownloadUrl,
  ObjectStorageService,
} from "../../lib/object-storage/objectStorage";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

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

export default router;
