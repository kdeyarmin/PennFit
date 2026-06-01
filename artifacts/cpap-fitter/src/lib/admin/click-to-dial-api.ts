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

export const OUTCOME_LABEL: Record<CallOutcome, string> = {
  reached: "Reached patient",
  voicemail: "Left voicemail",
  no_answer: "No answer",
  busy: "Busy",
  failed: "Call failed",
  wrong_number: "Wrong number",
  callback_requested: "Callback requested",
};
