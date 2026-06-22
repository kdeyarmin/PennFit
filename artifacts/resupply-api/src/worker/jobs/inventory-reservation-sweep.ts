// pg-boss job: inventory-reservation sweep.
//
// Expires (active → expired) every inventory hold whose TTL has passed,
// across every active tenant. The reserve_inventory RPC already filters on
// `expires_at > now()` when summing live holds, so a stale hold never counts
// toward availability — this sweep is HOUSEKEEPING (keeps the active partial
// index small and the ledger truthful), not a correctness dependency. The
// guard stays correct even if this cron never runs.
//
// SCHEDULE — built-in default, env-overridable. Unlike the opt-in bill-hold
// sweep, this one is always-on (the guard is fail-open and strictly safer, so
// there's no reason to gate it). It runs every 5 minutes by default; set
// INVENTORY_RESERVATION_SWEEP_CRON to override the cadence.
//
// PHI: logs counts + org ids only — never order bodies.

import type PgBoss from "pg-boss";

import { logger } from "../../lib/logger.js";
import { expireStaleReservations } from "../../lib/inventory/reservations.js";
import { forEachActiveOrg } from "../lib/for-each-active-org.js";
import {
  createQueueWithDlq,
  CRON_SCAN_QUEUE_OPTS,
} from "../lib/queue-options.js";

export const INVENTORY_RESERVATION_SWEEP_JOB = "inventory.reservation-sweep";

/** Default cadence when INVENTORY_RESERVATION_SWEEP_CRON is unset. */
const DEFAULT_SWEEP_CRON = "*/5 * * * *";

export interface InventoryReservationSweepStats {
  /** Tenants scanned. */
  orgsScanned: number;
  /** Active holds moved to `expired` across all tenants. */
  expired: number;
}

/**
 * Run the sweep for EVERY active tenant. `inventory_reservations` is
 * tenant-scoped, so we fan out per org and accumulate. Per-tenant failures
 * are isolated by forEachActiveOrg (one tenant's error doesn't stop the rest)
 * and expireStaleReservations itself returns 0 on error rather than throwing.
 */
export async function runInventoryReservationSweep(): Promise<InventoryReservationSweepStats> {
  const stats: InventoryReservationSweepStats = { orgsScanned: 0, expired: 0 };
  await forEachActiveOrg(
    async (orgId) => {
      stats.orgsScanned += 1;
      stats.expired += await expireStaleReservations(orgId, logger);
    },
    { jobName: INVENTORY_RESERVATION_SWEEP_JOB },
  );
  return stats;
}

export async function registerInventoryReservationSweepJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(
    boss,
    INVENTORY_RESERVATION_SWEEP_JOB,
    CRON_SCAN_QUEUE_OPTS,
  );
  await boss.work(INVENTORY_RESERVATION_SWEEP_JOB, async () => {
    try {
      const stats = await runInventoryReservationSweep();
      logger.info(
        { event: "inventory.reservation-sweep.completed", ...stats },
        "inventory-reservation-sweep: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "inventory-reservation-sweep: failed",
      );
      throw err;
    }
  });

  // Always-on cron with a built-in default; the env var only overrides the
  // cadence. (Re-attaching the same schedule each boot is idempotent in
  // pg-boss — it upserts the schedule row.)
  const cron =
    process.env.INVENTORY_RESERVATION_SWEEP_CRON?.trim() || DEFAULT_SWEEP_CRON;
  await boss.schedule(INVENTORY_RESERVATION_SWEEP_JOB, cron);
  logger.info(
    { queue: INVENTORY_RESERVATION_SWEEP_JOB, cron },
    "inventory-reservation-sweep scheduled",
  );
}
