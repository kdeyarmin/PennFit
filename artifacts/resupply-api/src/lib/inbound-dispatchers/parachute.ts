// Parachute Health inbound dispatcher.
//
// Reads an inbound_webhooks row (source='parachute', status in
// ('received', 'processing_failed')) and:
//
//   1. Re-verifies the signature header against PARACHUTE_SIGNING_SECRET.
//      Phase 1 also verifies inline at /integrations/inbound/parachute
//      so a forged payload never lands in inbound_webhooks in the
//      first place; the dispatcher-side check is defence-in-depth
//      against a stale signing-secret rotation.
//   2. Parses the verbatim payload into a typed ParachuteOrder.
//   3. Inserts an inbound_referral_orders row (idempotent on
//      (source, source_order_id) — re-runs are no-ops).
//   4. Inserts one inbound_referral_documents row per attachment.
//      Document bytes are NOT mirrored to object storage in Phase 1;
//      source_url is persisted and a Phase 2 worker will mirror.
//   5. Flips the inbound_webhooks row to 'processed' on success,
//      'processing_failed' (+ processing_error) on a transient
//      failure, 'rejected' on a permanent failure (bad signature,
//      malformed shape).
//   6. Emits an audit row keyed to the referral id.
//
// PHI posture: the dispatcher logs the referral id, source slug,
// HCPCS code count, and signature outcome only. Never the payload,
// patient name, or any document URL.

import {
  parseParachuteOrder,
  readParachuteConfigOrNull,
  verifyParachuteSignature,
} from "@workspace/resupply-integrations-parachute";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../logger";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;
type InboundWebhookRow =
  Database["resupply"]["Tables"]["inbound_webhooks"]["Row"];

export type DispatchOutcome =
  | { ok: true; referralId: string; deduped: boolean }
  | { ok: false; permanent: true; reason: string }
  | { ok: false; permanent: false; reason: string };

interface DispatchInput {
  row: Pick<
    InboundWebhookRow,
    | "id"
    | "source"
    | "payload_json"
    | "verification_headers_json"
    | "signature_verified"
  >;
  /**
   * Optional env override (tests). Defaults to process.env.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Dispatch a single inbound_webhooks row that arrived from
 * Parachute. The worker (worker/jobs/inbound-webhook-dispatch.ts)
 * calls this once per pending row.
 *
 * Pure-ish: returns an outcome; the caller is responsible for
 * flipping the inbound_webhooks.status based on it (keeps the
 * status-transition logic in one place).
 */
export async function dispatchParachute(
  input: DispatchInput,
): Promise<DispatchOutcome> {
  const env = input.env ?? process.env;
  const config = readParachuteConfigOrNull(env);
  if (!config) {
    // No PARACHUTE_SIGNING_SECRET in env — dev / preview deploys.
    // We don't reject (a stub-mode tester would never get past
    // signature check); we leave the row as 'received' for human
    // triage by returning a transient failure.
    return {
      ok: false,
      permanent: false,
      reason: "parachute_unconfigured",
    };
  }

  // Re-verify the signature using the headers we captured at intake.
  const headers =
    (input.row.verification_headers_json as Record<string, string> | null) ??
    {};
  const sigHeader = headers["x-parachute-signature"];
  const rawBody = JSON.stringify(input.row.payload_json);
  const verifyOutcome = verifyParachuteSignature({
    rawBody,
    signatureHeader: sigHeader,
    signingSecret: config.signingSecret,
  });
  if (!verifyOutcome.ok) {
    // Bad signature is permanent — re-running won't fix it. Mark
    // the row 'rejected' so the worker doesn't loop on it.
    return {
      ok: false,
      permanent: true,
      reason: `signature_${verifyOutcome.reason}`,
    };
  }

  const parsed = parseParachuteOrder(input.row.payload_json);
  if (!parsed.ok) {
    return {
      ok: false,
      permanent: true,
      reason: "parse_invalid_shape",
    };
  }
  const order = parsed.order;

  const supabase = getSupabaseServiceRoleClient();
  const { data: inserted, error: insertErr } = await supabase
    .schema("resupply")
    .from("inbound_referral_orders")
    .insert({
      source: input.row.source,
      source_order_id: order.sourceOrderId,
      inbound_webhook_id: input.row.id,
      payer_name: order.payerName,
      ordering_npi: order.provider.npi,
      hcpcs_items_json: order.hcpcsLines as unknown as Json,
      icd10_codes_json: order.icd10Codes as unknown as Json,
      raw_parsed_json: order as unknown as Json,
      triage_status: "new",
      received_at: order.occurredAt,
    })
    .select("id")
    .maybeSingle();

  let referralId: string;
  let deduped = false;
  if (insertErr) {
    // Duplicate on (source, source_order_id) — Parachute re-delivered
    // a webhook we've already turned into a referral. Treat as success.
    if (typeof insertErr.code === "string" && insertErr.code === "23505") {
      const { data: existing } = await supabase
        .schema("resupply")
        .from("inbound_referral_orders")
        .select("id")
        .eq("source", input.row.source)
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
          webhook_id: input.row.id,
          err_code: insertErr.code,
        },
        "parachute_dispatcher_insert_failed",
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

  // Mirror attachments (metadata only — Phase 2 worker downloads the
  // bytes). Per-row insert errors are non-fatal; we log and continue
  // so a single bad attachment doesn't strand the whole referral.
  if (!deduped && order.documents.length > 0) {
    await persistDocuments(supabase, referralId, order.documents);
  }

  await logAudit({
    action: deduped
      ? "inbound_referral.parachute.dispatched_duplicate"
      : "inbound_referral.parachute.dispatched",
    adminEmail: "system:dispatcher:parachute",
    adminUserId: null,
    targetTable: "inbound_referral_orders",
    targetId: referralId,
    metadata: {
      source_order_id: order.sourceOrderId,
      event_type: order.eventType,
      hcpcs_count: order.hcpcsLines.length,
      document_count: order.documents.length,
    },
    ip: null,
    userAgent: null,
  }).catch((err) => {
    logger.warn({ err }, "inbound_referral.parachute audit write failed");
  });

  return { ok: true, referralId, deduped };
}

async function persistDocuments(
  supabase: SupabaseClient,
  referralId: string,
  documents: import("@workspace/resupply-integrations-parachute").ParachuteDocument[],
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
        "parachute_dispatcher_document_insert_failed",
      );
    }
  }
}
