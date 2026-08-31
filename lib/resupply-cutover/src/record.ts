// record.ts — the durable, auditable record of a resupply cutover
// decision, and the state machine the console reads back from it.
//
// `feature_flag_events` already records THAT a flag was toggled. It
// cannot record the EVIDENCE the toggle was based on, and for these two
// flags the evidence is the whole point: each changes when a live patient
// is next contacted, so "was this tenant assessed, and did the assessment
// pass?" has to be answerable six weeks later, from data, by someone who
// was not there.
//
// FOUR STATES, NOT TWO
// --------------------
// A console that shows only ready/blocked cannot distinguish a tenant
// nobody has looked at from one that passed, and cannot distinguish a
// tenant that passed last week from one that passed in March. Both
// distinctions decide whether it is safe to flip:
//
//   ready              assessed, clean, and the assessment is still fresh
//   blocked            assessed, and something is wrong
//   not_evaluated      never assessed
//   validation_expired assessed and clean, but too long ago to trust —
//                      the book of business moved underneath it
//
// `validation_expired` is not a variant of ready. A tenant assessed in
// March and flipped in July was not really assessed.

import { getOrgScopedClient } from "@workspace/resupply-db";

import type {
  CutoverFlagKey,
  ReadinessReport,
  ReadinessStatus,
} from "./readiness";

/**
 * How long a clean readiness verdict may be relied upon. Two weeks is
 * long enough to schedule a cutover across a business week and short
 * enough that the tenant's open-episode book has not turned over.
 */
export const READINESS_TTL_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export type CutoverAction = "evaluate" | "enable" | "rollback";

export type CutoverReadinessState =
  | "ready"
  | "blocked"
  | "not_evaluated"
  | "validation_expired";

export interface CutoverRecordInput {
  orgId: string;
  flagKey: CutoverFlagKey;
  action: CutoverAction;
  previousValue: boolean | null;
  newValue: boolean | null;
  readinessStatus: ReadinessStatus;
  report: ReadinessReport | Record<string, unknown>;
  /**
   * Operator-supplied identifier tying this record to whatever lives
   * outside the system — a ticket, a change request. Free text on
   * purpose: the point is that the same string appears in both places.
   */
  evidenceId?: string | null;
  rollbackReason?: string | null;
  actorEmail?: string | null;
  actorUserId?: string | null;
}

export interface CutoverRecord {
  id: string;
  orgId: string;
  flagKey: CutoverFlagKey;
  action: CutoverAction;
  previousValue: boolean | null;
  newValue: boolean | null;
  readinessStatus: ReadinessStatus;
  report: Record<string, unknown>;
  evidenceId: string | null;
  rollbackReason: string | null;
  actorEmail: string | null;
  evaluatedAt: string;
  createdAt: string;
}

interface Row {
  id: string;
  org_id: string;
  flag_key: string;
  action: string;
  previous_value: boolean | null;
  new_value: boolean | null;
  readiness_status: string;
  report: Record<string, unknown> | null;
  evidence_id: string | null;
  rollback_reason: string | null;
  actor_email: string | null;
  evaluated_at: string;
  created_at: string;
}

function rowToRecord(row: Row): CutoverRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    flagKey: row.flag_key as CutoverFlagKey,
    action: row.action as CutoverAction,
    previousValue: row.previous_value,
    newValue: row.new_value,
    readinessStatus: row.readiness_status as ReadinessStatus,
    report: row.report ?? {},
    evidenceId: row.evidence_id,
    rollbackReason: row.rollback_reason,
    actorEmail: row.actor_email,
    evaluatedAt: row.evaluated_at,
    createdAt: row.created_at,
  };
}

/**
 * Persist a cutover decision.
 *
 * NOT fail-soft. The database enforces `action = 'enable'` implies
 * `readiness_status = 'ready'`, and a rollback implies a reason — so a
 * failed write here means the decision was refused, and the caller must
 * not proceed to flip a flag whose justification could not be recorded.
 *
 * @param input - The decision and the evidence behind it.
 * @returns The persisted record.
 */
