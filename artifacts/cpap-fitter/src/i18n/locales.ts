// Translation dictionaries for PennFit's customer surfaces.
//
// The customer-facing app is currently English-only. The Spanish
// translations and the EN/ES language toggle were retired because
// the existing es strings were AI-drafted and never reviewed by a
// native speaker. The hook + dictionary shape are kept (rather
// than inlining the strings at call sites) so a properly reviewed
// translation can be reintroduced later without churning the
// pages that already call `t(key)`.

export type Locale = "en";

export const SUPPORTED_LOCALES: readonly Locale[] = ["en"];

/** Localized label for the language switcher button. */
export const LOCALE_LABEL: Record<Locale, string> = {
  en: "English",
};

const en = {
  // ── Generic UI ──────────────────────────────────────────────────
  "common.languageToggle": "Language",
  "common.changeLanguage": "Change language",

  // ── Home hero ───────────────────────────────────────────────────
  "home.eyebrow": "PennPaps CPAP supplier — at-home mask fitting",
  "home.headline": "Find the right CPAP mask without a clinic visit",
  "home.subhead":
    "Snap a quick photo, get a mask fit to your face in 2 minutes, and have it shipped — covered by most insurance.",
  "home.ctaPrimary": "Start at-home mask fitting",
  "home.ctaSecondary": "Check insurance coverage",

  // ── Track-order page (public, no login) ─────────────────────────
  "track.badge": "Order status",
  "track.headline": "Track my order",
  "track.intro":
    "Enter your PennPaps order reference (from your confirmation email) and the email you used to place it. No login needed.",
  "track.formTitle": "Order lookup",
  "track.formSubtitleAccountPrefix": "For full order history, sign in to",
  "track.formSubtitleAccountLink": "your account",
  "track.fieldReference": "Order reference",
  "track.fieldEmail": "Email on the order",
  "track.submit": "Look up my order",
  "track.submitting": "Looking up…",
  "track.lookupAnother": "Look up another order",
  "track.errorNotFound":
    "We couldn't find that order. Double-check the reference and the email match.",
  "track.errorRateLimited":
    "Too many attempts. Please wait a few minutes and try again.",
  "track.errorGeneric":
    "Something went wrong. Please try again in a moment.",
  "track.resultLabelStatus": "Status",
  "track.resultLabelReference": "Reference",
  "track.resultLabelMask": "Mask",
  "track.resultLabelSubmitted": "Submitted",

  // ── Order-status descriptors (parallel to formatStatus) ─────────
  "track.statusReceived.label": "Received",
  "track.statusReceived.description":
    "Our fulfillment team has your order. A team member contacts you within 1 business day.",
  "track.statusProcessing.label": "Processing",
  "track.statusProcessing.description":
    "Order received. Awaiting confirmation from our team.",
  "track.statusDeliveryIssue.label": "Delivery issue",
  "track.statusDeliveryIssue.description":
    "We hit a snag forwarding your order. Please call us or reply to your confirmation email.",
} as const;

export type TranslationKey = keyof typeof en;

export const TRANSLATIONS: Record<Locale, Record<TranslationKey, string>> = {
  en,
};
