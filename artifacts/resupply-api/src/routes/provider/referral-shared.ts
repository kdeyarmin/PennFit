// Shared referral plumbing used by both sides of the portal — the
// provider routes (/api/provider/referrals/*) and the DME's inbound queue
// (/admin/referrals/*).
//
// The two sides read the SAME rows through different doors, so the row →
// JSON mapping lives here rather than being written twice and drifting.
// Where the two sides legitimately differ is in what they are ALLOWED to
// see, and that is enforced by the loader each side uses, not by the
// mapper:
//
//   * `loadReferralForProvider` gates on the provider's own identity and
//     then reads the row's own org_id to pick the tenant client.
//   * the DME side has `req.orgId` from its admin session and gates the
//     ordinary way, so it needs no loader here.
//
// PHI: everything below handles patient demographics. Nothing here logs.

import { Readable } from "node:stream";

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../../lib/object-storage/objectStorage";

/** Matches a canonical UUID; deliberately not version-specific. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Narrow a row's `org_id` to a usable tenant id, or null.
 *
 * In this tree the tenant comes off the ROW rather than the request, so
 * every `getOrgScopedClient` call is only as trustworthy as the value
 * pulled out of that row. `String(null)` yields the string "null", which
 * the client accepts without complaint and then scopes every query to a
 * tenant that cannot exist — the query returns empty and the caller sees
 * "no data" rather than an error. That is a far worse failure than a 500.
 *
 * The columns involved are all NOT NULL, so this should never fire. It
 * exists because the cost is one comparison and the thing it guards is
 * which tenant's PHI a request touches.
 */
export function asOrgId(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

export interface ReferralRow {
  id: string;
  org_id: string;
  provider_id?: string;
  status: string;
  patient_id?: string | null;
  patient_first_name: string;
  patient_last_name: string;
  patient_dob?: string | null;
  patient_email?: string | null;
  patient_phone_e164?: string | null;
  patient_sex?: string | null;
  patient_address?: unknown;
  insurance_payer_name?: string | null;
  insurance_member_id?: string | null;
  insurance_group_number?: string | null;
  routed_to_location_id?: string | null;
  entry_point?: string;
  therapy_mode?: string;
  prescribed_pressure_cm_h2o?: number | string | null;
  diagnosis_code?: string | null;
  clinical_notes?: string | null;
  fitter_invite_id?: string | null;
  fit_session_id?: string | null;
  fitting_sent_at?: string | null;
  fitting_completed_at?: string | null;
  approved_mask_model_id?: string | null;
  approved_variant_id?: string | null;
  approval_is_override?: boolean;
  approval_note?: string | null;
  approved_at?: string | null;
  signature_request_id?: string | null;
  signed_at?: string | null;
  adherence_updates_authorized?: boolean;
  provider_unread_count: number;
  dme_unread_count: number;
  created_by_email?: string | null;
  submitted_at?: string | null;
  accepted_at?: string | null;
  accepted_by_email?: string | null;
  declined_at?: string | null;
  declined_reason?: string | null;
  dispensed_at?: string | null;
  cancelled_at?: string | null;
  created_at: string;
  updated_at: string;
  organizations?: { name?: string } | null;
}

const REFERRAL_COLUMNS =
  "id, org_id, provider_id, status, patient_id, patient_first_name, patient_last_name, patient_dob, patient_email, patient_phone_e164, patient_sex, patient_address, insurance_payer_name, insurance_member_id, insurance_group_number, routed_to_location_id, entry_point, therapy_mode, prescribed_pressure_cm_h2o, diagnosis_code, clinical_notes, fitter_invite_id, fit_session_id, fitting_sent_at, fitting_completed_at, approved_mask_model_id, approved_variant_id, approval_is_override, approval_note, approved_at, signature_request_id, signed_at, adherence_updates_authorized, provider_unread_count, dme_unread_count, created_by_email, submitted_at, accepted_at, accepted_by_email, declined_at, declined_reason, dispensed_at, cancelled_at, created_at, updated_at";

/**
 * Load one referral on behalf of a signed-in provider.
 *
 * THE authorization check for the whole provider tree. A referral's
 * tenant is a property of the ROW, not of the request, so this cannot use
 * `req.orgId` — it matches on `provider_id` (taken from the authenticated
 * session, never from the caller) and then hands back the row's own
 * `org_id` for the caller to build a tenant client from.
 *
 * Returns null for "not found" and for "belongs to a different provider"
 * alike, so a caller cannot distinguish the two and probe for the
 * existence of another provider's referrals.
 */
export async function loadReferralForProvider(
  providerId: string,
  referralId: string,
): Promise<{ orgId: string; row: ReferralRow } | null> {
  try {
    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) return null;
    // raw-org-scope-exempt: a provider's referrals span every DME they
    // refer to, so resolving one by id is inherently cross-tenant. It is
    // constrained by `provider_id` from the authenticated session — the
    // caller supplies only the referral id, and a referral belonging to
    // anyone else simply does not match.
    const { data, error } = await getOrgScopedClient(seedOrgId)
      .raw()
      .schema("resupply")
      .from("referrals")
      .select(`${REFERRAL_COLUMNS}, organizations(name)`)
      .eq("id", referralId)
      .eq("provider_id", providerId)
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as unknown as ReferralRow;
    const orgId = asOrgId(row.org_id);
    if (!orgId) {
      // Same reasoning as the create path: refuse rather than scope a
      // PHI read to a tenant id we cannot vouch for.
      logger.error(
        { event: "referral_missing_org", referralId },
        "referral row has no usable org_id",
      );
      return null;
    }
    return { orgId, row };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "referral lookup failed",
    );
    return null;
  }
}

