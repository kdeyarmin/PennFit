// New CPAP setup board. Auth rides on the pf_session cookie.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type SetupStage =
  | "coverage"
  | "docs"
  | "fit"
  | "order"
  | "auth"
  | "release"
  | "setup"
  | "ready";

export interface SetupBoardRow {
  id: string;
  kind: "setup" | "fit_request";
  patientId: string | null;
  displayName: string;
  source: string;
  openedAt: string;
  ageHours: number;
  stage: SetupStage;
  blocker: string | null;
  href: string;
  ownerUserId: string | null;
  ownerEmail: string | null;
}

export interface MorningCounts {
  openReferralReviews: number;
  staleFitRequests: number;
  unsignedPackets: number;
  priorAuthsInSla: number;
}

export interface SetupBoard {
  rows: SetupBoardRow[];
  morning: MorningCounts;
}

const BASE = "/resupply-api/admin/setups";

async function readError(
  res: Response,
  method: string,
  url: string,
): Promise<ApiError> {
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // body not JSON
  }
  return new ApiError(res, data, { method, url });
}

export async function fetchSetupBoard(limit = 50): Promise<SetupBoard> {
  const url = `${BASE}?limit=${encodeURIComponent(String(limit))}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    credentials: "include",
  });
  if (!res.ok) throw await readError(res, "GET", url);
  return (await res.json()) as SetupBoard;
}

export async function patchSetup(
  id: string,
  action: "claim" | "release" | "cancel",
): Promise<void> {
  const url = `${BASE}/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    credentials: "include",
    body: JSON.stringify({ action }),
  });
  if (!res.ok) throw await readError(res, "PATCH", url);
}

export function formatSetupAge(ageHours: number): string {
  if (ageHours < 1) return "under an hour";
  if (ageHours < 48) return `${ageHours}h`;
  return `${Math.round(ageHours / 24)}d`;
}

export const SETUP_STAGE_LABEL: Record<SetupStage, string> = {
  coverage: "Coverage",
  docs: "Paperwork",
  fit: "Fit",
  order: "Signature",
  auth: "Prior auth",
  release: "Release",
  setup: "First night",
  ready: "Ready",
};
