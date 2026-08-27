// pg-boss job: referrals.adherence-report — send a patient's 90-day CPAP
// adherence attestation to their REFERRING PROVIDER once they reach the
// 90-day therapy mark (Referral CRM Phase 3 / Provider RTM Phase 3).
//
// WHAT IT DOES (first slice)
//   For each ACTIVE tenant with the referrals.adherence_report flag ON, find
//   patients at their ~90-day therapy mark whose referring provider has a fax
//   (preferred) or email on file and who haven't already had a 90-day report
//   sent, render the SAME Medicare LCD L33718 adherence attestation a CSR can
//   download by hand, send it to the referring provider via the tenant's own
//   sender (fax → Telnyx, else email → SendGrid). The send is CLAIMED before
//   the vendor call: a 'sending' row is inserted into
//   resupply.referral_adherence_reports first, and the unique constraint on
//   (org_id, patient_id, provider_id, window_days) is the concurrency guard
//   — a concurrent tick that loses the insert race (23505) SKIPS without
//   sending, so two overlapping workers can never double-disclose. The row
//   is then UPDATEd to 'sent'/'failed'.
//
// SAFETY — this is a PHI DISCLOSURE. Two independent off switches, BOTH
// required for anything to send:
//
//   1. OPT-IN CRON. The queue + worker always register, but the recurring
//      schedule only attaches when REFERRAL_ADHERENCE_REPORT_CRON is set.
//      Dev / preview / a fresh prod never auto-send. Removing the env var
//      unschedules the cron (mirrors auto-submit-batch).
//
//   2. RUNTIME FEATURE FLAG. Even with the cron scheduled, the job checks
//      referrals.adherence_report (seeded DISABLED per-tenant, migration
//      0451) for EACH tenant and no-ops when it's off. The disclosure
//      posture is an explicit owner opt-in.
//
// Iterates ALL active tenants via forEachActiveOrg — NOT seed-org only.
//
// PHI / log posture: the attestation PDF is a permitted treatment/care-
// coordination disclosure to the referring provider. We NEVER log the PDF
// bytes, patient names, or therapy text — counts and ids only. A render/send
// error for one patient logs + records status='failed' and continues; it
// never crashes the tick.

import type PgBoss from "pg-boss";

import { getOrgScopedClient } from "@workspace/resupply-db";
import { createTelnyxFaxClient } from "@workspace/resupply-telecom";

import { createTenantSendgridClient } from "../../lib/email/tenant-sender.js";
import { signAdherenceAttestationFaxToken } from "../../lib/fax-document-token.js";
import { isFeatureEnabled } from "../../lib/feature-flags.js";
import { logger } from "../../lib/logger.js";
import { resolveTenantFaxFrom } from "../../lib/messaging/tenant-telecom.js";
import { recordTenantUsage } from "../../lib/metering/usage.js";
import { renderAdherenceAttestationPdf } from "../../lib/referral-adherence/render.js";
import {
  getFaxPublicBaseUrl,
  isFaxConfigured,
} from "../../routes/admin/physician-fax-outreach.js";
import { forEachActiveOrg } from "../lib/for-each-active-org.js";
import {
  createQueueWithDlq,
  CRON_SCAN_QUEUE_OPTS,
} from "../lib/queue-options.js";

export const REFERRAL_ADHERENCE_REPORT_JOB = "referrals.adherence-report";

/** The therapy window this slice attests to. */
const WINDOW_DAYS = 90;

/** Per-tick cap so one tenant's backlog can't monopolise a tick. */
const MAX_PER_TICK = 50;

interface TickStats {
  orgsScanned: number;
  candidates: number;
  sent: number;
  failed: number;
  skippedNoProvider: number;
  skippedNoContact: number;
  skippedNotDue: number;
  skippedAlreadySent: number;
}

