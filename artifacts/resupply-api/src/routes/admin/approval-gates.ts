// GET /admin/approval-gates — what is waiting on a person, how long it
// has been waiting, and why a person is required.
//
// The platform's human-approval posture is deliberate and correct, and
// the code says so at each site. But it is stated in about a dozen places
// and nowhere as a set, so an operator could not see what was waiting on
// them without opening a dozen queues and knowing which ones existed —
// and nobody could check whether the product's description of itself was
// still true. This is that set, with live counts.
//
// A COUNT ALONE IS THE LESS USEFUL HALF
// -------------------------------------
// Five items sitting for six weeks and fifty that arrived this morning
// are different problems, and only the first is failing anybody. So each
// countable gate also reports the age of its OLDEST item, measured
// against a per-gate expectation.
//
// The expectations are per gate because they are not comparable. A
// patient waiting on an address confirmation is blocking a shipment
// today; a catalog sign-off is a standing task with no due date at all,
// and giving it an SLA would manufacture an alarm.
//
// FOUR STATES, NOT TWO
// --------------------
// "Nothing is waiting", "this step has no single countable queue", "the
// count failed just now", and "a worker moves part of this queue" are
// four different answers, and three of them look like zero if you let
// them. Each is reported distinctly:
//
//   waiting: 0             the queue is genuinely empty
//   countable: false       + uncountableReason — a permanent property
//   waiting: null          the read failed; an outage, not an empty queue
//   partlyAutomated: true  the count is a CEILING, not a backlog
//
// IT CHANGES NO GATE. Read-only. Adding an entry to the registry does not
// create a control; removing one does not open anything.
//
// PHI: table names, statuses, counts and ages. Nothing reaches a patient
// record, so this is safe on a dashboard anyone with reports.read can
// open.

import { Router, type IRouter } from "express";

import { getOrgScopedClient } from "@workspace/resupply-db";

import {
  ageStatus,
  escalationMultiplier,
  readGate,
} from "../../lib/approval-gates/read";
import {
  APPROVAL_ACTOR_LABEL,
  APPROVAL_GATES,
} from "../../lib/approval-gates/registry";
import { isFeatureEnabled, type FeatureFlagKey } from "../../lib/feature-flags";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// `readGate`, `ageStatus` and `escalationMultiplier` now live in
// lib/approval-gates/read.ts — the lifecycle health monitor asks the same
// question of the same queues, and two implementations of "is this queue
// past its SLA" would eventually disagree.

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
    const now = Date.now();
    const multiplier = escalationMultiplier();

    const readings = await Promise.all(
      APPROVAL_GATES.map((gate) => readGate(supabase, gate)),
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

    const gates = APPROVAL_GATES.map((gate, i) => {
      const reading = readings[i];
      const age = ageStatus(gate.slaHours, reading.oldestAt, now, multiplier);
      return {
        key: gate.key,
        label: gate.label,
        actor: gate.actor,
        actorLabel: APPROVAL_ACTOR_LABEL[gate.actor],
        why: gate.why,
        href: gate.href,
        permission: gate.permission,
        priority: gate.priority,
        disposition: gate.disposition,
        slaHours: gate.slaHours,
        /**
         * Whether this gate has a queue to count AT ALL — a static
         * property of the registry, not of this request. Without it a
         * `waiting: null` is ambiguous between "this step has no single
         * queue" and "we could not read it just now", and an operator
         * during a partial outage reads a permanent dash as the former.
         */
        countable: gate.queue != null,
        /** Why not, when it is not. Makes the dash informative. */
        uncountableReason: gate.uncountableReason ?? null,
        /** null = not countable, or the count failed. Never conflate with 0. */
        waiting: reading.waiting,
        /** True only when the read itself failed. An outage signal. */
        countFailed: reading.failed,
        oldestAt: reading.oldestAt,
        oldestAgeHours:
          age.ageHours === null ? null : Math.round(age.ageHours * 10) / 10,
        /** ok | due_soon | breached | escalate | no_sla | unknown */
        ageStatus: age.status,
        /**
         * True when a worker moves part of this queue for this tenant, so
         * `waiting` is a ceiling rather than a backlog. The exact subset
         * cannot be counted here — the auto-submit predicate spans tables
         * PostgREST cannot join — and an inflated "needs a person" number
         * that the operator then finds already handled is how a panel
         * loses their trust.
         */
        partlyAutomated: partlyAutomated.has(gate.key),
      };
    });

    const counted = gates.filter((g) => typeof g.waiting === "number");

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      gates,
      /**
       * When this reading was taken. A dashboard left open overnight
       * shows yesterday's queue depths as though they were now, and an
       * operator has no way to tell — the counts look identical.
       */
      refreshedAt: new Date(now).toISOString(),
      escalationMultiplier: multiplier,
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
        failedCounts: gates.filter((g) => g.countFailed).length,
        breachedGates: gates.filter(
          (g) => g.ageStatus === "breached" || g.ageStatus === "escalate",
        ).length,
        escalatedGates: gates.filter((g) => g.ageStatus === "escalate").length,
      },
    });
  },
);

export default router;
