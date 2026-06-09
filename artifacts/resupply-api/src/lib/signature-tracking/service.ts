// Signature-tracking service — the read/write helpers for
// resupply.signature_tracking (migration 0253).
//
// One row tracks one document (a prescription-request packet or a
// signable manual document) from the moment it is prepared for a
// provider signature until the signed copy comes back. The route + send
// paths call these helpers; the unified /admin/signature-tracking
// dashboard reads through {@link listOutstandingSignatures}.
//
// Design notes
//   • `registerSignatureTracking` is idempotent on (kind, id): re-running
//     it (e.g. re-rendering the PDF after an edit) returns the SAME
//     tracking code, so the barcode on the document is stable. It only
//     refreshes the snapshot labels, never the code.
//   • The tracking code is drawn from a deliberately unambiguous alphabet
//     (no 0/O/1/I/L) so a CSR can read it off a fax and key it in. Lookup
//     normalises case / spacing / a missing prefix.
//   • Snapshot labels (patient / provider / practice / title) are stored
//     so the dashboard renders without re-joining each source table.
//
// Pure-ish data layer: takes a Supabase client, performs reads/writes,
// returns typed results. No HTTP, no logging side effects (the route
// layer owns audit + logging).

import { randomInt } from "node:crypto";

import type { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export type SignatureDocumentKind = "prescription_request" | "manual_document";
export type SignatureTrackingStatus =
  | "awaiting_signature"
  | "returned_signed"
  | "canceled";
export type SignatureDeliveryChannel =
  | "none"
  | "fax"
  | "email"
  | "hand_delivery";

const CODE_PREFIX = "PFS-";
// Crockford-ish alphabet minus the easily-confused glyphs (0/O, 1/I/L).
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_BODY_LENGTH = 8;

/** Mint a random, human-keyable, barcode-safe tracking code (PFS-XXXXXXXX). */
export function generateTrackingCode(): string {
  let body = "";
  for (let i = 0; i < CODE_BODY_LENGTH; i += 1) {
    body += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return `${CODE_PREFIX}${body}`;
}

/**
 * Normalise a scanned / typed code for lookup: uppercase, strip spaces +
 * dashes, and re-apply the canonical PFS- prefix. Accepts the code with
 * or without the prefix and with arbitrary internal spacing (faxed
 * barcodes are sometimes hand-keyed with a space after the prefix).
 */
export function normalizeTrackingCode(raw: string): string {
  const compact = raw.toUpperCase().replace(/[\s-]+/g, "");
  const body = compact.startsWith("PFS") ? compact.slice(3) : compact;
  return `${CODE_PREFIX}${body}`;
}

// Canonical shape: PFS- + 8 chars from the unambiguous alphabet. Built
// from the same constants `generateTrackingCode` mints from so the two
// can never drift.
const WELL_FORMED_CODE_RE = new RegExp(
  `^${CODE_PREFIX}[${CODE_ALPHABET}]{${CODE_BODY_LENGTH}}$`,
);

/**
 * True when `raw` (after {@link normalizeTrackingCode}) is a syntactically
 * valid PennFit tracking code. Used to reject a hallucinated / misread
 * code from the fax barcode scan BEFORE it hits the database — a value
 * that can't be one of ours never warrants a lookup.
 */
export function isWellFormedTrackingCode(raw: string): boolean {
  return WELL_FORMED_CODE_RE.test(normalizeTrackingCode(raw));
}

export interface RegisterSignatureTrackingInput {
  kind: SignatureDocumentKind;
  documentId: string;
  title: string;
  patientId?: string | null;
  providerId?: string | null;
  patientLabel?: string | null;
  providerLabel?: string | null;
  practiceName?: string | null;
  returnFaxE164?: string | null;
  createdByEmail?: string | null;
}

/**
 * Ensure a tracking row exists for (kind, documentId) and return its
 * code. Idempotent: an existing row keeps its code (the printed barcode
 * stays stable) while its snapshot labels are refreshed. A re-registered
 * row that was previously canceled/returned is reopened to
 * awaiting_signature (the document is being sent again).
 */
export async function registerSignatureTracking(
  supabase: SupabaseClient,
  input: RegisterSignatureTrackingInput,
): Promise<{ trackingCode: string; id: string; created: boolean }> {
  const { data: existing, error: loadErr } = await supabase
    .schema("resupply")
    .from("signature_tracking")
    .select("id, tracking_code")
    .eq("document_kind", input.kind)
    .eq("document_id", input.documentId)
    .limit(1)
    .maybeSingle();
  if (loadErr) throw loadErr;

  const nowIso = new Date().toISOString();
  if (existing) {
    const { error: updErr } = await supabase
      .schema("resupply")
      .from("signature_tracking")
      .update({
        title: input.title,
        patient_id: input.patientId ?? null,
        provider_id: input.providerId ?? null,
        patient_label: input.patientLabel ?? null,
        provider_label: input.providerLabel ?? null,
        practice_name: input.practiceName ?? null,
        return_fax_e164: input.returnFaxE164 ?? null,
        status: "awaiting_signature",
        returned_at: null,
        canceled_at: null,
        updated_at: nowIso,
      })
      .eq("id", existing.id);
    if (updErr) throw updErr;
    return {
      trackingCode: existing.tracking_code,
      id: existing.id,
      created: false,
    };
  }

  // New row. Retry once on the (vanishingly unlikely) unique-code
  // collision before giving up.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const trackingCode = generateTrackingCode();
    const { data: inserted, error: insertErr } = await supabase
      .schema("resupply")
      .from("signature_tracking")
      .insert({
        tracking_code: trackingCode,
        document_kind: input.kind,
        document_id: input.documentId,
        title: input.title,
        patient_id: input.patientId ?? null,
        provider_id: input.providerId ?? null,
        patient_label: input.patientLabel ?? null,
        provider_label: input.providerLabel ?? null,
        practice_name: input.practiceName ?? null,
        return_fax_e164: input.returnFaxE164 ?? null,
        status: "awaiting_signature",
        delivery_channel: "none",
        sent_count: 0,
        created_by_email: input.createdByEmail ?? null,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .select("id")
      .limit(1)
      .maybeSingle();
    if (!insertErr && inserted) {
      return { trackingCode, id: inserted.id, created: true };
    }
    // 23505 = unique_violation. A racing register on the same document
    // (not the code) means a row now exists — re-read and use it.
    const code = (insertErr as { code?: string } | null)?.code;
    if (code === "23505") {
      const { data: raced } = await supabase
        .schema("resupply")
        .from("signature_tracking")
        .select("id, tracking_code")
        .eq("document_kind", input.kind)
        .eq("document_id", input.documentId)
        .limit(1)
        .maybeSingle();
      if (raced) {
        return {
          trackingCode: raced.tracking_code,
          id: raced.id,
          created: false,
        };
      }
      // Otherwise it was a code collision — loop and mint a new code.
      continue;
    }
    if (insertErr) throw insertErr;
  }
  throw new Error("signature_tracking: could not allocate a unique code");
}

/** Look up the tracking code already assigned to a document, if any. */
export async function getTrackingCodeForDocument(
  supabase: SupabaseClient,
  kind: SignatureDocumentKind,
  documentId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .schema("resupply")
    .from("signature_tracking")
    .select("tracking_code")
    .eq("document_kind", kind)
    .eq("document_id", documentId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.tracking_code ?? null;
}

/**
 * Record that a document was dispatched: bump sent_count, stamp
 * last_sent_at + channel, and keep it in the awaiting queue. Best-effort
 * — a missing tracking row (e.g. an older document created before this
 * feature) is a no-op rather than an error.
 */
export async function recordTrackingSent(
  supabase: SupabaseClient,
  kind: SignatureDocumentKind,
  documentId: string,
  channel: SignatureDeliveryChannel,
): Promise<void> {
  const { data: row, error } = await supabase
    .schema("resupply")
    .from("signature_tracking")
    .select("id, sent_count")
    .eq("document_kind", kind)
    .eq("document_id", documentId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!row) return;
  const nowIso = new Date().toISOString();
  const { error: updErr } = await supabase
    .schema("resupply")
    .from("signature_tracking")
    .update({
      sent_count: (row.sent_count ?? 0) + 1,
      last_sent_at: nowIso,
      delivery_channel: channel,
      status: "awaiting_signature",
      updated_at: nowIso,
    })
    .eq("id", row.id);
  if (updErr) throw updErr;
}

/** Mark the document's tracking row as returned-signed. Best-effort. */
export async function markTrackingReturned(
  supabase: SupabaseClient,
  kind: SignatureDocumentKind,
  documentId: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .schema("resupply")
    .from("signature_tracking")
    .update({
      status: "returned_signed",
      returned_at: nowIso,
      updated_at: nowIso,
    })
    .eq("document_kind", kind)
    .eq("document_id", documentId);
  if (error) throw error;
}

/**
 * Mark a tracking row returned-signed AND advance the source document
 * where it carries its own signed state (a prescription packet still in
 * an open status is stamped `signed` so the two views agree). Shared by
 * the signature-tracking route and the chart-upload "this is the signed
 * return" path so the cascade is identical. Returns whether the source
 * was advanced (false when there was nothing to advance / it was already
 * terminal).
 */
export async function markReturnedAndCascade(
  supabase: SupabaseClient,
  row: SignatureTrackingRow,
): Promise<{ cascaded: boolean }> {
  await markTrackingReturned(supabase, row.documentKind, row.documentId);
  if (row.documentKind !== "prescription_request") return { cascaded: false };
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .schema("resupply")
    .from("prescription_request_packets")
    .update({ status: "signed", signed_at: nowIso, updated_at: nowIso })
    .eq("id", row.documentId)
    .in("status", ["draft", "sent_fax", "delivered", "failed"])
    .select("id");
  if (error) throw error;
  return { cascaded: (data ?? []).length > 0 };
}

/** Mark the document's tracking row as canceled. Best-effort. */
export async function markTrackingCanceled(
  supabase: SupabaseClient,
  kind: SignatureDocumentKind,
  documentId: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .schema("resupply")
    .from("signature_tracking")
    .update({ status: "canceled", canceled_at: nowIso, updated_at: nowIso })
    .eq("document_kind", kind)
    .eq("document_id", documentId);
  if (error) throw error;
}

export interface SignatureTrackingRow {
  id: string;
  trackingCode: string;
  documentKind: SignatureDocumentKind;
  documentId: string;
  patientId: string | null;
  providerId: string | null;
  patientLabel: string | null;
  providerLabel: string | null;
  practiceName: string | null;
  title: string;
  status: SignatureTrackingStatus;
  deliveryChannel: SignatureDeliveryChannel;
  returnFaxE164: string | null;
  sentCount: number;
  lastSentAt: string | null;
  returnedAt: string | null;
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SignatureTrackingDbRow {
  id: string;
  tracking_code: string;
  document_kind: SignatureDocumentKind;
  document_id: string;
  patient_id: string | null;
  provider_id: string | null;
  patient_label: string | null;
  provider_label: string | null;
  practice_name: string | null;
  title: string;
  status: SignatureTrackingStatus;
  delivery_channel: SignatureDeliveryChannel;
  return_fax_e164: string | null;
  sent_count: number;
  last_sent_at: string | null;
  returned_at: string | null;
  canceled_at: string | null;
  created_at: string;
  updated_at: string;
}

const ROW_COLUMNS =
  "id, tracking_code, document_kind, document_id, patient_id, provider_id, " +
  "patient_label, provider_label, practice_name, title, status, " +
  "delivery_channel, return_fax_e164, sent_count, last_sent_at, returned_at, " +
  "canceled_at, created_at, updated_at";

function projectRow(r: SignatureTrackingDbRow): SignatureTrackingRow {
  return {
    id: r.id,
    trackingCode: r.tracking_code,
    documentKind: r.document_kind,
    documentId: r.document_id,
    patientId: r.patient_id,
    providerId: r.provider_id,
    patientLabel: r.patient_label,
    providerLabel: r.provider_label,
    practiceName: r.practice_name,
    title: r.title,
    status: r.status,
    deliveryChannel: r.delivery_channel,
    returnFaxE164: r.return_fax_e164,
    sentCount: r.sent_count ?? 0,
    lastSentAt: r.last_sent_at,
    returnedAt: r.returned_at,
    canceledAt: r.canceled_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Resolve a scanned / typed tracking code to its row (or null). */
export async function lookupTrackingByCode(
  supabase: SupabaseClient,
  rawCode: string,
): Promise<SignatureTrackingRow | null> {
  const code = normalizeTrackingCode(rawCode);
  const { data, error } = await supabase
    .schema("resupply")
    .from("signature_tracking")
    .select(ROW_COLUMNS)
    .eq("tracking_code", code)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return projectRow(data as unknown as SignatureTrackingDbRow);
}

/** Load one tracking row by its id. */
export async function getTrackingById(
  supabase: SupabaseClient,
  id: string,
): Promise<SignatureTrackingRow | null> {
  const { data, error } = await supabase
    .schema("resupply")
    .from("signature_tracking")
    .select(ROW_COLUMNS)
    .eq("id", id)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return projectRow(data as unknown as SignatureTrackingDbRow);
}

export interface SignatureProviderGroup {
  /** Provider id when grouped by a real provider; null for manual-doc rows. */
  providerId: string | null;
  /** Display name — provider label, practice, or "Unassigned". */
  label: string;
  practiceName: string | null;
  count: number;
  /** ISO timestamp of the oldest outstanding item in the group. */
  oldestCreatedAt: string;
}

export interface OutstandingSignaturesResult {
  count: number;
  rows: SignatureTrackingRow[];
  /** Outstanding items grouped by provider/practice, most-overdue first. */
  byProvider: SignatureProviderGroup[];
}

export interface ListOutstandingOptions {
  status?: SignatureTrackingStatus;
  providerId?: string;
  practiceName?: string;
  kind?: SignatureDocumentKind;
  limit?: number;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/**
 * The dashboard read: outstanding (default awaiting_signature) tracking
 * rows, oldest first, plus a provider/practice rollup for the at-a-glance
 * view. Throws on a DB error (Express middleware → 500).
 */
export async function listOutstandingSignatures(
  supabase: SupabaseClient,
  opts: ListOutstandingOptions = {},
): Promise<OutstandingSignaturesResult> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const status = opts.status ?? "awaiting_signature";

  let query = supabase
    .schema("resupply")
    .from("signature_tracking")
    .select(ROW_COLUMNS)
    .eq("status", status)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (opts.providerId) query = query.eq("provider_id", opts.providerId);
  if (opts.practiceName) query = query.eq("practice_name", opts.practiceName);
  if (opts.kind) query = query.eq("document_kind", opts.kind);

  const { data, error } = await query;
  if (error) throw error;

  const rows = ((data ?? []) as unknown as SignatureTrackingDbRow[]).map(
    projectRow,
  );
  return { count: rows.length, rows, byProvider: groupByProvider(rows) };
}

function groupByProvider(
  rows: SignatureTrackingRow[],
): SignatureProviderGroup[] {
  const groups = new Map<string, SignatureProviderGroup>();
  for (const row of rows) {
    // Key on provider id when present, else the practice name, else a
    // single "unassigned" bucket — so manual documents without a linked
    // provider still roll up sensibly.
    const key = row.providerId ?? row.practiceName ?? "__unassigned__";
    const label =
      row.providerLabel ?? row.practiceName ?? "Unassigned / no provider";
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (row.createdAt < existing.oldestCreatedAt) {
        existing.oldestCreatedAt = row.createdAt;
      }
    } else {
      groups.set(key, {
        providerId: row.providerId,
        label,
        practiceName: row.practiceName,
        count: 1,
        oldestCreatedAt: row.createdAt,
      });
    }
  }
  // Most-overdue first: the group whose oldest item is oldest leads.
  return [...groups.values()].sort((a, b) =>
    a.oldestCreatedAt < b.oldestCreatedAt ? -1 : 1,
  );
}
