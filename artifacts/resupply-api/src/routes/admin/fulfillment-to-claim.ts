// POST /admin/fulfillments/:fulfillmentId/create-claim
//
// One-click claim creation. Given a fulfillment row, runs the
// claim-builder to assemble a fully-populated draft + inserts:
//   * one insurance_claims row,
//   * N insurance_claim_line_items rows,
//   * one insurance_claim_events row for the 'note' kind so the
//     reconstruction shows "built from fulfillment X by CSR Y".
//
// On success returns the new claim id + the builder's notes (so the
// UI can immediately show the CSR what was auto-resolved vs left
// blank). On a hard prereq failure (fulfillment missing) returns 404.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  buildClaimFromFulfillment,
  buildClaimLineRows,
} from "../../lib/billing/claim-builder";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const params = z.object({ fulfillmentId: z.string().uuid() });

const body = z
  .object({
    dateOfService: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
      .nullable()
      .optional(),
    payerProfileId: z.string().uuid().nullable().optional(),
    /** Free-text note attached to the initial event row. */
    note: z.string().trim().max(2000).optional(),
  })
  .strict()
  .optional();

router.post(
  "/admin/fulfillments/:fulfillmentId/create-claim",
  // CSRs working the billing queue need this; gate behind the same
  // permission as the other claim writes.
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "fulfillments.create_claim", preset: "mutation" }),
  async (req, res) => {
    const idParsed = params.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const bodyParsed = body.safeParse(req.body ?? {});
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

    let proposed;
    try {
      proposed = await buildClaimFromFulfillment({
        fulfillmentId: idParsed.data.fulfillmentId,
        dateOfServiceOverride: bodyParsed.data?.dateOfService ?? null,
        payerProfileIdOverride: bodyParsed.data?.payerProfileId ?? null,
      });
    } catch (err) {
      if (err instanceof Error && /not found/i.test(err.message)) {
        res.status(404).json({ error: "fulfillment_not_found" });
        return;
      }
      throw err;
    }

    const supabase = getSupabaseServiceRoleClient();

    // Insert the claim header.
    const { data: claimRow, error: claimErr } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .insert({
        patient_id: proposed.patientId,
        insurance_coverage_id: proposed.insuranceCoverageId,
        secondary_coverage_id: proposed.secondaryCoverageId,
        payer_name: proposed.payerName,
        date_of_service: proposed.dateOfService,
        fulfillment_id: proposed.fulfillmentId,
        payer_profile_id: proposed.payerProfileId,
        referring_provider_id: proposed.referringProviderId,
        rendering_provider_id: proposed.renderingProviderId,
        status: "draft",
        total_billed_cents: proposed.lines.reduce(
          (s, l) => s + l.billedCents * l.quantity,
          0,
        ),
      })
      .select("id")
      .single();
    if (claimErr) throw claimErr;

    // Insert the line items (carrying the per-unit COGS snapshot the
    // builder resolved from product_costs — migration 0193).
    if (proposed.lines.length > 0) {
      const lineRows = buildClaimLineRows(
        claimRow.id,
        proposed.lines,
        new Date().toISOString(),
      );
      const { error: lineErr } = await supabase
        .schema("resupply")
        .from("insurance_claim_line_items")
        .insert(lineRows);
      if (lineErr) throw lineErr;
    }

    // Initial event row capturing the builder breadcrumbs.
    const noteParts: string[] = [
      `Built from fulfillment ${proposed.fulfillmentId} by ${req.adminEmail ?? "unknown"}.`,
    ];
    if (bodyParsed.data?.note) noteParts.push(bodyParsed.data.note);
    if (proposed.builderNotes.length > 0) {
      noteParts.push(`Builder notes: ${proposed.builderNotes.join(" ")}`);
    }
    await supabase
      .schema("resupply")
      .from("insurance_claim_events")
      .insert({
        claim_id: claimRow.id,
        event_type: "note",
        note: noteParts.join(" "),
        actor_email: req.adminEmail ?? "unknown",
      });

    await logAudit({
      action: "insurance_claim.create_from_fulfillment",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "insurance_claims",
      targetId: claimRow.id,
      metadata: {
        patient_id: proposed.patientId,
        fulfillment_id: proposed.fulfillmentId,
        payer_profile_id: proposed.payerProfileId,
        line_count: proposed.lines.length,
        builder_notes_count: proposed.builderNotes.length,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "insurance_claim.create_from_fulfillment audit write failed",
      );
    });

    res.status(201).json({
      id: claimRow.id,
      patientId: proposed.patientId,
      lineCount: proposed.lines.length,
      builderNotes: proposed.builderNotes,
      proposed: {
        payerProfileId: proposed.payerProfileId,
        payerName: proposed.payerName,
        diagnosisCodes: proposed.diagnosisCodes,
        renderingProviderId: proposed.renderingProviderId,
        referringProviderId: proposed.referringProviderId,
        priorAuthNumber: proposed.priorAuthNumber,
        lines: proposed.lines.map((l) => ({
          hcpcsCode: l.hcpcsCode,
          modifiers: l.modifiers,
          quantity: l.quantity,
          billedCents: l.billedCents,
          sourceKind: l.sourceKind,
          feeScheduleRowId: l.feeScheduleRowId,
        })),
      },
    });
  },
);

export default router;