/** The column list both sides select. Exported so the DME side matches. */
export { REFERRAL_COLUMNS };

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** The list-row shape. Deliberately excludes contact details and
 *  insurance identifiers — a queue listing does not need them. */
export function mapReferralSummary(row: ReferralRow) {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    dmeName: row.organizations?.name ?? null,
    status: row.status,
    patientName: `${row.patient_first_name} ${row.patient_last_name}`.trim(),
    patientDob: row.patient_dob ?? null,
    routedToLocationId: row.routed_to_location_id ?? null,
    entryPoint: row.entry_point ?? "remote_link",
    therapyMode: row.therapy_mode ?? "pap",
    fitSessionId: row.fit_session_id ?? null,
    approvedMaskModelId: row.approved_mask_model_id ?? null,
    unreadForProvider: Number(row.provider_unread_count ?? 0),
    unreadForDme: Number(row.dme_unread_count ?? 0),
    submittedAt: row.submitted_at ?? null,
    acceptedAt: row.accepted_at ?? null,
    declinedAt: row.declined_at ?? null,
    declinedReason: row.declined_reason ?? null,
    dispensedAt: row.dispensed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapReferralDetail(
  row: ReferralRow,
  related: {
    events: Record<string, unknown>[];
    messages: Record<string, unknown>[];
    documents: Record<string, unknown>[];
  },
) {
  return {
    ...mapReferralSummary(row),
    patient: {
      firstName: row.patient_first_name,
      lastName: row.patient_last_name,
      dob: row.patient_dob ?? null,
      email: row.patient_email ?? null,
      phone: row.patient_phone_e164 ?? null,
      sex: row.patient_sex ?? null,
      address: row.patient_address ?? null,
      /** Set once the DME matched or created a chart. */
      chartId: row.patient_id ?? null,
    },
    insurance: {
      payerName: row.insurance_payer_name ?? null,
      memberId: row.insurance_member_id ?? null,
      groupNumber: row.insurance_group_number ?? null,
    },
    clinical: {
      therapyMode: row.therapy_mode ?? "pap",
      prescribedPressureCmH2O: num(row.prescribed_pressure_cm_h2o),
      diagnosisCode: row.diagnosis_code ?? null,
      notes: row.clinical_notes ?? null,
    },
    fitting: {
      inviteId: row.fitter_invite_id ?? null,
      sessionId: row.fit_session_id ?? null,
      sentAt: row.fitting_sent_at ?? null,
      completedAt: row.fitting_completed_at ?? null,
    },
    approval: {
      maskModelId: row.approved_mask_model_id ?? null,
      variantId: row.approved_variant_id ?? null,
      isOverride: Boolean(row.approval_is_override),
      note: row.approval_note ?? null,
      approvedAt: row.approved_at ?? null,
      // Filled in by whichever side resolves the catalog — ids alone are
      // not something a warehouse can pick from.
      maskName: null as string | null,
      interfaceType: null as string | null,
      sizeLabel: null as string | null,
    },
    signature: {
      requestId: row.signature_request_id ?? null,
      signedAt: row.signed_at ?? null,
    },
    adherenceUpdatesAuthorized: Boolean(row.adherence_updates_authorized),
    createdByEmail: row.created_by_email ?? null,
    acceptedByEmail: row.accepted_by_email ?? null,
    events: related.events.map((e) => ({
      eventType: e.event_type,
      actorKind: e.actor_kind,
      actorEmail: e.actor_email ?? null,
      detail: e.detail ?? null,
      occurredAt: e.occurred_at,
    })),
    messages: related.messages.map((m) => ({
      id: String(m.id),
      authorKind: m.author_kind,
      authorEmail: m.author_email ?? null,
      authorName: m.author_name ?? null,
      body: m.body,
      createdAt: m.created_at,
    })),
    documents: related.documents.map((d) => ({
      id: String(d.id),
      docType: d.doc_type,
      fileName: d.file_name,
      contentType: d.content_type,
      sizeBytes: d.size_bytes,
      uploadedByKind: d.uploaded_by_kind,
      uploadedByEmail: d.uploaded_by_email ?? null,
      notes: d.notes ?? null,
      createdAt: d.created_at,
    })),
  };
}

/**
 * Is this provider still authorized to send referrals to this tenant?
 *
 * Authorization is not a create-time question. A DME can revoke or
 * suspend a provider at any point, and the admin UI tells them that
 * "revoking stops any new referrals from them immediately" — which is
 * only true if the check runs again at the moment something is actually
 * delivered, rather than only when the draft was started.
 *
 * raw-org-scope-exempt: the link table spans tenants by design, and this
 * is constrained to the authenticated provider plus one explicit org.
 */
export async function providerMayReferTo(
  providerId: string,
  orgId: string,
): Promise<boolean> {
  try {
    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) return false;
    const { data, error } = await getOrgScopedClient(seedOrgId)
      .raw()
      .schema("resupply")
      .from("provider_dme_links")
      .select("id")
      .eq("provider_id", providerId)
      .eq("org_id", orgId)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();
    if (error) return false;
    return Boolean(data);
  } catch {
    // Fail CLOSED: an unverifiable authorization is not an authorization.
    return false;
  }
}