export async function writeCutoverRecord(
  input: CutoverRecordInput,
): Promise<CutoverRecord> {
  const supabase = getOrgScopedClient(input.orgId);
  const { data, error } = await supabase
    .from("resupply_cutover_records")
    .insert({
      org_id: input.orgId,
      flag_key: input.flagKey,
      action: input.action,
      previous_value: input.previousValue,
      new_value: input.newValue,
      readiness_status: input.readinessStatus,
      report: input.report as Record<string, unknown>,
      evidence_id: input.evidenceId ?? null,
      rollback_reason: input.rollbackReason ?? null,
      actor_email: input.actorEmail ?? null,
      actor_user_id: input.actorUserId ?? null,
      evaluated_at: new Date().toISOString(),
    })
    .select(
      "id, org_id, flag_key, action, previous_value, new_value, readiness_status, report, evidence_id, rollback_reason, actor_email, evaluated_at, created_at",
    )
    .single();
  if (error) throw error;
  return rowToRecord(data as unknown as Row);
}

/**
 * The most recent record for a tenant/flag, of any action.
 *
 * @param orgId - Tenant.
 * @param flagKey - Cutover flag.
 * @returns The newest record, or null when the flag has never been touched.
 */
export async function readLatestCutoverRecord(
  orgId: string,
  flagKey: CutoverFlagKey,
): Promise<CutoverRecord | null> {
  const supabase = getOrgScopedClient(orgId);
  const { data, error } = await supabase
    .from("resupply_cutover_records")
    .select(
      "id, org_id, flag_key, action, previous_value, new_value, readiness_status, report, evidence_id, rollback_reason, actor_email, evaluated_at, created_at",
    )
    .eq("flag_key", flagKey)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToRecord(data as unknown as Row) : null;
}

/**
 * Cutover history for a tenant/flag, newest first.
 *
 * @param orgId - Tenant.
 * @param flagKey - Cutover flag.
 * @param limit - Page size, capped at 200.
 * @returns The records, newest first.
 */
export async function listCutoverRecords(
  orgId: string,
  flagKey: CutoverFlagKey,
  limit = 50,
): Promise<CutoverRecord[]> {
  const supabase = getOrgScopedClient(orgId);
  const { data, error } = await supabase
    .from("resupply_cutover_records")
    .select(
      "id, org_id, flag_key, action, previous_value, new_value, readiness_status, report, evidence_id, rollback_reason, actor_email, evaluated_at, created_at",
    )
    .eq("flag_key", flagKey)
    .order("created_at", { ascending: false })
    .limit(Math.min(limit, 200));
  if (error) throw error;
  return ((data ?? []) as unknown as Row[]).map(rowToRecord);
}

/**
 * Resolve the state the console should display for a tenant/flag from
 * the most recent record.
 *
 * @param record - Newest record, or null when there is none.
 * @param now - Clock, for the freshness window.
 * @returns The display state plus the age it was derived from.
 */
export function resolveReadinessState(
  record: CutoverRecord | null,
  now: Date = new Date(),
): { state: CutoverReadinessState; ageDays: number | null } {
  if (!record) return { state: "not_evaluated", ageDays: null };

  const evaluatedMs = Date.parse(record.evaluatedAt);
  if (!Number.isFinite(evaluatedMs)) {
    // An unreadable timestamp is not "fresh"; refuse to imply it is.
    return { state: "not_evaluated", ageDays: null };
  }
  const ageDays = Math.floor((now.getTime() - evaluatedMs) / DAY_MS);

  if (record.readinessStatus !== "ready") {
    // A blocked or errored assessment stays blocked however old it is.
    // Age cannot turn a failure into an unknown.
    return { state: "blocked", ageDays };
  }
  if (ageDays > READINESS_TTL_DAYS) {
    return { state: "validation_expired", ageDays };
  }
  return { state: "ready", ageDays };
}

/**
 * Is there a fresh, clean assessment authorising an enable right now?
 *
 * This is the gate the enable path consults. It deliberately does NOT
 * accept a stale pass — see the header.
 *
 * @param orgId - Tenant.
 * @param flagKey - Cutover flag.
 * @param now - Clock.
 * @returns Whether enabling is authorised, and why not when it is not.
 */
export async function hasFreshReadyAssessment(
  orgId: string,
  flagKey: CutoverFlagKey,
  now: Date = new Date(),
): Promise<{
  ok: boolean;
  state: CutoverReadinessState;
  record: CutoverRecord | null;
}> {
  let record: CutoverRecord | null;
  try {
    record = await readLatestCutoverRecord(orgId, flagKey);
  } catch {
    // Fail CLOSED. A readiness gate that cannot read its own history
    // must not conclude "go ahead" — the whole point is that nobody
    // flips these without evidence. No logger here: this package is
    // imported by a tsx script with no pino instance, and the callers
    // (the admin route, the CLI) both surface the returned state.
    return { ok: false, state: "not_evaluated", record: null };
  }
  const { state } = resolveReadinessState(record, now);
  return { ok: state === "ready", state, record };
}
