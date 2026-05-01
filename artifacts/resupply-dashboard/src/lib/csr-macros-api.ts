// Hand-rolled fetch wrappers for the admin csr-macros endpoints.
// Mirrors the shop-reviews/-returns pattern.

type ClerkGlobal = {
  session?: { getToken: () => Promise<string | null> } | null;
};

async function authHeaders(): Promise<Record<string, string>> {
  const clerk = (globalThis as unknown as { Clerk?: ClerkGlobal }).Clerk;
  if (!clerk?.session) return {};
  try {
    const token = await clerk.session.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

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
  const res = await fetch(`${BASE}${qs.toString() ? `?${qs.toString()}` : ""}`, {
    headers: { Accept: "application/json", ...(await authHeaders()) },
  });
  if (!res.ok) throw new Error(`Failed to load macros (${res.status})`);
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
      ...(await authHeaders()),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null;
    throw new Error(json?.message ?? json?.error ?? `Create failed (${res.status})`);
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
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null;
    throw new Error(json?.message ?? json?.error ?? `Patch failed (${res.status})`);
  }
  return (await res.json()) as { macro: CsrMacro };
}

export async function deleteMacro(id: string, hard = false): Promise<void> {
  const qs = hard ? "?hard=1" : "";
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}${qs}`, {
    method: "DELETE",
    credentials: "include",
    headers: { Accept: "application/json", ...(await authHeaders()) },
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null;
    throw new Error(json?.message ?? json?.error ?? `Delete failed (${res.status})`);
  }
}
