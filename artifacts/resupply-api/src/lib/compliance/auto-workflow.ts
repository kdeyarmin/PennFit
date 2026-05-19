// Compliance auto-workflow passes.
//
// Mirror of `lib/billing/auto-workflow-engine.ts` for the Phase 10
// compliance machinery. Three idempotent passes that run every 5
// minutes and emit webhook events when a compliance gap crosses a
// threshold:
//
//   1. BAA EXPIRY — for each non-terminated BAA expiring within 60
//      days, publish `compliance.baa_expiring_soon` once per cooldown
//      window. For each expired BAA, publish `compliance.baa_expired`.
//   2. OIG SCREENING OVERDUE — if no LEIE screening landed in the
//      last 35 days, publish `compliance.oig_screening_overdue`.
//   3. PATIENT RIGHTS OVERDUE — for each open rights request whose
//      30-day clock has elapsed (no extension granted) or whose
//      60-day extended clock has elapsed, publish
//      `compliance.patient_rights_overdue`.
//
// Cooldown posture: events are de-duped by piggy-backing on the
// resupply.audit_log row write — each emission gets one row with a
// deterministic `targetId` that subsequent runs can `count(*)`
// against in the cooldown window. We DON'T add a dedicated cooldown
// table because (a) the audit_log is the system-of-record for "did
// this happen", (b) the cooldown windows are coarse (24 hours), and
// (c) we already write audit-log rows for the operator actions, so
// the cooldown read is a one-row index lookup.
//
// PHI posture: IDs + slugs + counts only. Patient rights payloads
// carry the patient_id (acceptable — subscribers fetch enrichment).

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../logger";
import { publishEvent } from "../webhooks/publisher";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

const COOLDOWN_HOURS = 24;
const BAA_EXPIRING_DAYS = 60;
const OIG_OVERDUE_DAYS = 35;

export interface ComplianceWorkflowStats {
  baaExpiringPublished: number;
  baaExpiredPublished: number;
  oigOverduePublished: number;
  rightsOverduePublished: number;
  errors: number;
}

export async function runComplianceWorkflowPass(): Promise<ComplianceWorkflowStats> {
  const stats: ComplianceWorkflowStats = {
    baaExpiringPublished: 0,
    baaExpiredPublished: 0,
    oigOverduePublished: 0,
    rightsOverduePublished: 0,
    errors: 0,
  };
  const supabase = getSupabaseServiceRoleClient();
  await runBaaExpiryPass(supabase, stats);
  await runOigOverduePass(supabase, stats);
  await runRightsOverduePass(supabase, stats);
  return stats;
}

// ── Pass 1: BAA expiry ──────────────────────────────────────────────

async function runBaaExpiryPass(
  supabase: SupabaseClient,
  stats: ComplianceWorkflowStats,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const warnCutoff = new Date(
    Date.now() + BAA_EXPIRING_DAYS * 24 * 3600 * 1000,
  )
    .toISOString()
    .slice(0, 10);
  const { data: rows } = await supabase
    .schema("resupply")
    .from("business_associate_agreements")
    .select("id, vendor_slug, vendor_kind, agreement_expires_on, status")
    .neq("status", "terminated")
    .not("agreement_expires_on", "is", null)
    .lte("agreement_expires_on", warnCutoff);
  for (const row of rows ?? []) {
    if (!row.agreement_expires_on) continue;
    const expired = row.agreement_expires_on < today;
    const auditAction = expired
      ? "compliance.baa_expired.published"
      : "compliance.baa_expiring_soon.published";
    if (await isOnCooldown(supabase, auditAction, row.id)) continue;
    try {
      await publishEvent({
        eventType: expired
          ? "compliance.baa_expired"
          : "compliance.baa_expiring_soon",
        payload: {
          baa_id: row.id,
          vendor_slug: row.vendor_slug,
          vendor_kind: row.vendor_kind,
          expires_on: row.agreement_expires_on,
        },
      });
      await stampCooldown(auditAction, row.id);
      if (expired) stats.baaExpiredPublished += 1;
      else stats.baaExpiringPublished += 1;
    } catch (err) {
      stats.errors += 1;
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), baa_id: row.id },
        "compliance.baa_expiry.publish failed",
      );
    }
  }
}

