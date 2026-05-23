// Hand-rolled fetch wrappers for the patient onboarding endpoints
// shipped in Phase B.1. Used by the patient-detail page's
// "Onboarding" tab to enroll, pause/resume, and read journey
// state.

import { csrfHeader } from "../csrf";

export type PatientOnboardingStatus = "active" | "completed" | "paused";

export interface PatientOnboardingJourney {
  id: string;
  startedAt: string;
  day1SentAt: string | null;
  day3SentAt: string | null;
  day7SentAt: string | null;
  day30SentAt: string | null;
  day60SentAt: string | null;
  day90SentAt: string | null;
  status: PatientOnboardingStatus;
  enrolledByEmail: string;
  createdAt: string;
}

export interface OnboardingAttempt {
  id: string;
  dayLabel: string;
  channel: "email" | "sms" | "voice";
  outcome:
    | "sent"
    | "skipped_no_contact"
    | "skipped_not_configured"
    | "vendor_error";
  vendorRef: string | null;
  errorCode: string | null;
  attemptedAt: string;
}

export async function fetchPatientOnboardingAttempts(
  patientId: string,
): Promise<{ attempts: OnboardingAttempt[] }> {
  const res = await fetch(
    `/resupply-api/admin/patients/${encodeURIComponent(patientId)}/onboarding/attempts`,
    { headers: { Accept: "application/json" }, credentials: "include" },
  );
  if (!res.ok) {
    throw new Error(`Failed to load attempts (${res.status})`);
  }
  return (await res.json()) as { attempts: OnboardingAttempt[] };
}

export async function fetchPatientOnboarding(
  patientId: string,
): Promise<{ journey: PatientOnboardingJourney | null }> {
  const res = await fetch(
    `/resupply-api/admin/patients/${encodeURIComponent(patientId)}/onboarding`,
    { headers: { Accept: "application/json" }, credentials: "include" },
  );
  if (!res.ok) {
    throw new Error(`Failed to load onboarding (${res.status})`);
  }
  return (await res.json()) as { journey: PatientOnboardingJourney | null };
}

export async function enrollPatientOnboarding(
  patientId: string,
  startedAt?: string,
): Promise<{ id: string; startedAt: string }> {
  const res = await fetch(
    `/resupply-api/admin/patients/${encodeURIComponent(patientId)}/onboarding/enroll`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...csrfHeader() },
      body: JSON.stringify(startedAt ? { startedAt } : {}),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to enroll (${res.status}): ${text}`);
  }
  return (await res.json()) as { id: string; startedAt: string };
}

export async function setPatientOnboardingStatus(
  patientId: string,
  status: "active" | "paused",
): Promise<void> {
  const res = await fetch(
    `/resupply-api/admin/patients/${encodeURIComponent(patientId)}/onboarding/status`,
    {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...csrfHeader() },
      body: JSON.stringify({ status }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to update status (${res.status}): ${text}`);
  }
}
