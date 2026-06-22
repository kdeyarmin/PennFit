// Extension batch 5 — billing/clearinghouse + CSR-ops admin surfaces
// for the demo sandbox. The fetch interceptor's empty `{}` fallback
// would otherwise crash these admin pages (they map over arrays and
// deref nested fields), so each route below returns fully-shaped
// sample data matching the live API response (see the corresponding
// artifacts/resupply-api/src/routes/admin/*.ts route file named in
// each section header).
//
// DATA RULES: everything here is fictional demo data — obviously-fake
// patient/provider names, demo ids, fresh relative dates. Platform =
// CareMetric Breathe; the demo tenant = Penn Home Medical Supply
// (pennpaps.com). Office Ally is the clearinghouse (837P/835/277CA
// over SFTP) — believable submission/ack rows, NO real credentials.
// PacWare is a CSV file exchange with no API — preview/notice shapes
// only. Money in cents. NO real PHI.

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import {
  daysAgo,
  daysFromNow,
  hoursAgo,
  minutesAgo,
  dateOnly,
  NOW_ISO,
} from "../fixtures/dates";

// ── Office Ally submissions (office-ally-submissions.ts) ──────────────
// GET /resupply-api/admin/office-ally-submissions → { submissions: [...] }
// GET /resupply-api/admin/office-ally-submissions/:id
//   → { submission, claims: [...], lineage: { parent, children } }
interface OaSubmission {
  id: string;
  fileName: string;
  isaControlNumber: string;
  gsControlNumber: string;
  status: string;
  fileSizeBytes: number;
  claimCount: number;
  officeAllySessionId: string | null;
  ack999FileName: string | null;
  ack999ReceivedAt: string | null;
  ack277caFileName: string | null;
  ack277caReceivedAt: string | null;
  rejectionReason: string | null;
  submittedByEmail: string;
  submittedAt: string;
  updatedAt: string;
  attemptedClaimIds: string[];
  parentSubmissionId: string | null;
}

const OA_SUBMISSIONS: OaSubmission[] = [
  {
    id: "demo-oas-0001-0000-0000-0000-000000000001",
    fileName: "PF-837P-20260619-0001.txt",
    isaControlNumber: "000010234",
    gsControlNumber: "10234",
    status: "accepted_277ca",
    fileSizeBytes: 84211,
    claimCount: 8,
    officeAllySessionId: "OA-SESS-77120",
    ack999FileName: "999-20260619-0001.txt",
    ack999ReceivedAt: hoursAgo(70),
    ack277caFileName: "277CA-20260619-0001.txt",
    ack277caReceivedAt: hoursAgo(64),
    rejectionReason: null,
    submittedByEmail: "demo.biller@pennpaps.example",
    submittedAt: daysAgo(3),
    updatedAt: hoursAgo(64),
    attemptedClaimIds: ["demo-claim-9001", "demo-claim-9002"],
    parentSubmissionId: null,
  },
  {
    id: "demo-oas-0001-0000-0000-0000-000000000002",
    fileName: "PF-837P-20260621-0002.txt",
    isaControlNumber: "000010235",
    gsControlNumber: "10235",
    status: "rejected_999",
    fileSizeBytes: 12044,
    claimCount: 2,
    officeAllySessionId: "OA-SESS-77384",
    ack999FileName: "999-20260621-0002.txt",
    ack999ReceivedAt: hoursAgo(20),
    ack277caFileName: null,
    ack277caReceivedAt: null,
    rejectionReason:
      "IK304: Subscriber primary identifier missing on 1 of 2 claims (loop 2010BA)",
    submittedByEmail: "demo.biller@pennpaps.example",
    submittedAt: daysAgo(1),
    updatedAt: hoursAgo(20),
    attemptedClaimIds: ["demo-claim-9003", "demo-claim-9004"],
    parentSubmissionId: null,
  },
  {
    id: "demo-oas-0001-0000-0000-0000-000000000003",
    fileName: "PF-837P-20260622-0003.txt",
    isaControlNumber: "000010236",
    gsControlNumber: "10236",
    status: "uploaded",
    fileSizeBytes: 53120,
    claimCount: 5,
    officeAllySessionId: "OA-SESS-77501",
    ack999FileName: null,
    ack999ReceivedAt: null,
    ack277caFileName: null,
    ack277caReceivedAt: null,
    rejectionReason: null,
    submittedByEmail: "demo.biller@pennpaps.example",
    submittedAt: hoursAgo(2),
    updatedAt: hoursAgo(2),
    attemptedClaimIds: ["demo-claim-9005"],
    parentSubmissionId: null,
  },
  {
    id: "demo-oas-0001-0000-0000-0000-000000000004",
    fileName: "PF-837P-20260622-0004.txt",
    isaControlNumber: "000010237",
    gsControlNumber: "10237",
    status: "transport_failed",
    fileSizeBytes: 28890,
    claimCount: 3,
    officeAllySessionId: null,
    ack999FileName: null,
    ack999ReceivedAt: null,
    ack277caFileName: null,
    ack277caReceivedAt: null,
    rejectionReason: "SFTP upload failed: connection reset by peer",
    submittedByEmail: "demo.biller@pennpaps.example",
    submittedAt: hoursAgo(5),
    updatedAt: hoursAgo(5),
    attemptedClaimIds: ["demo-claim-9006", "demo-claim-9007"],
    parentSubmissionId: null,
  },
];

