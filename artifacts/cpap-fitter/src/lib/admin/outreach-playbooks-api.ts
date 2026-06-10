// Hand-rolled fetch wrapper for /admin/outreach-playbooks/*.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type PlaybookChannel = "sms" | "email" | "call";

export type PlaybookCategory =
  | "resupply"
  | "clinical"
  | "sales"
  | "onboarding"
  | "service"
  | "engagement";

export const PLAYBOOK_CATEGORY_LABELS: Record<PlaybookCategory, string> = {
  resupply: "Resupply",
  clinical: "Clinical",
  sales: "Sales",
  onboarding: "Onboarding",
  service: "Service",
  engagement: "Re-engagement",
};

export interface PlaybookStep {
  id: string;
  stepIndex: number;
  dayOffset: number;
  channel: PlaybookChannel;
  subject: string | null;
  body: string;
}

export interface Playbook {
  id: string;
  playbookKey: string;
  name: string;
  situation: string;
  description: string | null;
  category: PlaybookCategory;
  isActive: boolean;
  isSeeded: boolean;
  updatedAt: string;
  activeRunCount: number;
  steps: PlaybookStep[];
}

export interface PlaybookStepDraft {
  dayOffset: number;
  channel: PlaybookChannel;
  subject?: string | null;
  body: string;
}

export interface PlaybookRun {
  id: string;
  playbookId: string;
  playbookName: string;
  patientId: string;
  patientName: string;
  status: "active" | "completed" | "cancelled";
  nextStepIndex: number;
  nextStepAt: string | null;
  startedByEmail: string | null;
  startedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
}

export interface CallTask {
  id: string;
  runId: string;
  stepIndex: number;
  hasPhone: boolean;
  patientId: string | null;
  patientName: string;
  playbookName: string;
  callScript: string | null;
  dueSince: string;
}

export type CallOutcome =
  | "reached"
  | "voicemail"
  | "no_answer"
  | "busy"
  | "failed"
  | "wrong_number"
  | "callback_requested";

export const CALL_OUTCOME_LABELS: Record<CallOutcome, string> = {
  reached: "Reached",
  voicemail: "Left voicemail",
  no_answer: "No answer",
  busy: "Busy",
  failed: "Call failed",
  wrong_number: "Wrong number",
  callback_requested: "Callback requested",
};

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers: initHeaders, ...restInit } = init;
  const method = (init.method ?? "GET").toUpperCase();
  const url = `/resupply-api${path}`;
  const res = await fetch(url, {
    ...restInit,
    headers: {
      Accept: "application/json",
      ...csrfHeader(),
      ...(initHeaders ?? {}),
    },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // ignore
    }
    throw new ApiError(res, data, { method, url });
  }
  return (await res.json()) as T;
}

export const listPlaybooks = () =>
  jsonFetch<{ playbooks: Playbook[] }>(`/admin/outreach-playbooks`);

export const createPlaybook = (body: {
  name: string;
  situation: string;
  description?: string | null;
  category: PlaybookCategory;
  steps: PlaybookStepDraft[];
}) =>
  jsonFetch<{ id: string; playbookKey: string }>(`/admin/outreach-playbooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const updatePlaybook = (
  id: string,
  body: {
    name?: string;
    situation?: string;
    description?: string | null;
    category?: PlaybookCategory;
    isActive?: boolean;
  },
) =>
  jsonFetch<{ id: string }>(
    `/admin/outreach-playbooks/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

export const replacePlaybookSteps = (id: string, steps: PlaybookStepDraft[]) =>
  jsonFetch<{ id: string; stepCount: number }>(
    `/admin/outreach-playbooks/${encodeURIComponent(id)}/steps`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ steps }),
    },
  );

export const startPlaybook = (id: string, patientId: string) =>
  jsonFetch<{
    runId: string;
    schedule: Array<{
      stepIndex: number;
      channel: PlaybookChannel;
      dueAt: string;
    }>;
  }>(`/admin/outreach-playbooks/${encodeURIComponent(id)}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patientId }),
  });

export const listRuns = (status: "active" | "completed" | "cancelled") =>
  jsonFetch<{ runs: PlaybookRun[] }>(
    `/admin/outreach-playbooks/runs?status=${encodeURIComponent(status)}`,
  );

export const cancelRun = (id: string) =>
  jsonFetch<{ id: string; status: "cancelled" }>(
    `/admin/outreach-playbooks/runs/${encodeURIComponent(id)}/cancel`,
    { method: "POST" },
  );

export const listCallQueue = () =>
  jsonFetch<{ tasks: CallTask[] }>(`/admin/outreach-playbooks/call-queue`);

export const completeCallTask = (id: string, outcome: CallOutcome) =>
  jsonFetch<{ id: string; status: "call_completed" }>(
    `/admin/outreach-playbooks/call-tasks/${encodeURIComponent(id)}/complete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome }),
    },
  );

export interface PatientSearchHit {
  id: string;
  firstName: string;
  lastName: string;
}

/** Patient typeahead for the "Start playbook" dialog — same endpoint
 *  the manual-documents attach flow uses. */
export const searchPatients = async (
  search: string,
): Promise<PatientSearchHit[]> => {
  const qs = new URLSearchParams({ search, limit: "8" });
  const data = await jsonFetch<{
    items?: Array<{ id: string; firstName?: string; lastName?: string }>;
  }>(`/patients?${qs.toString()}`);
  return (data.items ?? []).map((p) => ({
    id: p.id,
    firstName: p.firstName ?? "",
    lastName: p.lastName ?? "",
  }));
};
