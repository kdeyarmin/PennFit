// Hand-rolled fetch wrappers for the per-customer message-template
// overrides admin endpoints. Sister to message-templates-api.ts.

import { csrfHeader } from "../csrf";
import { TemplatePatchError } from "./message-templates-api";

export type TemplateChannel = "email" | "sms" | "voice" | "push";

export interface MessageTemplateOverride {
  id: string;
  customerId: string;
  templateKey: string;
  channel: TemplateChannel;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  isActive: boolean;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

function base(userId: string): string {
  return `/resupply-api/admin/shop/customers/${encodeURIComponent(userId)}/message-template-overrides`;
}

export async function listOverrides(
  userId: string,
): Promise<{ overrides: MessageTemplateOverride[] }> {
  const res = await fetch(base(userId), {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to load overrides (${res.status})`);
  }
  return (await res.json()) as { overrides: MessageTemplateOverride[] };
}

export interface CreateOverrideBody {
  templateKey: string;
  channel: TemplateChannel;
  subject?: string | null;
  bodyHtml?: string | null;
  bodyText?: string | null;
  isActive?: boolean;
  note: string;
}

async function readError(res: Response): Promise<never> {
  const json = (await res.json().catch(() => null)) as {
    error?: string;
    message?: string;
    offending?: string[];
    allowed?: string[];
  } | null;
  throw new TemplatePatchError(
    json?.message ?? json?.error ?? `Request failed (${res.status})`,
    res.status,
    json?.offending,
    json?.allowed,
  );
}

export async function createOverride(
  userId: string,
  body: CreateOverrideBody,
): Promise<{ override: MessageTemplateOverride }> {
  const res = await fetch(base(userId), {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) await readError(res);
  return (await res.json()) as { override: MessageTemplateOverride };
}

export interface PatchOverrideBody {
  subject?: string | null;
  bodyHtml?: string | null;
  bodyText?: string | null;
  isActive?: boolean;
  note?: string;
}

export async function patchOverride(
  userId: string,
  id: string,
  body: PatchOverrideBody,
): Promise<{ override: MessageTemplateOverride }> {
  const res = await fetch(`${base(userId)}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) await readError(res);
  return (await res.json()) as { override: MessageTemplateOverride };
}

export async function deactivateOverride(
  userId: string,
  id: string,
): Promise<{ override: MessageTemplateOverride }> {
  const res = await fetch(`${base(userId)}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  if (!res.ok) await readError(res);
  return (await res.json()) as { override: MessageTemplateOverride };
}
