// The "empty everything" body the demo sandbox returns for any GET it
// doesn't explicitly seed.
//
// The demo seeds the prominent endpoints with real fixtures; everything
// else (the long tail of admin pages a broadly-permissioned demo
// explorer can still navigate to) falls through to this shape. Returning
// a bare `{}` made those pages crash on `data.<field>.<arrayMethod>` and
// bubble to the global ErrorBoundary ("Something went wrong"); mapping
// every known collection name to an empty array (plus the common
// indexable objects and zeroed pagination) instead lets each page render
// the empty state the demo README promises. Harmless extra keys a page
// doesn't read are simply ignored. Keep this union broad — a missing
// name is a latent crash.
//
// It also backs the per-id detail handlers: when a `:id` route is hit
// with a path segment that isn't a real demo entity id (e.g. a static
// sub-route like `/patients/duplicates`), the handler returns this body
// instead of a wrong-shaped fixture.

const EMPTY_COLLECTION_KEYS = [
  "items",
  "results",
  "records",
  "rows",
  "products",
  "masks",
  "orders",
  "events",
  "messageEvents",
  "recallEvents",
  "auditEvents",
  "messages",
  "conversations",
  "patients",
  "customers",
  "tenants",
  "accounts",
  "providers",
  "locations",
  "agents",
  "recipients",
  "comments",
  "videos",
  "links",
  "cases",
  "closures",
  "episodes",
  "prescriptions",
  "fulfillments",
  "deliveries",
  "backorders",
  "recalls",
  "subscriptions",
  "reviews",
  "notes",
  "attachments",
  "packets",
  "interventions",
  "tasks",
  "runs",
  "rules",
  "thresholds",
  "targets",
  "requests",
  "acknowledgements",
  "signals",
  "setups",
  "signed",
  "opportunities",
  "campaigns",
  "candidates",
  "attempts",
  "addons",
  "eligible",
  "evaluated",
  "alerts",
  "points",
  "entries",
  "history",
  "activity",
  "pages",
  "sources",
  "substitutes",
  "claims",
  "insuranceClaims",
  "feeSchedules",
  "checks",
  "eraFiles",
  "groups",
  "excluded",
  "pending",
  "queued",
  "cohort",
  "horizons",
  "funnel",
  "topMasks",
  "topRecommendations",
  "statusBreakdown",
  "ordersByDay",
  "byMonth",
  "byPlan",
  "byPayer",
  "byCohort",
  "bySource",
] as const;

// Object-shaped fields that pages index into (e.g. `data.counts[k]`,
// `data.stats.totalCents`) — an empty object yields `undefined` (which
// tolerant formatters handle) instead of throwing on a missing parent.
const EMPTY_OBJECT_KEYS = ["counts", "stats", "summary", "totals"] as const;

/**
 * The body returned for any unmatched (or non-owned-id) demo GET: empty
 * collections, empty indexable objects, and zeroed pagination scalars.
 * One shape that satisfies the overwhelmingly common list-page contract
 * so unseeded demo endpoints render empty states, not crashes.
 */
export function emptyGetFallbackBody(): Record<string, unknown> {
  const body: Record<string, unknown> = {
    total: 0,
    count: 0,
    page: 1,
    pageSize: 25,
    limit: 25,
    offset: 0,
  };
  for (const key of EMPTY_COLLECTION_KEYS) body[key] = [];
  for (const key of EMPTY_OBJECT_KEYS) body[key] = {};
  return body;
}
