// Hand-rolled fetch wrapper for /admin/compliance/* surfaces.

import { csrfHeader } from "../csrf";

export type TrainingType =
  | "hipaa_privacy"
  | "hipaa_security"
  | "osha_bloodborne"
  | "osha_general"
  | "infection_control"
  | "fit_test"
  | "new_hire_orientation"
  | "dmepos_supplier_stds"
  | "other";

export type TrainingExpiryBucket = "current" | "due_soon" | "expired";

export interface StaffTrainingRecord {
  id: string;
  staffUserId: string;
  trainingType: TrainingType;
  courseTitle: string | null;
  completedAt: string;
  expiresAt: string | null;
  /** PostgREST passes numeric as string. */
  creditHours: string | null;
  provider: string | null;
  certificateReference: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  expiryBucket: TrainingExpiryBucket;
}

export interface CreateTrainingRecordRequest {
  staffUserId: string;
  trainingType: TrainingType;
  courseTitle?: string | null;
  completedAt: string;
  expiresAt?: string | null;
  creditHours?: number | null;
  provider?: string | null;
  certificateReference?: string | null;
  notes?: string | null;
}

export type GrievanceKind = "complaint" | "grievance" | "adverse_event";
export type GrievanceSeverity = "low" | "moderate" | "high";
export type GrievanceSource =
  | "phone"
  | "email"
  | "sms"
  | "in_person"
  | "letter"
  | "portal"
  | "other";
export type GrievanceStatus =
  | "open"
  | "acknowledged"
  | "escalated"
  | "resolved"
  | "reopened";
export type FdaReportStatus = "yes" | "no" | "not_applicable";

export interface Grievance {
  id: string;
  patientId: string;
  equipmentAssetId: string | null;
  kind: GrievanceKind;
  severity: GrievanceSeverity;
  source: GrievanceSource;
  summary: string;
  receivedAt: string;
  status: GrievanceStatus;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  reportedToFda: FdaReportStatus;
  fdaReportReference: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateGrievanceRequest {
  patientId: string;
  equipmentAssetId?: string | null;
  kind: GrievanceKind;
  severity?: GrievanceSeverity;
  source: GrievanceSource;
  summary: string;
  description?: string | null;
  receivedAt: string;
  notes?: string | null;
}

export interface PatchGrievanceRequest {
  status?: GrievanceStatus;
  severity?: GrievanceSeverity;
  resolution?: string | null;
  reportedToFda?: FdaReportStatus;
  fdaReportReference?: string | null;
  notes?: string | null;
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/resupply-api${path}`, {
    headers: { Accept: "application/json", ...csrfHeader(), ...(init.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const listTrainingRecords = () =>
  jsonFetch<{ asOfDate: string; records: StaffTrainingRecord[] }>(
    `/admin/compliance/training-records`,
  );

export const createTrainingRecord = (body: CreateTrainingRecordRequest) =>
  jsonFetch<{ id: string }>(`/admin/compliance/training-records`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const listGrievances = (
  status: "active" | "all" | GrievanceStatus = "active",
) =>
  jsonFetch<{ grievances: Grievance[] }>(
    `/admin/compliance/grievances?status=${encodeURIComponent(status)}`,
  );

export const createGrievance = (body: CreateGrievanceRequest) =>
  jsonFetch<{ id: string }>(`/admin/compliance/grievances`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const patchGrievance = (id: string, body: PatchGrievanceRequest) =>
  jsonFetch<{ id: string; changed: boolean }>(
    `/admin/compliance/grievances/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
