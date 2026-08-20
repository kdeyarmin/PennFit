// Demo fixtures for the tenant admin REFERRAL surfaces:
//
//   /admin/referrals          /admin/provider-referrals*   (provider portal inbox)
//   /admin/referral-reviews   /admin/referral-reviews*     (AI fax/upload triage)
//
// Both pages previously had NO demo coverage — every call fell through to
// the empty fallback, so the inbox and the triage queue rendered empty and
// none of their actions worked. Shapes mirror
// `src/lib/admin/referrals-api.ts` and `src/lib/admin/referral-reviews-api.ts`.
//
// Writes go through the session-scoped store, so accepting or declining a
// referral moves it between the inbox tabs, replying appends to the thread,
// and dismissing a review clears it from the triage queue.
//
// All patients, providers and clinics here are invented. The extraction
// payloads mirror what the model returns from a real referral packet
// (demographics, insurance, sleep study, order) so the triage UI —
// including its confidence badges and the PAP-qualification verdict — has
// something real-shaped to render.

import { daysAgo, hoursAgo, minutesAgo, NOW_ISO } from "./dates";

const DEMO_STAFF = "demo.admin@caremetric.example";

// ── Types (mirrors of the two client API modules) ───────────────────

type ReferralStatus =
  | "submitted"
  | "accepted"
  | "in_progress"
  | "dispensed"
  | "declined"
  | "cancelled";

interface DemoReferralMessage {
  id: string;
  authorKind: "provider" | "staff";
  authorEmail: string | null;
  body: string;
  createdAt: string;
}

interface DemoReferral {
  id: string;
  status: ReferralStatus;
  patientName: string;
  patientDob: string | null;
  entryPoint: "remote_link" | "in_office" | "kiosk_qr" | "refit_campaign";
  therapyMode: "pap" | "niv";
  fitSessionId: string | null;
  approvedMaskModelId: string | null;
  unreadForDme: number;
  submittedAt: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  declinedReason: string | null;
  dispensedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Detail-only fields.
  patient: {
    firstName: string;
    lastName: string;
    dob: string | null;
    email: string | null;
    phone: string | null;
    sex: string | null;
    address: unknown;
    chartId: string | null;
  };
  insurance: {
    payerName: string | null;
    memberId: string | null;
    groupNumber: string | null;
  };
  clinical: {
    therapyMode: "pap" | "niv";
    prescribedPressureCmH2O: number | null;
    diagnosisCode: string | null;
    notes: string | null;
  };
  approval: {
    maskModelId: string | null;
    variantId: string | null;
    isOverride: boolean;
    note: string | null;
    approvedAt: string | null;
    maskName: string | null;
    interfaceType: string | null;
    sizeLabel: string | null;
  };
  signature: { requestId: string | null; signedAt: string | null };
  createdByEmail: string | null;
  acceptedByEmail: string | null;
  events: Array<{
    eventType: string;
    actorKind: string;
    actorEmail: string | null;
    occurredAt: string;
  }>;
  messages: DemoReferralMessage[];
  documents: Array<{
    id: string;
    docType: string;
    fileName: string;
    sizeBytes: number;
    uploadedByKind: "provider" | "staff";
    createdAt: string;
  }>;
}

interface DemoProviderLink {
  id: string;
  providerId: string;
  status: "active" | "suspended" | "revoked";
  displayName: string | null;
  defaultLocationId: string | null;
  invitedByEmail: string | null;
  invitedAt: string;
  revokedAt: string | null;
  notes: string | null;
}

type ReferralReviewStatus =
  | "pending"
  | "extracted"
  | "accepted"
  | "dismissed"
  | "failed"
  | "offline"
  | "unsupported";

type ConfidenceLevel = "high" | "medium" | "low";

interface DemoReferralReview {
  id: string;
  source: "fax" | "upload";
  inboundFaxId: string | null;
  hasMedia: boolean;
  mediaContentType: string | null;
  mediaSizeBytes: number | null;
  status: ReferralReviewStatus;
  extraction: Record<string, unknown> | null;
  extractionModel: string | null;
  extractedAt: string | null;
  errorReason: string | null;
  createdPatientId: string | null;
  acceptedAt: string | null;
  dismissedAt: string | null;
  dismissNote: string | null;
  createdAt: string;
  updatedAt: string;
  report: Record<string, unknown> | null;
  faxFromE164: string | null;
}

