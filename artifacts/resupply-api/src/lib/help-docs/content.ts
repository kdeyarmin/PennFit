// Invite help-document content.
//
// When a brand-new user is invited — a patient to their self-service
// portal, or a staff member to the admin console — we attach the
// getting-started help document(s) for *their* user type to the invite
// email. This module owns the copy + the role→document mapping; the
// rendering (to PDF) and email-attachment shaping live in `render.ts`.
//
// Copy here is static and brand-neutral apart from the company name,
// which is a PARAMETER, not a literal. It used to be hardcoded to the
// seed tenant, so every tenant's patients and providers received a PDF
// branded "Penn Home Medical Supply". Each document is therefore a factory taking the
// tenant's own name; `render.ts` keys its byte cache on that name as
// well as the doc + version. No PHI ever appears in a help document —
// they are generic onboarding guides, identical for every recipient of
// a given user type and tenant, which is what makes caching safe.

import type { AdminRole } from "@workspace/resupply-db";

import { staffRoleProfile, type StaffRoleProfile } from "./roles";

/** Bump when the copy below changes so cached/rendered bytes refresh
 *  and the document footer advertises the right revision. */
export const HELP_DOC_VERSION = "2026-08-25.v3";

/** A single labelled block of a help document. Mirrors the structured-
 *  content shape the patient-packet templates use (heading + prose +
 *  bullets) so the PDF renderer can stay dumb. */
export interface HelpDocSection {
  heading?: string;
  paragraphs?: string[];
  bullets?: string[];
  /** Ordered steps, rendered "1. …, 2. …". Use where the order the
   *  reader works through the list is part of the instruction (a
   *  first-week checklist); use `bullets` where it isn't. */
  steps?: string[];
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
  /** One line telling the RECIPIENT what this attachment is, listed
   *  beside the filename in the invite email. A bare filename tells a
   *  new hire nothing about which of three PDFs to open first. */
  description: string;
  sections: HelpDocSection[];
}

// ── Patient portal ──────────────────────────────────────────────────

const PATIENT_PORTAL_GUIDE = (company: string): HelpDoc => ({
  key: "patient-portal-guide",
  filename: `${company}-Patient-Portal-Guide.pdf`,
  title: `Welcome to Your ${company} Patient Portal`,
  subtitle: "A quick guide to getting set up and managing your CPAP supplies.",
  description:
    "Getting set up and managing your supplies in the patient portal.",
  sections: [
    {
      heading: "Setting up your account",
      paragraphs: [
        `Your care team has invited you to the ${company} patient portal. The invitation email contains a secure link to choose your password — open it on any phone, tablet, or computer to get started.`,
        "For your security, that link expires seven days after it is sent. If it expires before you set your password, just contact our team and we'll send you a fresh invitation.",
      ],
    },
    {
      heading: "What you can do in the portal",
      bullets: [
        "See when your CPAP mask, cushions, tubing, and filters are due for replacement.",
        "Confirm or reschedule a resupply shipment with a single tap.",
        "Review your past and pending orders and their delivery status.",
        "See what your insurance was billed — statements, any open balance, and your billing history.",
        "Upload your insurance card or a prescription so we can keep your file complete.",
        "Update your shipping address, phone number, and how you'd like us to reach you.",
        "Message our team directly and keep the whole thread in one place.",
      ],
    },
    {
      heading: "How your supplies are paid for",
      paragraphs: [
        `Everything ${company} sends you is billed to your insurance plan — there is no store, no card to keep on file, and nothing to check out. We confirm what your plan covers before anything ships, so you know where you stand first.`,
        "If your plan leaves you owing something, it appears in your billing history in the portal, and you can always ask us to walk you through it.",
      ],
    },
    {
      heading: "Need a new mask?",
      paragraphs: [
        "If your mask no longer fits or you'd like to try a different style, you can run our virtual fitter from your phone — it measures your face on the device itself, so no photos are ever sent to us, and it suggests the masks most likely to suit you.",
        "At the end you either send us your details or ask us to call. A member of our team then checks your coverage, sorts out the prescription if one is needed, and places the order for you — usually within one business day.",
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
        `Have a question? Reply to any ${company} email or call the number on your welcome message and a member of our team will be glad to assist. We're a real, local team — not a call center.`,
      ],
    },
  ],
});

