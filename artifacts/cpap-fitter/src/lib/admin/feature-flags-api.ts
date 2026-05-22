// Hand-rolled fetch wrappers for /admin/feature-flags — backs the
// admin Control Center.

export interface FeatureFlag {
  key: string;
  enabled: boolean;
  description: string;
  category: string;
  updatedByEmail: string | null;
  updatedAt: string;
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/resupply-api${path}`, {
    credentials: "include",
    headers: { Accept: "application/json", ...(init.headers ?? {}) },
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

export const listFeatureFlags = () =>
  jsonFetch<{ flags: FeatureFlag[] }>("/admin/feature-flags");

export const toggleFeatureFlag = (key: string, enabled: boolean) =>
  jsonFetch<{ flag: FeatureFlag }>(
    `/admin/feature-flags/${encodeURIComponent(key)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
