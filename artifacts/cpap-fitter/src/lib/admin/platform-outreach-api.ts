// Client for the platform super-admin outreach surfaces:
//   * /platform/contacts*          — saved contacts / leads (mini-CRM)
//   * /platform/email-campaigns*   — broadcast campaigns + lifecycle
//
// All gated server-side by requirePlatformAdmin. Mirrors the jsonFetch
// pattern in platform-config-api.ts (credentials + CSRF header).

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers, ...rest } = init;
  const method = (init.method ?? "GET").toUpperCase();
  const url = `/resupply-api${path}`;
  const res = await fetch(url, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...csrfHeader(),
      ...(headers ?? {}),
    },
    ...rest,
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {}
    throw new ApiError(res, data, { method, url });
  }
  return (await res.json()) as T;
}

// ── Contacts ────────────────────────────────────────────────────────

export interface PlatformContact {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  tags: string[];
  notes: string | null;
  unsubscribed: boolean;
  unsubscribed_at: string | null;
  source: "manual" | "import";
  created_at: string;
  updated_at: string;
}

export function listPlatformContacts(opts?: {
  search?: string;
  tag?: string;
}): Promise<{ contacts: PlatformContact[] }> {
  const params = new URLSearchParams();
  if (opts?.search) params.set("search", opts.search);
  if (opts?.tag) params.set("tag", opts.tag);
  const qs = params.toString();
  return jsonFetch(`/platform/contacts${qs ? `?${qs}` : ""}`);
}

export function createPlatformContact(body: {
  email: string;
  name?: string | null;
  company?: string | null;
  tags?: string[];
  notes?: string | null;
}): Promise<{ contact: PlatformContact }> {
  return jsonFetch("/platform/contacts", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function importPlatformContacts(body: {
  raw?: string;
  contacts?: Array<{
    email: string;
    name?: string | null;
    company?: string | null;
  }>;
  tags?: string[];
}): Promise<{ imported: number; skipped: number }> {
  return jsonFetch("/platform/contacts/import", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updatePlatformContact(
  id: string,
  body: Partial<{
    name: string | null;
    company: string | null;
    tags: string[];
    notes: string | null;
    unsubscribed: boolean;
  }>,
): Promise<{ contact: PlatformContact }> {
  return jsonFetch(`/platform/contacts/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deletePlatformContact(id: string): Promise<{ ok: true }> {
  return jsonFetch(`/platform/contacts/${id}`, { method: "DELETE" });
}

// ── Campaigns ───────────────────────────────────────────────────────

export type PlatformAudienceKind =
  | "all_tenants"
  | "selected_tenants"
  | "all_contacts"
  | "contacts_by_tag"
  | "manual_list";

export type PlatformCampaignStatus =
  | "draft"
  | "sending"
  | "sent"
  | "paused"
  | "cancelled";

export interface PlatformCampaignSummary {
  id: string;
  name: string;
  subject: string;
  audienceKind: PlatformAudienceKind;
  status: PlatformCampaignStatus;
  totalRecipients: number;
  pendingRecipients: number;
  suppressedCount: number;
  sentCount: number;
  failedCount: number;
  throttlePerMinute: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
}

export interface PlatformCampaignRecipient {
  id: string;
  recipientKind: "tenant" | "contact" | "manual";
  recipientEmail: string;
  recipientName: string | null;
  status: string;
  suppressionReason: string | null;
}

export interface PlatformCampaignDetail extends PlatformCampaignSummary {
  bodyText: string;
  bodyHtml: string | null;
  audiencePayload: unknown;
  recipients: PlatformCampaignRecipient[];
}

export function listPlatformCampaigns(): Promise<{
  campaigns: PlatformCampaignSummary[];
}> {
  return jsonFetch("/platform/email-campaigns");
}

export function getPlatformCampaign(
  id: string,
): Promise<PlatformCampaignDetail> {
  return jsonFetch(`/platform/email-campaigns/${id}`);
}

export function createPlatformCampaignDraft(body: {
  name: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  audienceKind: PlatformAudienceKind;
  tenantIds?: string[];
  tag?: string;
  emails?: string[];
  throttlePerMinute?: number;
}): Promise<{
  id: string;
  totals: { total: number; pending: number; suppressed: number };
}> {
  return jsonFetch("/platform/email-campaigns/draft", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function platformCampaignAction(
  id: string,
  action: "start" | "pause" | "resume" | "cancel",
): Promise<{ id: string; status: PlatformCampaignStatus }> {
  return jsonFetch(`/platform/email-campaigns/${id}/${action}`, {
    method: "POST",
  });
}
