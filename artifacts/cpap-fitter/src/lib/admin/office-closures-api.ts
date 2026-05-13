// Hand-rolled fetch wrappers for /admin/office-closures.

export interface OfficeClosure {
  id: string;
  label: string;
  startsAt: string;
  endsAt: string;
  autoReplyMessage: string;
  createdByUserId: string | null;
  createdAt: string;
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

export const listOfficeClosures = () =>
  jsonFetch<{ closures: OfficeClosure[] }>("/admin/office-closures");

export const getActiveClosure = () =>
  jsonFetch<{ active: OfficeClosure | null }>(
    "/admin/office-closures/active",
  );

export const createClosure = (body: {
  label: string;
  startsAt: string;
  endsAt: string;
  autoReplyMessage: string;
}) =>
  jsonFetch<{ id: string }>("/admin/office-closures", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const endClosureNow = (id: string) =>
  jsonFetch<{ ok: true }>(`/admin/office-closures/${id}/end-now`, {
    method: "POST",
  });
