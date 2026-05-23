// Hand-rolled fetch wrappers for /admin/shop/backorders and
// /admin/shop/sku-substitutes.

import { csrfHeader } from "../csrf";

export interface Backorder {
  id: string;
  sku: string;
  markedAt: string;
  clearedAt: string | null;
  notes: string | null;
  markedByUserId: string | null;
  createdAt: string;
}

export interface SkuSubstitute {
  id: string;
  primarySku: string;
  alternativeSku: string;
  priority: number;
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/resupply-api${path}`, {
    credentials: "include",
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

export const listBackorders = () =>
  jsonFetch<{ backorders: Backorder[] }>("/admin/shop/backorders");

export const markBackorder = (body: { sku: string; notes?: string }) =>
  jsonFetch<{ id: string }>("/admin/shop/backorders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const clearBackorder = (id: string, notes?: string) =>
  jsonFetch<{ ok: true }>(`/admin/shop/backorders/${id}/clear`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(notes ? { notes } : {}),
  });

export const listSubstitutes = (primarySku?: string) => {
  const qs = primarySku
    ? `?primary_sku=${encodeURIComponent(primarySku)}`
    : "";
  return jsonFetch<{ substitutes: SkuSubstitute[] }>(
    `/admin/shop/sku-substitutes${qs}`,
  );
};

export const createSubstitute = (body: {
  primarySku: string;
  alternativeSku: string;
  priority?: number;
  notes?: string;
}) =>
  jsonFetch<{ id: string }>("/admin/shop/sku-substitutes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const patchSubstitute = (
  id: string,
  body: { priority?: number; active?: boolean; notes?: string | null },
) =>
  jsonFetch<{ ok: true }>(`/admin/shop/sku-substitutes/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const deleteSubstitute = (id: string) =>
  jsonFetch<{ ok: true }>(`/admin/shop/sku-substitutes/${id}`, {
    method: "DELETE",
  });
