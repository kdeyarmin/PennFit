// Fetch wrappers for CSR #11 click-to-dial + disposition logging.
// The dial places an agent-first Twilio bridge (Twilio rings the CSR's
// own phone first, then connects the patient); the disposition logs the
// outcome afterwards. The patient's number never reaches the browser.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export const CALL_OUTCOMES = [
  "reached",
  "voicemail",
  "no_answer",
  "busy",
  "failed",
  "wrong_number",
  "callback_requested",
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export interface PlaceDialResponse {
  dispositionId: string;
  callSid: string;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const url = `/resupply-api${path}`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "POST", url });
  }
  return (await res.json()) as T;
}

export function placeClickToDial(
  patientId: string,
  opts: { override?: boolean } = {},
): Promise<PlaceDialResponse> {
  return postJson<PlaceDialResponse>(
    `/admin/patients/${encodeURIComponent(patientId)}/click-to-dial`,
    opts.override ? { override: true } : {},
  );
}

export function logCallDisposition(
  dispositionId: string,
  body: { outcome: CallOutcome; note?: string },
): Promise<{ id: string; outcome: string }> {
  return postJson(
    `/admin/call-dispositions/${encodeURIComponent(dispositionId)}`,
    body,
  );
}

export interface CallDisposition {
  id: string;
  outcome: string;
  note: string | null;
  agentEmail: string | null;
  createdAt: string;
}

export async function getPatientCallHistory(
  patientId: string,
): Promise<{ dispositions: CallDisposition[]; count: number }> {
  // POST (not GET) with the patient id in the body — the patient id is a
  // read input, but a CodeQL autofix moved it off the URL ("sensitive data
  // read from GET request"); the server route is now
  // POST /admin/patients/call-dispositions.
  const url = "/resupply-api/admin/patients/call-dispositions";
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify({ patientId }),
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "POST", url });
  }
  return (await res.json()) as {
    dispositions: CallDisposition[];
    count: number;
  };
}

/** Set the current agent's own click-to-dial bridge number (E.164, or "" to clear). */
export function setAgentPhone(
  phoneE164: string,
): Promise<{ hasPhone: boolean; phoneLast4: string | null }> {
  return postJson("/admin/agent-availability/me/phone", { phoneE164 });
}

export const OUTCOME_LABEL: Record<CallOutcome, string> = {
  reached: "Reached patient",
  voicemail: "Left voicemail",
  no_answer: "No answer",
  busy: "Busy",
  failed: "Call failed",
  wrong_number: "Wrong number",
  callback_requested: "Callback requested",
};
