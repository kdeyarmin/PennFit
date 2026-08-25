// The complete user guide for the staff Help Center (/admin/resources).
//
// Where the how-tos answer "how do I do X", this answers "what is all of
// this and how does it fit together". It is organized the way the
// sidebar is, so a reader can hold the console and the guide side by
// side, and every section carries a table of the pages it covers.
//
// Keep it descriptive rather than procedural — when a section starts
// growing numbered steps, that content belongs in a how-to instead.
// Every /admin/... path here is cross-checked against the console's
// NAV_GROUPS by `admin-help.coverage.test.ts`.

import type { GuideSection } from "./types";

export const GUIDE_SECTIONS: readonly GuideSection[] = [
  // ---------------------------------------------------------------
  {
    id: "overview",
    title: "What this platform does",
    category: "getting-started",
    intro:
      "One system that runs a CPAP resupply program end to end — from the first fitting through ordering, fulfillment, insurance billing, and the ongoing resupply relationship.",
    blocks: [
      {
        kind: "para",
        text: "Most durable medical equipment operations run on four or five disconnected tools: a billing system, a texting tool, a storefront, a spreadsheet of who is due, and a filing cabinet of signed paperwork. This platform replaces that with one console where the patient record, the conversation, the order, the documentation, and the claim are the same object seen from different angles.",
      },
      {
        kind: "para",
        text: "There are two front doors. Patients see a storefront with a guided virtual mask fitter, a shop, and an account area where they manage orders, subscriptions, and communication preferences. Your team sees this admin console, where all of that work is queued, worked, and measured.",
      },
      {
        kind: "bullets",
        items: [
          "Acquire — a mask-fitting link you can send to anyone, a storefront, and inbound referral intake.",
          "Fit — a guided phone-camera scan that produces measurements, a ranked mask recommendation, and a safety screen, reviewed by your staff before anything ships.",
          "Order — storefront checkout, counter sales, fitter-generated requests, and recurring resupply subscriptions.",
          "Fulfill — pick, substitute deliberately, buy and print labels, and track delivery.",
          "Bill — eligibility, prior authorization, claim submission, remittance posting, denials, and patient balances.",
          "Retain — therapy-usage monitoring, adherence coaching, resupply reminders, and satisfaction measurement.",
        ],
      },
      {
        kind: "callout",
        tone: "note",
        text: "Everything is per-account. Your branding, your phone and email senders, your formulary, your rules, and your data belong to your account alone, even though the software is shared.",
      },
    ],
  },

  // ---------------------------------------------------------------
  {
    id: "concepts",
    title: "Concepts worth understanding first",
    category: "getting-started",
    intro:
      "Five ideas explain most of what is otherwise confusing: modules, roles, your brand identity, the two AI assistants, and how protected health information is handled.",
    blocks: [
      {
        kind: "para",
        text: "Modules are large on/off switches for whole areas of the console — Conversations, Schedule, Outreach, Documents, Therapy, Clinical, Inventory, Storefront, Automation, Integrations, and Support. Switching one off hides its entire sidebar section without deleting anything. Feature flags sit underneath and turn individual behaviors on and off. Both live at Control Center /admin/control-center.",
      },
      {
        kind: "para",
        text: 'Roles decide which pages render at all. Two coarse roles gate the console — admin and agent — and finer effective roles narrow it further: owner (super-admin), admin, customer-service rep, clinician, and biller. A page a role cannot use simply does not appear in that person\'s sidebar. This is why "the page is missing" is nearly always a role or a module, not a fault.',
      },
      {
        kind: "callout",
        tone: "tip",
        text: "When a teammate reports a missing page, check their role at /admin/team first and the module at /admin/control-center second. That resolves the large majority of these reports.",
      },
      {
        kind: "para",
        text: "Your brand identity is data, not a build setting. The company name, logo, colors, support contacts, phone number, fax number, and email From address all belong to your account and are applied to patient-facing copy — SMS, voice, email, chat, PDFs, and the storefront — as it goes out. Until you set your own, patients see the platform's neutral identity rather than another business's.",
      },
      {
        kind: "para",
        text: "There are two AI assistants and they have different audiences. The storefront assistant answers prospective and signed-in patients on your public site. The admin assistant is the floating widget in this console; it explains how the app works, points staff at the right page, and can forward a feature suggestion to the account owners — always after asking you first. Both are renameable to your own brand from system configuration.",
      },
      {
        kind: "callout",
        tone: "warning",
        text: "Assistant conversations and support tickets leave the application. Never paste a patient's Social Security number, full date of birth, insurance member ID, or card number into either. Describe the workflow instead, or reference an order number.",
      },
    ],
  },

  // ---------------------------------------------------------------
  {
    id: "workspace",
    title: "Workspace — the day-to-day desk",
    category: "patients",
    intro:
      "Where staff spend their day: the landing dashboard, the counter, the unified inbox, cases and episodes, the schedule, and every outbound surface.",
    blocks: [
      {
        kind: "para",
        text: "Home is the queue-driven landing page — today's work and the signals worth reacting to. Front Desk is a purpose-built counter flow for a walk-in: find or create the person, add items, take payment, done. Conversations is one inbox for inbound SMS, MMS, and email, with a channel filter when you want just one.",
      },
      {
        kind: "para",
        text: "Cases and Episodes are the two escalation shapes. A case links the pieces of one problem — a thread, an order, a fax, a billing question — and is tracked to closure. An episode holds a dated service commitment. If you promised a patient something with a date attached, it belongs in one of those two rather than in someone's memory.",
      },
      {
        kind: "para",
        text: "The outreach group holds every way you deliberately contact a patient, plus the reusable content behind it: campaigns for batches, the alert library for one-offs, the reminder schedule for resupply, playbooks and canned replies for consistency, automated message templates for system-sent copy, and a preview renderer so you can see any of it with sample data before it goes out.",
      },
      {
        kind: "pages",
        title: "Workspace pages",
        rows: [
          {
            path: "/admin",
            label: "Home",
            what: "Landing dashboard — today's work, queues, and signals.",
          },
          {
            path: "/admin/conversations",
            label: "Conversations",
            what: "Unified inbound SMS, MMS, and email threads.",
          },
          {
            path: "/admin/cases",
            label: "Cases",
            what: "Multi-channel tickets linking threads, orders, and faxes.",
          },
          {
            path: "/admin/episodes",
            label: "Episodes",
            what: "Open service episodes needing follow-up.",
          },
          {
            path: "/admin/company-calendar",
            label: "Company Calendar",
            what: "Shared schedule of fittings, setups, and follow-ups.",
          },
          {
            path: "/admin/video-visits",
            label: "Video visits",
            what: "Telehealth visits with a secure join link — no app for the patient.",
          },
          {
            path: "/admin/followups",
            label: "Follow-ups",
            what: "Scheduled callbacks and tasks.",
          },
          {
            path: "/admin/bulk-campaigns",
            label: "Bulk Campaigns",
            what: "Batch SMS and email sends with audience filters and throttling.",
          },
          {
            path: "/admin/alerts",
            label: "Alert Library",
            what: "Curated one-off alerts to a single patient.",
          },
          {
            path: "/admin/fitter/reminders",
            label: "Reminders",
            what: "The resupply reminder schedule.",
          },
          {
            path: "/admin/playbooks",
            label: "Playbooks",
            what: "Situation-based contact templates.",
          },
          {
            path: "/admin/macros",
            label: "Canned Replies",
            what: "Saved quick replies for the inbox.",
          },
          {
            path: "/admin/templates",
            label: "Automated messages",
            what: "The copy the system sends on its own.",
          },
          {
            path: "/admin/message-previews",
            label: "Message previews",
            what: "Render any automated message with sample data before it ships.",
          },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------
  {
    id: "patients",
    title: "Patients — the roster and the chart",
    category: "patients",
    intro:
      "The patient record is the spine of the system. Everything else — orders, messages, documents, therapy data, claims — hangs off it.",
    blocks: [
      {
        kind: "para",
        text: "Patients is the roster, filterable by status, payer, equipment, and where someone sits in the resupply cycle. Opening a record gives you a combined timeline: orders, messages in and out, documents, therapy readings, and billing events in one chronological view, with quick actions for the things you most often do next.",
      },
      {
        kind: "para",
        text: "Duplicate review surfaces likely duplicate records with the evidence behind the match. Merging early matters more than it looks: a split record means split order history, two sets of reminders to the same person, and claims that reference the wrong chart.",
      },
      {
        kind: "callout",
        tone: "tip",
        text: "The global lookup in the top header is the fastest way to a chart when someone is on the phone. Reserve the roster page for filtering and list work.",
      },
      {
        kind: "pages",
        title: "Patient pages",
        rows: [
          {
            path: "/admin/patients",
            label: "Patients",
            what: "The roster, with filters; click through for the full chart.",
          },
          {
            path: "/admin/patients/duplicates",
            label: "Duplicate review",
            what: "Likely duplicate records, with the match evidence, ready to merge.",
          },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------
  {
    id: "documents",
    title: "Documents, e-signature, and referrals",
    category: "patients",
    intro:
      "The paperwork pipeline, in the order paper actually moves: draft, send for signature, track, receive, and retain.",
    blocks: [
      {
        kind: "para",
        text: "Documents is where a CMN, prescription, agreement, or fax cover is drafted. Document packets bundles what a patient or provider needs to sign into one e-signature request — bundling matters, because completion rates fall with every additional link a person has to open. Awaiting signatures is everything currently out with a provider, with its age; the e-signature portal is the provider-facing staging area and where signed items land.",
      },
      {
        kind: "para",
        text: "Inbound faxes is the triage queue for everything that comes back on paper: signed pages, sleep studies, and prescription renewals. The referral reviewer is the specialized version for inbound referrals, where a fax becomes a patient and an order; referral sources tracks which practices send you that volume, which is what makes referral growth measurable.",
      },
      {
        kind: "para",
        text: "Retention handles the end of a document's life. Legal holds require a reason and prevent destruction; destroying a document is admin-gated and only possible once the retention sweep has marked it eligible.",
      },
      {
        kind: "callout",
        tone: "warning",
        text: "Documentation completeness is a billing constraint, not just an administrative one. An item supplied without the paperwork the payer requires can be unbillable — not merely delayed.",
      },
      {
        kind: "pages",
        title: "Document pages",
        rows: [
          {
            path: "/admin/documents",
            label: "Documents",
            what: "Draft a CMN, prescription, agreement, or fax cover.",
          },
          {
            path: "/admin/patient-packets",
            label: "Document packets",
            what: "Send and track bundled e-signature packets.",
          },
          {
            path: "/admin/signature-tracking",
            label: "Awaiting signatures",
            what: "Everything out for a provider signature, with its age.",
          },
          {
            path: "/admin/provider-portal",
            label: "E-signature portal",
            what: "Provider-facing e-sign staging and signed items.",
          },
          {
            path: "/admin/inbound-faxes",
            label: "Inbound faxes",
            what: "Triage returned faxes, sleep studies, and Rx renewals.",
          },
          {
            path: "/admin/referral-reviews",
            label: "Referral reviewer",
            what: "Work inbound referral faxes into patients and orders.",
          },
          {
            path: "/admin/referral-sources",
            label: "Referral sources",
            what: "The practices sending referrals, and their volume.",
          },
          {
            path: "/admin/documents/retention",
            label: "Retention",
            what: "Legal holds and eligible-document destruction.",
          },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------
  {
    id: "therapy",
    title: "Therapy monitoring",
    category: "patients",
    intro:
      "Device-cloud usage data turned into worklists — who is struggling, who is at risk of failing a compliance window, and who is genuinely due for supplies.",
    blocks: [
      {
        kind: "para",
        text: "When a therapy-cloud integration is connected, nightly usage data flows in and drives four boards. RT Overview is the daily triage read. Therapy Fleet is the same population as a sortable roster. Setup Adherence surfaces patients inside their initial compliance window who are trending toward failing it — the highest-value outreach in the entire program, because that window closes. Resupply Opportunities converts real usage into who needs supplies now.",
      },
      {
        kind: "para",
        text: "Compliance thresholds are per payer, not universal, and live in Compliance Rules under Automation. RT outcomes closes the loop by showing whether your interventions actually moved adherence.",
      },
      {
        kind: "callout",
        tone: "note",
        text: "Therapy data describes device usage. It is not a clinical interpretation, and nothing in this console gives clinical advice — therapy decisions belong to the patient's physician.",
      },
      {
        kind: "pages",
        title: "Therapy pages",
        rows: [
          {
            path: "/admin/rt-overview",
            label: "RT Overview",
            what: "The daily triage read across monitored patients.",
          },
          {
            path: "/admin/therapy-fleet",
            label: "Therapy Fleet",
            what: "Fleet-wide adherence roster, sortable and filterable.",
          },
          {
            path: "/admin/therapy-compliance",
            label: "Setup Adherence",
            what: "Patients at risk of failing their compliance window.",
          },
          {
            path: "/admin/therapy-resupply",
            label: "Resupply Opportunities",
            what: "Who is due for supplies based on actual usage.",
          },
          {
            path: "/admin/rt-outcomes",
            label: "RT outcomes",
            what: "Whether interventions moved adherence.",
          },
          {
            path: "/admin/therapy-usage-report",
            label: "Therapy Report",
            what: "Usage reporting across the population.",
          },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------
  {
    id: "clinical",
    title: "Clinical work and the mask fitter",
    category: "patients",
    intro:
      "The mask fitter is the platform's distinctive capability: a guided phone-camera scan that produces measurements and a ranked, explained recommendation your staff approve before anything ships.",
    blocks: [
      {
        kind: "para",
        text: "A patient opens a fitting link on their phone and follows a guided scan. The camera images never leave their device — only numeric facial measurements are transmitted. Those measurements are matched against the mask catalog's per-variant fit bands, filtered by contraindications, and ranked. A safety screen covering magnetic implants for the patient and their household can exclude magnetic-clip masks outright.",
      },
      {
        kind: "para",
        text: 'The questionnaire opens by asking who the mask is for — an adult or a child — and offers no "not sure". That answer is a service line, never an age or a date of birth, and it sets three things at once: which measurements count as plausible, which masks are eligible at all, and what the session records. A catalog entry with no service line is treated as adult, which is what stops an unmarked mask from ever reaching a child.',
      },
      {
        kind: "para",
        text: "A fitting ends in a REQUEST, not an order. The patient either sends their details or asks to be contacted, and the row lands on Fit Requests for a person to work — a claim must not start from a patient's own guess at their member ID. Insurance is optional on that form on purpose, because someone verifies it anyway. Closing the row asks how it turned out, and only Fulfilled — the patient actually has the mask — marks the fitting as dispensed.",
      },
      {
        kind: "para",
        text: "Fit review is where a human closes the loop. Each session shows the measurements, the population the patient chose, the tier-by-tier reasoning behind the ranking, and a confidence read. You approve, override the mask or size when you know something the scan cannot see, or request a rescan when confidence is low. Fitter outcomes then reports how the recommendation actually turned out — dispensed, and whether the mask the patient got was the one the engine picked or an override.",
      },
      {
        kind: "para",
        text: "The formulary is the last tier of the ranking and is deliberately bounded: it re-orders masks that are already close on fit toward what you stock, and can never promote a poorly fitting mask over a well fitting one. Around this sit the rest of clinical work — encounters, interventions, referrals out to providers, mask-fit feedback, clinical outreach, adherence coaching, and the patient education video library.",
      },
      {
        kind: "callout",
        tone: "warning",
        text: "A magnetic-implant flag applies to people who live with the patient, not only the patient. Treat the resulting exclusion as final rather than overriding it.",
      },
      {
        kind: "pages",
        title: "Clinical and fitter pages",
        rows: [
          {
            path: "/admin/fit-sessions",
            label: "Fit review",
            what: "Every completed scan with measurements, reasoning, and confidence.",
          },
          {
            path: "/admin/fitter/catalog",
            label: "Mask catalog",
            what: "Models, size variants, fit bands, contraindications, and sourcing.",
          },
          {
            path: "/admin/fitter/formulary",
            label: "Formulary",
            what: "Which catalog masks you stock or prefer.",
          },
          {
            path: "/admin/fitter/safety-screens",
            label: "Safety screening",
            what: "The magnetic-implant question set and its published version.",
          },
          {
            path: "/admin/fitter-invites",
            label: "Fitter Invites",
            what: "Text or email a fitting link to anyone, including non-patients.",
          },
          {
            path: "/admin/fitter-leads",
            label: "Fitter Prospects",
            what: "People invited to a fitting who are not yet patients.",
          },
          {
            path: "/admin/clinical",
            label: "Clinical encounters",
            what: "Documented clinical contacts.",
          },
          {
            path: "/admin/clinical/interventions",
            label: "Interventions",
            what: "What was done for a struggling patient, and when.",
          },
          {
            path: "/admin/clinical/mask-fit",
            label: "Mask-fit feedback",
            what: "What patients reported about fit after delivery.",
          },
          {
            path: "/admin/clinical/outreach",
            label: "Clinical outreach",
            what: "Clinically driven patient outreach.",
          },
          {
            path: "/admin/coaching",
            label: "Adherence coaching",
            what: "Structured coaching for patients struggling with therapy.",
          },
          {
            path: "/admin/clinical/education-videos",
            label: "Video library",
            what: "Patient education videos.",
          },
          {
            path: "/admin/provider-referrals",
            label: "Referrals",
            what: "Clinical referrals out to providers.",
          },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------
  {
    id: "providers",
    title: "Providers, recalls, and asset recovery",
    category: "patients",
    intro:
      "The referring and prescribing side of the relationship, plus the two jobs that only matter when something goes wrong.",
    blocks: [
      {
        kind: "para",
        text: "Providers holds the prescribing and referring clinicians you work with. Recalls tracks equipment recall notices against your registry of who has what — the reason keeping an equipment registry current is worth the effort is that a recall turns it into a patient-safety task list overnight. Asset recovery chases back rental equipment out with a patient who has stopped therapy.",
      },
      {
        kind: "pages",
        title: "Provider pages",
        rows: [
          {
            path: "/admin/providers",
            label: "Providers",
            what: "Prescribing and referring clinicians.",
          },
          {
            path: "/admin/equipment-recalls",
            label: "Recalls",
            what: "Recall notices matched against who has the equipment.",
          },
          {
            path: "/admin/asset-recovery",
            label: "Asset recovery",
            what: "Recover rental equipment from patients who stopped therapy.",
          },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------
  {
    id: "orders",
    title: "Orders and fulfillment",
    category: "orders",
    intro:
      "Supplies are dispensed against a patient's insurance, and every parcel leaves through the same fulfillment path.",
    blocks: [
      {
        kind: "para",
        text: "Patients do not buy supplies with a card — everything is billed to their plan. An order therefore starts either from an approved fitter recommendation or from the resupply engine, and the claim is what collects the money. Fitter requests is the subset that came from a fitting, which often needs a clinical approval before it ships.",
      },
      {
        kind: "para",
        text: "Shipping labels buys, prints, and tracks — use it rather than a carrier's own site so the tracking number attaches to the order and reaches the patient.",
      },
      {
        kind: "para",
        text: "Catalog is the SKU registry behind all of it: what you dispense and how many are on the shelf. Stock only ever moves as a recorded movement with a reason — received, returned, counted, adjusted — so a balance always has a history you can read back. A blank count means untracked, which is not the same as zero. A dispense is recorded when a fulfillment is queued, and a SKU that is not in the catalog is skipped and logged rather than being allowed to fail a resupply the patient is due.",
      },
      {
        kind: "para",
        text: "Backorders is the other half of that: marking a SKU unavailable and saying what should go out instead. It is read by the insurance fulfillment path, not by a storefront, so an uncleared backorder quietly keeps substituting away from that SKU. Recording a receipt on Catalog clears it for you.",
      },
      {
        kind: "pages",
        title: "Order pages",
        rows: [
          {
            path: "/admin/fitter-requests",
            label: "Fit Requests",
            what: "Finished fittings waiting for someone to place the order.",
          },
          {
            path: "/admin/fitter/orders",
            label: "Fitter requests",
            what: "Orders originating from an approved fitting.",
          },
          {
            path: "/admin/catalog",
            label: "Catalog",
            what: "The SKUs you dispense and what is on the shelf.",
          },
          {
            path: "/admin/shop/backorders",
            label: "Backorders",
            what: "Mark a SKU out of stock and set substitution rules.",
          },
          {
            path: "/admin/shipping",
            label: "Shipping labels",
            what: "Buy, print, and track parcels.",
          },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------
  {
    id: "billing-overview",
    title: "Billing — how the revenue cycle maps to the pages",
    category: "billing",
    intro:
      "The billing area is organized as the claim lifecycle, front to back. Read the worklist tabs in order and you have read the revenue cycle.",
    blocks: [
      {
        kind: "para",
        text: "The sequence is: confirm coverage, clear an authorization if the plan needs one, make sure the required documentation exists, submit, watch for the response, work what came back wrong, and pursue what remains owed. Each of those steps is a worklist, and a claim moves between them rather than living in one place.",
      },
      {
        kind: "bullets",
        items: [
          'Dashboards answer "how are we doing" — billing hub, denials and DSO, collections forecast, chargeback disputes, and payer profitability.',
          'Worklists answer "what do I work next" and follow the lifecycle order.',
          'A/R and collections answer "what is still owed and by whom".',
          "Tools are the plumbing — remittances, the clearinghouse queue, manual claims, configuration, and your plan usage.",
        ],
      },
      {
        kind: "callout",
        tone: "warning",
        text: "Timely filing is the one deadline with no appeal. Filing deadlines /admin/billing/timely-filing deserves a daily look regardless of what else is on the worklist.",
      },
      {
        kind: "pages",
        title: "Billing dashboards",
        rows: [
          {
            path: "/admin/billing",
            label: "Billing Hub",
            what: "The billing landing view.",
          },
          {
            path: "/admin/billing/denials",
            label: "Denials & DSO",
            what: "Denial rate and days-sales-outstanding trend.",
          },
          {
            path: "/admin/billing/collections-forecast",
            label: "Collections forecast",
            what: "Projected collections.",
          },
          {
            path: "/admin/billing/disputes",
            label: "Chargeback disputes",
            what: "Card disputes and their evidence deadlines.",
          },
          {
            path: "/admin/billing/payer-profitability",
            label: "Payer profitability",
            what: "Which payers are worth the effort.",
          },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------
  {
    id: "billing-worklists",
    title: "Billing worklists",
    category: "billing",
    intro:
      "The queues a biller works, in the order a claim moves through them.",
    blocks: [
      {
        kind: "para",
        text: "Verify insurance runs a live eligibility check on demand for any patient; insurance discovery searches for coverage when a patient says they have none or you cannot identify the plan. Eligibility is the ongoing queue and re-verification flags coverage stale enough to re-check. Prior auths tracks authorization requests, and the CMN/DIF worklist tracks the certificates payers expect.",
      },
      {
        kind: "para",
        text: "Bill hold is deliberately a place to park a claim blocked on paperwork, so it is not aging on a worklist pretending to be workable. Auto-submit handles routine volume on your rules; the AI queue proposes codes and edits for review. The denials worklist is ranked by recoverable dollars weighted by win probability, which is why working it top-down beats re-sorting it. ADR and audit readiness cover payer documentation requests and whether your billed claims would survive one.",
      },
      {
        kind: "pages",
        title: "Worklist pages",
        rows: [
          {
            path: "/admin/billing/verify",
            label: "Verify insurance",
            what: "Run an on-demand eligibility check for any patient.",
          },
          {
            path: "/admin/billing/insurance-discovery",
            label: "Insurance discovery",
            what: "Find coverage for a patient whose plan you cannot identify.",
          },
          {
            path: "/admin/billing/eligibility",
            label: "Eligibility",
            what: "The ongoing eligibility queue.",
          },
          {
            path: "/admin/billing/eligibility-recheck",
            label: "Re-verification",
            what: "Coverage stale enough to re-check.",
          },
          {
            path: "/admin/billing/prior-auths",
            label: "Prior auths",
            what: "Authorization requests and their status.",
          },
          {
            path: "/admin/billing/cmn",
            label: "CMN / DIF worklist",
            what: "Certificates the payer expects, and what is outstanding.",
          },
          {
            path: "/admin/billing/bill-hold",
            label: "Bill hold",
            what: "Claims parked on missing paperwork.",
          },
          {
            path: "/admin/billing/auto-submit",
            label: "Auto-submit",
            what: "Routine claim submission on your rules.",
          },
          {
            path: "/admin/billing/manual-claim",
            label: "Manual claim",
            what: "One-off claims that do not fit the rules.",
          },
          {
            path: "/admin/billing/ai-queue",
            label: "AI queue",
            what: "Suggested codes and edits, for review.",
          },
          {
            path: "/admin/billing/denials-worklist",
            label: "Denials worklist",
            what: "Denials ranked by weighted recoverable dollars.",
          },
          {
            path: "/admin/billing/adr",
            label: "ADR / audit response",
            what: "Payer documentation requests and their clocks.",
          },
          {
            path: "/admin/billing/audit-readiness",
            label: "Audit readiness",
            what: "Whether billed claims' documentation would hold up.",
          },
          {
            path: "/admin/billing/notes",
            label: "Billing notes",
            what: "The account-level billing note trail.",
          },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------
  {
    id: "billing-ar",
    title: "A/R, collections, and billing tools",
    category: "billing",
    intro: "What is still owed, by whom, and the plumbing that moves money in.",
    blocks: [
      {
        kind: "para",
        text: "A/R aging is the money view of what is outstanding; filing deadlines is the clock that can silently erase it. Secondary claims covers balances a second plan owes, and posting them promptly matters because the secondary payer's filing clock usually starts at the primary's remittance date. Statement send issues patient statements, and collections runs the dunning ladder from statement through to a reviewed agency hand-off. Capped rentals tracks rental items through their capped period.",
      },
      {
        kind: "para",
        text: "On the tools side, ERA files holds remittance advice, Office Ally is the clearinghouse queue where claims go out and acknowledgements and remittances come back, and Config holds the HCPCS maps, payer and modifier rules, and claim templates that decide how claims are built. Package and usage shows your plan and your usage against its allowances.",
      },
      {
        kind: "callout",
        tone: "tip",
        text: "Reconcile remittances line by line rather than by file total. A file that balances overall can still hide an underpaid line, and that line is the money.",
      },
      {
        kind: "pages",
        title: "A/R and tool pages",
        rows: [
          {
            path: "/admin/billing/aging",
            label: "A/R aging",
            what: "Outstanding balances by age.",
          },
          {
            path: "/admin/billing/timely-filing",
            label: "Filing deadlines",
            what: "Claims about to age out of the filing window.",
          },
          {
            path: "/admin/billing/secondary",
            label: "Secondary claims",
            what: "Balances owed by a second plan.",
          },
          {
            path: "/admin/billing/statements",
            label: "Statement send",
            what: "Issue patient statements.",
          },
          {
            path: "/admin/billing/collections",
            label: "Collections",
            what: "The patient dunning ladder and agency hand-off.",
          },
          {
            path: "/admin/billing/capped-rentals",
            label: "Capped rentals",
            what: "Rental items through their capped period.",
          },
          {
            path: "/admin/billing/era",
            label: "ERA files",
            what: "Electronic remittance advice from payers.",
          },
          {
            path: "/admin/billing/office-ally",
            label: "Office Ally",
            what: "The clearinghouse queue — claims out, responses back.",
          },
          {
            path: "/admin/billing/config",
            label: "Config",
            what: "HCPCS maps, payer and modifier rules, claim templates.",
          },
          {
            path: "/admin/billing/package",
            label: "Package & usage",
            what: "Your plan, allowances, and usage against them.",
          },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------
  {
    id: "analytics",
    title: "Analytics and reports",
    category: "analytics",
    intro:
      "Reports is the catalog; the analytics pages are the standing answers to the questions owners ask most.",
    blocks: [
      {
        kind: "para",
        text: "Financial analytics answer profitability and growth: margin and cost of goods, revenue by source, the acquisition funnel, lifetime value against acquisition cost, and inventory turnover. Outreach attribution and channel engagement answer whether your messaging works and on which channel. Fitter outcomes answers whether the fitting recommendations hold up in practice.",
      },
      {
        kind: "para",
        text: "Performance pages cover the team: throughput per person, live staffing against the queues, goals and targets, and KPI alerts that notify you when a metric crosses a threshold. Clinical and customer pages cover the program: clinical analytics, reorder reminder performance, therapy usage, and net promoter score. The audit trail answers who did what to a specific record.",
      },
      {
        kind: "callout",
        tone: "note",
        text: "Resupply is seasonal. Compare a period against the same period last year as well as against last month before drawing a conclusion.",
      },
      {
        kind: "pages",
        title: "Analytics pages",
        rows: [
          {
            path: "/admin/reports",
            label: "Reports",
            what: "The report catalog.",
          },
          {
            path: "/admin/analytics/audit-trail",
            label: "Audit Trail",
            what: "Who did what, and when.",
          },
          {
            path: "/admin/analytics/margin",
            label: "Margin & COGS",
            what: "Profitability by product and category.",
          },
          {
            path: "/admin/analytics/revenue-by-source",
            label: "Revenue by source",
            what: "Where revenue originates.",
          },
          {
            path: "/admin/analytics/acquisition-funnel",
            label: "Acquisition funnel",
            what: "How prospects become patients.",
          },
          {
            path: "/admin/analytics/ltv-cac",
            label: "LTV & CAC",
            what: "Lifetime value against acquisition cost.",
          },
          {
            path: "/admin/analytics/outreach-attribution",
            label: "Outreach Attribution",
            what: "What outreach actually converted.",
          },
          {
            path: "/admin/analytics/channel-engagement",
            label: "Channel engagement",
            what: "Which channel works for which audience.",
          },
          {
            path: "/admin/analytics/fitter-outcomes",
            label: "Fitter outcomes",
            what: "Whether recommendations were ordered, kept, or exchanged.",
          },
          {
            path: "/admin/productivity",
            label: "Team throughput",
            what: "Output per person.",
          },
          {
            path: "/admin/live-staffing",
            label: "Live staffing",
            what: "Who is covering right now.",
          },
          {
            path: "/admin/goals",
            label: "Goals & targets",
            what: "The targets you manage against.",
          },
          {
            path: "/admin/kpi-alerts",
            label: "KPI alerts",
            what: "Notification when a metric crosses a threshold.",
          },
          {
            path: "/admin/analytics",
            label: "Clinical Analytics",
            what: "Clinical program performance.",
          },
          {
            path: "/admin/reorder-reminders",
            label: "Reorder Reminders",
            what: "How the resupply reminder program is performing.",
          },
          {
            path: "/admin/nps",
            label: "Customer NPS",
            what: "Satisfaction and net promoter score.",
          },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------
  {
    id: "automation",
    title: "Automation",
    category: "outreach",
    intro:
      "How often the app reaches out about resupply, and on which channel — plus a simulator that shows which rule would fire before you rely on it.",
    blocks: [
      {
        kind: "para",
        text: "Frequency rules set the default reminder cadence and channel by therapy type, payer, and how long someone has been a customer, and a per-patient override always beats the rule. Compliance rules are a separate thing: the per-payer adherence thresholds the therapy boards measure against. The rule tester takes a hypothetical patient and reports which rule fires and what cadence and channel the worker would pick — it reads the live rules and modifies nothing.",
      },
      {
        kind: "callout",
        tone: "warning",
        text: "Simulate a rule change before you rely on it. Cadence rules decide how often real patients hear from you, and a sent reminder cannot be recalled.",
      },
      {
        kind: "pages",
        title: "Automation pages",
        rows: [
          {
            path: "/admin/rules",
            label: "Rules",
            what: "Frequency rules — reminder cadence and channel defaults.",
          },
          {
            path: "/admin/compliance-rules",
            label: "Compliance Rules",
            what: "Per-payer adherence thresholds.",
          },
          {
            path: "/admin/rule-tester",
            label: "Rule Tester",
            what: "Dry-run a rule before enabling it.",
          },
          {
            path: "/admin/bot-playground",
            label: "Bot playground",
            what: "Try assistant behavior in a safe sandbox.",
          },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------
  {
    id: "operations",
    title: "Operations and integrations",
    category: "system",
    intro:
      "Where you find out whether the machinery is actually running — and where partner systems plug in.",
    blocks: [
      {
        kind: "para",
        text: "Operations is the health overview across background jobs and queues. Outbound messages is the definitive record of every SMS and email sent with its delivery result, and delivery failures is the queue of what did not land. Webhook deliveries shows inbound partner traffic and whether it was accepted, which is usually where stale data first becomes visible.",
      },
      {
        kind: "para",
        text: "Integrations covers three kinds of connector: therapy-cloud device data pulled in from manufacturer clouds, payer and clearinghouse connectivity for eligibility and claims, and PacWare — a CSV file exchange rather than an API, because the legacy billing system does not offer one. Each connector reports available or unavailable; unavailable means it is not configured, and the badge deliberately does not reveal which credential is missing.",
      },
      {
        kind: "callout",
        tone: "note",
        text: "PacWare import is fill-only: new patients are inserted and blank fields are filled, but an existing value is never overwritten. That is what makes re-running an import safe.",
      },
      {
        kind: "pages",
        title: "Operations pages",
        rows: [
          {
            path: "/admin/operations",
            label: "Operations",
            what: "Background jobs, queues, and system signals.",
          },
          {
            path: "/admin/outbound-messages",
            label: "Outbound Messages",
            what: "Every outbound SMS and email with its delivery result.",
          },
          {
            path: "/admin/delivery-failures",
            label: "Delivery Failures",
            what: "Failed SMS, email, and voice sends. Not parcels.",
          },
          {
            path: "/admin/integrations",
            label: "Integrations",
            what: "Therapy-cloud, payer, and clearinghouse connectors.",
          },
          {
            path: "/admin/pacware",
            label: "PacWare",
            what: "CSV import and export with the legacy billing system.",
          },
          {
            path: "/admin/webhook-deliveries",
            label: "Webhook Deliveries",
            what: "Inbound partner traffic and whether it was accepted.",
          },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------
  {
    id: "settings",
    title: "Settings and your account",
    category: "system",
    intro:
      "Your brand, your sending identities, your team, your modules, and your plan.",
    blocks: [
      {
        kind: "para",
        text: 'Set up your workspace is the onboarding checklist with live status and links to whatever finishes each row — the right starting point for "how do I finish setting up". Company information supplies the identity every other surface reads from. Storefront branding controls the customer-facing name, logo, and colors.',
      },
      {
        kind: "para",
        text: "Three separate pages own the three outbound channels — phone and SMS, fax, and the email From address — and each falls back to the platform's identity until you set your own. Closures records when you are shut so automation behaves. Team manages invitations and roles; locations appears only with multi-branch enabled; account security is each person's own password and multi-factor setup.",
      },
      {
        kind: "para",
        text: "Control Center holds the module switches and feature flags. Configuration is owner-only and holds your own vendor credentials; shared platform infrastructure is managed by the platform rather than here. Plan and billing shows your package, allowances, and usage.",
      },
      {
        kind: "pages",
        title: "Settings pages",
        rows: [
          {
            path: "/admin/setup",
            label: "Set up your workspace",
            what: "The onboarding checklist with live status.",
          },
          {
            path: "/admin/company-information",
            label: "Company information",
            what: "Names, addresses, support contacts, identifiers.",
          },
          {
            path: "/admin/storefront-branding",
            label: "Storefront branding",
            what: "Customer-facing name, logo, and colors.",
          },
          {
            path: "/admin/phone-settings",
            label: "Phone & SMS",
            what: "Your own number for patient texts and calls.",
          },
          {
            path: "/admin/fax-settings",
            label: "Fax number",
            what: "Your own fax number for providers and referrals.",
          },
          {
            path: "/admin/email-settings",
            label: "Email From address",
            what: "Your own From name and address on patient email.",
          },
          {
            path: "/admin/closures",
            label: "Closures",
            what: "When you are closed, so automation behaves.",
          },
          {
            path: "/admin/team",
            label: "Team",
            what: "Invite teammates and set roles.",
          },
          {
            path: "/admin/locations",
            label: "Locations",
            what: "Branches, when multi-branch is enabled.",
          },
          {
            path: "/admin/security",
            label: "Account security",
            what: "Your own password and multi-factor authentication.",
          },
          {
            path: "/admin/control-center",
            label: "Control Center",
            what: "App-module switches and feature flags.",
          },
          {
            path: "/admin/system/configuration",
            label: "Configuration",
            what: "Owner-only: your own vendor credentials.",
          },
          {
            path: "/admin/settings",
            label: "Settings",
            what: "The client-only demo sandbox toggle.",
          },
          {
            path: "/admin/support",
            label: "Support",
            what: "File a request; the assistant answers what it can.",
          },
          {
            path: "/admin/resources",
            label: "Help & Resources",
            what: "This Help Center — how-tos, the user guide, and FAQ.",
          },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------
  {
    id: "security-privacy",
    title: "Security and handling patient information",
    category: "system",
    intro:
      "A short set of rules that protect patients and your business. They are not optional and they are not complicated.",
    blocks: [
      {
        kind: "bullets",
        items: [
          "Give people the narrowest role that lets them do their job, and review roles when someone changes duties or leaves.",
          "Enable multi-factor authentication for anyone who can read a patient chart — set it up at Account security /admin/security.",
          "Never paste identifiers into the AI assistant or a support ticket: no Social Security number, full date of birth, insurance member ID, or card number. Use initials plus an order number instead.",
          "Camera images from the mask fitter never leave the patient's device. Only numeric measurements are transmitted, and nothing in the system stores the imagery.",
          "Patient opt-outs are enforced by the platform and are not overridable from the console. A patient who texted STOP must be reached another way.",
          "Legal holds on documents require a reason, and destruction is admin-gated and only possible once retention rules mark a document eligible.",
          "The audit trail /admin/analytics/audit-trail records who did what. Treat it as the answer to a specific question about a specific record.",
        ],
      },
      {
        kind: "callout",
        tone: "warning",
        text: "If you believe patient information has been exposed — a message sent to the wrong person, a document shared in error — report it immediately through Support /admin/support and to whoever owns compliance for your business. Speed materially changes the outcome.",
      },
    ],
  },
] as const;
