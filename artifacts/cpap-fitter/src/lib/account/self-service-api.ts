// Fetch wrappers for the patient-side self-service endpoints added
// during the second 15-phase sprint. Same convention as the other
// /shop/me/* clients in this directory.

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
      // ignore non-JSON body
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

// ---- Equipment self-register ----

export type SelfEquipmentItem = {
  id: string;
  deviceClass: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  status: string;
  dispensedAt: string | null;
  createdAt: string;
};

export const listSelfEquipment = () =>
  jsonFetch<{
    patientLinked: boolean;
    assets: SelfEquipmentItem[];
  }>("/shop/me/equipment");

export const registerSelfEquipment = (body: {
  deviceClass: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  dispensedAt?: string | null;
}) =>
  jsonFetch<{ id: string }>("/shop/me/equipment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

// ---- Form acknowledgements (e-sign) ----

export type FormAckEntry = {
  kind: string;
  title: string;
  body: string;
  currentVersion: string;
  lastSignedVersion: string | null;
  lastSignedAt: string | null;
  upToDate: boolean;
};

export const listFormAcknowledgements = () =>
  jsonFetch<{ patientLinked: boolean; forms: FormAckEntry[] }>(
    "/shop/me/form-acknowledgements",
  );

export const signFormAcknowledgement = (formKind: string) =>
  jsonFetch<{ id: string | null; created: boolean }>(
    "/shop/me/form-acknowledgements",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ formKind }),
    },
  );

// ---- Referrals ----

export type ReferralEntry = {
  id: string;
  code: string;
  refereeEmail: string | null;
  refereeName: string | null;
  status: string;
  convertedAt: string | null;
  createdAt: string;
};

export const listMyReferrals = () =>
  jsonFetch<{
    patientLinked: boolean;
    stats: { total: number; converted: number; pending: number } | null;
    referrals: ReferralEntry[];
  }>("/shop/me/referrals");

export const mintReferral = (body: {
  refereeEmail?: string | null;
  refereeName?: string | null;
}) =>
  jsonFetch<{ id: string; code: string }>("/shop/me/referrals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

// ---- Appointment request ----

export const submitAppointmentRequest = (body: {
  topic: string;
  preferredWindow?: string | null;
  notes?: string | null;
  phone?: string | null;
}) =>
  jsonFetch<{ id: string }>("/shop/me/appointment-request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

// ---- Lost-shipment report ----

export const reportLostShipment = (orderId: string, note: string) =>
  jsonFetch<{ id: string }>(
    `/shop/me/orders/${encodeURIComponent(orderId)}/loss-claim`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    },
  );
