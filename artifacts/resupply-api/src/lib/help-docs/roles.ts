// Staff role profiles — ONE source of truth for "what is this person's
// job title, and what does that job involve".
//
// Three surfaces need the same answer and used to each carry their own:
//   * the invite email's "Role:" line (team.ts ROLE_EMAIL_LABEL said
//     "Super admin" while the team page and the User Manual both said
//     "Owner" — the new hire was told a title nobody else in the
//     product uses),
//   * the role handbook PDF attached to that invite, and
//   * which pre-rendered manual is the RIGHT manual for the role (every
//     staff invite used to attach the Customer Service Manual, so a
//     biller's welcome email arrived with a customer-service manual and
//     nothing about the revenue cycle).
//
// The nine granular `AdminRole` values collapse into five job families.
// The legacy names (`agent`, `fitter`, `fulfillment`,
// `compliance_officer`) are persisted on existing rows but are not
// offered by the invite UI; they resolve to the family they belong to
// so an old row still gets sensible copy.
//
// The role content below is the same role decomposition the
// comprehensive User Manual is organised by (docs/user-manual/
// build_user_manual.py `ROLES` / `SUMMARY` / `JOB_AIDES`), so the
// handbook a new hire receives on day one and the manual they download
// from Support on day two describe the same job in the same terms.
//
// No PHI, no tenant literals: copy here is generic and the tenant's own
// name is a parameter wherever it appears (see content.ts).

import type { AdminRole } from "@workspace/resupply-db";

/** Role families, in the vocabulary the admin console and the User
 *  Manual use. `owner` and `admin` are both "administrator" as far as
 *  the manual is concerned; they differ on team + system settings,
 *  which are owner-only (requireAdminOnly === role 'admin'). */
export type StaffRoleFamily = "owner" | "admin" | "csr" | "biller" | "rt";

/** A labelled group of console areas the role works in. */
export interface RoleAreaGroup {
  label: string;
  items: string[];
}

/** An extra handbook section for a role whose job carries duties no
 *  other role has. Structurally a `HelpDocSection` — declared here
 *  rather than imported so `content.ts` can depend on this module
 *  without the dependency pointing back. */
export interface RoleHandbookSection {
  heading?: string;
  paragraphs?: string[];
  bullets?: string[];
  steps?: string[];
}

export interface StaffRoleProfile {
  family: StaffRoleFamily;
  /** Job title as the invitee will see it everywhere in the product. */
  title: string;
  /** One sentence describing the job, written in the second person
   *  ("You own the revenue cycle — …"). The invite email splices it
   *  after "As a Biller, …", and the handbook prints it as-is, so it
   *  has to read correctly both ways. */
  summary: string;
  /** What they will actually do day to day. Email bullets. */
  highlights: string[];
  /** Where their work lives in the console. Handbook content. */
  areas: RoleAreaGroup[];
  /** The first tasks worth learning, in the order worth learning them.
   *  Drawn from the manual's job aides for this role. */
  firstTasks: string[];
  /** Sections appended to this role's handbook, for duties no other
   *  role carries (the Owner managing the team, for instance). */
  extraSections?: RoleHandbookSection[];
  /** True when the pre-rendered Customer Service Manual is the manual
   *  for this job — the service desk itself, and the roles that
   *  supervise it. A biller or an RT gets their own handbook instead;
   *  the full role-organised User Manual is on the Support page for
   *  everyone. */
  customerServiceManual: boolean;
}