// ── Provider referrals seed ─────────────────────────────────────────

function referral(
  n: number,
  first: string,
  last: string,
  status: ReferralStatus,
  opts: Partial<DemoReferral> = {},
): DemoReferral {
  const created = hoursAgo(6 + n * 14);
  const dob = `19${60 + n}-0${(n % 9) + 1}-1${n % 9}`;
  return {
    id: `demo-referral-${n}`,
    status,
    patientName: `${first} ${last}`,
    patientDob: dob,
    entryPoint: n % 3 === 0 ? "in_office" : "remote_link",
    therapyMode: "pap",
    fitSessionId: `demo-fit-${(n % 8) + 1}`,
    approvedMaskModelId: null,
    unreadForDme: status === "submitted" ? 1 : 0,
    submittedAt: created,
    acceptedAt:
      status === "submitted" || status === "declined" ? null : created,
    declinedAt: status === "declined" ? hoursAgo(4 + n * 10) : null,
    declinedReason: status === "declined" ? "Out of our service area." : null,
    dispensedAt: status === "dispensed" ? hoursAgo(2 + n * 8) : null,
    createdAt: created,
    updatedAt: created,
    patient: {
      firstName: first,
      lastName: last,
      dob,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
      phone: `+1215555${String(2000 + n).slice(-4)}`,
      sex: n % 2 === 0 ? "F" : "M",
      address: {
        line1: `${100 + n * 7} Chestnut St`,
        city: "Philadelphia",
        state: "PA",
        postalCode: "19106",
      },
      chartId: null,
    },
    insurance: {
      payerName: n % 2 === 0 ? "Independence Blue Cross" : "Aetna",
      memberId: `W${100000000 + n * 137}`,
      groupNumber: `GRP${4000 + n}`,
    },
    clinical: {
      therapyMode: "pap",
      prescribedPressureCmH2O: 8 + (n % 5),
      diagnosisCode: "G47.33",
      notes: "Moderate OSA. Auto-titrating PAP ordered.",
    },
    approval: {
      maskModelId: null,
      variantId: null,
      isOverride: false,
      note: null,
      approvedAt: null,
      maskName: null,
      interfaceType: null,
      sizeLabel: null,
    },
    signature: { requestId: null, signedAt: null },
    createdByEmail: `dr.${last.toLowerCase()}@sleepclinic.example`,
    acceptedByEmail:
      status === "submitted" || status === "declined" ? null : DEMO_STAFF,
    events: [
      {
        eventType: "referral.submitted",
        actorKind: "provider",
        actorEmail: `dr.${last.toLowerCase()}@sleepclinic.example`,
        occurredAt: created,
      },
      ...(status !== "submitted" && status !== "declined"
        ? [
            {
              eventType: "referral.accepted",
              actorKind: "staff",
              actorEmail: DEMO_STAFF,
              occurredAt: created,
            },
          ]
        : []),
      ...(status === "declined"
        ? [
            {
              eventType: "referral.declined",
              actorKind: "staff",
              actorEmail: DEMO_STAFF,
              occurredAt: hoursAgo(4 + n * 10),
            },
          ]
        : []),
      ...(status === "dispensed"
        ? [
            {
              eventType: "referral.dispensed",
              actorKind: "staff",
              actorEmail: DEMO_STAFF,
              occurredAt: hoursAgo(2 + n * 8),
            },
          ]
        : []),
    ],
    messages:
      n === 1
        ? [
            {
              id: "demo-referral-1-m1",
              authorKind: "provider",
              authorEmail: "dr.okonkwo@sleepclinic.example",
              body: "Patient is travelling from the 14th — if a fitting can happen before then it would help.",
              createdAt: hoursAgo(5),
            },
          ]
        : [],
    documents: [
      {
        id: `demo-referral-${n}-d1`,
        docType: "sleep_study",
        fileName: `${last.toLowerCase()}-psg-report.pdf`,
        sizeBytes: 428_100,
        uploadedByKind: "provider",
        createdAt: created,
      },
      {
        id: `demo-referral-${n}-d2`,
        docType: "physician_order",
        fileName: `${last.toLowerCase()}-order.pdf`,
        sizeBytes: 96_400,
        uploadedByKind: "provider",
        createdAt: created,
      },
    ],
    ...opts,
  };
}

