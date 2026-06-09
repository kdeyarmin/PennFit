// Fetch wrappers for Biller #30 — patient-responsibility statement send.
// Read the pending worklist (reports.read); send single / batch
// (admin.tools.manage, enforced server-side).

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export interface PendingStatement {
  statementId: string;
  patientId: string;
  amountCents: number;
  createdAt: string;
}

export interface PendingStatementsResponse {
  pending: PendingStatement[];
  count: number;
  totalCents: number;
}

export type StatementSendOutcome =
  | { kind: "sent"; channel: "email" | "sms" }
  | { kind: "failed"; channel: "email" | "sms"; reason: string }
  | { kind: "skipped"; reason: string }
  | { kind: "mail"; reason: string };

export interface StatementBatchSummary {
  scanned: number;
  sent: number;
  failed: number;
  skipped: number;
  mailQueued: number;
}

export interface MailQueueStatement {
  statementId: string;
  patientId: string;
  amountCents: number;
  createdAt: string;
}

export interface MailQueueResponse {
  queued: MailQueueStatement[];
  count: number;
  totalCents: number;
  printCap: number;
}

async function parseError(res: Response, method: string, url: string) {
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // body not JSON
  }
  return new ApiError(res, data, { method, url });
}

export async function getPendingStatements(): Promise<PendingStatementsResponse> {
  const url = "/resupply-api/admin/billing/statements/pending";
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await parseError(res, "GET", url);
  return (await res.json()) as PendingStatementsResponse;
}

export async function sendStatement(
  statementId: string,
): Promise<{ outcome: StatementSendOutcome }> {
  const url = `/resupply-api/admin/billing/statements/${encodeURIComponent(
    statementId,
  )}/send`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  if (!res.ok) throw await parseError(res, "POST", url);
  return (await res.json()) as { outcome: StatementSendOutcome };
}

export async function sendStatementBatch(
  cap?: number,
): Promise<{ summary: StatementBatchSummary }> {
  const url = "/resupply-api/admin/billing/statements/batch-send";
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(cap ? { cap } : {}),
  });
  if (!res.ok) throw await parseError(res, "POST", url);
  return (await res.json()) as { summary: StatementBatchSummary };
}

// ── Mail worklist (delivery_method = 'mail') ───────────────────────

export async function getMailQueueStatements(): Promise<MailQueueResponse> {
  const url = "/resupply-api/admin/billing/statements/mail-queue";
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await parseError(res, "GET", url);
  return (await res.json()) as MailQueueResponse;
}

/** URL for the combined print-batch PDF (one statement per page). The
 *  browser downloads it directly; the session cookie authenticates. */
export function mailQueuePrintUrl(): string {
  return "/resupply-api/admin/billing/statements/mail-queue/print";
}

export async function markStatementsMailed(
  statementIds: string[],
): Promise<{ marked: number }> {
  const url = "/resupply-api/admin/billing/statements/mark-mailed";
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify({ statementIds }),
  });
  if (!res.ok) throw await parseError(res, "POST", url);
  return (await res.json()) as { marked: number };
}
