// The lifecycle health signal catalog — what we watch, what "bad" means,
// and what a person does about it.
//
// WHY A CATALOG AND NOT TWENTY-SEVEN JOBS
// ---------------------------------------
// The platform already has single-purpose watchers: a DLQ digest, a
// delivery-failure spike monitor, a KPI threshold evaluator over
// metrics_daily. Each one earns its keep and none of them can answer
// "is the resupply lifecycle healthy?", because the lifecycle's failure
// modes are spread across intake, outreach, fulfilment, billing,
// integrations and tenancy — and the ones that cost the most money are
// precisely the quiet ones that no single subsystem owns. Shipped and
// never billed is nobody's error log.
//
// So the signals are DATA, evaluated by one pure function and collected
// by one pass. Adding a signal is a catalog entry plus a collector, not
// a new cron, a new email template and a new set of thresholds nobody
// can find.
//
// EVERY SIGNAL IS PHRASED SO THAT MORE IS WORSE
// ---------------------------------------------
// There is no `direction` field, deliberately. A comparator that can
// point either way doubles the number of ways a threshold can be typed
// in backwards, and a backwards threshold is a monitor that stays silent
// through the exact event it was added for. Where the natural phrasing
// is "not enough", the signal measures the ABSENCE instead — hours since
// the last cycle was created rather than cycles per hour.
//
// THRESHOLDS ARE CONFIGURABLE, AND THE DEFAULTS ARE ARGUABLE
// ----------------------------------------------------------
// Every signal reads `LIFECYCLE_HEALTH_<KEY>_WARN` / `_FAIL` from the
// environment and falls back to the default here. The defaults are sized
// for a mid-size DME and are meant to be tuned, not obeyed; a number
// nobody can change is a number everyone learns to ignore.
//
// PHI
// ---
// Nothing in this file, and nothing any collector may return, identifies
// a patient. Signals are counts, ages and ratios over populations. That
// is also why there is no per-patient alert anywhere in this subsystem:
// one alert per patient is how a monitor becomes a filter rule.

/** Where the signal lives, for grouping on the panel. */
export type SignalCategory =
  | "intake"
  | "outreach"
  | "fulfillment"
  | "billing"
  | "integrations"
  | "tenancy"
  | "platform";

/**
 * What the value means, so the UI can format it and a threshold can be
 * read without guessing at units.
 */
export type SignalUnit = "count" | "hours" | "days" | "ratio" | "multiple";

/**
 * How much it matters when this fails.
 *
 * `critical` carries an obligation: every critical signal has a named
 * response procedure in docs/runbooks/lifecycle-health-alerts.md, and a
 * spec asserts the two lists match. An alert nobody knows how to answer
 * is worse than no alert, because it consumes attention and returns
 * nothing.
 */
export type SignalSeverity = "critical" | "major" | "minor";

/**
 * Tenant or platform.
 *
 * Two signals are about rows that belong to NO tenant. Rendering a
 * global number inside every tenant's panel would have each operator
 * chasing another practice's problem, so they are scoped explicitly and
 * evaluated once per scan rather than once per org.
 */
export type SignalScope = "tenant" | "platform";

export interface LifecycleSignal {
  key: string;
  label: string;
  category: SignalCategory;
  scope: SignalScope;
  unit: SignalUnit;
  severity: SignalSeverity;
  /** Environment variable that overrides `defaultWarn`. */
  warnEnv: string;
  /** Environment variable that overrides `defaultFail`. */
  failEnv: string;
  defaultWarn: number;
  defaultFail: number;
  /**
   * Ratio signals only: the smallest denominator at which a breach means
   * anything. A 50% denial rate over two claims is one denial.
   *
   * Below it the signal reports `ok` and says WHY it withheld, rather
   * than reporting a breach nobody should act on or silently reporting
   * nothing.
   */
  minSample?: number;
  /**
   * What the number means and why anyone should care. Shown verbatim on
   * the panel and in the alert body — a threshold with no explanation
   * gets tuned until it stops firing.
   */
  why: string;
  /** Where in the admin console the operator goes to act on it. */
  remedyHref: string;
  /**
   * Anchor in docs/runbooks/lifecycle-health-alerts.md. Required for
   * every signal, not only the critical ones, because the person on the
   * receiving end of a `major` at 2am is the same person.
   */
  runbookAnchor: string;
}

/** `LIFECYCLE_HEALTH_SHIPPED_UNBILLED_WARN`, and so on. */
function envName(key: string, bound: "WARN" | "FAIL"): string {
  return `LIFECYCLE_HEALTH_${key.toUpperCase()}_${bound}`;
}

