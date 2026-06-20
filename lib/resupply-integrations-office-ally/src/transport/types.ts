// Submission transport interface.
//
// Office Ally accepts 837 files via SFTP (sftp10.officeally.com:22),
// inbound directory `inbound/`. The default production transport
// wraps the system `sftp` binary via child_process so we don't add a
// new top-level npm dep for a single-purpose call. Tests + dev use the
// file-drop transport which writes the payload to a local directory.
//
// A custom transport (e.g. ssh2-sftp-client wrapping a connection pool)
// can be plugged in by passing a custom factory to createOfficeAllyAdapter.

export type SubmissionTransportKind = "sftp" | "file" | "noop";

export interface UploadResult {
  ok: true;
  /** The opaque session / file handle the transport surfaces. Persisted for support tickets. */
  sessionId: string | null;
  /** The remote path the file landed on (server-side or local). Informational only. */
  remotePath: string;
}

export interface UploadFailure {
  ok: false;
  kind: "auth_failed" | "connect_failed" | "transfer_failed" | "unavailable";
  /** Caller-safe failure message. Never includes credentials. */
  message: string;
}

export type UploadOutcome = UploadResult | UploadFailure;

export interface UploadRequest {
  /** Caller-chosen file name. Office Ally rejects file names with spaces or non-ASCII. */
  fileName: string;
  /** UTF-8 EDI payload. */
  payload: string;
}

export interface SubmissionTransport {
  readonly kind: SubmissionTransportKind;
  upload(req: UploadRequest): Promise<UploadOutcome>;
}

// ── Real-time eligibility transport ──────────────────────────────────
//
// SubmissionTransport.upload() is fire-and-forget: it pushes an EDI file
// and never returns a response body (the 271 comes back later, async, on
// the SFTP poll). The real-time eligibility channel is request/response —
// you send a 270 and get the 271 in the SAME call — so it needs its own
// contract rather than overloading `upload`.

export interface EligibilityRequest {
  /** UTF-8 270 EDI payload (from build270). */
  payload: string;
}

export interface EligibilityRealtimeResult {
  ok: true;
  /** The raw 271 EDI payload extracted from the response envelope. */
  payload271: string;
  /** Opaque correlation id (the CORE PayloadID we sent), for support. */
  sessionId: string | null;
}

export interface EligibilityRealtimeFailure {
  ok: false;
  kind: "auth_failed" | "connect_failed" | "rejected" | "unavailable";
  /** Caller-safe failure message. Never includes credentials or PHI. */
  message: string;
}

export type EligibilityRealtimeOutcome =
  | EligibilityRealtimeResult
  | EligibilityRealtimeFailure;

export interface EligibilityRealtimeTransport {
  readonly kind: "soap" | "https" | "noop";
  requestEligibility(
    req: EligibilityRequest,
  ): Promise<EligibilityRealtimeOutcome>;
}

// ── Insurance discovery transport ────────────────────────────────────
//
// Insurance discovery answers a DIFFERENT question from eligibility
// verification. Verification asks "is THIS coverage active?" — you
// already know the payer and the member id. Discovery asks "does this
// PERSON have ANY active coverage, and with whom?" — you provide only
// demographics and Office Ally searches its payer network, returning
// every coverage it can match. It's the tool for when a patient's
// insurance is unknown, or a coverage on file came back inactive and you
// need to find what's actually in force.
//
// Like the real-time eligibility transport this is request/response over
// HTTPS, but the inputs (demographics, no payer/member) and outputs (a
// LIST of discovered coverages, each with its own payer + member id) are
// different enough that it gets its own contract rather than overloading
// requestEligibility.

export interface InsuranceDiscoveryRequest {
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD */
  dateOfBirth: string;
  /** X12 administrative sex; defaults to unknown when omitted. */
  gender?: "M" | "F" | "U";
  /** Subscriber SSN (digits only). Optional — it lifts the match rate but
   *  is sensitive PHI, so the transport never logs or persists it. */
  ssn?: string;
  /** A member-id hint, when one is on hand (e.g. a stale insurance card). */
  memberId?: string;
  /** Postal code; narrows the payer search when supplied. */
  postalCode?: string;
  /** As-of date for the coverage search (YYYY-MM-DD). Defaults to today. */
  serviceDate?: string;
}

/** One coverage the discovery service matched to the searched person. */
export interface DiscoveredCoverage {
  /** Human-readable payer name as returned by the discovery service. */
  payerName: string;
  /** Office Ally / CPID payer id, when the service returns one. */
  payerId: string | null;
  /** The member/subscriber id the payer has on file. */
  memberId: string | null;
  /** Plan / product name, when present. */
  planName: string | null;
  /** True when the matched coverage is active as of the service date. */
  isActive: boolean;
  /** Coverage start (YYYY-MM-DD), when present. */
  coverageStart: string | null;
  /** Coverage end (YYYY-MM-DD), when present. */
  coverageEnd: string | null;
}

export interface InsuranceDiscoveryResult {
  ok: true;
  /** Every coverage matched. Empty when the search ran but found nothing. */
  coverages: DiscoveredCoverage[];
  /** Opaque correlation id, for support. */
  sessionId: string | null;
}

export interface InsuranceDiscoveryFailure {
  ok: false;
  kind: "auth_failed" | "connect_failed" | "rejected" | "unavailable";
  /** Caller-safe failure message. Never includes credentials or PHI. */
  message: string;
}

export type InsuranceDiscoveryOutcome =
  | InsuranceDiscoveryResult
  | InsuranceDiscoveryFailure;

export interface InsuranceDiscoveryTransport {
  readonly kind: "https" | "noop";
  discover(req: InsuranceDiscoveryRequest): Promise<InsuranceDiscoveryOutcome>;
}
