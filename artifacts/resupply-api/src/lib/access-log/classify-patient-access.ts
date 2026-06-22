// classify-patient-access — map an admin HTTP request (method + path)
// to a patient-data access descriptor, or null when the request does
// not touch patient information.
//
// This is the allowlist that defines what the Audit Trail records. The
// chosen scope is "patient-data access only" (set with the product
// owner): only requests against the PHI surfaces below are logged —
// both reads (views) and writes (changes) — and everything else (admin
// dashboards, settings, billing config, the audit report itself) is
// ignored.
//
// It is intentionally a curated allowlist rather than "log everything":
// it keeps the log signal high (every row is a real patient-data touch)
// and PHI-safe (we record stable ids + the path, never names / DOB /
// clinical free-text, and never the query string). Extend PATIENT_DATA_
// ROUTES below when a new patient-facing admin surface is added.

export interface PatientAccessDescriptor {
  /** `${table}.${verb}` — e.g. "patients.view", "customers.update". */
  action: string;
  /** The kind of record touched — e.g. "patients", "conversations". */
  targetTable: string;
  /** The specific record id from the path, when present. */
  targetId: string | null;
  /** The patient/customer id, when the resource IS a person record. */
  patientId: string | null;
}

interface RouteRule {
  /** Path prefix (after stripping the /resupply-api or /api mount). */
  prefix: string;
  /** Logical table name recorded against the access. */
  table: string;
  /**
   * True when the prefix's `:id` segment is itself a patient/customer
   * identifier (so it populates `patient_id`). False for resources that
   * merely relate to a patient (a conversation, order, case): their id
   * is recorded as `target_id` only.
   */
  person?: boolean;
}

// Ordered most-specific first. The matcher requires an exact match or a
// `prefix + "/"` boundary. Every prefix below is verified against the
// actual route registrations in artifacts/resupply-api/src/routes (NOT
// guessed from file names — several earlier guesses drifted from the
// real mounts). When adding a patient-facing admin surface, grep its
// router for the real path literal and add the prefix here.
const PATIENT_DATA_ROUTES: readonly RouteRule[] = [
  // Resupply patients (the canonical PHI record): /patients/:id and all
  // sub-resources (documents, prescriptions, claims, timeline, notes…).
  { prefix: "/patients", table: "patients", person: true },
  // Admin per-patient surfaces mounted under /admin/patients/:id —
  // onboarding, per-patient clinical encounters, per-patient CMN docs.
  { prefix: "/admin/patients", table: "patients", person: true },
  // Storefront customers (the cash-pay / shop-side patient record),
  // including their notes / timeline / followups / reorder sub-paths
  // (all mounted under /admin/shop/customers/:userId/…).
  { prefix: "/admin/shop/customers", table: "customers", person: true },
  // Standalone prescription record.
  { prefix: "/prescriptions", table: "prescriptions" },
  // Patient conversations + message threads.
  { prefix: "/conversations", table: "conversations" },
  { prefix: "/admin/conversations-search", table: "conversations" },
  // Clinical / care surfaces.
  { prefix: "/admin/clinical", table: "clinical_outreach" }, // /admin/clinical/outreach/*
  { prefix: "/admin/coaching-plans", table: "coaching_plans" },
  { prefix: "/admin/cmn-documents", table: "cmn_documents" },
  { prefix: "/admin/cases", table: "cases" },
  // Resupply episodes + orders tied to a patient.
  { prefix: "/episodes", table: "episodes" },
  { prefix: "/admin/shop/orders", table: "orders" },
  { prefix: "/admin/orders", table: "orders" },
] as const;

// Segments that follow a resource prefix but are NOT record ids — verbs
// and sub-collections that appear as the FIRST segment after a prefix.
// Keeps e.g. "/patients/merge" or "/admin/patients/clinical-encounters/
// query" from recording a patient id of "merge" / "clinical-encounters".
const NON_ID_SEGMENTS = new Set<string>([
  "export",
  "export.csv",
  "search",
  "bulk",
  "bulk-status",
  "bulk-send",
  "count",
  "counts",
  "summary",
  "recent",
  "list",
  "stats",
  "new",
  "create",
  "csv",
  "import",
  "import-csv",
  "open",
  "all",
  "merge",
  "duplicates",
  "query",
  "clinical-encounters",
  "eligible",
  "run",
  "send-due",
]);

function verbForMethod(method: string): string {
  switch (method.toUpperCase()) {
    case "GET":
    case "HEAD":
      return "view";
    case "POST":
      return "create";
    case "PUT":
    case "PATCH":
      return "update";
    case "DELETE":
      return "delete";
    default:
      return "access";
  }
}

/** Strip a leading API mount prefix so rules match either mount point. */
function normalizePath(rawPath: string): string {
  let p = rawPath.split("?")[0] ?? "";
  if (p.startsWith("/resupply-api")) p = p.slice("/resupply-api".length);
  else if (p.startsWith("/api")) p = p.slice("/api".length);
  if (p.length === 0) p = "/";
  // Drop a trailing slash (except root) so "/patients/" === "/patients".
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

function matchRule(path: string): RouteRule | null {
  for (const rule of PATIENT_DATA_ROUTES) {
    if (path === rule.prefix || path.startsWith(rule.prefix + "/")) {
      return rule;
    }
  }
  return null;
}

/** The first path segment after the matched prefix, if it looks like an
 *  id (not a known verb / sub-collection). */
function extractId(path: string, prefix: string): string | null {
  const rest = path.slice(prefix.length).replace(/^\//, "");
  if (rest.length === 0) return null;
  const first = rest.split("/")[0] ?? "";
  if (first.length === 0) return null;
  if (NON_ID_SEGMENTS.has(first.toLowerCase())) return null;
  let decoded = first;
  try {
    decoded = decodeURIComponent(first);
  } catch {
    // malformed escape — keep the raw segment
  }
  // Guard against unbounded junk in the log.
  return decoded.slice(0, 128);
}

/**
 * Classify a request. Returns a descriptor when the path is a
 * patient-data surface, otherwise null (the caller records nothing).
 */
export function classifyPatientAccess(
  method: string,
  rawPath: string,
): PatientAccessDescriptor | null {
  const path = normalizePath(rawPath);
  const rule = matchRule(path);
  if (!rule) return null;

  const id = extractId(path, rule.prefix);
  const verb = verbForMethod(method);
  return {
    action: `${rule.table}.${verb}`,
    targetTable: rule.table,
    targetId: id,
    patientId: rule.person ? id : null,
  };
}
