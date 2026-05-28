// /admin/patients/:id/insurance-claims/* — payer claim & EOB
// tracking for the DME billing team.
//
//   GET    /patients/:id/insurance-claims                 — list newest-first
//   POST   /patients/:id/insurance-claims                 — create draft
//   GET    /patients/:id/insurance-claims/:claimId        — detail w/ lines + events
//   PATCH  /patients/:id/insurance-claims/:claimId        — state transitions + edits
//   POST   /patients/:id/insurance-claims/:claimId/lines  — add HCPCS line
//   PATCH  /patients/:id/insurance-claims/:claimId/lines/:lineId — edit / mark paid|denied
//   POST   /patients/:id/insurance-claims/:claimId/events — append history event (incl. EOB receipt)
//
// Status state machine
// --------------------
//   draft     -> submitted
//   submitted -> accepted | denied
//   accepted  -> paid | denied
//   denied    -> appealed | closed
//   appealed  -> accepted | denied
//   paid      -> closed
//
// Every transition writes:
//   * an insurance_claim_events row (replayable history),
//   * an audit_log row (HMAC-chained; tamper-evident),
//   * the totals on the claim row (recomputed from line items).
//
// Capture-only in this Tier-2 sprint. Tier-3 will wire automated
// 837P claim submission to clearinghouses where the payer supports
// it; the schema and the state machine are stable across that work.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { publishEvent } from "../../lib/webhooks/publisher";
import { requireAdmin } from "../../middlewares/requireAdmin";
import { sendEobExplainerEmail } from "../../lib/order-emails/send-eob-explainer-email";

type ClaimRow = Database["resupply"]["Tables"]["insurance_claims"]["Row"];
type ClaimStatus = ClaimRow["status"];

const router: IRouter = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HCPCS_RE = /^[A-Z]\d{4}(-[A-Z0-9]{2}){0,4}$/;

const idParam = z.object({ id: z.string().uuid() });
const idAndClaimParam = z.object({
  id: z.string().uuid(),
  claimId: z.string().uuid(),
});
const idClaimAndLineParam = z.object({
  id: z.string().uuid(),
  claimId: z.string().uuid(),
  lineId: z.string().uuid(),
});

const STATUS_VALUES = [
  "draft",
  "submitted",
  "accepted",
  "denied",
  "paid",
  "appealed",
  "closed",
] as const satisfies readonly ClaimStatus[];

// Allowed forward transitions. Backward moves (e.g. accepted -> draft)
// are rejected so the history is monotonic. A mistake gets a 'note'
// event documenting the correction and a new claim if needed.
const VALID_TRANSITIONS: Record<ClaimStatus, readonly ClaimStatus[]> = {
  draft: ["submitted"],
  submitted: ["accepted", "denied"],
  accepted: ["paid", "denied"],
  denied: ["appealed", "closed"],
  appealed: ["accepted", "denied"],
  paid: ["closed"],
  closed: [],
};

const LINE_STATUS_VALUES = ["pending", "accepted", "denied", "paid"] as const;

const EVENT_TYPE_VALUES = [
  "submitted",
  "accepted",
  "denied",
  "partial_pay",
  "paid",
  "appealed",
  "closed",
  "note",
] as const;

