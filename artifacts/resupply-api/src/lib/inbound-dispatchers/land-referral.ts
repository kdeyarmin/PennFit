// Shared "land an inbound referral" helper.
//
// Both the Parachute dispatcher (lib/inbound-dispatchers/parachute.ts)
// and the EHR FHIR dispatcher (lib/inbound-dispatchers/ehr-fhir.ts)
// arrive at the same place: a typed ParachuteOrder + the source slug
// + the inbound_webhook_id. From there the work is identical —
// matchers, AI classifier, insert, dedupe, audit, document mirror.
//
// Extracting it here keeps the per-source dispatchers small (each
// only owns its parse + verify), and ensures auto-triage rules
// stay consistent across sources.
//
// PHI posture: logger sees referral id + source slug + counts. Never
// payer name, patient name, document URL.

import { logAudit } from "@workspace/resupply-audit";
import {
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import type {
  ParachuteDocument,
  ParachuteOrder,
} from "@workspace/resupply-integrations-parachute";

import { logger } from "../logger";
import { classifyReferral } from "./ai-classify";
import { matchPatient } from "./match-patient";
import { matchProvider } from "./match-provider";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

/**
 * AI confidence threshold above which an inbound referral with both
 * patient + provider matches auto-promotes `new` → `triaged`. Below
 * this, the row stays `new` so a human looks at it.
 */
export const AUTO_TRIAGE_CONFIDENCE_THRESHOLD = 0.85;

export type LandOutcome =
  | { ok: true; referralId: string; deduped: boolean }
  | { ok: false; permanent: true; reason: string }
  | { ok: false; permanent: false; reason: string };

export interface LandReferralInput {
  /** Source slug: 'parachute' | `ehr_fhir_<tenant_slug>` | ... */
  source: string;
  /** inbound_webhooks.id (FK back to the verbatim row). */
  inboundWebhookId: string;
  /** Parsed referral payload — every source projects to this shape. */
  order: ParachuteOrder;
  /** For the audit log action prefix — 'parachute' | 'ehr_fhir' | ... */
  dispatcherLabel: string;
  /** Tests override; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export async function landReferralFromOrder(
  input: LandReferralInput,
): Promise<LandOutcome> {
  const env = input.env ?? process.env;
  const order = input.order;

  // Run matchers + AI classifier BEFORE insert so the row lands with
  // patient/provider FKs already populated and the CSR sees triage
  // hints inline.
  const [patientMatch, providerMatch] = await Promise.all([
    matchPatient({
      lastName: order.patient.lastName,
      dob: order.patient.dob,
      phoneE164: order.patient.phoneE164,
    }),
    matchProvider({ npi: order.provider.npi }),
  ]);

  const classification = await classifyReferral({
    order,
    patientMatched: patientMatch.patientId !== null,
    providerMatched: providerMatch.providerId !== null,
    env,
  }).catch((err) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "inbound_referral.classify.unexpected_error",
    );
    return null;
  });

  const autoTriage =
    classification !== null &&
    classification.confidence >= AUTO_TRIAGE_CONFIDENCE_THRESHOLD &&
    patientMatch.patientId !== null &&
    providerMatch.providerId !== null;

  const supabase = getSupabaseServiceRoleClient();
  const { data: inserted, error: insertErr } = await supabase
    .schema("resupply")
    .from("inbound_referral_orders")
    .insert({
      source: input.source,
      source_order_id: order.sourceOrderId,
      inbound_webhook_id: input.inboundWebhookId,
      patient_match_id: patientMatch.patientId,
      patient_match_kind: patientMatch.kind,
      provider_match_id: providerMatch.providerId,
      provider_match_kind: providerMatch.kind,
      ai_classification_json: classification as unknown as Json,
      ai_confidence: classification?.confidence ?? null,
      payer_name: order.payerName,
      ordering_npi: order.provider.npi,
      hcpcs_items_json: order.hcpcsLines as unknown as Json,
      icd10_codes_json: order.icd10Codes as unknown as Json,
      raw_parsed_json: order as unknown as Json,
      triage_status: autoTriage ? "triaged" : "new",
      triaged_at: autoTriage ? new Date().toISOString() : null,
      received_at: order.occurredAt,
    })
    .select("id")
    .maybeSingle();

  let referralId: string;
  let deduped = false;
  if (insertErr) {
    if (typeof insertErr.code === "string" && insertErr.code === "23505") {
      const { data: existing } = await supabase
        .schema("resupply")
        .from("inbound_referral_orders")
        .select("id")
        .eq("source", input.source)
        .eq("source_order_id", order.sourceOrderId)
        .limit(1)
        .maybeSingle();
      if (!existing) {
        return {
          ok: false,
          permanent: false,
          reason: "duplicate_lookup_failed",
        };
      }
      referralId = existing.id;
      deduped = true;
    } else {
      logger.warn(
        {
          inbound_webhook_id: input.inboundWebhookId,
          source: input.source,
          err_code: insertErr.code,
        },
        "land_referral_insert_failed",
      );
      return {
        ok: false,
        permanent: false,
        reason: `insert_${insertErr.code ?? "unknown"}`,
      };
    }
  } else {
    if (!inserted) {
      return {
        ok: false,
        permanent: false,
        reason: "insert_no_row",
      };
    }
    referralId = inserted.id;
  }

  if (!deduped && order.documents.length > 0) {
    await persistReferralDocuments(supabase, referralId, order.documents);
  }

  await logAudit({
    action: deduped
      ? `inbound_referral.${input.dispatcherLabel}.dispatched_duplicate`
      : `inbound_referral.${input.dispatcherLabel}.dispatched`,
    adminEmail: `system:dispatcher:${input.dispatcherLabel}`,
    adminUserId: null,
    targetTable: "inbound_referral_orders",
    targetId: referralId,
    metadata: {
      source: input.source,
      source_order_id: order.sourceOrderId,
      event_type: order.eventType,
      hcpcs_count: order.hcpcsLines.length,
      document_count: order.documents.length,
    },
    ip: null,
    userAgent: null,
  }).catch((err) => {
    logger.warn(
      { err },
      `inbound_referral.${input.dispatcherLabel} audit write failed`,
    );
  });

  return { ok: true, referralId, deduped };
}

async function persistReferralDocuments(
  supabase: SupabaseClient,
  referralId: string,
  documents: ParachuteDocument[],
): Promise<void> {
  for (const doc of documents) {
    const { error } = await supabase
      .schema("resupply")
      .from("inbound_referral_documents")
      .insert({
        referral_id: referralId,
        doc_kind: doc.kind,
        source_filename: doc.filename,
        content_type: doc.contentType,
        size_bytes: doc.sizeBytes,
        source_url: doc.sourceUrl,
        source_document_id: doc.sourceDocumentId,
      });
    if (error && error.code !== "23505") {
      logger.warn(
        {
          referral_id: referralId,
          source_document_id: doc.sourceDocumentId,
          err_code: error.code,
        },
        "land_referral_document_insert_failed",
      );
    }
  }
}
