// Patient CPAP hygiene maintenance catalog.
//
// Static catalog of tasks the patient-facing /account checklist
// surfaces. Each task has a stable `key`, a cadence (in days),
// a label + one-line "why" copy, and a clinical rationale comment
// for code reviewers.
//
// Why the catalog lives here (not in the DB):
//   * The set of tasks evolves with the codebase — a new task needs
//     new SPA copy and analytics anyway, so versioning it in code
//     keeps everything in lockstep.
//   * Cadences are NOT user-tunable. ResMed, Philips, F&P all
//     publish identical hygiene schedules; deviating is a clinical
//     call, not a per-tenant config.
//
// Manufacturer guidance sources (general consensus across the
// "big three" — exact citation deliberately omitted to keep this
// file free of vendor pages that 404 over time):
//   * Mask cushion / pillow: daily wipe, weekly mild-soap wash.
//   * Headgear: weekly hand wash.
//   * Hose / tubing: weekly inside-flush.
//   * Humidifier chamber: weekly, vinegar descale monthly.
//   * Filter: monthly inspect / replace per device guidance.

export type MaintenanceCategory =
  | "mask"
  | "tubing"
  | "humidifier"
  | "filter";

export interface MaintenanceTask {
  key: string;
  label: string;
  category: MaintenanceCategory;
  /** Days between completions. Cadence is fixed in code (see file
   *  preamble); we don't accept a per-patient override. */
  frequencyDays: number;
  /** One-line copy shown next to the checkbox on /account. */
  why: string;
}

export const MAINTENANCE_CATALOG: ReadonlyArray<MaintenanceTask> = [
  {
    key: "mask_cushion_wipe",
    label: "Wipe down mask cushion",
    category: "mask",
    frequencyDays: 1,
    why: "Daily face-oil wipe-down keeps the seal tight and skin clear.",
  },
  {
    key: "mask_wash",
    label: "Wash mask + headgear",
    category: "mask",
    frequencyDays: 7,
    why: "Weekly mild-soap wash extends cushion life and prevents irritation.",
  },
  {
    key: "tubing_wash",
    label: "Flush hose with warm soapy water",
    category: "tubing",
    frequencyDays: 7,
    why: "Weekly hose flush prevents mold + keeps airflow clean.",
  },
  {
    key: "humidifier_chamber_wash",
    label: "Wash humidifier chamber",
    category: "humidifier",
    frequencyDays: 7,
    why: "Weekly wash + monthly vinegar descale prevents bacterial buildup.",
  },
  {
    key: "filter_replace",
    label: "Inspect / replace air filter",
    category: "filter",
    frequencyDays: 30,
    why: "Monthly filter swap keeps the motor breathing clean room air.",
  },
];

/** Lookup by key (catalog is small; linear scan is fine). */
export function findMaintenanceTask(
  key: string,
): MaintenanceTask | undefined {
  return MAINTENANCE_CATALOG.find((t) => t.key === key);
}

/** Set of valid keys for fast Zod-side validation. */
export const MAINTENANCE_TASK_KEYS = MAINTENANCE_CATALOG.map((t) => t.key);

/** Bucket of a task's "next due" date relative to today. The SPA
 *  uses this to color rows green / amber / rose without doing
 *  date arithmetic itself. */
export type MaintenanceDueBucket = "due_now" | "due_soon" | "current";

export function bucketizeMaintenance(input: {
  lastCompletedAt: string | null;
  frequencyDays: number;
  asOfDate: Date;
}): {
  nextDueDate: string;
  bucket: MaintenanceDueBucket;
  daysUntilDue: number;
} {
  const { lastCompletedAt, frequencyDays, asOfDate } = input;
  let nextDue: Date;
  if (lastCompletedAt == null) {
    // Never completed → due today.
    nextDue = new Date(asOfDate);
  } else {
    const last = new Date(lastCompletedAt);
    nextDue = new Date(last.getTime() + frequencyDays * 86_400_000);
  }
  const daysUntilDue = Math.floor(
    (nextDue.getTime() - asOfDate.getTime()) / 86_400_000,
  );
  let bucket: MaintenanceDueBucket;
  if (daysUntilDue <= 0) bucket = "due_now";
  else if (daysUntilDue <= 1) bucket = "due_soon";
  else bucket = "current";
  return {
    nextDueDate: nextDue.toISOString().slice(0, 10),
    bucket,
    daysUntilDue,
  };
}
