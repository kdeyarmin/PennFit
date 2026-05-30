// Typed fetch wrappers for the Office Ally admin surfaces:
//   - /admin/office-ally-submissions/*      — 837P file lineage + resubmit
//   - /admin/clearinghouse-credentials/*    — SFTP config + test
//   - /admin/clearinghouse-inbound-files    — 999 / 277CA / 835 / 271 viewer
//   - /admin/office-ally/poll-now           — manual inbound trigger
//
// Keeps the single "Office Ally Operations" page lightweight: every
// call here returns a typed shape, errors propagate as Error, and
// nothing on this path holds PHI in memory longer than the render
// cycle.

import { csrfHeader } from "../csrf";

const BASE = "/resupply-api";

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
  return (await res.json()) as T;
}

async function postJSON<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...csrfHeader(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      // Body not JSON or unreadable — fall through.
    }
    throw new Error(
      `POST ${path} failed (${res.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return (await res.json()) as T;
}

// ─── Submissions ──────────────────────────────────────────────────

export type OaSubmissionStatus =
  | "queued"
  | "uploaded"
  | "accepted_999"
  | "rejected_999"
  | "accepted_277ca"
  | "rejected_277ca"
  | "transport_failed";

export interface OaSubmission {
  id: string;
  fileName: string;
  isaControlNumber: string;
  gsControlNumber: string;
  status: OaSubmissionStatus;
  fileSizeBytes: number;
  claimCount: number;
  officeAllySessionId: string | null;
  ack999FileName: string | null;
  ack999ReceivedAt: string | null;
  ack277caFileName: string | null;
  ack277caReceivedAt: string | null;
  rejectionReason: string | null;
  submittedByEmail: string;
  submittedAt: string;
  updatedAt: string;
  attemptedClaimIds: string[];
  parentSubmissionId: string | null;
}

export function fetchOaSubmissions(filters?: {
  status?: OaSubmissionStatus;
  q?: string;
}): Promise<{ submissions: OaSubmission[] }> {
  const qs = new URLSearchParams();
  if (filters?.status) qs.set("status", filters.status);
  if (filters?.q) qs.set("q", filters.q);
  const tail = qs.toString();
  return getJSON(`/admin/office-ally-submissions${tail ? `?${tail}` : ""}`);
}

// ─── Operations summary + health (KPI tiles + outage banner) ─────

export interface OaOperationsSummary {
  window: { sinceIso: string; days: number };
  counts: {
    totalSubmissions: number;
    totalClaims: number;
    accepted: number;
    rejected: number;
    transportFailed: number;
    pendingAck: number;
  };
  rates: {
    acceptanceRatePct: number | null;
    avgMinutesToAck999: number | null;
  };
}

export function fetchOaOperationsSummary(): Promise<OaOperationsSummary> {
  return getJSON("/admin/office-ally/operations-summary");
}

export type OaPollStatus = "fresh" | "stale" | "outage" | "never";

export interface OaHealth {
  hasActiveClearinghouse: boolean;
  activeClearinghouseSlug: string | null;
  activeClearinghouseName: string | null;
  lastPolledAt: string | null;
  minutesSinceLastPoll: number | null;
  pollStatus: OaPollStatus;
  recentTransportFailures: number;
}

export function fetchOaHealth(): Promise<OaHealth> {
  return getJSON("/admin/office-ally/health");
}

export interface OaPayerStatsEntry {
  payerProfileId: string;
  displayName: string;
  slug: string | null;
  lineOfBusiness: string | null;
  submissionCount: number;
  claimCount: number;
  acceptedCount: number;
  rejectedCount: number;
  transportFailedCount: number;
  pendingCount: number;
  acceptanceRatePct: number | null;
}

export interface OaPayerStatsResponse {
  window: { sinceIso: string; days: number };
  payers: OaPayerStatsEntry[];
}

export function fetchOaPayerStats(): Promise<OaPayerStatsResponse> {
  return getJSON("/admin/office-ally/payer-stats");
}

export interface OaSubmissionLinkedClaim {
  id: string;
  patientId: string;
  patientName: string | null;
  payerName: string;
  claimNumber: string | null;
  dateOfService: string;
  status: string;
  totalBilledCents: number;
  /** Per-claim 277CA outcome + reason. Null when no 277CA has been
   *  received for this claim yet. */
  ack277ca: {
    outcome: "accepted" | "rejected" | "note";
    reason: string;
    receivedAt: string;
  } | null;
}

export interface OaSubmissionLineage {
  parent: OaSubmission | null;
  children: OaSubmission[];
}

export function fetchOaSubmissionDetail(id: string): Promise<{
  submission: OaSubmission;
  claims: OaSubmissionLinkedClaim[];
  lineage: OaSubmissionLineage;
}> {
  return getJSON(`/admin/office-ally-submissions/${encodeURIComponent(id)}`);
}

// ─── EDI enrollment watchlist (OA Operations banner) ─────────────

export interface EnrollmentWatchlistEntry {
  id: string;
  slug: string;
  displayName: string;
  lineOfBusiness: string;
  ediEnrollmentStatus: "pending" | "not_enrolled";
  officeAllyPayerId: string | null;
  requirementsLastVerifiedAt: string | null;
}

export function fetchEnrollmentWatchlist(): Promise<{
  payers: EnrollmentWatchlistEntry[];
}> {
  return getJSON("/admin/office-ally/enrollment-watchlist");
}

export function resubmitOaSubmission(id: string): Promise<{
  ok: boolean;
  submissionId: string;
  parentSubmissionId: string;
  claimCount: number;
  isaControlNumber: string;
  gsControlNumber: string;
  transport: string;
  uploadError: string | null;
}> {
  return postJSON(
    `/admin/office-ally-submissions/${encodeURIComponent(id)}/resubmit`,
  );
}

export type BulkResubmitOutcome =
  | {
      submissionId: string;
      ok: true;
      newSubmissionId: string;
      claimCount: number;
      isaControlNumber: string;
      transport: string;
      uploadOk: boolean;
      uploadError: string | null;
    }
  | {
      submissionId: string;
      ok: false;
      error: string;
      message?: string;
    };

export interface BulkResubmitResponse {
  total: number;
  okCount: number;
  failedCount: number;
  outcomes: BulkResubmitOutcome[];
}

export function bulkResubmitOaSubmissions(
  submissionIds: string[],
): Promise<BulkResubmitResponse> {
  return postJSON("/admin/office-ally/bulk-resubmit", { submissionIds });
}

// Plain <a href> works — cookie auth, no preflight. Browser saves
// the file directly without us juggling Blob URLs.
export function rawEdiDownloadHref(submissionId: string): string {
  return `${BASE}/admin/office-ally-submissions/${encodeURIComponent(submissionId)}/raw-837p`;
}

// CSV export of the submissions list. Honours the same status + q
// filters as the JSON list so an op can export "exactly what I'm
// looking at". `days` controls the trailing window (default 90).
export function submissionsCsvHref(opts?: {
  status?: OaSubmissionStatus;
  q?: string;
  days?: number;
}): string {
  const qs = new URLSearchParams();
  if (opts?.status) qs.set("status", opts.status);
  if (opts?.q) qs.set("q", opts.q);
  if (opts?.days != null) qs.set("days", String(opts.days));
  const tail = qs.toString();
  return `${BASE}/admin/office-ally-submissions/export.csv${tail ? `?${tail}` : ""}`;
}

// ─── Clearinghouse credentials + connection self-test ────────────

export interface ClearinghouseRow {
  id: string;
  slug: string;
  displayName: string;
  usageIndicator: "P" | "T";
  sftpHost: string;
  sftpPort: number;
  sftpUsername: string;
  privateKeyPath: string;
  knownHostsPath: string;
  remoteInboxDir: string;
  remoteOutboundDir: string;
  remoteArchiveDir: string | null;
  etin: string;
  submitterOrganizationName: string | null;
  contactName: string | null;
  contactPhoneE164: string | null;
  isActive: boolean;
  lastPolledAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export function fetchClearinghouses(): Promise<{
  clearinghouses: ClearinghouseRow[];
}> {
  return getJSON("/admin/clearinghouse-credentials");
}

export type ConnectionTestResult =
  | { ok: true; fileCount: number }
  | { ok: false; kind: string; message: string };

export async function testClearinghouseConnection(
  id: string,
): Promise<ConnectionTestResult> {
  const res = await fetch(
    `${BASE}/admin/clearinghouse-credentials/${encodeURIComponent(id)}/test`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", ...csrfHeader() },
    },
  );
  // Both 200 and 502 carry a typed JSON body; surface either as a
  // structured result so the UI can render a green/red badge without
  // throwing.
  const body = (await res.json().catch(() => ({}))) as ConnectionTestResult;
  return body;
}

export function pollNow(): Promise<{
  ok: true;
  stats: {
    listed?: number;
    downloaded?: number;
    parsed?: number;
    dispatched?: number;
  };
}> {
  return postJSON("/admin/office-ally/poll-now");
}

// ─── Inbound files (999 / 277CA / 835 / 271) ─────────────────────

export type InboundFileKind = "999" | "277ca" | "835" | "271" | "unknown";
export type InboundDispatchStatus =
  | "pending"
  | "parsed"
  | "dispatched"
  | "dispatch_failed"
  | "skipped";

export interface InboundFile {
  id: string;
  clearinghouseId: string;
  remotePath: string;
  fileName: string;
  fileSha256: string;
  fileSizeBytes: number;
  fileKind: InboundFileKind;
  parseSummary: unknown;
  dispatchStatus: InboundDispatchStatus;
  appliedToEraFileId: string | null;
  appliedToSubmissionId: string | null;
  errorMessage: string | null;
  downloadedAt: string;
  dispatchedAt: string | null;
}

export function fetchInboundFiles(filters?: {
  fileKind?: InboundFileKind;
  dispatchStatus?: InboundDispatchStatus;
}): Promise<{ files: InboundFile[] }> {
  const qs = new URLSearchParams();
  if (filters?.fileKind) qs.set("fileKind", filters.fileKind);
  if (filters?.dispatchStatus) qs.set("dispatchStatus", filters.dispatchStatus);
  const tail = qs.toString();
  return getJSON(`/admin/clearinghouse-inbound-files${tail ? `?${tail}` : ""}`);
}

export interface UploadAckResponse {
  ok: true;
  inboundFileId: string;
  fileKind: InboundFileKind;
  fileSizeBytes: number;
}

export function uploadOaAck(body: {
  content: string;
  fileName?: string;
}): Promise<UploadAckResponse> {
  return postJSON("/admin/office-ally/upload-ack", body);
}
