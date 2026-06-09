// Hash-chained append-only signature-event log for the provider
// e-signature portal.
//
// Every lifecycle action on a `provider_signature_requests` row writes
// one `provider_signature_events` row. The rows are chained: each
// event's `event_hash` is SHA-256 over the previous event's hash plus a
// canonical serialization of this event's core fields. A printed
// signature certificate can then show an unbroken chain, giving the
// Medicare / insurer auditor tamper-evidence scoped to a single
// signature ceremony.
//
// This is deliberately SELF-CONTAINED and feature-local: it is NOT the
// retired global `resupply.audit_log` machinery (migration 0156) and
// adds no readers against that table. The hash math lives here as a
// pure function so it can be unit-tested without a database.

import { createHash } from "node:crypto";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

/** The genesis previous-hash for the first event in a chain. */
export const GENESIS_HASH = "0".repeat(64);

export type SignatureEventType =
  | "created"
  | "viewed"
  | "signed"
  | "declined"
  | "reminded"
  | "voided"
  | "ready_to_print"
  | "returned_signed"
  | "attached_to_chart"
  | "released";

export type SignatureActorKind = "provider" | "employee" | "system";

/** The hashed core of an event. Field order is fixed via the explicit
 *  key list in {@link canonicalizeEventCore}, NOT object insertion
 *  order, so the hash is stable regardless of how callers build the
 *  object. */
export interface SignatureEventCore {
  requestId: string;
  seq: number;
  eventType: SignatureEventType;
  actorKind: SignatureActorKind;
  actorEmail: string | null;
  payload: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
  occurredAt: string; // ISO-8601
}

/** Stable JSON of an object with recursively sorted keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/** Canonical, deterministic serialization of the hashed core. */
export function canonicalizeEventCore(core: SignatureEventCore): string {
  return stableStringify({
    requestId: core.requestId,
    seq: core.seq,
    eventType: core.eventType,
    actorKind: core.actorKind,
    actorEmail: core.actorEmail ?? null,
    payload: core.payload ?? {},
    ip: core.ip ?? null,
    userAgent: core.userAgent ?? null,
    occurredAt: core.occurredAt,
  });
}

/**
 * Compute one event's hash from the previous hash + this event's core.
 * `prevHash || "\n" || canonical(core)` keeps the domain separator
 * explicit so two adjacent events can never collide by concatenation.
 */
export function computeEventHash(
  prevHash: string,
  core: SignatureEventCore,
): string {
  return createHash("sha256")
    .update(prevHash, "utf8")
    .update("\n", "utf8")
    .update(canonicalizeEventCore(core), "utf8")
    .digest("hex");
}

export interface ChainEvent {
  seq: number;
  prevHash: string;
  eventHash: string;
  core: SignatureEventCore;
}

/**
 * Verify an ordered list of events forms an unbroken chain: the first
 * event chains off {@link GENESIS_HASH}, each subsequent event's
 * `prevHash` equals the prior event's `eventHash`, and every event's
 * `eventHash` recomputes from its core. Returns the index of the first
 * broken link, or null when the chain is intact. Pure — used by the
 * certificate renderer and the unit tests.
 */
export function verifySignatureChain(
  events: ReadonlyArray<ChainEvent>,
): { ok: true } | { ok: false; brokenAtSeq: number; reason: string } {
  let expectedPrev = GENESIS_HASH;
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (const ev of sorted) {
    if (ev.prevHash !== expectedPrev) {
      return {
        ok: false,
        brokenAtSeq: ev.seq,
        reason: "prev_hash_mismatch",
      };
    }
    const recomputed = computeEventHash(ev.prevHash, ev.core);
    if (recomputed !== ev.eventHash) {
      return {
        ok: false,
        brokenAtSeq: ev.seq,
        reason: "event_hash_mismatch",
      };
    }
    expectedPrev = ev.eventHash;
  }
  return { ok: true };
}

export interface AppendEventInput {
  requestId: string;
  eventType: SignatureEventType;
  actorKind: SignatureActorKind;
  actorAccountId?: string | null;
  actorEmail?: string | null;
  payload?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  /** Override the timestamp (tests). Defaults to now. */
  occurredAt?: Date;
}

export interface AppendedEvent {
  id: string;
  seq: number;
  eventHash: string;
}

/**
 * Append one event to a request's chain. Reads the current tail
 * (highest seq + its hash), computes the next link, and inserts.
 *
 * The unique index on (request_id, seq) is the concurrency backstop: if
 * two events race for the same seq, the second insert fails and the
 * caller can retry. Signature ceremonies are human-paced and
 * single-actor per step, so contention is effectively nil — but the
 * index keeps the chain honest if it ever happens.
 */
export async function appendSignatureEvent(
  input: AppendEventInput,
): Promise<AppendedEvent> {
  const supabase = getSupabaseServiceRoleClient();

  const { data: tail, error: tailErr } = await supabase
    .schema("resupply")
    .from("provider_signature_events")
    .select("seq, event_hash")
    .eq("request_id", input.requestId)
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (tailErr) throw tailErr;

  const seq = (tail?.seq ?? 0) + 1;
  const prevHash = tail?.event_hash ?? GENESIS_HASH;
  const occurredAt = (input.occurredAt ?? new Date()).toISOString();

  const core: SignatureEventCore = {
    requestId: input.requestId,
    seq,
    eventType: input.eventType,
    actorKind: input.actorKind,
    actorEmail: input.actorEmail ?? null,
    payload: input.payload ?? {},
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    occurredAt,
  };
  const eventHash = computeEventHash(prevHash, core);

  const { data: inserted, error: insErr } = await supabase
    .schema("resupply")
    .from("provider_signature_events")
    .insert({
      request_id: input.requestId,
      seq,
      event_type: input.eventType,
      actor_kind: input.actorKind,
      actor_account_id: input.actorAccountId ?? null,
      actor_email: input.actorEmail ?? null,
      payload: input.payload ?? {},
      ip: input.ip ?? null,
      user_agent: input.userAgent ?? null,
      prev_hash: prevHash,
      event_hash: eventHash,
      occurred_at: occurredAt,
    })
    .select("id")
    .single();
  if (insErr) throw insErr;

  return { id: inserted.id as string, seq, eventHash };
}
