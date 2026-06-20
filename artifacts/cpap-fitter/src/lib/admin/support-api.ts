// Client for the support-ticket surfaces:
//   Tenant (admin console):   /admin/support/tickets*
//   Platform (super-admin):   /platform/support/tickets*
//
// Tenant routes are gated server-side by requireAdmin + the
// `support.tickets` feature flag; platform routes by requirePlatformAdmin.
// Mirrors the jsonFetch pattern in platform-config-api.ts.

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

export type SupportTicketStatus =
  | "open"
  | "awaiting_tenant"
  | "awaiting_platform"
  | "resolved"
  | "closed";

export interface SupportMessage {
  id: string;
  authorRole: "tenant" | "bot" | "platform";
  authorEmail: string | null;
  body: string;
  createdAt: string;
}

export interface SupportTicket {
  id: string;
  subject: string;
  status: SupportTicketStatus;
  botAnswered: boolean;
  botConfidence: number | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  /** Platform queue only: the owning tenant. */
  orgId?: string;
  tenant?: { slug: string; name: string | null } | null;
}

export interface SupportTicketDetail {
  ticket: SupportTicket;
  messages: SupportMessage[];
  /** Create response only: true when no AI provider answered on intake. */
  botOffline?: boolean;
}

// ── Tenant (admin console) ──────────────────────────────────────────

export function listSupportTickets(
  status?: SupportTicketStatus,
): Promise<{ tickets: SupportTicket[] }> {
  const q = status ? `?status=${encodeURIComponent(status)}` : "";
  return jsonFetch<{ tickets: SupportTicket[] }>(`/admin/support/tickets${q}`);
}

export function getSupportTicket(id: string): Promise<SupportTicketDetail> {
  return jsonFetch<SupportTicketDetail>(
    `/admin/support/tickets/${encodeURIComponent(id)}`,
  );
}

export function createSupportTicket(body: {
  subject: string;
  body: string;
}): Promise<SupportTicketDetail> {
  return jsonFetch<SupportTicketDetail>("/admin/support/tickets", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function addSupportMessage(
  id: string,
  body: string,
): Promise<SupportTicketDetail> {
  return jsonFetch<SupportTicketDetail>(
    `/admin/support/tickets/${encodeURIComponent(id)}/messages`,
    { method: "POST", body: JSON.stringify({ body }) },
  );
}

export function resolveSupportTicket(
  id: string,
): Promise<{ ticket: SupportTicket }> {
  return jsonFetch<{ ticket: SupportTicket }>(
    `/admin/support/tickets/${encodeURIComponent(id)}/resolve`,
    { method: "POST" },
  );
}

// ── Platform (super-admin queue) ────────────────────────────────────

export function listPlatformSupportTickets(
  status?: SupportTicketStatus,
): Promise<{ tickets: SupportTicket[]; counts: Record<string, number> }> {
  const q = status ? `?status=${encodeURIComponent(status)}` : "";
  return jsonFetch<{
    tickets: SupportTicket[];
    counts: Record<string, number>;
  }>(`/platform/support/tickets${q}`);
}

export function getPlatformSupportTicket(
  id: string,
): Promise<SupportTicketDetail> {
  return jsonFetch<SupportTicketDetail>(
    `/platform/support/tickets/${encodeURIComponent(id)}`,
  );
}

export function replyPlatformSupportTicket(
  id: string,
  body: string,
): Promise<SupportTicketDetail> {
  return jsonFetch<SupportTicketDetail>(
    `/platform/support/tickets/${encodeURIComponent(id)}/reply`,
    { method: "POST", body: JSON.stringify({ body }) },
  );
}

export function setPlatformSupportStatus(
  id: string,
  status: SupportTicketStatus,
): Promise<{ ticket: SupportTicket }> {
  return jsonFetch<{ ticket: SupportTicket }>(
    `/platform/support/tickets/${encodeURIComponent(id)}/status`,
    { method: "POST", body: JSON.stringify({ status }) },
  );
}

// ── Shared display helpers ──────────────────────────────────────────

export function statusLabel(status: SupportTicketStatus): string {
  switch (status) {
    case "awaiting_tenant":
      return "Awaiting you";
    case "awaiting_platform":
      return "With support";
    case "resolved":
      return "Resolved";
    case "closed":
      return "Closed";
    default:
      return "Open";
  }
}

export function statusVariant(
  status: SupportTicketStatus,
): "success" | "danger" | "muted" | "info" | "neutral" {
  switch (status) {
    case "awaiting_tenant":
      return "info";
    case "awaiting_platform":
      return "danger";
    case "resolved":
    case "closed":
      return "muted";
    default:
      return "neutral";
  }
}
