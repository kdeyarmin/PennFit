// /admin/.../payment-plans — patient payment-plan tracker (biller #B7).
//
//   POST  /admin/patients/:patientId/payment-plans       patients.update
//   GET   /admin/patients/:patientId/payment-plans        patients.read
//   GET   /admin/payment-plans/:id                        patients.read
//   PATCH /admin/payment-plans/:id                        patients.update  (cancel)
//   PATCH /admin/payment-plan-installments/:id            patients.update  (settle)
//
// Structures a patient balance into a scheduled installment plan and
// tracks paid / remaining / overdue. RECORD-KEEPING only — it does not
// charge a card (Stripe auto-charge is a deliberate follow-up). Reads
// gated by patients.read, mutations by patients.update (CSR + admin hold
// both — a CSR/biller sets these up). Schedule + summary + status math is
// the pure, unit-tested core in lib/billing/payment-plan.ts.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  computePlanSummary,
  derivePlanStatus,
  generateInstallmentSchedule,
  type InstallmentRow,
} from "../../lib/billing/payment-plan";
import { logger } from "../../lib/logger";
import {
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import {
  adminRateLimit,
  adminReadRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const uuid = z.string().uuid();
const todayIso = (): string => new Date().toISOString().slice(0, 10);

const createBody = z
  .object({
    totalAmountCents: z.number().int().min(1).max(100_000_000),
    installmentCount: z.number().int().min(2).max(60),
    frequency: z.enum(["weekly", "biweekly", "monthly"]).default("monthly"),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    note: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.totalAmountCents < v.installmentCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "totalAmountCents must be >= installmentCount (min 1¢ per installment)",
        path: ["totalAmountCents"],
      });
    }
  });

const listByPatientBody = z
  .object({
    patientId: uuid,
  })
  .strict();

router.post(
  "/admin/patients/:patientId/payment-plans",
  requirePermission("patients.update"),
  adminRateLimit({ name: "payment_plans.create", preset: "mutation" }),
  async (req, res) => {
    const patientId = uuid.safeParse(req.params.patientId);
    if (!patientId.success) {
      res.status(400).json({ error: "invalid_patient_id" });
      return;
    }
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const d = parsed.data;
    const supabase = getSupabaseServiceRoleClient();
    const { data: patient } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("id", patientId.data)
      .limit(1)
      .maybeSingle();
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    const schedule = generateInstallmentSchedule({
      totalAmountCents: d.totalAmountCents,
      installmentCount: d.installmentCount,
      frequency: d.frequency,
      startDate: d.startDate,
    });

    const { data: plan, error: planErr } = await supabase
      .schema("resupply")
      .from("patient_payment_plans")
      .insert({
        patient_id: patientId.data,
        total_amount_cents: d.totalAmountCents,
        installment_count: d.installmentCount,
        frequency: d.frequency,
        start_date: d.startDate,
        status: "active",
        note: d.note ?? null,
        created_by_email: req.adminEmail ?? null,
      })
      .select("id")
      .single();
    if (planErr) throw planErr;

    const { error: instErr } = await supabase
      .schema("resupply")
      .from("patient_payment_plan_installments")
      .insert(
        schedule.map((s) => ({
          plan_id: plan.id,
          seq: s.seq,
          due_date: s.dueDate,
          amount_cents: s.amountCents,
          status: "scheduled" as const,
        })),
      );
    if (instErr) {
      // Best-effort cleanup: avoid leaving an orphaned plan if the schedule insert fails.
      const { error: cleanupErr } = await supabase
        .schema("resupply")
        .from("patient_payment_plans")
        .delete()
        .eq("id", plan.id);
      if (cleanupErr) {
        logger.error(
          { err: cleanupErr.message, planId: plan.id },
          "payment-plans.create: orphan plan cleanup failed",
        );
      }
      throw instErr;
    }

    await audit(req, "payment_plan.create", "patient_payment_plans", plan.id, {
      patient_id: patientId.data,
      total_amount_cents: d.totalAmountCents,
      installment_count: d.installmentCount,
    });
    res.status(201).json({ id: plan.id, installments: schedule });
  },
);

router.post(
  "/admin/patients/payment-plans/list",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = listByPatientBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_patient_id" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: plans } = await supabase
      .schema("resupply")
      .from("patient_payment_plans")
      .select(
        "id, total_amount_cents, installment_count, frequency, start_date, status, note, created_at, autopay_status, autopay_authorized_at",
      )
      .eq("patient_id", parsed.data.patientId)
      .order("created_at", { ascending: false })
      .limit(200);
    const planIds = (plans ?? []).map((p) => p.id);
    const summaryByPlan = await loadSummaries(planIds);
    res.json({
      plans: (plans ?? []).map((p) => ({
        ...p,
        summary: summaryByPlan.get(p.id) ?? null,
      })),
    });
  },
);

