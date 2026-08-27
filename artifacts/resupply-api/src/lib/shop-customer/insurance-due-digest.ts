// Pure helpers for the signed-in home dashboard's insurance due digest.
// Maps in-progress outreach episodes (+ prescription SKUs) onto the
// legacy Subscribe & Save `nextShipment` / `eligibility` JSON shape the
// SPA already renders — without reading retired shop_subscriptions.

const DAY_MS = 24 * 60 * 60 * 1000;

export const IN_PROGRESS_EPISODE_STATUSES = [
  "outreach_pending",
  "awaiting_response",
] as const;

export interface EpisodeDueRow {
  id: string;
  prescription_id: string;
  due_at: string;
}

export interface DashboardNextShipment {
  subscriptionId: string;
  date: string;
  daysUntil: number;
  firstItemName: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface DashboardEligibility {
  eligibleNow: Array<{
    subscriptionId: string;
    firstItemName: string | null;
  }>;
  soonest: {
    firstItemName: string | null;
    daysUntil: number;
  } | null;
}

export interface InsuranceDueDigest {
  nextShipment: DashboardNextShipment | null;
  eligibility: DashboardEligibility;
}

function startOfUtcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Whole UTC days from `now` until `dueAt`. Negative when overdue. */
export function daysUntilDue(dueAtIso: string, now: Date = new Date()): number {
  const due = Date.parse(dueAtIso);
  if (!Number.isFinite(due)) return 0;
  return Math.ceil(
    (startOfUtcDay(new Date(due)) - startOfUtcDay(now)) / DAY_MS,
  );
}

function displayNameForSku(sku: string | null | undefined): string | null {
  if (!sku || !sku.trim()) return null;
  return sku.trim();
}

/**
 * Build the home-banner due digest from in-progress episodes.
 * Earliest `due_at` wins for `nextShipment`; overdue rows populate
 * `eligibleNow`; the closest future (or overdue) row is `soonest`.
 */
export function buildInsuranceDueDigest(
  episodes: EpisodeDueRow[],
  skuByPrescriptionId: Map<string, string>,
  now: Date = new Date(),
): InsuranceDueDigest {
  const empty: InsuranceDueDigest = {
    nextShipment: null,
    eligibility: { eligibleNow: [], soonest: null },
  };
  if (episodes.length === 0) return empty;

  const ranked = [...episodes].sort((a, b) => {
    const da = Date.parse(a.due_at) || 0;
    const db = Date.parse(b.due_at) || 0;
    if (da !== db) return da - db;
    return a.id.localeCompare(b.id);
  });

  const eligibleNow: DashboardEligibility["eligibleNow"] = [];
  let soonestFuture: {
    firstItemName: string | null;
    daysUntil: number;
  } | null = null;

  for (const ep of ranked) {
    const days = daysUntilDue(ep.due_at, now);
    const name = displayNameForSku(skuByPrescriptionId.get(ep.prescription_id));
    if (days <= 0) {
      eligibleNow.push({
        subscriptionId: ep.id,
        firstItemName: name,
      });
    } else if (!soonestFuture) {
      soonestFuture = { firstItemName: name, daysUntil: days };
    }
  }

  const earliest = ranked[0]!;
  const earliestDays = daysUntilDue(earliest.due_at, now);
  const earliestName = displayNameForSku(
    skuByPrescriptionId.get(earliest.prescription_id),
  );

  const soonest =
    eligibleNow.length > 0
      ? {
          firstItemName: eligibleNow[0]!.firstItemName,
          daysUntil: 0,
        }
      : soonestFuture;

  return {
    nextShipment: {
      subscriptionId: earliest.id,
      date: earliest.due_at,
      daysUntil: Math.max(0, earliestDays),
      firstItemName: earliestName,
      cancelAtPeriodEnd: false,
    },
    eligibility: {
      eligibleNow,
      soonest,
    },
  };
}
