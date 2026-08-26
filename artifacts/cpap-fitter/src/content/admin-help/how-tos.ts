// Step-by-step how-to guides for the staff Help Center (/admin/resources).
//
// Editorial rules for anything added here:
//   * One task per article, named the way an operator would ask for it
//     ("Verify a patient's insurance", not "Eligibility module").
//   * Every step names the page it happens on and includes that page's
//     real /admin/... path — the renderer links it, so the reader never
//     has to hunt the sidebar.
//   * Only reference pages that actually exist. `admin-help.coverage.test.ts`
//     cross-checks every path against the console's NAV_GROUPS and fails
//     the build on a broken pointer.
//   * Say what the operator sees, not how it is implemented.

import type { HowToGuide } from "./types";

export const HOW_TO_GUIDES: readonly HowToGuide[] = [
  // ---------------------------------------------------------------
  // Getting started
  // ---------------------------------------------------------------
  {
    slug: "finish-workspace-setup",
    title: "Finish setting up your workspace",
    category: "getting-started",
    summary:
      "Work the setup checklist at /admin/setup top to bottom — it shows live status for branding, your domain, phone and fax numbers, your email sender, your billing identity, team, and catalog, and links straight to the page that finishes each row.",
    audience: "Owner or admin",
    timeEstimate: "30–60 minutes, spread over a few days",
    primaryPath: "/admin/setup",
    featured: true,
    prerequisites: [
      "You are signed in as an owner (super-admin) or admin.",
      "You know the business name, support phone, and support email you want patients to see.",
    ],
    steps: [
      {
        title: "Open the checklist",
        body: "Go to Settings → Set up your workspace /admin/setup. Each row reads its status live from your account, so a row only turns green once the thing it describes is genuinely configured. The progress bar counts required rows only; optional rows are marked as such.",
      },
      {
        title: "Set your company information",
        body: "Company information /admin/company-information holds the legal and DBA names, addresses, support phone and email, and the identifiers that print on documents. This is the source every other surface reads from — documents, the storefront, chat, and the branding on outbound SMS and email.",
        callout: {
          tone: "note",
          text: "Fill this in before you send anything to a patient. Until it is set, patient-facing copy falls back to the platform's neutral identity rather than your practice name.",
        },
      },
      {
        title: "Brand the storefront",
        body: "Storefront branding /admin/storefront-branding controls the customer-facing name, logo, and colors on your shop and mask fitter. Upload a logo at least 512px wide with a transparent or white background so it reads well in both the site header and email.",
      },
      {
        title: "Claim your sending identities",
        body: "Three separate pages own the three outbound channels. Each one falls back to the platform's shared number or address until you set your own, so patients see a generic sender until you finish this step.",
        substeps: [
          "Phone & SMS /admin/phone-settings — the number that texts and calls patients.",
          "Fax number /admin/fax-settings — the number used for provider faxes and inbound referrals.",
          "Email From address /admin/email-settings — the From name and address on patient email.",
        ],
        callout: {
          tone: "warning",
          text: "Your email domain must be authenticated (SPF/DKIM) before mail from your own address lands reliably. Saving an unauthenticated address still sends, but it will land in spam. Ask the platform team to verify your domain before you switch.",
        },
      },
      {
        title: 'Set your billing identity — and know which "billing" is which',
        body: "Two different things are both called billing, and they are unrelated. Config → Organization /admin/billing/config/organization is your DME identity as payers see it: legal name, tax ID, organizational NPI, addresses, and accreditation. The claim builder, eligibility checks, and the HCFA PDF all read it, so a claim cannot go out correctly until it is filled in. Plan & billing /admin/billing/package is your own subscription to this platform — its allowances and invoices — and has nothing to do with patient claims.",
        callout: {
          tone: "warning",
          text: "Patients are never charged a card — everything is billed to their insurance — so there is no storefront payment to connect. If Config → Organization is blank, claims go out under whatever fallback the platform has and will be rejected.",
        },
      },
      {
        title: "Invite your team",
        body: "Team /admin/team is where you invite teammates and set their role. Invite the people who will work the queues before you turn messaging on, so inbound replies land in front of somebody.",
      },
      {
        title: "Load your catalog and formulary",
        body: "Mask catalog /admin/fitter/catalog is the shared library of mask models and their fit data. Formulary /admin/fitter/formulary is the subset you actually stock — set it so the fitter prefers masks you can ship today.",
      },
      {
        title: "Turn on only the modules you need",
        body: "Control Center /admin/control-center holds the app-module switches that show or hide whole sections of the sidebar, plus the feature flags. Turning off a module you do not use makes the console noticeably easier for your staff to learn.",
      },
      {
        title: "Stand up resupply automation",
        body: "The setup checklist includes a Resupply automation section: turn on reminder switches, review Frequency rules /admin/rules (Medicare defaults ship preloaded), and add an active prescription per supply line. Importing a patient roster alone does not start reminders.",
      },
    ],
    troubleshooting: [
      {
        symptom: "A row stays red after I saved the page it links to.",
        fix: "Reload /admin/setup — status is fetched when the page loads. If it is still red, the save may have been partial; reopen the linked page and confirm every required field is filled.",
      },
      {
        symptom: "I can't open Configuration or System Configuration.",
        fix: "Those pages are owner-only (super-admin). Ask whoever owns the account, or have them grant you the role from Team /admin/team.",
      },
    ],
    related: ["invite-your-team", "manage-modules-and-flags"],
    keywords: [
      "onboarding",
      "first run",
      "new account",
      "configure",
      "go live",
      "launch",
    ],
  },
  {
    slug: "invite-your-team",
    title: "Add a teammate and set their role",
    category: "getting-started",
    summary:
      "Invite from Team /admin/team, pick the role that matches the work they do, and have them finish setup at Account security /admin/security. Roles decide which pages they can even see.",
    audience: "Admin",
    timeEstimate: "About 5 minutes per person",
    primaryPath: "/admin/team",
    featured: true,
    prerequisites: [
      "You are signed in as an admin — team management is admin-only.",
      "You have the teammate's work email address.",
    ],
    steps: [
      {
        title: "Open Team",
        body: "Settings → Team /admin/team lists everyone with access, their role, and their status. Invite the person by email from here.",
      },
      {
        title: "Choose the right role",
        body: "The role is not cosmetic — it decides which nav entries render at all. Pick the narrowest role that lets the person do their job.",
        substeps: [
          "Owner (super-admin) — everything, including vendor configuration. Keep this to one or two people.",
          "Admin — the full console except the owner-only configuration pages.",
          "CSR — the customer-service desk: conversations, patients, orders, returns.",
          "Clinician (RT) — clinical documentation and patient read; no billing or system settings.",
          "Biller — the Billing area only, plus the billing context on a patient chart. No CSR tools, no clinical, no team or system management.",
        ],
        callout: {
          tone: "note",
          text: "If a teammate says a page is missing, it is almost always their role or a switched-off module — not a bug. Check both before escalating.",
        },
      },
      {
        title: "Have them secure their account",
        body: "Once they sign in, point them at Account security /admin/security to set a strong password and enable multi-factor authentication. Anyone who can read a patient chart should have MFA on.",
      },
      {
        title: "Give them a starting point",
        body: "Send new staff to the user guide in this Help Center and to Home /admin, which is the queue-driven landing page they will live on. A CSR normally starts their day in Conversations /admin/conversations and Follow-ups /admin/followups.",
      },
    ],
    troubleshooting: [
      {
        symptom: "The invite never arrived.",
        fix: "Check Outbound Messages /admin/outbound-messages for the send and its delivery result, then Delivery Failures /admin/delivery-failures. A bounced invite is usually a typo in the address or a corporate spam filter.",
      },
      {
        symptom: "A teammate can sign in but sees almost no sidebar.",
        fix: "Their role is narrower than the work you gave them, or the modules those pages belong to are off in Control Center /admin/control-center. Fix the role first, then the modules.",
      },
    ],
    related: ["finish-workspace-setup", "manage-modules-and-flags"],
    keywords: [
      "user",
      "staff",
      "permissions",
      "role",
      "access",
      "invite",
      "mfa",
    ],
  },
  {
    slug: "navigate-the-console",
    title: "Find your way around the console",
    category: "getting-started",
    summary:
      "The sidebar is grouped by the shape of the work — Workspace, Patients & Clinical, Orders & fulfillment, Billing, Analytics & Reports, System. Use the global lookup in the header to jump straight to a patient, and the in-app assistant when you cannot find a page.",
    audience: "Everyone",
    timeEstimate: "About 10 minutes",
    primaryPath: "/admin",
    prerequisites: ["You have an account and can sign in."],
    steps: [
      {
        title: "Start at Home",
        body: "Home /admin is the landing dashboard: today's work, the queues that need attention, and the signals worth reacting to. If you only check one page each morning, check this one.",
      },
      {
        title: "Learn the six sidebar groups",
        body: "Every page lives in one of six groups, and the group tells you what kind of work it is.",
        substeps: [
          "Workspace — the day-to-day desk: front desk, conversations, cases, schedule, outreach.",
          "Patients & Clinical — the patient roster, paperwork and e-sign, therapy monitoring, and clinical work.",
          "Orders & fulfillment — insurance orders, fulfillment, signature paperwork, inventory, and storefront leads.",
          "Billing — the revenue cycle, front to back, as worklists.",
          "Analytics & Reports — dashboards, the report catalog, goals, and team performance.",
          "System — support, automation, operations, and settings.",
        ],
      },
      {
        title: "Use the global lookup for patients",
        body: "The lookup in the top header jumps straight to a patient record without going through Patients /admin/patients. It is the fastest path when someone is on the phone.",
      },
      {
        title: "Ask the in-app assistant when you are stuck",
        body: "The assistant widget floats on every console page. Ask it where something lives and it answers with the page path as a one-click link. It explains the app — it does not take actions for you.",
        callout: {
          tone: "warning",
          text: "Do not paste a patient's Social Security number, full date of birth, card number, or insurance member ID into the assistant. Describe what you are trying to do instead.",
        },
      },
      {
        title: "Know why a page might be missing",
        body: "Two things hide a page: a permission your role does not hold, and an app module your account switched off in Control Center /admin/control-center. Neither is a bug — check the role first, then the module.",
      },
    ],
    related: ["invite-your-team", "get-help-and-report-a-problem"],
    keywords: [
      "sidebar",
      "navigation",
      "menu",
      "layout",
      "orientation",
      "tour",
    ],
  },
  {
    slug: "get-help-and-report-a-problem",
    title: "Get help, report a problem, or suggest a feature",
    category: "getting-started",
    summary:
      "Ask the in-app assistant first for how-to questions, file a ticket at Support /admin/support when you need a person, and let the assistant forward a feature idea to the owners when the app genuinely cannot do something.",
    audience: "Everyone",
    timeEstimate: "About 2 minutes",
    primaryPath: "/admin/support",
    prerequisites: [],
    steps: [
      {
        title: "Try the assistant for anything how-to",
        body: 'The floating assistant knows every page in the console and the common workflows. It answers on the spot and links you to the page. This is the fastest route for "where do I…" and "what does this worklist mean".',
      },
      {
        title: "File a support ticket when you need a person",
        body: "Support /admin/support takes a request and answers instantly from the same knowledge base when it can; anything it cannot answer goes to a human. You can follow up on the thread and resolve it from the same page.",
      },
      {
        title: "Include what actually helps",
        body: "A good ticket names the page path, what you expected, what happened, and roughly when. Screenshots help. Never include a patient's SSN, full date of birth, member ID, or card number — a patient's initials and the order number are enough to find the record.",
        callout: {
          tone: "warning",
          text: "Support tickets and assistant chats travel outside the app. Keep protected health information out of both.",
        },
      },
      {
        title: "Suggest a feature",
        body: "If a workflow is genuinely missing, tell the assistant. It will summarize the idea back to you and — only after you confirm — email a structured suggestion to the account owners. It never sends silently.",
      },
    ],
    related: ["navigate-the-console"],
    keywords: [
      "support",
      "ticket",
      "bug",
      "feedback",
      "assistant",
      "chat",
      "idea",
    ],
  },

  // ---------------------------------------------------------------
  // Patients & clinical
  // ---------------------------------------------------------------
  {
    slug: "find-and-work-a-patient",
    title: "Find a patient and work their record",
    category: "patients",
    summary:
      "Search from the header lookup or Patients /admin/patients, then use the chart's tabs — timeline, orders, messages, documents, therapy, billing — as the single place you do everything for that person.",
    audience: "Everyone",
    timeEstimate: "About 5 minutes",
    primaryPath: "/admin/patients",
    featured: true,
    prerequisites: [
      "The patient exists in the roster, or you are about to add them.",
    ],
    steps: [
      {
        title: "Find them",
        body: "The global lookup in the top header matches a phone number, an email address, or a record id — not a name. When you have a name, search from Patients /admin/patients instead, which also filters by status and, with multi-branch enabled, by location.",
        callout: {
          tone: "tip",
          text: "Typing a name into the header lookup returns nothing. That is the lookup working as designed, not a missing patient — take the name to /admin/patients.",
        },
      },
      {
        title: "Read the timeline first",
        body: "The chart opens on a combined timeline: orders, messages in and out, documents, therapy data, and billing events in one chronological list. Read the last few entries before you call — it usually answers the question the patient is about to ask.",
      },
      {
        title: "Work from the chart, not from the queues",
        body: "The chart's quick actions do the common things in place: verify insurance, send a fitting invite, start a video visit, log a follow-up, or add a note. Doing it from the chart keeps the record attached to the right person.",
      },
      {
        title: "Leave a trail",
        body: "Log what you did. Follow-ups /admin/followups holds a callback you promised; Episodes /admin/episodes holds an open service episode; Cases /admin/cases links a thread, an order, and a fax that all belong to one issue. A note nobody can find is the same as no note.",
        callout: {
          tone: "tip",
          text: 'If you told a patient "we\'ll call you Tuesday", it belongs in Follow-ups or an Episode — not in your head.',
        },
      },
      {
        title: "Merge duplicates when you spot them",
        body: "Duplicate review /admin/patients/duplicates lists likely duplicate records with the evidence for the match. Merging early avoids split order history and a second set of reminders going to the same person.",
      },
    ],
    troubleshooting: [
      {
        symptom:
          "Search finds nothing but the patient swears they have an account.",
        fix: "If you used the header lookup, remember it does not match names — search again from /admin/patients. Then try their phone number, their maiden or previous name, and /admin/patients/duplicates.",
      },
    ],
    related: ["answer-a-patient-message", "send-a-fitting-invite"],
    keywords: [
      "chart",
      "record",
      "search",
      "lookup",
      "timeline",
      "merge",
      "duplicate",
    ],
  },
  {
    slug: "answer-a-patient-message",
    title: "Answer an inbound patient message",
    category: "patients",
    summary:
      "Work Conversations /admin/conversations as one queue for SMS, MMS, and email. Reply with a canned reply where one fits, and open a Case when the thread needs more than an answer.",
    audience: "CSR or admin",
    timeEstimate: "About 3 minutes per thread",
    primaryPath: "/admin/conversations",
    featured: true,
    prerequisites: [
      "The Conversations module is on for your account.",
      "Your account has a phone number and email sender configured, or replies go out under the platform's.",
    ],
    steps: [
      {
        title: "Open the queue",
        body: "Conversations /admin/conversations is the unified inbox: inbound SMS and MMS threads and email in one list. Filter by channel when you want the email-only view.",
      },
      {
        title: "Read the patient's context before replying",
        body: "Open the linked patient from the thread and skim their timeline. Most inbound messages are about an order that is already in flight, and the answer is on the chart.",
      },
      {
        title: "Reply, using a canned reply where one fits",
        body: "Canned Replies /admin/macros holds the saved macros your team maintains — insert one and edit it rather than retyping. Consistent answers are faster to write and easier to audit.",
        callout: {
          tone: "tip",
          text: "If you find yourself typing the same paragraph a third time, add it to /admin/macros. That is what the library is for.",
        },
      },
      {
        title: "Escalate a thread that is really a case",
        body: "When a thread has grown into an order problem plus a fax plus a billing question, open a Case /admin/cases and link the pieces. A case is tracked to closure; a thread just scrolls away.",
      },
      {
        title: "Close the loop",
        body: "If you promised anything, put it in Follow-ups /admin/followups or Episodes /admin/episodes before you move on. Then mark the thread handled so the next person does not re-answer it.",
      },
    ],
    troubleshooting: [
      {
        symptom: "My reply says it sent but the patient never got it.",
        fix: "Check Outbound Messages /admin/outbound-messages for that send's delivery result, then Delivery Failures /admin/delivery-failures. A hard bounce or a STOP on file will show there.",
      },
      {
        symptom: "A patient replied STOP and now I cannot text them.",
        fix: "That is the platform honoring their opt-out, and it is not overridable from the console. Reach them by email or phone, and ask them to text START if they want texts back on.",
      },
    ],
    related: ["find-and-work-a-patient", "send-a-bulk-campaign"],
    keywords: [
      "inbox",
      "sms",
      "text",
      "email",
      "reply",
      "macro",
      "case",
      "escalate",
    ],
  },
  {
    slug: "send-a-fitting-invite",
    title: "Send someone a mask-fitting link",
    category: "patients",
    summary:
      "Fitter Invites /admin/fitter-invites texts or emails a guided mask-fitting link to anyone — including someone who is not in the system yet. Their scan lands in Fit review /admin/fit-sessions for you to approve.",
    // Sending an invite is gated on conversations.manage, which the
    // clinician role does not hold — it would 403 for an RT.
    audience: "CSR or admin",
    timeEstimate: "About 2 minutes",
    primaryPath: "/admin/fitter-invites",
    featured: true,
    prerequisites: [
      "You have the person's mobile number or email address.",
      "Your formulary is set at /admin/fitter/formulary so the recommendation prefers masks you stock.",
    ],
    steps: [
      {
        title: "Open Fitter Invites",
        body: "Storefront & leads → Fitter Invites /admin/fitter-invites. You can also send an invite from a patient's chart when they already exist in the roster.",
      },
      {
        title: "Enter who it is for",
        body: "Name, date of birth, and the mobile number or email to send to. A person who is not yet a patient is fine — the invite creates the prospect record, and they show up under Fitter Prospects /admin/fitter-leads until they convert.",
      },
      {
        title: "Send the link and tell them what to expect",
        body: "The patient opens the link on their phone and follows a guided scan. It takes a couple of minutes, works in the phone's browser with no app to install, and the camera images never leave their device — only the measurements are sent.",
        callout: {
          tone: "note",
          text: "Good light and holding the phone at eye level make the biggest difference to scan quality. Saying that on the call meaningfully cuts rescans.",
        },
      },
      {
        title: "Watch for the result",
        body: "Completed scans arrive in Fit review /admin/fit-sessions with the measurements, the tier-by-tier reasoning behind the recommendation, and a confidence read. Work that queue rather than waiting for the patient to call back.",
      },
    ],
    troubleshooting: [
      {
        symptom: "The invite text never arrived.",
        fix: "Confirm the number is a mobile line, then check Outbound Messages /admin/outbound-messages for the delivery result. Landlines and some corporate numbers reject SMS silently at the carrier.",
      },
      {
        symptom: "The scan came back with low confidence.",
        fix: "Request a rescan from /admin/fit-sessions and coach the patient on lighting and camera height. Low confidence is the system telling you the measurements are not trustworthy yet.",
      },
    ],
    related: ["review-a-fit-session", "find-and-work-a-patient"],
    keywords: [
      "fitter",
      "scan",
      "mask fitting",
      "invite",
      "link",
      "prospect",
      "lead",
    ],
  },
  {
    slug: "review-a-fit-session",
    title: "Review and approve a mask recommendation",
    category: "patients",
    summary:
      "Fit review /admin/fit-sessions lists every completed scan with its measurements, reasoning, and confidence. Approve the recommendation, override the mask or size, or request a rescan.",
    audience: "Clinician or trained CSR",
    timeEstimate: "About 3 minutes per session",
    primaryPath: "/admin/fit-sessions",
    prerequisites: [
      "A patient has completed a fitting scan.",
      "The clinical module is on and your role includes clinical read access.",
    ],
    steps: [
      {
        title: "Open the worklist",
        body: "Clinical work → Fit review /admin/fit-sessions. Each row is one scan session with its recommendation and how confident the engine is in it.",
      },
      {
        title: "Read the reasoning, not just the answer",
        body: "The session shows the measurements it took and the tier-by-tier reasoning that produced the recommendation — which masks fit the measurements, what was ruled out, and why. A confident recommendation with a clean rationale can be approved as-is.",
      },
      {
        title: "Check the safety screen",
        body: "The magnetic-implant question set covers the patient and their household. If it flagged anything, the recommendation excludes magnetic-clip masks. Do not override that exclusion — Safety screening /admin/fitter/safety-screens shows the question set and its published version.",
        callout: {
          tone: "warning",
          text: "A magnet contraindication applies to people who live with the patient too, not only the patient. Treat a flag as final.",
        },
      },
      {
        title: "Approve, override, or rescan",
        body: "Approve when the reasoning holds. Override the mask or size when you know something the scan cannot see — a documented preference, a facial-hair pattern, a prior failure. Request a rescan when confidence is low or the measurements look implausible.",
      },
      {
        title: "Turn it into an order",
        body: "A patient who finishes a fitting lands in Fit Requests /admin/fitter-requests, where a person places the order — the patient never files their own. Orders that came out of a fitting are listed under Fitter requests /admin/fitter/orders. Track how these turn out in Fitter outcomes /admin/analytics/fitter-outcomes — ordered, kept, or exchanged.",
      },
    ],
    related: ["send-a-fitting-invite", "manage-the-mask-formulary"],
    keywords: [
      "fit",
      "scan",
      "recommendation",
      "approve",
      "override",
      "rescan",
      "mask size",
    ],
  },
  {
    slug: "manage-the-mask-formulary",
    title: "Set which masks the fitter recommends",
    category: "patients",
    summary:
      "Mask catalog /admin/fitter/catalog is the shared library of models and their fit data. Formulary /admin/fitter/formulary is the subset you stock — it nudges near-ties toward what you can ship, and never filters a clinically better mask out.",
    audience: "Clinician or admin",
    timeEstimate: "About 15 minutes",
    primaryPath: "/admin/fitter/formulary",
    prerequisites: ["You know which masks you actually keep in stock."],
    steps: [
      {
        title: "Understand the two lists",
        body: "The catalog is the full mask library — models, size variants, per-variant fit bands, contraindications, and where each figure came from. The formulary is your account's preference layer on top of it.",
      },
      {
        title: "Mark what you stock",
        body: "Formulary /admin/fitter/formulary is where you say which catalog masks you stock or prefer. Keep it honest: a formulary that lists masks you cannot ship produces recommendations you then have to walk back.",
      },
      {
        title: "Know what the preference actually does",
        body: "The formulary is the last tier of the fitting engine and is deliberately bounded — it re-orders masks that are already close on fit. It cannot promote a poorly fitting mask over a well fitting one, so you cannot accidentally recommend the wrong size by stocking it.",
        callout: {
          tone: "note",
          text: "If a mask you do not stock keeps winning, that is the engine saying it fits materially better. Consider stocking it rather than forcing the substitution.",
        },
      },
      {
        title: "Review the effect",
        body: "Fitter outcomes /admin/analytics/fitter-outcomes shows how recommendations actually turned out. A rising exchange rate on one model is the signal to revisit its formulary position.",
      },
    ],
    related: ["review-a-fit-session"],
    keywords: [
      "formulary",
      "catalog",
      "mask",
      "stock",
      "preference",
      "recommendation",
    ],
  },
  {
    slug: "send-a-document-for-signature",
    title: "Send a document out for signature",
    category: "patients",
    summary:
      "Draft the document at Documents /admin/documents, send it as a packet from Document packets /admin/patient-packets, then track it through Awaiting signatures /admin/signature-tracking until it comes back signed.",
    // Sending a packet needs patients.update, and the provider portal
    // needs provider_portal.manage — neither is held by the clinician role.
    audience: "CSR or admin",
    timeEstimate: "About 5 minutes",
    primaryPath: "/admin/patient-packets",
    prerequisites: [
      "The Documents module is on for your account.",
      "The patient record has a current email address or mobile number.",
    ],
    steps: [
      {
        title: "Draft the document",
        body: "Documents /admin/documents is where you draft a CMN, prescription, agreement, or fax cover from your templates. Get the content right here before you send anything.",
      },
      {
        title: "Send it as a packet",
        body: "Document packets /admin/patient-packets bundles what a patient or provider needs to sign into one e-signature request and sends it. Bundling beats sending three separate requests — signature rates drop with every extra link.",
      },
      {
        title: "Track it",
        body: "Awaiting signatures /admin/signature-tracking is everything currently out for a provider signature, with how long it has been waiting. The E-signature portal /admin/provider-portal is the provider-facing staging area and where signed items land.",
      },
      {
        title: "Handle what comes back on paper",
        body: "Faxes return to Inbound faxes /admin/inbound-faxes for triage — returned signature pages, sleep studies, and prescription renewals all arrive there. Work that queue daily; a signed CMN sitting untriaged is a claim you cannot bill.",
        callout: {
          tone: "tip",
          text: "If paperwork is blocking a claim, put the claim on Bill hold /admin/billing/bill-hold instead of letting it age, and release it the moment the document lands.",
        },
      },
    ],
    troubleshooting: [
      {
        symptom: "A provider says they never received the request.",
        fix: "Check /admin/signature-tracking for the send, then Outbound Messages /admin/outbound-messages for its delivery result. Provider offices frequently filter unknown senders — a phone call plus a re-send usually clears it.",
      },
    ],
    related: ["work-inbound-referrals", "submit-a-claim"],
    keywords: [
      "esign",
      "e-signature",
      "cmn",
      "prescription",
      "packet",
      "signature",
      "fax",
    ],
  },
  {
    slug: "work-inbound-referrals",
    title: "Turn an inbound referral into a patient and an order",
    category: "patients",
    summary:
      "Referral reviewer /admin/referral-reviews is the queue for inbound referral faxes. Work each one into a patient record and an order, and keep the sending practice attached so attribution stays accurate.",
    audience: "CSR or intake specialist",
    timeEstimate: "About 10 minutes per referral",
    primaryPath: "/admin/referral-reviews",
    prerequisites: [
      "The Documents module is on and your fax number is configured.",
    ],
    steps: [
      {
        title: "Open the reviewer",
        body: "Documents & e-sign → Referral reviewer /admin/referral-reviews. Each item is an inbound referral waiting to be turned into real work.",
      },
      {
        title: "Match or create the patient",
        body: "Search the roster before creating anything — many referrals are for people you already have. If you do create a record, check Duplicate review /admin/patients/duplicates afterwards.",
      },
      {
        title: "Attach the referring practice",
        body: "Referral sources /admin/referral-sources holds the practices and accounts that send you referrals, and their volume. Attaching the source is what makes that page worth reading — an unattributed referral is invisible in your growth numbers.",
      },
      {
        title: "Check the paperwork before you promise anything",
        body: "Confirm the prescription and any required documentation are present and current. If something is missing, send the request now — Documents /admin/documents to draft, /admin/patient-packets to send — rather than discovering it at billing.",
      },
      {
        title: "Verify coverage, then order",
        body: "Run eligibility at Verify insurance /admin/billing/verify before you set expectations on cost. Then place the order so fulfillment can start.",
      },
    ],
    related: ["send-a-document-for-signature", "verify-a-patients-insurance"],
    keywords: [
      "referral",
      "intake",
      "fax",
      "new patient",
      "provider",
      "source",
    ],
  },
  {
    slug: "schedule-a-video-visit",
    title: "Run a video visit with a patient",
    category: "patients",
    summary:
      "Create the visit from Video visits /admin/video-visits, the header button, or a patient chart. The patient gets a secure join link by text or email — there is nothing for them to install.",
    audience: "Clinician or CSR",
    timeEstimate: "About 3 minutes to schedule",
    primaryPath: "/admin/video-visits",
    prerequisites: [
      "The Schedule module is on for your account.",
      "The patient has a working mobile number or email address.",
    ],
    steps: [
      {
        title: "Create the visit",
        body: 'Schedule → Video visits /admin/video-visits, the "Video visit" button in the top header, or the patient\'s chart. The header button works for someone who is not in the system yet, which is what you want for a walk-in question.',
      },
      {
        title: "Send the join link",
        body: "The patient receives a secure link by text or email. It opens in their phone or computer browser — no app, no account, no password.",
      },
      {
        title: "Put it on the calendar",
        body: "Company Calendar /admin/company-calendar is the shared schedule of patient appointments — fittings, setups, and follow-ups. Scheduling there is what stops two staff from booking the same slot.",
      },
      {
        title: "Document the visit",
        body: "Log what happened in Clinical encounters /admin/clinical so the next person sees it, and put any promise you made into Follow-ups /admin/followups.",
      },
    ],
    troubleshooting: [
      {
        symptom: "The patient's link does not open.",
        fix: "Links are time-limited by design. Re-send from /admin/video-visits rather than reusing an old message, and have them open it in their default browser rather than an in-app one.",
      },
    ],
    related: ["find-and-work-a-patient"],
    keywords: [
      "telehealth",
      "video",
      "visit",
      "appointment",
      "calendar",
      "schedule",
    ],
  },
  {
    slug: "monitor-therapy-adherence",
    title: "Find the patients whose therapy needs attention",
    category: "patients",
    summary:
      "The therapy boards turn device-cloud data into worklists: RT Overview /admin/rt-overview for the daily read, Setup Adherence /admin/therapy-compliance for people at risk of failing their compliance window, and Resupply Opportunities /admin/therapy-resupply for who is due.",
    audience: "Clinician or RT",
    timeEstimate: "About 20 minutes daily",
    primaryPath: "/admin/rt-overview",
    prerequisites: [
      "The Therapy module is on and at least one therapy-cloud integration is connected at /admin/integrations.",
    ],
    steps: [
      {
        title: "Start with the overview",
        body: "RT Overview /admin/rt-overview is the daily read across your monitored patients. Therapy Fleet /admin/therapy-fleet is the same data as a fleet-wide roster when you want to sort and filter rather than triage.",
      },
      {
        title: "Work the compliance window first",
        body: "Setup Adherence /admin/therapy-compliance surfaces the patients inside their initial compliance window who are trending toward failing it. That window closes — a call in week two is worth ten in week twelve.",
        callout: {
          tone: "tip",
          text: "Compliance thresholds differ by payer. Compliance Rules /admin/compliance-rules holds the per-payer minimum hours and nights the boards measure against.",
        },
      },
      {
        title: "Intervene and log it",
        body: "Adherence coaching /admin/coaching and Clinical outreach /admin/clinical/outreach are the outreach surfaces; Interventions /admin/clinical/interventions is where you record what you did. An uncounted intervention cannot be shown to a payer later.",
      },
      {
        title: "Convert usage into resupply",
        body: "Resupply Opportunities /admin/therapy-resupply is who is due for replacement supplies based on real usage rather than a calendar. Work it alongside Reorder Reminders /admin/reorder-reminders.",
      },
      {
        title: "Check whether it worked",
        body: "RT outcomes /admin/rt-outcomes and Therapy Report /admin/therapy-usage-report show whether the interventions moved adherence. If a play is not moving the number, stop running it.",
      },
    ],
    related: ["set-up-resupply-reminders"],
    keywords: [
      "adherence",
      "compliance",
      "therapy",
      "usage",
      "resmed",
      "philips",
      "device data",
    ],
  },

  // ---------------------------------------------------------------
  // Billing
  // ---------------------------------------------------------------
  {
    slug: "verify-a-patients-insurance",
    title: "Verify a patient's insurance right now",
    category: "billing",
    summary:
      "Verify insurance /admin/billing/verify runs a live eligibility check for any patient on demand. The same check is on the patient chart under quick actions and the billing tab.",
    audience: "CSR or biller",
    timeEstimate: "About 2 minutes",
    primaryPath: "/admin/billing/verify",
    featured: true,
    prerequisites: [
      "A clearinghouse connection is configured for your account.",
      "You have the patient's name, date of birth, payer, and member ID.",
    ],
    steps: [
      {
        title: "Open Verify insurance",
        body: "Billing → Worklists → Verify insurance /admin/billing/verify. Search any patient, pick the coverage on file, and run the check.",
      },
      {
        title: "Run it from the chart when you are already there",
        body: "The patient chart has the same one-click check under quick actions and on the Billing tab. Use whichever you are closest to — it is the same request and the same stored result.",
      },
      {
        title: "Read the response properly",
        body: "Active coverage is not the same as covered benefit. Check the deductible position, the copay or coinsurance, and whether the plan needs a prior authorization for the item you are about to supply.",
        callout: {
          tone: "warning",
          text: 'Quoting a patient a price from "coverage is active" alone is how you end up writing off a balance later. Read the benefit detail, not just the status.',
        },
      },
      {
        title: "When you cannot find coverage",
        body: "Insurance discovery /admin/billing/insurance-discovery searches for coverage for a patient who says they have none, or whose plan you cannot identify. Try it before you write the account off as self-pay.",
      },
      {
        title: "Keep it fresh",
        body: "Eligibility /admin/billing/eligibility is the ongoing worklist and Re-verification /admin/billing/eligibility-recheck flags coverage that is stale enough to re-check. Plans change at year end and mid-year far more often than patients report.",
      },
    ],
    troubleshooting: [
      {
        symptom: 'The payer returns "patient not found".',
        fix: "Almost always a demographic mismatch — check the date of birth, the member ID including any alpha prefix, and whether the plan is under a spouse. Try /admin/billing/insurance-discovery if the details look right.",
      },
    ],
    related: ["submit-a-claim", "work-the-denials-worklist"],
    keywords: [
      "eligibility",
      "270",
      "271",
      "coverage",
      "benefits",
      "verify",
      "insurance",
    ],
  },
  {
    slug: "submit-a-claim",
    title: "Take a claim from eligibility to submission",
    category: "billing",
    summary:
      "Confirm coverage, clear a prior auth if the plan needs one, then submit through Auto-submit /admin/billing/auto-submit or Manual claim /admin/billing/manual-claim and watch for the response in ERA files /admin/billing/era.",
    audience: "Biller",
    timeEstimate: "About 10 minutes per claim, less once it is routine",
    primaryPath: "/admin/billing",
    featured: true,
    prerequisites: [
      "Coverage is verified and current.",
      "The clinical documentation the payer requires is on file and signed.",
      "Your payer, HCPCS, and modifier rules are configured at /admin/billing/config.",
    ],
    steps: [
      {
        title: "Confirm eligibility",
        body: "Eligibility /admin/billing/eligibility should be clean for this patient before anything else. A claim built on stale coverage is a denial you already paid to produce.",
      },
      {
        title: "Clear the prior authorization if the plan needs one",
        body: "Prior auths /admin/billing/prior-auths tracks authorization requests and their status. Supplying before an authorization the plan requires is an avoidable write-off.",
      },
      {
        title: "Make sure the paperwork is complete",
        body: "CMN / DIF worklist /admin/billing/cmn tracks the certificates the payer expects. If something is outstanding, park the claim on Bill hold /admin/billing/bill-hold rather than submitting and getting denied.",
      },
      {
        title: "Submit",
        body: "Auto-submit /admin/billing/auto-submit handles the routine volume on your rules. Manual claim /admin/billing/manual-claim is for the one-off that does not fit them. The AI queue /admin/billing/ai-queue proposes codes and edits along the way — review its suggestions rather than accepting them blind.",
      },
      {
        title: "Watch for the response",
        body: "Office Ally /admin/billing/office-ally is the clearinghouse queue — claims out, acknowledgements and remittances back. ERA files /admin/billing/era holds the remittance advice. Denials land on the Denials worklist /admin/billing/denials-worklist.",
        callout: {
          tone: "tip",
          text: "Check acknowledgements, not just payments. A claim rejected at the clearinghouse never reached the payer, and its filing clock is still running.",
        },
      },
      {
        title: "Follow the money",
        body: "A/R aging /admin/billing/aging and Filing deadlines /admin/billing/timely-filing are the two pages that stop a claim from quietly aging out. Check filing deadlines daily.",
      },
    ],
    related: [
      "verify-a-patients-insurance",
      "work-the-denials-worklist",
      "post-an-era",
    ],
    keywords: [
      "claim",
      "837",
      "submit",
      "prior auth",
      "cmn",
      "clearinghouse",
      "office ally",
    ],
  },
  {
    slug: "work-the-denials-worklist",
    title: "Work denials so the winnable ones get won",
    category: "billing",
    summary:
      "Denials worklist /admin/billing/denials-worklist is already ranked by recoverable dollars weighted by win probability — work it top-down, fix the root cause, and check filing deadlines daily.",
    audience: "Biller",
    timeEstimate: "Budget an hour a day",
    primaryPath: "/admin/billing/denials-worklist",
    featured: true,
    prerequisites: [
      "Claims have been submitted and remittances are coming back.",
    ],
    steps: [
      {
        title: "Work the list top-down",
        body: "Denials worklist /admin/billing/denials-worklist is ranked by recoverable dollars weighted by how likely you are to win. The first row is genuinely the best use of your next hour — resist re-sorting it by date or by payer out of habit.",
      },
      {
        title: "Check filing deadlines first thing",
        body: "Filing deadlines /admin/billing/timely-filing shows what is about to age out. A denial you could have won is still lost if the payer's window closes. This page beats the ranking on any day something is close.",
        callout: {
          tone: "warning",
          text: "Timely filing is the one deadline with no appeal. Check it every day, not every week.",
        },
      },
      {
        title: "Fix the cause, not the symptom",
        body: "Before resubmitting, correct the underlying problem — the code, the modifier, the missing document. The AI queue /admin/billing/ai-queue proposes the correction; Config /admin/billing/config is where you fix the rule so the same error stops recurring.",
      },
      {
        title: "Look for the pattern",
        body: "Check whether the same error is queued on other claims. One denial is a task; the same denial twelve times is a configuration problem, and fixing it once is worth more than working all twelve.",
      },
      {
        title: "Park what is genuinely blocked",
        body: "If the blocker is paperwork — an unsigned CMN, a missing prescription — move it to Bill hold /admin/billing/bill-hold and release it the moment the document lands. Do not let it ride on the worklist pretending to be workable.",
      },
      {
        title: "Watch the trend",
        body: "Denials & DSO /admin/billing/denials shows whether your denial rate and days-sales-outstanding are moving. Payer profitability /admin/billing/payer-profitability tells you which payers are worth the effort at all.",
      },
    ],
    related: ["submit-a-claim", "post-an-era", "respond-to-an-adr"],
    keywords: [
      "denial",
      "appeal",
      "rejection",
      "dso",
      "timely filing",
      "resubmit",
      "worklist",
    ],
  },
  {
    slug: "post-an-era",
    title: "Post an ERA and reconcile what the payer paid",
    category: "billing",
    summary:
      "ERA files /admin/billing/era holds the electronic remittance advice. Post it, reconcile each line against what you expected, and route underpayments and denials to the right worklist.",
    audience: "Biller",
    timeEstimate: "About 20 minutes per file",
    primaryPath: "/admin/billing/era",
    prerequisites: ["Claims have been submitted through the clearinghouse."],
    steps: [
      {
        title: "Open the remittance",
        body: "Billing → Tools → ERA files /admin/billing/era lists the remittance advice received from payers. Office Ally /admin/billing/office-ally is the queue those files arrive through.",
      },
      {
        title: "Reconcile line by line, not in total",
        body: "A file that totals correctly can still contain an underpaid line and an overpaid one. The line detail is where the money actually is.",
      },
      {
        title: "Route what is not clean",
        body: "Denied lines go to the Denials worklist /admin/billing/denials-worklist. Patient responsibility moves to Collections /admin/billing/collections. A remaining balance owed by a second plan goes to Secondary claims /admin/billing/secondary.",
        callout: {
          tone: "tip",
          text: "Post secondary claims promptly — the secondary payer's filing clock usually starts at the primary's remittance date, not at your posting date.",
        },
      },
      {
        title: "Check what it did to A/R",
        body: "A/R aging /admin/billing/aging should move after a posting run. If it does not, something did not post. Collections forecast /admin/billing/collections-forecast projects what you should expect to collect next.",
      },
    ],
    related: ["work-the-denials-worklist", "collect-a-patient-balance"],
    keywords: [
      "era",
      "835",
      "remittance",
      "posting",
      "payment",
      "reconcile",
      "secondary",
    ],
  },
  {
    slug: "collect-a-patient-balance",
    title: "Collect a patient balance without losing the patient",
    category: "billing",
    summary:
      "Collections /admin/billing/collections runs the dunning ladder — statement, reminder, second notice, final notice, agency. Send statements from Statement send /admin/billing/statements and review before any agency hand-off.",
    audience: "Biller or admin",
    timeEstimate: "About 30 minutes weekly",
    primaryPath: "/admin/billing/collections",
    prerequisites: [
      "Insurance has adjudicated and a genuine patient balance remains.",
    ],
    steps: [
      {
        title: "Make sure the balance is real",
        body: "Confirm the claim finished adjudicating and any secondary plan has been billed. Chasing a patient for a balance their second plan owes is the fastest way to lose them.",
      },
      {
        title: "Send the statement",
        body: "Statement send /admin/billing/statements issues statements. Collections /admin/billing/collections is the ladder they move along afterwards — statement, reminder, second notice, final notice, agency.",
      },
      {
        title: "Answer the phone call it generates",
        body: "Most statements produce a question, not a payment. Billing notes /admin/billing/notes is the account-level note trail — write down what you told them, because the next person will need it.",
        callout: {
          tone: "tip",
          text: "A payment plan collects far more than a final notice. Offer one before the account escalates, not after.",
        },
      },
      {
        title: "Review before the agency step",
        body: "The agency hand-off export is deliberately gated behind a review. Read the list before it goes — a billing error or an unposted payment sent to collections costs far more than it recovers.",
      },
    ],
    related: ["post-an-era"],
    keywords: [
      "collections",
      "statement",
      "dunning",
      "balance",
      "patient pay",
      "agency",
    ],
  },
  {
    slug: "respond-to-an-adr",
    title: "Respond to a payer documentation request or audit",
    category: "billing",
    summary:
      "ADR / audit response /admin/billing/adr tracks Additional Documentation Requests and their response clocks. Assemble the packet, send it before the deadline, and use Audit readiness /admin/billing/audit-readiness to find the gaps first.",
    audience: "Biller or admin",
    timeEstimate: "About an hour per request",
    primaryPath: "/admin/billing/adr",
    prerequisites: ["Your role includes reports access."],
    steps: [
      {
        title: "Open the request and note the clock",
        body: "ADR / audit response /admin/billing/adr lists open requests with their response deadlines. The deadline is the whole game — a complete packet sent late scores the same as no packet.",
      },
      {
        title: "Assemble exactly what was asked for",
        body: "Pull the prescription, the certificate, the delivery proof, and the clinical documentation that support the billed item. Documents /admin/documents and the patient chart are where they live.",
      },
      {
        title: "Check whether the rest of your billing would survive",
        body: "Audit readiness /admin/billing/audit-readiness assesses whether the documentation behind claims you have already billed would hold up. One ADR is usually a sample — fix the systemic gap it exposes before the payer asks about the rest.",
        callout: {
          tone: "note",
          text: "Treat the first ADR from a payer as a warning about the whole book of business with that payer, not as a one-off.",
        },
      },
      {
        title: "Send and record it",
        body: "Submit the packet, and record what you sent and when. Billing notes /admin/billing/notes is the durable trail; if the payer says they never received it, that record is what you will rely on.",
      },
    ],
    related: ["work-the-denials-worklist", "send-a-document-for-signature"],
    keywords: [
      "adr",
      "audit",
      "documentation request",
      "packet",
      "additional documentation",
    ],
  },

  // ---------------------------------------------------------------
  // Outreach & automation
  // ---------------------------------------------------------------
  {
    slug: "send-a-bulk-campaign",
    title: "Send a bulk SMS or email campaign",
    category: "outreach",
    summary:
      "Build the audience with filters in Bulk Campaigns /admin/bulk-campaigns, sanity-check the count before you write anything, then send. Measure it in Outreach Attribution /admin/analytics/outreach-attribution.",
    audience: "Admin or marketing",
    timeEstimate: "About 20 minutes",
    primaryPath: "/admin/bulk-campaigns",
    featured: true,
    prerequisites: [
      "The Outreach module is on for your account.",
      "Your own phone number and email sender are configured, so the message comes from your brand.",
    ],
    steps: [
      {
        title: "Build the audience first",
        body: "Bulk Campaigns /admin/bulk-campaigns filters by cohort, device type, payer, equipment or mask model, and category. Build the filter before you write the copy — the audience decides what the message should say.",
      },
      {
        title: "Sanity-check the count",
        body: "Read the audience count and ask whether it is plausible. A campaign that was supposed to reach 40 people and shows 4,000 is a filter mistake, and the send is not reversible.",
        callout: {
          tone: "warning",
          text: "Check the count every single time. This is the one step that prevents the mistake nobody recovers from.",
        },
      },
      {
        title: "Pick the channel and the category honestly",
        body: "Choose text or email, and set the category — marketing, service, or compliance and recall — accurately. Consent and quiet hours are enforced by the platform based on that category; mislabeling marketing as service is both a compliance problem and a trust problem.",
      },
      {
        title: "Write one clear message",
        body: "One message with one action beats three reminders. Preview it before sending — Message previews /admin/message-previews renders any automated message with sample data so you see exactly what lands.",
      },
      {
        title: "Throttle and send",
        body: "Set a per-minute throttle so a large send does not arrive as one spike your team cannot answer. Then send, and be staffed for the replies — Conversations /admin/conversations will get busy within minutes.",
      },
      {
        title: "Measure it",
        body: "Outreach Attribution /admin/analytics/outreach-attribution shows what the campaign actually converted. Channel engagement /admin/analytics/channel-engagement shows whether text or email works better for that audience.",
      },
    ],
    troubleshooting: [
      {
        symptom: "Fewer messages went out than the audience count.",
        fix: "Expected. Opt-outs, quiet hours, missing contact details, and hard bounces all remove recipients at send time. /admin/outbound-messages shows the per-recipient result.",
      },
      {
        symptom: "I need to send to exactly one person.",
        fix: "Use the Alert Library /admin/alerts instead. A campaign of one is harder to build and harder to find later.",
      },
    ],
    related: ["set-up-resupply-reminders", "build-an-automation-rule"],
    keywords: [
      "campaign",
      "bulk",
      "blast",
      "sms",
      "email",
      "audience",
      "marketing",
      "throttle",
    ],
  },
  {
    slug: "set-up-resupply-reminders",
    title: "Run the resupply reminder program",
    category: "outreach",
    summary:
      "Turn on reminder automation in Control Center, set cadence in Frequency rules /admin/rules, add an active prescription per supply line, and read results in Reorder Reminders /admin/reorder-reminders. Escalation timing lives in System Configuration → Resupply reminders.",
    audience: "Admin",
    timeEstimate: "About 30 minutes to set up",
    primaryPath: "/admin/setup",
    featured: true,
    prerequisites: [
      "The Outreach module is on.",
      "Your phone number and email sender are configured, so reminders come from your brand.",
      "Patient records carry current contact details.",
      "Each patient has at least one active prescription for the supplies you resupply.",
    ],
    steps: [
      {
        title: "Turn on the core switches",
        body: "Control Center /admin/control-center holds the on/off switches. Apply the recommended preset for your billing plan — it enables SMS reminders, email reminders, and the daily escalation sweep. You can still fine-tune individual flags afterward.",
      },
      {
        title: "Set the cadence in Frequency rules",
        body: "Frequency rules /admin/rules is where reminder cadence and channel are decided — the defaults by therapy type, payer, and how long someone has been a customer. Medicare LCD intervals ship preloaded (filters every 15 days, cushions every 30, masks every 90, etc.). A per-patient override always beats the rule, so the rules are the baseline rather than the last word.",
      },
      {
        title: "Simulate before you rely on it",
        body: 'Rule Tester /admin/rule-tester answers "for a patient like this, which rule fires and what cadence and channel does the worker pick?". It reads the live rules and changes nothing, so run it freely — it is the cheapest way to find a rule that is narrower or broader than you intended.',
        callout: {
          tone: "tip",
          text: "Simulate the awkward cases, not the typical one: a new customer on an unusual payer is where overlapping rules disagree.",
        },
      },
      {
        title: "Add prescriptions — importing patients is not enough",
        body: 'Reminders run per supply line. Each active prescription opens an outreach episode when that item is due. Importing a PacWare roster fills demographics, but it does not start reminders until you record what each person is entitled to resupply — from the patient chart, or when a patient confirms an order.',
        callout: {
          tone: "warning",
          text: "If patients exist but nobody is getting reminders, check for active prescriptions first. The setup checklist at /admin/setup turns green on this row once at least one Rx line is on file.",
        },
      },
      {
        title: "Read the copy that will go out",
        body: "Automated messages /admin/templates holds the system-sent wording. Read it before it goes live and preview it with sample data at Message previews /admin/message-previews — a merge field that fails to resolve is invisible in the editor and obvious to the patient.",
      },
      {
        title: "Tune escalation spacing (optional)",
        body: 'System Configuration /admin/system/configuration → Resupply reminders controls how many days pass between ladder steps (default 3) and when to stop nagging (default 21). Leave the defaults unless your team wants a slower or faster follow-up cadence.',
      },
      {
        title: "Understand the patient's side",
        body: 'The reminder carries a short-lived signed link, and one tap confirms or declines — no sign-in, no password. That single-tap path is why the program works; anything that adds friction cuts the response rate sharply. The links expire by design, so a patient saying "the link doesn\'t work" usually has an old message and needs a fresh send.',
      },
      {
        title: "Measure the funnel, not the sends",
        body: "Reorder Reminders /admin/reorder-reminders shows the ladder — due, reminded, confirmed, shipped — broken down by SMS, email, and voice, so you can see which channel actually drives reorders. If confirmation is falling, change the cadence or the copy, one at a time.",
      },
    ],
    troubleshooting: [
      {
        symptom: "Nobody is getting reminders even though patients are on file.",
        fix: "Confirm each patient has an active prescription for the supply you resupply, that Control Center has SMS/email reminders and escalation dispatch on, and that the episode is past due in Episodes /admin/episodes.",
      },
      {
        symptom: "I can't find where to set the reminder interval.",
        fix: "Cadence lives in Frequency rules /admin/rules. Step spacing (days between SMS, email, and call) lives in System Configuration /admin/system/configuration under Resupply reminders.",
      },
      {
        symptom: "A patient is getting reminders too often.",
        fix: "Simulate them in /admin/rule-tester to see which rule is firing. A per-patient override beats the rule, so check for one before editing a rule that affects everybody.",
      },
    ],
    related: ["send-a-bulk-campaign", "monitor-therapy-adherence"],
    keywords: [
      "reminder",
      "resupply",
      "reorder",
      "cadence",
      "frequency",
      "schedule",
      "funnel",
      "renewal",
    ],
  },
  {
    slug: "build-an-automation-rule",
    title: "Set reminder frequency rules and simulate them",
    category: "outreach",
    summary:
      "Frequency rules /admin/rules set the default reminder cadence and channel by therapy type, payer, and customer tenure. A per-patient override always wins. Rule Tester /admin/rule-tester shows which rule would fire for a hypothetical patient, without changing anything.",
    audience: "Admin",
    timeEstimate: "About 30 minutes",
    primaryPath: "/admin/rules",
    prerequisites: [
      "The Automation module is on and your role includes tools management.",
    ],
    steps: [
      {
        title: "Know what these rules decide",
        body: "Frequency rules /admin/rules answer one question: for this kind of patient, how often do we reach out about resupply, and on which channel. They are matched on therapy type, payer, and how long the person has been a customer.",
      },
      {
        title: "Start broad, then add exceptions",
        body: "A sensible default covering most patients plus a small number of deliberate exceptions is easier to reason about than a rule per segment. Every extra rule is another thing that can overlap with the others.",
      },
      {
        title: "Remember that per-patient overrides win",
        body: "An override on an individual patient beats whatever the rules say. So before editing a rule because one person is getting the wrong cadence, check whether that person simply has an override.",
        callout: {
          tone: "tip",
          text: "One patient with the wrong cadence is usually an override. Everybody with the wrong cadence is a rule.",
        },
      },
      {
        title: "Simulate before and after every change",
        body: "Rule Tester /admin/rule-tester takes a hypothetical patient and reports which rule fires and what cadence and channel the worker would pick. It reads the live rules and modifies nothing, so there is no reason not to run it — do it for the edge cases, where overlapping rules actually disagree.",
      },
      {
        title: "Watch the funnel after it ships",
        body: "Reorder Reminders /admin/reorder-reminders shows whether the change moved confirmations and reorders. Change one thing at a time or the funnel cannot tell you which change did it.",
      },
      {
        title: "Know what lives elsewhere",
        body: "Per-payer adherence thresholds are Compliance Rules /admin/compliance-rules, not these. The wording of what goes out is Automated messages /admin/templates. One-off and batch sends are the Alert Library /admin/alerts and Bulk Campaigns /admin/bulk-campaigns.",
      },
    ],
    troubleshooting: [
      {
        symptom: "I changed a rule and nothing seems different.",
        fix: "Simulate the affected patient shape in /admin/rule-tester. Either another rule is matching first, or that patient carries a per-patient override that beats every rule.",
      },
    ],
    related: [
      "set-up-resupply-reminders",
      "send-a-bulk-campaign",
      "manage-modules-and-flags",
    ],
    keywords: [
      "frequency rule",
      "cadence",
      "channel",
      "rule tester",
      "simulate",
      "override",
      "reminder",
    ],
  },

  // ---------------------------------------------------------------
  // Analytics
  // ---------------------------------------------------------------
  {
    slug: "find-and-read-a-report",
    title: "Find the right report and read it correctly",
    category: "analytics",
    summary:
      "Reports /admin/reports is the catalog. Money questions go to the financial analytics, staff-output questions to Team throughput /admin/productivity, and satisfaction to Customer NPS /admin/nps.",
    audience: "Admin or owner",
    timeEstimate: "About 15 minutes",
    primaryPath: "/admin/reports",
    prerequisites: ["Your role includes reports access."],
    steps: [
      {
        title: "Start at the catalog",
        body: "Reports /admin/reports lists what is available. Browse it once end to end — most people rediscover a report they needed six months earlier.",
      },
      {
        title: "Pick by the question you are asking",
        body: "Different questions live in genuinely different places.",
        substeps: [
          "Are we making money? — Margin & COGS /admin/analytics/margin and Payer profitability /admin/billing/payer-profitability.",
          "Where do patients come from? — Acquisition funnel /admin/analytics/acquisition-funnel and Revenue by source /admin/analytics/revenue-by-source.",
          "Is outreach working? — Outreach Attribution /admin/analytics/outreach-attribution and Channel engagement /admin/analytics/channel-engagement.",
          "Is the team keeping up? — Team throughput /admin/productivity and Live staffing /admin/live-staffing.",
          "Are patients happy? — Customer NPS /admin/nps.",
          "Is therapy working? — Therapy Report /admin/therapy-usage-report and RT outcomes /admin/rt-outcomes.",
        ],
      },
      {
        title: "Read the trend, not the number",
        body: "A single period is almost never actionable. Compare against the previous period and look for the direction of travel — that is what tells you whether something you changed worked.",
        callout: {
          tone: "note",
          text: "Seasonality is real in resupply. Compare to the same month last year as well as to last month before concluding anything.",
        },
      },
      {
        title: "Set targets so the numbers mean something",
        body: "Goals & targets /admin/goals turns a metric into a target you are actually managing against, and KPI alerts /admin/kpi-alerts tells you when one moves past a threshold instead of waiting for someone to check.",
      },
    ],
    related: ["track-team-performance"],
    keywords: [
      "report",
      "analytics",
      "dashboard",
      "kpi",
      "metric",
      "export",
      "trend",
    ],
  },
  {
    slug: "track-team-performance",
    title: "Track how the team is performing",
    category: "analytics",
    summary:
      "Team throughput /admin/productivity shows output per person, Live staffing /admin/live-staffing shows coverage right now, and Goals & targets /admin/goals is where you set what good looks like.",
    audience: "Admin or supervisor",
    timeEstimate: "About 15 minutes weekly",
    primaryPath: "/admin/productivity",
    prerequisites: ["Your role includes metrics or reports access."],
    steps: [
      {
        title: "Look at throughput weekly, not daily",
        body: "Team throughput /admin/productivity shows what each person got through. Daily numbers are noise — one difficult case can dominate a day. Weekly is where a real pattern shows up.",
      },
      {
        title: "Check coverage against the queues",
        body: "Live staffing /admin/live-staffing shows who is on right now. Read it against the queues that are actually backing up in Conversations /admin/conversations and Follow-ups /admin/followups.",
      },
      {
        title: "Set targets and let the app watch them",
        body: "Goals & targets /admin/goals holds the targets. KPI alerts /admin/kpi-alerts notifies you when a metric crosses a threshold, so nobody has to remember to check.",
        callout: {
          tone: "tip",
          text: "Set targets on outcomes — resolved cases, converted reminders — rather than on activity counts. Activity targets reliably produce activity.",
        },
      },
      {
        title: "Use the audit trail for specifics",
        body: "Audit Trail /admin/analytics/audit-trail shows who did what and when. Use it to answer a specific question about a specific record, not as a performance dashboard.",
      },
    ],
    related: ["find-and-read-a-report"],
    keywords: [
      "productivity",
      "throughput",
      "staffing",
      "goals",
      "targets",
      "kpi",
      "audit trail",
    ],
  },

  // ---------------------------------------------------------------
  // System
  // ---------------------------------------------------------------
  {
    slug: "manage-modules-and-flags",
    title: "Turn a feature or a whole section on or off",
    category: "system",
    summary:
      "Control Center /admin/control-center holds both the app-module switches that show or hide entire sidebar sections and the individual feature flags. Turning off what you do not use is the cheapest usability win available.",
    audience: "Admin",
    timeEstimate: "About 10 minutes",
    primaryPath: "/admin/control-center",
    featured: true,
    prerequisites: ["Your role includes tools management."],
    steps: [
      {
        title: "Know the two kinds of switch",
        body: "App modules show or hide a whole section of the console — Conversations, Schedule, Outreach, Documents, Therapy, Clinical, Inventory, Storefront, Automation, Integrations, Support. Feature flags turn individual behaviors on and off inside those sections.",
      },
      {
        title: "Turn off what you genuinely do not use",
        body: "A smaller sidebar is dramatically easier for new staff to learn. If you do not run video visits, turn the module off — you can turn it back on the moment you do.",
        callout: {
          tone: "note",
          text: "Switching a module off hides its pages; it does not delete any data. Turning it back on restores the pages as they were.",
        },
      },
      {
        title: "Use the recommended bundle to start",
        body: "Control Center can apply the bundle recommended for your plan, and it previews the diff before writing anything. Read that preview — it is the fastest way to see what is about to change.",
      },
      {
        title: "Tell your team what changed",
        body: "A page disappearing without warning reads as a bug and generates support tickets. Post the change before you make it.",
      },
    ],
    troubleshooting: [
      {
        symptom: "A teammate says a page vanished.",
        fix: "Check whether its module is off in /admin/control-center, then check their role at /admin/team. It is nearly always one of those two.",
      },
    ],
    related: ["invite-your-team", "finish-workspace-setup"],
    keywords: [
      "feature flag",
      "module",
      "control center",
      "enable",
      "disable",
      "toggle",
      "hide",
    ],
  },
  {
    slug: "brand-outbound-communications",
    title: "Make patient messages come from your brand",
    category: "system",
    summary:
      "Set your own phone number, fax number, and email From address on their three settings pages. Until you do, patients receive messages from the platform's shared sender rather than your practice.",
    audience: "Owner or admin",
    timeEstimate: "About 20 minutes, plus domain verification",
    primaryPath: "/admin/email-settings",
    prerequisites: [
      "Company information /admin/company-information is filled in.",
      "You control the DNS for the email domain you want to send from.",
    ],
    steps: [
      {
        title: "Fill in company information first",
        body: "Company information /admin/company-information supplies the name, addresses, and support contacts that appear in patient-facing copy across documents, the storefront, chat, and messaging. Everything else reads from it.",
      },
      {
        title: "Claim your phone and fax numbers",
        body: "Phone & SMS /admin/phone-settings sets the number that texts and calls patients. Fax number /admin/fax-settings sets the number used for provider faxes and inbound referrals. Each falls back to the platform's number until you set your own.",
      },
      {
        title: "Set your email From address",
        body: "Email From address /admin/email-settings sets the From name and address on patient email. Internal and operational mail — password resets and system alerts — deliberately stays on the platform sender.",
        callout: {
          tone: "warning",
          text: "Authenticate your sending domain (SPF and DKIM) before switching. An unauthenticated From address still sends, but the mail lands in spam — which is worse than sending from the platform address.",
        },
      },
      {
        title: "Brand the storefront to match",
        body: "Storefront branding /admin/storefront-branding sets the customer-facing name, logo, and colors. Matching them to your email and SMS branding is what makes the whole thing read as one business.",
      },
      {
        title: "Verify with a real send",
        body: "Send yourself a message on each channel and read it on a phone. Then check Outbound Messages /admin/outbound-messages to confirm the delivery result matches what you saw.",
      },
    ],
    related: ["finish-workspace-setup"],
    keywords: [
      "branding",
      "from address",
      "sender",
      "phone number",
      "fax",
      "domain",
      "spf",
      "dkim",
    ],
  },
  {
    slug: "connect-an-integration",
    title: "Connect a therapy-cloud, clearinghouse, or partner integration",
    category: "system",
    summary:
      "Integrations /admin/integrations shows every connector and whether it is available. Your own vendor accounts are entered at Configuration /admin/system/configuration, which is owner-only.",
    audience: "Owner",
    timeEstimate: "About 30 minutes per connector, plus vendor paperwork",
    primaryPath: "/admin/integrations",
    prerequisites: [
      "The Integrations module is on and your role includes tools management.",
      "You have an account with the vendor and its credentials in hand.",
    ],
    steps: [
      {
        title: "See what is connected",
        body: "Operations → Integrations /admin/integrations lists the therapy-cloud, payer, and clearinghouse connectors with an availability badge each. Unavailable means it is not configured — the badge deliberately does not say which credential is missing.",
      },
      {
        title: "Enter your own vendor accounts",
        body: "Configuration /admin/system/configuration is where your account's own integration credentials go — therapy-cloud and clearinghouse. It is owner-only, because those credentials reach real patient data.",
        callout: {
          tone: "note",
          text: "Shared platform infrastructure — AI vendors, telephony, email, and payments — is managed by the platform, not here. If one of those is not working, file a ticket at /admin/support.",
        },
      },
      {
        title: "Confirm data is actually flowing",
        body: "For a therapy-cloud connector, check that patients appear on RT Overview /admin/rt-overview and Therapy Fleet /admin/therapy-fleet. For a clearinghouse, run a live check at Verify insurance /admin/billing/verify. A green badge means configured; a real request means working.",
      },
      {
        title: "Watch for silent failures",
        body: "Webhook Deliveries /admin/webhook-deliveries shows inbound partner traffic and whether it was accepted. An integration that stops delivering usually fails quietly — check this page when data goes stale.",
      },
      {
        title: "Rotate credentials without a restart",
        body: "Credentials are read when a request is made, not cached at startup, so updating a credential takes effect immediately. Rotate on the vendor's schedule rather than waiting for an expiry to break something.",
      },
    ],
    related: ["sync-with-pacware", "monitor-therapy-adherence"],
    keywords: [
      "integration",
      "connector",
      "api key",
      "credentials",
      "resmed",
      "philips",
      "clearinghouse",
      "webhook",
    ],
  },
  {
    slug: "sync-with-pacware",
    title: "Exchange data with PacWare",
    category: "system",
    summary:
      "PacWare /admin/pacware is a CSV exchange, not a live connection. Import is fill-only and never overwrites an existing value; every export has a verify step before you download.",
    audience: "Admin or biller",
    timeEstimate: "About 20 minutes per run",
    primaryPath: "/admin/pacware",
    prerequisites: [
      "The Integrations module is on and your role includes tools management.",
      "You can export the relevant report from PacWare as CSV.",
    ],
    steps: [
      {
        title: "Know which system owns what",
        body: "PacWare is the billing and warehouse system of record. This app is the resupply engine. They exchange CSV files because PacWare has no API — nothing is ever pushed automatically.",
      },
      {
        title: "Import patients as a fill-only sync",
        body: "PacWare /admin/pacware imports the patient roster by matching on the PacWare ID. New patients are inserted; existing ones only have blank fields filled. An existing value is never overwritten, which makes re-running an import safe.",
        callout: {
          tone: "note",
          text: "Because import is fill-only, correcting a wrong value here means editing it on the patient record — re-importing will not overwrite it.",
        },
      },
      {
        title: "Always use the verify step on an export",
        body: "The exports — patient roster and the resupply-due worklist — show a preview with a row count and a sample before you download. Read it. A count that is wildly off means your filter is wrong, and you would otherwise find out inside PacWare.",
      },
      {
        title: "Use the ready-to-sync notice as a prompt",
        body: "An opt-in setting surfaces an in-app notice when there is data ready to sync. It is a reminder to run the exchange — it never sends anything on its own.",
      },
      {
        title: "Keep a routine",
        body: "A weekly rhythm beats an occasional big reconciliation. The full column mapping and format details are in the PacWare operator manual under the project's runbooks.",
      },
    ],
    related: ["connect-an-integration"],
    keywords: [
      "pacware",
      "csv",
      "import",
      "export",
      "sync",
      "billing system",
      "roster",
    ],
  },
  {
    slug: "check-operations-health",
    title: "Check whether messages and background work are healthy",
    category: "system",
    summary:
      "Operations /admin/operations is the system overview. Outbound Messages /admin/outbound-messages shows every send with its delivery result, and Delivery Failures /admin/delivery-failures is the queue of what did not land.",
    audience: "Admin",
    timeEstimate: "About 10 minutes daily",
    primaryPath: "/admin/operations",
    prerequisites: [
      "Your role includes tools management for the message-level pages.",
    ],
    steps: [
      {
        title: "Start at Operations",
        body: "System → Operations /admin/operations is the health overview — background jobs, queues, and system signals in one place. Check it before concluding a patient-facing problem is a patient-facing problem.",
      },
      {
        title: "Trace a specific message",
        body: 'Outbound Messages /admin/outbound-messages lists every outbound SMS and email with its delivery result. This is the page that answers "did it actually send?" — and it answers it definitively.',
      },
      {
        title: "Work the failures",
        body: "Delivery Failures /admin/delivery-failures is what did not land. Most entries are fixable contact-detail problems; a cluster with the same cause and timestamp is an integration or vendor issue worth a support ticket.",
        callout: {
          tone: "tip",
          text: "A daily two-minute scan of this page catches problems while they are still one patient rather than one hundred.",
        },
      },
      {
        title: "Check inbound partner traffic",
        body: "Webhook Deliveries /admin/webhook-deliveries shows what partners sent you and whether it was accepted. Stale therapy data or missing inbound orders usually show up here first.",
      },
      {
        title: "Escalate with specifics",
        body: "If it is genuinely a platform problem, file at Support /admin/support with the page path, the time, and an order or message reference — never with patient identifiers.",
      },
    ],
    related: ["get-help-and-report-a-problem", "connect-an-integration"],
    keywords: [
      "operations",
      "health",
      "delivery",
      "failures",
      "queue",
      "worker",
      "webhook",
      "status",
    ],
  },
  // ---------------------------------------------------------------
  // Batch two — workflows that had no guide of their own.
  // ---------------------------------------------------------------
  {
    slug: "open-and-work-a-case",
    title: "Open a case and drive it to closure",
    category: "patients",
    summary:
      "When one problem spans a text, a fax, and a refund, open a Case /admin/cases so it has a persistent home. Set status and priority, link the related threads, orders, and follow-ups, and work it until it closes.",
    audience: "CSR or admin",
    timeEstimate: "About 5 minutes to open, then ongoing",
    primaryPath: "/admin/cases",
    prerequisites: [
      "The Conversations module is on and your role includes case access.",
      "You know which patient the issue belongs to.",
    ],
    steps: [
      {
        title: "Know when a thread has become a case",
        body: 'A single question answered in one reply is a conversation. "Lost order #12345" that involves an SMS thread, a returned fax, and a refund is a case — it spans channels and will outlive today\'s shift.',
        callout: {
          tone: "tip",
          text: "The test is whether the next person picking it up could reconstruct the situation from the thread alone. If not, it needs a case.",
        },
      },
      {
        title: "Open the case",
        body: "Cases /admin/cases holds the multi-channel tickets. Give it a title that describes the patient's problem in their words, not the internal cause you suspect.",
      },
      {
        title: "Set status and priority honestly",
        body: "Priority is how the queue gets sorted, so inflating it just moves the problem. Reserve the top priority for things that are actively harming a patient or costing money right now.",
      },
      {
        title: "Link the pieces",
        body: "Attach the related conversation threads, orders, and follow-ups. That linking is the whole point — it turns scattered artifacts into one story someone else can read.",
      },
      {
        title: "Put dated promises in Episodes or Follow-ups",
        body: "A case tracks the problem; Episodes /admin/episodes hold dated service commitments and Follow-ups /admin/followups hold the callback you promised. Use all three rather than burying a date in a case note.",
      },
      {
        title: "Close it deliberately",
        body: "Close with a resolution the next reader can understand. A case closed with no explanation is worse than one left open — it looks handled when nobody knows what happened.",
      },
    ],
    related: ["answer-a-patient-message", "find-and-work-a-patient"],
    keywords: [
      "case",
      "ticket",
      "escalation",
      "episode",
      "follow-up",
      "issue",
      "multi-channel",
    ],
  },
  {
    slug: "merge-duplicate-patients",
    title: "Merge two records for the same patient",
    category: "patients",
    summary:
      "Duplicate review /admin/patients/duplicates groups likely collisions by the key they share. Pick the survivor, fold the duplicate into it, and the merge repoints every reference at once — the duplicate is closed, not deleted.",
    audience: "CSR or admin",
    timeEstimate: "About 5 minutes per pair",
    primaryPath: "/admin/patients/duplicates",
    prerequisites: [
      "You can confirm the two records really are the same person.",
    ],
    steps: [
      {
        title: "Understand why duplicates happen",
        body: "Intake from faxes and referrals routinely creates a second record for someone you already have — a first-name typo, a maiden versus married last name, a re-keyed phone number. It is a normal side effect of paper intake, not carelessness.",
      },
      {
        title: "Work the collision list",
        body: "Duplicate review /admin/patients/duplicates lists the collisions grouped by the key the records share, so you can see what matched before deciding anything.",
      },
      {
        title: "Confirm before you merge",
        body: "Same name and same city is not proof — families share both. Check date of birth, address, and equipment history together. A wrong merge is far more painful to unpick than a duplicate is to live with.",
        callout: {
          tone: "warning",
          text: "If you are not sure the two records are the same person, leave them. Ask the patient on the next call rather than guessing.",
        },
      },
      {
        title: "Pick the survivor, then merge",
        body: "Choose which record is the primary — usually the one with the richer history and the current insurance — and fold the other into it. The merge repoints every reference atomically, so orders, messages, documents, and claims all follow.",
      },
      {
        title: "Know what happens to the duplicate",
        body: "The folded record is closed, not deleted. That means the merge leaves a trail rather than making history disappear, which matters if anyone ever asks what happened to an old record number.",
      },
    ],
    related: ["find-and-work-a-patient", "work-inbound-referrals"],
    keywords: [
      "duplicate",
      "merge",
      "collision",
      "same patient",
      "two records",
      "intake",
    ],
  },
  {
    slug: "triage-inbound-faxes",
    title: "Triage the inbound fax queue",
    category: "patients",
    summary:
      "Inbound faxes /admin/inbound-faxes lists what arrived with its sender, page count, and status. Open a fax to read the PDF in place, attach it to the right patient, provider, or prescription, then archive it.",
    audience: "CSR or intake specialist",
    timeEstimate: "About 3 minutes per fax",
    primaryPath: "/admin/inbound-faxes",
    prerequisites: [
      "The Documents module is on and your fax number is configured at /admin/fax-settings.",
    ],
    steps: [
      {
        title: "Work the Open filter daily",
        body: "Inbound faxes /admin/inbound-faxes filters by Open, All, or Archived. Open is your queue. A signed certificate sitting untriaged is a claim you cannot bill, so this is a daily job, not a weekly one.",
      },
      {
        title: "Read the fax in place",
        body: "Selecting a row opens the triage view with the PDF embedded, so you can read it and file it without downloading anything.",
      },
      {
        title: "Attach it to the right records",
        body: "Use the search pickers to attach the patient, the provider, and where relevant the prescription. Searching by name is the supported path precisely so nobody has to copy identifiers by hand.",
        callout: {
          tone: "tip",
          text: "If the patient search finds nothing, check Duplicate review /admin/patients/duplicates before creating a new record — inbound paper is the single biggest source of duplicates.",
        },
      },
      {
        title: "Route what is really a referral",
        body: "An inbound referral belongs in Referral reviewer /admin/referral-reviews, which turns it into a patient and an order and keeps the sending practice attached for attribution.",
      },
      {
        title: "Archive when it is filed",
        body: "Archive the fax once it is attached. An accurate Open queue is what makes the daily pass fast; a queue full of already-handled faxes trains people to skim it.",
      },
    ],
    related: ["work-inbound-referrals", "send-a-document-for-signature"],
    keywords: [
      "fax",
      "inbound",
      "triage",
      "attach",
      "archive",
      "sleep study",
      "prescription",
    ],
  },
  {
    slug: "run-an-equipment-recall",
    title: "Work a manufacturer equipment recall",
    category: "patients",
    summary:
      "Record the recall in Recalls /admin/equipment-recalls with its manufacturer, model, and serial criteria, run the scan to find every affected device you dispensed, then notify those patients and work the remediation to completion.",
    audience: "Admin or clinical lead",
    timeEstimate:
      "An hour to set up, then ongoing until every device is resolved",
    primaryPath: "/admin/equipment-recalls",
    prerequisites: [
      "The Providers module is on.",
      "You have the manufacturer's recall notice with the affected models and serial ranges.",
      "Dispensed equipment has been recorded with serial numbers on patient records.",
    ],
    steps: [
      {
        title: "Record the recall",
        body: "Recalls /admin/equipment-recalls lists recalls grouped by status with active ones first, each carrying a severity badge — urgent, priority, or advisory. Add the recall with its manufacturer, model, and any serial criteria, either a range or an explicit list.",
        callout: {
          tone: "note",
          text: "Enter the serial criteria exactly as the manufacturer published them. Too broad and you alarm patients who are not affected; too narrow and you miss some who are.",
        },
      },
      {
        title: "Run the scan",
        body: "Scan the recall to run the match engine against your dispensed equipment. It surfaces every affected serial you supplied, so you learn the size of the problem before you start calling anyone.",
      },
      {
        title: "Know that the scan changes nothing on its own",
        body: "The scan is read-only by design — it identifies affected devices but does not mark them. Moving a specific device to recalled status is a deliberate action taken per device from that patient's Equipment tab, so nobody's record changes without a person deciding.",
        callout: {
          tone: "warning",
          text: "Because the scan does not change device status, the work is not done when the scan finishes. Every affected device still needs a person to act on it.",
        },
      },
      {
        title: "Notify the affected patients",
        body: "Queue notifications from the recall, and track what has gone out against what is still outstanding. Severity should set the channel: an urgent recall warrants a phone call, not only an email nobody opens.",
      },
      {
        title: "Work the remediation to the end",
        body: "Each recall keeps a notification status and remediation log so you can see which patients have been reached and which devices are actually resolved. Work it until every affected device has an outcome — a recall with a notification sent and no follow-through is not a closed recall.",
      },
      {
        title: "Keep the record",
        body: "The recall carries a document joining notifications and remediation per asset. That is what you produce if anyone ever asks how you handled it, so keep the underlying data accurate as you go rather than reconstructing it later.",
      },
    ],
    related: ["recover-rental-equipment", "find-and-work-a-patient"],
    keywords: [
      "recall",
      "safety",
      "manufacturer",
      "serial",
      "notification",
      "remediation",
      "equipment",
    ],
  },
  {
    slug: "coach-a-struggling-patient",
    title: "Run an adherence coaching plan",
    category: "patients",
    summary:
      "Adherence coaching /admin/coaching holds an open plan per patient who is struggling. Create the plan, move it along with the inline state chips as you make contact, and close it with a resolution note.",
    audience: "Clinician, RT, or trained CSR",
    timeEstimate: "About 10 minutes to open, then per-touch",
    primaryPath: "/admin/coaching",
    prerequisites: [
      "The Clinical module is on.",
      "You have a reason to think this patient is struggling — usually from the therapy boards.",
    ],
    steps: [
      {
        title: "Find who needs it",
        body: "Setup Adherence /admin/therapy-compliance surfaces the patients trending toward failing their compliance window, and that window closes. Those are the people worth a coaching plan; a patient who is doing fine does not need one.",
      },
      {
        title: "Open a plan",
        body: "Adherence coaching /admin/coaching has a create form alongside the open-plans queue. One plan per patient per problem — several overlapping plans for one person just splits the history.",
      },
      {
        title: "Work the plan, moving its state as you go",
        body: "Each row carries inline state chips so you advance the plan where you are looking at it. Update it at the time of the contact; a plan updated from memory at the end of the week is not reliable.",
        callout: {
          tone: "tip",
          text: "Ask what specifically is going wrong before proposing anything. Mask discomfort, pressure intolerance, and dryness look identical in the usage data and need completely different fixes.",
        },
      },
      {
        title: "Use the right tool for the actual problem",
        body: "A fit problem is a rescan or a size override — Fit review /admin/fit-sessions. A comfort or habit problem is coaching plus education from the Video library /admin/clinical/education-videos. A clinical problem belongs with the prescribing physician, not with this console.",
      },
      {
        title: "Record the intervention",
        body: "Log what you did in Interventions /admin/clinical/interventions. An intervention that was never recorded cannot be shown to a payer later, and it is invisible in RT outcomes /admin/rt-outcomes.",
      },
      {
        title: "Close with a resolution note",
        body: "Closing a plan prompts for a resolution note — write it for the next person. Closed plans hide behind a toggle so the working queue stays honest.",
      },
    ],
    related: ["monitor-therapy-adherence", "review-a-fit-session"],
    keywords: [
      "coaching",
      "adherence",
      "compliance",
      "plan",
      "intervention",
      "struggling",
      "outreach",
    ],
  },
  {
    slug: "manage-document-retention",
    title: "Place a legal hold or destroy an expired document",
    category: "patients",
    summary:
      "Retention /admin/documents/retention lists documents whose retention clock is up or close. A legal hold needs a reason and blocks destruction; destruction is admin-only, requires the sweep to have marked the row, and makes you type DESTROY.",
    audience: "Admin or compliance owner",
    timeEstimate: "About 20 minutes per review pass",
    primaryPath: "/admin/documents/retention",
    prerequisites: [
      "Your role includes audit export access — the page is gated on it.",
      "You know your own retention obligations; the app enforces the workflow, not your policy.",
    ],
    steps: [
      {
        title: "Review what is coming due",
        body: "Retention /admin/documents/retention shows patient documents whose retention clock has expired or is close. Review it on a schedule rather than reacting to a prompt.",
      },
      {
        title: "Place a hold on anything under dispute",
        body: "A legal hold requires a reason and blocks destruction. Anything touched by an open dispute, an audit, a payer request, or a potential claim goes on hold before anything else is considered.",
        callout: {
          tone: "warning",
          text: "When in doubt, hold. Destroying a document that later turns out to be needed is not recoverable; keeping one slightly too long almost never is a problem.",
        },
      },
      {
        title: "Understand the destruction gate",
        body: "Destruction is one-way and deliberately hard to do by accident: it is admin-only, it only becomes available once the retention sweep has marked the row as eligible, and you must type DESTROY to confirm. You cannot destroy something just because you think its time is up.",
      },
      {
        title: "Release holds when the reason ends",
        body: "A hold placed for a dispute that settled two years ago is just an unreviewed backlog. Release holds as their reasons close, and record why.",
      },
    ],
    related: ["send-a-document-for-signature", "respond-to-an-adr"],
    keywords: [
      "retention",
      "legal hold",
      "destroy",
      "documents",
      "purge",
      "compliance",
      "audit",
    ],
  },
  {
    slug: "work-insurance-leads",
    title: "Work the insurance-coverage lead queue",
    category: "orders",
    summary:
      "Insurance Leads /admin/shop/insurance-leads collects everyone who asked whether their plan covers supplies. Work it top-down, run a real eligibility check, and record the outcome with a note so the next person is not starting over.",
    audience: "CSR",
    timeEstimate: "About 10 minutes per lead",
    primaryPath: "/admin/shop/insurance-leads",
    prerequisites: [
      "The Storefront module is on.",
      "A clearinghouse connection is configured, so you can actually answer the question.",
    ],
    steps: [
      {
        title: "Understand what these people asked",
        body: "Insurance Leads /admin/shop/insurance-leads is the durable queue behind the coverage form on your public site. Everyone in it raised their hand and asked a specific question — this is the warmest list you have.",
      },
      {
        title: "Work it while it is fresh",
        body: "The KPI strip and status filter let you see what is outstanding. Answer quickly: someone who asked about coverage on Monday has usually called a competitor by Thursday.",
        callout: {
          tone: "tip",
          text: "Speed matters more than polish on this queue. A same-day call with a partial answer beats a perfect answer next week.",
        },
      },
      {
        title: "Actually check, do not guess",
        body: "Run the real check at Verify insurance /admin/billing/verify. If you cannot identify their plan, Insurance discovery /admin/billing/insurance-discovery is the next step before you write them off as self-pay.",
      },
      {
        title: "Answer the benefit, not just the status",
        body: "Active coverage is not the same as a covered benefit. Tell them the deductible position and the copay or coinsurance, because that is the number they are actually asking about.",
      },
      {
        title: "Record the outcome inline",
        body: "Set the row's status and leave a note. The note is what stops the next person from repeating the same eligibility call to the same patient a week later.",
      },
    ],
    related: ["verify-a-patients-insurance"],
    keywords: [
      "insurance lead",
      "coverage",
      "form",
      "prospect",
      "queue",
      "eligibility",
      "self-pay",
    ],
  },
  {
    slug: "recover-rental-equipment",
    title: "Recover a rental device from a patient who stopped therapy",
    category: "orders",
    summary:
      "Asset recovery /admin/asset-recovery is the human action queue that moves a device from identified through to received and redeployed, so a machine sitting in a closet becomes one you can refurbish and place again.",
    audience: "CSR with case management access",
    timeEstimate: "About 10 minutes to open, then weeks of follow-up",
    primaryPath: "/admin/asset-recovery",
    prerequisites: [
      "The Providers module is on and your role includes case access.",
      "Creating and advancing a recovery needs case-management permission, not just read.",
    ],
    steps: [
      {
        title: "Let the system surface the candidates",
        body: "The platform already detects likely discontinuation from low-usage signals and lapsed-customer patterns. Asset recovery /admin/asset-recovery is where a person acts on that — it is the action queue, not the detector.",
      },
      {
        title: "Confirm before you ask for the device back",
        body: "Low usage is a signal, not a verdict. A patient who was in hospital for a month, or who is struggling with a mask and about to give up, needs a coaching call — not a collection letter.",
        callout: {
          tone: "warning",
          text: "Check Adherence coaching /admin/coaching and the therapy boards first. Asking for the machine back from someone who was about to restart therapy is the fastest way to end their therapy for good.",
        },
      },
      {
        title: "Open the recovery",
        body: "Open a recovery case for the device. It carries the machine through the stages, so at any point you can see how many devices are identified versus actually back on your shelf.",
      },
      {
        title: "Make returning it easy",
        body: "Send the shipping label rather than asking them to arrange it — Shipping labels /admin/shipping. Every step of friction you remove measurably raises the number of devices that actually come back.",
      },
      {
        title: "Advance it to received and redeployed",
        body: "Move the recovery along as the device arrives and is refurbished. The value is only realised at the end of that chain; a recovery that stops at identified has recovered nothing.",
      },
    ],
    related: ["run-an-equipment-recall", "monitor-therapy-adherence"],
    keywords: [
      "asset recovery",
      "rental",
      "return device",
      "discontinued",
      "refurbish",
      "redeploy",
      "machine",
    ],
  },
  {
    slug: "get-a-prior-authorization",
    title: "Get a prior authorization before you supply",
    category: "billing",
    summary:
      "Prior auths /admin/billing/prior-auths is five buckets in the order they need attention — missed SLA, at-risk SLA, awaiting decision, expiring approvals, and drafts. Work them top-down.",
    audience: "Biller",
    timeEstimate: "About 30 minutes daily",
    primaryPath: "/admin/billing/prior-auths",
    prerequisites: [
      "Coverage is verified and you know the plan requires an authorization for this item.",
      "The clinical documentation supporting medical necessity is on file.",
    ],
    steps: [
      {
        title: "Work the buckets in order",
        body: "The queue is organized by urgency, and the order is the recommendation.",
        substeps: [
          "Missed SLA — past the target with no decision. These draw regulator attention; chase the payer's portal directly.",
          "At-risk SLA — two days or fewer remaining. Chase before they become missed.",
          "Awaiting — submitted, no decision yet. Check, do not re-submit.",
          "Expiring — approved, but the approval runs out within about a month. Re-authorize before the next dispense.",
          "Drafts — captured but never submitted. The most wasteful bucket, because the work is done and the clock is not running.",
        ],
      },
      {
        title: "Submit with the documentation attached",
        body: "Most authorization denials are documentation problems, not medical-necessity disagreements. Attach the prescription, the sleep study, and the clinical notes the payer's policy asks for, the first time.",
      },
      {
        title: "Never supply ahead of a required authorization",
        body: "Supplying before an authorization the plan requires is an avoidable write-off — the payer is entitled to refuse, and usually will. If the patient needs the item urgently, that is a business decision to make consciously, not a workflow shortcut.",
        callout: {
          tone: "warning",
          text: '"We\'ll get the auth after" is how unbillable inventory leaves the building. If you supply anyway, record why, so nobody is surprised at write-off time.',
        },
      },
      {
        title: "Watch the expiring bucket like a calendar",
        body: "An approval that lapses between dispenses turns a routine resupply into a denial. The expiring bucket exists so that never surprises you — treat it as scheduled work.",
      },
      {
        title: "Work a specific patient from their chart",
        body: "Rows deep-link to the patient record, which is where the supporting documentation and the coverage detail live. Work from the chart when you are dealing with one case rather than clearing a queue.",
      },
    ],
    related: ["submit-a-claim", "verify-a-patients-insurance"],
    keywords: [
      "prior auth",
      "authorization",
      "pa",
      "sla",
      "expiring",
      "approval",
      "medical necessity",
    ],
  },
  {
    slug: "bill-a-secondary-payer",
    title: "Bill the secondary payer after the primary pays",
    category: "billing",
    summary:
      "Secondary claims /admin/billing/secondary lists paid primary claims that carry a secondary coverage and a remaining patient balance, ranked by recoverable dollars. Generating one copies the lines and snapshots the primary's adjudication into a draft you review and submit.",
    audience: "Biller",
    timeEstimate: "About 20 minutes per batch",
    primaryPath: "/admin/billing/secondary",
    prerequisites: [
      "The primary payer has paid and the remittance is posted.",
      "The patient's secondary coverage is recorded.",
      "Generating a secondary claim needs tools-management permission; viewing needs reports access.",
    ],
    steps: [
      {
        title: "Understand what is on the list",
        body: "Secondary claims /admin/billing/secondary shows claims the primary actually paid, where a secondary coverage exists and a patient-responsibility balance remains — ranked by recoverable balance, so the top row is the best use of your time.",
      },
      {
        title: "Generate the secondary claim",
        body: "Generating copies the line items and snapshots the primary's adjudication for the coordination-of-benefits loop, producing a draft. It does not submit anything — the draft is deliberately yours to review.",
      },
      {
        title: "Review the draft before submitting",
        body: "Check that the primary's payment and adjustments carried across correctly, then submit through your normal batch path. A secondary claim with a wrong primary adjudication is rejected rather than merely underpaid.",
      },
      {
        title: "Do it promptly — the clock started earlier than you think",
        body: "The secondary payer's filing window usually starts at the primary's remittance date, not at your posting date. A month of sitting on posted remittances quietly eats most of the window.",
        callout: {
          tone: "warning",
          text: "Treat secondary generation as part of your posting routine, not as a separate task for later. That single habit change recovers more than most denial work does.",
        },
      },
      {
        title: "Only then bill the patient",
        body: "Once the secondary has adjudicated, whatever remains is genuinely the patient's — Collections /admin/billing/collections. Statementing a balance a second plan owes is the fastest way to lose a patient's trust.",
      },
    ],
    related: ["post-an-era", "collect-a-patient-balance"],
    keywords: [
      "secondary",
      "cob",
      "coordination of benefits",
      "crossover",
      "primary paid",
      "balance",
    ],
  },
  {
    slug: "manage-capped-rentals",
    title: "Keep capped rentals on track",
    category: "billing",
    summary:
      "Capped rentals /admin/billing/capped-rentals tracks each rental through its 13- and 36-month lifecycle. A daily job advances the cycles on its own; the page is where you see the state, catch an exception, and correct one.",
    audience: "Biller",
    timeEstimate: "About 20 minutes weekly",
    primaryPath: "/admin/billing/capped-rentals",
    prerequisites: [
      "Rental items are being billed and their cycles have started.",
    ],
    steps: [
      {
        title: "Know what is automatic",
        body: "A daily job advances rental cycles by itself. You are not expected to tick months forward by hand — the page exists so you can see the state, spot an exception, and override when reality diverges from the schedule.",
      },
      {
        title: "Review the state weekly",
        body: "Capped rentals /admin/billing/capped-rentals shows where every rental sits in its cycle. Weekly is enough to catch problems while they are still one or two months of revenue.",
      },
      {
        title: "Look for cycles that stalled",
        body: "A rental that stopped advancing usually means the underlying billing stopped — a claim on hold, a lapsed authorization, or a patient who moved. Trace it back rather than correcting the cycle and moving on.",
        callout: {
          tone: "tip",
          text: "A stalled cycle is a symptom. Fixing the cycle without fixing the cause means it stalls again next month.",
        },
      },
      {
        title: "Watch the transition points",
        body: "The end of a capped period changes what you may bill and what you owe the patient in service. Those transitions are where the money and the compliance risk both concentrate, so review them before they arrive rather than after.",
      },
      {
        title: "Correct deliberately, and leave a note",
        body: "When you override a cycle, record why in Billing notes /admin/billing/notes. A corrected cycle with no explanation is indistinguishable from a bug when someone reviews it a year from now.",
      },
    ],
    related: ["submit-a-claim", "post-an-era"],
    keywords: [
      "capped rental",
      "13 month",
      "36 month",
      "cycle",
      "rental",
      "lifecycle",
      "oxygen",
    ],
  },
  {
    slug: "configure-billing-rules",
    title: "Configure the rules that build your claims",
    category: "billing",
    summary:
      "Config /admin/billing/config is the landing grid for the settings behind the claim scrubber, claim builder, fee-schedule lookups, and denial analyzer. Fixing a rule here stops a recurring denial at its source.",
    audience: "Billing manager or admin",
    timeEstimate: "About an hour per surface",
    primaryPath: "/admin/billing/config",
    prerequisites: [
      "You have the payer's current policy or fee schedule in hand.",
      "You have identified a specific recurring problem — this is not a page to browse and adjust speculatively.",
    ],
    steps: [
      {
        title: "Start from a denial pattern, not from the page",
        body: "The reason to open Config /admin/billing/config is that the same denial keeps appearing on the Denials worklist /admin/billing/denials-worklist. Configuration changes made without that evidence tend to create the next recurring denial.",
      },
      {
        title: "Know which surfaces you can edit",
        body: "Organization identity, the clearinghouse connection, payer profiles, and fee schedules are editable from their own sub-pages. Modifier rules, denial codes, and claim templates are shown read-only — they are maintained centrally, and their pages let you see which rule actually fired.",
        callout: {
          tone: "note",
          text: "If the fix belongs in a read-only surface, that is a support request rather than a configuration change. Raise it at /admin/support with the claim and the rule that fired.",
        },
      },
      {
        title: "Change one thing at a time",
        body: "These settings drive the scrubber, the claim builder, the fee-schedule lookup, and the denial analyzer together. Change several at once and the next batch tells you nothing about which change helped.",
      },
      {
        title: "Verify on the next batch",
        body: "Watch the specific denial you were targeting on the next submission cycle. If it recurs, the rule was not the cause — go back to the claim and read what actually fired.",
      },
    ],
    related: ["work-the-denials-worklist", "submit-a-claim"],
    keywords: [
      "config",
      "hcpcs",
      "modifier",
      "fee schedule",
      "payer",
      "scrubber",
      "claim template",
      "denial code",
    ],
  },
  {
    slug: "build-your-reply-library",
    title: "Build the reply library your team actually uses",
    category: "outreach",
    summary:
      "Canned Replies /admin/macros holds the one-line answers your team reaches for, Playbooks /admin/playbooks holds multi-touch outreach for a situation, and Automated messages /admin/templates holds the copy the system sends on its own.",
    audience: "Admin or team lead",
    timeEstimate: "About an hour to set up, then ongoing",
    primaryPath: "/admin/macros",
    prerequisites: [
      "The Outreach module is on and your role includes tools management.",
    ],
    steps: [
      {
        title: "Know which of the three you need",
        body: "The three surfaces solve genuinely different problems, and putting content in the wrong one is why libraries go stale.",
        substeps: [
          "Canned Replies /admin/macros — a single saved answer a CSR inserts into a reply they are writing now.",
          "Playbooks /admin/playbooks — a multi-touch sequence for a situation, with a cadence, a channel per touch, and wording for each.",
          "Automated messages /admin/templates — the copy the system sends without a person involved.",
        ],
      },
      {
        title: "Write macros from real replies",
        body: "The best macro is a message somebody already sent well. When you notice the same paragraph typed a third time, save it. Macros invented in a meeting are the ones nobody uses.",
      },
      {
        title: "Disable rather than delete",
        body: "Macros can be disabled, and inactive ones stay listed separately so you can bring one back. Disabling keeps the picker clean without losing wording you may want in six months.",
        callout: {
          tone: "tip",
          text: "A picker with eighty macros is a picker nobody scrolls. Prune aggressively — the library's value is in what is easy to find, not in what it contains.",
        },
      },
      {
        title: "Build playbooks for situations you handle repeatedly",
        body: "A playbook carries a suggested cadence as day offsets, the channel for each touch, and editable wording. Its Active runs view shows what is in flight and what the next touch is, and the Call queue lists the phone touches that are due with the script rendered.",
      },
      {
        title: "Preview automated copy before it ships",
        body: "Read every template in Automated messages /admin/templates and render it with sample data at Message previews /admin/message-previews. A merge field that does not resolve is invisible in the editor and obvious to the patient.",
      },
    ],
    related: [
      "answer-a-patient-message",
      "send-a-bulk-campaign",
      "set-up-resupply-reminders",
    ],
    keywords: [
      "macro",
      "canned reply",
      "playbook",
      "template",
      "library",
      "cadence",
      "call script",
    ],
  },
  {
    slug: "act-on-customer-feedback",
    title: "Read your NPS and actually act on it",
    category: "analytics",
    summary:
      "Customer NPS /admin/nps shows the headline score, the promoter/passive/detractor split, and — the part that matters — the recent comments. Read the comments in one sitting and route what they surface.",
    audience: "Owner, admin, or team lead",
    timeEstimate: "About 30 minutes monthly",
    primaryPath: "/admin/nps",
    prerequisites: [
      "Post-delivery follow-up is running, so responses are coming in.",
    ],
    steps: [
      {
        title: "Look at the score, briefly",
        body: "Customer NPS /admin/nps shows the score for the window — the promoter percentage minus the detractor percentage — with the counts in each band. Note the direction of travel and move on; the number is a thermometer, not a diagnosis.",
      },
      {
        title: "Read the comments properly",
        body: "The comment tail is the reason the page exists. Read it in one sitting rather than a couple at a time, because the pattern across twenty comments is the finding — no individual comment is.",
        callout: {
          tone: "tip",
          text: "Read detractor and promoter comments together. What promoters praise tells you what to protect when you change something.",
        },
      },
      {
        title: "Route what the comments actually say",
        body: "Fit complaints belong with Mask-fit feedback /admin/clinical/mask-fit and Fit review /admin/fit-sessions. Shipping complaints belong with the order and its tracking in Shipping labels /admin/shipping. Billing surprises usually mean coverage was quoted from eligibility status rather than benefit detail.",
      },
      {
        title: "Close the loop with detractors",
        body: "Somebody who took the time to complain is usually still recoverable. A call within a few days converts a meaningful share of them; a survey nobody responded to converts none.",
      },
      {
        title: "Track whether it moved",
        body: "Set a target in Goals & targets /admin/goals and check the trend next month. If a change you made did not move the number, stop doing it rather than doing more of it.",
      },
    ],
    related: ["find-and-read-a-report"],
    keywords: [
      "nps",
      "survey",
      "feedback",
      "promoter",
      "detractor",
      "satisfaction",
      "comments",
    ],
  },
  {
    slug: "set-closures-and-hours",
    title: "Tell the system when you are closed",
    category: "system",
    summary:
      "Closures /admin/closures declares the windows when your office is shut. While a window is active, an inbound text gets your configured auto-reply instead of silence — and recurring windows cover the holidays you close every year.",
    audience: "CSR lead or admin",
    timeEstimate: "About 20 minutes once, then a few minutes per closure",
    primaryPath: "/admin/closures",
    prerequisites: [
      "Your phone number is configured at /admin/phone-settings.",
    ],
    steps: [
      {
        title: "Declare the window",
        body: "Closures /admin/closures is where you schedule the times you are shut — federal holidays, a snow day, an all-hands offsite. Anyone who can work the inbox should be able to add one; a closure nobody declared is the one that hurts.",
      },
      {
        title: "Write the auto-reply the patient will get",
        body: 'While the window is active, an inbound text receives your configured auto-reply. Say when you reopen and what to do if it cannot wait — a bare "we\'re closed" leaves someone with a broken machine no better off.',
        callout: {
          tone: "note",
          text: "Opt-out and help keywords are handled by the platform and are never replaced by a closure reply, so a patient can still text STOP while you are closed.",
        },
      },
      {
        title: "Set the recurring ones once",
        body: "Closures can repeat, so the holidays you close every year are worth setting up once. A year of holidays entered in one sitting beats remembering the day before each one.",
      },
      {
        title: "Enter unplanned closures the moment you know",
        body: "A snow day entered at 8am does its job. Entered at 4pm, it has only told the patients who texted after everyone went home.",
      },
      {
        title: "Check what happened when you reopen",
        body: "Work the backlog in Conversations /admin/conversations first thing, and glance at Outbound Messages /admin/outbound-messages to confirm the auto-replies actually went out.",
      },
    ],
    related: ["answer-a-patient-message", "brand-outbound-communications"],
    keywords: [
      "closure",
      "holiday",
      "hours",
      "closed",
      "auto-reply",
      "out of office",
      "snow day",
    ],
  },
  {
    slug: "secure-your-account",
    title: "Secure your own account with multi-factor authentication",
    category: "system",
    summary:
      "Account security /admin/security is where you enroll an authenticator app, check your status, and disable it if you change devices. Enrollment is not yet enforced at sign-in, so it only protects you if you actually do it.",
    audience: "Everyone",
    timeEstimate: "About 5 minutes",
    primaryPath: "/admin/security",
    prerequisites: ["An authenticator app on your phone."],
    steps: [
      {
        title: "Enroll an authenticator",
        body: "Account security /admin/security walks you through enrolling a time-based one-time-password app. Anyone who can open a patient chart should do this, which in practice means everyone with console access.",
      },
      {
        title: "Know whether enrollment is enforced where you work",
        body: "Enforcement is a deployment setting, so the answer differs by installation. Where it is switched on, an admin or agent without a verified factor is blocked from the admin API — everything except their own identity and the enrollment endpoints — until they enroll, and enrolled users are challenged at sign-in. Where it is off, nothing stops you working unenrolled.",
        callout: {
          tone: "warning",
          text: "If you are suddenly locked out of every admin page but can still reach Account security, that is enforcement, not an outage. Finish enrolling and access returns.",
        },
      },
      {
        title: "Handle a new phone before you wipe the old one",
        body: "Disable and re-enroll from /admin/security while you still have the working device. Doing it in that order takes two minutes; doing it afterwards takes an admin and a bad afternoon.",
      },
      {
        title: "Use a real password",
        body: "A unique password from a password manager. Reused credentials are how most accounts are actually lost — a second factor helps, but it should not be the only thing standing between an attacker and a patient roster.",
      },
      {
        title: "Say something if it looks wrong",
        body: "A sign-in you do not recognize, or activity on a record you never touched, goes to Support /admin/support immediately. Audit Trail /admin/analytics/audit-trail is where an admin can see who did what.",
      },
    ],
    related: ["invite-your-team", "get-help-and-report-a-problem"],
    keywords: [
      "mfa",
      "2fa",
      "totp",
      "authenticator",
      "password",
      "security",
      "account",
      "login",
    ],
  },
  {
    slug: "appeal-a-denial",
    title: "Write and send a denial appeal",
    category: "billing",
    summary:
      "The appeal workbench lives in the claim drawer on a patient's claims: generate the letter, fax it to the payer — which moves the claim from denied to appealed — or record an out-of-band delivery, then record the payer's outcome.",
    audience: "Biller",
    timeEstimate: "About 30 minutes per appeal",
    primaryPath: "/admin/billing/denials-worklist",
    prerequisites: [
      "The claim is denied and you have read the actual denial reason.",
      "Your role includes patient update permission — generating, faxing, and recording an outcome all need it.",
      "The clinical documentation supporting the claim is on file.",
    ],
    steps: [
      {
        title: "Decide whether this one is worth appealing",
        body: "Work from the Denials worklist /admin/billing/denials-worklist, which is already ranked by recoverable dollars weighted by win probability. Not every denial should be appealed — a coding error is a correction and resubmission, not an appeal.",
        callout: {
          tone: "tip",
          text: "Check Filing deadlines /admin/billing/timely-filing before you start writing. A perfect appeal filed after the window closes recovers nothing.",
        },
      },
      {
        title: "Open the claim and its appeal section",
        body: "Open the claim from the patient's record under Patients /admin/patients — the claim drawer carries the appeal workbench alongside the claim itself, so you are writing with the adjudication in front of you.",
      },
      {
        title: "Generate the letter",
        body: "Generate the appeal letter, then read it before it goes anywhere. Address the payer's stated reason specifically and attach what their policy asks for. A generic letter that does not engage with the actual denial code is the most common reason an appeal fails twice.",
      },
      {
        title: "Send it, and let the send record itself",
        body: "Faxing the letter to the payer from the workbench transitions the claim from denied to appealed automatically, so the status reflects reality without a second step. If you sent it another way — mail, email, or the payer's portal — record that out-of-band delivery so the trail is still complete.",
        callout: {
          tone: "warning",
          text: "An appeal sent through a portal and never recorded here looks like an appeal that was never sent. Record it the same day.",
        },
      },
      {
        title: "Record the payer's outcome",
        body: "When the decision comes back, record it. That is what makes win rate and response aging measurable — without outcomes, you cannot tell which appeals are worth writing, and the worklist's ranking has nothing to learn from.",
      },
      {
        title: "Fix the cause so you appeal it once",
        body: "If the denial came from a rule you control, correct it in Config /admin/billing/config. Winning the same appeal twelve times is worse than fixing the thing that generated twelve denials.",
      },
    ],
    troubleshooting: [
      {
        symptom:
          "I can generate the letter but can't fax it or record an outcome.",
        fix: "Those actions need patient update permission; listing existing letters only needs read. Ask an admin to widen your role at Team /admin/team.",
      },
      {
        symptom: "The payer says they never received the appeal.",
        fix: "The delivery record on the claim is your evidence of what was sent and when. Re-send, record the second delivery too, and note it in Billing notes /admin/billing/notes.",
      },
    ],
    related: [
      "work-the-denials-worklist",
      "configure-billing-rules",
      "respond-to-an-adr",
    ],
    keywords: [
      "appeal",
      "denial",
      "letter",
      "overturn",
      "fax",
      "payer",
      "win rate",
      "reconsideration",
    ],
  },
  {
    slug: "check-capped-rental-modifiers",
    title: "Check the modifiers on a capped-rental claim",
    category: "billing",
    summary:
      "Modifier rules /admin/billing/config/modifier-rules is the payer-specific policy the claim builder applies, sorted so the rules that fire first show first. Use it to see which rule fired on a rental claim — the sequence itself comes from your payer's policy, not from the app.",
    audience: "Biller",
    timeEstimate: "About 20 minutes to investigate one claim",
    primaryPath: "/admin/billing/config/modifier-rules",
    prerequisites: [
      "You have a specific rental claim that was denied or paid unexpectedly.",
      "You have the payer's current policy for that item in front of you.",
    ],
    steps: [
      {
        title: "Start from the claim, not the rule table",
        body: "Work from the denial on the Denials worklist /admin/billing/denials-worklist. Read what the payer actually objected to before you go looking at configuration — a modifier is only sometimes the answer.",
      },
      {
        title: "See which rule fired",
        body: "Modifier rules /admin/billing/config/modifier-rules lists the payer-specific policy by payer and HCPCS, ordered by priority so the rules that fire first appear first. That ordering is the point: it tells you which rule won when several could have applied.",
      },
      {
        title: "Check the rental month the claim was billed in",
        body: "Capped rentals /admin/billing/capped-rentals shows where that rental sits in its cycle. A modifier that is right for one month of a capped period is wrong for another, so confirm the cycle position before concluding the rule is at fault.",
        callout: {
          tone: "warning",
          text: "The required modifier sequence is set by the payer's policy and changes over time. Verify it against their current published policy — do not infer it from what previous claims happened to use.",
        },
      },
      {
        title: "Know that you cannot edit these yourself",
        body: "Modifier rules are read-only in the console and maintained centrally, unlike payer profiles and fee schedules which you edit from their own sub-pages under Config /admin/billing/config. The page exists so you can diagnose, not adjust.",
      },
      {
        title: "Raise a change with evidence",
        body: 'If the rule is genuinely wrong, file it at Support /admin/support with the claim, the rule that fired, and the payer policy that contradicts it. Those three things together get it fixed; "the modifiers are wrong" on its own does not.',
        callout: {
          tone: "tip",
          text: "Check whether the same rule is about to misfire on other queued claims before you send the request — one report covering twelve claims lands very differently from twelve reports.",
        },
      },
      {
        title: "Record what you found",
        body: "Note the finding in Billing notes /admin/billing/notes. The next person to hit the same denial should find your investigation rather than repeat it.",
      },
    ],
    related: [
      "manage-capped-rentals",
      "configure-billing-rules",
      "work-the-denials-worklist",
    ],
    keywords: [
      "modifier",
      "capped rental",
      "rotation",
      "kh",
      "hcpcs",
      "rule",
      "denial",
      "rental month",
    ],
  },
  // ---------------------------------------------------------------
  // Fit requests, catalog & stock
  // ---------------------------------------------------------------
  {
    slug: "work-the-fit-requests-queue",
    title: "Work the fit requests queue",
    category: "patients",
    summary:
      "Fit Requests /admin/fitter-requests is where a finished mask fitting lands. The patient never files their own order — you verify the benefit, place the order, and close the row with what actually happened.",
    audience: "CSR or intake coordinator",
    timeEstimate: "About 10 minutes per request",
    primaryPath: "/admin/fitter-requests",
    featured: true,
    prerequisites: [
      "The mask fitter is enabled for your tenant.",
      "You can see patient details (the queue shows PHI in the clear).",
    ],
    steps: [
      {
        title: "Open the queue oldest first",
        body: "Fit Requests /admin/fitter-requests lists finished fittings waiting on a person, oldest at the top. The patient was told someone would be in touch within one business day, so the age of a row is the SLA, not a sort preference.",
        callout: {
          tone: "note",
          text: "This is a queue, not a report. Every row is a person waiting to hear back.",
        },
      },
      {
        title: "Read what the patient asked for",
        body: "A row is one of two shapes. Send my details means they filled in what they know — insurance is optional there on purpose, because you are going to verify it anyway. Ask a representative to contact me is contact details only. Neither one is an order, and neither has been reviewed by anyone yet.",
      },
      {
        title: "Verify the benefit before you promise anything",
        body: "Run the patient through Verify insurance /admin/billing/verify the way you would any other intake. Whatever the patient typed is a starting point, not a verified benefit — quoting from an unverified member ID is how balances end up written off later.",
      },
      {
        title: "Move the row as you work it",
        body: "Set the status so the rest of the team can see where it stands: New, Contacted, In progress, then Closed. Use the note field for anything the next person would need — a callback time, a voicemail left, a plan that needs a prior auth.",
      },
      {
        title: "Close it with the real outcome",
        body: "Closing asks HOW it turned out, and the answer matters beyond this queue. Fulfilled means the patient actually has the mask; that is the only outcome that marks the fitting as dispensed, which is what Fitter outcomes /admin/analytics/fitter-outcomes counts and what the re-fit campaign reads. Not proceeding, Couldn't reach them, and Duplicate simply close the row.",
        callout: {
          tone: "warning",
          text: "Do not close a row as Fulfilled to tidy the queue. It inflates your dispense rate and tells the outcomes dashboard a mask was delivered that never was.",
        },
      },
    ],
    troubleshooting: [
      {
        symptom: "The same patient appears twice.",
        fix: "An identical re-submit while the first request is still open does not create a second row, so two rows mean two genuinely different asks — or one that was already closed. Close the later one as Duplicate.",
      },
      {
        symptom: "A patient says they submitted but no row appeared.",
        fix: "Check whether a row for them was already closed. Once a request is closed, a fresh identical ask does create a new row, so a missing row usually means it is sitting under a filter rather than lost.",
      },
      {
        symptom: "The dispense rate on Fitter outcomes looks like zero.",
        fix: "Closing rows as Fulfilled is what writes it. If the team has been closing everything as Not proceeding, or leaving rows open, nothing stamps the fitting as dispensed.",
      },
    ],
    related: [
      "review-a-fit-session",
      "verify-a-patients-insurance",
      "send-a-fitting-invite",
    ],
    keywords: [
      "fit request",
      "fitter",
      "queue",
      "callback",
      "lead capture",
      "dispensed",
      "outcome",
      "sla",
    ],
  },
  {
    slug: "manage-catalog-and-stock",
    title: "Manage your catalog and stock levels",
    category: "orders",
    summary:
      "Catalog /admin/catalog is the list of SKUs you dispense and how many are on the shelf. Stock moves as a recorded movement with a reason — never as a typed-in total — so every balance has a history behind it.",
    audience: "Inventory or operations lead",
    timeEstimate: "About 15 minutes",
    primaryPath: "/admin/catalog",
    prerequisites: [
      "The Inventory module is on for your tenant.",
      "You hold the inventory.read permission to view the catalog, and admin.tools.manage to record a movement.",
    ],
    steps: [
      {
        title: "Find the SKU",
        body: "Catalog /admin/catalog lists every SKU you dispense with its on-hand count. A SKU with no count is untracked rather than empty — that distinction matters, because an untracked SKU is never treated as out of stock.",
        callout: {
          tone: "note",
          text: "Blank is not zero. If you want a SKU to trigger low-stock warnings, give it a real count.",
        },
      },
      {
        title: "Record a movement, not a new total",
        body: "Stock changes are entered as a movement with a reason — received, returned, counted, or adjusted. The balance is the result of those movements, so the page always tells you not just what you have but how you got there.",
      },
      {
        title: "Reconcile after a physical count",
        body: "After counting the shelf, record the difference as a counted movement with the counted reason rather than overwriting the number. The movement history is what lets you explain a variance later, so record the reason while you still remember it.",
      },
      {
        title: "Watch the low-stock badges",
        body: "SKUs below their threshold are badged on this page and go out as a digest email every 6 hours, so a shortage surfaces before it blocks a resupply rather than after.",
      },
      {
        title: "Clear a backorder by receiving stock",
        body: "Backorders /admin/shop/backorders is where a SKU is marked out of stock. Recording a receipt on the Catalog page clears the backorder automatically — you do not have to clear it by hand.",
      },
    ],
    troubleshooting: [
      {
        symptom: "A count looks wrong right after a resupply run.",
        fix: "A dispense is recorded when a fulfillment is queued, so the shelf count drops at queue time rather than at ship time. Compare against the movement history before adjusting.",
      },
      {
        symptom: "A SKU the fitter recommends is not in the catalog.",
        fix: "An un-catalogued SKU is skipped rather than blocking the resupply, and the skip is logged. Add the SKU so the next dispense is counted.",
      },
    ],
    related: ["manage-backorders-and-substitutions", "sync-with-pacware"],
    keywords: [
      "catalog",
      "sku",
      "stock",
      "inventory",
      "on hand",
      "count",
      "receipt",
      "ledger",
      "low stock",
    ],
  },
  {
    slug: "manage-backorders-and-substitutions",
    title: "Mark a SKU out of stock and set substitutions",
    category: "orders",
    summary:
      "Backorders /admin/shop/backorders marks a SKU unavailable and sets what the resupply engine should send instead. The insurance fulfillment path reads this, so an uncleared backorder keeps substituting away from that SKU.",
    audience: "Inventory or operations lead",
    timeEstimate: "About 10 minutes",
    primaryPath: "/admin/shop/backorders",
    prerequisites: [
      "The Inventory module is on for your tenant.",
      "You hold the returns.manage permission.",
    ],
    steps: [
      {
        title: "Mark the SKU out of stock",
        body: "Backorders /admin/shop/backorders is where you flag a SKU as unavailable. This is not a retail shelf notice — the insurance fulfillment path reads it directly, so flagging a SKU changes what patients actually receive.",
      },
      {
        title: "Set what goes out instead",
        body: "Give the SKU a substitution rule so a patient who is due gets a comparable item rather than nothing. A resupply the patient is due should not stall because one SKU is short.",
        callout: {
          tone: "warning",
          text: "A substitution still has to be clinically appropriate and billable. Check the HCPCS code and the prescription before you route a substitution at scale.",
        },
      },
      {
        title: "Clear it when stock arrives",
        body: "Recording a receipt for the SKU on Catalog /admin/catalog clears the backorder automatically. If you clear it by hand without receiving stock, the engine will start sending a SKU you do not have.",
      },
    ],
    troubleshooting: [
      {
        symptom: "Patients are still getting the substitute after restock.",
        fix: "The backorder is still set. Record the receipt on /admin/catalog, or clear the flag here.",
      },
    ],
    related: ["manage-catalog-and-stock", "set-up-resupply-reminders"],
    keywords: [
      "backorder",
      "out of stock",
      "substitution",
      "resupply",
      "shortage",
      "sku",
    ],
  },
  {
    slug: "read-inventory-turnover",
    title: "Read the inventory turnover report",
    category: "analytics",
    summary:
      "Inventory turnover /admin/analytics/inventory-turnover shows how fast stock moves (COGS ÷ inventory value) and which SKUs ran out while patients wanted them.",
    audience: "Owner or operations lead",
    timeEstimate: "About 10 minutes",
    primaryPath: "/admin/analytics/inventory-turnover",
    prerequisites: [
      "You hold the cost.read permission.",
      "Your catalog has real stock counts — untracked SKUs cannot be measured.",
    ],
    steps: [
      {
        title: "Read turnover as a pace, not a score",
        body: "Turnover is cost of goods sold divided by inventory value over the period. A high number means stock moves quickly; a low number means cash is sitting on the shelf. Neither is automatically good — a low number on a slow-moving but clinically necessary SKU is the cost of being able to serve the patient who needs it.",
      },
      {
        title: "Look at stockout demand next to it",
        body: "The stockout column is the one that costs you patients: it counts demand that arrived while the SKU was unavailable. A SKU with healthy turnover and repeated stockouts is under-ordered, not well managed.",
      },
      {
        title: "Act on it in the catalog",
        body: "Adjust reorder levels on Catalog /admin/catalog, and check whether a repeatedly stocked-out SKU has a standing substitution on Backorders /admin/shop/backorders that is quietly masking the shortage.",
      },
    ],
    related: ["manage-catalog-and-stock", "find-and-read-a-report"],
    keywords: ["turnover", "inventory", "cogs", "stockout", "reorder", "cost"],
  },
  {
    slug: "read-storefront-analytics",
    title: "Read storefront analytics",
    category: "analytics",
    summary:
      "Storefront Analytics /admin/fitter/analytics shows how people move through your public site and mask fitter — where they arrive, where they drop, and how many finish a fitting.",
    audience: "Owner or marketing lead",
    timeEstimate: "About 10 minutes",
    primaryPath: "/admin/fitter/analytics",
    prerequisites: ["Your storefront is live on your own domain."],
    steps: [
      {
        title: "Start with the funnel, not the traffic",
        body: "Traffic tells you how many arrived; the funnel tells you where they stopped. The drop between starting a fitting and finishing one is usually the most actionable number on the page.",
      },
      {
        title: "Compare against the fit requests you actually received",
        body: "A finished fitting should turn into a row on Fit Requests /admin/fitter-requests. A gap between finished fittings and requests received means patients are completing the fitter and then not asking — usually a wording or trust problem on the results page rather than a technical one.",
      },
      {
        title: "Check where the traffic came from",
        body: "Use it alongside Fitter Prospects /admin/fitter-leads and Insurance Leads /admin/shop/insurance-leads to see which sources produce people who actually enter the pipeline, not just visitors.",
      },
    ],
    related: ["work-the-fit-requests-queue", "work-insurance-leads"],
    keywords: [
      "storefront",
      "analytics",
      "traffic",
      "funnel",
      "conversion",
      "fitter",
    ],
  },
] as const;