function oaSubmissionDetail(id: string) {
  const submission =
    OA_SUBMISSIONS.find((s) => s.id === id) ?? OA_SUBMISSIONS[0]!;
  return {
    submission,
    claims: [
      {
        id: "demo-claim-9001",
        patientId: "demo-p-2004",
        patientName: "Avery Sample",
        payerName: "Demo Health Plan",
        claimNumber: "CLM-DEMO-9001",
        dateOfService: dateOnly(-12),
        status: "submitted",
        totalBilledCents: 18950,
        ack277ca:
          submission.status === "accepted_277ca"
            ? {
                outcome: "accepted" as const,
                reason: "A1 Acknowledged — claim forwarded to payer",
                receivedAt: submission.ack277caReceivedAt ?? hoursAgo(64),
              }
            : null,
      },
      {
        id: "demo-claim-9002",
        patientId: "demo-p-2005",
        patientName: "Quinn Mockton",
        payerName: "Demo Health Plan",
        claimNumber: "CLM-DEMO-9002",
        dateOfService: dateOnly(-9),
        status: "submitted",
        totalBilledCents: 9900,
        ack277ca:
          submission.status === "rejected_999"
            ? {
                outcome: "rejected" as const,
                reason: "Subscriber primary identifier missing",
                receivedAt: hoursAgo(20),
              }
            : null,
      },
    ],
    lineage: { parent: null, children: [] as OaSubmission[] },
  };
}

// ── Office closures (office-closures.ts) ──────────────────────────────
// GET /resupply-api/admin/office-closures → { closures: [...] }
// GET /resupply-api/admin/office-closures/active → { active }
// GET /resupply-api/admin/office-closures/recurring → { rules: [...] }
const OFFICE_CLOSURES = [
  {
    id: "demo-oc-0001-0000-0000-0000-000000000001",
    label: "Independence Day",
    startsAt: daysFromNow(12),
    endsAt: daysFromNow(13),
    autoReplyMessage:
      "Penn Home Medical Supply is closed for the holiday. We'll reply to your message on the next business day.",
    createdByUserId: "demo-user-csr-1",
    createdAt: daysAgo(20),
    updatedAt: daysAgo(20),
  },
  {
    id: "demo-oc-0001-0000-0000-0000-000000000002",
    label: "Staff training (half day)",
    startsAt: daysFromNow(4),
    endsAt: daysFromNow(4),
    autoReplyMessage:
      "Our team is in training this afternoon. Leave a message and we'll get back to you shortly.",
    createdByUserId: "demo-user-csr-1",
    createdAt: daysAgo(6),
    updatedAt: daysAgo(6),
  },
  {
    id: "demo-oc-0001-0000-0000-0000-000000000003",
    label: "Memorial Day (recent)",
    startsAt: daysAgo(26),
    endsAt: daysAgo(25),
    autoReplyMessage:
      "Penn Home Medical Supply is closed for Memorial Day. We'll respond on the next business day.",
    createdByUserId: "demo-user-csr-1",
    createdAt: daysAgo(45),
    updatedAt: daysAgo(45),
  },
];

const OFFICE_RECURRING_CLOSURES = [
  {
    id: "demo-orc-0001-0000-0000-0000-000000000001",
    label: "Weekends — Saturday",
    dayOfWeek: 6,
    startTimeUtc: "00:00:00",
    endTimeUtc: "23:59:59",
    autoReplyMessage:
      "We're closed on weekends. Send your question and we'll reply Monday morning.",
    active: true,
    createdAt: daysAgo(90),
    updatedAt: daysAgo(90),
  },
  {
    id: "demo-orc-0001-0000-0000-0000-000000000002",
    label: "Weekends — Sunday",
    dayOfWeek: 0,
    startTimeUtc: "00:00:00",
    endTimeUtc: "23:59:59",
    autoReplyMessage:
      "We're closed on weekends. Send your question and we'll reply Monday morning.",
    active: true,
    createdAt: daysAgo(90),
    updatedAt: daysAgo(90),
  },
];

