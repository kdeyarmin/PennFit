// Hand-rolled fetch wrappers for the admin csr-macros endpoints.
// Mirrors the shop-reviews/-returns pattern.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type MacroChannel = "sms" | "email";

export interface CsrMacro {
  id: string;
  key: string;
  label: string;
  category: string | null;
  body: string;
  channels: MacroChannel[];
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

const BASE = "/resupply-api/admin/csr-macros";

export async function listMacros(opts?: {
  includeInactive?: boolean;
}): Promise<{ macros: CsrMacro[] }> {
  const qs = new URLSearchParams();
  if (opts?.includeInactive) qs.set("includeInactive", "1");
  const url = `${BASE}${qs.toString() ? `?${qs.toString()}` : ""}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as { macros: CsrMacro[] };
}

export async function createMacro(body: {
  key: string;
  label: string;
  category?: string | null;
  body: string;
  channels: MacroChannel[];
  sortOrder?: number;
}): Promise<{ macro: CsrMacro }> {
  const res = await fetch(BASE, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new ApiError(res, json, { method: "POST", url: BASE });
  }
  return (await res.json()) as { macro: CsrMacro };
}

export async function patchMacro(
  id: string,
  body: Partial<{
    label: string;
    category: string | null;
    body: string;
    channels: MacroChannel[];
    sortOrder: number;
    isActive: boolean;
  }>,
): Promise<{ macro: CsrMacro }> {
  const url = `${BASE}/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "PATCH",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new ApiError(res, json, { method: "PATCH", url });
  }
  return (await res.json()) as { macro: CsrMacro };
}

export async function deleteMacro(id: string, hard = false): Promise<void> {
  const qs = hard ? "?hard=1" : "";
  const url = `${BASE}/${encodeURIComponent(id)}${qs}`;
  const res = await fetch(url, {
    method: "DELETE",
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new ApiError(res, json, { method: "DELETE", url });
  }
}