const createClaimBody = z
  .object({
    insuranceCoverageId: z.string().uuid().nullable().optional(),
    payerName: z.string().trim().min(1).max(120),
    dateOfService: z.string().regex(ISO_DATE, "must be YYYY-MM-DD"),
    fulfillmentId: z.string().uuid().nullable().optional(),
    claimNumber: z.string().trim().max(64).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

const patchClaimBody = z
  .object({
    status: z.enum(STATUS_VALUES).optional(),
    claimNumber: z.string().trim().max(64).nullable().optional(),
    denialReason: z.string().trim().max(2000).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    submittedAt: z.string().datetime().nullable().optional(),
    decisionAt: z.string().datetime().nullable().optional(),
    paidAt: z.string().datetime().nullable().optional(),
    patientResponsibilityCents: z.number().int().min(0).optional(),
  })
  .strict();

const createLineBody = z
  .object({
    hcpcsCode: z
      .string()
      .trim()
      .max(12)
      .transform((v) => v.toUpperCase())
      .refine((v) => HCPCS_RE.test(v), "must be a HCPCS code like E0601"),
    modifier: z.string().trim().max(32).nullable().optional(),
    description: z.string().trim().max(240).nullable().optional(),
    quantity: z.number().int().min(1).max(9999).default(1),
    billedCents: z.number().int().min(0),
  })
  .strict();

const patchLineBody = z
  .object({
    status: z.enum(LINE_STATUS_VALUES).optional(),
    modifier: z.string().trim().max(32).nullable().optional(),
    description: z.string().trim().max(240).nullable().optional(),
    quantity: z.number().int().min(1).max(9999).optional(),
    billedCents: z.number().int().min(0).optional(),
    allowedCents: z.number().int().min(0).optional(),
    paidCents: z.number().int().min(0).optional(),
    denialReason: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

const createEventBody = z
  .object({
    eventType: z.enum(EVENT_TYPE_VALUES),
    amountCents: z.number().int().min(0).nullable().optional(),
    payerRef: z.string().trim().max(120).nullable().optional(),
    documentId: z.string().uuid().nullable().optional(),
    note: z.string().trim().max(4000).nullable().optional(),
  })
  .strict();

/**
 * Convert a database `insurance_claims` row (snake_case) into the API-facing camelCase shape.
 *
 * @param r - A raw row from the `resupply.insurance_claims` table with snake_case fields
 * @returns An object representing the insurance claim with camelCase property names and equivalent values
 */
function rowToApi(r: {
  id: string;
  insurance_coverage_id: string | null;
  payer_name: string;
  claim_number: string | null;
  date_of_service: string;
  fulfillment_id: string | null;
  status: ClaimStatus;
  total_billed_cents: number;
  total_allowed_cents: number;
  total_paid_cents: number;
  patient_responsibility_cents: number;
  submitted_at: string | null;
  decision_at: string | null;
  paid_at: string | null;
  denial_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}) {
  return {
    id: r.id,
    insuranceCoverageId: r.insurance_coverage_id,
    payerName: r.payer_name,
    claimNumber: r.claim_number,
    dateOfService: r.date_of_service,
    fulfillmentId: r.fulfillment_id,
    status: r.status,
    totalBilledCents: r.total_billed_cents,
    totalAllowedCents: r.total_allowed_cents,
    totalPaidCents: r.total_paid_cents,
    patientResponsibilityCents: r.patient_responsibility_cents,
    submittedAt: r.submitted_at,
    decisionAt: r.decision_at,
    paidAt: r.paid_at,
    denialReason: r.denial_reason,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Recalculates and updates an insurance claim's total billed, allowed, and paid cents from its line items.
 *
 * @param claimId - UUID of the claim whose totals will be recomputed and persisted
 * @throws If a Supabase query or update fails, the underlying error is thrown
 */
async function recomputeTotals(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  claimId: string,
): Promise<void> {
  // Read-modify-write retry loop. PostgREST doesn't expose
  // SELECT FOR UPDATE, so concurrent line-item writes could
  // interleave: writer A reads N lines, writer B inserts a new line
  // and rewrites the total, writer A then overwrites with the
  // pre-B total (stale). Retry up to MAX_RECOMPUTE_RETRIES with
  // optimistic concurrency on `updated_at` until the parent row
  // hasn't drifted between our SELECT and our UPDATE.
  const MAX_RECOMPUTE_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RECOMPUTE_RETRIES; attempt++) {
    const { data: parent, error: parentErr } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select("updated_at")
      .eq("id", claimId)
      .limit(1)
      .maybeSingle();
    if (parentErr) throw parentErr;
    if (!parent) return;
    const observedUpdatedAt = parent.updated_at;

    const { data: lines, error } = await supabase
      .schema("resupply")
      .from("insurance_claim_line_items")
      .select("billed_cents, quantity, allowed_cents, paid_cents")
      .eq("claim_id", claimId);
    if (error) throw error;
    const totals = (lines ?? []).reduce(
      (acc, l) => ({
        // billed_cents is the PER-UNIT charge; the extended line charge
        // (and HCFA Box 24F / 837P SV102) is billed_cents * quantity.
        // allowed/paid come from the payer's 835 as line totals already.
        billed: acc.billed + (l.billed_cents ?? 0) * (l.quantity ?? 1),
        allowed: acc.allowed + (l.allowed_cents ?? 0),
        paid: acc.paid + (l.paid_cents ?? 0),
      }),
      { billed: 0, allowed: 0, paid: 0 },
    );
    const { data: updated, error: updErr } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .update({
        total_billed_cents: totals.billed,
        total_allowed_cents: totals.allowed,
        total_paid_cents: totals.paid,
        updated_at: new Date().toISOString(),
      })
      .eq("id", claimId)
      .eq("updated_at", observedUpdatedAt)
      .select("id");
    if (updErr) throw updErr;
    if (updated && updated.length > 0) return;
    // Parent updated_at moved — concurrent writer landed. Retry.
  }
  // Best-effort fallthrough: under sustained contention, do a final
  // unconditional update so the totals don't stay drifted forever.
  // The next caller will reconverge.
  const { data: linesFinal } = await supabase
    .schema("resupply")
    .from("insurance_claim_line_items")
    .select("billed_cents, quantity, allowed_cents, paid_cents")
    .eq("claim_id", claimId);
  const totalsFinal = (linesFinal ?? []).reduce(
    (acc, l) => ({
      billed: acc.billed + (l.billed_cents ?? 0) * (l.quantity ?? 1),
      allowed: acc.allowed + (l.allowed_cents ?? 0),
      paid: acc.paid + (l.paid_cents ?? 0),
    }),
    { billed: 0, allowed: 0, paid: 0 },
  );
  await supabase
    .schema("resupply")
    .from("insurance_claims")
    .update({
      total_billed_cents: totalsFinal.billed,
      total_allowed_cents: totalsFinal.allowed,
      total_paid_cents: totalsFinal.paid,
      updated_at: new Date().toISOString(),
    })
    .eq("id", claimId);
}

// ── LIST ────────────────────────────────────────────────────────────
router.get(
  "/patients/:id/insurance-claims",
  requireAdmin,
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select(
        "id, insurance_coverage_id, payer_name, claim_number, date_of_service, fulfillment_id, status, total_billed_cents, total_allowed_cents, total_paid_cents, patient_responsibility_cents, submitted_at, decision_at, paid_at, denial_reason, notes, created_at, updated_at",
      )
      .eq("patient_id", idParsed.data.id)
      .order("date_of_service", { ascending: false });
    if (error) throw error;
    res.json({ insuranceClaims: (data ?? []).map(rowToApi) });
  },
);

// ── DETAIL (claim + lines + events) ─────────────────────────────────
router.get(
  "/patients/:id/insurance-claims/:claimId",
  requireAdmin,
  async (req, res) => {
    const idParsed = idAndClaimParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: claim, error } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select(
        "id, patient_id, insurance_coverage_id, payer_name, claim_number, date_of_service, fulfillment_id, status, total_billed_cents, total_allowed_cents, total_paid_cents, patient_responsibility_cents, submitted_at, decision_at, paid_at, denial_reason, notes, created_at, updated_at",
      )
      .eq("id", idParsed.data.claimId)
      .eq("patient_id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!claim) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const [{ data: lines }, { data: events }] = await Promise.all([
      supabase
        .schema("resupply")
        .from("insurance_claim_line_items")
        .select("*")
        .eq("claim_id", claim.id)
        .order("created_at", { ascending: true }),
      supabase
        .schema("resupply")
        .from("insurance_claim_events")
        .select("*")
        .eq("claim_id", claim.id)
        .order("occurred_at", { ascending: false }),
    ]);

    res.json({
      claim: rowToApi(claim),
      lineItems: (lines ?? []).map((l) => ({
        id: l.id,
        hcpcsCode: l.hcpcs_code,
        modifier: l.modifier,
        description: l.description,
        quantity: l.quantity,
        billedCents: l.billed_cents,
        allowedCents: l.allowed_cents,
        paidCents: l.paid_cents,
        status: l.status,
        denialReason: l.denial_reason,
        createdAt: l.created_at,
        updatedAt: l.updated_at,
      })),
      events: (events ?? []).map((e) => ({
        id: e.id,
        eventType: e.event_type,
        amountCents: e.amount_cents,
        payerRef: e.payer_ref,
        documentId: e.document_id,
        note: e.note,
        actorEmail: e.actor_email,
        occurredAt: e.occurred_at,
      })),
    });
  },
);

// ── CREATE ──────────────────────────────────────────────────────────
router.post(
  "/patients/:id/insurance-claims",
  requireAdmin,
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = createClaimBody.safeParse(req.body);
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

    const { data: patient, error: patientErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (patientErr) {
      logger.error({ err: patientErr.message, patientId: idParsed.data.id }, "insurance_claims.create: patient lookup failed");
      throw patientErr;
    }
    if (!patient) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const { data: row, error } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .insert({
        patient_id: idParsed.data.id,
        insurance_coverage_id: b.insuranceCoverageId ?? null,
        payer_name: b.payerName,
        claim_number: b.claimNumber ?? null,
        date_of_service: b.dateOfService,
        fulfillment_id: b.fulfillmentId ?? null,
        notes: b.notes ?? null,
        status: "draft",
      })
      .select("id")
      .single();
    if (error) throw error;

    await logAudit({
      action: "insurance_claim.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "insurance_claims",
      targetId: row.id,
      metadata: {
        patient_id: idParsed.data.id,
        payer_name: b.payerName,
        date_of_service: b.dateOfService,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "insurance_claim.create audit write failed");
    });

    res.status(201).json({ id: row.id });
  },
);

// ── PATCH (status transition + field edits) ─────────────────────────
router.patch(
  "/patients/:id/insurance-claims/:claimId",
  requireAdmin,
  async (req, res) => {
    const idParsed = idAndClaimParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = patchClaimBody.safeParse(req.body);
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

    const { data: current, error: currentErr } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select("id, status")
      .eq("id", idParsed.data.claimId)
      .eq("patient_id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (currentErr) {
      logger.error({ err: currentErr.message, claimId: idParsed.data.claimId }, "insurance_claims.patch: claim lookup failed");
      throw currentErr;
    }
    if (!current) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    if (b.status && b.status !== current.status) {
      const allowed = VALID_TRANSITIONS[current.status as ClaimStatus] ?? [];
      if (!allowed.includes(b.status)) {
        res.status(409).json({
          error: "invalid_transition",
          from: current.status,
          to: b.status,
          allowed,
        });
        return;
      }
    }

    const update: Database["resupply"]["Tables"]["insurance_claims"]["Update"] =
      {
        updated_at: new Date().toISOString(),
      };
    if (b.status !== undefined) update.status = b.status;
    if (b.claimNumber !== undefined) update.claim_number = b.claimNumber;
    if (b.denialReason !== undefined) update.denial_reason = b.denialReason;
    if (b.notes !== undefined) update.notes = b.notes;
    if (b.submittedAt !== undefined) update.submitted_at = b.submittedAt;
    if (b.decisionAt !== undefined) update.decision_at = b.decisionAt;
    if (b.paidAt !== undefined) update.paid_at = b.paidAt;
    if (b.patientResponsibilityCents !== undefined) {
      update.patient_responsibility_cents = b.patientResponsibilityCents;
    }

    // Optimistic-concurrency precondition. We validated the transition
    // against `current.status` (the value we read at the top of the
    // handler), so the UPDATE must only land when the row is still in
    // that state. Without this guard, two concurrent PATCHes from
    // different admins (e.g. "submitted→accepted" and "submitted→
    // denied") both pass the in-memory transition check and both
    // apply; the later writer silently wins, the prior history event
    // misrepresents the chain, and a money-bearing row ends up in
    // the wrong terminal state.
    const { data: updated, error: updErr } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .update(update)
      .eq("id", idParsed.data.claimId)
      .eq("status", current.status)
      .select("id");
    if (updErr) throw updErr;
    if (!updated || updated.length === 0) {
      // Another admin moved the row between our SELECT and our UPDATE.
      res.status(409).json({
        error: "concurrent_modification",
        message:
          "Another team member updated this claim while you were reviewing. Refresh and try again.",
      });
      return;
    }

    // Status change → append history event so the audit reconstruction
    // matches the canonical state machine even if the audit_log row
    // is later archived.
    if (b.status && b.status !== current.status) {
      const eventType =
        b.status === "submitted"
          ? "submitted"
          : b.status === "accepted"
            ? "accepted"
            : b.status === "denied"
              ? "denied"
              : b.status === "paid"
                ? "paid"
                : b.status === "appealed"
                  ? "appealed"
                  : b.status === "closed"
                    ? "closed"
                    : "note";
      await supabase
        .schema("resupply")
        .from("insurance_claim_events")
        .insert({
          claim_id: idParsed.data.claimId,
          event_type: eventType,
          note: b.denialReason ?? null,
          actor_email: req.adminEmail ?? "unknown",
        });
    }

    await logAudit({
      action: "insurance_claim.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "insurance_claims",
      targetId: idParsed.data.claimId,
      metadata: {
        patient_id: idParsed.data.id,
        from_status: current.status,
        to_status: b.status ?? current.status,
        fields_changed: Object.keys(update).filter((k) => k !== "updated_at"),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "insurance_claim.update audit write failed");
    });

    // Publish a webhook event for the status transition so external
    // subscribers (CRM, accounting, reporting BI) can react without
    // polling. Fire-and-forget — the publisher never throws.
    if (b.status && b.status !== current.status) {
      void publishEvent({
        eventType: `claim.${b.status}`,
        payload: {
          claim_id: idParsed.data.claimId,
          patient_id: idParsed.data.id,
          from_status: current.status,
          to_status: b.status,
        },
      });
    }

    res.status(200).json({ ok: true });
  },
);

// ── ADD LINE ITEM ───────────────────────────────────────────────────
router.post(
  "/patients/:id/insurance-claims/:claimId/lines",
  requireAdmin,
  async (req, res) => {
    const idParsed = idAndClaimParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = createLineBody.safeParse(req.body);
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

    const { data: claim, error: claimErr } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select("id, status")
      .eq("id", idParsed.data.claimId)
      .eq("patient_id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (claimErr) {
      logger.error({ err: claimErr.message, claimId: idParsed.data.claimId }, "insurance_claims.lines.create: claim lookup failed");
      throw claimErr;
    }
    if (!claim) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const { data: line, error } = await supabase
      .schema("resupply")
      .from("insurance_claim_line_items")
      .insert({
        claim_id: idParsed.data.claimId,
        hcpcs_code: b.hcpcsCode,
        modifier: b.modifier ?? null,
        description: b.description ?? null,
        quantity: b.quantity,
        billed_cents: b.billedCents,
        status: "pending",
      })
      .select("id")
      .single();
    if (error) throw error;

    await recomputeTotals(supabase, idParsed.data.claimId);

    await logAudit({
      action: "insurance_claim.line.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "insurance_claim_line_items",
      targetId: line.id,
      metadata: {
        claim_id: idParsed.data.claimId,
        patient_id: idParsed.data.id,
        hcpcs_code: b.hcpcsCode,
        billed_cents: b.billedCents,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "insurance_claim.line.create audit write failed");
    });

    res.status(201).json({ id: line.id });
  },
);

// ── PATCH LINE ITEM ─────────────────────────────────────────────────
router.patch(
  "/patients/:id/insurance-claims/:claimId/lines/:lineId",
  requireAdmin,
  async (req, res) => {
    const idParsed = idClaimAndLineParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = patchLineBody.safeParse(req.body);
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

    // Verify ownership: the line must belong to a claim that
    // belongs to the URL's :id patient. Without the patient_id
    // join the route lets an attacker (or a buggy client) patch
    // Patient B's line while the audit row blames Patient A,
    // breaking the §164.312(b) tamper-evident audit invariant.
    const { data: existing, error: existingErr } = await supabase
      .schema("resupply")
      .from("insurance_claim_line_items")
      .select("id, claim_id, insurance_claims!inner(patient_id)")
      .eq("id", idParsed.data.lineId)
      .eq("claim_id", idParsed.data.claimId)
      .eq("insurance_claims.patient_id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (existingErr) {
      logger.error({ err: existingErr.message, lineId: idParsed.data.lineId }, "insurance_claims.lines.patch: line lookup failed");
      throw existingErr;
    }
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const update: Database["resupply"]["Tables"]["insurance_claim_line_items"]["Update"] =
      {
        updated_at: new Date().toISOString(),
      };
    if (b.status !== undefined) update.status = b.status;
    if (b.modifier !== undefined) update.modifier = b.modifier;
    if (b.description !== undefined) update.description = b.description;
    if (b.quantity !== undefined) update.quantity = b.quantity;
    if (b.billedCents !== undefined) update.billed_cents = b.billedCents;
    if (b.allowedCents !== undefined) update.allowed_cents = b.allowedCents;
    if (b.paidCents !== undefined) update.paid_cents = b.paidCents;
    if (b.denialReason !== undefined) update.denial_reason = b.denialReason;

    const { error } = await supabase
      .schema("resupply")
      .from("insurance_claim_line_items")
      .update(update)
      .eq("id", idParsed.data.lineId);
    if (error) throw error;

    await recomputeTotals(supabase, idParsed.data.claimId);

    await logAudit({
      action: "insurance_claim.line.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "insurance_claim_line_items",
      targetId: idParsed.data.lineId,
      metadata: {
        claim_id: idParsed.data.claimId,
        patient_id: idParsed.data.id,
        fields_changed: Object.keys(update).filter((k) => k !== "updated_at"),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "insurance_claim.line.update audit write failed");
    });

    res.status(200).json({ ok: true });
  },
);

// ── APPEND EVENT (EOB receipt, note, partial pay) ───────────────────
router.post(
  "/patients/:id/insurance-claims/:claimId/events",
  requireAdmin,
  async (req, res) => {
    const idParsed = idAndClaimParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = createEventBody.safeParse(req.body);
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

    const { data: claim, error: claimErr } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select("id")
      .eq("id", idParsed.data.claimId)
      .eq("patient_id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (claimErr) {
      logger.error({ err: claimErr.message, claimId: idParsed.data.claimId }, "insurance_claims.events.create: claim lookup failed");
      throw claimErr;
    }
    if (!claim) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const { data: event, error } = await supabase
      .schema("resupply")
      .from("insurance_claim_events")
      .insert({
        claim_id: idParsed.data.claimId,
        event_type: b.eventType,
        amount_cents: b.amountCents ?? null,
        payer_ref: b.payerRef ?? null,
        document_id: b.documentId ?? null,
        note: b.note ?? null,
        actor_email: req.adminEmail ?? "unknown",
      })
      .select("id")
      .single();
    if (error) throw error;

    await logAudit({
      action: "insurance_claim.event.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "insurance_claim_events",
      targetId: event.id,
      metadata: {
        claim_id: idParsed.data.claimId,
        patient_id: idParsed.data.id,
        event_type: b.eventType,
        amount_cents: b.amountCents ?? null,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "insurance_claim.event.create audit write failed");
    });

    // Best-effort EOB explainer email. Fires for paid / partial_pay /
    // denied events because those are the points where the patient
    // would otherwise call us asking "what happened with my claim?"
    // 'submitted', 'accepted', 'appealed', 'closed', 'note' are
    // internal-audience events; we don't email on those.
    //
    // The send is fire-and-forget against the response. A SendGrid
    // outage or a missing patient.email never 500s the admin's
    // event POST.
    const eobKind: "paid" | "partial_pay" | "denied" | null =
      b.eventType === "paid"
        ? "paid"
        : b.eventType === "partial_pay"
          ? "partial_pay"
          : b.eventType === "denied"
            ? "denied"
            : null;
    if (eobKind) {
      void (async () => {
        try {
          const { data: claimFull } = await supabase
            .schema("resupply")
            .from("insurance_claims")
            .select(
              "payer_name, claim_number, date_of_service, total_billed_cents, total_allowed_cents, total_paid_cents, patient_responsibility_cents, denial_reason",
            )
            .eq("id", idParsed.data.claimId)
            .limit(1)
            .maybeSingle();
          if (!claimFull) return;
          const { data: patient } = await supabase
            .schema("resupply")
            .from("patients")
            .select("email, legal_first_name")
            .eq("id", idParsed.data.id)
            .limit(1)
            .maybeSingle();
          if (!patient?.email) return;
          const result = await sendEobExplainerEmail({
            toEmail: patient.email,
            firstName: patient.legal_first_name,
            kind: eobKind,
            payerName: claimFull.payer_name,
            claimNumber: claimFull.claim_number,
            dateOfService: claimFull.date_of_service,
            totals: {
              billedCents: claimFull.total_billed_cents,
              allowedCents: claimFull.total_allowed_cents,
              paidCents: claimFull.total_paid_cents,
              patientResponsibilityCents:
                claimFull.patient_responsibility_cents,
            },
            denialReason: claimFull.denial_reason,
          });
          if (!result.configured) {
            logger.info(
              { eventId: event.id },
              "eob_explainer: skipped — sendgrid not configured",
            );
          } else if (!result.delivered) {
            logger.warn(
              { eventId: event.id, error: result.error },
              "eob_explainer: send failed",
            );
          }
        } catch (sendErr) {
          logger.warn(
            {
              err:
                sendErr instanceof Error ? sendErr.message : String(sendErr),
              eventId: event.id,
            },
            "eob_explainer: send threw (non-fatal)",
          );
        }
      })();
    }

    res.status(201).json({ id: event.id });
  },
);

export default router;