/** Help documents attached to a patient portal invite. */
export const patientHelpDocs = (company: string): ReadonlyArray<HelpDoc> => [
  PATIENT_PORTAL_GUIDE(company),
];

// ── Provider e-signature portal ─────────────────────────────────────

const PROVIDER_PORTAL_GUIDE = (company: string): HelpDoc => ({
  key: "provider-portal-guide",
  filename: `${company}-Provider-Portal-Guide.pdf`,
  title: `Welcome to the ${company} Provider Portal`,
  subtitle:
    "Reviewing and electronically signing your patients' documents online.",
  description:
    "Activating your portal account and e-signing your patients' documents.",
  sections: [
    {
      heading: "Activating your account",
      paragraphs: [
        `${company} has invited you to its provider portal, where you can review and electronically sign documents for your patients without faxes or paper chasing. Your invitation email contains a secure link to choose your password — your username is your email address.`,
        `The invitation link expires seven days after it is sent. If it expires before you set your password, contact the ${company} team and we'll send a fresh one.`,
        "To protect patient information, the portal uses multi-factor authentication: after enrolling an authenticator app on first sign-in, you'll confirm a six-digit code each time you sign in.",
      ],
    },
    {
      heading: "What you can do in the portal",
      bullets: [
        "See every document awaiting your signature for your patients in a single queue.",
        "Review each item — prescriptions, supply orders, and certificates of medical necessity — before you sign.",
        "Sign electronically with a typed or drawn signature, one document at a time or several at once.",
        `Decline a document back to the ${company} team when something needs to be corrected first.`,
      ],
    },
    {
      heading: "Keeping patient information safe",
      paragraphs: [
        "Documents in the portal contain protected health information (PHI). Use a strong, unique password, keep your authenticator app enrolled, and sign out when you're finished — especially on shared computers.",
      ],
    },
    {
      heading: "Getting help",
      paragraphs: [
        `Questions about a document or the portal itself? Reply to any ${company} email or call the practice and a member of the team will be glad to assist.`,
      ],
    },
  ],
});

/** Help documents attached to a provider portal invite. */
export const providerHelpDocs = (company: string): ReadonlyArray<HelpDoc> => [
  PROVIDER_PORTAL_GUIDE(company),
];

// ── Staff / admin console ───────────────────────────────────────────

/**
 * Turn a job title into the filename fragment used for that role's
 * handbook, e.g. "Customer service rep" → "Customer-Service-Rep".
 */
function titleSlug(title: string): string {
  return title
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("-");
}

/**
 * The activation guide every staff member gets, whatever their job.
 * Deliberately role-NEUTRAL: what the console is, how to get into it,
 * how to keep it secure, and where the rest of the documentation lives.
 * Anything specific to the reader's job belongs in their role handbook
 * below — this document's rendered bytes are cached per tenant, not per
 * role, so role-specific copy here would be served to the wrong role.
 */
const STAFF_GETTING_STARTED = (company: string): HelpDoc => ({
  key: "staff-getting-started",
  filename: `${company}-Team-Getting-Started.pdf`,
  title: `Getting Started with the ${company} Admin Console`,
  subtitle: "Signing in, staying secure, and finding the documentation.",
  description:
    "Read this first: activating your account, signing in, and keeping patient information safe.",
  sections: [
    {
      heading: "What the admin console is",
      paragraphs: [
        `Welcome to the ${company} team. The admin console is where the team runs CPAP resupply day to day: patient records, insurance and claims, orders and shipments, messages and scheduling, and the automations behind them. It runs in any modern browser — there is nothing to install.`,
        "Everything you do is scoped to your role, so you see the parts of the console your job needs and not the rest.",
      ],
    },
    {
      heading: "Activating your account",
      steps: [
        "Open the invitation email and click Set your password. The link is valid for seven days; if it expires, ask an administrator to resend your invite.",
        "Choose a strong, unique password — one you do not use anywhere else.",
        "You will land on the sign-in page. Sign in with your email address as your username and the password you just chose.",
        "Turn on multi-factor authentication from your account settings, and keep your authenticator app to hand. Some workspaces require it before you can continue.",
      ],
    },
    {
      heading: "Signing in from then on",
      paragraphs: [
        "Sign in at the /admin sign-in page of your workspace — the invitation email contains the exact address, and it is worth bookmarking. If multi-factor authentication is enabled on your account, you will enter a six-digit code from your authenticator app after your password.",
        "Forgotten your password? Use Forgot password on the sign-in page. If the reset email does not arrive, check your spam folder, then contact your administrator rather than requesting it repeatedly — once your account is active, an invite can no longer be resent, so they will need to sort the delivery problem out with you directly.",
      ],
    },
    {
      heading: "Keeping patient information safe",
      paragraphs: [
        "Patient records contain protected health information (PHI). Only open the records you need for the task in front of you, and never share patient details over unsecured channels — personal email, personal phones, or chat apps that are not part of the workspace.",
        "Use a strong, unique password and keep multi-factor authentication enabled. Lock your screen when you step away, and sign out on shared computers. If you think an account has been compromised, tell an administrator the same day.",
      ],
    },
    {
      heading: "Where the documentation is",
      bullets: [
        "Your role handbook — attached to your invitation email. It covers what your job involves and where that work lives in the console.",
        "The full User Manual — open Support in the console once you have signed in. It is organised by role and covers every feature, with step-by-step job aides.",
        "The in-app assistant — the floating helper on every console page. Ask it how something works or where to find it, in plain English.",
        "Your administrator or supervisor — they can walk you through any workflow and adjust your access when your responsibilities change.",
      ],
    },
  ],
});