type SignalSeed = Omit<LifecycleSignal, "warnEnv" | "failEnv">;

function signal(seed: SignalSeed): LifecycleSignal {
  return {
    ...seed,
    warnEnv: envName(seed.key, "WARN"),
    failEnv: envName(seed.key, "FAIL"),
  };
}

export const LIFECYCLE_SIGNALS: readonly LifecycleSignal[] = [
  // ── Intake: are cycles being created, and only the right ones? ──────
  signal({
    key: "cycle_creation_spike",
    label: "Cycle-creation spike",
    category: "intake",
    scope: "tenant",
    unit: "multiple",
    severity: "major",
    defaultWarn: 3,
    defaultFail: 6,
    // Fourteen days of history, so a tenant whose ladder produces a
    // couple of cycles a week is not declared to be spiking on a Tuesday.
    minSample: 14,
    why: "Cycles created in the last 24 hours, as a multiple of the trailing 14-day daily average. A spike is almost never demand: it is a sweep re-running over a population it already contacted, a cadence edited by mistake, or a bulk import — and each of those texts patients who are not due.",
    remedyHref: "/admin/episodes",
    runbookAnchor: "#cycle-creation-spike",
  }),
  signal({
    key: "cycle_creation_stalled",
    label: "No cycles created",
    category: "intake",
    scope: "tenant",
    unit: "hours",
    severity: "critical",
    defaultWarn: 48,
    defaultFail: 96,
    why: "Hours since the most recent resupply cycle was created, for a tenant that HAS active prescriptions. A stalled sweep is silent by nature — nothing errors, patients simply stop being contacted — and the business effect (a month of missed reorders) arrives long after the cause.",
    remedyHref: "/admin/episodes",
    runbookAnchor: "#no-cycles-created",
  }),
  signal({
    key: "episodes_open_past_age",
    label: "Open cycles past their expiry",
    category: "intake",
    scope: "tenant",
    unit: "count",
    severity: "major",
    defaultWarn: 25,
    defaultFail: 100,
    why: "Open cycles whose expires_at has already passed. The expiry sweep should close these daily and open the next cycle; a growing number means the sweep is not running, and every one of these patients is stuck out of resupply rather than being asked again.",
    remedyHref: "/admin/episodes?status=awaiting_response",
    runbookAnchor: "#open-cycles-past-their-expiry",
  }),

  // ── Outreach: did we reach them, and what did they say? ─────────────
  signal({
    key: "never_contacted_growth",
    label: "Cycles closed never-contacted",
    category: "outreach",
    scope: "tenant",
    unit: "count",
    severity: "critical",
    defaultWarn: 5,
    defaultFail: 25,
    why: "Cycles closed in the last 7 days having never reached the patient at all — no phone, no email, permanent quiet hours, or a messaging outage. This is not a patient decision and must never be read as one: it is a broken pipeline, and the patients in it went without supplies while the system recorded a normal-looking close.",
    remedyHref: "/admin/analytics/order-outcomes",
    runbookAnchor: "#cycles-closed-never-contacted",
  }),
  signal({
    key: "no_response_growth",
    label: "Cycles closed with no response",
    category: "outreach",
    scope: "tenant",
    unit: "count",
    severity: "major",
    defaultWarn: 25,
    defaultFail: 100,
    why: "Cycles closed in the last 7 days after the patient was reached and never answered. Distinct from never-contacted — this one is a messaging-effectiveness problem (wrong channel, wrong hours, message going to spam), not an outage.",
    remedyHref: "/admin/analytics/order-outcomes",
    runbookAnchor: "#cycles-closed-with-no-response",
  }),
  signal({
    key: "address_hold_aging",
    label: "Address holds past SLA",
    category: "outreach",
    scope: "tenant",
    unit: "count",
    severity: "major",
    defaultWarn: 5,
    defaultFail: 20,
    why: "Cycles sitting on an address hold for more than 24 hours. The patient has already said yes; the shipment is blocked on someone confirming where it goes. Every hour here is a day added to a reorder the patient believes is on its way.",
    remedyHref: "/admin/episodes?status=address_hold",
    runbookAnchor: "#address-holds-past-sla",
  }),

  // ── Fulfillment: did it ship, and do we know that it shipped? ───────
  signal({
    key: "assumed_shipped_growth",
    label: "Cycles advanced without shipment evidence",
    category: "fulfillment",
    scope: "tenant",
    unit: "count",
    severity: "critical",
    defaultWarn: 5,
    defaultFail: 25,
    why: "Cycles the grace sweep advanced in the last 7 days with NO shipment evidence. These are neither shipped nor lost: the sweep deliberately never invents a ship date, so nobody knows whether anything left the warehouse. This bucket is exactly the population the platform cannot account for, and its size is the argument for connecting a shipment feed.",
    remedyHref: "/admin/pacware",
    runbookAnchor: "#cycles-advanced-without-shipment-evidence",
  }),
  signal({
    key: "shipment_evidence_lag",
    label: "Shipment-evidence lag",
    category: "fulfillment",
    scope: "tenant",
    unit: "hours",
    severity: "major",
    defaultWarn: 120,
    defaultFail: 336,
    why: "Average hours from a fulfillment being queued to its shipment being confirmed, over the last 14 days. Past the grace window (336h / 14 days by default) the cycle advances as assumed-shipped instead, so a lag approaching it means evidence is arriving too late to be used.",
    remedyHref: "/admin/pacware",
    runbookAnchor: "#shipment-evidence-lag",
  }),
  signal({
    key: "fulfilled_not_shipped",
    label: "Queued and never shipped",
    category: "fulfillment",
    scope: "tenant",
    unit: "count",
    severity: "critical",
    defaultWarn: 10,
    defaultFail: 50,
    why: "Fulfillments queued more than 7 days ago with no shipment recorded. Either the warehouse has a backlog nobody is watching, or shipments are happening and the confirmation feed is not reaching us. Both are expensive, and they look identical from here — which is why the number matters more than its cause.",
    remedyHref: "/admin/fulfillments",
    runbookAnchor: "#queued-and-never-shipped",
  }),
  signal({
    key: "pacware_unmatched_rows",
    label: "PacWare rows that matched nothing",
    category: "fulfillment",
    scope: "tenant",
    unit: "count",
    severity: "major",
    defaultWarn: 5,
    defaultFail: 25,
    why: "Rows in the most recent shipment-confirmation import that matched no fulfillment. Each one is a shipment the warehouse believes it sent and this system has no record of, so the cycle stays open and the claim never starts.",
    remedyHref: "/admin/pacware",
    runbookAnchor: "#pacware-rows-that-matched-nothing",
  }),
  signal({
    key: "pacware_ambiguous_rows",
    label: "PacWare rows that matched more than one order",
    category: "fulfillment",
    scope: "tenant",
    unit: "count",
    severity: "critical",
    defaultWarn: 1,
    defaultFail: 10,
    why: "Rows in the most recent import that matched several candidate fulfillments. The importer refuses to guess — a wrong match writes a wrong date of service onto a claim — so these are held for a person. They stay held until someone resolves them, which is why the warning threshold is one.",
    remedyHref: "/admin/pacware",
    runbookAnchor: "#pacware-ambiguous-rows",
  }),
  signal({
    key: "pacware_invalid_dates",
    label: "PacWare rows with unusable dates",
    category: "fulfillment",
    scope: "tenant",
    unit: "count",
    severity: "major",
    defaultWarn: 5,
    defaultFail: 25,
    why: "Rows rejected for an unparseable, future-dated, or implausibly old ship date. A future-dated ship is usually a spreadsheet re-formatting a column; an implausibly old one is usually a re-export of last year's file. Neither may become a date of service.",
    remedyHref: "/admin/pacware",
    runbookAnchor: "#pacware-rows-with-unusable-dates",
  }),

  // ── Billing: did it turn into money? ────────────────────────────────
  signal({
    key: "shipped_unbilled",
    label: "Shipped and never billed",
    category: "billing",
    scope: "tenant",
    unit: "count",
    severity: "critical",
    defaultWarn: 10,
    defaultFail: 50,
    why: "Product shipped between 7 and 45 days ago with no claim of any kind against it. Usually the single largest recoverable number on this panel and the one nothing else surfaces: it does not appear in denials, it does not appear in rejections, and the cycle looks successfully completed.",
    remedyHref: "/admin/claims",
    runbookAnchor: "#shipped-and-never-billed",
  }),
  signal({
    key: "claims_stuck_submitting",
    label: "Claims stuck submitting",
    category: "billing",
    scope: "tenant",
    unit: "count",
    severity: "critical",
    defaultWarn: 1,
    defaultFail: 10,
    why: "Claims left in `submitting` for more than 2 hours. That status means a batch upload started and never reported back, so the claim is in an unknown state with the clearinghouse — it may be filed, may be lost, and must not be blindly resubmitted into a duplicate.",
    remedyHref: "/admin/claims?status=submitting",
    runbookAnchor: "#claims-stuck-submitting",
  }),
  signal({
    key: "claims_missing_ship_evidence",
    label: "Claims without shipment evidence",
    category: "billing",
    scope: "tenant",
    unit: "count",
    severity: "critical",
    defaultWarn: 1,
    defaultFail: 5,
    why: "Claims raised in the last 30 days against a fulfillment with no recorded shipment, while this tenant requires shipment evidence to bill. A claim whose date of service is not anchored to an actual shipment is a compliance problem, not a data-quality one. Reported as `disabled` for tenants that have not enabled the requirement.",
    remedyHref: "/admin/claims",
    runbookAnchor: "#claims-without-shipment-evidence",
  }),
  signal({
    key: "clearinghouse_rejection_rate",
    label: "Clearinghouse rejection rate",
    category: "billing",
    scope: "tenant",
    unit: "ratio",
    severity: "major",
    defaultWarn: 0.1,
    defaultFail: 0.25,
    minSample: 20,
    why: "Share of claims in the last 30 days rejected by the clearinghouse (277CA). A rejection is a STRUCTURAL refusal — a malformed or incomplete claim that never reached the payer — so it is fixable and resubmittable, and it must never be counted as a payer denial. A rising rate usually means one payer's requirements changed.",
    remedyHref: "/admin/claims?status=rejected",
    runbookAnchor: "#clearinghouse-rejection-rate",
  }),
  signal({
    key: "payer_denial_rate",
    label: "Payer denial rate",
    category: "billing",
    scope: "tenant",
    unit: "ratio",
    severity: "major",
    defaultWarn: 0.15,
    defaultFail: 0.3,
    minSample: 20,
    why: "Share of adjudicated claims in the last 30 days the payer denied. Unlike a rejection this one reached the payer and lost on its merits — coverage, medical necessity, timely filing — so the fix is upstream in eligibility and documentation, not in the claim file.",
    remedyHref: "/admin/analytics/order-outcomes",
    runbookAnchor: "#payer-denial-rate",
  }),

  // ── Integrations: is the device data real and current? ──────────────
  signal({
    key: "connector_failures",
    label: "Manufacturer connector failures",
    category: "integrations",
    scope: "tenant",
    unit: "count",
    severity: "major",
    defaultWarn: 3,
    defaultFail: 10,
    why: "The highest consecutive-failure count across this tenant's configured therapy connectors. Reported as `not configured` — never as zero — when no connector is set up, because a tenant with no connector has no failures and no data either, and those must not render the same.",
    remedyHref: "/admin/integrations",
    runbookAnchor: "#manufacturer-connector-failures",
  }),
  signal({
    key: "connector_partial_responses",
    label: "Connectors returning partial data",
    category: "integrations",
    scope: "tenant",
    unit: "count",
    severity: "major",
    defaultWarn: 1,
    defaultFail: 3,
    why: "Connectors whose last sync returned some resources and failed on others — usage came back, compliance did not. A partial response looks like a successful sync from the outside, and the missing half quietly becomes a gap in every downstream adherence number.",
    remedyHref: "/admin/integrations",
    runbookAnchor: "#connectors-returning-partial-data",
  }),
  signal({
    key: "portal_reconciliation_discrepancies",
    label: "Portal reconciliation discrepancies",
    category: "integrations",
    scope: "tenant",
    unit: "count",
    severity: "major",
    defaultWarn: 10,
    defaultFail: 50,
    why: "Patients present in the manufacturer's own portal export and missing here, present here and missing there, or carrying different figures — from the most recent reconciliation run. Reported as `not configured` when no reconciliation has ever been run: never having checked is not the same as having checked and found nothing.",
    remedyHref: "/admin/integrations",
    runbookAnchor: "#portal-reconciliation-discrepancies",
  }),
  signal({
    key: "therapy_data_staleness",
    label: "Therapy data staleness",
    category: "integrations",
    scope: "tenant",
    unit: "hours",
    severity: "major",
    defaultWarn: 36,
    defaultFail: 96,
    why: "Hours since the most recent successful therapy sync of any connector. Stale device data does not error — the adherence screens keep rendering yesterday's numbers as though they were today's, and compliance decisions get made on them.",
    remedyHref: "/admin/integrations",
    runbookAnchor: "#therapy-data-staleness",
  }),

  // ── Tenancy: is anything landing in the wrong practice, or none? ────
  signal({
    key: "voice_calls_unattributed",
    label: "Voice calls with no tenant",
    category: "tenancy",
    scope: "platform",
    unit: "count",
    severity: "critical",
    defaultWarn: 1,
    defaultFail: 10,
    why: "Voice call records written with no org_id in the last 7 days. Such a call belongs to no practice: it is invisible in every tenant's metrics and its conversation cannot be worked by anyone. One is worth investigating, because the cause is usually a DID that was pointed at the platform before it was registered to a tenant.",
    remedyHref: "/admin/phone-settings",
    runbookAnchor: "#voice-calls-with-no-tenant",
  }),
  signal({
    key: "inbound_attribution_failures",
    label: "Inbound events that failed tenant attribution",
    category: "tenancy",
    scope: "platform",
    unit: "count",
    severity: "critical",
    defaultWarn: 5,
    defaultFail: 25,
    why: "Inbound texts and calls in the last 7 days that were dropped because no tenant could be resolved. Dropping is correct — filing a stranger's message under the nearest-looking practice is the tenant-isolation bug this platform refuses to have — but a rising count means a real patient is being ignored by a real practice's published number.",
    remedyHref: "/admin/phone-settings",
    runbookAnchor: "#inbound-events-that-failed-tenant-attribution",
  }),
  signal({
    key: "flags_without_readiness_evidence",
    label: "Lifecycle flags enabled without readiness evidence",
    category: "tenancy",
    scope: "tenant",
    unit: "count",
    severity: "critical",
    defaultWarn: 1,
    defaultFail: 2,
    why: "Resupply lifecycle flags that are ON for this tenant with no current readiness assessment behind them — never assessed, or assessed longer ago than the validity window. The flags change how cycles close and how claims are dated; enabling one on unexamined data is how a tenant's whole ladder shifts without anyone deciding it should.",
    remedyHref: "/admin/feature-flags",
    runbookAnchor: "#lifecycle-flags-enabled-without-readiness-evidence",
  }),

  // ── Platform: is the machinery under all of it running? ─────────────
  signal({
    key: "approval_queues_past_sla",
    label: "Human-approval queues past SLA",
    category: "platform",
    scope: "tenant",
    unit: "count",
    severity: "major",
    defaultWarn: 1,
    defaultFail: 3,
    why: "Approval queues whose oldest waiting item is past that queue's own expectation. These are the steps that deliberately do not move without a person; the design assumes a person turns up, and this is the only thing that checks whether one did.",
    remedyHref: "/admin",
    runbookAnchor: "#human-approval-queues-past-sla",
  }),
  signal({
    key: "worker_failures",
    label: "Dead-lettered worker jobs",
    category: "platform",
    scope: "tenant",
    unit: "count",
    severity: "critical",
    defaultWarn: 1,
    defaultFail: 10,
    why: "Jobs that exhausted their retries and landed in a dead-letter queue. Nearly every signal above depends on a worker: the sweeps that close cycles, the sends that contact patients, the batches that file claims. A dead-lettered job is a silent halt to one of them.",
    remedyHref: "/admin/operations",
    runbookAnchor: "#dead-lettered-worker-jobs",
  }),
  signal({
    key: "analytics_window_truncated",
    label: "Truncated analytics windows",
    category: "platform",
    scope: "tenant",
    unit: "count",
    severity: "major",
    defaultWarn: 1,
    defaultFail: 3,
    why: "Collectors in this scan that hit their row cap. Every capped read makes the number it produced a FLOOR rather than a total, so the panel above is understating something. Silently truncating is how a growing tenant's backlog stops growing on the dashboard while it keeps growing in the warehouse.",
    remedyHref: "/admin/operations",
    runbookAnchor: "#truncated-analytics-windows",
  }),
] as const;

const BY_KEY = new Map(LIFECYCLE_SIGNALS.map((s) => [s.key, s]));

export function findSignal(key: string): LifecycleSignal | undefined {
  return BY_KEY.get(key);
}

/** Signals evaluated once per scan rather than once per tenant. */
export const PLATFORM_SIGNALS: readonly LifecycleSignal[] =
  LIFECYCLE_SIGNALS.filter((s) => s.scope === "platform");

/** Signals evaluated once per tenant. */
export const TENANT_SIGNALS: readonly LifecycleSignal[] =
  LIFECYCLE_SIGNALS.filter((s) => s.scope === "tenant");

/**
 * Signals that can only be measured from inside the worker.
 *
 * Dead-letter depth is a pg-boss API call and there is no boss handle in
 * an HTTP request, so the admin route reads the last scan's observation
 * for these instead of computing one — and says how old it is, rather
 * than presenting a twelve-hour-old number as current.
 */
export const WORKER_ONLY_SIGNAL_KEYS: readonly string[] = ["worker_failures"];

export function isWorkerOnly(key: string): boolean {
  return WORKER_ONLY_SIGNAL_KEYS.includes(key);
}
