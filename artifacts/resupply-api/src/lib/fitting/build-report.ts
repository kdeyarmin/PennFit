/**
 * Assemble a `FitReport` from a stored fit session.
 *
 * The impure counterpart to `fit-report.ts` (which is a pure projection):
 * this file does the reads and hands the pure layer a plain object.
 *
 * The central rule: read STORED provenance, never recompute it. The
 * formulary version, rules-engine version, catalog snapshot, and the
 * recommendation itself all come off the row as they were written at
 * assessment time. A report reprinted a year from now must show the rules
 * that actually ran — recomputing would quietly rewrite history.
 */

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../logger";
import { getCompanyInfo } from "../company-info";
import {
  FIT_REPORT_DISCLAIMER,
  profileAsQA,
  type FitReport,
  type FitReportEvent,
} from "./fit-report.js";
import type {
  ExclusionRecord,
  FitCandidate,
  FitOutcome,
  FitProfile,
} from "./types.js";

const GUIDANCE: Record<FitOutcome, string> = {
  high_confidence:
    "Clear match. This fitting can proceed through the normal workflow.",
  moderate_confidence:
    "Good match, but a clinician should review it before the order ships.",
  low_confidence:
    "Not enough evidence for an automated recommendation. A fresh scan or a manual fitting is needed.",
  contraindicated:
    "Every candidate was ruled out on safety or therapy compatibility. A respiratory therapist should fit this patient personally.",
  outside_validated_range:
    "The measurements fall outside the range the sizing data covers, so no automated recommendation was made.",
};

type Row = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function record(v: unknown): Record<string, number> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const n = numOrNull(val);
    if (n !== null) out[k] = n;
  }
  return out;
}

/**
 * The org-scoped facade returns an untyped builder, so PostgREST results
 * arrive as `unknown`. These two narrow at the boundary and swallow the
 * error: a missing sub-query degrades one section of the report rather
 * than failing the whole document.
 */
async function rows(query: PromiseLike<unknown>): Promise<Row[]> {
  try {
    const r = (await query) as { data: Row[] | null };
    return Array.isArray(r?.data) ? r.data : [];
  } catch {
    return [];
  }
}

async function single(query: PromiseLike<unknown>): Promise<Row | null> {
  try {
    const r = (await query) as { data: Row | null };
    return r?.data ?? null;
  } catch {
    return null;
  }
}