router.get(
  "/admin/payment-plans/:id",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  async (req, res) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: plan } = await supabase
      .schema("resupply")
      .from("patient_payment_plans")
      .select(
        "id, patient_id, total_amount_cents, installment_count, frequency, start_date, status, note, created_at, updated_at, autopay_status, autopay_authorized_at",
      )
      .eq("id", id.data)
      .limit(1)
      .maybeSingle();
    if (!plan) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { data: installments } = await supabase
      .schema("resupply")
      .from("patient_payment_plan_installments")
      .select(
        "id, seq, due_date, amount_cents, status, paid_at, patient_payment_id",
      )
      .eq("plan_id", id.data)
      .order("seq", { ascending: true });
    const rows = (installments ?? []).map(toInstallmentRow);
    res.json({
      plan,
      installments: installments ?? [],
      summary: computePlanSummary(rows, todayIso()),
    });
  },
);

const cancelBody = z.object({ status: z.literal("cancelled") }).strict();

router.patch(
  "/admin/payment-plans/:id",
  requirePermission("patients.update"),
  adminRateLimit({ name: "payment_plans.update", preset: "mutation" }),
  async (req, res) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!cancelBody.safeParse(req.body).success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("patient_payment_plans")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", id.data)
      .neq("status", "completed")
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      res.status(409).json({ error: "not_cancellable" });
      return;
    }
    await audit(
      req,
      "payment_plan.cancel",
      "patient_payment_plans",
      id.data,
      {},
    );
    res.json({ ok: true, status: "cancelled" });
  },
);

const settleBody = z
  .object({
    status: z.enum(["paid", "waived", "scheduled"]),
    patientPaymentId: uuid.nullable().optional(),
  })
  .strict();

router.patch(
  "/admin/payment-plan-installments/:id",
  requirePermission("patients.update"),
  adminRateLimit({
    name: "payment_plan_installments.update",
    preset: "mutation",
  }),
  async (req, res) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = settleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: inst } = await supabase
      .schema("resupply")
      .from("patient_payment_plan_installments")
      .select("id, plan_id")
      .eq("id", id.data)
      .limit(1)
      .maybeSingle();
    if (!inst) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { error: updErr } = await supabase
      .schema("resupply")
      .from("patient_payment_plan_installments")
      .update({
        status: parsed.data.status,
        paid_at:
          parsed.data.status === "paid" ? new Date().toISOString() : null,
        patient_payment_id:
          parsed.data.status === "paid"
            ? (parsed.data.patientPaymentId ?? null)
            : null,
      })
      .eq("id", id.data);
    if (updErr) throw updErr;

    // Recompute plan lifecycle from the (now-updated) sibling installments,
    // unless the plan was cancelled.
    const { data: siblings } = await supabase
      .schema("resupply")
      .from("patient_payment_plan_installments")
      .select("amount_cents, status, due_date")
      .eq("plan_id", inst.plan_id);
    const planStatus = derivePlanStatus((siblings ?? []).map(toInstallmentRow));
    const { error: planStatusErr } = await supabase
      .schema("resupply")
      .from("patient_payment_plans")
      .update({ status: planStatus, updated_at: new Date().toISOString() })
      .eq("id", inst.plan_id)
      .neq("status", "cancelled");
    if (planStatusErr) {
      logger.error(
        { err: planStatusErr.message, planId: inst.plan_id },
        "payment-plans.settle: plan status update failed",
      );
    }

    await audit(
      req,
      "payment_plan.installment_settle",
      "patient_payment_plan_installments",
      id.data,
      { status: parsed.data.status, plan_status: planStatus },
    );
    res.json({ ok: true, planStatus });
  },
);

// ── helpers ──────────────────────────────────────────────────────────
function toInstallmentRow(r: {
  amount_cents: number;
  status: string;
  due_date: string;
}): InstallmentRow {
  return {
    amountCents: r.amount_cents,
    status: r.status as InstallmentRow["status"],
    dueDate: r.due_date,
  };
}

async function loadSummaries(
  planIds: string[],
): Promise<Map<string, ReturnType<typeof computePlanSummary>>> {
  const out = new Map<string, ReturnType<typeof computePlanSummary>>();
  if (planIds.length === 0) return out;
  const supabase = getSupabaseServiceRoleClient();
  const { data } = await supabase
    .schema("resupply")
    .from("patient_payment_plan_installments")
    .select("plan_id, amount_cents, status, due_date")
    .in("plan_id", planIds);
  const byPlan = new Map<string, InstallmentRow[]>();
  for (const r of data ?? []) {
    const list = byPlan.get(r.plan_id) ?? [];
    list.push(toInstallmentRow(r));
    byPlan.set(r.plan_id, list);
  }
  const today = todayIso();
  for (const pid of planIds) {
    out.set(pid, computePlanSummary(byPlan.get(pid) ?? [], today));
  }
  return out;
}

