// Aggregate the outstanding prescription-request packets that still
// need a physician's signature, scoped to a single provider or a
// single practice, so a CSR can print the whole batch at once and
// hand-carry it for in-person signing.
//
// Why this exists
// ---------------
// The normal flow faxes one packet at a time (see
// routes/admin/prescription-requests.ts -> send-fax). But practices we
// visit in person — or whose fax keeps bouncing — are far faster to
// clear by walking in with every open order for that office in one
// stack. This module is the read side of that workflow: given a
// provider id or a practice name, return every packet that is still
// awaiting signature, with just enough patient/provider context to
// render a cover manifest and the per-packet PDFs.
//
// "Practice" is denormalized onto `providers.practice_name` (there is
// no separate practice table), so a practice batch is "every open
// packet whose ordering provider shares this practice_name".
//
// Pure-ish: takes a Supabase client + a target, performs reads, returns
// the typed result. No logging side effects, no PDF rendering (the
// route layer composes the combined PDF from these rows).

import type { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

// A packet in one of these statuses still needs a signature — it is
// "outstanding". The terminal states (`signed`, `void`, `expired`) are
// excluded. `failed` is deliberately included: a packet whose fax
// bounced is exactly the kind we want to print and hand-deliver.
export const SIGNATURE_PENDING_STATUSES = [
  "draft",
  "sent_fax",
  "delivered",
  "failed",
] as const;

export type SignaturePendingStatus =
  (typeof SIGNATURE_PENDING_STATUSES)[number];

export type SignatureTarget =
  | { kind: "provider"; providerId: string }
  | { kind: "practice"; practiceName: string };

export interface PacketNeedingSignature {
  /** prescription_request_packets.id — feed to the per-packet renderer. */
  id: string;
  patientId: string;
  /** "Last, First" for the cover manifest. */
  patientName: string;
  providerId: string | null;
  providerName: string | null;
  providerNpi: string | null;
  practiceName: string | null;
  status: SignaturePendingStatus | string;
  returnFaxE164: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface SignatureAggregation {
  target: SignatureTarget;
  /** Human-readable header for the printed batch (provider/practice). */
  label: string;
  count: number;
  /** Oldest first — the order we want them stacked for signing. */
  packets: PacketNeedingSignature[];
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

// Shape of the embedded rows PostgREST returns for the select below.
// The generated Database types don't carry the embedded relationships,
// so we describe the projection locally and cast (matching the pattern
// in routes/admin/providers.ts).
interface PacketJoinRow {
  id: string;
  patient_id: string;
  provider_id: string | null;
  status: string;
  return_fax_e164: string | null;
  sent_at: string | null;
  created_at: string;
  patients: {
    legal_first_name: string | null;
    legal_last_name: string | null;
  } | null;
  providers: {
    id: string;
    legal_name: string | null;
    npi: string | null;
    practice_name: string | null;
  } | null;
}

/**
 * Aggregate every outstanding (signature-pending) packet for a single
 * provider or practice, oldest first. Throws on a DB error so the
 * caller's Express error middleware returns a 500.
 */
export async function aggregatePacketsNeedingSignature(
  supabase: SupabaseClient,
  target: SignatureTarget,
  opts: { limit?: number } = {},
): Promise<SignatureAggregation> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  // `patients!inner` / `providers!inner`: every signature-pending packet
  // we care about is tied to a real patient (NOT NULL FK) and a real
  // provider — the provider filter (by id or by practice_name) requires
  // a non-null join either way, so inner is correct and lets the
  // practice filter reference `providers.practice_name`.
  let query = supabase
    .schema("resupply")
    .from("prescription_request_packets")
    .select(
      "id, patient_id, provider_id, status, return_fax_e164, sent_at, created_at, " +
        "patients!inner(legal_first_name, legal_last_name), " +
        "providers!inner(id, legal_name, npi, practice_name)",
    )
    .in("status", SIGNATURE_PENDING_STATUSES as unknown as string[])
    .order("created_at", { ascending: true })
    .limit(limit);

  if (target.kind === "provider") {
    query = query.eq("provider_id", target.providerId);
  } else {
    query = query.eq("providers.practice_name", target.practiceName);
  }

  const { data, error } = await query;
  if (error) throw error;

  const rows = (data ?? []) as unknown as PacketJoinRow[];
  const packets = rows.map(projectPacketRow);

  return {
    target,
    label: deriveLabel(target, packets),
    count: packets.length,
    packets,
  };
}

function projectPacketRow(r: PacketJoinRow): PacketNeedingSignature {
  return {
    id: r.id,
    patientId: r.patient_id,
    patientName: formatPatientName(
      r.patients?.legal_first_name ?? null,
      r.patients?.legal_last_name ?? null,
    ),
    providerId: r.provider_id,
    providerName: r.providers?.legal_name ?? null,
    providerNpi: r.providers?.npi ?? null,
    practiceName: r.providers?.practice_name ?? null,
    status: r.status,
    returnFaxE164: r.return_fax_e164,
    sentAt: r.sent_at,
    createdAt: r.created_at,
  };
}

function formatPatientName(first: string | null, last: string | null): string {
  const f = (first ?? "").trim();
  const l = (last ?? "").trim();
  if (l && f) return `${l}, ${f}`;
  return l || f || "—";
}

// The batch header. For a practice we always have the name. For a
// provider we prefer "Provider name (Practice)" derived from the first
// packet, falling back to the raw id when the batch is empty.
function deriveLabel(
  target: SignatureTarget,
  packets: PacketNeedingSignature[],
): string {
  if (target.kind === "practice") return target.practiceName;
  const first = packets[0];
  if (first?.providerName) {
    return first.practiceName
      ? `${first.providerName} (${first.practiceName})`
      : first.providerName;
  }
  return target.providerId;
}