// ── Outreach playbooks (outreach-playbooks.ts) ────────────────────────
// GET /resupply-api/admin/outreach-playbooks → { playbooks: [...] }
// GET /resupply-api/admin/outreach-playbooks/runs?status= → { runs: [...] }
// GET /resupply-api/admin/outreach-playbooks/call-queue → { tasks: [...] }
function outreachPlaybooks() {
  return {
    playbooks: [
      {
        id: "demo-pb-0001-0000-0000-0000-000000000001",
        playbookKey: "resupply_ready_to_order",
        name: "Ready to re-order supplies",
        situation:
          "Patient is due for resupply and hasn't responded to the standard reminder.",
        description:
          "Three-touch nudge across SMS and email to confirm the next shipment.",
        category: "resupply",
        isActive: true,
        isSeeded: true,
        updatedAt: daysAgo(14),
        activeRunCount: 2,
        steps: [
          {
            id: "demo-pbs-1001",
            stepIndex: 1,
            dayOffset: 0,
            channel: "sms",
            subject: null,
            body: "Hi {{firstName}}, you're due for fresh CPAP supplies. Reply YES to confirm your order.",
          },
          {
            id: "demo-pbs-1002",
            stepIndex: 2,
            dayOffset: 3,
            channel: "email",
            subject: "Your CPAP resupply is ready",
            body: "We have your replacement cushions and filters ready to ship. Confirm anytime.",
          },
          {
            id: "demo-pbs-1003",
            stepIndex: 3,
            dayOffset: 6,
            channel: "call",
            subject: null,
            body: "Call script: confirm shipping address, ask about mask comfort, offer to place the order.",
          },
        ],
      },
      {
        id: "demo-pb-0001-0000-0000-0000-000000000002",
        playbookKey: "clinical_compliance_nudge",
        name: "Not meeting compliance goals",
        situation:
          "Usage has dropped below 4 hours on most nights in the trailing week.",
        description:
          "Empathetic check-in plus a coaching call to troubleshoot comfort.",
        category: "clinical",
        isActive: true,
        isSeeded: true,
        updatedAt: daysAgo(8),
        activeRunCount: 1,
        steps: [
          {
            id: "demo-pbs-2001",
            stepIndex: 1,
            dayOffset: 0,
            channel: "sms",
            subject: null,
            body: "Hi {{firstName}}, how is therapy going? We're here if anything feels off with your mask or pressure.",
          },
          {
            id: "demo-pbs-2002",
            stepIndex: 2,
            dayOffset: 4,
            channel: "call",
            subject: null,
            body: "Call script: review usage trend, troubleshoot leak/pressure, schedule a refit if needed.",
          },
        ],
      },
      {
        id: "demo-pb-0001-0000-0000-0000-000000000003",
        playbookKey: "custom_fitter_no_order_1a2b3c",
        name: "Used the fitter, no order",
        situation:
          "Patient completed the online mask fitter but never placed an order.",
        description: null,
        category: "sales",
        isActive: false,
        isSeeded: false,
        updatedAt: daysAgo(2),
        activeRunCount: 0,
        steps: [
          {
            id: "demo-pbs-3001",
            stepIndex: 1,
            dayOffset: 1,
            channel: "email",
            subject: "Your recommended mask is ready",
            body: "Based on your fitting we recommend the nasal-pillow setup. Want us to send it?",
          },
        ],
      },
    ],
  };
}

function outreachRuns(status: "active" | "completed" | "cancelled") {
  const active = [
    {
      id: "demo-pbr-0001-0000-0000-0000-000000000001",
      playbookId: "demo-pb-0001-0000-0000-0000-000000000001",
      playbookName: "Ready to re-order supplies",
      patientId: "demo-p-2004",
      patientName: "Avery Sample",
      status: "active",
      nextStepIndex: 2,
      nextStepAt: daysFromNow(1),
      startedByEmail: "demo.csr@pennpaps.example",
      startedAt: daysAgo(2),
      completedAt: null,
      cancelledAt: null,
    },
    {
      id: "demo-pbr-0001-0000-0000-0000-000000000002",
      playbookId: "demo-pb-0001-0000-0000-0000-000000000002",
      playbookName: "Not meeting compliance goals",
      patientId: "demo-p-3007",
      patientName: "Demo Patient",
      status: "active",
      nextStepIndex: 2,
      nextStepAt: daysFromNow(2),
      startedByEmail: "demo.rt@pennpaps.example",
      startedAt: daysAgo(2),
      completedAt: null,
      cancelledAt: null,
    },
  ];
  const completed = [
    {
      id: "demo-pbr-0001-0000-0000-0000-000000000003",
      playbookId: "demo-pb-0001-0000-0000-0000-000000000001",
      playbookName: "Ready to re-order supplies",
      patientId: "demo-p-2005",
      patientName: "Quinn Mockton",
      status: "completed",
      nextStepIndex: 4,
      nextStepAt: null,
      startedByEmail: "demo.csr@pennpaps.example",
      startedAt: daysAgo(20),
      completedAt: daysAgo(11),
      cancelledAt: null,
    },
  ];
  const cancelled = [
    {
      id: "demo-pbr-0001-0000-0000-0000-000000000004",
      playbookId: "demo-pb-0001-0000-0000-0000-000000000002",
      playbookName: "Not meeting compliance goals",
      patientId: "demo-p-2003",
      patientName: "Jordan Fixture",
      status: "cancelled",
      nextStepIndex: 1,
      nextStepAt: null,
      startedByEmail: "demo.rt@pennpaps.example",
      startedAt: daysAgo(15),
      completedAt: null,
      cancelledAt: daysAgo(13),
    },
  ];
  const runs =
    status === "completed"
      ? completed
      : status === "cancelled"
        ? cancelled
        : active;
  return { runs };
}

