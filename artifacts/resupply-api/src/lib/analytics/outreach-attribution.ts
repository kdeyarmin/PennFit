// Pure aggregation for outreach -> order attribution (roadmap Lever 3,
// the closed-loop half). Mirrors the read-then-aggregate shape of the
// other analytics aggregators: the route does window-bounded DB reads,
// this module reduces them, so the correlation math is unit-testable
// without Postgres.
//
// Question answered: "Of the patients we proactively contacted in the
// window, how many placed a resupply order (fulfillment) within N days
// of that contact?" — split by outreach channel so you can see which
// outreach actually converts.
//
// Model
// -----
//   * A patient is "contacted" by a source if there's >= 1 outreach event
//     for them in the window. We attribute against their EARLIEST contact
//     (first-touch).
//   * A contacted patient "converted" if they have >= 1 fulfillment whose
//     timestamp is on/after that earliest contact and within
//     attributionWindowDays of it.
//   * conversionRate = converted / contacted (null when contacted = 0).
//
// Sources: resupply reminders (episode-linked conversations) and clinical
// outreach (clinical_outreach_log). `overall` de-dupes across both,
// taking each patient's earliest contact from either source. Cash-pay
// storefront orders carry no patient_id, so they can't be patient-
// attributed here — this measures the insurance/resupply outreach loop.

const DAY_MS = 86_400_000;

export interface OutreachContact {
  patientId: string;
  /** ISO-8601 timestamp of the outreach event. */
  at: string;
}

export interface FulfillmentEvent {
  patientId: string;
  /** ISO-8601 timestamp the fulfillment was created. */
  at: string;
}

export type AttributionSource =
  | "resupply_reminder"
  | "clinical_outreach"
  | "overall";

export interface AttributionBucket {
  source: AttributionSource;
  label: string;
  contactedPatients: number;
  convertedPatients: number;
  /** 0..1, or null when no patients were contacted. */
  conversionRate: number | null;
}

export interface OutreachAttributionInput {
  reminderContacts: readonly OutreachContact[];
  clinicalContacts: readonly OutreachContact[];
  fulfillments: readonly FulfillmentEvent[];
  attributionWindowDays: number;
}

export interface OutreachAttributionResult {
  attributionWindowDays: number;
  bySource: AttributionBucket[];
  overall: AttributionBucket;
}

function earliestContactByPatient(
  contacts: readonly OutreachContact[],
): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of contacts) {
    const t = Date.parse(c.at);
    if (Number.isNaN(t)) continue;
    const prev = m.get(c.patientId);
    if (prev === undefined || t < prev) m.set(c.patientId, t);
  }
  return m;
}

function fulfillmentTimesByPatient(
  fulfillments: readonly FulfillmentEvent[],
): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const f of fulfillments) {
    const t = Date.parse(f.at);
    if (Number.isNaN(t)) continue;
    const arr = m.get(f.patientId);
    if (arr) arr.push(t);
    else m.set(f.patientId, [t]);
  }
  return m;
}

function countConverted(
  contactByPatient: Map<string, number>,
  fulfillmentsByPatient: Map<string, number[]>,
  windowMs: number,
): number {
  let converted = 0;
  for (const [patientId, contactT] of contactByPatient) {
    const times = fulfillmentsByPatient.get(patientId);
    if (!times) continue;
    if (times.some((t) => t >= contactT && t <= contactT + windowMs)) {
      converted += 1;
    }
  }
  return converted;
}

function makeBucket(
  source: AttributionSource,
  label: string,
  contactByPatient: Map<string, number>,
  fulfillmentsByPatient: Map<string, number[]>,
  windowMs: number,
): AttributionBucket {
  const contacted = contactByPatient.size;
  const converted = countConverted(
    contactByPatient,
    fulfillmentsByPatient,
    windowMs,
  );
  return {
    source,
    label,
    contactedPatients: contacted,
    convertedPatients: converted,
    conversionRate: contacted === 0 ? null : converted / contacted,
  };
}

export function aggregateOutreachAttribution(
  input: OutreachAttributionInput,
): OutreachAttributionResult {
  const windowMs = Math.max(0, input.attributionWindowDays) * DAY_MS;
  const fulfillmentsByPatient = fulfillmentTimesByPatient(input.fulfillments);

  const reminderContacts = earliestContactByPatient(input.reminderContacts);
  const clinicalContacts = earliestContactByPatient(input.clinicalContacts);

  // overall — earliest contact across BOTH sources per patient.
  const overallContacts = new Map<string, number>(reminderContacts);
  for (const [patientId, t] of clinicalContacts) {
    const prev = overallContacts.get(patientId);
    if (prev === undefined || t < prev) overallContacts.set(patientId, t);
  }

  return {
    attributionWindowDays: input.attributionWindowDays,
    bySource: [
      makeBucket(
        "resupply_reminder",
        "Resupply reminders",
        reminderContacts,
        fulfillmentsByPatient,
        windowMs,
      ),
      makeBucket(
        "clinical_outreach",
        "Clinical outreach",
        clinicalContacts,
        fulfillmentsByPatient,
        windowMs,
      ),
    ],
    overall: makeBucket(
      "overall",
      "All outreach (de-duped)",
      overallContacts,
      fulfillmentsByPatient,
      windowMs,
    ),
  };
}