function seedReferrals(): DemoReferral[] {
  return [
    referral(1, "Amara", "Okonkwo", "submitted"),
    referral(2, "Louis", "Bertrand", "submitted"),
    referral(3, "Sofia", "Marchetti", "accepted"),
    referral(4, "Henry", "Castellanos", "in_progress"),
    referral(5, "Nadia", "Haddad", "dispensed"),
    referral(6, "Tom", "Whitlock", "declined"),
  ];
}

function seedProviders(): DemoProviderLink[] {
  return [
    {
      id: "demo-provider-link-1",
      providerId: "demo-provider-1",
      status: "active",
      displayName: "Dr. Chidi Okonkwo — Riverside Sleep Clinic",
      defaultLocationId: null,
      invitedByEmail: DEMO_STAFF,
      invitedAt: daysAgo(210),
      revokedAt: null,
      notes: "High volume; sends complete packets.",
    },
    {
      id: "demo-provider-link-2",
      providerId: "demo-provider-2",
      status: "active",
      displayName: "Dr. Helena Marchetti — Center City Pulmonology",
      defaultLocationId: null,
      invitedByEmail: DEMO_STAFF,
      invitedAt: daysAgo(96),
      revokedAt: null,
      notes: null,
    },
    {
      id: "demo-provider-link-3",
      providerId: "demo-provider-3",
      status: "suspended",
      displayName: "Dr. Peter Vance — Northeast Family Medicine",
      defaultLocationId: null,
      invitedByEmail: DEMO_STAFF,
      invitedAt: daysAgo(310),
      revokedAt: null,
      notes: "Suspended pending an updated NPI on file.",
    },
  ];
}

// ── Referral reviews (AI triage) seed ───────────────────────────────

function extraction(
  first: string,
  last: string,
  opts: {
    ahi?: number;
    payer?: string;
    missingInsurance?: boolean;
    confidence?: Partial<
      Record<"patient" | "insurance" | "order" | "sleepStudy", ConfidenceLevel>
    >;
  } = {},
) {
  const ahi = opts.ahi ?? 22.4;
  return {
    patient: {
      firstName: first,
      lastName: last,
      dob: "1968-04-12",
      phone: "+12155551844",
      email: null,
      address: {
        line1: "88 Spruce St",
        line2: "Apt 3B",
        city: "Philadelphia",
        state: "PA",
        postalCode: "19107",
      },
    },
    insurance: opts.missingInsurance
      ? null
      : {
          payerName: opts.payer ?? "Independence Blue Cross",
          planName: "Keystone HMO",
          memberId: "W284419307",
          groupNumber: "GRP7742",
          policyholderName: `${first} ${last}`,
          policyholderRelationship: "self",
        },
    secondaryInsurance: null,
    order: [
      { description: "Auto-titrating PAP device", hcpcs: "E0601" },
      { description: "Full face mask with headgear", hcpcs: "A7030" },
      { description: "Heated humidifier", hcpcs: "E0562" },
    ],
    diagnoses: [
      {
        icd10: "G47.33",
        description: "Obstructive sleep apnea (adult) (pediatric)",
      },
    ],
    recommendedTherapy: "APAP 5–15 cmH2O with heated humidification",
    comorbidities: ahi < 15 ? ["Hypertension"] : [],
    sleepStudy: {
      studyDate: daysAgo(38).slice(0, 10),
      studyType: "In-lab polysomnography",
      ahi,
      rdi: ahi + 2.1,
      odi: ahi - 3.4,
      totalSleepMinutes: 372,
      interpretingPhysician: "Dr. Helena Marchetti",
    },
    physician: {
      name: "Dr. Helena Marchetti",
      npi: "1487654321",
      phone: "+12155559900",
      fax: "+12155559901",
      clinic: "Center City Pulmonology",
    },
    documents: [
      {
        type: "sleep_study" as const,
        pageStart: 1,
        pageEnd: 4,
        title: "Polysomnography report",
      },
      {
        type: "physician_order" as const,
        pageStart: 5,
        pageEnd: 5,
        title: "Signed DME order",
      },
      {
        type: "demographics" as const,
        pageStart: 6,
        pageEnd: 6,
        title: "Patient face sheet",
      },
      ...(opts.missingInsurance
        ? []
        : [
            {
              type: "insurance_card" as const,
              pageStart: 7,
              pageEnd: 7,
              title: "Insurance card (front/back)",
            },
          ]),
    ],
    summary: `${first} ${last}, AHI ${ahi}. In-lab PSG with a signed order for APAP plus a full-face interface.`,
    confidence: {
      patient: opts.confidence?.patient ?? ("high" as ConfidenceLevel),
      insurance:
        opts.confidence?.insurance ??
        (opts.missingInsurance
          ? ("low" as ConfidenceLevel)
          : ("high" as ConfidenceLevel)),
      order: opts.confidence?.order ?? ("high" as ConfidenceLevel),
      sleepStudy: opts.confidence?.sleepStudy ?? ("high" as ConfidenceLevel),
    },
  };
}