export async function buildFitReport(
  orgId: string,
  fitSessionId: string,
): Promise<FitReport | null> {
  const supabase = getOrgScopedClient(orgId);

  const { data, error } = (await supabase
    .from("fit_sessions")
    .select("*")
    .eq("id", fitSessionId)
    .limit(1)
    .maybeSingle()) as { data: Row | null; error: { message: string } | null };

  if (error || !data) {
    if (error) {
      logger.warn(
        { fitSessionId, message: error.message },
        "fit report: session lookup failed",
      );
    }
    return null;
  }

  const [company, safetyRows, eventRows, patientRow, catalogNames] =
    await Promise.all([
      getCompanyInfo(orgId).catch(() => null),
      rows(
        supabase
          .from("fit_session_safety_responses")
          .select("question_key, subject, answer")
          .eq("fit_session_id", fitSessionId),
      ),
      rows(
        supabase
          .from("fit_session_events")
          .select("event_type, actor_kind, actor_email, detail, occurred_at")
          .eq("fit_session_id", fitSessionId)
          .order("occurred_at", { ascending: true }),
      ),
      data.patient_id
        ? single(
            supabase
              .from("patients")
              .select("first_name, last_name, date_of_birth")
              .eq("id", String(data.patient_id))
              .limit(1)
              .maybeSingle(),
          )
        : Promise.resolve(null),
      resolveMaskNames(orgId, [
        str(data.override_mask_model_id),
        str(data.ordered_mask_model_id),
      ]),
    ]);

  const profile = (data.profile_answers ?? null) as Partial<FitProfile> | null;
  const outcome = (data.outcome ?? null) as FitOutcome | null;

  // Prompts live on the question set, but the responses table stores the
  // key. Fall back to a readable form of the key rather than dropping the
  // answer — an unlabelled "yes" is still evidence.
  const snapshot = data.safety_snapshot as {
    questions?: Array<{ questionKey: string; prompt: string }>;
    attestationCopy?: string;
  } | null;
  const promptByKey = new Map(
    (snapshot?.questions ?? []).map((q) => [q.questionKey, q.prompt]),
  );

  const events: FitReportEvent[] = eventRows.map((e: Row) => ({
    eventType: String(e.event_type),
    actorKind: String(e.actor_kind),
    actorEmail: str(e.actor_email),
    occurredAt: String(e.occurred_at),
    detail: (e.detail ?? null) as FitReportEvent["detail"],
  }));

  const patientName = patientRow
    ? [str(patientRow.first_name), str(patientRow.last_name)]
        .filter(Boolean)
        .join(" ") || null
    : null;

  return {
    header: {
      practiceName: company?.name ?? "CareMetric Breathe",
      locationName: null,
      generatedAt: new Date().toISOString(),
      reportId: fitSessionId,
    },
    patient: {
      name: patientName,
      dateOfBirth: patientRow ? str(patientRow.date_of_birth) : null,
      patientRef: str(data.patient_id),
    },
    session: {
      id: fitSessionId,
      createdAt: String(data.created_at),
      population: String(data.population ?? "adult"),
      serviceLine: String(data.service_line ?? "pap"),
      entryPoint: String(data.entry_point ?? "remote_link"),
      outcome,
      confidence: numOrNull(data.recommendation_confidence),
      guidance: outcome ? GUIDANCE[outcome] : "",
    },
    capture: {
      scanDateTime: String(data.created_at),
      frameCount: Number(data.frame_count ?? 1),
      calibrationMethod: str(data.calibration_method),
      measurementConfidence: numOrNull(data.measurement_confidence),
      band: (data.measurement_confidence_band ?? null) as
        | "high"
        | "moderate"
        | "low"
        | null,
      grade: (data.scan_quality_grade ?? null) as
        | "good"
        | "marginal"
        | "poor"
        | null,
      quality: record(data.scan_quality),
      agreement: record(data.measurement_agreement),
    },
    measurements: record(data.measurements),
    profile: profileAsQA(profile),
    safety: {
      screenVersion: str(data.safety_screen_version),
      attestedAt: str(data.safety_attested_at),
      attestationCopy: snapshot?.attestationCopy ?? null,
      responses: safetyRows.map((s: Row) => ({
        prompt:
          promptByKey.get(String(s.question_key)) ??
          String(s.question_key).replace(/_/g, " "),
        subject: String(s.subject) as "patient" | "household",
        answer: String(s.answer) as "yes" | "no" | "unsure",
      })),
      flags: Array.isArray(data.safety_flags)
        ? (data.safety_flags as string[])
        : [],
    },
    primary: (data.primary_recommendation ?? null) as FitCandidate | null,
    alternatives: Array.isArray(data.alternatives)
      ? (data.alternatives as unknown as FitCandidate[])
      : [],
    excluded: Array.isArray(data.excluded)
      ? (data.excluded as unknown as ExclusionRecord[])
      : [],
    provenance: {
      rulesEngineVersion: String(data.rules_engine_version ?? "unknown"),
      catalogSnapshotVersion: numOrNull(data.catalog_snapshot_version),
      formularyName: null,
      formularyVersion: numOrNull(data.formulary_version),
      formularyRulesMatched: (data.formulary_rules_matched ??
        null) as FitReport["provenance"]["formularyRulesMatched"],
      degraded: Boolean(data.degraded),
    },
    review: {
      status: String(data.review_status ?? "not_required"),
      reviewerEmail: str(data.reviewed_by_email),
      reviewedAt: str(data.reviewed_at),
      decision: str(data.review_status),
      overrideFrom:
        (data.primary_recommendation as { name?: string } | null)?.name ?? null,
      overrideTo:
        catalogNames.get(str(data.override_mask_model_id) ?? "") ?? null,
      overrideReason: str(data.override_reason),
    },
    dispensing: {
      orderedMask:
        catalogNames.get(str(data.ordered_mask_model_id) ?? "") ?? null,
      orderedSize: null,
      orderId: str(data.shop_order_id),
      dispensedAt: str(data.dispensed_at),
    },
    auditTrail: events,
    disclaimer: FIT_REPORT_DISCLAIMER,
  };
}

/**
 * Resolve mask ids to display names for the override / dispensed lines.
 *
 * Reference-catalog read: `mask_models` has a nullable `org_id` (NULL =
 * platform row) so the org-scoped facade would hide every shared model.
 * Filtered explicitly to the platform catalog plus this tenant's own
 * additions, exactly as `catalog-store.ts` does.
 */
async function resolveMaskNames(
  orgId: string,
  ids: Array<string | null>,
): Promise<Map<string, string>> {
  const wanted = ids.filter((v): v is string => Boolean(v));
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;
  try {
    const { data } = (await getOrgScopedClient(orgId)
      .raw()
      .schema("resupply")
      .from("mask_models")
      .select("id, manufacturer, model_name")
      .or(`org_id.is.null,org_id.eq.${orgId}`)
      .in("id", wanted)) as { data: Row[] | null };
    for (const row of data ?? []) {
      out.set(String(row.id), `${row.manufacturer} ${row.model_name}`);
    }
  } catch {
    // A missing display name degrades the report line to null; it must
    // never fail the report.
  }
  return out;
}