const OWNER: StaffRoleProfile = {
  family: "owner",
  title: "Owner",
  summary:
    "You have full access to the workspace — setup, the team, the money, and the controls that govern every other role.",
  highlights: [
    "Set up the workspace: company information, storefront branding, locations, and the phone, fax, and email identities patients see.",
    "Invite teammates, assign their roles, and revoke access the day someone leaves.",
    "Turn features on and off in Control Center, and tune automation rules, alerts, and compliance rules.",
    "Connect integrations — therapy clouds, the clearinghouse, PacWare, and Slack — and keep an eye on the plumbing.",
    "Read the whole business from Reports, financial analytics, and Performance & Goals.",
  ],
  areas: [
    {
      label: "Command center",
      items: [
        "Home — today's work, live counters, and quick links into every queue",
        "Support — the full User Manual, how-to answers, and support requests",
      ],
    },
    {
      label: "Setup & identity",
      items: [
        "Set Up Your Workspace — the go-live checklist",
        "Company Information, Storefront Branding, Locations",
        "Phone & SMS, Fax, and Email sending identities",
        "Account Security — multi-factor authentication and sign-in policy",
      ],
    },
    {
      label: "Team & control",
      items: [
        "Team — invite, re-invite, edit roles, and revoke access",
        "Control Center — turn features on and off for the whole workspace",
        "System Configuration, Automation Rules, Compliance Rules",
      ],
    },
    {
      label: "Operations & integrations",
      items: [
        "Operations — the health of everything running in the background",
        "Integrations, PacWare, Slack notifications",
        "Outbound Messages, Delivery Failures, Webhook Deliveries",
      ],
    },
    {
      label: "Analytics & goals",
      items: [
        "Reports and financial analytics",
        "Performance & Goals — targets and KPI alerts",
        "Audit Trail — who accessed which record, and when",
      ],
    },
  ],
  extraSections: [
    {
      heading: "Managing your team",
      paragraphs: [
        "Team management is yours alone — an Admin cannot invite, re-invite, or revoke anyone. Every invite you send emails the new member a secure password-setup link, the guides for their role, and the manual their job runs on.",
      ],
      bullets: [
        "Invite by email and assign a role — the role decides which parts of the console that person can see and change.",
        "Resend an invite when the original link expired before the member set their password.",
        "Revoke a member to end their access immediately and sign out every session they have open.",
        "Delete a pending or revoked invite to remove it entirely, as though it had never been sent.",
      ],
    },
    {
      heading: "Roles and what each one can do",
      bullets: [
        "Owner — full access, including team management and system settings. Keep this to as few people as possible.",
        "Admin — broad day-to-day management, but not the team or system configuration.",
        "Customer service rep — patients, the inbox, orders, and scheduling.",
        "Biller — the billing and revenue-cycle area.",
        "Respiratory therapist — the clinical and therapy-monitoring tools.",
      ],
      paragraphs: [
        "Grant each person the least access their job needs, and review the team list periodically so anyone who has left is revoked. A page above someone's role simply does not appear in their menu — if a colleague says something is missing, check their role before assuming a fault.",
      ],
    },
  ],
  firstTasks: [
    "Sign in and turn on multi-factor authentication on your own account.",
    "Work through Set Up Your Workspace — company information, branding, locations, and your sending identities.",
    "Review Control Center and turn on only the features your practice will actually use.",
    "Invite the rest of your team and assign each person the least access their job needs.",
    "Get billing ready for go-live: payers, fee schedules, and the clearinghouse connection.",
    "Set your business goals so Performance & Goals can alert you when a number drifts.",
  ],
  customerServiceManual: true,
};

const ADMIN: StaffRoleProfile = {
  family: "admin",
  title: "Admin",
  summary:
    "You have broad day-to-day management access across patients, orders, billing, and reporting — everything except the owner-only team and system settings.",
  highlights: [
    "Run the daily queues alongside your team: conversations, cases, orders, and follow-ups.",
    "Supervise patient records, documents, and e-signature packets end to end.",
    "Watch operations, outbound messages, and delivery failures for anything stuck.",
    "Pull reports and track the team against its goals.",
    "Team management and system configuration stay with the Owner — ask them when access needs to change.",
  ],
  areas: [
    {
      label: "Daily oversight",
      items: [
        "Home — today's work across every queue",
        "Conversations, Email Inbox, Cases, Episodes",
        "Orders, Shipping Labels, Backorders",
      ],
    },
    {
      label: "Patients & paperwork",
      items: [
        "Patients — the roster and each patient's full timeline",
        "Documents & Packets, Awaiting Signatures, Inbound Faxes",
        "Referral Reviewer and referral sources",
      ],
    },
    {
      label: "Operations",
      items: [
        "Operations — background jobs, integrations, and queue health",
        "Outbound Messages and Delivery Failures",
      ],
    },
    {
      label: "Analytics",
      items: ["Reports and financial analytics", "Performance & Goals"],
    },
  ],
  firstTasks: [
    "Sign in and turn on multi-factor authentication on your own account.",
    "Open Home and learn what each queue counter is telling you.",
    "Work one inbound conversation end to end so you know how a case is opened and closed.",
    "Read a patient's 360° timeline — the whole history is on one screen.",
    "Check Operations once so you recognise what healthy looks like.",
    "Run a report you will be asked for regularly and export it.",
  ],
  customerServiceManual: true,
};