function report(ahi: number, missingInsurance: boolean) {
  const qualifies = ahi >= 15;
  const comorbid = !qualifies && ahi >= 5;
  return {
    qualification: {
      verdict: qualifies
        ? ("qualifies" as const)
        : comorbid
          ? ("qualifies_with_comorbidity" as const)
          : ("not_qualifying" as const),
      qualifyingValue: ahi,
      metric: "AHI" as const,
      hasDocumentedComorbidity: comorbid,
      summary: qualifies
        ? `AHI ${ahi} meets the ≥15 threshold on its own.`
        : comorbid
          ? `AHI ${ahi} is between 5 and 14, so coverage depends on a documented comorbidity — hypertension is present in the packet.`
          : `AHI ${ahi} is below the coverage threshold.`,
      details: [
        `Study date ${daysAgo(38).slice(0, 10)} — in-lab polysomnography.`,
        qualifies
          ? "No comorbidity documentation required."
          : "Comorbidity documentation required; check the chart note on page 6.",
      ],
    },
    completeness: {
      items: [
        {
          key: "sleep_study",
          label: "Sleep study",
          status: "present" as const,
          detail: "In-lab PSG, 4 pages.",
        },
        {
          key: "physician_order",
          label: "Signed physician order",
          status: "present" as const,
          detail: "Signed and dated.",
        },
        {
          key: "demographics",
          label: "Patient demographics",
          status: "present" as const,
          detail: "Face sheet included.",
        },
        missingInsurance
          ? {
              key: "insurance",
              label: "Insurance",
              status: "missing" as const,
              detail: "No insurance card or payer details in the packet.",
              request:
                "Please fax the patient's insurance card (front and back).",
            }
          : {
              key: "insurance",
              label: "Insurance",
              status: "present" as const,
              detail: "Card captured; member id read cleanly.",
            },
        {
          key: "face_to_face",
          label: "Face-to-face note",
          status: "attention" as const,
          detail: "A chart note is present but the visit date is not legible.",
          request:
            "Please send the face-to-face encounter note with a legible visit date.",
        },
      ],
      outstandingCount: missingInsurance ? 2 : 1,
      complete: false,
      providerRequests: [
        ...(missingInsurance
          ? ["Please fax the patient's insurance card (front and back)."]
          : []),
        "Please send the face-to-face encounter note with a legible visit date.",
      ],
    },
  };
}