/**
 * Append to the referral's timeline.
 *
 * Best-effort: a failed event write must not fail the clinical action it
 * describes. `detail` carries ids, codes, and counts ONLY — this is a
 * feature-owned domain table, not the retired `resupply.audit_log`, and
 * it must never accumulate free-text PHI.
 */
export async function recordReferralEvent(
  orgId: string,
  referralId: string,
  eventType: string,
  opts: {
    actorKind: "provider" | "staff" | "patient" | "system";
    actorEmail?: string | null;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await getOrgScopedClient(orgId)
      .from("referral_events")
      .insert({
        referral_id: referralId,
        event_type: eventType,
        actor_kind: opts.actorKind,
        actor_email: opts.actorEmail ?? null,
        detail: opts.detail ?? {},
      });
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err : new Error(String(err)),
        referralId,
        eventType,
      },
      "referral event write failed",
    );
  }
}

// ── Attachment streaming ─────────────────────────────────────────────

const objectStorage = new ObjectStorageService();

/**
 * Stream one referral attachment back to whichever side asked for it.
 *
 * Both sides need this or the document exchange is write-only: a DME that
 * can see "prescription.pdf" listed but not open it still has to phone
 * the practice, which is the thing this portal exists to remove.
 *
 * AUTHORIZATION IS THE CALLER'S JOB. `downloadObject` does not enforce
 * per-object ACLs (see its docstring), so every caller must already have
 * proven the requester may see this referral — the provider side by
 * matching the row's `provider_id` to the session, the DME side by
 * reading through its own org-scoped client. The object key is read off
 * the document row, never accepted from the request.
 */
export async function streamReferralDocument(
  res: {
    status: (code: number) => unknown;
    setHeader: (name: string, value: string) => unknown;
    json: (body: unknown) => unknown;
    end: () => unknown;
  },
  input: {
    objectPath: string;
    contentType: string | null;
    fileName: string;
    referralId: string;
  },
): Promise<void> {
  let file;
  try {
    file = await objectStorage.getObjectEntityFile(input.objectPath);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404);
      res.json({ error: "not_found" });
      return;
    }
    logger.error(
      { err, referral_id: input.referralId },
      "referral_document_lookup_failed",
    );
    res.status(500);
    res.json({ error: "download_failed" });
    return;
  }

  try {
    const response = await objectStorage.downloadObject(file, 0);
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (input.contentType) res.setHeader("Content-Type", input.contentType);
    // `attachment`, not `inline`: these bytes came from outside the
    // deployment, so they are never rendered in the app's own origin.
    // Quotes, backslashes, and newlines are stripped so a crafted file
    // name cannot break out of the header value.
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${input.fileName.replace(/[\\"\r\n]/g, "")}"`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (response.body) {
      const nodeStream = Readable.fromWeb(
        response.body as unknown as ReadableStream<Uint8Array>,
      );
      nodeStream.pipe(res as unknown as NodeJS.WritableStream);
    } else {
      res.end();
    }
  } catch (err) {
    logger.error(
      { err, referral_id: input.referralId },
      "referral_document_stream_failed",
    );
    res.status(500);
    res.json({ error: "download_failed" });
  }
}
