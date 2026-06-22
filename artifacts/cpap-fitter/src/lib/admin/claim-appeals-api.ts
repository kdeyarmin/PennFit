// Hand-rolled fetch wrappers for the per-claim appeal-letter endpoints
// (routes/admin/claim-appeals.ts). These back the appeals workbench section in
// the claim drawer. The whole appeal lifecycle already exists server-side —
// generate the letter PDF, list letters, fax to payer, mark an out-of-band
// delivery, and record the payer's outcome — but had no UI until now.
//
// Auth: the browser sends the `pf_session` cookie automatically on same-origin
// requests, so no per-call auth header is needed (CSRF header on mutations).

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type AppealDeliveryMethod = "fax" | "mail" | "portal_upload" | "email";
export type AppealOutcome =
  | "pending"
  | "overturned"
  | "upheld"
  | "partial"
  | "withdrawn";

export interface AppealLetterRow {
  id: string;
  claim_id: string;
  denial_analysis_id: string | null;
  letter_body: string;
  delivery_method: AppealDeliveryMethod | null;
  delivered_at: string | null;
  generated_by_email: string | null;
  outcome: AppealOutcome | null;
  responded_at: string | null;
  created_at: string;
}

function base(patientId: string, claimId: string): string {
  return `/resupply-api/admin/patients/${encodeURIComponent(
    patientId,
  )}/insurance-claims/${encodeURIComponent(claimId)}/appeal-letter`;
}

async function readJsonOrThrow<T>(
  res: Response,
  method: string,
  url: string,
): Promise<T> {
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON body — leave data null
  }
  if (!res.ok) {
    throw new ApiError(res, data, { method, url });
  }
  return data as T;
}

export async function listAppealLetters(
  patientId: string,
  claimId: string,
): Promise<AppealLetterRow[]> {
  const url = base(patientId, claimId);
  const res = await fetch(url, { credentials: "same-origin" });
  const data = await readJsonOrThrow<{ appealLetters: AppealLetterRow[] }>(
    res,
    "GET",
    url,
  );
  return data.appealLetters ?? [];
}

// Generate + persist an appeal letter; the response is the rendered PDF, which
// we trigger as a download. Returns the new letter id from the X-Appeal-Id
// header so the caller can refresh the list.
export async function generateAppealLetter(
  patientId: string,
  claimId: string,
  input: { letterBody: string; deliveryMethod?: AppealDeliveryMethod },
): Promise<{ appealId: string | null }> {
  const url = base(patientId, claimId);
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...csrfHeader() },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // ignore
    }
    throw new ApiError(res, data, { method: "POST", url });
  }
  const appealId = res.headers.get("X-Appeal-Id");
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = `appeal-${(appealId ?? "letter").slice(0, 8)}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
  return { appealId };
}

export async function faxAppealLetter(
  patientId: string,
  claimId: string,
  letterId: string,
  faxNumber: string,
): Promise<{ ok: boolean; vendorRef: string }> {
  const url = `${base(patientId, claimId)}/${encodeURIComponent(letterId)}/fax`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...csrfHeader() },
    body: JSON.stringify({ faxNumber }),
  });
  return readJsonOrThrow(res, "POST", url);
}

export async function markAppealDelivered(
  patientId: string,
  claimId: string,
  letterId: string,
  deliveryMethod: "mail" | "email" | "portal_upload",
): Promise<{ ok: boolean }> {
  const url = `${base(patientId, claimId)}/${encodeURIComponent(
    letterId,
  )}/mark-delivered`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...csrfHeader() },
    body: JSON.stringify({ deliveryMethod }),
  });
  return readJsonOrThrow(res, "POST", url);
}

export async function recordAppealOutcome(
  patientId: string,
  claimId: string,
  letterId: string,
  outcome: "overturned" | "upheld" | "partial" | "withdrawn",
  respondedAt?: string,
): Promise<{ ok: boolean; outcome: string; respondedAt: string }> {
  const url = `${base(patientId, claimId)}/${encodeURIComponent(
    letterId,
  )}/outcome`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...csrfHeader() },
    body: JSON.stringify(respondedAt ? { outcome, respondedAt } : { outcome }),
  });
  return readJsonOrThrow(res, "POST", url);
}
