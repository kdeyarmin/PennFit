// ship-evidence-gate.ts — does the next cycle start at the confirm, or
// wait until something proves the order shipped?
//
// One decision, given its own name because the fail direction is the
// interesting part and it is easy to get backwards.
//
// WHAT THE FLAG DECIDES
// ---------------------
// A refill cycle needs a start date, and there are two candidates: when
// the patient said yes, and when the box actually left. They can be weeks
// apart for a tenant whose orders queue up before shipping, and the
// difference lands on a real patient — start too early and they are
// reminded before they have run out.
//
//   OFF (default, and what every tenant does today)
//     Open at the confirm, dated from the confirm.
//     `recordShipmentEvidence` re-anchors it to the real ship date when
//     evidence arrives, so this is a provisional estimate, not a guess
//     nobody revisits.
//
//   ON
//     Do not open at the confirm. The two producers that KNOW the date
//     take it instead: `recordShipmentEvidence` (dated from the ship)
//     and, if evidence never arrives, the grace sweep in
//     `resupply-cycle-sweep`.
//
// Either way a patient keeps being reminded — the sweep is the floor, and
// that is why this flag is safe to offer at all.
//
// WHY IT FAILS TOWARD "OPEN NOW"
// ------------------------------
// Plain `isFeatureEnabled`, deliberately: it absorbs a failed lookup into
// `false`, and false is the current behaviour for every tenant. The two
// outcomes are not symmetric. Opening a cycle on an estimate is
// RECOVERABLE — the date gets corrected the moment a shipment is
// recorded. Not opening one is not: the cycle then depends entirely on
// evidence arriving, and if the flag read failed spuriously nothing in
// the system knows a cycle was skipped. Prefer the mistake that fixes
// itself.

import { isFeatureEnabled } from "../feature-flags";

/**
 * True when the confirm path should open the next cycle itself.
 *
 * Never throws: `isFeatureEnabled` resolves a failed lookup to `false`,
 * which lands on the recoverable side above.
 */
export async function shouldOpenNextCycleAtConfirm(
  orgId: string,
): Promise<boolean> {
  return !(await isFeatureEnabled("resupply.ship_evidence_required", orgId));
}
