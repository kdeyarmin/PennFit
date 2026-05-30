// Hand-rolled fetch wrappers for the equipment registry + recall
// surface. Same pattern as clinical-tabs-api.ts.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type DeviceClass =
  | "cpap"
  | "auto_cpap"
  | "bipap"
  | "asv"
  | "avaps"
  | "humidifier"
  | "oximeter"
  | "other";

export type EquipmentStatus = "active" | "returned" | "recalled" | "retired";

export interface EquipmentAsset {
  id: string;
  patientId: string;
  prescriptionId: string | null;
  deviceClass: DeviceClass;
  manufacturer: string;
  model: string;
  serialNumber: string;
  pressureSetting: string | null;
  humidifierSetting: string | null;
  status: EquipmentStatus;
  dispensedAt: string | null;
  dispensingNote: string | null;
  recallId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateEquipmentAssetRequest {
  deviceClass: DeviceClass;
  manufacturer: string;
  model: string;
  serialNumber: string;
  pressureSetting?: string | null;
  humidifierSetting?: string | null;
  prescriptionId?: string | null;
  dispensedAt?: string | null;
  dispensingNote?: string | null;
  notes?: string | null;
}

export interface PatchEquipmentAssetRequest {
  status?: EquipmentStatus;
  pressureSetting?: string | null;
  humidifierSetting?: string | null;
  dispensingNote?: string | null;
  notes?: string | null;
}

export type RecallSerialMatch =
  | { kind: "range"; from: string; to: string }
  | { kind: "list"; serials: string[] }
  | null;

export type RecallSeverity = "urgent" | "priority" | "advisory";
export type RecallStatus = "active" | "closed";

export interface EquipmentRecall {
  id: string;
  recallReference: string;
  title: string;
  manufacturer: string;
  modelMatch: string | null;
  serialMatch: RecallSerialMatch;
  severity: RecallSeverity;
  status: RecallStatus;
  issuedAt: string | null;
  deadlineAt: string | null;
  referenceUrl: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRecallRequest {
  recallReference: string;
  title: string;
  manufacturer: string;
  modelMatch?: string | null;
  serialMatch?: RecallSerialMatch;
  severity?: RecallSeverity;
  issuedAt?: string | null;
  deadlineAt?: string | null;
  referenceUrl?: string | null;
  description?: string | null;
}

export interface RecallScanResult {
  recallId: string;
  candidatesScanned: number;
  affectedCount: number;
  affected: Array<{
    id: string;
    patientId: string;
    manufacturer: string;
    model: string;
    serialNumber: string;
    status: EquipmentStatus;
    dispensedAt: string | null;
  }>;
}

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
      // body not JSON
    }
    throw new ApiError(res, data, { method, url });
  }
  return (await res.json()) as T;
}

// ── Per-patient equipment ──────────────────────────────────────────

export const listPatientEquipment = (patientId: string) =>
  jsonFetch<{ equipment: EquipmentAsset[] }>(
    `/patients/${encodeURIComponent(patientId)}/equipment`,
  );

export const createPatientEquipment = (
  patientId: string,
  body: CreateEquipmentAssetRequest,
) =>
  jsonFetch<{ id: string }>(
    `/patients/${encodeURIComponent(patientId)}/equipment`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

export const patchPatientEquipment = (
  patientId: string,
  assetId: string,
  body: PatchEquipmentAssetRequest,
) =>
  jsonFetch<{ id: string; changed: boolean }>(
    `/patients/${encodeURIComponent(patientId)}/equipment/${encodeURIComponent(
      assetId,
    )}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

// ── Recalls ────────────────────────────────────────────────────────

export const listEquipmentRecalls = () =>
  jsonFetch<{ recalls: EquipmentRecall[] }>(`/admin/equipment-recalls`);

export const createEquipmentRecall = (body: CreateRecallRequest) =>
  jsonFetch<{ id: string }>(`/admin/equipment-recalls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const scanEquipmentRecall = (recallId: string) =>
  jsonFetch<RecallScanResult>(
    `/admin/equipment-recalls/${encodeURIComponent(recallId)}/scan`,
  );

// ── Match-and-notify + remediation ─────────────────────────────────

export interface MatchAssetsResult {
  recallId: string;
  matchedCount: number;
  newlyQueuedCount: number;
  alreadyQueuedCount: number;
  skippedNonMatchCount: number;
}

export const matchRecallAssets = (recallId: string) =>
  jsonFetch<MatchAssetsResult>(
    `/admin/equipment-recalls/${encodeURIComponent(recallId)}/match-assets`,
    { method: "POST" },
  );

export type RecallNotificationStatus =
  | "queued"
  | "sent"
  | "failed"
  | "bounced"
  | "skipped";

export interface RecallNotification {
  id: string;
  assetId: string;
  patientId: string;
  status: RecallNotificationStatus;
  channel: "email" | "sms" | "letter" | null;
  notifiedAt: string | null;
  failedAt: string | null;
  failedReason: string | null;
  createdAt: string;
}

export const listRecallNotifications = (recallId: string) =>
  jsonFetch<{
    counts: Record<string, number>;
    notifications: RecallNotification[];
  }>(`/admin/equipment-recalls/${encodeURIComponent(recallId)}/notifications`);

export type RemediationAction =
  | "returned_to_manufacturer"
  | "destroyed"
  | "replaced"
  | "patient_declined"
  | "lost"
  | "unreachable";

export interface RemediationLogEntry {
  id: string;
  assetId: string;
  action: RemediationAction;
  evidenceUrl: string | null;
  notes: string | null;
  performedByUserId: string | null;
  performedAt: string;
}

export const listRecallRemediation = (recallId: string) =>
  jsonFetch<{
    counts: Record<string, number>;
    actions: RemediationLogEntry[];
  }>(`/admin/equipment-recalls/${encodeURIComponent(recallId)}/remediation`);

export const logRecallRemediation = (
  recallId: string,
  body: {
    assetId: string;
    action: RemediationAction;
    evidenceUrl?: string | null;
    notes?: string | null;
  },
) =>
  jsonFetch<{ id: string }>(
    `/admin/equipment-recalls/${encodeURIComponent(recallId)}/remediation`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