const CSR: StaffRoleProfile = {
  family: "csr",
  title: "Customer service rep",
  summary:
    "You are the patient's first point of contact — messages, orders, scheduling, and day-to-day service.",
  highlights: [
    "Work the inbox: patient texts, emails, and calls arrive in Conversations and Cases.",
    "Look up any patient and read their full 360° timeline before you reply.",
    "Take fit requests from the mask fitter, confirm coverage, and turn them into orders.",
    "Fulfil and ship orders, print labels, and handle returns and backorders.",
    "Schedule follow-ups and video visits, and keep patients moving with reminders and canned replies.",
    "Send document packets for e-signature and triage inbound faxes and referrals.",
  ],
  areas: [
    {
      label: "Daily workspace",
      items: [
        "Home — your queues for today",
        "Conversations and Email Inbox — every patient message in one thread",
        "Cases and Episodes — the work opened from those messages",
      ],
    },
    {
      label: "Schedule & outreach",
      items: [
        "Company Calendar, Video Visits, Follow-ups",
        "Alert Library and Reminders",
        "Playbooks, Canned Replies, Automated Messages",
      ],
    },
    {
      label: "Patients & paperwork",
      items: [
        "Patients and Duplicate Review",
        "Documents & Packets, Awaiting Signatures, Inbound Faxes",
        "Referral Reviewer and referral sources",
      ],
    },
    {
      label: "Orders, catalog & leads",
      items: [
        "Fit Requests — what the mask fitter sends you",
        "Orders, Shipping Labels, Backorders, Catalog",
        "Insurance Leads, Fitter Invites and Prospects",
      ],
    },
  ],
  firstTasks: [
    "Sign in and turn on multi-factor authentication on your own account.",
    "Handle one inbound message from Conversations start to finish.",
    "Look up a patient and read their 360° timeline.",
    "Work a fit request: confirm coverage, then raise the order.",
    "Fulfil and ship an order, and print the label.",
    "Send a document packet for e-signature and watch it come back signed.",
  ],
  customerServiceManual: true,
};

const BILLER: StaffRoleProfile = {
  family: "biller",
  title: "Biller",
  summary:
    "You own the revenue cycle — eligibility, claims, accounts receivable, and getting every dollar collected.",
  highlights: [
    "Verify insurance and work eligibility, discovery, re-verification, and prior authorizations.",
    "Submit claims through the clearinghouse and post ERA (835) remittances.",
    "Work denials and appeals, and let the AI Queue fix and resubmit the routine ones.",
    "Manage A/R aging, timely-filing deadlines, secondary claims, statements, and collections.",
    "Keep billing configuration current, and work from the payer profiles and fee schedules your Owner maintains.",
  ],
  areas: [
    {
      label: "Dashboards",
      items: [
        "Billing Hub — the state of the revenue cycle at a glance",
        "Denials & DSO, Collections Forecast, Payer Profitability",
      ],
    },
    {
      label: "Claim worklists",
      items: [
        "Verify Insurance, Insurance Discovery, Eligibility, Re-verification",
        "Prior Auths, CMN / DIF Worklist, Bill Hold, Auto-submit",
        "AI Queue and the Denials Worklist",
      ],
    },
    {
      label: "A/R & collections",
      items: [
        "A/R Aging, Filing Deadlines, Secondary Claims",
        "Statement Send, Collections, Capped Rentals",
        "ADR / Audit Response and Audit Packet",
      ],
    },
    {
      label: "Tools & configuration",
      items: [
        "ERA Files, Office Ally, Manual Claim",
        "Billing Config — the billing rules and settings you maintain",
        "Payer profiles and fee schedules — your reference while working claims; an Owner makes the edits",
      ],
    },
  ],
  firstTasks: [
    "Sign in and turn on multi-factor authentication on your own account.",
    "Open the Billing Hub and learn what each worklist counter means.",
    "Verify a patient's insurance (270/271) from their chart.",
    "Submit a claim through the clearinghouse and watch it acknowledge.",
    "Post an ERA (835) remittance.",
    "Work a denial: read the reason code, fix it, and refile.",
  ],
  customerServiceManual: false,
};

