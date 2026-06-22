// Fetch wrappers for RT #21 — structured non-adherence interventions.
// Interventions are clinical_encounters of type 'adherence_intervention';
// read on clinical.read, write on clinical.intervention.write.

import { adminJsonFetch as jsonFetch } from "../admin-json-fetch";

export const ASSESSMENT_CATEGORIES = [
  "mask_leak",
  "claustrophobia",
  "pressure_intolerance",
  "motivation",
  "congestion",
  "mask_discomfort",
  "mouth_breathing",
  "travel_disruption",
  "other",
] as const;
export type AssessmentCategory = (typeof ASSESSMENT_CATEGORIES)[number];

export const ASSESSMENT_LABEL: Record<AssessmentCategory, string> = {
  mask_leak: "Mask leak",
  claustrophobia: "Claustrophobia",
  pressure_intolerance: "Pressure intolerance",
  motivation: "Motivation / habit",
  congestion: "Congestion",
  mask_discomfort: "Mask discomfort",
  mouth_breathing: "Mouth breathing",
  travel_disruption: "Travel disruption",
  other: "Other",
};

export const OUTCOME_STATUSES = [
  "pending",
  "improved",
  "no_change",
  "worsened",
  "unknown",
] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

export const OUTCOME_LABEL: Record<OutcomeStatus, string> = {
  pending: "Pending",
  improved: "Improved",
  no_change: "No change",
  worsened: "Worsened",
  unknown: "Unknown",
};

export interface InterventionItem {
  id: string;
  patientId: string;
  assessmentCategory: AssessmentCategory | null;
  outcomeStatus: OutcomeStatus;
  reason: string | null;
  plan: string | null;
  followUpAt: string | null;
  authorEmail: string | null;
  createdAt: string;
  open: boolean;
}

export interface InterventionWorklist {
  interventions: InterventionItem[];
  count: number;
  openCount: number;
}

export function getInterventionWorklist(
  windowDays = 120,
): Promise<InterventionWorklist> {
  return jsonFetch(`/admin/clinical/interventions?windowDays=${windowDays}`);
}

export function createIntervention(
  patientId: string,
  body: {
    assessmentCategory: AssessmentCategory;
    reason?: string;
    plan?: string;
    followUpAt?: string;
    linkedAlertId?: string;
  },
): Promise<{ id: string; outcomeStatus: string }> {
  return jsonFetch(
    `/admin/patients/${encodeURIComponent(patientId)}/interventions`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function setInterventionOutcome(
  id: string,
  outcomeStatus: OutcomeStatus,
): Promise<{ id: string; outcomeStatus: string }> {
  return jsonFetch(`/admin/interventions/${encodeURIComponent(id)}/outcome`, {
    method: "PATCH",
    body: JSON.stringify({ outcomeStatus }),
  });
}
