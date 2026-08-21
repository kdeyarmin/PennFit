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
      "Work the setup checklist at /admin/setup top to bottom — it shows live status for branding, your domain, phone and fax numbers, your email sender, payments, team, and catalog, and links straight to the page that finishes each row.",
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
        title: "Connect payments and confirm your plan",
        body: "Plan & billing /admin/billing/package shows your plan, its allowances, and your usage against them. Payments must be connected before the storefront can take a card, so do this before you promote your shop.",
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
      "The sidebar is grouped by the shape of the work — Workspace, Patients & Clinical, Orders & Shop, Billing, Analytics & Reports, System. Use the global lookup in the header to jump straight to a patient, and the in-app assistant when you cannot find a page.",
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
          "Orders & Shop — orders, fulfillment, subscriptions, returns, inventory, and storefront leads.",
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
        body: "Use the global lookup in the top header when you have a name or phone number in front of you. Use Patients /admin/patients when you want to filter the roster instead — by status, payer, equipment, or where they are in the resupply cycle.",
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
        fix: "Try their phone number and their maiden or previous name, then check /admin/patients/duplicates. Storefront customers who have never ordered appear under Customers /admin/shop/customers rather than the clinical roster.",
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
    audience: "CSR, clinician, or admin",
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
        body: "An approved recommendation flows to Fitter requests /admin/fitter/orders, where it becomes a real order. Track how these turn out in Fitter outcomes /admin/analytics/fitter-outcomes — ordered, kept, or exchanged.",
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
    audience: "CSR, clinician, or admin",
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
  // Orders & shop
  // ---------------------------------------------------------------
  {
    slug: "take-a-front-desk-order",
    title: "Ring up a walk-in at the front desk",
    category: "orders",
    summary:
      "Front Desk /admin/front-desk captures a walk-in and takes a counter order in one flow — find or create the patient, add items, take payment, and hand them the receipt.",
    audience: "CSR with order-create permission",
    timeEstimate: "About 5 minutes",
    primaryPath: "/admin/front-desk",
    prerequisites: [
      "The Front Desk module is on and your role includes creating orders.",
      "Payments are connected for your account.",
    ],
    steps: [
      {
        title: "Open Front Desk",
        body: "Workspace → Front Desk /admin/front-desk. It is built for someone standing at the counter, so it front-loads the search and keeps the order on one screen.",
      },
      {
        title: "Find or create the person",
        body: "Search first — most walk-ins already exist. Creating a second record for someone you already have splits their order history and doubles their reminders.",
      },
      {
        title: "Add the items",
        body: "Add what they are taking today. Inventory /admin/shop/inventory is the stock position behind those items; if something is short, Backorders & subs /admin/shop/backorders is where the substitution decision gets recorded.",
      },
      {
        title: "Take payment and finish",
        body: "Complete the sale and give them the receipt. The order appears in Orders /admin/shop/orders like any other, so the rest of the workflow — returns, billing, history — behaves normally.",
      },
      {
        title: "Set up what comes next",
        body: "Before they leave, offer the fitting link if they need a mask (Fitter Invites /admin/fitter-invites) and get them on resupply reminders. Both take under a minute at the counter and are much harder to do later.",
      },
    ],
    related: ["fulfill-and-ship-an-order", "send-a-fitting-invite"],
    keywords: [
      "walk-in",
      "counter",
      "point of sale",
      "pos",
      "front desk",
      "retail",
    ],
  },
  {
    slug: "fulfill-and-ship-an-order",
    title: "Fulfill an order and print a shipping label",
    category: "orders",
    summary:
      "Work Orders /admin/shop/orders as the queue, confirm the paperwork and stock, then buy and print the label from Shipping labels /admin/shipping. Tracking flows back to the patient automatically.",
    audience: "Fulfillment staff or CSR",
    timeEstimate: "About 4 minutes per order",
    primaryPath: "/admin/shop/orders",
    featured: true,
    prerequisites: [
      "Your role includes returns and fulfillment management.",
      "The order has a valid shipping address on the patient record.",
    ],
    steps: [
      {
        title: "Work the order queue",
        body: "Orders /admin/shop/orders holds every storefront and resupply order. Fitter requests /admin/fitter/orders is the subset that came out of a fitting — those often need a clinical approval before they ship.",
      },
      {
        title: "Check the paperwork before you pick",
        body: "For anything billed to insurance, confirm the prescription and any required documentation are on file. Shipping first and chasing paperwork afterward is how claims end up on Bill hold /admin/billing/bill-hold.",
        callout: {
          tone: "warning",
          text: "Shipping an item whose documentation is not complete does not just delay payment — it can make the claim unbillable. Check first.",
        },
      },
      {
        title: "Confirm stock, or substitute deliberately",
        body: "If an item is short, do not silently swap it. Backorders & subs /admin/shop/backorders is where the substitution or backorder is recorded so the patient can be told and billing sees the right item.",
      },
      {
        title: "Buy and print the label",
        body: "Shipping labels /admin/shipping buys the label, prints it, and tracks the parcel. Use it rather than a carrier site so the tracking number attaches to the order and reaches the patient.",
      },
      {
        title: "Watch for delivery problems",
        body: "Delivery Failures /admin/delivery-failures surfaces sends and shipments that did not land. A failed delivery caught the same week is a re-ship; caught a month later it is a refund and a bad review.",
      },
    ],
    related: ["handle-a-return", "manage-subscriptions"],
    keywords: [
      "shipping",
      "label",
      "fulfillment",
      "pick pack",
      "tracking",
      "order queue",
    ],
  },
  {
    slug: "handle-a-return",
    title: "Process a return, exchange, or refund",
    category: "orders",
    summary:
      "Start the RMA from Returns & RMAs /admin/shop/returns, tell the patient what to send back and how, then refund or exchange per policy once it arrives. Restock what is resellable.",
    audience: "CSR",
    timeEstimate: "About 5 minutes to start, plus receiving",
    primaryPath: "/admin/shop/returns",
    prerequisites: [
      "The original order is in the system and you know why it is coming back.",
    ],
    steps: [
      {
        title: "Start the return",
        body: "Returns & RMAs /admin/shop/returns creates and tracks the return. Start it from here rather than promising a refund in a message thread — the RMA is what fulfillment and billing both read.",
      },
      {
        title: "Record the real reason",
        body: '"Did not fit", "wrong item shipped", and "changed mind" lead to completely different follow-ups. The reason you record is what shows up later in Fitter outcomes /admin/analytics/fitter-outcomes and in Mask-fit feedback /admin/clinical/mask-fit.',
        callout: {
          tone: "tip",
          text: "A fit-related return is a clinical signal, not just a refund. Consider a rescan or a size override rather than shipping the same mask again.",
        },
      },
      {
        title: "Tell the patient exactly what to do",
        body: "What to send back, how, and by when. Ambiguity here is the single biggest cause of returns that never arrive.",
      },
      {
        title: "Close it out when it lands",
        body: "Receive the return, refund or exchange per your policy, and restock anything resellable through Inventory /admin/shop/inventory. If the item was billed, make sure the claim or the patient balance is adjusted too.",
      },
      {
        title: "Handle a card dispute separately",
        body: "If the patient disputed the charge with their bank instead of asking you, it appears in Chargeback disputes /admin/billing/disputes with its evidence deadline. That deadline is hard — miss it and the money is gone regardless of who was right.",
      },
    ],
    related: ["fulfill-and-ship-an-order", "review-a-fit-session"],
    keywords: [
      "return",
      "rma",
      "refund",
      "exchange",
      "restock",
      "chargeback",
      "dispute",
    ],
  },
  {
    slug: "manage-subscriptions",
    title: "Set up and manage a resupply subscription",
    category: "orders",
    summary:
      "Subscriptions /admin/shop/subscriptions holds every recurring resupply plan — the cadence, the items, and what is due next. Change the cadence rather than cancelling when a patient says they have too much.",
    audience: "CSR",
    timeEstimate: "About 3 minutes",
    primaryPath: "/admin/shop/subscriptions",
    prerequisites: [
      "The patient has a payment method on file or billable coverage.",
    ],
    steps: [
      {
        title: "Open the subscription list",
        body: "Orders → Subscriptions /admin/shop/subscriptions. Each row is a recurring plan with its items, cadence, and next ship date.",
      },
      {
        title: "Match the cadence to real usage",
        body: 'A patient who says "I have a drawer full of cushions" does not want to cancel — they want a longer interval. Therapy-driven timing is better than a calendar: Resupply Opportunities /admin/therapy-resupply is based on actual device usage.',
        callout: {
          tone: "tip",
          text: "Stretching the interval saves the subscription. Cancelling loses the patient and the revenue.",
        },
      },
      {
        title: "Keep payment current",
        body: "An expired card is the most common silent failure. Delivery Failures /admin/delivery-failures and the billing pages surface it; catching it before the ship date avoids an awkward call.",
      },
      {
        title: "Pause rather than cancel where you can",
        body: "Travel, a hospital stay, or a temporary stop is a pause. Cancelling drops them out of the reminder program entirely and they usually do not come back on their own.",
      },
    ],
    related: ["set-up-resupply-reminders", "fulfill-and-ship-an-order"],
    keywords: [
      "subscription",
      "auto-ship",
      "recurring",
      "cadence",
      "resupply",
      "cancel",
      "pause",
    ],
  },
  {
    slug: "count-and-reconcile-inventory",
    title: "Run an inventory count and reconcile variance",
    category: "orders",
    summary:
      "Count against Inventory /admin/shop/inventory, then record what you actually found in Reconcile /admin/shop/inventory/reconcile with a reason for every variance.",
    audience: "Warehouse or admin",
    timeEstimate: "Depends on catalog size; budget half a day monthly",
    primaryPath: "/admin/shop/inventory/reconcile",
    prerequisites: ["The Inventory module is on for your account."],
    steps: [
      {
        title: "Pick a cadence and hold it",
        body: "Monthly is the usual rhythm. The value of a count comes from the trend across counts, so an irregular count tells you much less than a boring regular one.",
      },
      {
        title: "Count against the system position",
        body: "Inventory /admin/shop/inventory is the on-hand position the app believes. Count physically first and compare afterwards, so you are not unconsciously counting toward the expected number.",
      },
      {
        title: "Record variance with a reason",
        body: "Reconcile /admin/shop/inventory/reconcile takes the counted figures. Always record why a line varied — damage, an unrecorded sale, a mis-pick. Variance without a reason is noise; variance with reasons is a fixable process problem.",
        callout: {
          tone: "note",
          text: "Repeated shrink on one SKU is usually a receiving or picking process problem, not theft. The reason codes are what let you tell the difference.",
        },
      },
      {
        title: "Feed the result back into ordering",
        body: "Inventory turnover /admin/analytics/inventory-turnover shows what is moving and what is dead stock. Use it to set reorder points rather than reordering from memory.",
      },
    ],
    related: ["fulfill-and-ship-an-order"],
    keywords: [
      "inventory",
      "count",
      "cycle count",
      "stock",
      "variance",
      "reconcile",
      "shrink",
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
    title: "Turn on resupply reminders",
    category: "outreach",
    summary:
      "Reminders /admin/fitter/reminders sets the resupply schedule. Patients get a signed link that lets them confirm or decline in one tap, and Reorder Reminders /admin/reorder-reminders shows how the program is performing.",
    audience: "Admin",
    timeEstimate: "About 20 minutes to configure",
    primaryPath: "/admin/fitter/reminders",
    featured: true,
    prerequisites: [
      "The Outreach module is on.",
      "Your phone number and email sender are configured.",
      "Patient records carry current contact details.",
    ],
    steps: [
      {
        title: "Set the schedule",
        body: "Outreach → Reminders /admin/fitter/reminders holds the resupply reminder schedule — which supplies get a reminder and how often. Start from standard replacement intervals and adjust from what you actually see.",
      },
      {
        title: "Review the copy that goes out",
        body: "Automated messages /admin/templates holds the system-sent copy. Read every template before it goes live, and preview it with sample data at Message previews /admin/message-previews.",
      },
      {
        title: "Understand the patient's side",
        body: "The reminder carries a short-lived signed link. One tap confirms or declines — no sign-in, no password. That one-tap path is why the program works; anything that adds friction reduces the response rate sharply.",
        callout: {
          tone: "note",
          text: 'Those links expire by design. A patient who says "the link doesn\'t work" usually has an old message — re-send rather than troubleshooting.',
        },
      },
      {
        title: "Time it from real usage where you can",
        body: "Resupply Opportunities /admin/therapy-resupply is based on actual device usage rather than the calendar. A reminder that arrives when a patient genuinely needs supplies converts far better than one on a fixed schedule.",
      },
      {
        title: "Watch the program, not the individual sends",
        body: "Reorder Reminders /admin/reorder-reminders shows how the program is performing — sends, responses, conversions. If response is falling, the copy or the cadence is wrong; adjust one thing at a time.",
      },
    ],
    related: [
      "manage-subscriptions",
      "send-a-bulk-campaign",
      "monitor-therapy-adherence",
    ],
    keywords: [
      "reminder",
      "resupply",
      "reorder",
      "schedule",
      "cadence",
      "automated",
      "renewal",
    ],
  },
  {
    slug: "build-an-automation-rule",
    title: "Build an automation rule and dry-run it first",
    category: "outreach",
    summary:
      "Rules /admin/rules defines what happens automatically. Always dry-run a new or edited rule in the Rule Tester /admin/rule-tester before enabling it — a misconfigured rule messages real patients.",
    audience: "Admin",
    timeEstimate: "About 30 minutes",
    primaryPath: "/admin/rules",
    prerequisites: [
      "The Automation module is on and your role includes tools management.",
    ],
    steps: [
      {
        title: "Write down the rule in a sentence first",
        body: '"When X happens, do Y." If you cannot say it in one sentence, it is more than one rule. Rules /admin/rules is where it gets built.',
      },
      {
        title: "Scope the trigger narrowly",
        body: "A specific keyword or a specific event, not a broad category. Broad triggers are what turn a helpful rule into a patient receiving four messages about one order.",
      },
      {
        title: "One action per rule",
        body: "Chaining several actions into one rule makes it almost impossible to work out which part misfired. Separate rules are easier to test, easier to disable, and easier to explain.",
      },
      {
        title: "Dry-run it — every time, including after edits",
        body: "Rule Tester /admin/rule-tester runs the rule against sample input and shows what it would have done, without sending anything. Do this before enabling and after every edit.",
        callout: {
          tone: "warning",
          text: "This is the one step people skip and then regret. An untested rule can message your entire patient list before anyone notices.",
        },
      },
      {
        title: "Enable it and watch the first day",
        body: "Turn it on, then check Outbound Messages /admin/outbound-messages to see what it actually sent. Compliance Rules /admin/compliance-rules is the separate place per-payer adherence thresholds live.",
      },
    ],
    troubleshooting: [
      {
        symptom: "The rule is on but nothing fires.",
        fix: "Dry-run it again in /admin/rule-tester with input you know should match. Nine times out of ten the trigger is narrower than intended, or the module it depends on is off in /admin/control-center.",
      },
    ],
    related: ["send-a-bulk-campaign", "manage-modules-and-flags"],
    keywords: [
      "rule",
      "automation",
      "trigger",
      "workflow",
      "dry run",
      "tester",
      "auto reply",
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
] as const;