function seedReviews(): DemoReferralReview[] {
  const rows: Array<{
    n: number;
    first: string;
    last: string;
    status: ReferralReviewStatus;
    source: "fax" | "upload";
    ahi: number;
    missingInsurance?: boolean;
  }> = [
    {
      n: 1,
      first: "Gloria",
      last: "Fennimore",
      status: "extracted",
      source: "fax",
      ahi: 22.4,
    },
    {
      n: 2,
      first: "Marcus",
      last: "Delgado",
      status: "extracted",
      source: "fax",
      ahi: 9.6,
      missingInsurance: true,
    },
    {
      n: 3,
      first: "Ines",
      last: "Kovac",
      status: "extracted",
      source: "upload",
      ahi: 41.2,
    },
    {
      n: 4,
      first: "Ray",
      last: "Sundberg",
      status: "pending",
      source: "fax",
      ahi: 0,
    },
    {
      n: 5,
      first: "Beatrice",
      last: "Lam",
      status: "accepted",
      source: "upload",
      ahi: 18.9,
    },
    {
      n: 6,
      first: "Unknown",
      last: "Sender",
      status: "failed",
      source: "fax",
      ahi: 0,
    },
  ];

  return rows.map((r) => {
    const extracted = r.status === "extracted" || r.status === "accepted";
    return {
      id: `demo-review-${r.n}`,
      source: r.source,
      inboundFaxId: r.source === "fax" ? `demo-fax-${r.n}` : null,
      hasMedia: true,
      mediaContentType:
        r.source === "fax" ? "application/pdf" : "application/pdf",
      mediaSizeBytes: 512_000 + r.n * 40_000,
      status: r.status,
      extraction: extracted
        ? extraction(r.first, r.last, {
            ahi: r.ahi,
            missingInsurance: r.missingInsurance,
          })
        : null,
      extractionModel: extracted ? "claude-sonnet-4-6" : null,
      extractedAt: extracted ? minutesAgo(20 + r.n * 45) : null,
      errorReason:
        r.status === "failed"
          ? "The fax was received but no readable text could be extracted — it looks like a blank or heavily skewed scan."
          : null,
      createdPatientId: r.status === "accepted" ? `demo-patient-${r.n}` : null,
      acceptedAt: r.status === "accepted" ? minutesAgo(12) : null,
      dismissedAt: null,
      dismissNote: null,
      createdAt: hoursAgo(2 + r.n * 7),
      updatedAt: minutesAgo(15 + r.n * 30),
      report: extracted ? report(r.ahi, Boolean(r.missingInsurance)) : null,
      faxFromE164:
        r.source === "fax" ? `+1215555${String(7100 + r.n).slice(-4)}` : null,
    };
  });
}

// ── Session-scoped mutable store ────────────────────────────────────

interface ReferralState {
  referrals: DemoReferral[];
  providers: DemoProviderLink[];
  reviews: DemoReferralReview[];
}

let state: ReferralState | null = null;