function emptyStats(): TickStats {
  return {
    orgsScanned: 0,
    candidates: 0,
    sent: 0,
    failed: 0,
    skippedNoProvider: 0,
    skippedNoContact: 0,
    skippedNotDue: 0,
    skippedAlreadySent: 0,
  };
}

/** A patient + their resolved referring provider for this tenant. */
interface Candidate {
  patientId: string;
  providerId: string;
  faxE164: string | null;
  email: string | null;
}

/**
 * Build the per-tenant candidate list: patients with a referring provider
 * (preferring insurance_claims.referring_provider_id, falling back to
 * prescriptions.provider_id) where that provider has a fax OR email.
 *
 * NOT capped here. The MAX_PER_TICK cap is applied by runForOrg AFTER the
 * per-patient filters (already-reported / not-yet-due) so it counts only
 * patients actually sent. Capping the raw list here would let a tenant whose
 * first 50 contactable patients are all skipped (already-sent / not-due)
 * starve patient 51+ forever, because the next cron rebuilds the same
 * capped-then-skipped list. Patients already sent a 90-day report are
 * filtered later (per-patient) against referral_adherence_reports.
 */
async function buildCandidates(
  db: ReturnType<typeof getOrgScopedClient>,
  stats: TickStats,
): Promise<Candidate[]> {
  // 1. Referring provider per patient. Claims' referring_provider_id is the
  //    most explicit signal; prescriptions.provider_id is the fallback.
  //    Page past PostgREST max_rows (~1000): a bare high `.limit(...)` silently
  //    truncated, so patients past the first unordered page never entered
  //    the candidate set (and the next cron rebuilt the same truncated list).
  const patientToProvider = new Map<string, string>();
  const PAGE = 1000;

  for (let from = 0; ; from += PAGE) {
    const { data: claimRows, error: claimErr } = await db
      .from("insurance_claims")
      .select("patient_id, referring_provider_id")
      .not("referring_provider_id", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (claimErr) throw claimErr;
    const page = (claimRows ?? []) as Array<{
      patient_id: string | null;
      referring_provider_id: string | null;
    }>;
    for (const r of page) {
      if (r.patient_id && r.referring_provider_id) {
        patientToProvider.set(r.patient_id, r.referring_provider_id);
      }
    }
    if (page.length < PAGE) break;
  }

  for (let from = 0; ; from += PAGE) {
    const { data: rxRows, error: rxErr } = await db
      .from("prescriptions")
      .select("patient_id, provider_id")
      .not("provider_id", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (rxErr) throw rxErr;
    const page = (rxRows ?? []) as Array<{
      patient_id: string;
      provider_id: string | null;
    }>;
    for (const r of page) {
      // Don't overwrite a claims-derived referring provider.
      if (r.provider_id && !patientToProvider.has(r.patient_id)) {
        patientToProvider.set(r.patient_id, r.provider_id);
      }
    }
    if (page.length < PAGE) break;
  }

  if (patientToProvider.size === 0) return [];

  // 2. Resolve provider contact details (fax preferred, email fallback).
  const providerIds = Array.from(new Set(patientToProvider.values()));
  const { data: providerRows, error: provErr } = await db
    .from("providers")
    .select("id, fax_e164, email")
    .in("id", providerIds);
  if (provErr) throw provErr;
  const providerContact = new Map<
    string,
    { faxE164: string | null; email: string | null }
  >();
  for (const p of (providerRows ?? []) as Array<{
    id: string;
    fax_e164: string | null;
    email: string | null;
  }>) {
    providerContact.set(p.id, {
      faxE164: p.fax_e164?.trim() || null,
      email: p.email?.trim() || null,
    });
  }

  const candidates: Candidate[] = [];
  for (const [patientId, providerId] of patientToProvider) {
    const contact = providerContact.get(providerId);
    if (!contact) {
      // Provider row missing (deleted/unresolved) — treat as no contact.
      stats.skippedNoContact += 1;
      continue;
    }
    if (!contact.faxE164 && !contact.email) {
      stats.skippedNoContact += 1;
      continue;
    }
    candidates.push({
      patientId,
      providerId,
      faxE164: contact.faxE164,
      email: contact.email,
    });
  }
  return candidates;
}

/**
 * Compute a patient's therapy anchor (earliest therapy-night date) and
 * whether the 90-day horizon is complete (anchor + 90 days has passed). The
 * worker only discloses once a full 90-day window has elapsed — matching the
 * admin attestation's "final" determination.
 */
async function resolveDueAnchor(
  db: ReturnType<typeof getOrgScopedClient>,
  patientId: string,
): Promise<{ due: boolean; anchorDate: string | null }> {
  const { data, error } = await db
    .from("patient_therapy_nights")
    .select("night_date")
    .eq("patient_id", patientId)
    .order("night_date", { ascending: true })
    .limit(1);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ night_date: string }>;
  const anchorDate = rows[0]?.night_date ?? null;
  if (!anchorDate) return { due: false, anchorDate: null };

  // horizon end = anchor + 89 days (inclusive 90-day window). Due once today
  // is on/after that date.
  const anchor = Date.parse(`${anchorDate}T00:00:00Z`);
  if (Number.isNaN(anchor)) return { due: false, anchorDate };
  const horizonEnd = anchor + (WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000;
  const due = Date.now() >= horizonEnd;
  return { due, anchorDate };
}

/**
 * Send the attestation to the referring provider. Fax preferred (when the
 * provider has a fax AND Telnyx is configured), else email. Returns the
 * outcome for the idempotency record; never throws for a vendor failure
 * (the caller records status='failed' and continues).
 */
async function sendReport(
  orgId: string,
  candidate: Candidate,
  pdf: Buffer,
  anchorDate: string,
): Promise<
  | { status: "sent"; channel: "fax" | "email"; vendorRef: string | null }
  | { status: "failed"; channel: "fax" | "email" }
> {
  // ── Fax (preferred) ──────────────────────────────────────────────────
  if (candidate.faxE164 && isFaxConfigured()) {
    const baseUrl = getFaxPublicBaseUrl()!;
    const token = signAdherenceAttestationFaxToken(
      candidate.patientId,
      anchorDate,
    );
    const mediaUrl = `${baseUrl}/resupply-api/fax/document/${token}`;
    const statusCallbackUrl = `${baseUrl}/resupply-api/fax/webhook`;
    const tenantFrom = await resolveTenantFaxFrom(orgId);
    const fromNumber = tenantFrom ?? process.env.TELNYX_FAX_FROM_NUMBER!.trim();
    try {
      const faxClient = createTelnyxFaxClient();
      const result = await faxClient.sendFax({
        to: candidate.faxE164,
        from: fromNumber,
        mediaUrl,
        statusCallbackUrl,
      });
      void recordTenantUsage({
        orgId,
        metricKey: "faxEvents",
        source: "referral_adherence_report.fax",
      });
      return { status: "sent", channel: "fax", vendorRef: result.id };
    } catch (err) {
      logger.warn(
        {
          event: "referral_adherence_report.fax_failed",
          org_id: orgId,
          provider_id: candidate.providerId,
          // Pass the Error object (not err.message) so the logger's
          // err.message/err.stack redaction applies. TelnyxApiError extends
          // Error, so both branches hit the redaction path.
          err: err instanceof Error ? err : new Error(String(err)),
        },
        "referral-adherence-report: fax dispatch failed",
      );
      // Fall through to email if the provider also has an email on file.
      if (!candidate.email) return { status: "failed", channel: "fax" };
    }
  }

  // ── Email (fallback / no fax) ────────────────────────────────────────
  if (candidate.email) {
    try {
      const sendgrid = await createTenantSendgridClient(orgId);
      const result = await sendgrid.sendEmail({
        to: candidate.email,
        subject: "CPAP Adherence Attestation (90-day)",
        text:
          "Attached is the 90-day CPAP adherence attestation for your " +
          "referred patient, provided for care coordination. This message " +
          "contains protected health information; if you received it in " +
          "error, please delete it and notify the sender.",
        html:
          "<p>Attached is the 90-day CPAP adherence attestation for your " +
          "referred patient, provided for care coordination.</p>" +
          "<p>This message contains protected health information; if you " +
          "received it in error, please delete it and notify the sender.</p>",
        attachments: [
          {
            content: pdf,
            filename: "adherence-attestation.pdf",
            contentType: "application/pdf",
          },
        ],
      });
      return { status: "sent", channel: "email", vendorRef: result.messageId };
    } catch (err) {
      logger.warn(
        {
          event: "referral_adherence_report.email_failed",
          org_id: orgId,
          provider_id: candidate.providerId,
          // Pass the Error object (not err.message) so the logger's
          // err.message/err.stack redaction applies.
          err: err instanceof Error ? err : new Error(String(err)),
        },
        "referral-adherence-report: email send failed",
      );
      return { status: "failed", channel: "email" };
    }
  }

  // No usable channel (shouldn't reach here — candidates are pre-filtered).
  return { status: "failed", channel: "fax" };
}

/** Run the sweep for one tenant. */
async function runForOrg(orgId: string, stats: TickStats): Promise<void> {
  const enabled = await isFeatureEnabled("referrals.adherence_report", orgId);
  if (!enabled) return; // Flag OFF for this tenant — complete no-op.

  stats.orgsScanned += 1;
  const db = getOrgScopedClient(orgId);

  const candidates = await buildCandidates(db, stats);
  // MAX_PER_TICK is applied AFTER the per-patient filters below (counting
  // only patients we actually attempt to send to), NOT against the raw
  // candidate list — see buildCandidates' note. `processed` counts the
  // patients that reached the send step this tick.
  let processed = 0;
  for (const candidate of candidates) {
    if (processed >= MAX_PER_TICK) break;
    try {
      // Idempotency pre-read: skip if a report row already exists for this
      // (patient, provider, window) in ANY state ('sending' claim, 'sent',
      // or 'failed'). This read avoids re-rendering on every tick; the
      // unique-constraint CLAIM below is the hard concurrency backstop.
      const { data: existing, error: existErr } = await db
        .from("referral_adherence_reports")
        .select("id")
        .eq("patient_id", candidate.patientId)
        .eq("provider_id", candidate.providerId)
        .eq("window_days", WINDOW_DAYS)
        .limit(1)
        .maybeSingle();
      if (existErr) throw existErr;
      if (existing) {
        stats.skippedAlreadySent += 1;
        continue;
      }

      // Due check: only disclose once the full 90-day horizon has elapsed.
      const { due, anchorDate } = await resolveDueAnchor(
        db,
        candidate.patientId,
      );
      if (!due || !anchorDate) {
        stats.skippedNotDue += 1;
        continue;
      }

      stats.candidates += 1;

      const rendered = await renderAdherenceAttestationPdf(
        orgId,
        candidate.patientId,
        anchorDate,
      );
      if (!rendered.ok) {
        // No therapy data / patient gone — not "due" in practice. Skip
        // without recording a row so a later data sync can retry.
        stats.skippedNotDue += 1;
        continue;
      }

      // ── CLAIM BEFORE SEND (concurrency guard) ─────────────────────────
      // PHI-disclosure safety: claim the unique
      // (org_id, patient_id, provider_id, window_days) slot BEFORE the
      // vendor call by inserting a 'sending' row. If a concurrent tick /
      // worker already claimed it, this insert hits the unique constraint
      // (23505) and we SKIP without sending — the constraint, not a
      // post-hoc dedup, prevents a duplicate disclosure. Only after a
      // successful claim do we render/send and UPDATE the row to its
      // terminal status. A 'sending' row that never reaches a terminal
      // state (worker crash mid-send) still occupies the slot and is NOT
      // re-sent — the safe default for a PHI disclosure.
      const { data: claimRow, error: claimErr } = await db
        .from("referral_adherence_reports")
        .insert({
          org_id: orgId,
          patient_id: candidate.patientId,
          provider_id: candidate.providerId,
          window_days: WINDOW_DAYS,
          channel: candidate.faxE164 ? "fax" : "email",
          status: "sending",
        })
        .select("id")
        .single();
      if (claimErr) {
        if ((claimErr as { code?: string }).code === "23505") {
          // Another tick/worker already claimed this slot — do NOT send.
          stats.candidates -= 1;
          stats.skippedAlreadySent += 1;
          continue;
        }
        throw claimErr;
      }
      const claimId = (claimRow as { id: string }).id;

      // We hold the claim — now (and only now) send.
      processed += 1;
      const outcome = await sendReport(
        orgId,
        candidate,
        rendered.pdf,
        anchorDate,
      );

      // Transition the claimed row to its terminal status (sent | failed).
      const { error: updateErr } = await db
        .from("referral_adherence_reports")
        .update({
          channel: outcome.channel,
          status: outcome.status,
          vendor_ref: outcome.status === "sent" ? outcome.vendorRef : null,
          sent_at: outcome.status === "sent" ? new Date().toISOString() : null,
        })
        .eq("id", claimId);
      if (updateErr) {
        logger.warn(
          {
            event: "referral_adherence_report.record_failed",
            org_id: orgId,
            provider_id: candidate.providerId,
          },
          "referral-adherence-report: failed to finalize send record",
        );
      }

      if (outcome.status === "sent") stats.sent += 1;
      else stats.failed += 1;
    } catch (err) {
      // One patient's error never blocks the rest of the tenant's worklist.
      stats.failed += 1;
      logger.warn(
        {
          event: "referral_adherence_report.patient_failed",
          org_id: orgId,
          provider_id: candidate.providerId,
          // Pass the Error object (not err.message) so the logger's
          // err.message/err.stack redaction applies.
          err: err instanceof Error ? err : new Error(String(err)),
        },
        "referral-adherence-report: candidate failed — continuing",
      );
    }
  }
}

/** The full tick: fan out across every active tenant. Exported for tests. */
export async function runReferralAdherenceReport(): Promise<TickStats> {
  const stats = emptyStats();
  await forEachActiveOrg((orgId) => runForOrg(orgId, stats), {
    jobName: REFERRAL_ADHERENCE_REPORT_JOB,
  });
  return stats;
}

export async function registerReferralAdherenceReportJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(
    boss,
    REFERRAL_ADHERENCE_REPORT_JOB,
    CRON_SCAN_QUEUE_OPTS,
  );

  await boss.work(REFERRAL_ADHERENCE_REPORT_JOB, async () => {
    const stats = await runReferralAdherenceReport();
    if (stats.sent > 0 || stats.failed > 0) {
      logger.info(
        { event: "referrals.adherence-report.completed", ...stats },
        "referrals.adherence-report: tick",
      );
    }
  });

  const cron = process.env.REFERRAL_ADHERENCE_REPORT_CRON?.trim();
  if (cron) {
    await boss.schedule(REFERRAL_ADHERENCE_REPORT_JOB, cron);
    logger.info(
      { queue: REFERRAL_ADHERENCE_REPORT_JOB, cron },
      "referrals.adherence-report scheduled",
    );
  } else {
    // Removing the env var must actually turn the cron off — clear any
    // previously-persisted schedule (same pattern as auto-submit-batch).
    if (typeof boss.unschedule === "function") {
      await boss
        .unschedule(REFERRAL_ADHERENCE_REPORT_JOB)
        .catch(() => undefined);
    }
    logger.info(
      { queue: REFERRAL_ADHERENCE_REPORT_JOB },
      "referrals.adherence-report registered (cron opt-in unset; no-op)",
    );
  }
}
