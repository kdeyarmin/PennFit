// GET /admin/approval-gates — what is waiting on a person, and why.
//
// The platform's human-approval posture is deliberate and correct, and
// the code says so at each site. But it is stated in about a dozen places
// and nowhere as a set, so an operator could not see what was waiting on
// them without opening a dozen queues and knowing which ones existed —
// and nobody could check whether the product's description of itself was
// still true. This is that set, with live counts.
//
// IT CHANGES NO GATE. Read-only, counts only. Adding an entry to the
// registry does not create a control; removing one does not open
// anything.
//
// PHI: table names, statuses, and counts. Nothing reaches a patient
// record, so this is safe on a dashboard anyone with reports.read can
// open.

import { Router, type IRouter } from "express";

import { getOrgScopedClient } from "@workspace/resupply-db";

import {
  APPROVAL_ACTOR_LABEL,
  APPROVAL_GATES,
  type ApprovalGate,
} from "../../lib/approval-gates/registry";
import { isFeatureEnabled, type FeatureFlagKey } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

/**
 * Count one gate's backlog.
 *
 * Returns `null` — NOT zero — when the count cannot be taken: a gate with
 * no single countable queue, or a query that failed. "Nothing is waiting"
 * and "we could not find out" are different answers, and rendering a
 * failed lookup as an empty queue is how a backlog goes unnoticed.
 */
async function countGate(
  supabase: ReturnType<typeof getOrgScopedClient>,
  gate: ApprovalGate,
): Promise<number | null> {
  if (!gate.queue) return null;
  try {
    let q = supabase
      .from(gate.queue.table)
      .select("*", { count: "exact", head: true });
    for (const [column, value] of Object.entries(gate.queue.match)) {
      // `required: "true"` in the registry is a boolean column; PostgREST
      // accepts the string form, so no per-gate special-casing is needed.
      q = q.eq(column, value);
    }
    if (gate.queue.anyOf) {
      q = q.in(gate.queue.anyOf.column, gate.queue.anyOf.values);
    }
    if (gate.queue.isNull) {
      q = q.is(gate.queue.isNull, null);
    }
    const { count, error } = await q;
    if (error) throw error;
    return count ?? 0;
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
    return null;
  }
}

router.get(
  "/admin/approval-gates",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId || !orgId.trim()) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    const counts = await Promise.all(
      APPROVAL_GATES.map((gate) => countGate(supabase, gate)),
    );

    // A gate can be conditionally automated for this tenant. Resolving it
    // fails toward "fully manual", which is the safe reading: over-
    // promising automation is what would leave a queue unworked.
    const partlyAutomated = new Set<string>();
    await Promise.all(
      APPROVAL_GATES.filter((g) => g.conditionalOn).map(async (gate) => {
        try {
          if (
            await isFeatureEnabled(gate.conditionalOn as FeatureFlagKey, orgId)
          )
            partlyAutomated.add(gate.key);
        } catch {
          // Leave it out: the gate reads as fully manual.
        }
      }),
    );

    const gates = APPROVAL_GATES.map((gate, i) => ({
      key: gate.key,
      label: gate.label,
      actor: gate.actor,
      actorLabel: APPROVAL_ACTOR_LABEL[gate.actor],
      why: gate.why,
      href: gate.href,
      permission: gate.permission,
      /**
       * Whether this gate has a queue to count AT ALL — a static property
       * of the registry, not of this request. Without it a `waiting: null`
       * is ambiguous between "this step has no single queue" and "we could
       * not read it just now", and an operator during a partial outage
       * reads a permanent dash as the former.
       */
      countable: gate.queue != null,
      /** null = not countable, or the count failed. Never conflate with 0. */
      waiting: counts[i] ?? null,
      /**
       * True when a worker moves part of this queue for this tenant, so
       * `waiting` is a ceiling rather than a backlog. The exact subset
       * cannot be counted here — the auto-submit predicate spans tables
       * PostgREST cannot join — and an inflated "needs a person" number
       * that the operator then finds already handled is how a panel
       * loses their trust.
       */
      partlyAutomated: partlyAutomated.has(gate.key),
    }));

    const counted = gates.filter((g) => typeof g.waiting === "number");

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      gates,
      totals: {
        gateCount: gates.length,
        // Sum of the queues we could actually read, reported alongside
        // both reasons a gate is missing from it — separately, because
        // they mean opposite things. `uncountableGates` is a constant of
        // the registry; a non-zero `failedCounts` is an outage, and
        // folding the two together hides it inside a number that always
        // looks the same.
        waiting: counted.reduce((sum, g) => sum + (g.waiting ?? 0), 0),
        uncountableGates: gates.filter((g) => !g.countable).length,
        failedCounts: gates.filter((g) => g.countable && g.waiting === null)
          .length,
      },
    });
  },
);

export default router;