function get(): ReferralState {
  if (!state) {
    state = {
      referrals: seedReferrals(),
      providers: seedProviders(),
      reviews: seedReviews(),
    };
  }
  return state;
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

// ── Provider referrals ──────────────────────────────────────────────

const OPEN_STATUSES = new Set<ReferralStatus>([
  "submitted",
  "accepted",
  "in_progress",
]);

function referralSummary(r: DemoReferral) {
  return {
    id: r.id,
    status: r.status,
    patientName: r.patientName,
    patientDob: r.patientDob,
    entryPoint: r.entryPoint,
    therapyMode: r.therapyMode,
    fitSessionId: r.fitSessionId,
    approvedMaskModelId: r.approvedMaskModelId,
    unreadForDme: r.unreadForDme,
    submittedAt: r.submittedAt,
    acceptedAt: r.acceptedAt,
    declinedAt: r.declinedAt,
    declinedReason: r.declinedReason,
    dispensedAt: r.dispensedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** GET /admin/provider-referrals */
export function demoInboundReferrals(query: URLSearchParams) {
  const s = get();
  const status = query.get("status") as ReferralStatus | null;
  const open = query.get("open") === "true";
  const limit = Number(query.get("limit")) || 50;
  const offset = Number(query.get("offset")) || 0;

  let referrals = s.referrals;
  if (status) referrals = referrals.filter((r) => r.status === status);
  else if (open)
    referrals = referrals.filter((r) => OPEN_STATUSES.has(r.status));

  return {
    referrals: [...referrals]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(offset, offset + limit)
      .map(referralSummary),
    limit,
    offset,
  };
}

/** GET /admin/provider-referrals/:id */
export function demoInboundReferral(id: string) {
  const r = get().referrals.find((x) => x.id === id);
  if (!r) return null;
  // Opening the detail clears the unread badge, like the real route.
  r.unreadForDme = 0;
  return r;
}

/** POST /admin/provider-referrals/:id/accept */
export function demoAcceptReferral(id: string) {
  const r = get().referrals.find((x) => x.id === id);
  if (!r) return null;
  r.status = "accepted";
  r.acceptedAt = NOW_ISO();
  r.acceptedByEmail = DEMO_STAFF;
  r.updatedAt = NOW_ISO();
  r.events.push({
    eventType: "referral.accepted",
    actorKind: "staff",
    actorEmail: DEMO_STAFF,
    occurredAt: NOW_ISO(),
  });
  return { ok: true as const, status: r.status };
}

/** POST /admin/provider-referrals/:id/decline */
export function demoDeclineReferral(id: string, reason: string) {
  const r = get().referrals.find((x) => x.id === id);
  if (!r) return null;
  r.status = "declined";
  r.declinedAt = NOW_ISO();
  r.declinedReason = reason;
  r.updatedAt = NOW_ISO();
  r.events.push({
    eventType: "referral.declined",
    actorKind: "staff",
    actorEmail: DEMO_STAFF,
    occurredAt: NOW_ISO(),
  });
  return { ok: true as const, status: r.status };
}

/** POST /admin/provider-referrals/:id/status */
export function demoSetReferralStatus(id: string, status: string) {
  const r = get().referrals.find((x) => x.id === id);
  if (!r) return null;
  r.status = status as ReferralStatus;
  r.updatedAt = NOW_ISO();
  if (status === "dispensed") r.dispensedAt = NOW_ISO();
  r.events.push({
    eventType: `referral.${status}`,
    actorKind: "staff",
    actorEmail: DEMO_STAFF,
    occurredAt: NOW_ISO(),
  });
  return { ok: true as const, status: r.status };
}

/** POST /admin/provider-referrals/:id/messages */
export function demoReplyToReferral(id: string, body: string) {
  const r = get().referrals.find((x) => x.id === id);
  if (!r) return null;
  r.messages.push({
    id: newId("demo-referral-msg"),
    authorKind: "staff",
    authorEmail: DEMO_STAFF,
    body,
    createdAt: NOW_ISO(),
  });
  r.updatedAt = NOW_ISO();
  return { ok: true as const };
}

/** GET /admin/provider-referrals/providers */
export function demoProviderLinks() {
  return { providers: get().providers };
}

/** POST /admin/provider-referrals/providers */
export function demoInviteProvider(
  body:
    | { email?: string; displayName?: string | null; notes?: string | null }
    | undefined,
) {
  const s = get();
  const link: DemoProviderLink = {
    id: newId("demo-provider-link"),
    providerId: newId("demo-provider"),
    status: "active",
    displayName: body?.displayName ?? body?.email ?? "New provider",
    defaultLocationId: null,
    invitedByEmail: DEMO_STAFF,
    invitedAt: NOW_ISO(),
    revokedAt: null,
    notes: body?.notes ?? null,
  };
  s.providers.push(link);
  return { provider: link };
}

/** PATCH /admin/provider-referrals/providers/:id */
export function demoUpdateProviderLink(
  id: string,
  patch: Record<string, unknown> | undefined,
) {
  const link = get().providers.find((p) => p.id === id);
  if (!link) return null;
  Object.assign(link, patch);
  if (patch?.status === "revoked") link.revokedAt = NOW_ISO();
  return { provider: link };
}

// ── Referral reviews (AI triage) ────────────────────────────────────

/** GET /admin/referral-reviews */
export function demoReferralReviews(query: URLSearchParams) {
  const s = get();
  const status = query.get("status");
  const limit = Number(query.get("limit")) || 50;
  const offset = Number(query.get("offset")) || 0;
  let reviews = s.reviews;
  if (status) reviews = reviews.filter((r) => r.status === status);
  return {
    reviews: [...reviews]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(offset, offset + limit),
    limit,
    offset,
  };
}

/** GET /admin/referral-reviews/:id */
export function demoReferralReview(id: string) {
  const r = get().reviews.find((x) => x.id === id);
  return r ? { review: r } : null;
}

/** GET /admin/referral-reviews/:id/duplicates */
export function demoReferralDuplicates(id: string) {
  const r = get().reviews.find((x) => x.id === id);
  // Only the first demo review looks like an existing patient — enough to
  // exercise the "merge or create" branch without making every accept
  // hit it.
  if (!r || r.id !== "demo-review-1") return { candidates: [] };
  return {
    candidates: [
      {
        id: "demo-patient-9",
        legalFirstName: "Gloria",
        legalLastName: "Fennimore",
        dateOfBirth: "1968-04-12",
        email: null,
        phoneE164: "+12155551844",
        matchedOn: "dob_name" as const,
      },
    ],
  };
}

/** GET /admin/referral-reviews/:id/report */
export function demoReferralReviewReport(id: string) {
  const r = get().reviews.find((x) => x.id === id);
  if (!r?.report) return null;
  return r.report;
}

/** POST /admin/referral-reviews/:id/extract — re-run the extraction. */
export function demoExtractReferralReview(id: string) {
  const r = get().reviews.find((x) => x.id === id);
  if (!r) return null;
  const name =
    (r.extraction?.patient as
      | { firstName?: string; lastName?: string }
      | undefined) ?? {};
  r.status = "extracted";
  r.extraction =
    r.extraction ??
    extraction(name.firstName ?? "New", name.lastName ?? "Patient");
  r.report = r.report ?? report(22.4, false);
  r.extractionModel = "claude-sonnet-4-6";
  r.extractedAt = NOW_ISO();
  r.errorReason = null;
  r.updatedAt = NOW_ISO();
  return { review: r };
}

/** POST /admin/referral-reviews/:id/accept — create/merge the patient. */
export function demoAcceptReferralReview(id: string) {
  const r = get().reviews.find((x) => x.id === id);
  if (!r) return null;
  r.status = "accepted";
  r.acceptedAt = NOW_ISO();
  r.createdPatientId = r.createdPatientId ?? newId("demo-patient");
  r.updatedAt = NOW_ISO();
  return { ok: true as const, patientId: r.createdPatientId, review: r };
}

/** POST /admin/referral-reviews/:id/dismiss */
export function demoDismissReferralReview(id: string, note?: string) {
  const r = get().reviews.find((x) => x.id === id);
  if (!r) return null;
  r.status = "dismissed";
  r.dismissedAt = NOW_ISO();
  r.dismissNote = note ?? null;
  r.updatedAt = NOW_ISO();
  return { ok: true as const, review: r };
}

/** POST /admin/referral-reviews/:id/request-from-provider */
export function demoRequestFromProvider(id: string) {
  const r = get().reviews.find((x) => x.id === id);
  if (!r) return null;
  const requests =
    (r.report as { completeness?: { providerRequests?: string[] } } | null)
      ?.completeness?.providerRequests ?? [];
  return {
    ok: true as const,
    // No fax leaves the sandbox; the console renders what WOULD be sent.
    sent: false,
    faxTo: r.faxFromE164,
    requests,
  };
}

/** POST /admin/referral-reviews/upload-url — presigned-upload stand-in. */
export function demoReferralUploadUrl() {
  const id = newId("demo-review-upload");
  return {
    uploadId: id,
    // A same-origin path so nothing in the sandbox tries to reach a real
    // storage host; the demo router answers the PUT with `{ ok: true }`.
    url: `/resupply-api/admin/referral-reviews/upload/${id}`,
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

/** POST /admin/referral-reviews — register an uploaded packet. */
export function demoCreateReferralReview(
  _body: { uploadId?: string; fileName?: string } | undefined,
) {
  const s = get();
  const review: DemoReferralReview = {
    id: newId("demo-review"),
    source: "upload",
    inboundFaxId: null,
    hasMedia: true,
    mediaContentType: "application/pdf",
    mediaSizeBytes: 480_000,
    status: "pending",
    extraction: null,
    extractionModel: null,
    extractedAt: null,
    errorReason: null,
    createdPatientId: null,
    acceptedAt: null,
    dismissedAt: null,
    dismissNote: null,
    createdAt: NOW_ISO(),
    updatedAt: NOW_ISO(),
    report: null,
    faxFromE164: null,
  };
  s.reviews.unshift(review);
  return { review };
}