/**
 * The role handbook: what THIS person's job is, where that job lives in
 * the console, and the order worth learning it in. Built from the same
 * role decomposition the comprehensive User Manual is organised by, so
 * day one and day two agree.
 */
const ROLE_HANDBOOK = (
  profile: StaffRoleProfile,
  company: string,
): HelpDoc => ({
  key: `staff-handbook-${profile.family}`,
  filename: `${company}-${titleSlug(profile.title)}-Handbook.pdf`,
  title: `${company} ${profile.title} Handbook`,
  subtitle: `What your role covers and how to work it in the ${company} admin console.`,
  description:
    "Your job in detail: what the role owns, where that work lives in the console, and what to learn first.",
  sections: [
    {
      heading: `Your role: ${profile.title}`,
      paragraphs: [profile.summary],
      bullets: profile.highlights,
    },
    {
      heading: "Where your work lives in the console",
      paragraphs: [
        "These are the areas your role opens. Menus you cannot see are simply not part of your job — if you expect one and it is missing, an administrator can adjust your access.",
      ],
    },
    ...profile.areas.map((group) => ({
      heading: group.label,
      bullets: [...group.items],
    })),
    ...(profile.extraSections ?? []),
    {
      heading: "Your first week",
      paragraphs: [
        "Work through these in order. Each one is covered step by step in the User Manual's job aides for your role.",
      ],
      steps: profile.firstTasks,
    },
    {
      heading: "The full manual for your role",
      paragraphs: [
        profile.customerServiceManual
          ? `The Customer Service Manual is attached to your invitation email — it is the operations manual for the service desk you are joining. For the complete reference, open Support in the console and download the ${company} User Manual: it is organised by role, and the ${profile.title} chapters carry the full feature reference and job aides for your job.`
          : `Open Support in the console and download the ${company} User Manual. It is organised by role — go to the ${profile.title} chapters for the full feature reference and the step-by-step job aides for your job.`,
      ],
    },
    {
      heading: "Working safely with patient information",
      paragraphs: [
        "Patient records contain protected health information (PHI). Open only the records the task in front of you needs, keep multi-factor authentication enabled, and never move patient details onto personal email, personal phones, or unsecured chat.",
      ],
    },
    {
      heading: "Getting help",
      paragraphs: [
        "The in-app assistant sits on every console page — ask it how a feature works or where to find something. For anything it cannot answer, or when your access needs to change, speak to your administrator or supervisor.",
      ],
    },
  ],
});

/**
 * Return the help document(s) to attach to a staff invite for the given
 * granular admin role: the role-neutral activation guide, plus the
 * handbook for the invitee's own job. Every staff role gets a handbook
 * — before this, every non-admin role received the same generic guide
 * and the same Customer Service Manual, so a biller's welcome email
 * explained the service desk and said nothing about the revenue cycle.
 */
export function staffHelpDocs(
  role: AdminRole,
  company: string,
): ReadonlyArray<HelpDoc> {
  const profile = staffRoleProfile(role);
  return [STAFF_GETTING_STARTED(company), ROLE_HANDBOOK(profile, company)];
}