const RT: StaffRoleProfile = {
  family: "rt",
  title: "Respiratory therapist",
  summary:
    "You keep patients adherent and document the clinical care that backs every claim.",
  highlights: [
    "Document clinical encounters, interventions, and adherence coaching straight into the patient's chart.",
    "Work the clinical outreach list and follow up with patients drifting off therapy.",
    "Read each patient's therapy history and clinical timeline before you act on it.",
    "Triage mask-fit feedback, and override a fitting's recommended mask or size when the clinical picture calls for it.",
    "Curate the mask formulary so the fitter recommends what your practice actually dispenses.",
    "Track your own encounters, patients, and interventions on RT Outcomes.",
  ],
  areas: [
    {
      label: "Clinical work",
      items: [
        "Clinical Encounters — document what you did and what you found",
        "Interventions — the structured plan for a non-adherent patient",
        "Clinical Outreach and Adherence Coaching",
      ],
    },
    {
      label: "Patients & therapy history",
      items: [
        "Patients — the roster and each patient's chart",
        "The clinical timeline and therapy insights on a patient's record",
        "Providers — who is prescribing for your patients",
      ],
    },
    {
      label: "Fitting & formulary",
      items: [
        "Mask-fit feedback and the fit-review queue — yours to sign off",
        "Formulary — the masks the fitter is allowed to recommend",
        "Video Library",
      ],
    },
    {
      label: "Your activity",
      items: ["RT Outcomes — your encounters, patients, and interventions"],
    },
  ],
  extraSections: [
    {
      heading: "What your role does not cover",
      paragraphs: [
        "The population dashboards — Therapy Fleet, Setup Adherence, Resupply Opportunities — along with Recalls, Asset Recovery, and the printable Therapy Report, read from the reporting, returns, and case permissions, which your role does not hold. They are not in your menu, so you will not find them there.",
        "That is by design, not something missing from your account. If you need a population view, ask an Owner or Admin to pull it — or to widen your access if that work has become part of your job.",
      ],
    },
  ],
  firstTasks: [
    "Sign in and turn on multi-factor authentication on your own account.",
    "Open a patient's chart and read their clinical timeline end to end.",
    "Document a clinical encounter on that patient.",
    "Open a non-adherence intervention and work it.",
    "Work the clinical outreach list and log what came of each contact.",
    "Triage a mask-fit feedback item and sign off the fitting.",
  ],
  customerServiceManual: false,
};

const BY_ROLE: Record<AdminRole, StaffRoleProfile> = {
  admin: OWNER,
  supervisor: ADMIN,
  compliance_officer: ADMIN,
  csr: CSR,
  fitter: CSR,
  fulfillment: CSR,
  agent: CSR,
  biller: BILLER,
  rt: RT,
};

/** The job profile for a granular admin role. Legacy role names resolve
 *  to the family they belong to. */
export function staffRoleProfile(role: AdminRole): StaffRoleProfile {
  return BY_ROLE[role] ?? CSR;
}