function outreachCallQueue() {
  return {
    tasks: [
      {
        id: "demo-pbt-0001-0000-0000-0000-000000000001",
        runId: "demo-pbr-0001-0000-0000-0000-000000000002",
        stepIndex: 2,
        hasPhone: true,
        patientId: "demo-p-3007",
        patientName: "Demo Patient",
        playbookName: "Not meeting compliance goals",
        callScript:
          "Call script: review usage trend, troubleshoot leak/pressure, schedule a refit if needed.",
        dueSince: hoursAgo(6),
      },
      {
        id: "demo-pbt-0001-0000-0000-0000-000000000002",
        runId: "demo-pbr-0001-0000-0000-0000-000000000001",
        stepIndex: 3,
        hasPhone: true,
        patientId: "demo-p-2004",
        patientName: "Avery Sample",
        playbookName: "Ready to re-order supplies",
        callScript:
          "Call script: confirm shipping address, ask about mask comfort, offer to place the order.",
        dueSince: hoursAgo(2),
      },
    ],
  };
}

// ── PacWare (pacware.ts) — CSV file exchange, NO API ──────────────────
// GET /resupply-api/admin/pacware/status   → { availability, reports, generatedAt }
// GET /resupply-api/admin/pacware/settings → { autoSync, pending, generatedAt }
// GET /resupply-api/admin/pacware/sync/patients/preview → verify shape
// GET /resupply-api/admin/pacware/sync/resupply-due/preview → verify shape
// (CSV download + import-commit routes are skipped — binary/stream + writes.)
function pacwareStatus() {
  return {
    availability: {
      status: "configured" as const,
      mode: "file_exchange" as const,
      outboxConfigured: false,
    },
    reports: [
      {
        kind: "patient_roster",
        direction: "both",
        label: "Patient roster",
        description:
          "Patient demographics + insurance. In PacWare, run the Patient List report. Joins to CareMetric Breathe patients on the PacWare account number (pacware_id).",
        columns: [
          {
            field: "pacwareId",
            header: "pacware_id",
            required: true,
            description:
              "PacWare patient account number — the stable join key.",
            aliases: ["accountnumber", "acctno", "patientid"],
          },
          {
            field: "legalFirstName",
            header: "legal_first_name",
            required: true,
            description: "Patient legal first name.",
            aliases: ["firstname", "first"],
          },
          {
            field: "legalLastName",
            header: "legal_last_name",
            required: true,
            description: "Patient legal last name.",
            aliases: ["lastname", "last"],
          },
          {
            field: "dateOfBirth",
            header: "date_of_birth",
            required: true,
            description: "Date of birth in YYYY-MM-DD.",
            aliases: ["dob", "birthdate"],
          },
          {
            field: "insurancePayer",
            header: "insurance_payer",
            required: false,
            description: "Primary insurance payer name.",
            aliases: ["payer", "insurance"],
          },
        ],
      },
      {
        kind: "resupply_due",
        direction: "export",
        label: "Resupply due worklist",
        description:
          "Resupply episodes due / ready to action. CareMetric Breathe to PacWare order entry & billing. Export only.",
        columns: [
          {
            field: "pacwareId",
            header: "pacware_id",
            required: true,
            description: "PacWare patient account number.",
            aliases: ["accountnumber", "acctno"],
          },
          {
            field: "itemSku",
            header: "item_sku",
            required: true,
            description: "HCPCS / SKU of the due resupply item.",
            aliases: ["sku", "hcpcs"],
          },
          {
            field: "dueDate",
            header: "due_date",
            required: true,
            description: "Date the resupply item is due (YYYY-MM-DD).",
            aliases: ["due"],
          },
        ],
      },
    ],
    generatedAt: NOW_ISO(),
  };
}

function pacwareSettings() {
  return {
    autoSync: false,
    pending: { resupplyDue: 12, patients: 12 },
    generatedAt: NOW_ISO(),
  };
}

function pacwarePatientsPreview() {
  return {
    target: "patient_roster",
    count: 12,
    sample: [
      {
        pacwareId: "PW-10240",
        legalFirstName: "Jordan",
        legalLastName: "Sample",
        dateOfBirth: "1968-04-12",
        phoneE164: "+15555550140",
        email: "jordan.sample@example.com",
        addressLine1: "100 Demo Street",
        addressLine2: null,
        city: "Philadelphia",
        state: "PA",
        postalCode: "19103",
        country: "US",
        insurancePayer: "Demo Health Plan",
      },
      {
        pacwareId: "PW-10244",
        legalFirstName: "Avery",
        legalLastName: "Sample",
        dateOfBirth: "1971-09-03",
        phoneE164: "+15555550144",
        email: "avery.sample@example.com",
        addressLine1: "240 Fixture Ave",
        addressLine2: "Apt 4",
        city: "Pittsburgh",
        state: "PA",
        postalCode: "15201",
        country: "US",
        insurancePayer: "Demo Medicaid MCO",
      },
    ],
  };
}

