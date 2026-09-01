// Fetch wrapper for /admin/approval-gates — the set of transitions that
// require a person, with live counts. Read-only; the route changes no
// gate.

import { ApiError } from "@workspace/api-client-react/admin";

export interface ApprovalGateRow {
  key: string;
  label: string;
  actor: "biller" | "csr" | "clinician" | "owner";
  actorLabel: string;
  /** Why a person is required. Shown verbatim — it is the answer to the
   *  question the panel provokes. */
  why: string;
  href: string;
  permission: string;
  /** Whether this gate has a queue to count at all — static, from the
   *  registry. Distinguishes a permanent dash from a failed lookup. */
  countable: boolean;
  /** `null` when there is no single countable queue, or the count failed.
   *  Never render this as zero; read `countable` to tell the two apart. */
  waiting: number | null;
  /** A worker moves part of this queue for this tenant, so `waiting` is a
   *  ceiling rather than a backlog. */
  partlyAutomated: boolean;

  /** True only when the read itself failed — an outage signal, distinct
   *  from a gate that has no queue at all. */
  countFailed: boolean;
  /** Why a gate cannot be counted, when it cannot. Makes a permanent
   *  dash informative rather than indistinguishable from an outage. */
  uncountableReason: string | null;
  /** 1 = a patient is blocked today. 3 = a standing task. */
  priority: 1 | 2 | 3;
  /** Where this gate's decision is recorded, for the question always
   *  asked afterwards: who approved this, and when? */
  disposition: string;
  /** Hours this queue is expected to be worked within. `null` for a
   *  standing task — giving one an SLA would manufacture an alarm. */
  slaHours: number | null;
  /** The oldest waiting item. Five items sitting for six weeks and fifty
   *  that arrived this morning are different problems, and a count alone
   *  cannot tell them apart. */
  oldestAt: string | null;
  oldestAgeHours: number | null;
  /**
   * `ok` | `due_soon` | `breached` | `escalate` | `no_sla` | `unknown`.
   *
   * `escalate` is past the SLA by a configurable multiple: past the SLA
   * is late, past the multiple is nobody is working this, and those want
   * different responses.
   */
  ageStatus: string;
}

export interface ApprovalGatesResponse {
  gates: ApprovalGateRow[];
  /** When this reading was taken. A dashboard left open overnight shows
   *  yesterday's depths as though they were now. */
  refreshedAt: string;
  escalationMultiplier: number;
  totals: {
    gateCount: number;
    waiting: number;
    /** Gates with no single queue to count — a constant of the registry. */
    uncountableGates: number;
    /** Gates whose count failed on THIS request. Non-zero means the
     *  totals are understated right now, which is an outage, not a
     *  quiet day. */
    failedCounts: number;
    /** Queues whose oldest item is past that queue's own expectation. */
    breachedGates: number;
    /** …and past it by the escalation multiple, which is a different
     *  problem: not "late" but "nobody is working this". */
    escalatedGates: number;
  };
}

export async function fetchApprovalGates(): Promise<ApprovalGatesResponse> {
  const url = "/resupply-api/admin/approval-gates";
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as ApprovalGatesResponse;
}
