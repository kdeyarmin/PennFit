// Hand-rolled fetch wrappers for /admin/alerts — backs the admin
// Alert Library page. Mirrors the csr-macros-api / feature-flags-api
// shape: plain fetch, credentials + csrfHeader on mutations, errors
// wrapped in ApiError.

import { adminJsonFetch } from "../admin-json-fetch";

export type AlertChannel = "email" | "sms" | "voice";
export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertMessage {
  channel: AlertChannel;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string;
  isActive: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

export interface AlertDefinition {
  key: string;
  name: string;
  description: string | null;
  // `category` stays a free string — the backend column is TEXT with no
  // enum, so a union here would drift from the DB.
  category: string;
  severity: AlertSeverity;
  channels: AlertChannel[];
  allowedVariables: string[];
  isActive: boolean;
  messages: AlertMessage[];
}

export interface PatchAlertMessageBody {
  subject?: string | null;
  bodyHtml?: string | null;
  bodyText?: string;
  isActive?: boolean;
}

export interface SendAlertBody {
  patientId: string;
  channel: AlertChannel;
  variables?: Record<string, string>;
}

// Routes live under /admin/alerts; adminJsonFetch adds the /resupply-api
// mount. Call sites pass the sub-path (e.g. "" or `/${key}`).
const jsonFetch = <T>(path: string, init?: RequestInit): Promise<T> =>
  adminJsonFetch<T>(`/admin/alerts${path}`, init);

export const listAlerts = () => jsonFetch<{ alerts: AlertDefinition[] }>("");

export const getAlert = (key: string) =>
  jsonFetch<{ alert: AlertDefinition }>(`/${encodeURIComponent(key)}`);

export const patchAlertMessage = (
  key: string,
  channel: AlertChannel,
  body: PatchAlertMessageBody,
) =>
  jsonFetch<{ message: AlertMessage }>(
    `/${encodeURIComponent(key)}/messages/${encodeURIComponent(channel)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

export const sendAlert = (key: string, body: SendAlertBody) =>
  jsonFetch<{ channel: AlertChannel; vendorRef: string }>(
    `/${encodeURIComponent(key)}/send`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