function pacwareResupplyPreview(status: string) {
  return {
    target: "resupply_due",
    status,
    count: 12,
    withheldMissingPacwareId: 2,
    sample: [
      {
        pacwareId: "PW-10244",
        legalLastName: "Sample",
        legalFirstName: "Avery",
        itemSku: "A7034",
        quantity: 1,
        dueDate: dateOnly(2),
        episodeStatus: status,
        insurancePayer: "Demo Medicaid MCO",
        episodeId: "demo-ep-9101",
      },
      {
        pacwareId: "PW-10240",
        legalLastName: "Sample",
        legalFirstName: "Jordan",
        itemSku: "A7038",
        quantity: 1,
        dueDate: dateOnly(5),
        episodeStatus: status,
        insurancePayer: "Demo Health Plan",
        episodeId: "demo-ep-9102",
      },
    ],
  };
}

// ── Patient address history (patient-address-history.ts) ──────────────
// GET /resupply-api/admin/patients/:id/address-history → { history: [...] }
function addressHistory() {
  return {
    history: [
      {
        id: "demo-pah-0001",
        line1: "240 Fixture Ave",
        line2: "Apt 4",
        city: "Pittsburgh",
        state: "PA",
        postalCode: "15201",
        country: "US",
        reason: "Patient moved — updated per inbound call",
        changedByUserId: "demo-user-csr-1",
        createdAt: daysAgo(40),
      },
      {
        id: "demo-pah-0002",
        line1: "18 Sample Lane",
        line2: null,
        city: "Pittsburgh",
        state: "PA",
        postalCode: "15213",
        country: "US",
        reason: "Original address at intake",
        changedByUserId: "demo-user-csr-1",
        createdAt: daysAgo(200),
      },
    ],
  };
}

// ── Patient documents retention (patient-documents-retention.ts) ──────
// GET /resupply-api/admin/patient-documents/retention?bucket=
//   → { count, documents: [...] }
function documentsRetention(bucket?: string) {
  const all = [
    {
      id: "demo-pd-0001",
      patientId: "demo-p-2004",
      documentType: "prescription",
      filename: "rx-avery-sample.pdf",
      contentType: "application/pdf",
      sizeBytes: 184320,
      createdAt: daysAgo(2400),
      retentionUntilAt: daysAgo(5),
      legalHold: false,
      retentionMarkedAt: daysAgo(3),
      destroyedAt: null,
      bucket: "due_now",
    },
    {
      id: "demo-pd-0002",
      patientId: "demo-p-2005",
      documentType: "proof_of_delivery",
      filename: "pod-quinn-mockton.jpg",
      contentType: "image/jpeg",
      sizeBytes: 512000,
      createdAt: daysAgo(2300),
      retentionUntilAt: daysFromNow(20),
      legalHold: false,
      retentionMarkedAt: null,
      destroyedAt: null,
      bucket: "due_soon",
    },
    {
      id: "demo-pd-0003",
      patientId: "demo-p-3007",
      documentType: "insurance_card",
      filename: "insurance-demo-patient.pdf",
      contentType: "application/pdf",
      sizeBytes: 98304,
      createdAt: daysAgo(2600),
      retentionUntilAt: daysAgo(30),
      legalHold: true,
      retentionMarkedAt: daysAgo(25),
      destroyedAt: null,
      bucket: "legal_hold",
    },
    {
      id: "demo-pd-0004",
      patientId: "demo-p-2003",
      documentType: "prescription",
      filename: "rx-jordan-fixture.pdf",
      contentType: "application/pdf",
      sizeBytes: 156000,
      createdAt: daysAgo(2800),
      retentionUntilAt: daysAgo(60),
      legalHold: false,
      retentionMarkedAt: daysAgo(40),
      destroyedAt: daysAgo(12),
      bucket: "destroyed",
    },
  ];
  const documents = bucket ? all.filter((d) => d.bucket === bucket) : all;
  return { count: documents.length, documents };
}

// ── Patient fit overrides (patient-fit-overrides.ts) ──────────────────
// GET /resupply-api/admin/patients/:id/fit-override → { override }
function fitOverride(patientId: string) {
  return {
    override: {
      patientId,
      recommendedMaskSku: "AIRFIT-N30I",
      recommendedMaskSize: "M",
      rationale:
        "Camera fit suggested full-face, but patient prefers nasal pillows and reported claustrophobia — overriding to nasal mask.",
      createdByUserId: "demo-user-rt-1",
      createdAt: daysAgo(5),
      updatedAt: daysAgo(5),
    },
  };
}