// ── Pass 2: OIG screening overdue ───────────────────────────────────

async function runOigOverduePass(
  supabase: SupabaseClient,
  stats: ComplianceWorkflowStats,
): Promise<void> {
  const cutoff = new Date(
    Date.now() - OIG_OVERDUE_DAYS * 24 * 3600 * 1000,
  ).toISOString();
  const { data: recent } = await supabase
    .schema("resupply")
    .from("oig_leie_screenings")
    .select("id")
    .gte("screened_at", cutoff)
    .limit(1);
  if (recent && recent.length > 0) return;
  // Singleton event — pin by the literal "system" target so the
  // cooldown gate is shared across runs.
  const auditAction = "compliance.oig_screening_overdue.published";
  const targetId = "00000000-0000-0000-0000-000000000000";
  if (await isOnCooldown(supabase, auditAction, targetId)) return;
  try {
    await publishEvent({
      eventType: "compliance.oig_screening_overdue",
      payload: {
        cutoff_days: OIG_OVERDUE_DAYS,
        cutoff_at: cutoff,
      },
    });
    await stampCooldown(auditAction, targetId);
    stats.oigOverduePublished += 1;
  } catch (err) {
    stats.errors += 1;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "compliance.oig_overdue.publish failed",
    );
  }
}

// ── Pass 3: patient rights overdue ──────────────────────────────────

async function runRightsOverduePass(
  supabase: SupabaseClient,
  stats: ComplianceWorkflowStats,
): Promise<void> {
  const now = Date.now();
  const t30d = new Date(now - 30 * 24 * 3600 * 1000).toISOString();
  const t60d = new Date(now - 60 * 24 * 3600 * 1000).toISOString();
  const { data: rows } = await supabase
    .schema("resupply")
    .from("patient_rights_requests")
    .select(
      "id, patient_id, request_kind, status, received_at, extension_granted_at",
    )
    .in("status", ["received", "in_review", "extended"])
    .lte("received_at", t30d);
  for (const r of rows ?? []) {
    // Extended path: only overdue once 60d elapsed.
    if (r.extension_granted_at && r.received_at > t60d) continue;
    const auditAction = "compliance.patient_rights_overdue.published";
    if (await isOnCooldown(supabase, auditAction, r.id)) continue;
    try {
      await publishEvent({
        eventType: "compliance.patient_rights_overdue",
        payload: {
          request_id: r.id,
          patient_id: r.patient_id,
          request_kind: r.request_kind,
          received_at: r.received_at,
          extended: r.extension_granted_at != null,
        },
      });
      await stampCooldown(auditAction, r.id);
      stats.rightsOverduePublished += 1;
    } catch (err) {
      stats.errors += 1;
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          request_id: r.id,
        },
        "compliance.patient_rights_overdue.publish failed",
      );
    }
  }
}

// ── Cooldown helpers ────────────────────────────────────────────────
//
// Each cooldown bucket is keyed by (audit action, target id). We
// check the audit_log row written by the prior pass; if one exists
// inside the 24-hour window, we skip. Same row also serves as the
// "we published this" tamper-evident receipt for the surveyor.

async function isOnCooldown(
  supabase: SupabaseClient,
  action: string,
  targetId: string,
): Promise<boolean> {
  const cutoff = new Date(
    Date.now() - COOLDOWN_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const { data } = await supabase
    .schema("resupply")
    .from("audit_log")
    .select("id")
    .eq("action", action)
    .eq("target_id", targetId)
    .gte("occurred_at", cutoff)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

async function stampCooldown(action: string, targetId: string): Promise<void> {
  await logAudit({
    action,
    adminEmail: null,
    adminUserId: null,
    targetTable: "compliance_workflow",
    targetId,
    metadata: { source: "compliance.auto_workflow" },
    ip: null,
    userAgent: null,
  }).catch((err) => {
    logger.warn({ err }, `${action}: audit write failed`);
  });
}
