// Frequently asked questions for the staff Help Center (/admin/resources).
//
// These are the questions staff actually ask in their first months —
// "why can't I see that page", "did the message send", "why did fewer
// texts go out than my audience count". Keep answers to one to three
// short paragraphs and hand off to a how-to via `seeAlso` when the full
// answer is a procedure.

import type { FaqEntry } from "./types";

export const FAQ_ENTRIES: readonly FaqEntry[] = [
  // ---------------------------------------------------------------
  // Getting started / access
  // ---------------------------------------------------------------
  {
    id: "missing-page",
    question: "A page I was told about isn't in my sidebar. Is it broken?",
    category: "getting-started",
    answer: [
      "Almost certainly not. Two things hide a page: a permission your role does not hold, and an app module your account switched off.",
      "Check the role first at Team /admin/team, then the module at Control Center /admin/control-center. If your role is right and the module is on and the page still is not there, file a ticket at Support /admin/support.",
    ],
    seeAlso: "manage-modules-and-flags",
    keywords: ["missing", "hidden", "cannot see", "permission", "sidebar"],
  },
  {
    id: "which-role",
    question: "Which role should I give a new hire?",
    category: "getting-started",
    answer: [
      "The narrowest one that covers their job. A customer-service rep gets conversations, patients, orders, and returns. A biller gets the billing area plus billing context on a chart, and nothing else. A clinician gets clinical documentation and patient read. Admin is the full console; owner adds vendor configuration on top.",
      "It is easy to widen a role later and awkward to explain why someone had access they did not need. Start narrow.",
    ],
    seeAlso: "invite-your-team",
    keywords: [
      "role",
      "permission",
      "access",
      "csr",
      "biller",
      "clinician",
      "admin",
    ],
  },
  {
    id: "where-to-start",
    question: "I just got access. Where do I start?",
    category: "getting-started",
    answer: [
      "Read the user guide's first two sections in this Help Center — they explain what the platform does and the handful of concepts that make everything else obvious.",
      "Then spend a day on Home /admin and whichever queue is yours: Conversations /admin/conversations for a CSR, the billing worklists for a biller, Fit review /admin/fit-sessions for a clinician. The queues teach the app faster than clicking around does.",
    ],
    seeAlso: "navigate-the-console",
    keywords: ["new", "onboarding", "start", "training", "first day"],
  },
  {
    id: "assistant-vs-support",
    question: "Should I ask the assistant or file a support ticket?",
    category: "getting-started",
    answer: [
      'Ask the assistant for anything that starts with "how do I" or "where is" — it knows every page and answers instantly with a link.',
      "File at Support /admin/support when something is actually wrong, when you need a person, or when the answer requires seeing your data. Include the page path, what you expected, what happened, and roughly when — but never patient identifiers.",
    ],
    seeAlso: "get-help-and-report-a-problem",
    keywords: ["assistant", "support", "ticket", "help", "chat", "bug"],
  },

  // ---------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------
  {
    id: "did-it-send",
    question: "How do I tell whether a message actually reached the patient?",
    category: "outreach",
    answer: [
      "Outbound Messages /admin/outbound-messages lists every outbound SMS and email with its delivery result. That is the definitive answer, not the thread view.",
      "If it failed, Delivery Failures /admin/delivery-failures shows why. Most failures are contact-detail problems; a cluster with the same cause and timestamp is a vendor or integration issue worth a ticket.",
    ],
    seeAlso: "check-operations-health",
    keywords: [
      "delivered",
      "sent",
      "failed",
      "bounce",
      "sms",
      "email",
      "tracking",
    ],
  },
  {
    id: "patient-said-stop",
    question: "A patient texted STOP. Can I turn their texts back on?",
    category: "outreach",
    answer: [
      "No — and that is deliberate. Opt-outs are enforced by the platform and are not overridable from the console, because honoring them is a legal requirement rather than a preference.",
      "Reach them by email or phone instead. If they want texts back, they have to text START themselves; you cannot do it for them.",
    ],
    keywords: ["stop", "opt out", "unsubscribe", "consent", "sms", "start"],
  },
  {
    id: "fewer-sent-than-audience",
    question: "Why did fewer messages go out than my campaign audience count?",
    category: "outreach",
    answer: [
      "That gap is expected. Opt-outs, quiet hours, missing or invalid contact details, and hard bounces all remove recipients at send time, after the audience is counted.",
      "Outbound Messages /admin/outbound-messages shows the per-recipient result so you can see exactly which category each drop fell into.",
    ],
    seeAlso: "send-a-bulk-campaign",
    keywords: ["campaign", "audience", "count", "sent", "fewer", "quiet hours"],
  },
  {
    id: "quiet-hours",
    question: "What are quiet hours and can I override them?",
    category: "outreach",
    answer: [
      "Quiet hours stop patient messaging during overnight windows. They are enforced by the platform based on the message category you set — marketing, service, or compliance and recall.",
      "Set the category honestly rather than looking for an override. Mislabeling marketing as service to get around a send window is both a compliance problem and a fast way to get your number filtered by carriers.",
    ],
    seeAlso: "send-a-bulk-campaign",
    keywords: ["quiet hours", "overnight", "timing", "category", "compliance"],
  },
  {
    id: "campaign-vs-alert",
    question: "I need to message one patient. Campaign or alert?",
    category: "outreach",
    answer: [
      "Alert Library /admin/alerts. It is built for a one-off to a single person and is far easier to find afterwards.",
      "Bulk Campaigns /admin/bulk-campaigns is for an audience built from filters. A campaign of one is more work to build and clutters your campaign history.",
    ],
    seeAlso: "send-a-bulk-campaign",
    keywords: ["one patient", "single", "alert", "campaign", "individual"],
  },
  {
    id: "preview-message",
    question:
      "Can I see what an automated message looks like before it goes out?",
    category: "outreach",
    answer: [
      "Yes. Message previews /admin/message-previews renders any automated message with sample data, so you see exactly what a patient receives.",
      "The copy itself lives in Automated messages /admin/templates. Preview after every edit — a merge field that does not resolve is obvious in a preview and invisible in the editor.",
    ],
    seeAlso: "set-up-resupply-reminders",
    keywords: ["preview", "template", "automated", "test", "sample"],
  },
  {
    id: "reminder-link-expired",
    question: "A patient says their reminder link doesn't work.",
    category: "outreach",
    answer: [
      "Those links are short-lived by design — they let a patient confirm or decline in one tap without signing in, so they cannot stay valid indefinitely.",
      "The usual cause is that they are opening an older message. Send a fresh reminder rather than troubleshooting the old link.",
    ],
    seeAlso: "set-up-resupply-reminders",
    keywords: ["link", "expired", "reminder", "broken", "confirm", "decline"],
  },

  // ---------------------------------------------------------------
  // Patients & clinical
  // ---------------------------------------------------------------
  {
    id: "cannot-find-patient",
    question: "I can't find a patient who says they have an account.",
    category: "patients",
    answer: [
      "Try their phone number and any previous or maiden name, then check Duplicate review /admin/patients/duplicates in case the record was split.",
      "Storefront customers who have never placed a clinical order live under Customers /admin/shop/customers rather than the clinical roster, which catches people out regularly.",
    ],
    seeAlso: "find-and-work-a-patient",
    keywords: ["search", "find", "missing patient", "duplicate", "customer"],
  },
  {
    id: "duplicate-records",
    question: "I found two records for the same person. What now?",
    category: "patients",
    answer: [
      "Merge them from Duplicate review /admin/patients/duplicates, which shows the evidence behind the match.",
      "Do it promptly. A split record means split order history, two sets of reminders going to one person, and claims that can reference the wrong chart.",
    ],
    seeAlso: "find-and-work-a-patient",
    keywords: ["duplicate", "merge", "two records", "split"],
  },
  {
    id: "fitter-privacy",
    question: "Does the mask fitter store photos of the patient's face?",
    category: "patients",
    answer: [
      "No. The camera images never leave the patient's device — only numeric facial measurements are transmitted, and no imagery is stored anywhere in the system.",
      "It is worth telling patients this on the call. It is the most common reason someone hesitates to complete a scan, and the answer is genuinely reassuring.",
    ],
    seeAlso: "send-a-fitting-invite",
    keywords: ["privacy", "photo", "camera", "image", "face", "scan", "hipaa"],
  },
  {
    id: "low-confidence-scan",
    question:
      "A fit session came back with low confidence. What does that mean?",
    category: "patients",
    answer: [
      "It means the measurements are not trustworthy enough to recommend from — usually poor lighting, an odd camera angle, or an incomplete scan.",
      "Request a rescan from Fit review /admin/fit-sessions and coach the patient on light and holding the phone at eye level. Do not approve a low-confidence recommendation just to move the queue.",
    ],
    seeAlso: "review-a-fit-session",
    keywords: ["confidence", "low", "scan", "rescan", "measurement", "quality"],
  },
  {
    id: "override-recommendation",
    question: "Can I override the mask the fitter recommended?",
    category: "patients",
    answer: [
      "Yes. Fit review /admin/fit-sessions lets you override the mask or the size when you know something the scan cannot see — a documented preference, facial hair, or a mask that already failed for this patient.",
      "The one exception is a magnetic-implant exclusion from the safety screen. That flag covers the patient and their household, and it should be treated as final.",
    ],
    seeAlso: "review-a-fit-session",
    keywords: [
      "override",
      "recommendation",
      "mask",
      "size",
      "safety",
      "magnet",
    ],
  },
  {
    id: "formulary-not-winning",
    question: "Why does the fitter keep recommending a mask we don't stock?",
    category: "patients",
    answer: [
      "The formulary is a bounded preference, not a filter. It re-orders masks that are already close on fit toward what you stock, but it cannot promote a worse-fitting mask over a better-fitting one.",
      "If a mask you do not carry keeps winning, the engine is telling you it fits materially better for that patient. Either stock it or make the substitution consciously, knowing what you are trading away.",
    ],
    seeAlso: "manage-the-mask-formulary",
    keywords: ["formulary", "stock", "recommendation", "substitute", "catalog"],
  },
  {
    id: "clinical-advice",
    question: "Can the app tell me what pressure setting a patient needs?",
    category: "patients",
    answer: [
      "No. Nothing in this console gives clinical advice, and neither AI assistant will. Therapy decisions — pressure, interpreting an apnea-hypopnea index, prescriptions — belong to the patient's physician.",
      "The app shows you the data and who needs attention. The clinical judgment stays with a clinician.",
    ],
    keywords: ["clinical", "medical advice", "pressure", "ahi", "prescription"],
  },

  // ---------------------------------------------------------------
  // Orders
  // ---------------------------------------------------------------
  {
    id: "order-origins",
    question:
      "Do orders from the storefront, the counter, and a fitting behave differently?",
    category: "orders",
    answer: [
      "No — they all land in Orders /admin/shop/orders and follow the same fulfillment, return, and billing paths.",
      "The one difference is that an order from a fitting appears in Fitter requests /admin/fitter/orders and may need a clinical approval before it ships.",
    ],
    seeAlso: "fulfill-and-ship-an-order",
    keywords: ["order", "source", "storefront", "counter", "fitter", "queue"],
  },
  {
    id: "out-of-stock",
    question: "An item on an order is out of stock. What do I do?",
    category: "orders",
    answer: [
      "Record it in Backorders & subs /admin/shop/backorders rather than silently swapping the item. That is what tells the patient and billing what actually shipped.",
      "A silent substitution is the origin of a surprising number of returns and denied claims — the billed item and the delivered item stop matching.",
    ],
    seeAlso: "fulfill-and-ship-an-order",
    keywords: ["backorder", "out of stock", "substitute", "shortage"],
  },
  {
    id: "return-reason",
    question: "Does it matter which return reason I pick?",
    category: "orders",
    answer: [
      'Yes, quite a lot. "Did not fit", "wrong item shipped", and "changed mind" produce completely different follow-ups, and the reason feeds Fitter outcomes /admin/analytics/fitter-outcomes and Mask-fit feedback /admin/clinical/mask-fit.',
      "A fit-related return is a clinical signal. Consider a rescan or a size override rather than shipping the same mask again.",
    ],
    seeAlso: "handle-a-return",
    keywords: ["return", "reason", "rma", "exchange", "fit"],
  },
  {
    id: "chargeback",
    question: "A patient disputed a charge with their bank. What happens?",
    category: "orders",
    answer: [
      "It appears in Chargeback disputes /admin/billing/disputes with an evidence deadline attached.",
      "That deadline is hard. If it passes without a response, the money is gone regardless of the merits — treat a dispute as more urgent than an ordinary return.",
    ],
    seeAlso: "handle-a-return",
    keywords: ["chargeback", "dispute", "bank", "card", "evidence", "deadline"],
  },
  {
    id: "patient-has-too-many",
    question: "A patient says they have too many supplies and wants to cancel.",
    category: "orders",
    answer: [
      "They usually want a longer interval, not a cancellation — say so before they reach for cancel. You cannot make the change for them from this console: Subscriptions /admin/shop/subscriptions is a read-only health dashboard, and the plan is changed by the patient from their own account. Their current state is visible on their customer record at /admin/shop/customers.",
      "Cancelling drops them out of the reminder program entirely, and patients rarely restart on their own. Stretching the interval keeps the relationship.",
    ],
    seeAlso: "manage-subscriptions",
    keywords: [
      "cancel",
      "pause",
      "too many",
      "subscription",
      "cadence",
      "interval",
    ],
  },

  // ---------------------------------------------------------------
  // Billing
  // ---------------------------------------------------------------
  {
    id: "eligibility-vs-benefit",
    question: "Eligibility came back active. Can I quote the patient a price?",
    category: "billing",
    answer: [
      "Not from the status alone. Active coverage is not the same as a covered benefit for the item you are supplying.",
      'Read the benefit detail — the deductible position, the copay or coinsurance, and whether the plan requires a prior authorization. Quoting from "active" is how balances end up written off later.',
    ],
    seeAlso: "verify-a-patients-insurance",
    keywords: [
      "eligibility",
      "active",
      "benefit",
      "quote",
      "deductible",
      "copay",
    ],
  },
  {
    id: "patient-not-found",
    question: 'The payer says "patient not found" on an eligibility check.',
    category: "billing",
    answer: [
      "Nearly always a demographic mismatch. Check the date of birth, the member ID including any alphabetic prefix, and whether the policy is held under a spouse rather than the patient.",
      "If the details look right, try Insurance discovery /admin/billing/insurance-discovery before concluding the patient is self-pay.",
    ],
    seeAlso: "verify-a-patients-insurance",
    keywords: [
      "not found",
      "eligibility",
      "member id",
      "mismatch",
      "270",
      "271",
    ],
  },
  {
    id: "denial-order",
    question: "What order should I work denials in?",
    category: "billing",
    answer: [
      "Top-down as the Denials worklist /admin/billing/denials-worklist gives it to you. It is already ranked by recoverable dollars weighted by win probability, so the first row is the best use of your next hour.",
      "The one thing that outranks the ranking is Filing deadlines /admin/billing/timely-filing. Check that daily — a winnable denial is still lost once the payer's window closes.",
    ],
    seeAlso: "work-the-denials-worklist",
    keywords: ["denial", "order", "priority", "worklist", "timely filing"],
  },
  {
    id: "same-denial-repeatedly",
    question: "We keep getting the same denial. How do we stop it?",
    category: "billing",
    answer: [
      "Fix the rule, not the claims. Config /admin/billing/config holds the HCPCS maps, payer rules, modifier rules, and claim templates that produced the error.",
      "One denial is a task; the same denial twelve times is a configuration problem. Fixing the cause once is worth more than working all twelve.",
    ],
    seeAlso: "work-the-denials-worklist",
    keywords: [
      "repeat denial",
      "pattern",
      "config",
      "modifier",
      "hcpcs",
      "root cause",
    ],
  },
  {
    id: "missing-paperwork-claim",
    question:
      "A claim is blocked on missing paperwork. Should I submit anyway?",
    category: "billing",
    answer: [
      "No. Put it on Bill hold /admin/billing/bill-hold and release it when the document lands.",
      "Submitting without the required documentation buys a denial, consumes part of the filing window, and adds an appeal you did not need. Chase the document instead — Documents /admin/documents to draft and /admin/patient-packets to send.",
    ],
    seeAlso: "submit-a-claim",
    keywords: [
      "bill hold",
      "paperwork",
      "cmn",
      "documentation",
      "submit",
      "blocked",
    ],
  },
  {
    id: "era-reconcile",
    question:
      "The remittance total matches. Do I still need to check the lines?",
    category: "billing",
    answer: [
      "Yes. A file that balances overall can still contain an underpaid line offset by an overpaid one, and the underpaid line is real money you are entitled to.",
      "Reconcile line by line in ERA files /admin/billing/era, then route denials, patient responsibility, and secondary balances to their respective worklists.",
    ],
    seeAlso: "post-an-era",
    keywords: ["era", "835", "reconcile", "underpaid", "posting", "lines"],
  },
  {
    id: "secondary-timing",
    question: "How quickly do secondary claims need to go out?",
    category: "billing",
    answer: [
      "Promptly. The secondary payer's filing clock usually starts at the primary's remittance date rather than at your posting date, so a slow posting run eats the window before you have started.",
      "Secondary claims /admin/billing/secondary is the queue. Treat it as part of posting, not as a separate later task.",
    ],
    seeAlso: "post-an-era",
    keywords: ["secondary", "cob", "timely filing", "posting", "clock"],
  },
  {
    id: "first-adr",
    question:
      "We received our first ADR from a payer. How worried should we be?",
    category: "billing",
    answer: [
      "Respond on time — that is the immediate priority, and ADR /admin/billing/adr tracks the clock. A complete packet sent late scores the same as no packet.",
      "Then treat it as a sample rather than a one-off. Audit readiness /admin/billing/audit-readiness tells you whether the rest of your billed claims would survive the same scrutiny, which is the real question the ADR is asking.",
    ],
    seeAlso: "respond-to-an-adr",
    keywords: ["adr", "audit", "documentation request", "payer", "packet"],
  },
  {
    id: "collections-agency",
    question: "Can I send an account straight to a collections agency?",
    category: "billing",
    answer: [
      "The agency hand-off export is deliberately gated behind a review step, and that review is worth doing properly.",
      "A billing error or an unposted payment sent to an agency costs far more in goodwill and rework than it recovers. Confirm insurance has finished adjudicating and any secondary plan has been billed first.",
    ],
    seeAlso: "collect-a-patient-balance",
    keywords: ["collections", "agency", "dunning", "balance", "hand-off"],
  },

  // ---------------------------------------------------------------
  // System & settings
  // ---------------------------------------------------------------
  {
    id: "messages-from-platform",
    question: "Why do patient messages come from a name that isn't ours?",
    category: "system",
    answer: [
      "Because your own sending identities are not set yet. Until they are, outbound messages fall back to the platform's shared number and address.",
      "Set them at Phone & SMS /admin/phone-settings, Fax number /admin/fax-settings, and Email From address /admin/email-settings. Authenticate your email domain before switching, or the mail will land in spam.",
    ],
    seeAlso: "brand-outbound-communications",
    keywords: ["branding", "from", "sender", "platform", "name", "number"],
  },
  {
    id: "turn-off-module",
    question: "If I turn off a module, do I lose the data?",
    category: "system",
    answer: [
      "No. Switching a module off in Control Center /admin/control-center hides its pages from the sidebar; nothing is deleted.",
      "Turning it back on restores the pages as they were. Turning off what you genuinely do not use is the cheapest way to make the console easier for new staff.",
    ],
    seeAlso: "manage-modules-and-flags",
    keywords: ["module", "off", "disable", "data", "delete", "control center"],
  },
  {
    id: "who-changed-this",
    question: "Something changed on a record and nobody knows who did it.",
    category: "system",
    answer: [
      "Audit Trail /admin/analytics/audit-trail records who did what and when. It requires audit access, so ask an admin if you cannot open it.",
      "It is built to answer a specific question about a specific record. It is not a performance dashboard, and using it as one tends to go badly.",
    ],
    seeAlso: "track-team-performance",
    keywords: ["audit", "who changed", "history", "trail", "log"],
  },
  {
    id: "integration-unavailable",
    question:
      "An integration shows as unavailable. Which credential is missing?",
    category: "system",
    answer: [
      "The badge deliberately does not say — naming the specific missing credential on a shared screen is an information leak.",
      "Your own vendor accounts are entered at Configuration /admin/system/configuration, which is owner-only. Shared platform infrastructure is managed by the platform; if that is what is down, file at Support /admin/support.",
    ],
    seeAlso: "connect-an-integration",
    keywords: [
      "integration",
      "unavailable",
      "credential",
      "api key",
      "connector",
    ],
  },
  {
    id: "pacware-overwrite",
    question: "Will a PacWare import overwrite what we've edited here?",
    category: "system",
    answer: [
      "No. Import is fill-only: new patients are inserted and blank fields are filled, but an existing value is never overwritten. That is what makes re-running an import safe.",
      "The consequence is that correcting a wrong value means editing it on the patient record — a re-import will not fix it for you.",
    ],
    seeAlso: "sync-with-pacware",
    keywords: ["pacware", "import", "overwrite", "csv", "fill only", "sync"],
  },
  {
    id: "pacware-automatic",
    question: "Does PacWare sync automatically?",
    category: "system",
    answer: [
      "No. PacWare has no API, so the exchange is CSV files you import and export by hand. Nothing is ever pushed automatically.",
      "An opt-in setting can surface an in-app notice when there is data ready to sync, but it is only a prompt — you still run the exchange from /admin/pacware.",
    ],
    seeAlso: "sync-with-pacware",
    keywords: ["pacware", "automatic", "sync", "csv", "api", "schedule"],
  },
  {
    id: "assistant-actions",
    question:
      "Can the in-app assistant do things for me — place an order, fix a claim?",
    category: "system",
    answer: [
      "No. It explains how the app works and walks you to the page and control that does the thing. It does not place orders, edit patients, submit claims, or change settings.",
      "The one thing it can send is a feature suggestion to the account owners, and it always confirms with you before sending. It never sends silently.",
    ],
    seeAlso: "get-help-and-report-a-problem",
    keywords: [
      "assistant",
      "actions",
      "automation",
      "do it for me",
      "suggestion",
    ],
  },
  {
    id: "phi-in-chat",
    question:
      "Why can't I paste patient details into the assistant or a ticket?",
    category: "system",
    answer: [
      "Both leave the application — assistant conversations reach an AI vendor, and support tickets reach the platform team. Identifiers should not travel that way.",
      "Describe the workflow instead, or reference an order or message number. Initials plus an order number are enough for anyone to find the record.",
    ],
    seeAlso: "get-help-and-report-a-problem",
    keywords: ["phi", "privacy", "ssn", "member id", "chat", "ticket", "hipaa"],
  },
  {
    id: "rule-not-firing",
    question: "I enabled an automation rule and nothing happens.",
    category: "system",
    answer: [
      "Dry-run it again in Rule Tester /admin/rule-tester with input you know should match. Almost always the trigger is narrower than intended.",
      "The other common cause is that the module the rule depends on is switched off in Control Center /admin/control-center.",
    ],
    seeAlso: "build-an-automation-rule",
    keywords: [
      "rule",
      "not firing",
      "automation",
      "trigger",
      "tester",
      "debug",
    ],
  },
  {
    id: "plan-limits",
    question: "Where do I see our plan and whether we're near a limit?",
    category: "system",
    answer: [
      "Plan & billing /admin/billing/package shows your package, its allowances, and your usage against them. It is the same page as Package & usage under Billing.",
      "Check it before a large campaign or a bulk send rather than after — usage against messaging allowances is the limit most accounts meet first.",
    ],
    keywords: [
      "plan",
      "billing",
      "usage",
      "allowance",
      "limit",
      "package",
      "quota",
    ],
  },
  // ---------------------------------------------------------------
  // Batch two — questions raised by the newer workflow guides.
  // ---------------------------------------------------------------
  {
    id: "thread-or-case",
    question: "When should a conversation become a case?",
    category: "patients",
    answer: [
      'When it spans more than one channel or will outlive today\'s shift. One question answered in one reply is a conversation; "lost order" that involves a text, a fax, and a refund is a case.',
      "The test: could the next person reconstruct the situation from the thread alone? If not, open a Case /admin/cases and link the pieces.",
    ],
    seeAlso: "open-and-work-a-case",
    keywords: ["case", "escalate", "ticket", "thread", "when"],
  },
  {
    id: "merge-undo",
    question: "What happens to the duplicate record after a merge?",
    category: "patients",
    answer: [
      "It is closed, not deleted. The merge repoints every reference — orders, messages, documents, claims — at the surviving record atomically, and leaves the folded record behind as a trail.",
      "That said, treat a merge as one-way in practice. If you are not certain the two records are the same person, leave them and confirm on the next call.",
    ],
    seeAlso: "merge-duplicate-patients",
    keywords: ["merge", "duplicate", "undo", "delete", "reverse"],
  },
  {
    id: "recall-scan-does-what",
    question: "Does running a recall scan mark the affected devices?",
    category: "patients",
    answer: [
      "No — the scan is read-only. It surfaces every affected serial you dispensed so you know the size of the problem, but it changes nothing.",
      "Moving a specific device to recalled status is a separate, deliberate action taken per device from that patient's Equipment tab. The work is not finished when the scan finishes.",
    ],
    seeAlso: "run-an-equipment-recall",
    keywords: ["recall", "scan", "serial", "mark", "status", "equipment"],
  },
  {
    id: "who-can-destroy-documents",
    question: "Why can't I destroy an expired document?",
    category: "patients",
    answer: [
      "Three gates have to line up: viewing Retention /admin/documents/retention requires audit-export access, destruction is admin-only, and the row must already have been marked eligible by the retention sweep. You also have to type DESTROY to confirm.",
      "If the document is under a legal hold, destruction is blocked outright until the hold is released — which is the point of a hold.",
    ],
    seeAlso: "manage-document-retention",
    keywords: [
      "destroy",
      "retention",
      "legal hold",
      "purge",
      "permission",
      "documents",
    ],
  },
  {
    id: "reject-a-bad-review",
    question: "Can I reject a negative review?",
    category: "orders",
    answer: [
      "Reject for conduct, not for criticism — spam, abuse, or anything containing another person's private information. A genuine negative review is not grounds for rejection, and publishing it with a good reply serves you better than a wall of implausible five-star ratings.",
      "The one hard rule: never publish a review containing a patient's health details, even if the patient wrote them. Reject it and reach out privately.",
    ],
    seeAlso: "moderate-reviews-and-questions",
    keywords: [
      "review",
      "reject",
      "negative",
      "moderation",
      "criticism",
      "phi",
    ],
  },
  {
    id: "cart-nudge-count",
    question: "Why does an abandoned cart only get one reminder?",
    category: "orders",
    answer: [
      "By design. The nudge is one-shot per cart — carts already marked Recovered (they paid) or Cleared (they emptied it themselves) are never nudged at all.",
      "There is no escalating sequence because a second and third reminder about a forgotten cart reads as pestering. If you want more conversions here, improve the checkout rather than the reminder count.",
    ],
    seeAlso: "recover-abandoned-carts",
    keywords: [
      "abandoned cart",
      "reminder",
      "nudge",
      "sequence",
      "once",
      "recovery",
    ],
  },
  {
    id: "back-in-stock-manual",
    question:
      "When do I need to fan out a back-in-stock notification manually?",
    category: "orders",
    answer: [
      "Rarely. The notification fires automatically when an item goes from zero to in-stock in the inventory editor.",
      "The manual trigger covers the case where stock is already positive and that automatic moment passed — a backorder window that closed, or a restock nobody dispatched at the time.",
    ],
    seeAlso: "recover-abandoned-carts",
    keywords: [
      "back in stock",
      "waitlist",
      "notify",
      "manual",
      "fanout",
      "restock",
    ],
  },
  {
    id: "low-usage-means-recover",
    question: "A patient's usage dropped. Should I start an asset recovery?",
    category: "orders",
    answer: [
      "Not yet. Low usage is a signal, not a verdict — a hospital stay or a patient struggling with a mask both look identical in the data, and both are recoverable with a call.",
      "Check Adherence coaching /admin/coaching and the therapy boards first. Asking for the machine back from someone who was about to restart therapy is the fastest way to end their therapy permanently.",
    ],
    seeAlso: "recover-rental-equipment",
    keywords: [
      "asset recovery",
      "low usage",
      "discontinued",
      "rental",
      "machine",
      "stopped",
    ],
  },
  {
    id: "pa-order-of-work",
    question: "Which prior authorizations should I work first?",
    category: "billing",
    answer: [
      "Top-down as the buckets are ordered: missed SLA, then at-risk SLA, then awaiting, then expiring, then drafts. That ordering is the recommendation, not just a layout.",
      "The bucket people underestimate is Drafts — the work is already done and the clock is not running, which makes it the most wasteful place for a request to sit.",
    ],
    seeAlso: "get-a-prior-authorization",
    keywords: ["prior auth", "order", "sla", "priority", "drafts", "expiring"],
  },
  {
    id: "supply-before-auth",
    question: "Can we supply before the prior authorization comes back?",
    category: "billing",
    answer: [
      "You can, but the payer is entitled to refuse the claim and usually will. That makes it a business decision to take consciously, not a workflow shortcut.",
      "If you do it — say, for an urgent clinical need — record why, so nobody is surprised when it reaches write-off.",
    ],
    seeAlso: "get-a-prior-authorization",
    keywords: ["prior auth", "supply", "before", "write-off", "risk", "urgent"],
  },
  {
    id: "secondary-generate-submits",
    question: "Does generating a secondary claim submit it?",
    category: "billing",
    answer: [
      "No. Generating copies the line items and snapshots the primary's adjudication for the coordination-of-benefits loop, producing a draft. The draft is deliberately yours to review.",
      "Check that the primary's payment and adjustments carried across before you submit through the normal batch path — a wrong primary adjudication gets the claim rejected, not just underpaid.",
    ],
    seeAlso: "bill-a-secondary-payer",
    keywords: [
      "secondary",
      "generate",
      "draft",
      "submit",
      "cob",
      "adjudication",
    ],
  },
  {
    id: "capped-rental-manual",
    question: "Do I have to advance capped-rental cycles by hand?",
    category: "billing",
    answer: [
      "No — a daily job advances them automatically. The page exists so you can see the state, catch an exception, and override when reality diverges from the schedule.",
      "A cycle that stopped advancing usually means the underlying billing stopped: a claim on hold, a lapsed authorization, or a patient who moved. Fix the cause, not just the cycle.",
    ],
    seeAlso: "manage-capped-rentals",
    keywords: [
      "capped rental",
      "cycle",
      "manual",
      "advance",
      "automatic",
      "stalled",
    ],
  },
  {
    id: "billing-config-readonly",
    question: "Why can't I edit modifier rules or denial codes?",
    category: "billing",
    answer: [
      "Those surfaces are read-only and maintained centrally. Organization identity, the clearinghouse connection, payer profiles, and fee schedules are the ones you edit yourself from their sub-pages.",
      "The read-only pages still show current state so you can see which rule actually fired on a claim. If a change is needed there, file it at Support /admin/support with the claim and the rule.",
    ],
    seeAlso: "configure-billing-rules",
    keywords: [
      "config",
      "modifier",
      "denial code",
      "claim template",
      "read-only",
      "edit",
    ],
  },
  {
    id: "macro-vs-playbook",
    question: "Macro, playbook, or automated message — which do I want?",
    category: "outreach",
    answer: [
      "A macro is one saved answer a person inserts into a reply they are writing now (/admin/macros). A playbook is a multi-touch sequence for a situation, with a cadence and a channel per touch (/admin/playbooks). An automated message is copy the system sends with nobody involved (/admin/templates).",
      "Putting content in the wrong one is the usual reason a reply library goes stale — a sequence saved as a macro never gets used, and a one-liner built as a playbook is too much work to reach for.",
    ],
    seeAlso: "build-your-reply-library",
    keywords: [
      "macro",
      "playbook",
      "template",
      "canned reply",
      "which",
      "difference",
    ],
  },
  {
    id: "closure-blocks-stop",
    question: "Does a closure auto-reply interfere with STOP?",
    category: "system",
    answer: [
      "No. Opt-out and help keywords are handled by the platform and are never replaced by a closure reply, so a patient can still text STOP while you are closed.",
      'The closure reply covers ordinary inbound texts. Say when you reopen and what to do if it cannot wait — a bare "we\'re closed" leaves someone with a broken machine no better off.',
    ],
    seeAlso: "set-closures-and-hours",
    keywords: [
      "closure",
      "stop",
      "auto-reply",
      "opt out",
      "holiday",
      "keywords",
    ],
  },
  {
    id: "mfa-enforced",
    question: "Is multi-factor authentication required to sign in?",
    category: "system",
    answer: [
      "It depends on your deployment. Enforcement is a configurable setting: where it is on, an admin or agent with no verified factor is blocked from the admin API — everything except their own identity and the enrollment endpoints — until they enroll, and enrolled users are challenged at sign-in. Where it is off, you can work unenrolled.",
      "Enroll either way. It protects your account now, and if enforcement is switched on later you will not be locked out on the morning it happens.",
    ],
    seeAlso: "secure-your-account",
    keywords: [
      "mfa",
      "2fa",
      "totp",
      "required",
      "enforced",
      "sign in",
      "authenticator",
    ],
  },
  {
    id: "new-phone-mfa",
    question: "I'm getting a new phone. What do I do about my authenticator?",
    category: "system",
    answer: [
      "Disable and re-enroll from Account security /admin/security while the old device still works. In that order it takes two minutes.",
      "Doing it after you have wiped the old phone takes an admin and a considerably worse afternoon.",
    ],
    seeAlso: "secure-your-account",
    keywords: [
      "mfa",
      "new phone",
      "authenticator",
      "locked out",
      "re-enroll",
      "device",
    ],
  },
] as const;
