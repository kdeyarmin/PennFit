// Hand-rolled fetch wrappers for the /admin/pacware/* endpoints.
// Same pattern as integrations-status-api.ts.
//
// PacWare is a legacy DME billing system with no API; this surface is a
// CSV file exchange. The patient-roster import POSTs the whole report
// text (the server parses + validates with the shared
// @workspace/resupply-integrations-pacware package), so the UI stays a
// thin file-picker + preview + commit.

import { ApiError } from "@workspace/api-client-react/admin";
import { csrfHeader } from "../csrf";

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const url = `/resupply-api${path}`;
  const { headers: initHeaders, ...restInit } = init;
  const res = await fetch(url, {
    ...restInit,
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
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

export interface PacwareColumn {
  field: string;
  header: string;
  required: boolean;
  description: string;
  aliases: string[];
}

export interface PacwareReport {
  kind: string;
  direction: "import" | "export" | "both";
  label: string;
  description: string;
  columns: PacwareColumn[];
}

export type PacwareAvailability =
  | { status: "configured"; mode: "file_exchange"; outboxConfigured: boolean }
  | { status: "disabled"; reason: string };

export interface PacwareStatus {
  availability: PacwareAvailability;
  reports: PacwareReport[];
  generatedAt: string;
}

export interface PacwareRowError {
  rowIndex: number;
  field?: string;
  message: string;
}

export interface PacwareImportPreview {
  mode: "preview";
  validCount: number;
  errorCount: number;
  totalDataRows: number;
  unmappedHeaders: string[];
  presentFields: string[];
  errors: PacwareRowError[];
}

export interface PacwareImportCommit {
  mode: "commit";
  synced: number;
  validCount: number;
  errorCount: number;
  totalDataRows: number;
  unmappedHeaders: string[];
  errors: PacwareRowError[];
  batchErrors: string[];
}

export const getPacwareStatus = () =>
  jsonFetch<PacwareStatus>("/admin/pacware/status");

export const importPacwarePatients = (
  csv: string,
  mode: "preview" | "commit",
) =>
  jsonFetch<PacwareImportPreview | PacwareImportCommit>(
    "/admin/pacware/import/patients",
    { method: "POST", body: JSON.stringify({ csv, mode }) },
  );