// ── Patient identity verifications (patient-identity-verifications.ts) ─
// GET /resupply-api/admin/patients/:id/identity-verifications
//   → { verifications: [...] }
function identityVerifications() {
  return {
    verifications: [
      {
        id: "demo-piv-0001",
        method: "dob_last4_ssn",
        result: "pass",
        notes:
          "Confirmed DOB and last 4 on inbound call before address change.",
        verifiedByUserId: "demo-user-csr-1",
        createdAt: daysAgo(40),
      },
      {
        id: "demo-piv-0002",
        method: "video_attest",
        result: "pass",
        notes: null,
        verifiedByUserId: "demo-user-rt-1",
        createdAt: daysAgo(120),
      },
      {
        id: "demo-piv-0003",
        method: "gov_id_upload",
        result: "skipped",
        notes: "Patient declined; verified by DOB instead.",
        verifiedByUserId: "demo-user-csr-1",
        createdAt: daysAgo(180),
      },
    ],
  };
}

// ── Patient maintenance log (patient-maintenance-log.ts) ──────────────
// GET /resupply-api/admin/patients/:id/maintenance-log
//   → { entries: [...], latestByTask }
function maintenanceLog() {
  const entries = [
    {
      id: "demo-pml-0001",
      taskKey: "cushion_clean",
      completedAt: daysAgo(6),
      source: "patient_portal",
      createdAt: daysAgo(6),
    },
    {
      id: "demo-pml-0002",
      taskKey: "headgear_wash",
      completedAt: daysAgo(13),
      source: "patient_portal",
      createdAt: daysAgo(13),
    },
    {
      id: "demo-pml-0003",
      taskKey: "humidifier_descale",
      completedAt: daysAgo(20),
      source: "patient_portal",
      createdAt: daysAgo(20),
    },
    {
      id: "demo-pml-0004",
      taskKey: "filter_change",
      completedAt: daysAgo(34),
      source: "patient_portal",
      createdAt: daysAgo(34),
    },
    {
      id: "demo-pml-0005",
      taskKey: "cushion_clean",
      completedAt: daysAgo(41),
      source: "patient_portal",
      createdAt: daysAgo(41),
    },
  ];
  const latestByTask: Record<string, string> = {};
  for (const r of entries) {
    if (!latestByTask[r.taskKey] || r.completedAt > latestByTask[r.taskKey]!) {
      latestByTask[r.taskKey] = r.completedAt;
    }
  }
  return { entries, latestByTask };
}