async function audit(
  req: import("express").Request,
  action: string,
  table: string,
  targetId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await logAudit({
    action,
    adminEmail: req.adminEmail ?? null,
    adminUserId: req.adminUserId ?? null,
    targetTable: table,
    targetId,
    metadata,
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  }).catch((err) => {
    logger.warn({ err, action }, "payment-plan audit write failed");
  });
}

// POST /admin/payment-plans/:id/authorize-autopay — start the off-session
// mandate flow. Creates a Stripe *setup* Checkout session (which captures
// Stripe's standard recurring-charge mandate consent) for the plan's
// patient and returns the hosted URL for the CSR to send / the patient to
// complete. On completion the webhook stores the customer + payment method
// and flips autopay_status='authorized' (see stripe/webhook-handler.ts).
//
// Charging itself stays gated behind the seeded-OFF
// billing.payment_plan_autocharge flag + the worker cron — authorizing a
// plan never charges anything on its own.
const authorizeBody = z
  .object({
    successUrl: z.string().url().max(2000),
    cancelUrl: z.string().url().max(2000),
  })
  .strict();

router.post(
  "/admin/payment-plans/:id/authorize-autopay",
  requirePermission("patients.update"),
  adminRateLimit({
    name: "payment_plans.authorize_autopay",
    preset: "mutation",
  }),
  async (req, res) => {
    const idCheck = uuid.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = authorizeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const config = readStripeConfigOrNull();
    if (!config) {
      res.status(503).json({
        error: "stripe_not_configured",
        message: "Stripe is not configured; cannot authorize autopay.",
      });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: plan, error } = await supabase
      .schema("resupply")
      .from("patient_payment_plans")
      .select("id, patient_id, status, stripe_customer_id")
      .eq("id", idCheck.data)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!plan) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (plan.status !== "active") {
      res.status(409).json({
        error: "plan_not_active",
        message: "Only an active plan can be authorized for autopay.",
      });
      return;
    }

    const stripe = getStripeClient(config);
    // Reuse the plan's customer if one was already minted; otherwise let
    // Checkout create one (customer_creation='always' in setup mode).
    let session;
    try {
      session = await stripe.checkout.sessions.create(
        {
          mode: "setup",
          payment_method_types: ["card"],
          ...(plan.stripe_customer_id
            ? { customer: plan.stripe_customer_id }
            : {}),
          success_url: parsed.data.successUrl,
          cancel_url: parsed.data.cancelUrl,
          // The webhook keys off these to find the plan + store the PM.
          metadata: {
            payment_plan_id: plan.id,
            patient_id: plan.patient_id,
            purpose: "payment_plan_autopay",
          },
          setup_intent_data: {
            metadata: {
              payment_plan_id: plan.id,
              patient_id: plan.patient_id,
              purpose: "payment_plan_autopay",
            },
          },
        },
        { idempotencyKey: `pennpaps-autopay-setup-${plan.id}` },
      );
    } catch (err) {
      // Log the Error object so pino's serializer redacts message/stack
      // (a raw string field bypasses that redaction).
      logger.warn(
        { err },
        "payment-plan authorize-autopay: stripe session create failed",
      );
      res.status(502).json({ error: "stripe_error" });
      return;
    }
    if (!session.url) {
      res.status(502).json({ error: "stripe_no_url" });
      return;
    }

    // Mark the plan as pending authorization (not yet authorized — that
    // only happens when the webhook confirms the completed setup). If this
    // write fails the plan stays in its prior state; the setup session is
    // already live and the webhook flips it to 'authorized' on completion
    // regardless, so we don't fail the request — but we surface the error
    // so a stuck 'off' status is debuggable rather than silent.
    const { error: pendingErr } = await supabase
      .schema("resupply")
      .from("patient_payment_plans")
      .update({
        autopay_status: "pending",
        updated_at: new Date().toISOString(),
      })
      .eq("id", plan.id);
    if (pendingErr) {
      logger.warn(
        { err: pendingErr, planId: plan.id },
        "payment-plan authorize-autopay: failed to mark plan pending",
      );
    }

    await audit(
      req,
      "payment_plan.autopay.authorize_started",
      "patient_payment_plans",
      plan.id,
      {
        session_id: session.id,
      },
    );

    res.json({ url: session.url });
  },
);

export default router;
