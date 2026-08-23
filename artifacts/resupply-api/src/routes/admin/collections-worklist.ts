// Patient AR collections worklist (migration 0461).
//
//   GET   /admin/billing/collections-worklist   — active/paused dunning runs
//   POST  /admin/billing/collections/:id/pause   — manual hold (dispute, etc.)
//   POST  /admin/billing/collections/:id/resolve — written off / paid by hand
//   POST  /admin/billing/collections/:id/cancel  — stop dunning this balance
//   GET   /admin/billing/collections/agency-export — CSV of agency-step runs
//
// Gated behind the collections.dunning flag (agency-export additionally behind
// collections.agency_export). reports.read to view; patients.update to manage.
// PHI: amounts + reason codes only — no message bodies.

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { type Database, getOrgScopedClient } from "@workspace/resupply-db";
import { nextDunningStep } from "@workspace/resupply-domain";

import { resolveBillingIdentity } from "../../lib/billing/identity-resolver";
import { renderDunningLettersBatchPdf } from "../../lib/billing/dunning-letter-pdf";
import { isFeatureEnabled } from "../../lib/feature-flags";
import { redactDbErr } from "../../lib/redact-db-err";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get(
  "/admin/billing/collections-worklist",
  requirePermission("reports.read"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    if (!(await isFeatureEnabled("collections.dunning", orgId))) {
      res.status(404).json({ error: "feature_disabled" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data } = await supabase
      .from("patient_dunning_runs")
      .select(
        "id, patient_id, opened_balance_cents, current_step, next_action_at, status, paused_reason, opened_on, last_step_at",
      )
      .in("status", ["active", "paused"])
      .order("opened_balance_cents", { ascending: false })
      .limit(500);
    const items = (data ?? []) as Array<{
      id: string;
      patient_id: string;
      opened_balance_cents: number;
      current_step: string;
      next_action_at: string | null;
      status: string;
      paused_reason: string | null;
      opened_on: string;
      last_step_at: string | null;
    }>;
    res.json({
      items,
      counts: {
        total: items.length,
        active: items.filter((i) => i.status === "active").length,
        paused: items.filter((i) => i.status === "paused").length,
        atAgency: items.filter((i) => i.current_step === "agency").length,
        totalBalanceCents: items.reduce(
          (s, i) => s + (i.opened_balance_cents ?? 0),
          0,
        ),
      },
    });
  },
);

const idParams = z.object({ id: z.string().uuid() });

async function transition(
  req: Request,
  res: Response,
  action: "pause" | "resolve" | "cancel",
): Promise<void> {
  const p = idParams.safeParse(req.params);
  if (!p.success) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const orgId = req.orgId;
  if (!orgId) {
    res.status(500).json({ error: "tenant_context_missing" });
    return;
  }
  if (!(await isFeatureEnabled("collections.dunning", orgId))) {
    res.status(404).json({ error: "feature_disabled" });
    return;
  }
  const supabase = getOrgScopedClient(orgId);
  const update: Database["resupply"]["Tables"]["patient_dunning_runs"]["Update"] =
    { updated_at: new Date().toISOString(), next_action_at: null };
  if (action === "pause") {
    update.status = "paused";
    update.paused_reason = "manual_hold";
  } else if (action === "resolve") {
    update.status = "resolved";
    update.resolved_reason = "written_off";
  } else {
    update.status = "cancelled";
  }
  const { data: updatedRows, error } = await supabase
    .from("patient_dunning_runs")
    .update(update)
    .eq("id", p.data.id)
    .select("id, current_step");
  if (error) throw error;
  // PostgREST reports no error when zero rows match (unknown id, or a run
  // owned by another tenant). Without this guard the route would log a
  // dunning event against a non-existent run and falsely report success.
  const updatedRun = updatedRows?.[0];
  if (!updatedRun) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  // Distinct, schema-valid outcome per action: a cancel previously shared
  // "paused", conflating a terminal cancel with a resumable pause. (The
  // outcome CHECK has no "cancelled"; a cancelled run skips its remaining
  // ladder, so "skipped" is the closest valid code — `detail` still records
  // the exact `manual_cancel`.)
  const eventOutcome =
    action === "resolve"
      ? "resolved"
      : action === "pause"
        ? "paused"
        : "skipped";
  await supabase.from("patient_dunning_events").insert({
    run_id: p.data.id,
    // Log against the run's actual ladder step, not a hardcoded "statement"
    // (matches the dunning-engine's logEvent).
    step: updatedRun.current_step,
    channel: "none",
    outcome: eventOutcome,
    detail: `manual_${action}`,
    actor_email: req.adminEmail ?? null,
  });

  await logAudit({
    action: `dunning.${action}`,
    adminEmail: req.adminEmail ?? null,
    adminUserId: req.adminUserId ?? null,
    targetTable: "patient_dunning_runs",
    targetId: p.data.id,
    metadata: { action },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  }).catch((err) =>
    logger.warn(
      { err: redactDbErr(err) },
      `dunning.${action} audit write failed`,
    ),
  );

  res.json({ ok: true });
}

router.post(
  "/admin/billing/collections/:id/pause",
  requirePermission("patients.update"),
  adminRateLimit({ name: "dunning.pause", preset: "mutation" }),
  (req, res) => void transition(req, res, "pause"),
);
router.post(
  "/admin/billing/collections/:id/resolve",
  requirePermission("patients.update"),
  adminRateLimit({ name: "dunning.resolve", preset: "mutation" }),
  (req, res) => void transition(req, res, "resolve"),
);
router.post(
  "/admin/billing/collections/:id/cancel",
  requirePermission("patients.update"),
  adminRateLimit({ name: "dunning.cancel", preset: "mutation" }),
  (req, res) => void transition(req, res, "cancel"),
);

// CSV export of agency-step runs for a collections agency. Formula-injection
// guarded. Separately flag-gated — nothing leaves the building automatically.
function csvCell(value: string): string {
  const needsGuard = /^[=+\-@]/.test(value);
  const safe = needsGuard ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

router.get(
  "/admin/billing/collections/agency-export",
  requirePermission("patients.update"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    if (
      !(await isFeatureEnabled("collections.dunning", orgId)) ||
      !(await isFeatureEnabled("collections.agency_export", orgId))
    ) {
      res.status(404).json({ error: "feature_disabled" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data } = await supabase
      .from("patient_dunning_runs")
      .select("id, patient_id, opened_balance_cents, opened_on, last_step_at")
      .eq("status", "active")
      .eq("current_step", "agency")
      .order("opened_balance_cents", { ascending: false })
      .limit(2000);
    const rows = (data ?? []) as Array<{
      id: string;
      patient_id: string;
      opened_balance_cents: number;
      opened_on: string;
      last_step_at: string | null;
    }>;
    const header = [
      "run_id",
      "patient_id",
      "balance_usd",
      "opened_on",
      "last_contact",
    ];
    const lines = [header.map(csvCell).join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.id,
          r.patient_id,
          (r.opened_balance_cents / 100).toFixed(2),
          r.opened_on,
          r.last_step_at ?? "",
        ]
          .map((v) => csvCell(String(v)))
          .join(","),
      );
    }
    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="collections-agency-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).send(lines.join("\r\n"));
  },
);

// GET letter-batch — a print batch of final-notice letters for runs at the
// `final_notice` step. The dunning ladder's letter channel isn't sent
// electronically; this produces the PDF to fold and mail.
router.get(
  "/admin/billing/collections/letter-batch",
  requirePermission("patients.update"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    if (!(await isFeatureEnabled("collections.dunning", orgId))) {
      res.status(404).json({ error: "feature_disabled" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data: runRows } = await supabase
      .from("patient_dunning_runs")
      .select("id, patient_id, opened_balance_cents, opened_on")
      .eq("status", "active")
      .eq("current_step", "final_notice")
      .order("opened_balance_cents", { ascending: false })
      .limit(500);
    const runs = (runRows ?? []) as Array<{
      id: string;
      patient_id: string;
      opened_balance_cents: number;
      opened_on: string;
    }>;
    if (runs.length === 0) {
      res.status(404).json({ error: "no_letters_due" });
      return;
    }

    const { data: patientRows } = await supabase
      .from("patients")
      .select("id, legal_first_name, legal_last_name, address")
      .in(
        "id",
        runs.map((r) => r.patient_id),
      );
    const patients = new Map(
      (
        (patientRows ?? []) as Array<{
          id: string;
          legal_first_name: string;
          legal_last_name: string;
          address: {
            line1?: string;
            line2?: string;
            city?: string;
            state?: string;
            zip?: string;
          } | null;
        }>
      ).map((p) => [p.id, p]),
    );

    const identity = await resolveBillingIdentity({ orgId });
    const bp = identity.billingProvider;

    // Keep each rendered letter paired with the run it came from, so the
    // events + ladder advancement below touch ONLY the runs we actually
    // printed (a run whose patient row is missing is skipped entirely).
    const printed = runs.flatMap((run) => {
      const p = patients.get(run.patient_id);
      if (!p) return [];
      const a = p.address ?? {};
      const addressLines = [
        a.line1,
        a.line2,
        [a.city, a.state, a.zip].filter(Boolean).join(", "),
      ].filter((l): l is string => !!l && l.trim().length > 0);
      return [
        {
          run,
          letter: {
            patientName: `${p.legal_first_name} ${p.legal_last_name}`,
            addressLines,
            balanceCents: run.opened_balance_cents,
          },
        },
      ];
    });
    if (printed.length === 0) {
      res.status(404).json({ error: "no_letters_due" });
      return;
    }
    const letters = printed.map((x) => x.letter);

    const { pdf, letterCount } = await renderDunningLettersBatchPdf({
      company: {
        legalName: identity.organization?.legal_name ?? bp.organizationName,
        addressLines: [
          bp.address.line1,
          `${bp.address.city}, ${bp.address.state} ${bp.address.zip}`,
        ].filter(Boolean),
        phone: identity.organization?.phone_e164 ?? null,
      },
      letters,
      generatedOn: new Date(),
    });

    // Record a letter touch on each printed run for the audit trail.
    const nowIso = new Date().toISOString();
    await supabase.from("patient_dunning_events").insert(
      printed.map(({ run }) => ({
        run_id: run.id,
        step: "final_notice",
        channel: "letter" as const,
        outcome: "sent" as const,
        detail: "print_batch",
        amount_at_touch_cents: run.opened_balance_cents,
        actor_email: req.adminEmail ?? null,
        occurred_at: nowIso,
      })),
    );

    // Advance each printed run off `final_notice` so the ladder doesn't
    // re-print or let the next tick send another final notice before the
    // agency-handoff date. final_notice → agency (dayOffset 60 from open).
    await Promise.all(
      printed.map(({ run }) => {
        const next = nextDunningStep("final_notice", run.opened_on);
        if (!next) return Promise.resolve();
        return supabase
          .from("patient_dunning_runs")
          .update({
            current_step: next.step,
            next_action_at: `${next.nextActionAt}T00:00:00Z`,
            last_step_at: nowIso,
            updated_at: nowIso,
          })
          .eq("id", run.id)
          .then(() => undefined);
      }),
    );

    await logAudit({
      action: "dunning.letter_batch",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_dunning_runs",
      targetId: null,
      metadata: { letter_count: letterCount },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) =>
      logger.warn(
        { err: redactDbErr(err) },
        "dunning.letter_batch audit write failed",
      ),
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="dunning-letters-${nowIso.slice(0, 10)}.pdf"`,
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Dunning-Letter-Count", String(letterCount));
    res.status(200).end(pdf);
  },
);

export default router;
