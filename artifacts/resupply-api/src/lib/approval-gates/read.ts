// Reading one approval gate's queue: how many are waiting, and how long
// the oldest has waited.
//
// Extracted from the /admin/approval-gates route because the lifecycle
// health monitor needs the same answer, and two implementations of "is
// this queue past its SLA" would eventually disagree — at which point
// the panel and the alert say different things about the same queue and
// neither is believed.

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../logger";

import type { ApprovalGate } from "./registry";

const HOUR_MS = 60 * 60 * 1000;

export interface GateReading {
  /** null when the gate has no queue, or the read failed. */
  waiting: number | null;
  /** ISO timestamp of the oldest waiting item, when one exists. */
  oldestAt: string | null;
  /** Did the read itself fail? Distinct from an empty queue. */
  failed: boolean;
}

/**
 * Multiplier past the SLA at which a queue stops being "late" and starts
 * being "nobody is working this".
 *
 * Configurable because the right number depends on the practice's size,
 * and a hard-coded one is a number somebody argues with rather than
 * tunes. Read at call time so a change takes effect without a deploy.
 */
export function escalationMultiplier(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env.APPROVAL_GATE_ESCALATION_MULTIPLIER);
  return Number.isFinite(raw) && raw >= 1 ? raw : 3;
}

/**
 * Count one gate's backlog, and find its oldest item.
 *
 * Returns `failed: true` — NOT zero — when the count cannot be taken.
 * "Nothing is waiting" and "we could not find out" are different answers,
 * and rendering a failed lookup as an empty queue is how a backlog goes
 * unnoticed.
 *
 * The count uses `head: true`, so it is a COUNT at the database and is
 * not subject to PostgREST's row cap — a queue of five thousand reports
 * five thousand, not a truncated thousand.
 */
export async function readGate(
  supabase: ReturnType<typeof getOrgScopedClient>,
  gate: ApprovalGate,
): Promise<GateReading> {
  if (!gate.queue) return { waiting: null, oldestAt: null, failed: false };

  const applyFilters = <T extends Record<string, unknown>>(query: T): T => {
    let q = query as unknown as {
      eq: (c: string, v: unknown) => unknown;
      in: (c: string, v: unknown[]) => unknown;
      is: (c: string, v: null) => unknown;
    };
    for (const [column, value] of Object.entries(gate.queue!.match)) {
      // `required: "true"` in the registry is a boolean column; PostgREST
      // accepts the string form, so no per-gate special-casing is needed.
      q = q.eq(column, value) as typeof q;
    }
    if (gate.queue!.anyOf) {
      q = q.in(gate.queue!.anyOf.column, gate.queue!.anyOf.values) as typeof q;
    }
    if (gate.queue!.isNull) {
      q = q.is(gate.queue!.isNull, null) as typeof q;
    }
    return q as unknown as T;
  };

  let waiting: number;
  try {
    const q = applyFilters(
      supabase.from(gate.queue.table).select("*", {
        count: "exact",
        head: true,
      }) as unknown as Record<string, unknown>,
    );
    const { count, error } = (await q) as unknown as {
      count: number | null;
      error: unknown;
    };
    if (error) throw error;
    waiting = count ?? 0;
  } catch (err) {
    logger.warn(
      {
        event: "approval_gates.count_failed",
        gate: gate.key,
        table: gate.queue.table,
        errName: err instanceof Error ? err.name : "unknown",
      },
      "approval-gates: could not count a queue",
    );
    return { waiting: null, oldestAt: null, failed: true };
  }

  // The oldest item, for the age reading. Only when there IS one — an
  // empty queue has no oldest item, and asking is a wasted round trip.
  let oldestAt: string | null = null;
  const ageColumn = gate.queue.ageColumn;
  if (waiting > 0 && ageColumn) {
    try {
      const q = applyFilters(
        supabase.from(gate.queue.table).select(ageColumn) as unknown as Record<
          string,
          unknown
        >,
      ) as unknown as {
        order: (
          c: string,
          o: { ascending: boolean; nullsFirst: boolean },
        ) => unknown;
      };
      // NULLS LAST, explicitly. Some age columns are stamped alongside a
      // status change and can be missing on a row that predates the
      // stamp; ordering NULLS FIRST would make such a row the "oldest
      // item" and then read its null timestamp as no age at all — the
      // queue would report `unknown` while a genuinely old item sat
      // behind it. The unstamped row still counts toward `waiting`.
      const { data, error } = (await (
        q.order(ageColumn, {
          ascending: true,
          nullsFirst: false,
        }) as unknown as {
          limit: (n: number) => { maybeSingle: () => Promise<unknown> };
        }
      )
        .limit(1)
        .maybeSingle()) as unknown as {
        data: Record<string, string> | null;
        error: unknown;
      };
      if (error) throw error;
      oldestAt = data?.[ageColumn] ?? null;
    } catch (err) {
      // A failed AGE read is not a failed count. The count stands; the
      // age is simply unknown, and saying so is better than dropping the
      // whole gate to null.
      logger.warn(
        {
          event: "approval_gates.age_failed",
          gate: gate.key,
          errName: err instanceof Error ? err.name : "unknown",
        },
        "approval-gates: could not read a queue's oldest item",
      );
    }
  }

  return { waiting, oldestAt, failed: false };
}

/** `ok` | `due_soon` | `breached` | `escalate` | `no_sla` | `unknown`. */
export function ageStatus(
  slaHours: number | null,
  oldestAt: string | null,
  now: number,
  multiplier: number,
): { ageHours: number | null; status: string } {
  if (oldestAt === null) {
    return { ageHours: null, status: slaHours === null ? "no_sla" : "ok" };
  }
  const parsed = Date.parse(oldestAt);
  if (!Number.isFinite(parsed)) return { ageHours: null, status: "unknown" };
  const ageHours = Math.max(0, (now - parsed) / HOUR_MS);
  if (slaHours === null) return { ageHours, status: "no_sla" };
  if (ageHours >= slaHours * multiplier)
    return { ageHours, status: "escalate" };
  if (ageHours >= slaHours) return { ageHours, status: "breached" };
  if (ageHours >= slaHours * 0.75) return { ageHours, status: "due_soon" };
  return { ageHours, status: "ok" };
}
