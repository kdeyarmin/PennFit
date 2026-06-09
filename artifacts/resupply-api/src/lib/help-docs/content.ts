// Invite help-document content.
//
// When a brand-new user is invited — a patient to their self-service
// portal, or a staff member to the admin console — we attach the
// getting-started help document(s) for *their* user type to the invite
// email. This module owns the copy + the role→document mapping; the
// rendering (to PDF) and email-attachment shaping live in `render.ts`.
//
// Copy here is intentionally static and brand-neutral except for the
// PennPaps product name. No PHI ever appears in a help document — they
// are generic onboarding guides, identical for every recipient of a
// given user type, which is why `render.ts` can safely cache the
// rendered bytes.

import type { AdminRole } from "@workspace/resupply-db";

/** Bump when the copy below changes so cached/rendered bytes refresh
 *  and the document footer advertises the right revision. */
export const HELP_DOC_VERSION = "2026-06-09.v1";

/** A single labelled block of a help document. Mirrors the structured-
 *  content shape the patient-packet templates use (heading + prose +
 *  bullets) so the PDF renderer can stay dumb. */
export interface HelpDocSection {
  heading?: string;
  paragraphs?: string[];
  bullets?: string[];
}

/** One help document. Rendered to a single PDF attachment. */
export interface HelpDoc {
  /** Stable key — also the cache key for the rendered bytes. */
  key: string;
  /** Download filename (without path). */
  filename: string;
  /** Cover title printed at the top of the document. */
  title: string;
  /** One-line subtitle under the title. */
  subtitle: string;
  sections: HelpDocSection[];
}

// ── Patient portal ──────────────────────────────────────────────────

const PATIENT_PORTAL_GUIDE: HelpDoc = {
  key: "patient-portal-guide",
  filename: "PennPaps-Patient-Portal-Guide.pdf",
  title: "Welcome to Your PennPaps Patient Portal",
  subtitle: "A quick guide to getting set up and managing your CPAP supplies.",
  sections: [
    {
      heading: "Setting up your account",
      paragraphs: [
        "Your care team has invited you to the PennPaps patient portal. The invitation email contains a secure link to choose your password — open it on any phone, tablet, or computer to get started.",
        "For your security, that link expires seven days after it is sent. If it expires before you set your password, just contact our team and we'll send you a fresh invitation.",
      ],
    },
    {
      heading: "What you can do in the portal",
      bullets: [
        "See when your CPAP mask, cushions, tubing, and filters are due for replacement.",
        "Confirm or reschedule a resupply shipment with a single tap.",
        "Review your past and pending orders and their delivery status.",
        "Upload your insurance card or a prescription so we can keep your file complete.",
        "Update your shipping address, phone number, and how you'd like us to reach you.",
      ],
    },
    {
      heading: "Staying comfortable on therapy",
      paragraphs: [
        "Replacing your supplies on schedule keeps your equipment hygienic and your therapy effective. The portal reminds you automatically when an item is due, so you never have to track the dates yourself.",
        "If your mask is leaking, your pressure feels off, or you have questions about your therapy, reach out — our team is here to help you stay comfortable and sleeping well.",
      ],
    },
    {
      heading: "Getting help",
      paragraphs: [
        "Have a question? Reply to any PennPaps email or call the number on your welcome message and a member of our team will be glad to assist. We're a real, local team — not a call center.",
      ],
    },
  ],
};

/** Help documents attached to a patient portal invite. */
export const PATIENT_HELP_DOCS: ReadonlyArray<HelpDoc> = [PATIENT_PORTAL_GUIDE];

// ── Staff / admin console ───────────────────────────────────────────

const STAFF_GETTING_STARTED: HelpDoc = {
  key: "staff-getting-started",
  filename: "PennPaps-Team-Getting-Started.pdf",
  title: "Getting Started with the PennPaps Admin Console",
  subtitle: "Everything you need to sign in and find your way around.",
  sections: [
    {
      heading: "Activating your account",
      paragraphs: [
        "Welcome to the PennPaps team. Your invitation email contains a secure link to set your password — it lands you on the admin sign-in page once you've chosen one. The link is valid for seven days; if it expires, ask an administrator to resend your invite.",
        "Sign in at /admin/sign-in. If your account has multi-factor authentication enabled, you'll be prompted to enter a code from your authenticator app after your password.",
      ],
    },
    {
      heading: "Finding your way around",
      bullets: [
        "Patients — search the roster, open a patient chart, and manage their resupply schedule and portal invite.",
        "Orders — review incoming and outgoing orders and their fulfillment status.",
        "Operations — day-to-day dashboards for the team.",
        "Your visible menus depend on your role; if you can't find something you expect, an administrator can adjust your permissions.",
      ],
    },
    {
      heading: "Keeping patient information safe",
      paragraphs: [
        "Patient records contain protected health information (PHI). Only open the records you need for the task in front of you, and never share patient details over unsecured channels.",
        "Use a strong, unique password and enable multi-factor authentication on your account. Lock your screen when you step away, and sign out on shared computers.",
      ],
    },
    {
      heading: "Getting help",
      paragraphs: [
        "Questions about a workflow or your access? Reach out to your administrator or supervisor — they can walk you through any part of the console and adjust your permissions when your responsibilities change.",
      ],
    },
  ],
};

const ADMINISTRATOR_GUIDE: HelpDoc = {
  key: "staff-administrator-guide",
  filename: "PennPaps-Administrator-Guide.pdf",
  title: "PennPaps Administrator Guide",
  subtitle: "Managing your team, roles, and settings.",
  sections: [
    {
      heading: "Managing your team",
      paragraphs: [
        "As an administrator you can invite, re-invite, and remove team members under Team in the admin console. Each invite sends the new member a secure password-setup link and the getting-started guide for their role.",
      ],
      bullets: [
        "Invite a member by email and assign their role — the role controls which parts of the console they can see and change.",
        "Resend an invite if the original link expired before the member set their password.",
        "Revoke a member to immediately end their access and sign out every active session they have.",
      ],
    },
    {
      heading: "Roles and permissions",
      paragraphs: [
        "Roles range from front-line customer-service reps and fitters up to supervisors and administrators. Grant each person the least access they need to do their job, and review your team list periodically to remove anyone who has left.",
        "Only administrators can manage the team or change another member's role, so keep the number of administrators small.",
      ],
    },
    {
      heading: "Account security",
      paragraphs: [
        "Encourage every team member to enable multi-factor authentication. Investigate unexpected sign-in problems promptly, and revoke access the same day someone leaves the organization.",
      ],
    },
  ],
};

/**
 * Return the help document(s) to attach to a staff invite for the
 * given granular admin role. Every staff member gets the general
 * getting-started guide; administrators additionally get the
 * administrator guide.
 */
export function staffHelpDocs(role: AdminRole): ReadonlyArray<HelpDoc> {
  if (role === "admin") {
    return [STAFF_GETTING_STARTED, ADMINISTRATOR_GUIDE];
  }
  return [STAFF_GETTING_STARTED];
}
