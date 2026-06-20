// Typed fetch wrappers for a tenant's own voice + SMS numbers
// (/admin/organization/phone-settings).
//
// A DME tenant gets its OWN voice + SMS numbers so inbound calls/texts
// route to them and outbound send from their DID. Numbers are
// auto-provisioned through Twilio or set manually for a ported /
// pre-existing number. Backed by organizations.voice_from_number /
// sms_from_number / twilio_messaging_service_sid (migration 0364).

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

const BASE = "/resupply-api";

export interface PhoneSettings {
  /** The tenant's voice caller-ID (E.164), or null. */
  voiceNumber: string | null;
  /** The tenant's SMS from-number (E.164), or null. */
  smsNumber: string | null;
  /** The tenant's Twilio Messaging Service SID (MG…), or null. */
  messagingServiceSid: string | null;
  /** Whether the platform can auto-buy a number (Twilio creds present). */
  canProvision: boolean;
}

export type PhoneSlot = "voice" | "sms";

async function getJSON<T>(path: string): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    credentials: "same-origin",
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
  return (await res.json()) as T;
}

async function sendJSON<T>(
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method, url });
  }
  return (await res.json()) as T;
}

export const fetchPhoneSettings = () =>
  getJSON<PhoneSettings>("/admin/organization/phone-settings");

/**
 * Auto-buy a voice+SMS-capable number from Twilio and assign it to the
 * given slots (defaults to both). Optional area code keeps it local.
 */
export const provisionPhoneNumber = (input: {
  areaCode?: string;
  assign?: PhoneSlot[];
}) =>
  sendJSON<PhoneSettings & { provisioned: string }>(
    "POST",
    "/admin/organization/phone-settings/provision",
    {
      ...(input.areaCode ? { areaCode: input.areaCode } : {}),
      ...(input.assign && input.assign.length ? { assign: input.assign } : {}),
    },
  );

/**
 * Manually set/clear any of the tenant's numbers. Only the keys you pass
 * change; `null` clears that field back to the platform default.
 */
export const updatePhoneSettings = (patch: {
  voiceNumber?: string | null;
  smsNumber?: string | null;
  messagingServiceSid?: string | null;
}) =>
  sendJSON<PhoneSettings>("PATCH", "/admin/organization/phone-settings", patch);