export const ext5Handlers: DemoHandler[] = [
  // ── Office Ally submissions ─────────────────────────────────────────
  route("GET", "/resupply-api/admin/office-ally-submissions", (req) => {
    const status = req.query.get("status");
    const q = (req.query.get("q") ?? "").trim().toLowerCase();
    let rows = OA_SUBMISSIONS;
    if (status) rows = rows.filter((s) => s.status === status);
    if (q) {
      rows = rows.filter(
        (s) =>
          s.isaControlNumber.toLowerCase().includes(q) ||
          s.fileName.toLowerCase().includes(q),
      );
    }
    return json({ submissions: rows });
  }),
  route("GET", "/resupply-api/admin/office-ally/operations-summary", () => {
    const accepted = OA_SUBMISSIONS.filter((s) =>
      ["accepted_999", "accepted_277ca"].includes(s.status),
    ).length;
    const rejected = OA_SUBMISSIONS.filter((s) =>
      ["rejected_999", "rejected_277ca"].includes(s.status),
    ).length;
    const transportFailed = OA_SUBMISSIONS.filter(
      (s) => s.status === "transport_failed",
    ).length;
    const totalClaims = OA_SUBMISSIONS.reduce((n, s) => n + s.claimCount, 0);
    const decided = accepted + rejected;
    return json({
      window: { sinceIso: daysAgo(30), days: 30 },
      counts: {
        totalSubmissions: OA_SUBMISSIONS.length,
        totalClaims,
        accepted,
        rejected,
        transportFailed,
        pendingAck: 1,
      },
      rates: {
        acceptanceRatePct:
          decided > 0 ? Math.round((accepted / decided) * 1000) / 10 : null,
        avgMinutesToAck999: 38,
      },
    });
  }),
  route("GET", "/resupply-api/admin/office-ally/payer-stats", () =>
    json({
      window: { sinceIso: daysAgo(30), days: 30 },
      payers: [
        {
          payerProfileId: "demo-payer-1",
          displayName: "Demo Health Plan",
          slug: "demo-health-plan",
          lineOfBusiness: "commercial",
          submissionCount: 2,
          claimCount: 13,
          acceptedCount: 1,
          rejectedCount: 0,
          transportFailedCount: 1,
          pendingCount: 0,
          acceptanceRatePct: 100,
        },
        {
          payerProfileId: "demo-payer-2",
          displayName: "Demo Medicaid MCO",
          slug: "demo-medicaid-mco",
          lineOfBusiness: "medicaid",
          submissionCount: 1,
          claimCount: 2,
          acceptedCount: 0,
          rejectedCount: 1,
          transportFailedCount: 0,
          pendingCount: 0,
          acceptanceRatePct: 0,
        },
      ],
    }),
  ),
  route("GET", "/resupply-api/admin/office-ally/health", () =>
    json({
      hasActiveClearinghouse: true,
      activeClearinghouseSlug: "office-ally",
      activeClearinghouseName: "Office Ally",
      lastPolledAt: minutesAgo(8),
      minutesSinceLastPoll: 8,
      pollStatus: "fresh",
      recentTransportFailures: 1,
    }),
  ),
  route("GET", "/resupply-api/admin/office-ally/enrollment-watchlist", () =>
    json({
      payers: [
        {
          id: "demo-payer-3",
          slug: "demo-advantage",
          displayName: "Demo Advantage",
          lineOfBusiness: "medicare_advantage",
          ediEnrollmentStatus: "pending",
          officeAllyPayerId: "OA-44210",
          requirementsLastVerifiedAt: daysAgo(9),
        },
        {
          id: "demo-payer-4",
          slug: "demo-ppo",
          displayName: "Demo PPO",
          lineOfBusiness: "commercial",
          ediEnrollmentStatus: "not_enrolled",
          officeAllyPayerId: null,
          requirementsLastVerifiedAt: null,
        },
      ],
    }),
  ),
  route("GET", "/resupply-api/admin/office-ally-submissions/:id", (_req, p) =>
    json(oaSubmissionDetail(p.id)),
  ),
  // Resubmit a transport_failed batch — benign success in the route shape.
  route(
    "POST",
    "/resupply-api/admin/office-ally-submissions/:id/resubmit",
    (_req, p) =>
      json(
        {
          ok: true,
          submissionId: "demo-oas-0001-0000-0000-0000-0000000000ff",
          parentSubmissionId: p.id,
          claimCount: 3,
          isaControlNumber: "000010240",
          gsControlNumber: "10240",
          transport: "sftp",
          uploadError: null,
        },
        201,
      ),
  ),
  route("PATCH", "/resupply-api/admin/office-ally-submissions/:id", () =>
    json({ ok: true }),
  ),
  route("POST", "/resupply-api/admin/office-ally/bulk-resubmit", (req) => {
    const body = req.json<{ submissionIds?: string[] }>();
    const ids = body?.submissionIds ?? [];
    return json({
      total: ids.length,
      okCount: ids.length,
      failedCount: 0,
      outcomes: ids.map((id, i) => ({
        submissionId: id,
        ok: true,
        newSubmissionId: `demo-oas-resub-${i + 1}`,
        claimCount: 2,
        isaControlNumber: `0000${10240 + i}`,
        transport: "sftp",
        uploadOk: true,
        uploadError: null,
      })),
    });
  }),

  // ── Office Ally manual ack upload (office-ally-upload-ack.ts) ────────
  route("POST", "/resupply-api/admin/office-ally/upload-ack", () =>
    json(
      {
        ok: true,
        inboundFileId: "demo-cif-0001",
        fileKind: "277ca",
        fileSizeBytes: 4096,
      },
      201,
    ),
  ),

  // ── Office closures ─────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/office-closures/active", () =>
    json({ active: null }),
  ),
  route("GET", "/resupply-api/admin/office-closures/recurring", () =>
    json({ rules: OFFICE_RECURRING_CLOSURES }),
  ),
  route("GET", "/resupply-api/admin/office-closures", () =>
    json({ closures: OFFICE_CLOSURES }),
  ),
  route("POST", "/resupply-api/admin/office-closures", () =>
    json({ id: "demo-oc-0001-0000-0000-0000-0000000000ff" }, 201),
  ),
  route("PATCH", "/resupply-api/admin/office-closures/:id", () =>
    json({ ok: true }),
  ),
  route("POST", "/resupply-api/admin/office-closures/:id/end-now", () =>
    json({ ok: true }),
  ),
  route("POST", "/resupply-api/admin/office-closures/recurring", () =>
    json({ id: "demo-orc-0001-0000-0000-0000-0000000000ff" }, 201),
  ),
  route("PATCH", "/resupply-api/admin/office-closures/recurring/:id", () =>
    json({ ok: true }),
  ),

  // ── Outreach playbooks ──────────────────────────────────────────────
  route("GET", "/resupply-api/admin/outreach-playbooks/runs", (req) => {
    const raw = req.query.get("status");
    const status = raw === "completed" || raw === "cancelled" ? raw : "active";
    return json(outreachRuns(status));
  }),
  route("GET", "/resupply-api/admin/outreach-playbooks/call-queue", () =>
    json(outreachCallQueue()),
  ),
  route("GET", "/resupply-api/admin/outreach-playbooks", () =>
    json(outreachPlaybooks()),
  ),
  route("POST", "/resupply-api/admin/outreach-playbooks", () =>
    json(
      {
        id: "demo-pb-0001-0000-0000-0000-0000000000ff",
        playbookKey: "custom_demo_playbook_z9",
      },
      201,
    ),
  ),
  route("PATCH", "/resupply-api/admin/outreach-playbooks/:id", (_req, p) =>
    json({ id: p.id }),
  ),
  route("PUT", "/resupply-api/admin/outreach-playbooks/:id/steps", (_req, p) =>
    json({ id: p.id, stepCount: 3 }),
  ),
  route("POST", "/resupply-api/admin/outreach-playbooks/:id/start", () =>
    json(
      {
        runId: "demo-pbr-0001-0000-0000-0000-0000000000ff",
        schedule: [
          { stepIndex: 1, channel: "sms", dueAt: NOW_ISO() },
          { stepIndex: 2, channel: "email", dueAt: daysFromNow(3) },
          { stepIndex: 3, channel: "call", dueAt: daysFromNow(6) },
        ],
      },
      201,
    ),
  ),
  route(
    "POST",
    "/resupply-api/admin/outreach-playbooks/runs/:id/cancel",
    (_req, p) => json({ id: p.id, status: "cancelled" }),
  ),
  route(
    "POST",
    "/resupply-api/admin/outreach-playbooks/call-tasks/:id/complete",
    (_req, p) => json({ id: p.id, status: "call_completed" }),
  ),

  // ── PacWare (JSON read/preview surfaces only; CSV streams skipped) ───
  route("GET", "/resupply-api/admin/pacware/status", () =>
    json(pacwareStatus()),
  ),
  route("GET", "/resupply-api/admin/pacware/settings", () =>
    json(pacwareSettings()),
  ),
  route("PUT", "/resupply-api/admin/pacware/settings", (req) => {
    const body = req.json<{ autoSync?: boolean }>();
    return json({ autoSync: body?.autoSync ?? false });
  }),
  route("GET", "/resupply-api/admin/pacware/sync/patients/preview", () =>
    json(pacwarePatientsPreview()),
  ),
  route("GET", "/resupply-api/admin/pacware/sync/resupply-due/preview", (req) =>
    json(pacwareResupplyPreview(req.query.get("status") ?? "confirmed")),
  ),
  route("POST", "/resupply-api/admin/pacware/import/patients/headers", () =>
    json({
      columns: ["pacware_id", "first_name", "last_name", "dob", "payer"],
      fieldGuesses: {
        pacware_id: "pacwareId",
        first_name: "legalFirstName",
        last_name: "legalLastName",
        dob: "dateOfBirth",
        payer: "insurancePayer",
      },
      mappableFields: [
        "pacwareId",
        "legalFirstName",
        "legalLastName",
        "dateOfBirth",
        "phoneE164",
        "email",
        "insurancePayer",
        "addressLine1",
        "city",
        "state",
        "postalCode",
      ],
    }),
  ),
  route("POST", "/resupply-api/admin/pacware/import/patients", (req) => {
    const body = req.json<{ mode?: string }>();
    if (body?.mode === "commit") {
      return json({
        mode: "commit",
        created: 4,
        updated: 2,
        unchanged: 6,
        validCount: 12,
        errorCount: 0,
        totalDataRows: 12,
        unmappedHeaders: [],
        errors: [],
        batchErrors: [],
      });
    }
    return json({
      mode: "preview",
      validCount: 12,
      errorCount: 0,
      totalDataRows: 12,
      unmappedHeaders: [],
      presentFields: [
        "pacwareId",
        "legalFirstName",
        "legalLastName",
        "dateOfBirth",
        "insurancePayer",
      ],
      errors: [],
    });
  }),

  // ── Patient address history ─────────────────────────────────────────
  route("GET", "/resupply-api/admin/patients/:id/address-history", () =>
    json(addressHistory()),
  ),
  route("POST", "/resupply-api/admin/patients/:id/address-history", () =>
    json({ id: "demo-pah-0001-0000-0000-0000-0000000000ff" }, 201),
  ),

  // ── Patient documents retention ─────────────────────────────────────
  route("GET", "/resupply-api/admin/patient-documents/retention", (req) =>
    json(documentsRetention(req.query.get("bucket") ?? undefined)),
  ),
  route(
    "POST",
    "/resupply-api/admin/patient-documents/:id/legal-hold",
    (req) => {
      const body = req.json<{ hold?: boolean }>();
      return json({ ok: true, legalHold: body?.hold ?? true });
    },
  ),
  route("POST", "/resupply-api/admin/patient-documents/:id/destroy", () =>
    json({ ok: true, destroyedAt: NOW_ISO() }),
  ),

  // ── Patient fit overrides ───────────────────────────────────────────
  route("GET", "/resupply-api/admin/patients/:id/fit-override", (_req, p) =>
    json(fitOverride(p.id)),
  ),
  route("PUT", "/resupply-api/admin/patients/:id/fit-override", () =>
    json({ ok: true }),
  ),
  route("DELETE", "/resupply-api/admin/patients/:id/fit-override", () =>
    json({ ok: true, deletedCount: 1 }),
  ),

  // ── Patient identity verifications ──────────────────────────────────
  route("GET", "/resupply-api/admin/patients/:id/identity-verifications", () =>
    json(identityVerifications()),
  ),
  route("POST", "/resupply-api/admin/patients/:id/identity-verifications", () =>
    json({ id: "demo-piv-0001-0000-0000-0000-0000000000ff" }, 201),
  ),

  // ── Patient maintenance log ─────────────────────────────────────────
  route("GET", "/resupply-api/admin/patients/:id/maintenance-log", () =>
    json(maintenanceLog()),
  ),
];
